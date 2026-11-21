import { assertNever, rustTrim } from "@purin-labs/std";
import {
  type BoundaryContext,
  commerceTimestamp,
  contextDelivery,
  contextProvenance,
  finishedGoodInventoryItem,
  fulfillmentLineItem,
  inventoryBalanceAccounted,
  inventoryPosition,
  location,
  money,
  offer,
  onlineShippingOrder,
  payment,
  product,
  productMedia,
  productOption,
  quantity,
  rejectCommerce,
  resourceId,
  salesChannel,
  sellableVariant,
  shippingFulfillment,
  externalShipment,
  trackingEvent,
  type OnlineShippingOrderState,
} from "./commerce-canonical.ts";
import {
  commerceBoundary,
  invalidJson,
  type CommerceBoundaryResponse,
} from "./commerce-boundary.ts";
import { timestampNanoseconds } from "./commerce-timestamp.ts";
import {
  boolean,
  buffered,
  i64,
  list,
  name,
  required,
  struct,
  tag,
  text,
  u64,
} from "./serde-input.ts";
import type {
  CanonicalCommerceDelivery,
  CommerceProjection,
  FulfillmentLineItem,
  OfferLifecycle,
  PaymentLifecycle,
  TrackingEvent,
  TrackingEventKind,
} from "./records/commerce-records.ts";
import type { CommerceCueFact } from "./records/transitions.ts";

/** Plan 78: `commerce/lab.rs`, the commerce lab event boundary. */
export const LAB_EVENT_SCHEMA_VERSION = "pantry.commerce.lab.event.v1";

const SCENARIOS = [
  "product-listing",
  "happy-order",
  "payment-failed",
  "inventory-shortage",
  "shipment-delayed",
  "cancellation-refund",
] as const;
const EVENT_KINDS = [
  "catalog_item_prepared",
  "catalog_item_listed",
  "order_created",
  "order_fulfillment_pending",
  "order_fulfilled",
  "payment_captured",
  "payment_failed",
  "refund_completed",
  "inventory_shortage",
  "inventory_observed",
  "cancellation_refund_proposed",
  "fulfillment_requested",
  "fulfillment_overdue",
  "fulfillment_handed_to_carrier",
  "shipment_label_created",
  "shipment_in_transit",
  "tracking_stalled",
  "delivery_exception",
  "shipment_delivered",
  "shipment_returned",
] as const;
type LabEventKind = (typeof EVENT_KINDS)[number];
const ORDER_STATES = [
  "pending_confirmation",
  "confirmed",
  "fulfillment_pending",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
] as const;
const TRACKING_KINDS = [
  "label_created",
  "in_transit",
  "delivery_exception",
  "delivered",
  "returned",
] as const;

type LabEnvelope = Readonly<{
  schemaVersion: string;
  namespace: string;
  runId: string;
  organisationId: string;
  integrationAccountId: string;
  observedAt: string;
  event: LabEvent;
}>;
type LabEvent = Readonly<{
  kind: LabEventKind;
  eventId: string;
  revision: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}>;

function readEnvelope(value: unknown): LabEnvelope {
  const object = struct(value, "labEvent");
  const envelope = {
    schemaVersion: text(required(object, "schemaVersion"), "schemaVersion"),
    namespace: text(required(object, "namespace"), "namespace"),
    runId: text(required(object, "runId"), "runId"),
    scenarioId: name(required(object, "scenarioId"), "scenarioId", SCENARIOS),
    organisationId: text(required(object, "organisationId"), "organisationId"),
    integrationAccountId: text(
      required(object, "integrationAccountId"),
      "integrationAccountId",
    ),
    observedAt: text(required(object, "observedAt"), "observedAt"),
    event: readEvent(required(object, "event")),
  };
  return envelope;
}

function readEvent(value: unknown): LabEvent {
  const object = struct(value, "event");
  const kind = tag(object, "kind", EVENT_KINDS);
  return buffered(() => ({
    kind,
    eventId: text(required(object, "eventId"), "eventId"),
    revision: u64(required(object, "revision"), "revision"),
    occurredAt: text(required(object, "occurredAt"), "occurredAt"),
    payload: readPayload(kind, required(object, "payload")),
  }));
}

function readPayload(
  kind: LabEventKind,
  value: unknown,
): Record<string, unknown> {
  switch (kind) {
    case "catalog_item_prepared":
    case "catalog_item_listed":
      return readCatalogItem(value);
    case "order_created":
      return readOrder(value, true);
    case "order_fulfillment_pending":
    case "order_fulfilled":
      return readOrder(value, false);
    case "payment_captured":
    case "payment_failed":
    case "refund_completed":
    case "cancellation_refund_proposed":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        amountMinor: i64,
        currency: text,
        reason: text,
      });
    case "inventory_shortage":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        variantId: text,
        sku: text,
        requested: u64,
        available: u64,
        locationId: text,
      });
    case "inventory_observed":
      return readFields(value, {
        resourceId: text,
        variantId: text,
        sku: text,
        locationId: text,
        available: u64,
      });
    case "fulfillment_requested":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        locationId: text,
        expectedBy: text,
        lineItems: readFulfillmentLines,
      });
    case "fulfillment_overdue":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        locationId: text,
        requestedAt: text,
        expectedBy: text,
        lineItems: readFulfillmentLines,
      });
    case "fulfillment_handed_to_carrier":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        locationId: text,
        expectedBy: text,
        shipmentId: text,
        lineItems: readFulfillmentLines,
      });
    case "shipment_label_created":
    case "shipment_in_transit":
    case "tracking_stalled":
    case "delivery_exception":
    case "shipment_delivered":
    case "shipment_returned":
      return readFields(value, {
        resourceId: text,
        orderId: text,
        fulfillmentId: text,
        carrier: text,
        trackingNumber: text,
        estimatedDeliveryAt: text,
        reason: text,
        trackingEvents: (events, path) =>
          list(events, path, (event, eventPath) =>
            readFields(
              event,
              {
                eventId: text,
                occurredAt: text,
                kind: (kind, kindPath) => name(kind, kindPath, TRACKING_KINDS),
                reason: text,
                location: text,
              },
              eventPath,
            ),
          ),
      });
    default:
      return assertNever(kind);
  }
}

type FieldReaders = Record<string, (value: unknown, path: string) => unknown>;

/** A struct whose every field is required; unknown fields are ignored. */
function readFields(
  value: unknown,
  readers: FieldReaders,
  path = "payload",
): Record<string, unknown> {
  const object = struct(value, path);
  const result: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(readers))
    result[key] = read(required(object, key), `${path}.${key}`);
  return result;
}

function readFulfillmentLines(value: unknown, path: string): unknown {
  return list(value, path, (line, linePath) =>
    readFields(line, { lineItemId: text, quantity: u64 }, linePath),
  );
}

function readCatalogItem(value: unknown): Record<string, unknown> {
  return readFields(value, {
    resourceId: text,
    title: text,
    description: text,
    variants: (variants, path) =>
      list(variants, path, (variant, variantPath) =>
        readFields(
          variant,
          {
            variantId: text,
            sku: text,
            title: text,
            amountMinor: i64,
            currency: text,
            available: boolean,
            options: (options, optionsPath) =>
              list(options, optionsPath, (option, optionPath) =>
                readFields(option, { name: text, value: text }, optionPath),
              ),
            media: (media, mediaPath) =>
              list(media, mediaPath, (item, itemPath) =>
                readFields(
                  item,
                  {
                    kind: (kind, kindPath) =>
                      name(kind, kindPath, ["image", "video", "model3d"]),
                    url: text,
                    altText: text,
                  },
                  itemPath,
                ),
              ),
          },
          variantPath,
        ),
      ),
  });
}

function readOrder(
  value: unknown,
  withState: boolean,
): Record<string, unknown> {
  return readFields(value, {
    id: text,
    checkoutId: text,
    customerReference: text,
    currency: text,
    totalAmountMinor: i64,
    ...(withState
      ? {
          state: (state: unknown, path: string) =>
            name(state, path, ORDER_STATES),
        }
      : {}),
    lineItems: (lines, path) =>
      list(lines, path, (line, linePath) =>
        readFields(
          line,
          {
            id: text,
            variantId: text,
            sku: text,
            title: text,
            quantity: u64,
            fulfilledQuantity: u64,
            unitAmountMinor: i64,
          },
          linePath,
        ),
      ),
  });
}

/** Rust `normalizeLabEvent`. */
export function normalizeLabEvent(input: unknown): CommerceBoundaryResponse {
  return commerceBoundary(labDelivery.bind(null, input), invalidJson);
}

/** Rust `deriveLabEventCueFacts`. */
export function deriveLabEventCueFacts(
  input: unknown,
): CommerceBoundaryResponse {
  return commerceBoundary(labCueFacts.bind(null, input), invalidJson);
}

function labDelivery(input: unknown): CanonicalCommerceDelivery {
  return deliveryOf(readEnvelope(input));
}

function deliveryOf(envelope: LabEnvelope): CanonicalCommerceDelivery {
  validateEnvelope(envelope);
  commerceTimestamp(envelope.event.occurredAt);
  commerceTimestamp(envelope.observedAt);
  const context: BoundaryContext = {
    organisationId: envelope.organisationId,
    integrationAccountId: envelope.integrationAccountId,
    revision: envelope.event.revision,
    occurredAt: envelope.event.occurredAt,
    observedAt: envelope.observedAt,
    eventId: envelope.event.eventId,
    customerReference: "",
  };
  const event = envelope.event;
  const payload = event.payload as never;
  switch (event.kind) {
    case "catalog_item_prepared":
      return contextDelivery(
        context,
        catalog(context, payload, {
          state: "prepared",
          preparedAt: commerceTimestamp(context.occurredAt),
        }),
      );
    case "catalog_item_listed":
      return contextDelivery(
        context,
        catalog(context, payload, {
          state: "listed",
          listedAt: commerceTimestamp(context.occurredAt),
        }),
      );
    case "order_created":
      return single(context, order(context, payload));
    case "order_fulfillment_pending":
      return single(
        context,
        order(context, {
          ...(payload as object),
          state: "fulfillment_pending",
        } as never),
      );
    case "order_fulfilled":
      return single(
        context,
        order(context, { ...(payload as object), state: "fulfilled" } as never),
      );
    case "payment_captured":
    case "cancellation_refund_proposed":
      return single(context, labPayment(context, payload, "captured"));
    case "payment_failed":
      return single(context, labPayment(context, payload, "failed"));
    case "refund_completed":
      return single(context, labPayment(context, payload, "refunded"));
    case "inventory_shortage":
    case "inventory_observed":
      return single(context, inventory(context, payload));
    case "fulfillment_requested":
      return single(context, fulfillment(context, payload, "requested"));
    case "fulfillment_overdue":
      return single(context, fulfillment(context, payload, "overdue"));
    case "fulfillment_handed_to_carrier":
      return single(
        context,
        fulfillment(context, payload, "handed_to_carrier"),
      );
    case "shipment_label_created":
      return single(context, shipment(context, payload, "label_created"));
    case "shipment_in_transit":
    case "tracking_stalled":
      return single(context, shipment(context, payload, "in_transit"));
    case "delivery_exception":
      return single(context, shipment(context, payload, "delivery_exception"));
    case "shipment_delivered":
      return single(context, shipment(context, payload, "delivered"));
    case "shipment_returned":
      return single(context, shipment(context, payload, "returned"));
    default:
      return assertNever(event.kind);
  }
}

function single(
  context: BoundaryContext,
  projection: CommerceProjection,
): CanonicalCommerceDelivery {
  return contextDelivery(context, [projection]);
}

function validateEnvelope(envelope: LabEnvelope): void {
  if (envelope.schemaVersion !== LAB_EVENT_SCHEMA_VERSION)
    rejectCommerce({
      code: "unsupported_version",
      expected: LAB_EVENT_SCHEMA_VERSION,
      received: envelope.schemaVersion,
    });
  if (!envelope.namespace.startsWith("lab_"))
    rejectCommerce({
      code: "invalid_boundary_payload",
      reason: "lab namespace must start with lab_",
    });
  for (const [field, value] of [
    ["runId", envelope.runId],
    ["organisationId", envelope.organisationId],
    ["integrationAccountId", envelope.integrationAccountId],
    ["event.eventId", envelope.event.eventId],
  ] as const) {
    const trimmed = rustTrim(value);
    if (trimmed.length === 0 || value !== trimmed)
      rejectCommerce({ code: "invalid_identity", field });
  }
  if (envelope.event.revision === 0)
    rejectCommerce({
      code: "invalid_boundary_payload",
      reason: "lab revision must be greater than zero",
    });
}

type CatalogItem = Readonly<{
  resourceId: string;
  title: string;
  description: string;
  variants: readonly Readonly<{
    variantId: string;
    sku: string;
    title: string;
    amountMinor: number;
    currency: string;
    available: boolean;
    options: readonly Readonly<{ name: string; value: string }>[];
    media: readonly Readonly<{
      kind: "image" | "video" | "model3d";
      url: string;
      altText: string;
    }>[];
  }>[];
}>;

function catalog(
  context: BoundaryContext,
  payload: CatalogItem,
  lifecycle: OfferLifecycle,
): CommerceProjection[] {
  const productId = resourceId(payload.resourceId);
  const variants = payload.variants.map((variant) => {
    const variantId = resourceId(variant.variantId);
    const availability = variant.available
      ? { state: "available" as const }
      : { state: "unavailable" as const };
    const options = variant.options.map((option) =>
      productOption(option.name, option.value),
    );
    const media = variant.media.map((item) =>
      productMedia(item.kind, item.url, item.altText),
    );
    const price = money(variant.amountMinor, variant.currency);
    const projection = sellableVariant(
      contextProvenance(context, "lab", "sellable_variant", variant.variantId),
      productId,
      variantId,
      variant.sku,
      variant.title,
      options,
      media,
    );
    return { projection, variantId, sku: variant.sku, price, availability };
  });
  const item = product(
    contextProvenance(context, "lab", "product", payload.resourceId),
    payload.title,
    payload.description,
  );
  const locationId = resourceId("location_lab_main");
  const salesChannelId = resourceId("sales_channel_lab_online");
  const occurredAt = commerceTimestamp(context.occurredAt);
  const projections = [
    item,
    location(
      contextProvenance(context, "lab", "location", locationId),
      "Lab Main",
      "warehouse",
      { state: "active", activeAt: occurredAt },
    ),
    salesChannel(
      contextProvenance(context, "lab", "sales_channel", salesChannelId),
      "Lab Online",
      "online",
      { state: "active", activeAt: occurredAt },
    ),
  ];
  for (const variant of variants) {
    const itemId = resourceId(`inventory_item_${variant.variantId}`);
    const inventoryItem = finishedGoodInventoryItem(
      contextProvenance(context, "lab", "inventory_item", itemId),
      variant.sku,
      variant.sku,
    );
    const offerId = resourceId(`offer_${variant.variantId}_lab_online`);
    const listed = offer(
      contextProvenance(context, "lab", "offer", offerId),
      variant.variantId,
      salesChannelId,
      variant.price,
      variant.availability,
      lifecycle,
    );
    projections.push(variant.projection, inventoryItem, listed);
  }
  return projections;
}

type LabOrder = Readonly<{
  id: string;
  checkoutId: string;
  customerReference: string;
  currency: string;
  totalAmountMinor: number;
  state: (typeof ORDER_STATES)[number];
  lineItems: readonly Readonly<{
    id: string;
    variantId: string;
    sku: string;
    title: string;
    quantity: number;
    fulfilledQuantity: number;
    unitAmountMinor: number;
  }>[];
}>;

function order(
  context: BoundaryContext,
  payload: LabOrder,
): CommerceProjection {
  const provenance = contextProvenance(
    context,
    "lab",
    "commerce_order",
    payload.id,
  );
  return onlineShippingOrder(
    provenance,
    payload.checkoutId,
    payload.customerReference,
    payload.currency,
    payload.totalAmountMinor,
    payload.lineItems.map((line) => ({ ...line, variantId: line.variantId })),
    orderState(payload.state),
  );
}

function orderState(state: LabOrder["state"]): OnlineShippingOrderState {
  switch (state) {
    case "pending_confirmation":
      return { kind: "pending" };
    case "confirmed":
    case "fulfillment_pending":
    case "partially_fulfilled":
    case "fulfilled":
      return { kind: state };
    case "cancelled":
      return { kind: "cancelled", reason: "cancelled in lab scenario" };
    default:
      return assertNever(state);
  }
}

type LabPayment = Readonly<{
  resourceId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  reason: string;
}>;

function labPayment(
  context: BoundaryContext,
  payload: LabPayment,
  state: "captured" | "failed" | "refunded",
): CommerceProjection {
  const timestamp = commerceTimestamp(context.occurredAt);
  const amount = money(payload.amountMinor, payload.currency);
  let lifecycle: PaymentLifecycle;
  switch (state) {
    case "captured":
      lifecycle = { state: "captured", capturedAt: timestamp };
      break;
    case "failed":
      lifecycle = {
        state: "failed",
        failedAt: timestamp,
        reason: payload.reason,
      };
      break;
    case "refunded":
      lifecycle = {
        state: "refunded",
        refundedAt: timestamp,
        refundedAmount: amount,
      };
      break;
    default:
      return assertNever(state);
  }
  return payment(
    contextProvenance(context, "lab", "payment", payload.resourceId),
    resourceId(payload.orderId),
    amount,
    lifecycle,
  );
}

type LabInventory = Readonly<{
  resourceId: string;
  variantId: string;
  locationId: string;
  available: number;
}>;

function inventory(
  context: BoundaryContext,
  payload: LabInventory,
): CommerceProjection {
  if (payload.available >= 9223372036854775808)
    rejectCommerce({
      code: "invalid_quantity",
      field: "labInventory.available",
    });
  const balance = inventoryBalanceAccounted(
    quantity(payload.available, 0, "each"),
    quantity(0, 0, "each"),
    quantity(payload.available, 0, "each"),
  );
  return inventoryPosition(
    contextProvenance(context, "lab", "inventory_position", payload.resourceId),
    resourceId(`inventory_item_${payload.variantId}`),
    resourceId(payload.locationId),
    balance,
  );
}

type LabFulfillment = Readonly<{
  resourceId: string;
  orderId: string;
  locationId: string;
  expectedBy: string;
  requestedAt?: string;
  shipmentId?: string;
  lineItems: readonly Readonly<{ lineItemId: string; quantity: number }>[];
}>;

function fulfillment(
  context: BoundaryContext,
  payload: LabFulfillment,
  kind: "requested" | "overdue" | "handed_to_carrier",
): CommerceProjection {
  let expectedBy: string | null = null;
  if (kind === "overdue") {
    const occurredAt = commerceTimestamp(context.occurredAt);
    expectedBy = commerceTimestamp(payload.expectedBy);
    if (timestampNanoseconds(occurredAt)! < timestampNanoseconds(expectedBy)!)
      rejectCommerce({
        code: "invalid_lifecycle",
        reason: "fulfillment overdue event occurred before expected handoff",
      });
  }
  const provenance = contextProvenance(
    context,
    "lab",
    "fulfillment",
    payload.resourceId,
  );
  const orderId = resourceId(payload.orderId);
  const lineItems: FulfillmentLineItem[] = payload.lineItems.map((item) =>
    fulfillmentLineItem(resourceId(item.lineItemId), item.quantity),
  );
  const locationId = resourceId(payload.locationId);
  const expected = expectedBy ?? commerceTimestamp(payload.expectedBy);
  let lifecycle;
  switch (kind) {
    case "requested":
      lifecycle = {
        state: "requested" as const,
        requestedAt: commerceTimestamp(context.occurredAt),
      };
      break;
    case "overdue":
      lifecycle = {
        state: "requested" as const,
        requestedAt: commerceTimestamp(payload.requestedAt!),
      };
      break;
    case "handed_to_carrier":
      lifecycle = {
        state: "handed_to_carrier" as const,
        handedOverAt: commerceTimestamp(context.occurredAt),
        shipmentId: resourceId(payload.shipmentId!),
      };
      break;
    default:
      return assertNever(kind);
  }
  return shippingFulfillment(
    provenance,
    orderId,
    lineItems,
    locationId,
    expected,
    "lab.fulfillment",
    lifecycle,
  );
}

type LabShipment = Readonly<{
  resourceId: string;
  orderId: string;
  fulfillmentId: string;
  carrier: string;
  trackingNumber: string;
  estimatedDeliveryAt: string;
  reason: string;
  trackingEvents: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    kind: (typeof TRACKING_KINDS)[number];
    reason: string;
    location: string;
  }>[];
}>;

function shipment(
  context: BoundaryContext,
  payload: LabShipment,
  state: (typeof TRACKING_KINDS)[number],
): CommerceProjection {
  const events: TrackingEvent[] = payload.trackingEvents.map((event) => {
    const kind: TrackingEventKind =
      event.kind === "delivery_exception"
        ? { kind: "delivery_exception", reason: event.reason }
        : { kind: event.kind };
    return trackingEvent(
      resourceId(event.eventId),
      commerceTimestamp(event.occurredAt),
      kind,
      event.location,
    );
  });
  const occurredAt = commerceTimestamp(context.occurredAt);
  let lifecycle;
  switch (state) {
    case "label_created":
      lifecycle = { state, createdAt: occurredAt };
      break;
    case "in_transit":
      lifecycle = { state, since: occurredAt };
      break;
    case "delivery_exception":
      lifecycle = { state, occurredAt, reason: payload.reason };
      break;
    case "delivered":
      lifecycle = { state, deliveredAt: occurredAt };
      break;
    case "returned":
      lifecycle = { state, returnedAt: occurredAt, reason: payload.reason };
      break;
    default:
      return assertNever(state);
  }
  return externalShipment(
    contextProvenance(context, "lab", "shipment", payload.resourceId),
    resourceId(payload.orderId),
    resourceId(payload.fulfillmentId),
    payload.carrier,
    payload.trackingNumber,
    commerceTimestamp(payload.estimatedDeliveryAt),
    events,
    lifecycle,
  );
}

function labCueFacts(input: unknown): CommerceCueFact[] {
  const envelope = readEnvelope(input);
  const delivery = deliveryOf(envelope);
  const observation = delivery.observations[0]!;
  const projection = (observation as { projection: CommerceProjection })
    .projection;
  const value = projection.projection as unknown as Projected;
  const payload = envelope.event.payload as unknown as Projected;
  switch (envelope.event.kind) {
    case "inventory_shortage": {
      const orderId = resourceId(payload.orderId);
      const balance = value.balance as {
        kind: string;
        available: { amount: number; scale: number; unit: string };
      };
      const available = balance.available;
      if (available.unit !== "each" || available.scale !== 0) return [];
      const count =
        balance.kind === "accounted"
          ? available.amount
          : Math.max(available.amount, 0);
      return count < (payload.requested as number)
        ? [
            {
              kind: "inventory_shortage",
              orderId,
              sku: payload.sku,
              requested: payload.requested,
              available: count,
              locationId: value.locationId,
            },
          ]
        : [];
    }
    case "tracking_stalled": {
      const events = value.events as unknown as TrackingEvent[];
      const last = events.at(-1);
      if (last === undefined)
        rejectCommerce({
          code: "invalid_lifecycle",
          reason: "tracking stalled cue failed",
        });
      return [
        {
          kind: "tracking_stalled",
          orderId: value.orderId,
          shipmentId: (value.provenance as { resourceId: string }).resourceId,
          trackingNumber: value.trackingNumber,
          lastEventAt: last.occurredAt,
        },
      ];
    }
    case "fulfillment_overdue":
      return [
        {
          kind: "order_unshipped",
          orderId: value.orderId,
          fulfillmentId: (value.provenance as { resourceId: string })
            .resourceId,
          expectedBy: value.expectedBy,
        },
      ];
    case "cancellation_refund_proposed": {
      const orderId = resourceId(payload.orderId);
      const paymentId = resourceId(payload.resourceId);
      const amount = money(payload.amountMinor, payload.currency);
      const reason = payload.reason as string;
      if (rustTrim(reason).length === 0)
        rejectCommerce({
          code: "invalid_identity",
          field: "cancellationRefund.reason",
        });
      return [
        {
          kind: "cancellation_refund_proposed",
          orderId,
          paymentId,
          amountMinor: amount.amountMinor,
          currency: amount.currency,
          reason,
        },
      ];
    }
    default:
      return projectionCueFacts(projection);
  }
}

/** A validated projection read by field, as the Rust cue functions read their structs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Projected = Readonly<Record<string, any>>;

/** Rust `transitions::derive_cue_facts`. */
export function projectionCueFacts(
  projection: CommerceProjection,
): CommerceCueFact[] {
  const value = projection.projection as unknown as Projected;
  if (projection.kind === "payment") {
    const lifecycle = value.lifecycle as { state: string; reason?: string };
    if (lifecycle.state !== "failed") return [];
    const amount = value.amount as { amountMinor: number; currency: string };
    return [
      {
        kind: "payment_failed",
        orderId: value.orderId,
        paymentId: (value.provenance as { resourceId: string }).resourceId,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        reason: lifecycle.reason!,
      },
    ];
  }
  if (projection.kind === "shipment" && value.kind === "external") {
    const lifecycle = value.lifecycle as { state: string; reason?: string };
    if (lifecycle.state !== "delivery_exception") return [];
    return [
      {
        kind: "delivery_exception",
        orderId: value.orderId,
        shipmentId: (value.provenance as { resourceId: string }).resourceId,
        trackingNumber: value.trackingNumber,
        status: "delivery_exception",
        reason: lifecycle.reason!,
      },
    ];
  }
  return [];
}
