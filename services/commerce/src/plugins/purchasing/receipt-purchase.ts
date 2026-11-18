import type {
  ReceiveCommerceInventoryV3,
  CommerceMutationErrorV1,
} from "@seams/commerce-client";
import { checkInventoryRevision } from "../../commerce-authority/inventory.ts";
import type { CommerceDatabase } from "../../database.ts";
import { readPurchaseRequest, receivedForRequest } from "./purchase-request.ts";

/**
 * A receipt that names a purchase request must match its item and place,
 * and the request must still wait for stock. Whether it waits comes from the
 * receipts that already name it, not from its status, so a second receipt
 * before the reconciler runs sees the first.
 */
export function checkReceiptPurchase(
  database: CommerceDatabase,
  command: ReceiveCommerceInventoryV3,
): CommerceMutationErrorV1 | undefined {
  if (command.purchase.kind === "unlinked") return undefined;
  const entry = database
    .prepare(
      `SELECT revision FROM commerce_list_entry
    WHERE merchant_id = ? AND entry_id = ? AND list_id = 'replenishment_queue' AND lifecycle_state = 'active'`,
    )
    .get<{ revision: number }>(command.merchantId, command.purchase.entryId);
  const revisionError = checkInventoryRevision(
    "purchase_request",
    command.purchase.entryId,
    command.purchase.entryRevision,
    entry?.revision,
  );
  if (revisionError !== undefined) return revisionError;
  const request = readPurchaseRequest(
    database,
    command.merchantId,
    command.purchase.entryId,
    command.purchase.entryRevision,
  );
  if (
    request === undefined ||
    request.terms.inventoryItemId !== command.inventoryItemId ||
    request.terms.locationId !== command.locationId ||
    receivedForRequest(
      database,
      command.merchantId,
      command.purchase.entryId,
      request.terms,
    ) >= request.terms.required
  ) {
    return { code: "resource_relationship_invalid", field: "purchase.entryId" };
  }
  return undefined;
}
