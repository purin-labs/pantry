// Plan 78 step 2: schemas of the Commerce V1 resource types that the client
// declared by hand in packages/commerce-client/src/commerce-resources.ts.
// Each schema follows its client reader; the type fixture in the client
// proves the types equal. The records that the admin and storefront readers
// share come from api-common.ts.
import { Type, type Static, type TSchema } from "typebox";
import {
  commerceOrderMarketV1Schema,
  type CommerceOrderMarketV1,
} from "./api-markets.ts";
import type { OrderLineInventory } from "../commerce-domain.ts";
import {
  NonNegativeInteger,
  PositiveInteger,
  SafeInteger,
  recordParser,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import {
  wireBuyerSchema,
  wireInventoryLotExpirySchema,
  wireInventoryReceiptPurchaseSchema,
  wireInventoryTrackingSchema,
  wireLocationSchema,
  wireMoneySchema,
  wireOfferSchema,
  wireQuantitySchema,
  wireSalesChannelSchema,
} from "./api-common.ts";
import {
  checkoutModifierSelectionSchema,
  checkoutOptionValueSchema,
  checkoutPreparationSchema,
  checkoutProfileRecordReferenceSchema,
  checkoutLineInventorySchema,
  externalShipmentLifecycleSchema,
  firstPartyShipmentLifecycleSchema,
  inventoryItemCategorySchema,
  inventoryItemLifecycleSchema,
  orderAdjustmentKindSchema,
  orderAdjustmentStatusSchema,
  productMediaKindSchema,
  quantityUnitSchema,
  shipmentPackageSchema,
  shippingFulfillmentBindingSchema,
} from "./commerce-records.ts";
import {
  boundedTextSchema,
  currencyCodeTextSchema,
  httpsUrlSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

/** The domain type of a line's inventory keeps the variants apart. */
const orderLineInventorySchema = Type.Unsafe<OrderLineInventory>(
  checkoutLineInventorySchema,
);

/** `parseProductDetails`: what an older caller leaves out gets a default. */
export const commerceProductDetailsV1Schema = ReadonlyOpenObject({
  handle: Type.Union(
    [
      Type.Refine(boundedTextSchema(255), isProductHandle, productHandleError),
      Type.Null(),
    ],
    { default: null },
  ),
  productType: Type.String({ default: "" }),
  vendor: Type.String({ default: "" }),
  tags: ImmutableArray(boundedTextSchema(255), {
    uniqueItems: true,
    default: [],
  }),
  status: Type.Union(
    [Type.Literal("draft"), Type.Literal("active"), Type.Literal("archived")],
    { default: "active" },
  ),
});
export type CommerceProductDetailsV1 = Static<
  typeof commerceProductDetailsV1Schema
>;

/** `parseProduct`. */
export const commerceProductV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  title: text,
  description: Type.String(),
  ...commerceProductDetailsV1Schema.properties,
  occurredAt: utcTimestampSchema,
});
export type CommerceProductV1 = Static<typeof commerceProductV1Schema>;

/** `parseOption`. */
export const commerceVariantOptionV1Schema = ReadonlyOpenObject({
  name: text,
  value: text,
});

/** `parseMedia`. */
export const commerceVariantMediaV1Schema = ReadonlyOpenObject({
  kind: productMediaKindSchema,
  url: httpsUrlSchema,
  altText: Type.String(),
});

/** `parseVariant`. */
export const commerceVariantV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  productId: text,
  sku: text,
  title: text,
  options: ImmutableArray(commerceVariantOptionV1Schema),
  media: ImmutableArray(commerceVariantMediaV1Schema),
  barcode: Type.Union([boundedTextSchema(64), Type.Null()], {
    default: null,
  }),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")], {
    default: "active",
  }),
  occurredAt: utcTimestampSchema,
});
export type CommerceVariantV1 = Static<typeof commerceVariantV1Schema>;

/** `parseInventoryItem`. */
export const commerceInventoryItemV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  merchantCode: text,
  name: text,
  baseUnit: quantityUnitSchema,
  category: inventoryItemCategorySchema,
  tracking: wireInventoryTrackingSchema,
  lifecycle: inventoryItemLifecycleSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceInventoryItemV1 = Static<
  typeof commerceInventoryItemV1Schema
>;

/** `parseAvailableQuantity`: the amount may be negative. */
export const commerceAvailableQuantityV1Schema = Type.Refine(
  ReadonlyOpenObject({
    amount: SafeInteger,
    scale: Type.Integer({ minimum: 0, maximum: 6 }),
    unit: quantityUnitSchema,
  }),
  eachHasNoScale,
  eachScaleError,
);
export type CommerceAvailableQuantityV1 = Static<
  typeof commerceAvailableQuantityV1Schema
>;

/** `parseInventoryBalance`: on hand less allocated is available. */
export const commerceInventoryBalanceV1Schema = Type.Union([
  Type.Refine(
    ReadonlyOpenObject({
      kind: Type.Literal("accounted"),
      onHand: wireQuantitySchema,
      allocated: wireQuantitySchema,
      available: wireQuantitySchema,
    }),
    isBalanceConsistent,
    balanceError,
  ),
  ReadonlyOpenObject({
    kind: Type.Literal("available_only"),
    available: commerceAvailableQuantityV1Schema,
  }),
]);
export type CommerceInventoryBalanceV1 = Static<
  typeof commerceInventoryBalanceV1Schema
>;

/** `parseInventoryPosition`. */
export const commerceInventoryPositionV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  inventoryItemId: text,
  locationId: text,
  balance: commerceInventoryBalanceV1Schema,
  occurredAt: utcTimestampSchema,
});
export type CommerceInventoryPositionV1 = Static<
  typeof commerceInventoryPositionV1Schema
>;

/** `parseOnlineOrderConfiguration`: exact keys in each variant. */
export const commerceOnlineOrderConfigurationV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("checkout_profile"),
    checkoutProfile: checkoutProfileRecordReferenceSchema,
  }),
  ReadonlyStrictObject({ kind: Type.Literal("external_authority") }),
]);
export type CommerceOnlineOrderConfigurationV1 = Static<
  typeof commerceOnlineOrderConfigurationV1Schema
>;

/** `parseOrderOrigin`. */
export const commerceOrderOriginV1Schema = Type.Union([
  ReadonlyOpenObject({
    kind: Type.Literal("online"),
    salesChannelId: text,
    storefrontId: text,
    checkoutId: text,
    configuration: commerceOnlineOrderConfigurationV1Schema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("point_of_sale"),
    salesChannelId: text,
    locationId: text,
    checkoutId: text,
    terminalId: Type.Union([text, Type.Null()]),
    receiptNumber: text,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("marketplace"),
    salesChannelId: text,
    marketplaceOrderId: text,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("agent"),
    salesChannelId: text,
    caseId: text,
    externalReference: text,
  }),
]);
export type CommerceOrderOriginV1 = Static<
  typeof commerceOrderOriginV1Schema
>;

/** `parseOrderLineSource`. */
export const commerceOrderLineSourceV1Schema = Type.Union([
  ReadonlyOpenObject({
    kind: Type.Literal("catalog"),
    variantId: text,
    variantRevision: PositiveInteger,
    merchantCode: text,
    optionValues: ImmutableArray(checkoutOptionValueSchema),
    offerId: text,
    offerRevision: PositiveInteger,
    consumptionPlanId: text,
    consumptionPlanRevision: PositiveInteger,
    inventory: orderLineInventorySchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("food_service"),
    variantId: text,
    variantRevision: PositiveInteger,
    merchantCode: text,
    optionValues: ImmutableArray(checkoutOptionValueSchema),
    menuId: text,
    menuRevision: PositiveInteger,
    menuEntryId: text,
    menuEntryRevision: PositiveInteger,
    offerId: text,
    offerRevision: PositiveInteger,
    consumptionPlanId: text,
    consumptionPlanRevision: PositiveInteger,
    preparation: checkoutPreparationSchema,
    modifiers: ImmutableArray(checkoutModifierSelectionSchema),
    inventory: orderLineInventorySchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("source_only"),
    sourceItemReference: text,
  }),
]);
export type CommerceOrderLineSourceV1 = Static<
  typeof commerceOrderLineSourceV1Schema
>;

/**
 * `parseOrderLineItem`: a positive quantity, and a fulfilled quantity in its
 * unit that does not exceed it.
 */
export const commerceOrderLineItemV1Schema = Type.Refine(
  ReadonlyOpenObject({
    id: text,
    source: commerceOrderLineSourceV1Schema,
    sku: text,
    title: text,
    quantity: wireQuantitySchema,
    fulfilledQuantity: wireQuantitySchema,
    unitPrice: wireMoneySchema,
    tax: wireMoneySchema,
    discount: wireMoneySchema,
    lineTotal: wireMoneySchema,
  }),
  isFulfillableLine,
  fulfillableLineError,
);
export type CommerceOrderLineItemV1 = Static<
  typeof commerceOrderLineItemV1Schema
>;

/** `parseOrderTotals`. */
export const commerceOrderTotalsV1Schema = ReadonlyOpenObject({
  subtotal: wireMoneySchema,
  discount: wireMoneySchema,
  tax: wireMoneySchema,
  duty: wireMoneySchema,
  shipping: wireMoneySchema,
  serviceFee: wireMoneySchema,
  tip: wireMoneySchema,
  rounding: wireMoneySchema,
  total: wireMoneySchema,
  /** The listed prices include the tax, so the total does not add it. */
  taxIncluded: Type.Optional(Type.Literal(true)),
});
export type CommerceOrderTotalsV1 = Static<
  typeof commerceOrderTotalsV1Schema
>;

/** `parseOrderLifecycle`. */
export const commerceOrderLifecycleV1Schema = Type.Union([
  ReadonlyOpenObject({
    state: Type.Literal("pending_confirmation"),
    createdAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("confirmed"),
    confirmedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("fulfillment_pending"),
    since: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("partially_fulfilled"),
    since: utcTimestampSchema,
    fulfilledLineItemIds: ImmutableArray(text),
  }),
  ReadonlyOpenObject({
    state: Type.Literal("fulfilled"),
    fulfilledAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: utcTimestampSchema,
    reason: text,
  }),
]);
export type CommerceOrderLifecycleV1 = Static<
  typeof commerceOrderLifecycleV1Schema
>;

/** `parseOrderAdjustment`. */
export const commerceOrderAdjustmentV1Schema = ReadonlyOpenObject({
  id: text,
  kind: orderAdjustmentKindSchema,
  status: orderAdjustmentStatusSchema,
  occurredAt: utcTimestampSchema,
  amount: wireMoneySchema,
  reason: text,
});
export type CommerceOrderAdjustmentV1 = Static<
  typeof commerceOrderAdjustmentV1Schema
>;

/** `parseOrder`. */
export const commerceOrderV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  origin: commerceOrderOriginV1Schema,
  buyer: wireBuyerSchema,
  lineItems: ImmutableArray(commerceOrderLineItemV1Schema),
  totals: commerceOrderTotalsV1Schema,
  adjustments: ImmutableArray(commerceOrderAdjustmentV1Schema),
  lifecycle: commerceOrderLifecycleV1Schema,
  occurredAt: utcTimestampSchema,
  /** For an order in a market currency: the shop currency and the rate. */
  market: Type.Optional(commerceOrderMarketV1Schema),
});
export type CommerceOrderV1 = Static<typeof commerceOrderV1Schema>;

/** `parsePaymentLifecycle`. */
export const commercePaymentLifecycleV1Schema = Type.Union([
  ReadonlyOpenObject({
    state: Type.Literal("pending"),
    createdAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("authorized"),
    authorizedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("captured"),
    capturedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("failed"),
    failedAt: utcTimestampSchema,
    reason: text,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("partially_refunded"),
    refundedAt: utcTimestampSchema,
    refundedAmount: wireMoneySchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("refunded"),
    refundedAt: utcTimestampSchema,
    refundedAmount: wireMoneySchema,
  }),
]);
export type CommercePaymentLifecycleV1 = Static<
  typeof commercePaymentLifecycleV1Schema
>;

/** `parsePayment`. */
export const commercePaymentV1Schema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  orderId: text,
  amount: wireMoneySchema,
  lifecycle: commercePaymentLifecycleV1Schema,
  occurredAt: utcTimestampSchema,
});
export type CommercePaymentV1 = Static<typeof commercePaymentV1Schema>;

const requestedFulfillmentStates = [
  ReadonlyOpenObject({
    state: Type.Literal("requested"),
    requestedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: utcTimestampSchema,
    reason: text,
  }),
] as const;

const preparedFulfillmentStates = [
  ...requestedFulfillmentStates,
  ReadonlyOpenObject({
    state: Type.Literal("preparing"),
    startedAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("blocked"),
    blockedAt: utcTimestampSchema,
    reason: text,
  }),
] as const;

const completedFulfillmentState = ReadonlyOpenObject({
  state: Type.Literal("completed"),
  completedAt: utcTimestampSchema,
});

/** `parsePickupFulfillmentLifecycle`. */
export const commercePickupFulfillmentLifecycleV1Schema = Type.Union([
  ...preparedFulfillmentStates,
  ReadonlyOpenObject({
    state: Type.Literal("ready_for_pickup"),
    readyAt: utcTimestampSchema,
  }),
  completedFulfillmentState,
]);
export type CommercePickupFulfillmentLifecycleV1 = Static<
  typeof commercePickupFulfillmentLifecycleV1Schema
>;

/** `parseShippingFulfillmentLifecycle`. */
export const commerceShippingFulfillmentLifecycleV1Schema = Type.Union([
  ...preparedFulfillmentStates,
  ReadonlyOpenObject({
    state: Type.Literal("handed_to_carrier"),
    handedOverAt: utcTimestampSchema,
    shipmentId: text,
  }),
]);
export type CommerceShippingFulfillmentLifecycleV1 = Static<
  typeof commerceShippingFulfillmentLifecycleV1Schema
>;

/** `parseLocalDeliveryFulfillmentLifecycle` and the on-premise one. */
export const commerceLocalDeliveryFulfillmentLifecycleV1Schema = Type.Union([
  ...preparedFulfillmentStates,
  completedFulfillmentState,
]);
export type CommerceLocalDeliveryFulfillmentLifecycleV1 = Static<
  typeof commerceLocalDeliveryFulfillmentLifecycleV1Schema
>;
export type CommerceOnPremiseFulfillmentLifecycleV1 =
  CommerceLocalDeliveryFulfillmentLifecycleV1;

/** `parseImmediateHandoffFulfillmentLifecycle`. */
export const commerceImmediateHandoffFulfillmentLifecycleV1Schema =
  Type.Union([...requestedFulfillmentStates, completedFulfillmentState]);
export type CommerceImmediateHandoffFulfillmentLifecycleV1 = Static<
  typeof commerceImmediateHandoffFulfillmentLifecycleV1Schema
>;

/** `parseFulfillmentLineItem`. */
export const commerceFulfillmentLineItemV1Schema = ReadonlyOpenObject({
  lineItemId: text,
  quantity: PositiveInteger,
});
export type CommerceFulfillmentLineItemV1 = Static<
  typeof commerceFulfillmentLineItemV1Schema
>;

const fulfillmentBaseSchema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  orderId: text,
  lineItems: ImmutableArray(commerceFulfillmentLineItemV1Schema),
  locationId: text,
  expectedBy: utcTimestampSchema,
  occurredAt: utcTimestampSchema,
});

/** `parseFulfillment`. */
export const commerceFulfillmentV1Schema = Type.Union([
  Type.Intersect([
    fulfillmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("shipping"),
      binding: shippingFulfillmentBindingSchema,
      lifecycle: commerceShippingFulfillmentLifecycleV1Schema,
    }),
  ]),
  Type.Intersect([
    fulfillmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("pickup"),
      lifecycle: commercePickupFulfillmentLifecycleV1Schema,
    }),
  ]),
  Type.Intersect([
    fulfillmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("local_delivery"),
      lifecycle: commerceLocalDeliveryFulfillmentLifecycleV1Schema,
    }),
  ]),
  Type.Intersect([
    fulfillmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("immediate_handoff"),
      lifecycle: commerceImmediateHandoffFulfillmentLifecycleV1Schema,
    }),
  ]),
  Type.Intersect([
    fulfillmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("on_premise"),
      lifecycle: commerceLocalDeliveryFulfillmentLifecycleV1Schema,
    }),
  ]),
]);
export type CommerceFulfillmentV1 = Static<
  typeof commerceFulfillmentV1Schema
>;

/** `parseTrackingEventKind`. */
export const commerceTrackingEventKindV1Schema = Type.Union([
  ReadonlyOpenObject({ kind: Type.Literal("label_created") }),
  ReadonlyOpenObject({ kind: Type.Literal("in_transit") }),
  ReadonlyOpenObject({
    kind: Type.Literal("delivery_exception"),
    reason: text,
  }),
  ReadonlyOpenObject({ kind: Type.Literal("delivered") }),
  ReadonlyOpenObject({ kind: Type.Literal("returned") }),
]);
export type CommerceTrackingEventKindV1 = Static<
  typeof commerceTrackingEventKindV1Schema
>;

/** `parseTrackingEvent`. */
export const commerceTrackingEventV1Schema = ReadonlyOpenObject({
  id: text,
  occurredAt: utcTimestampSchema,
  kind: commerceTrackingEventKindV1Schema,
  location: text,
});
export type CommerceTrackingEventV1 = Static<
  typeof commerceTrackingEventV1Schema
>;

const shipmentBaseSchema = ReadonlyOpenObject({
  id: text,
  revision: PositiveInteger,
  orderId: text,
  fulfillmentId: text,
  events: ImmutableArray(commerceTrackingEventV1Schema),
  occurredAt: utcTimestampSchema,
});

/** `parseShipment`. */
export const commerceShipmentV1Schema = Type.Union([
  Type.Intersect([
    shipmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("first_party"),
      package: shipmentPackageSchema,
      lifecycle: firstPartyShipmentLifecycleSchema,
    }),
  ]),
  Type.Intersect([
    shipmentBaseSchema,
    ReadonlyOpenObject({
      kind: Type.Literal("external"),
      carrier: text,
      trackingNumber: text,
      estimatedDeliveryAt: utcTimestampSchema,
      lifecycle: externalShipmentLifecycleSchema,
    }),
  ]),
]);
export type CommerceShipmentV1 = Static<typeof commerceShipmentV1Schema>;

/** `parseResources`: orders and their effects are optional. */
export const commerceResourcesV1Schema = ReadonlyOpenObject({
  locations: ImmutableArray(wireLocationSchema),
  salesChannels: ImmutableArray(wireSalesChannelSchema),
  products: ImmutableArray(commerceProductV1Schema),
  variants: ImmutableArray(commerceVariantV1Schema),
  inventoryItems: ImmutableArray(commerceInventoryItemV1Schema),
  offers: ImmutableArray(wireOfferSchema),
  inventoryPositions: ImmutableArray(commerceInventoryPositionV1Schema),
  orders: ImmutableArray(commerceOrderV1Schema, { default: [] }),
  payments: ImmutableArray(commercePaymentV1Schema, { default: [] }),
  fulfillments: ImmutableArray(commerceFulfillmentV1Schema, { default: [] }),
  shipments: ImmutableArray(commerceShipmentV1Schema, { default: [] }),
});
export type CommerceResourcesV1 = Static<
  typeof commerceResourcesV1Schema
>;

/** `parseMerchantSnapshot`. */
export const commerceMerchantSnapshotV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.commerce-snapshot.v2"),
  merchantId: text,
  merchantRevision: NonNegativeInteger,
  deliverySigner: ReadonlyOpenObject({
    keyId: text,
    algorithm: Type.Literal("ed25519"),
    publicKeyB64: text,
  }),
  resources: commerceResourcesV1Schema,
});
export type CommerceMerchantSnapshotV1 = Static<
  typeof commerceMerchantSnapshotV1Schema
>;

/** `parseInventoryLot`: a received amount, and one scale and unit. */
export const commerceInventoryLotV1Schema = Type.Refine(
  ReadonlyOpenObject({
    id: text,
    lotCode: text,
    inventoryItemId: text,
    locationId: text,
    revision: PositiveInteger,
    sourceMovementId: text,
    receivedQuantity: wireQuantitySchema,
    remainingQuantity: wireQuantitySchema,
    expiry: wireInventoryLotExpirySchema,
    lifecycle: Type.Union([
      ReadonlyStrictObject({ state: Type.Literal("available") }),
      ReadonlyStrictObject({ state: Type.Literal("depleted") }),
      ReadonlyOpenObject({
        state: Type.Literal("quarantined"),
        reason: text,
      }),
      ReadonlyStrictObject({ state: Type.Literal("expired") }),
    ]),
    occurredAt: utcTimestampSchema,
  }),
  isLotQuantityValid,
  lotQuantityError,
);
export type CommerceInventoryLotV1 = Static<
  typeof commerceInventoryLotV1Schema
>;

/** `parseLotAllocation`. */
export const commerceLotAllocationV1Schema = ReadonlyOpenObject({
  lotId: text,
  quantity: Type.Refine(wireQuantitySchema, hasPositiveAmount, amountError),
});
export type CommerceLotAllocationV1 = Static<
  typeof commerceLotAllocationV1Schema
>;

/** `parseStockCountReason`. */
export const commerceStockCountReasonSchema = ReadonlyOpenObject({
  kind: Type.Literal("stock_count"),
  countId: text,
  explanation: text,
  observedQuantity: wireQuantitySchema,
});
export type CommerceStockCountReason = Static<
  typeof commerceStockCountReasonSchema
>;

const productionReasonSchema = ReadonlyOpenObject({
  kind: Type.Literal("production"),
  productionBatchId: text,
  recipeRevision: PositiveInteger,
});

/**
 * `parseInventoryMovementChange`: an amount of zero only for a stock count
 * that increases. A decrease names the lots it takes, which sum to it.
 */
const inventoryMovementChangeSchema = Type.Union([
  Type.Refine(
    ReadonlyOpenObject({
      kind: Type.Literal("increase"),
      quantity: wireQuantitySchema,
      reason: Type.Union([
        commerceStockCountReasonSchema,
        ReadonlyOpenObject({
          kind: Type.Literal("correction"),
          explanation: text,
        }),
        ReadonlyOpenObject({
          kind: Type.Literal("receipt"),
          receiptId: text,
          receiptLineId: text,
          purchase: wireInventoryReceiptPurchaseSchema,
        }),
        productionReasonSchema,
      ]),
    }),
    isIncreaseAmountValid,
    amountError,
  ),
  Type.Refine(
    ReadonlyOpenObject({
      kind: Type.Literal("decrease"),
      quantity: Type.Refine(wireQuantitySchema, hasPositiveAmount, amountError),
      reason: Type.Union([
        commerceStockCountReasonSchema,
        ReadonlyOpenObject({
          kind: Type.Union([
            Type.Literal("correction"),
            Type.Literal("waste"),
            Type.Literal("damage"),
          ]),
          explanation: text,
        }),
        ReadonlyOpenObject({
          kind: Type.Literal("sale"),
          orderId: text,
          orderLineId: text,
        }),
        ReadonlyOpenObject({
          kind: Type.Literal("preparation"),
          ticketId: text,
          recipeRevision: PositiveInteger,
        }),
        productionReasonSchema,
      ]),
      lotAllocation: Type.Union([
        ReadonlyStrictObject({ kind: Type.Literal("not_tracked") }),
        ReadonlyOpenObject({
          kind: Type.Literal("allocated"),
          lots: ImmutableArray(commerceLotAllocationV1Schema),
        }),
      ]),
    }),
    lotsCoverDecrease,
    lotAllocationError,
  ),
]);

/** `parseInventoryMovement`. */
export const commerceInventoryMovementV1Schema = ReadonlyOpenObject({
  id: text,
  inventoryItemId: text,
  locationId: text,
  change: inventoryMovementChangeSchema,
  occurredAt: utcTimestampSchema,
  idempotencyKey: text,
});
export type CommerceInventoryMovementV1 = Static<
  typeof commerceInventoryMovementV1Schema
>;

/** `parseCheckoutQuoteTotals`: the reader leaves the key check to its caller. */
export const parsedQuoteTotalsSchema = ReadonlyOpenObject({
  subtotal: wireMoneySchema,
  tax: wireMoneySchema,
  duty: wireMoneySchema,
  shipping: wireMoneySchema,
  total: wireMoneySchema,
  /** The line discounts already taken from the subtotal. */
  discount: Type.Optional(wireMoneySchema),
  /** The listed prices include the tax, so the total does not add it. */
  taxIncluded: Type.Optional(Type.Literal(true)),
});
export type ParsedQuoteTotals = Static<typeof parsedQuoteTotalsSchema>;

type Quantity = Readonly<{ amount: number; scale: number; unit: string }>;

function isProductHandle(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function productHandleError(): string {
  return "must be lowercase words joined by hyphens";
}

function eachHasNoScale(quantity: Quantity): boolean {
  return quantity.unit !== "each" || quantity.scale === 0;
}

function eachScaleError(): string {
  return "an each quantity has no scale";
}

function isBalanceConsistent(
  balance: Readonly<{
    onHand: Quantity;
    allocated: Quantity;
    available: Quantity;
  }>,
): boolean {
  const { onHand, allocated, available } = balance;
  return (
    onHand.unit === allocated.unit &&
    onHand.unit === available.unit &&
    onHand.scale === allocated.scale &&
    onHand.scale === available.scale &&
    onHand.amount - allocated.amount === available.amount
  );
}

function balanceError(): string {
  return "the balance is inconsistent";
}

function isFulfillableLine(
  line: Readonly<{ quantity: Quantity; fulfilledQuantity: Quantity }>,
): boolean {
  const { quantity, fulfilledQuantity } = line;
  return (
    quantity.amount !== 0 &&
    quantity.unit === fulfilledQuantity.unit &&
    BigInt(fulfilledQuantity.amount) * 10n ** BigInt(quantity.scale) <=
      BigInt(quantity.amount) * 10n ** BigInt(fulfilledQuantity.scale)
  );
}

function fulfillableLineError(): string {
  return "the quantity must be positive and not less than the fulfilled quantity";
}

function isLotQuantityValid(
  lot: Readonly<{ receivedQuantity: Quantity; remainingQuantity: Quantity }>,
): boolean {
  const { receivedQuantity, remainingQuantity } = lot;
  return (
    receivedQuantity.amount !== 0 &&
    receivedQuantity.scale === remainingQuantity.scale &&
    receivedQuantity.unit === remainingQuantity.unit
  );
}

function lotQuantityError(): string {
  return "the lot quantities are invalid";
}

function hasPositiveAmount(quantity: Quantity): boolean {
  return quantity.amount > 0;
}

function amountError(): string {
  return "the amount must be positive";
}

function isIncreaseAmountValid(
  change: Readonly<{ quantity: Quantity; reason: Readonly<{ kind: string }> }>,
): boolean {
  return change.quantity.amount > 0 || change.reason.kind === "stock_count";
}

/**
 * The lots of a decrease are in its unit and sum, at the largest scale, to
 * its quantity (`validateLotAllocations`). The reader's duplicate check never
 * refuses, so a lot may repeat.
 */
function lotsCoverDecrease(
  change: Readonly<{
    quantity: Quantity;
    lotAllocation:
      | Readonly<{ kind: "not_tracked" }>
      | Readonly<{
          kind: "allocated";
          lots: readonly Readonly<{ quantity: Quantity }>[];
        }>;
  }>,
): boolean {
  const allocation = change.lotAllocation;
  if (allocation.kind === "not_tracked") return true;
  const { lots } = allocation;
  if (lots.length === 0) return false;
  if (lots.some(hasOtherUnit.bind(undefined, change.quantity.unit)))
    return false;
  let scale = change.quantity.scale;
  for (const lot of lots) scale = Math.max(scale, lot.quantity.scale);
  let total = 0n;
  for (const lot of lots) total += scaledAmount(lot.quantity, scale);
  return total === scaledAmount(change.quantity, scale);
}

function hasOtherUnit(
  unit: string,
  lot: Readonly<{ quantity: Quantity }>,
): boolean {
  return lot.quantity.unit !== unit;
}

function scaledAmount(quantity: Quantity, scale: number): bigint {
  return BigInt(quantity.amount) * 10n ** BigInt(scale - quantity.scale);
}

function lotAllocationError(): string {
  return "the lot allocations must sum to the movement quantity";
}

// Parsers of the records above (Plan 78 step 2).
export const parseCommerceProductDetailsV1 = recordParser(
  commerceProductDetailsV1Schema,
  "product",
);
export const parseCommerceProductV1 = recordParser(
  commerceProductV1Schema,
  "product",
);
export const parseCommerceVariantV1 = recordParser(
  commerceVariantV1Schema,
  "variant",
);
export const parseCommerceVariantOptionV1 = recordParser(
  commerceVariantOptionV1Schema,
  "variant.option",
);
export const parseCommerceVariantMediaV1 = recordParser(
  commerceVariantMediaV1Schema,
  "variant.media",
);
export const parseCommerceLocationV1 = recordParser(
  wireLocationSchema,
  "location",
);
export const parseCommerceSalesChannelV1 = recordParser(
  wireSalesChannelSchema,
  "salesChannel",
);
export const parseCommerceInventoryItemV1 = recordParser(
  commerceInventoryItemV1Schema,
  "inventoryItem",
);
export const parseCommerceInventoryTrackingV1 = recordParser(
  wireInventoryTrackingSchema,
  "inventoryItem.tracking",
);
export const parseCommerceOfferV1 = recordParser(wireOfferSchema, "offer");
export const parseCommerceInventoryPositionV1 = recordParser(
  commerceInventoryPositionV1Schema,
  "inventoryPosition",
);
export const parseCommerceOrderV1 = recordParser(
  commerceOrderV1Schema,
  "order",
);
export const parseCommerceBuyerV1 = recordParser(
  wireBuyerSchema,
  "order.buyer",
);
export const parseCommercePaymentV1 = recordParser(
  commercePaymentV1Schema,
  "payment",
);
export const parseCommerceFulfillmentV1 = recordParser(
  commerceFulfillmentV1Schema,
  "fulfillment",
);
export const parseCommerceShipmentV1 = recordParser(
  commerceShipmentV1Schema,
  "shipment",
);
export const parseCommerceMerchantSnapshotV1 = recordParser(
  commerceMerchantSnapshotV1Schema,
  "snapshot",
);
export const parseCommerceInventoryLotV1 = recordParser(
  commerceInventoryLotV1Schema,
  "inventoryLot",
);
export const parseCommerceInventoryMovementV1 = recordParser(
  commerceInventoryMovementV1Schema,
  "inventoryMovement",
);
export const parseCommerceInventoryReceiptPurchaseV1 = recordParser(
  wireInventoryReceiptPurchaseSchema,
  "purchase",
);

/**
 * The parser of a field record whose client reader names the field it reads,
 * such as `parseMoney(value, "order.totals.total")`. Each field has one.
 */
export function fieldRecordParser<T extends TSchema>(
  schema: T,
  field: string,
): (input: unknown) => ContractDecodeResult<Static<T>> {
  let parsers = fieldRecordParsers.get(schema);
  if (parsers === undefined) {
    parsers = new Map();
    fieldRecordParsers.set(schema, parsers);
  }
  let parser = parsers.get(field);
  if (parser === undefined) {
    parser = recordParser(schema, field);
    parsers.set(field, parser);
  }
  return parser as (input: unknown) => ContractDecodeResult<Static<T>>;
}

const fieldRecordParsers = new WeakMap<
  TSchema,
  Map<string, (input: unknown) => ContractDecodeResult<unknown>>
>();

/** `parseCompareAtPrice`: none, or a positive price in the offer currency. */
export function compareAtPriceParser(
  currency: unknown,
): (input: unknown) => ContractDecodeResult<CommerceCompareAtPriceV1> {
  return recordParser(
    Type.Refine(
      commerceCompareAtPriceV1Schema,
      usesCurrency.bind(undefined, currency),
      compareAtCurrencyError,
    ),
    "offer.compareAtPrice",
  );
}

export const commerceCompareAtPriceV1Schema = Type.Union(
  [
    ReadonlyOpenObject({
      amountMinor: PositiveInteger,
      currency: currencyCodeTextSchema,
    }),
    Type.Null(),
  ],
  { default: null },
);
export type CommerceCompareAtPriceV1 = Static<
  typeof commerceCompareAtPriceV1Schema
>;

function usesCurrency(
  currency: unknown,
  price: CommerceCompareAtPriceV1,
): boolean {
  return price === null || price.currency === currency;
}

function compareAtCurrencyError(): string {
  return "must use the offer currency";
}

export { commerceOrderMarketV1Schema, type CommerceOrderMarketV1 };
