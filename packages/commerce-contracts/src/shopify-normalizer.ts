import { assertNever } from "@seams/std";
import {
  type BoundaryContext,
  availableQuantity,
  commerceTimestamp,
  contextDelivery,
  contextProvenance,
  externalShipment,
  finishedGoodInventoryItem,
  fulfillmentLineItem,
  identity,
  inventoryPosition,
  location,
  moneyFromMajorDecimal,
  offer,
  onlineShippingOrder,
  payment,
  product,
  rejectCommerce,
  resourceId,
  salesChannel,
  sellableVariant,
  shippingFulfillment,
  sourceProvenance,
  trackingEvent,
  type OnlineShippingOrderState,
} from "./commerce-canonical.ts";
import {
  commerceBoundary,
  invalidJson,
  type CommerceBoundaryResponse,
} from "./commerce-boundary.ts";
import {
  adjacentTag,
  boolean,
  buffered,
  fromSource,
  i64,
  list,
  name,
  optional,
  required,
  struct,
  tag,
  text,
  u64,
} from "./serde-input.ts";
import type {
  CanonicalCommerceDelivery,
  CommerceProjection,
  ExternalShipmentLifecycle,
  OfferLifecycle,
  PaymentLifecycle,
  ShippingFulfillmentLifecycle,
  TrackingEventKind,
} from "./records/commerce-records.ts";
import type {
  CommerceResourceType,
  SourceProvenance,
} from "./records/provenance.ts";

/** Plan 78: `commerce/shopify.rs`, the Shopify 2026-07 boundary. */
export const SHOPIFY_API_VERSION_2026_07 = "2026-07";

type Fields = Readonly<Record<string, unknown>>;
type Reader = (value: unknown, path: string) => unknown;

function fields(
  value: unknown,
  readers: Record<string, Reader>,
  path: string,
): Fields {
  const object = struct(value, path);
  const result: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(readers))
    result[key] = read(required(object, key), `${path}.${key}`);
  return result;
}

/** An internally tagged enum: `tag` names the variant and its fields sit beside it. */
function tagged(
  value: unknown,
  path: string,
  key: string,
  variants: Record<string, Record<string, Reader>>,
): Fields {
  const object = struct(value, path);
  const variant = tag(object, key, Object.keys(variants));
  return {
    [key]: variant,
    ...buffered(() => fields(object, variants[variant]!, path)),
  };
}

function context(value: unknown, path: string): BoundaryContext {
  return fields(
    value,
    {
      organisationId: text,
      integrationAccountId: text,
      revision: u64,
      occurredAt: text,
      observedAt: text,
      eventId: text,
      customerReference: text,
    },
    path,
  ) as BoundaryContext;
}

function checkVersion(apiVersion: string): void {
  if (apiVersion !== SHOPIFY_API_VERSION_2026_07)
    rejectCommerce({
      code: "unsupported_version",
      expected: SHOPIFY_API_VERSION_2026_07,
      received: apiVersion,
    });
}

export function normalizeShopifyCatalog(
  input: unknown,
): CommerceBoundaryResponse {
  return commerceBoundary(catalogDelivery.bind(null, input), invalidJson);
}

export function normalizeShopifyInventory(
  input: unknown,
): CommerceBoundaryResponse {
  return commerceBoundary(inventoryDelivery.bind(null, input), invalidJson);
}

export function normalizeShopifyResource(
  input: unknown,
): CommerceBoundaryResponse {
  return commerceBoundary(resourceDelivery.bind(null, input), invalidJson);
}

export function normalizeShopifyOrder(
  input: unknown,
): CommerceBoundaryResponse {
  return commerceBoundary(orderDelivery.bind(null, input), invalidJson);
}

type CatalogVariant = Readonly<{
  id: string;
  inventoryItemId: string;
  sku: string;
  title: string;
}>;

function catalogDelivery(input: unknown): CanonicalCommerceDelivery {
  const envelope = fields(
    input,
    {
      apiVersion: text,
      context,
      product: (value, path) =>
        fields(
          value,
          {
            id: text,
            title: text,
            description: text,
            variants: (variants, variantsPath) =>
              list(variants, variantsPath, (variant, variantPath) =>
                fields(
                  variant,
                  { id: text, inventoryItemId: text, sku: text, title: text },
                  variantPath,
                ),
              ),
          },
          path,
        ),
    },
    "catalog",
  );
  checkVersion(envelope.apiVersion as string);
  const boundary = envelope.context as BoundaryContext;
  const item = envelope.product as Readonly<{
    id: string;
    title: string;
    description: string;
    variants: readonly CatalogVariant[];
  }>;
  const productId = resourceId(item.id);
  const provenance = contextProvenance(
    boundary,
    "shopify",
    "product",
    productId,
  );
  const variants = item.variants.map((variant) => {
    const variantProvenance = contextProvenance(
      boundary,
      "shopify",
      "sellable_variant",
      variant.id,
    );
    return sellableVariant(
      variantProvenance,
      productId,
      resourceId(variant.id),
      variant.sku,
      variant.title,
      [],
      [],
    );
  });
  const projections = [product(provenance, item.title, item.description)];
  item.variants.forEach((variant, index) => {
    projections.push(variants[index]!);
    projections.push(
      finishedGoodInventoryItem(
        contextProvenance(
          boundary,
          "shopify",
          "inventory_item",
          variant.inventoryItemId,
        ),
        variant.sku,
        variant.title,
      ),
    );
  });
  return contextDelivery(boundary, projections);
}

function inventoryDelivery(input: unknown): CanonicalCommerceDelivery {
  const envelope = fields(
    input,
    {
      apiVersion: text,
      context,
      inventoryItemId: text,
      locationId: text,
      available: i64,
      updatedAt: text,
    },
    "inventory",
  ) as Readonly<{
    apiVersion: string;
    context: BoundaryContext;
    inventoryItemId: string;
    locationId: string;
    available: number;
    updatedAt: string;
  }>;
  checkVersion(envelope.apiVersion);
  const observedAt = commerceTimestamp(envelope.context.observedAt);
  const occurredAt = commerceTimestamp(envelope.updatedAt);
  const balance = {
    kind: "available_only" as const,
    available: availableQuantity(envelope.available, 0, "each"),
  };
  const inventoryItemId = resourceId(envelope.inventoryItemId);
  const locationId = resourceId(envelope.locationId);
  const provenance = sourceProvenance(
    identity(envelope.context.organisationId, "OrganisationId"),
    identity(envelope.context.integrationAccountId, "IntegrationAccountId"),
    "shopify",
    "inventory_position",
    resourceId(`${inventoryItemId}:${locationId}`),
    envelope.context.revision,
    occurredAt,
    observedAt,
  );
  return contextDelivery(envelope.context, [
    inventoryPosition(provenance, inventoryItemId, locationId, balance),
  ]);
}

function resourceProvenance(
  boundary: BoundaryContext,
  resourceType: CommerceResourceType,
  resource: string,
  occurredAt: string,
): SourceProvenance {
  const organisationId = identity(boundary.organisationId, "OrganisationId");
  const integrationAccountId = identity(
    boundary.integrationAccountId,
    "IntegrationAccountId",
  );
  const id = resourceId(resource);
  return sourceProvenance(
    organisationId,
    integrationAccountId,
    "shopify",
    resourceType,
    id,
    boundary.revision,
    occurredAt,
    commerceTimestamp(boundary.observedAt),
  );
}

const RESOURCE_KINDS = [
  "location",
  "sales_channel",
  "offer",
  "payment",
  "fulfillment",
  "shipment",
] as const;

function resourceDelivery(input: unknown): CanonicalCommerceDelivery {
  const object = struct(input, "resource");
  const apiVersion = text(required(object, "apiVersion"), "apiVersion");
  const boundary = context(required(object, "context"), "context");
  const resource = readResource(required(object, "resource"));
  checkVersion(apiVersion);
  return contextDelivery(boundary, [resourceProjection(boundary, resource)]);
}

type Resource = Readonly<{
  kind: (typeof RESOURCE_KINDS)[number];
  value: Fields;
}>;

/** Adjacently tagged: `kind` names the variant and `resource` holds it. */
function readResource(value: unknown): Resource {
  const object = struct(value, "resource");
  const kind = adjacentTag(object, "kind", RESOURCE_KINDS);
  const content = required(object, "resource");
  // serde buffers the content when it comes before the tag.
  const keys = Object.keys(object);
  const read = readResourceContent.bind(null, kind, content);
  return {
    kind,
    value:
      keys.indexOf("resource") < keys.indexOf("kind")
        ? fromSource("buffered", read)
        : read(),
  };
}

function readResourceContent(kind: Resource["kind"], value: unknown): Fields {
  const path = `resource.${kind}`;
  switch (kind) {
    case "location":
      return fields(
        value,
        {
          id: text,
          name: text,
          classification: (classification, classificationPath) =>
            tagged(classification, classificationPath, "state", {
              pending: {},
              assigned: {
                kind: (locationKind, kindPath) =>
                  name(locationKind, kindPath, [
                    "store",
                    "warehouse",
                    "fulfillment_center",
                    "pickup_point",
                  ]),
              },
            }),
          active: boolean,
          updatedAt: text,
        },
        path,
      );
    case "sales_channel":
      return fields(
        value,
        {
          id: text,
          name: text,
          kind: (channelKind, kindPath) =>
            name(channelKind, kindPath, [
              "online",
              "point_of_sale",
              "marketplace",
              "agent",
            ]),
          active: boolean,
          updatedAt: text,
        },
        path,
      );
    case "offer":
      return fields(
        value,
        {
          variantGid: text,
          publicationGid: text,
          price: text,
          currency: text,
          available: boolean,
          lifecycle: (lifecycle, lifecyclePath) =>
            tagged(lifecycle, lifecyclePath, "state", {
              prepared: { preparedAt: text },
              listed: { listedAt: text },
              archived: { archivedAt: text },
            }),
          updatedAt: text,
        },
        path,
      );
    case "payment":
      return fields(
        value,
        {
          id: text,
          orderId: text,
          amount: text,
          currency: text,
          lifecycle: (lifecycle, lifecyclePath) =>
            tagged(lifecycle, lifecyclePath, "state", {
              pending: { createdAt: text },
              authorized: { authorizedAt: text },
              captured: { capturedAt: text },
              failed: { failedAt: text, reason: text },
              partially_refunded: { refundedAt: text, refundedAmount: text },
              refunded: { refundedAt: text, refundedAmount: text },
            }),
          updatedAt: text,
        },
        path,
      );
    case "fulfillment":
      return fields(
        value,
        {
          id: text,
          orderId: text,
          locationId: text,
          expectedBy: text,
          lineItems: (lines, linesPath) =>
            list(lines, linesPath, (line, linePath) =>
              fields(line, { lineItemId: text, quantity: u64 }, linePath),
            ),
          lifecycle: (lifecycle, lifecyclePath) =>
            tagged(lifecycle, lifecyclePath, "state", {
              requested: { requestedAt: text },
              preparing: { startedAt: text },
              blocked: { blockedAt: text, reason: text },
              handed_to_carrier: { handedOverAt: text, shipmentId: text },
              cancelled: { cancelledAt: text, reason: text },
            }),
          updatedAt: text,
        },
        path,
      );
    case "shipment":
      return fields(
        value,
        {
          id: text,
          orderId: text,
          fulfillmentId: text,
          carrier: text,
          trackingNumber: text,
          estimatedDeliveryAt: text,
          events: (events, eventsPath) =>
            list(events, eventsPath, (event, eventPath) =>
              fields(
                event,
                {
                  id: text,
                  occurredAt: text,
                  kind: (kind, kindPath) =>
                    tagged(kind, kindPath, "state", {
                      label_created: {},
                      in_transit: {},
                      delivery_exception: { reason: text },
                      delivered: {},
                      returned: {},
                    }),
                  location: text,
                },
                eventPath,
              ),
            ),
          lifecycle: (lifecycle, lifecyclePath) =>
            tagged(lifecycle, lifecyclePath, "state", {
              label_created: { createdAt: text },
              in_transit: { since: text },
              delivery_exception: { occurredAt: text, reason: text },
              delivered: { deliveredAt: text },
              returned: { returnedAt: text, reason: text },
            }),
          updatedAt: text,
        },
        path,
      );
    default:
      return assertNever(kind);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Readonly<Record<string, any>>;

function resourceProjection(
  boundary: BoundaryContext,
  resource: Resource,
): CommerceProjection {
  const value = resource.value as Loose;
  switch (resource.kind) {
    case "location": {
      if (value.classification.state === "pending")
        rejectCommerce({ code: "location_classification_required" });
      const occurredAt = commerceTimestamp(value.updatedAt);
      return location(
        resourceProvenance(boundary, "location", value.id, occurredAt),
        value.name,
        value.classification.kind,
        value.active
          ? { state: "active", activeAt: occurredAt }
          : { state: "inactive", inactiveAt: occurredAt },
      );
    }
    case "sales_channel": {
      const occurredAt = commerceTimestamp(value.updatedAt);
      return salesChannel(
        resourceProvenance(boundary, "sales_channel", value.id, occurredAt),
        value.name,
        value.kind,
        value.active
          ? { state: "active", activeAt: occurredAt }
          : { state: "inactive", inactiveAt: occurredAt },
      );
    }
    case "offer": {
      const occurredAt = commerceTimestamp(value.updatedAt);
      const lifecycle = offerLifecycle(value.lifecycle);
      return offer(
        resourceProvenance(
          boundary,
          "offer",
          `shopify:offer:${value.variantGid}:${value.publicationGid}`,
          occurredAt,
        ),
        resourceId(value.variantGid),
        resourceId(value.publicationGid),
        moneyFromMajorDecimal(value.price, value.currency),
        value.available ? { state: "available" } : { state: "unavailable" },
        lifecycle,
      );
    }
    case "payment": {
      const occurredAt = commerceTimestamp(value.updatedAt);
      const lifecycle = paymentLifecycle(value.lifecycle, value.currency);
      return payment(
        resourceProvenance(boundary, "payment", value.id, occurredAt),
        resourceId(value.orderId),
        moneyFromMajorDecimal(value.amount, value.currency),
        lifecycle,
      );
    }
    case "fulfillment": {
      const occurredAt = commerceTimestamp(value.updatedAt);
      const lineItems = (
        value.lineItems as readonly { lineItemId: string; quantity: number }[]
      ).map((line) =>
        fulfillmentLineItem(resourceId(line.lineItemId), line.quantity),
      );
      const lifecycle = fulfillmentLifecycle(value.lifecycle);
      return shippingFulfillment(
        resourceProvenance(boundary, "fulfillment", value.id, occurredAt),
        resourceId(value.orderId),
        lineItems,
        resourceId(value.locationId),
        commerceTimestamp(value.expectedBy),
        "shopify.fulfillment",
        lifecycle,
      );
    }
    case "shipment": {
      const occurredAt = commerceTimestamp(value.updatedAt);
      const events = (value.events as readonly Loose[]).map((event) =>
        trackingEvent(
          resourceId(event.id),
          commerceTimestamp(event.occurredAt),
          trackingKind(event.kind),
          event.location,
        ),
      );
      const lifecycle = shipmentLifecycle(value.lifecycle);
      return externalShipment(
        resourceProvenance(boundary, "shipment", value.id, occurredAt),
        resourceId(value.orderId),
        resourceId(value.fulfillmentId),
        value.carrier,
        value.trackingNumber,
        commerceTimestamp(value.estimatedDeliveryAt),
        events,
        lifecycle,
      );
    }
    default:
      return assertNever(resource.kind);
  }
}

function offerLifecycle(lifecycle: Loose): OfferLifecycle {
  switch (lifecycle.state) {
    case "prepared":
      return {
        state: "prepared",
        preparedAt: commerceTimestamp(lifecycle.preparedAt),
      };
    case "listed":
      return {
        state: "listed",
        listedAt: commerceTimestamp(lifecycle.listedAt),
      };
    default:
      return {
        state: "archived",
        archivedAt: commerceTimestamp(lifecycle.archivedAt),
      };
  }
}

function paymentLifecycle(
  lifecycle: Loose,
  currency: string,
): PaymentLifecycle {
  switch (lifecycle.state) {
    case "pending":
      return {
        state: "pending",
        createdAt: commerceTimestamp(lifecycle.createdAt),
      };
    case "authorized":
      return {
        state: "authorized",
        authorizedAt: commerceTimestamp(lifecycle.authorizedAt),
      };
    case "captured":
      return {
        state: "captured",
        capturedAt: commerceTimestamp(lifecycle.capturedAt),
      };
    case "failed":
      return {
        state: "failed",
        failedAt: commerceTimestamp(lifecycle.failedAt),
        reason: lifecycle.reason,
      };
    case "partially_refunded":
    default:
      return {
        state: lifecycle.state,
        refundedAt: commerceTimestamp(lifecycle.refundedAt),
        refundedAmount: moneyFromMajorDecimal(
          lifecycle.refundedAmount,
          currency,
        ),
      } as PaymentLifecycle;
  }
}

function fulfillmentLifecycle(lifecycle: Loose): ShippingFulfillmentLifecycle {
  switch (lifecycle.state) {
    case "requested":
      return {
        state: "requested",
        requestedAt: commerceTimestamp(lifecycle.requestedAt),
      };
    case "preparing":
      return {
        state: "preparing",
        startedAt: commerceTimestamp(lifecycle.startedAt),
      };
    case "blocked":
      return {
        state: "blocked",
        blockedAt: commerceTimestamp(lifecycle.blockedAt),
        reason: lifecycle.reason,
      };
    case "handed_to_carrier":
      return {
        state: "handed_to_carrier",
        handedOverAt: commerceTimestamp(lifecycle.handedOverAt),
        shipmentId: resourceId(lifecycle.shipmentId),
      };
    default:
      return {
        state: "cancelled",
        cancelledAt: commerceTimestamp(lifecycle.cancelledAt),
        reason: lifecycle.reason,
      };
  }
}

function trackingKind(kind: Loose): TrackingEventKind {
  return kind.state === "delivery_exception"
    ? { kind: "delivery_exception", reason: kind.reason }
    : ({ kind: kind.state } as TrackingEventKind);
}

function shipmentLifecycle(lifecycle: Loose): ExternalShipmentLifecycle {
  switch (lifecycle.state) {
    case "label_created":
      return {
        state: "label_created",
        createdAt: commerceTimestamp(lifecycle.createdAt),
      };
    case "in_transit":
      return { state: "in_transit", since: commerceTimestamp(lifecycle.since) };
    case "delivery_exception":
      return {
        state: "delivery_exception",
        occurredAt: commerceTimestamp(lifecycle.occurredAt),
        reason: lifecycle.reason,
      };
    case "delivered":
      return {
        state: "delivered",
        deliveredAt: commerceTimestamp(lifecycle.deliveredAt),
      };
    default:
      return {
        state: "returned",
        returnedAt: commerceTimestamp(lifecycle.returnedAt),
        reason: lifecycle.reason,
      };
  }
}

function orderDelivery(input: unknown): CanonicalCommerceDelivery {
  const object = struct(input, "order");
  const apiVersion = text(required(object, "apiVersion"), "apiVersion");
  const boundary = context(required(object, "context"), "context");
  const orderObject = struct(required(object, "order"), "order");
  const order = {
    ...fields(
      orderObject,
      {
        id: text,
        checkoutId: text,
        currency: text,
        totalPrice: text,
        fulfillmentStatus: (status, path) =>
          name(status, path, ["unfulfilled", "partial", "fulfilled"]),
        cancelledAt: (cancellation, path) =>
          tagged(cancellation, path, "kind", {
            active: {},
            cancelled: { cancelledAt: text, reason: text },
          }),
        lineItems: (lines, linesPath) =>
          list(lines, linesPath, (line, linePath) => {
            const lineObject = struct(line, linePath);
            return {
              ...fields(
                lineObject,
                {
                  id: text,
                  sku: text,
                  title: text,
                  quantity: u64,
                  fulfilledQuantity: u64,
                  price: text,
                },
                linePath,
              ),
              variantId: optional(lineObject, "variantId", text),
            };
          }),
      },
      "order",
    ),
  } as Loose;
  checkVersion(apiVersion);
  const state: OnlineShippingOrderState =
    order.cancelledAt.kind === "cancelled"
      ? { kind: "cancelled", reason: order.cancelledAt.reason }
      : order.fulfillmentStatus === "unfulfilled"
        ? { kind: "confirmed" }
        : order.fulfillmentStatus === "partial"
          ? { kind: "partially_fulfilled" }
          : { kind: "fulfilled" };
  const total = moneyFromMajorDecimal(order.totalPrice, order.currency);
  const lines = (order.lineItems as readonly Loose[]).map((line) => ({
    id: line.id,
    variantId: line.variantId,
    sku: line.sku,
    title: line.title,
    quantity: line.quantity,
    fulfilledQuantity: line.fulfilledQuantity,
    unitAmountMinor: moneyFromMajorDecimal(line.price, order.currency)
      .amountMinor,
  }));
  return contextDelivery(boundary, [
    onlineShippingOrder(
      contextProvenance(boundary, "shopify", "commerce_order", order.id),
      order.checkoutId,
      boundary.customerReference,
      order.currency,
      total.amountMinor,
      lines,
      state,
    ),
  ]);
}
