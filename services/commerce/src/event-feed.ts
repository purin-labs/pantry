// The event feed (Plan 76A step 4B). Each signed delivery in the outbox is
// one event, read in merchant revision order. The event kind comes from the
// command receipt that produced the delivery; a delivery with no receipt,
// such as a refund reservation, is a generic update of its first resource.
import {
  parseReceipt,
  type CommerceDeliveryV1,
  type CommerceEventResourceV1,
  type CommerceEventV1,
  type CommerceMutationReceiptV1,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "./database.ts";
import { COLLECTIONS_COMMAND_EVENTS } from "./plugins/collections/index.ts";
import { MEDIA_COMMAND_EVENTS } from "./plugins/media/index.ts";
import { MARKETS_COMMAND_EVENTS } from "./plugins/markets/index.ts";
import { DISCOUNTS_COMMAND_EVENTS } from "./plugins/discounts/index.ts";
import { CUSTOMERS_COMMAND_EVENTS } from "./plugins/customers/index.ts";
import { DRAFT_ORDERS_COMMAND_EVENTS } from "./plugins/draft-orders/index.ts";
import { RETURNS_COMMAND_EVENTS } from "./plugins/returns/index.ts";
import { STORED_VALUE_COMMAND_EVENTS } from "./plugins/stored-value/index.ts";
import { COMPANIES_COMMAND_EVENTS } from "./plugins/companies/index.ts";

const MAXIMUM_PAGE = 200;

type CommandKind = CommerceMutationReceiptV1["commandKind"];

const COMMAND_EVENTS: Readonly<Partial<Record<CommandKind, string>>> = {
  create_location: "location.created",
  place_channel_listing: "product.listed",
  publish_catalog_listing: "product.published",
  update_product_description: "product.updated",
  update_product: "product.updated",
  delete_product: "product.deleted",
  update_variant: "variant.updated",
  update_offer: "offer.updated",
  update_storefront_tax: "storefront.updated",
  adjust_offer_price: "offer.updated",
  pause_plugin: "plugin.paused",
  resume_plugin: "plugin.resumed",
  configure_plugin: "plugin.configured",
  remove_plugin: "plugin.removed",
  report_plugin_function_failure: "plugin.function_failed",
  pause_failing_plugin: "plugin.paused",
  install_merchant_plugin: "plugin.installed",
  set_plugin_field_values: "plugin.fields_updated",
  run_plugin_action: "plugin.action_run",
  edit_order: "order.edited",
  record_order_manual_payment: "order.paid",
  open_order_balance: "checkout.created",
  create_webhook_subscription: "webhook_subscription.created",
  restart_webhook_subscription: "webhook_subscription.restarted",
  rotate_webhook_secret: "webhook_subscription.secret_rotated",
  delete_webhook_subscription: "webhook_subscription.deleted",
  mark_invoice_overdue: "invoice.overdue",
  create_pickup_checkout: "checkout.created",
  create_shipping_checkout: "checkout.created",
  create_in_person_checkout: "checkout.created",
  record_counter_cash_payment: "order.created",
  begin_checkout_payment: "checkout.payment_started",
  record_checkout_payment_capture: "payment.captured",
  resolve_checkout_payment: "checkout.payment_resolved",
  expire_checkout: "checkout.expired",
  cancel_order: "order.cancelled",
  record_counter_manual_cash_refund: "refund.succeeded",
  mark_pickup_ready: "fulfillment.ready",
  complete_pickup: "fulfillment.completed",
  purchase_shipping_label: "fulfillment.label_purchased",
  attach_fulfillment_tracking: "shipment.updated",
  record_shipping_tracking: "shipment.updated",
  observe_payment_dispute: "dispute.updated",
  create_inventory_item: "inventory_item.created",
  open_inventory_position: "inventory.updated",
  receive_inventory: "inventory.updated",
  reconcile_inventory: "inventory.updated",
  ...COLLECTIONS_COMMAND_EVENTS,
  ...MEDIA_COMMAND_EVENTS,
  ...MARKETS_COMMAND_EVENTS,
  ...DISCOUNTS_COMMAND_EVENTS,
  ...CUSTOMERS_COMMAND_EVENTS,
  ...DRAFT_ORDERS_COMMAND_EVENTS,
  ...RETURNS_COMMAND_EVENTS,
  ...STORED_VALUE_COMMAND_EVENTS,
  ...COMPANIES_COMMAND_EVENTS,
};

type OutboxRow = Readonly<{
  deliveryId: string;
  merchantRevision: number;
  deliveryJson: string;
}>;

export function readEventPage(
  database: CommerceDatabase,
  merchantId: string,
  after: string | undefined,
  limit: number,
): Readonly<{ events: readonly CommerceEventV1[]; nextCursor: string | null }> {
  const position = after === undefined ? undefined : parseCursor(after);
  const size = Math.max(1, Math.min(MAXIMUM_PAGE, Math.trunc(limit)));
  const rows =
    position === undefined
      ? database
          .prepare(
            `SELECT delivery_id AS deliveryId, merchant_revision AS merchantRevision,
                    delivery_json AS deliveryJson
             FROM observation_outbox WHERE merchant_id = ?
             ORDER BY merchant_revision, delivery_id LIMIT ?`,
          )
          .all<OutboxRow>(merchantId, size)
      : database
          .prepare(
            `SELECT delivery_id AS deliveryId, merchant_revision AS merchantRevision,
                    delivery_json AS deliveryJson
             FROM observation_outbox
             WHERE merchant_id = ? AND (merchant_revision > ? OR
               (merchant_revision = ? AND delivery_id > ?))
             ORDER BY merchant_revision, delivery_id LIMIT ?`,
          )
          .all<OutboxRow>(
            merchantId,
            position.revision,
            position.revision,
            position.deliveryId,
            size,
          );
  const receipts = receiptsByDelivery(
    database,
    merchantId,
    rows.map((row) => row.deliveryId),
  );
  const events = rows.map((row) => {
    const delivery = storedDelivery(row.deliveryJson);
    const receipt = receipts.get(row.deliveryId);
    const observed = deliveryResources(delivery.observations);
    // A command with no aggregate observation (a payment step, a draft order,
    // media) names the resource of its receipt.
    const resources =
      observed.length === 0 && receipt !== undefined
        ? [
            {
              kind: eventResourceName(receipt.resource.kind),
              id: receipt.resource.id,
              revision: receipt.resource.revision,
            },
          ]
        : observed;
    return {
      eventId: row.deliveryId,
      cursor: formatCursor(row.merchantRevision, row.deliveryId),
      kind: eventKind(receipt, resources),
      merchantRevision: row.merchantRevision,
      occurredAt: delivery.observedAt,
      resources,
      delivery,
    };
  });
  return { events, nextCursor: events.at(-1)?.cursor ?? null };
}

/**
 * A delivery exactly as it was stored and signed. A delivery written by an
 * older version keeps its own form, so a reader can still check its
 * signature (Plan 76 phase 4); re-serializing a parsed copy would not.
 */
function storedDelivery(json: string): CommerceDeliveryV1 {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { observations?: unknown }).observations) ||
    typeof (value as { observedAt?: unknown }).observedAt !== "string"
  )
    throw new Error("Stored delivery is not valid");
  return value as CommerceDeliveryV1;
}

/** The cursor of the newest event, so a new reader starts after it. */
export function headCursor(
  database: CommerceDatabase,
  merchantId: string,
): string {
  const row = database
    .prepare(
      `SELECT delivery_id AS deliveryId, merchant_revision AS merchantRevision
       FROM observation_outbox WHERE merchant_id = ?
       ORDER BY merchant_revision DESC, delivery_id DESC LIMIT 1`,
    )
    .get<Readonly<{ deliveryId: string; merchantRevision: number }>>(merchantId);
  return row === undefined
    ? formatCursor(0, "")
    : formatCursor(row.merchantRevision, row.deliveryId);
}

function eventKind(
  receipt: CommerceMutationReceiptV1 | undefined,
  resources: readonly CommerceEventResourceV1[],
): string {
  const first = resources[0];
  if (receipt === undefined)
    return `${eventResourceName(first?.kind ?? "merchant")}.updated`;
  if (receipt.commandKind === "place_paid_checkout")
    return receipt.resource.revision === 1 ? "order.created" : "order.paid";
  if (receipt.commandKind === "place_stored_value_checkout")
    return "order.created";
  if (receipt.commandKind === "refund_order")
    return resources.some((resource) => resource.kind === "payment")
      ? "refund.succeeded"
      : "refund.updated";
  return (
    COMMAND_EVENTS[receipt.commandKind] ??
    `${eventResourceName(receipt.resource.kind)}.updated`
  );
}

function eventResourceName(kind: string): string {
  return kind === "commerce_order" ? "order" : kind;
}

function deliveryResources(
  observations: readonly unknown[],
): readonly CommerceEventResourceV1[] {
  const resources: CommerceEventResourceV1[] = [];
  for (const observation of observations) {
    if (typeof observation !== "object" || observation === null) continue;
    const { kind, resource } = observation as Readonly<{
      kind?: unknown;
      resource?: unknown;
    }>;
    if (
      typeof kind !== "string" ||
      typeof resource !== "object" ||
      resource === null
    )
      continue;
    const { id, revision } = resource as Readonly<{
      id?: unknown;
      revision?: unknown;
    }>;
    if (typeof id === "string" && typeof revision === "number")
      resources.push({ kind: eventResourceName(kind), id, revision });
  }
  return resources;
}

const RECEIPT_CHUNK = 50;

export function receiptsByDelivery(
  database: CommerceDatabase,
  merchantId: string,
  deliveryIds: readonly string[],
): ReadonlyMap<string, CommerceMutationReceiptV1> {
  const receipts = new Map<string, CommerceMutationReceiptV1>();
  // Durable Object SQLite binds at most 100 variables in one statement.
  const rows: Readonly<{ receiptJson: string }>[] = [];
  for (let start = 0; start < deliveryIds.length; start += RECEIPT_CHUNK) {
    const chunk = deliveryIds.slice(start, start + RECEIPT_CHUNK);
    rows.push(
      ...database
        .prepare(
          `SELECT receipt_json AS receiptJson FROM command_receipt
           WHERE merchant_id = ?
             AND json_extract(receipt_json, '$.deliveryId') IN (${chunk
               .map(() => "?")
               .join(", ")})`,
        )
        .all<Readonly<{ receiptJson: string }>>(merchantId, ...chunk),
    );
  }
  for (const row of rows) {
    // An entity-plane command keeps a receipt of its own shape; its event
    // gets the generic kind of its first resource.
    let receipt: CommerceMutationReceiptV1;
    try {
      receipt = parseReceipt(JSON.parse(row.receiptJson));
    } catch {
      continue;
    }
    receipts.set(receipt.deliveryId, receipt);
  }
  return receipts;
}

export function formatCursor(revision: number, deliveryId: string): string {
  return `${revision}:${deliveryId}`;
}

export function parseCursor(
  cursor: string,
): Readonly<{ revision: number; deliveryId: string }> {
  const separator = cursor.indexOf(":");
  const revision = Number(cursor.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Event cursor is not valid");
  return { revision, deliveryId: cursor.slice(separator + 1) };
}
