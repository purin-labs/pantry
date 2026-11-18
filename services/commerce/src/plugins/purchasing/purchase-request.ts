// The purchase request machine (Refactor 15, refactor 7). The `status` of a
// `replenishment_queue` entry moves only through PURCHASE_REQUEST_MACHINE,
// and the states that receipts and time own are derived from them: a list
// patch, the reconciler and a receipt read the same evidence, so no patch
// marks a request received with no stock, and a receipt that names a
// request that receipts already cover is refused before the reconciler runs.
import type {
  CommerceEntityPlaneError,
  ListEntryAttributeValue,
  PurchaseRequestStatus,
} from "@seams/commerce-contracts";
import { commerceTransition } from "@seams/commerce-contracts";
import { parseAttributeDefinitionId } from "@seams/commerce-client";

import type { CommerceDatabase } from "../../database.ts";

/** Quantities on the queue are decimals with this scale. */
const PURCHASE_QUANTITY_SCALE = 6;

/** What the request binds: its item, place, unit and quantity. */
type PurchaseRequestTerms = Readonly<{
  inventoryItemId: string;
  locationId: string;
  unit: string;
  required: number;
}>;

type PurchaseRequestEvidence = Readonly<{
  /** Receipts that name the request, at PURCHASE_QUANTITY_SCALE. */
  received: number;
  required: number;
  deliveryPassed: boolean;
}>;

type StoredFieldRow = Readonly<{
  id: string;
  text: string | null;
  status: string | null;
  decimal: string | null;
  timestamp: string | null;
}>;

/** The event that moves a request to `status`; none moves it back to review. */
function purchaseRequestEvent(
  status: PurchaseRequestStatus,
): "request" | "expect" | "run_late" | "receive_part" | "receive" | undefined {
  switch (status) {
    case "requested":
      return "request";
    case "expected":
      return "expect";
    case "late":
      return "run_late";
    case "partial":
      return "receive_part";
    case "received":
      return "receive";
    case "needs_review":
      return undefined;
  }
}

/** True when the machine and the evidence allow the move to `next`. */
export function purchaseRequestMoveAllowed(
  current: PurchaseRequestStatus,
  next: PurchaseRequestStatus,
  evidence: PurchaseRequestEvidence,
): boolean {
  const event = purchaseRequestEvent(next);
  if (event === undefined) return false;
  const move = commerceTransition(
    "purchase_request",
    { state: current },
    event,
  );
  if (!move.allowed) return false;
  switch (event) {
    case "request":
      return true;
    case "expect":
      return !evidence.deliveryPassed;
    case "run_late":
      return evidence.deliveryPassed && evidence.received === 0;
    case "receive_part":
      return evidence.received > 0 && evidence.received < evidence.required;
    case "receive":
      return evidence.received >= evidence.required;
  }
}

/** The accepted receipts that name the request, at PURCHASE_QUANTITY_SCALE. */
export function receivedForRequest(
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  terms: PurchaseRequestTerms,
): number {
  const rows = database
    .prepare(
      `SELECT quantity_amount AS quantityAmount, quantity_scale AS quantityScale,
              quantity_unit AS quantityUnit
         FROM stock_movement
        WHERE merchant_id = ? AND inventory_item_id = ? AND location_id = ?
          AND reason_kind = 'receipt' AND direction = 'increase'
          AND json_extract(reason_json, '$.purchase.entryId') = ?
        ORDER BY occurred_at, movement_id`,
    )
    .all<
      Readonly<{
        quantityAmount: number;
        quantityScale: number;
        quantityUnit: string;
      }>
    >(merchantId, terms.inventoryItemId, terms.locationId, entryId);
  let total = 0;
  for (const row of rows) {
    if (row.quantityUnit !== terms.unit) continue;
    total += purchaseQuantity(row.quantityAmount, row.quantityScale);
    if (!Number.isSafeInteger(total))
      throw new Error(
        "Accepted receipt quantity exceeds the safe integer range",
      );
  }
  return total;
}

/** Scales a stock quantity to PURCHASE_QUANTITY_SCALE. */
function purchaseQuantity(amount: number, scale: number): number {
  if (
    !Number.isSafeInteger(amount) ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > PURCHASE_QUANTITY_SCALE
  ) {
    throw new Error(
      "Inventory quantity cannot be represented by the replenishment evidence scale",
    );
  }
  const value = Number(
    BigInt(amount) * 10n ** BigInt(PURCHASE_QUANTITY_SCALE - scale),
  );
  if (!Number.isSafeInteger(value))
    throw new Error("Inventory quantity exceeds the safe integer range");
  return value;
}

/** The stored status and terms of one revision of a queue entry. */
export function readPurchaseRequest(
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  revision: number,
):
  | Readonly<{
      status: PurchaseRequestStatus;
      terms: PurchaseRequestTerms;
    }>
  | undefined {
  const rows = database
    .prepare(
      `SELECT attribute_id AS id, short_text_value AS text, status_value AS status,
              decimal_value AS decimal, timestamp_value AS timestamp
         FROM commerce_list_entry_attribute_value
        WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ?`,
    )
    .all<StoredFieldRow>(merchantId, entryId, revision);
  const fields = new Map(rows.map((row) => [row.id, row]));
  const status = purchaseRequestStatus(fields.get("status")?.status);
  const inventoryItemId = fields.get("inventory_item_id")?.text;
  const locationId = fields.get("location_id")?.text;
  const unit = fields.get("quantity_unit")?.text;
  const required = storedDecimal(fields.get("required_quantity")?.decimal);
  if (
    status === undefined ||
    inventoryItemId == null ||
    locationId == null ||
    unit == null ||
    required === undefined
  )
    return undefined;
  return { status, terms: { inventoryItemId, locationId, unit, required } };
}

/**
 * Refuses a list patch that moves a purchase request's status where the
 * machine or the evidence does not allow. A patch that keeps the status
 * passes.
 */
export function checkPurchaseRequestPatch(
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  revision: number,
  attributes: readonly ListEntryAttributeValue[],
  now: string,
): CommerceEntityPlaneError | undefined {
  const refused: CommerceEntityPlaneError = {
    code: "invalid_attribute_value",
    attributeId: parseAttributeDefinitionId("status"),
  };
  const stored = readPurchaseRequest(database, merchantId, entryId, revision);
  if (stored === undefined) return refused;
  const statusValue = attributes.find(
    (value) => value.attributeId === "status",
  )?.value;
  const next =
    statusValue?.kind === "status"
      ? purchaseRequestStatus(String(statusValue.value))
      : undefined;
  if (next === undefined) return refused;
  if (next === stored.status) return undefined;
  const delivery = attributes.find(
    (value) => value.attributeId === "expected_delivery_at",
  )?.value;
  const evidence: PurchaseRequestEvidence = {
    received: receivedForRequest(database, merchantId, entryId, stored.terms),
    required: stored.terms.required,
    deliveryPassed:
      delivery?.kind === "timestamp" &&
      Date.parse(delivery.value) < Date.parse(now),
  };
  return purchaseRequestMoveAllowed(stored.status, next, evidence)
    ? undefined
    : refused;
}

export function purchaseRequestStatus(
  value: string | null | undefined,
): PurchaseRequestStatus | undefined {
  switch (value) {
    case "needs_review":
    case "requested":
    case "expected":
    case "partial":
    case "late":
    case "received":
      return value;
    default:
      return undefined;
  }
}

function storedDecimal(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("unscaled" in parsed) ||
    !("scale" in parsed) ||
    parsed.scale !== PURCHASE_QUANTITY_SCALE ||
    !Number.isSafeInteger(Number(parsed.unscaled))
  )
    return undefined;
  return Number(parsed.unscaled);
}
