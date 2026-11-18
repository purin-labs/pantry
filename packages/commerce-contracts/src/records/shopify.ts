// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";
import { commerceBoundaryContextSchema } from "./lab.ts";

export const shopifyCancellationV202607Schema = Type.Union([
  OpenObject({ kind: Type.Literal("active") }),
  OpenObject({
    kind: Type.Literal("cancelled"),
    cancelledAt: Type.String(),
    reason: Type.String(),
  }),
]);
export type ShopifyCancellationV202607 = Static<
  typeof shopifyCancellationV202607Schema
>;

export const shopifyFulfillmentLifecycleV202607Schema = Type.Union([
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

export const shopifyFulfillmentLineItemV202607Schema = OpenObject({
  lineItemId: Type.String(),
  quantity: SafeInteger,
});
export type ShopifyFulfillmentLineItemV202607 = Static<
  typeof shopifyFulfillmentLineItemV202607Schema
>;

export const shopifyFulfillmentStatusV202607Schema = Type.Union([
  Type.Literal("unfulfilled"),
  Type.Literal("partial"),
  Type.Literal("fulfilled"),
]);
export type ShopifyFulfillmentStatusV202607 = Static<
  typeof shopifyFulfillmentStatusV202607Schema
>;

export const shopifyFulfillmentV202607Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  locationId: Type.String(),
  expectedBy: Type.String(),
  lineItems: Type.Array(shopifyFulfillmentLineItemV202607Schema),
  lifecycle: shopifyFulfillmentLifecycleV202607Schema,
  updatedAt: Type.String(),
});
export type ShopifyFulfillmentV202607 = Static<
  typeof shopifyFulfillmentV202607Schema
>;

export const shopifyInventoryLevelEnvelopeV202607Schema = OpenObject({
  apiVersion: Type.String(),
  context: commerceBoundaryContextSchema,
  inventoryItemId: Type.String(),
  locationId: Type.String(),
  available: SafeInteger,
  updatedAt: Type.String(),
});
export type ShopifyInventoryLevelEnvelopeV202607 = Static<
  typeof shopifyInventoryLevelEnvelopeV202607Schema
>;

export const shopifyLocationClassificationKindV202607Schema = Type.Union([
  Type.Literal("store"),
  Type.Literal("warehouse"),
  Type.Literal("fulfillment_center"),
  Type.Literal("pickup_point"),
]);
export type ShopifyLocationClassificationKindV202607 = Static<
  typeof shopifyLocationClassificationKindV202607Schema
>;

export const shopifyLocationClassificationV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("pending") }),
  OpenObject({
    state: Type.Literal("assigned"),
    kind: shopifyLocationClassificationKindV202607Schema,
  }),
]);
export type ShopifyLocationClassificationV202607 = Static<
  typeof shopifyLocationClassificationV202607Schema
>;

export const shopifyLocationV202607Schema = OpenObject({
  id: Type.String(),
  name: Type.String(),
  classification: shopifyLocationClassificationV202607Schema,
  active: Type.Boolean(),
  updatedAt: Type.String(),
});
export type ShopifyLocationV202607 = Static<
  typeof shopifyLocationV202607Schema
>;

export const shopifyOfferLifecycleV202607Schema = Type.Union([
  OpenObject({ state: Type.Literal("prepared"), preparedAt: Type.String() }),
  OpenObject({ state: Type.Literal("listed"), listedAt: Type.String() }),
  OpenObject({ state: Type.Literal("archived"), archivedAt: Type.String() }),
]);
export type ShopifyOfferLifecycleV202607 = Static<
  typeof shopifyOfferLifecycleV202607Schema
>;

export const shopifyOfferV202607Schema = OpenObject({
  variantGid: Type.String(),
  publicationGid: Type.String(),
  price: Type.String(),
  currency: Type.String(),
  available: Type.Boolean(),
  lifecycle: shopifyOfferLifecycleV202607Schema,
  updatedAt: Type.String(),
});
export type ShopifyOfferV202607 = Static<typeof shopifyOfferV202607Schema>;

export const shopifyOrderLineItemV202607Schema = OpenObject({
  id: Type.String(),
  variantId: Type.Union([Type.String(), Type.Null()]),
  sku: Type.String(),
  title: Type.String(),
  quantity: SafeInteger,
  fulfilledQuantity: SafeInteger,
  price: Type.String(),
});
export type ShopifyOrderLineItemV202607 = Static<
  typeof shopifyOrderLineItemV202607Schema
>;

export const shopifyOrderV202607Schema = OpenObject({
  id: Type.String(),
  checkoutId: Type.String(),
  currency: Type.String(),
  totalPrice: Type.String(),
  fulfillmentStatus: shopifyFulfillmentStatusV202607Schema,
  cancelledAt: shopifyCancellationV202607Schema,
  lineItems: Type.Array(shopifyOrderLineItemV202607Schema),
});
export type ShopifyOrderV202607 = Static<typeof shopifyOrderV202607Schema>;

export const shopifyOrderEnvelopeV202607Schema = OpenObject({
  apiVersion: Type.String(),
  context: commerceBoundaryContextSchema,
  order: shopifyOrderV202607Schema,
});
export type ShopifyOrderEnvelopeV202607 = Static<
  typeof shopifyOrderEnvelopeV202607Schema
>;

export const shopifyPaymentLifecycleV202607Schema = Type.Union([
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

export const shopifyPaymentV202607Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  amount: Type.String(),
  currency: Type.String(),
  lifecycle: shopifyPaymentLifecycleV202607Schema,
  updatedAt: Type.String(),
});
export type ShopifyPaymentV202607 = Static<typeof shopifyPaymentV202607Schema>;

export const shopifySalesChannelKindV202607Schema = Type.Union([
  Type.Literal("online"),
  Type.Literal("point_of_sale"),
  Type.Literal("marketplace"),
  Type.Literal("agent"),
]);
export type ShopifySalesChannelKindV202607 = Static<
  typeof shopifySalesChannelKindV202607Schema
>;

export const shopifySalesChannelV202607Schema = OpenObject({
  id: Type.String(),
  name: Type.String(),
  kind: shopifySalesChannelKindV202607Schema,
  active: Type.Boolean(),
  updatedAt: Type.String(),
});
export type ShopifySalesChannelV202607 = Static<
  typeof shopifySalesChannelV202607Schema
>;

export const shopifyTrackingEventKindV202607Schema = Type.Union([
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

export const shopifyTrackingEventV202607Schema = OpenObject({
  id: Type.String(),
  occurredAt: Type.String(),
  kind: shopifyTrackingEventKindV202607Schema,
  location: Type.String(),
});
export type ShopifyTrackingEventV202607 = Static<
  typeof shopifyTrackingEventV202607Schema
>;

export const shopifyShipmentLifecycleV202607Schema = Type.Union([
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

export const shopifyShipmentV202607Schema = OpenObject({
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
export type ShopifyShipmentV202607 = Static<
  typeof shopifyShipmentV202607Schema
>;

export const shopifyResourceV202607Schema = Type.Union([
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
export type ShopifyResourceV202607 = Static<
  typeof shopifyResourceV202607Schema
>;

export const shopifyResourceEnvelopeV202607Schema = OpenObject({
  apiVersion: Type.String(),
  context: commerceBoundaryContextSchema,
  resource: shopifyResourceV202607Schema,
});
export type ShopifyResourceEnvelopeV202607 = Static<
  typeof shopifyResourceEnvelopeV202607Schema
>;

// Parsers of the records above (Plan 78 step 2).
export const parseShopifyCancellationV202607 = recordParser(
  shopifyCancellationV202607Schema,
);
export const parseShopifyFulfillmentLifecycleV202607 = recordParser(
  shopifyFulfillmentLifecycleV202607Schema,
);
export const parseShopifyFulfillmentLineItemV202607 = recordParser(
  shopifyFulfillmentLineItemV202607Schema,
);
export const parseShopifyFulfillmentStatusV202607 = recordParser(
  shopifyFulfillmentStatusV202607Schema,
);
export const parseShopifyFulfillmentV202607 = recordParser(
  shopifyFulfillmentV202607Schema,
);
export const parseShopifyInventoryLevelEnvelopeV202607 = recordParser(
  shopifyInventoryLevelEnvelopeV202607Schema,
);
export const parseShopifyLocationClassificationKindV202607 = recordParser(
  shopifyLocationClassificationKindV202607Schema,
);
export const parseShopifyLocationClassificationV202607 = recordParser(
  shopifyLocationClassificationV202607Schema,
);
export const parseShopifyLocationV202607 = recordParser(
  shopifyLocationV202607Schema,
);
export const parseShopifyOfferLifecycleV202607 = recordParser(
  shopifyOfferLifecycleV202607Schema,
);
export const parseShopifyOfferV202607 = recordParser(shopifyOfferV202607Schema);
export const parseShopifyOrderLineItemV202607 = recordParser(
  shopifyOrderLineItemV202607Schema,
);
export const parseShopifyOrderV202607 = recordParser(shopifyOrderV202607Schema);
export const parseShopifyOrderEnvelopeV202607 = recordParser(
  shopifyOrderEnvelopeV202607Schema,
);
export const parseShopifyPaymentLifecycleV202607 = recordParser(
  shopifyPaymentLifecycleV202607Schema,
);
export const parseShopifyPaymentV202607 = recordParser(
  shopifyPaymentV202607Schema,
);
export const parseShopifySalesChannelKindV202607 = recordParser(
  shopifySalesChannelKindV202607Schema,
);
export const parseShopifySalesChannelV202607 = recordParser(
  shopifySalesChannelV202607Schema,
);
export const parseShopifyTrackingEventKindV202607 = recordParser(
  shopifyTrackingEventKindV202607Schema,
);
export const parseShopifyTrackingEventV202607 = recordParser(
  shopifyTrackingEventV202607Schema,
);
export const parseShopifyShipmentLifecycleV202607 = recordParser(
  shopifyShipmentLifecycleV202607Schema,
);
export const parseShopifyShipmentV202607 = recordParser(
  shopifyShipmentV202607Schema,
);
export const parseShopifyResourceV202607 = recordParser(
  shopifyResourceV202607Schema,
);
export const parseShopifyResourceEnvelopeV202607 = recordParser(
  shopifyResourceEnvelopeV202607Schema,
);
