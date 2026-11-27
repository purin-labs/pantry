// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { commerceBoundaryContextSchema } from "./lab.ts";

const shopifyFulfillmentLifecycleV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("requested"), requestedAt: Type.String() }),
  OpenObject({ state: Type.Literal("preparing"), startedAt: Type.String() }),
  OpenObject({
    state: Type.Literal("blocked"),
    blockedAt: Type.String(),
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("handed_to_carrier"),
    handedOverAt: Type.String(),
    shipmentId: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: Type.String(),
    reason: Type.String(),
  }),
]);
export type ShopifyFulfillmentLifecycleV202607 = Static<
  typeof shopifyFulfillmentLifecycleV202607Schema
>;

const shopifyFulfillmentLineItemV202607Schema = OpenObject({
  lineItemId: Type.String(),
  quantity: SafeInteger,
});

const shopifyFulfillmentStatusV202607Schema = Type.Union([
  Type.Literal("unfulfilled"),
  Type.Literal("partial"),
  Type.Literal("fulfilled"),
]);
export type ShopifyFulfillmentStatusV202607 = Static<
  typeof shopifyFulfillmentStatusV202607Schema
>;

const shopifyFulfillmentV202607Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  locationId: Type.String(),
  expectedBy: Type.String(),
  lineItems: Type.Array(shopifyFulfillmentLineItemV202607Schema),
  lifecycle: shopifyFulfillmentLifecycleV202607Schema,
  updatedAt: Type.String(),
});

const shopifyLocationClassificationKindV202607Schema = Type.Union([
  Type.Literal("store"),
  Type.Literal("warehouse"),
  Type.Literal("fulfillment_center"),
  Type.Literal("pickup_point"),
]);

const shopifyLocationClassificationV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("pending") }),
  OpenObject({
    state: Type.Literal("assigned"),
    kind: shopifyLocationClassificationKindV202607Schema,
  }),
]);

const shopifyLocationV202607Schema = OpenObject({
  id: Type.String(),
  name: Type.String(),
  classification: shopifyLocationClassificationV202607Schema,
  active: Type.Boolean(),
  updatedAt: Type.String(),
});

const shopifyOfferLifecycleV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("prepared"), preparedAt: Type.String() }),
  OpenObject({ state: Type.Literal("listed"), listedAt: Type.String() }),
  OpenObject({ state: Type.Literal("archived"), archivedAt: Type.String() }),
]);

const shopifyOfferV202607Schema = OpenObject({
  variantGid: Type.String(),
  publicationGid: Type.String(),
  price: Type.String(),
  currency: Type.String(),
  available: Type.Boolean(),
  lifecycle: shopifyOfferLifecycleV202607Schema,
  updatedAt: Type.String(),
});

const shopifyPaymentLifecycleV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("pending"), createdAt: Type.String() }),
  OpenObject({
    state: Type.Literal("authorized"),
    authorizedAt: Type.String(),
  }),
  OpenObject({ state: Type.Literal("captured"), capturedAt: Type.String() }),
  OpenObject({
    state: Type.Literal("failed"),
    failedAt: Type.String(),
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("partially_refunded"),
    refundedAt: Type.String(),
    refundedAmount: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("refunded"),
    refundedAt: Type.String(),
    refundedAmount: Type.String(),
  }),
]);
export type ShopifyPaymentLifecycleV202607 = Static<
  typeof shopifyPaymentLifecycleV202607Schema
>;

const shopifyPaymentV202607Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  amount: Type.String(),
  currency: Type.String(),
  lifecycle: shopifyPaymentLifecycleV202607Schema,
  updatedAt: Type.String(),
});

const shopifySalesChannelKindV202607Schema = Type.Union([
  Type.Literal("online"),
  Type.Literal("point_of_sale"),
  Type.Literal("marketplace"),
  Type.Literal("agent"),
]);

const shopifySalesChannelV202607Schema = OpenObject({
  id: Type.String(),
  name: Type.String(),
  kind: shopifySalesChannelKindV202607Schema,
  active: Type.Boolean(),
  updatedAt: Type.String(),
});

const shopifyTrackingEventKindV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("label_created") }),
  OpenObject({ state: Type.Literal("in_transit") }),
  OpenObject({
    state: Type.Literal("delivery_exception"),
    reason: Type.String(),
  }),
  OpenObject({ state: Type.Literal("delivered") }),
  OpenObject({ state: Type.Literal("returned") }),
]);
export type ShopifyTrackingEventKindV202607 = Static<
  typeof shopifyTrackingEventKindV202607Schema
>;

const shopifyTrackingEventV202607Schema = OpenObject({
  id: Type.String(),
  occurredAt: Type.String(),
  kind: shopifyTrackingEventKindV202607Schema,
  location: Type.String(),
});
export type ShopifyTrackingEventV202607 = Static<
  typeof shopifyTrackingEventV202607Schema
>;

const shopifyShipmentLifecycleV202607Schema = Type.Union([
  OpenObject({
    state: Type.Literal("label_created"),
    createdAt: Type.String(),
  }),
  OpenObject({ state: Type.Literal("in_transit"), since: Type.String() }),
  OpenObject({
    state: Type.Literal("delivery_exception"),
    occurredAt: Type.String(),
    reason: Type.String(),
  }),
  OpenObject({ state: Type.Literal("delivered"), deliveredAt: Type.String() }),
  OpenObject({
    state: Type.Literal("returned"),
    returnedAt: Type.String(),
    reason: Type.String(),
  }),
]);
export type ShopifyShipmentLifecycleV202607 = Static<
  typeof shopifyShipmentLifecycleV202607Schema
>;

const shopifyShipmentV202607Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  fulfillmentId: Type.String(),
  carrier: Type.String(),
  trackingNumber: Type.String(),
  estimatedDeliveryAt: Type.String(),
  events: Type.Array(shopifyTrackingEventV202607Schema),
  lifecycle: shopifyShipmentLifecycleV202607Schema,
  updatedAt: Type.String(),
});

const shopifyResourceV202607Schema = Type.Union([
  OpenObject({
    kind: Type.Literal("location"),
    resource: shopifyLocationV202607Schema,
  }),
  OpenObject({
    kind: Type.Literal("sales_channel"),
    resource: shopifySalesChannelV202607Schema,
  }),
  OpenObject({
    kind: Type.Literal("offer"),
    resource: shopifyOfferV202607Schema,
  }),
  OpenObject({
    kind: Type.Literal("payment"),
    resource: shopifyPaymentV202607Schema,
  }),
  OpenObject({
    kind: Type.Literal("fulfillment"),
    resource: shopifyFulfillmentV202607Schema,
  }),
  OpenObject({
    kind: Type.Literal("shipment"),
    resource: shopifyShipmentV202607Schema,
  }),
]);

const shopifyResourceEnvelopeV202607Schema = OpenObject({
  apiVersion: Type.String(),
  context: commerceBoundaryContextSchema,
  resource: shopifyResourceV202607Schema,
});
export type ShopifyResourceEnvelopeV202607 = Static<
  typeof shopifyResourceEnvelopeV202607Schema
>;
