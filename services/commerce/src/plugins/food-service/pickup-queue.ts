// The pickup queue (Plan 40B phase 3): the open pickups of a merchant, read
// by state, so that the read stays small however many orders the merchant
// has sold. A pickup board reads it on each event.
import {
  parseFulfillment,
  parseOrder,
  parsePayment,
  commercePickupCode,
  commercePickupTicketId,
  type CommercePickupQueueEntryV1,
  type CommercePickupQueueV1,
} from "@purin-labs/commerce-client";
import type { CommerceDatabase } from "../../database.ts";
import { readPreparationTicket } from "./food-service-store.ts";

type Order = ReturnType<typeof parseOrder>;
type Fulfillment = ReturnType<typeof parseFulfillment>;

export function readPickupQueue(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
): CommercePickupQueueV1 {
  const rows = database
    .prepare(
      `SELECT fulfillment.fulfillment_snapshot_json AS fulfillmentJson,
              commerce_order.order_snapshot_json AS orderJson
       FROM fulfillment
       JOIN commerce_order
         ON commerce_order.merchant_id = fulfillment.merchant_id
        AND commerce_order.resource_id = fulfillment.order_id
       WHERE fulfillment.merchant_id = ?
         AND fulfillment.fulfillment_kind = 'pickup'
         AND fulfillment.lifecycle_state IN ('requested', 'ready_for_pickup')`,
    )
    .all<Readonly<{ fulfillmentJson: string; orderJson: string }>>(merchantId);
  const stations = activeStations(database, merchantId);
  const entries: CommercePickupQueueEntryV1[] = [];
  for (const row of rows) {
    const entry = queueEntry(
      database,
      merchantId,
      stations,
      parseOrder(JSON.parse(row.orderJson)),
      parseFulfillment(JSON.parse(row.fulfillmentJson)),
    );
    if (entry !== null) entries.push(entry);
  }
  entries.sort(
    (first, second) =>
      first.since.localeCompare(second.since) ||
      first.fulfillmentId.localeCompare(second.fulfillmentId),
  );
  return {
    schemaVersion: "commerce.pickup-queue.v1",
    merchantId,
    merchantRevision,
    entries,
  };
}

function queueEntry(
  database: CommerceDatabase,
  merchantId: string,
  stations: ReadonlyMap<string, string>,
  order: Order,
  fulfillment: Fulfillment,
): CommercePickupQueueEntryV1 | null {
  if (fulfillment.kind !== "pickup") return null;
  const lifecycle = fulfillment.lifecycle;
  if (lifecycle.state !== "requested" && lifecycle.state !== "ready_for_pickup")
    return null;
  const lines = order.lineItems.filter((line) =>
    fulfillment.lineItems.some((item) => item.lineItemId === line.id),
  );
  const payment = capturedPayment(database, merchantId, order.id);
  return {
    orderId: order.id,
    orderRevision: order.revision,
    fulfillmentId: fulfillment.id,
    fulfillmentRevision: fulfillment.revision,
    locationId: fulfillment.locationId,
    code: commercePickupCode(order.id),
    channel: order.origin.kind === "online" ? "online" : "counter",
    stage: lifecycle.state === "requested" ? "preparing" : "ready",
    since:
      lifecycle.state === "requested"
        ? lifecycle.requestedAt
        : lifecycle.readyAt,
    payment,
    lines: lines.map((line) => ({
      title: line.title,
      quantity: line.quantity.amount,
      modifiers:
        line.source.kind === "food_service"
          ? line.source.modifiers.map((modifier) => modifier.name)
          : [],
    })),
    preparation: preparationOf(database, merchantId, stations, lines, {
      orderId: order.id,
      fulfillmentId: fulfillment.id,
      locationId: fulfillment.locationId,
    }),
  };
}

function preparationOf(
  database: CommerceDatabase,
  merchantId: string,
  stations: ReadonlyMap<string, string>,
  lines: Order["lineItems"],
  pickup: Readonly<{
    orderId: string;
    fulfillmentId: string;
    locationId: string;
  }>,
): CommercePickupQueueEntryV1["preparation"] {
  const madeToOrder = lines.some(
    (line) =>
      line.source.kind === "food_service" &&
      line.source.preparation.kind === "immediate_recipe",
  );
  if (!madeToOrder) return { state: "not_needed" };
  const ticketId = commercePickupTicketId(
    pickup.orderId,
    pickup.fulfillmentId,
  );
  const ticket = readPreparationTicket(database, merchantId, ticketId);
  if (ticket === undefined)
    return {
      state: "not_started",
      ticketId,
      stationId: stations.get(pickup.locationId) ?? null,
    };
  return {
    state:
      ticket.lifecycle.state === "queued" ||
      ticket.lifecycle.state === "preparing"
        ? ticket.lifecycle.state
        : "completed",
    ticketId,
    ticketRevision: ticket.revision,
  };
}

function capturedPayment(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): CommercePickupQueueEntryV1["payment"] {
  const row = database
    .prepare(
      `SELECT payment_snapshot_json AS paymentJson FROM payment
       WHERE merchant_id = ? AND order_id = ? AND lifecycle_state = 'captured'
       ORDER BY resource_id LIMIT 1`,
    )
    .get<Readonly<{ paymentJson: string }>>(merchantId, orderId);
  if (row === undefined) return null;
  const payment = parsePayment(JSON.parse(row.paymentJson));
  return { paymentId: payment.id, paymentRevision: payment.revision };
}

/** The first active preparation station of each location. */
function activeStations(
  database: CommerceDatabase,
  merchantId: string,
): ReadonlyMap<string, string> {
  const rows = database
    .prepare(
      `SELECT resource_json AS resourceJson FROM food_service_resource
       WHERE merchant_id = ? AND resource_kind = 'preparation_station'
       ORDER BY resource_id, revision`,
    )
    .all<Readonly<{ resourceJson: string }>>(merchantId);
  // A later revision of a station replaces the earlier one.
  const latest = new Map<string, { locationId: string; active: boolean }>();
  for (const row of rows) {
    const station = JSON.parse(row.resourceJson) as Readonly<{
      stationId: string;
      locationId: string;
      lifecycle: string;
    }>;
    latest.set(station.stationId, {
      locationId: station.locationId,
      active: station.lifecycle === "active",
    });
  }
  const stations = new Map<string, string>();
  for (const [stationId, station] of latest)
    if (station.active && !stations.has(station.locationId))
      stations.set(station.locationId, stationId);
  return stations;
}
