// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  OpenObject,
  PositiveInteger,
  SafeInteger,
  StrictObject,
  recordParser,
} from "../schema.ts";
import { checkoutProfileReferenceSchema } from "./checkout-profile.ts";
import {
  hasUniqueValues,
  identityTextSchema,
  marketCurrencySchema,
  marketRateSchema,
  nonNegativeMoneySchema,
  quantityRecordSchema,
  uniqueValuesError,
} from "./commerce-fields.ts";
import {
  countryCodeTextSchema,
  currencyCodeTextSchema,
  hsCodeSchema,
  normalizedTextSchema,
  sha256HexSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  integrationAccountIdSchema,
  menuEntryIdSchema,
  menuIdSchema,
  menuSectionIdSchema,
  modifierGroupIdSchema,
  modifierOptionIdSchema,
  preparationStationIdSchema,
  preparationTicketIdSchema,
  productionBatchIdSchema,
  providerDeliveryIdSchema,
  recipeIdSchema,
  resourceIdSchema,
  shipmentEntityIdSchema,
} from "./identifiers.ts";
import { currencyCodeSchema, moneySchema } from "./money.ts";
import { preparationTicketLifecycleSchema } from "./preparation-ticket-lifecycle.ts";
export * from "./preparation-ticket-lifecycle.ts";
import {
  commerceTimestampSchema,
  sourceProvenanceSchema,
} from "./provenance.ts";

export const quantityUnitSchema = Type.Union([
  Type.Literal("each"),
  Type.Literal("gram"),
  Type.Literal("kilogram"),
  Type.Literal("milliliter"),
  Type.Literal("liter"),
]);
export type QuantityUnit = Static<typeof quantityUnitSchema>;

export const availableQuantitySchema = OpenObject({
  amount: SafeInteger,
  scale: SafeInteger,
  unit: quantityUnitSchema,
});
export type AvailableQuantity = Static<typeof availableQuantitySchema>;

export const buyerSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("identified"),
    customerReference: Type.String(),
  }),
  OpenObject({ kind: Type.Literal("guest") }),
]);
export type Buyer = Static<typeof buyerSchema>;

export const productSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  title: Type.String(),
  description: Type.String(),
});
export type Product = Static<typeof productSchema>;

export const productOptionSchema = OpenObject({
  name: Type.String(),
  value: Type.String(),
});
export type ProductOption = Static<typeof productOptionSchema>;

export const productMediaKindSchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("model3d"),
]);
export type ProductMediaKind = Static<typeof productMediaKindSchema>;

export const productMediaSchema = OpenObject({
  kind: productMediaKindSchema,
  url: Type.String(),
  altText: Type.String(),
});
export type ProductMedia = Static<typeof productMediaSchema>;

export const sellableVariantSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  productId: resourceIdSchema,
  variantId: resourceIdSchema,
  sku: Type.String(),
  title: Type.String(),
  options: Type.Array(productOptionSchema),
  media: Type.Array(productMediaSchema),
});
export type SellableVariant = Static<typeof sellableVariantSchema>;

export const inventoryItemCategorySchema = Type.Union([
  Type.Literal("ingredient"),
  Type.Literal("packaging"),
  Type.Literal("finished_good"),
  Type.Literal("operating_supply"),
]);
export type InventoryItemCategory = Static<typeof inventoryItemCategorySchema>;

export const inventoryExpiryTrackingSchema = Type.Union([
  Type.Literal("required"),
  Type.Literal("optional"),
]);
export type InventoryExpiryTracking = Static<
  typeof inventoryExpiryTrackingSchema
>;

export const inventoryTrackingPolicySchema = Type.Union([
  OpenObject({ kind: Type.Literal("aggregate") }),
  OpenObject({
    kind: Type.Literal("lot_tracked"),
    expiry: inventoryExpiryTrackingSchema,
  }),
]);
export type InventoryTrackingPolicy = Static<
  typeof inventoryTrackingPolicySchema
>;

export const inventoryItemLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type InventoryItemLifecycle = Static<
  typeof inventoryItemLifecycleSchema
>;

export const inventoryItemSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  merchantCode: Type.String(),
  name: Type.String(),
  baseUnit: quantityUnitSchema,
  category: inventoryItemCategorySchema,
  tracking: inventoryTrackingPolicySchema,
  lifecycle: inventoryItemLifecycleSchema,
});
export type InventoryItem = Static<typeof inventoryItemSchema>;

export const locationKindSchema = Type.Union([
  Type.Literal("store"),
  Type.Literal("warehouse"),
  Type.Literal("fulfillment_center"),
  Type.Literal("pickup_point"),
]);
export type LocationKind = Static<typeof locationKindSchema>;

export const locationLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("active"),
    activeAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("inactive"),
    inactiveAt: commerceTimestampSchema,
  }),
]);
export type LocationLifecycle = Static<typeof locationLifecycleSchema>;

export const locationSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  name: Type.String(),
  kind: locationKindSchema,
  lifecycle: locationLifecycleSchema,
});
export type Location = Static<typeof locationSchema>;

export const salesChannelKindSchema = Type.Union([
  Type.Literal("online"),
  Type.Literal("point_of_sale"),
  Type.Literal("marketplace"),
  Type.Literal("agent"),
]);
export type SalesChannelKind = Static<typeof salesChannelKindSchema>;

export const salesChannelLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("active"),
    activeAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("inactive"),
    inactiveAt: commerceTimestampSchema,
  }),
]);
export type SalesChannelLifecycle = Static<typeof salesChannelLifecycleSchema>;

export const salesChannelSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  name: Type.String(),
  kind: salesChannelKindSchema,
  lifecycle: salesChannelLifecycleSchema,
});
export type SalesChannel = Static<typeof salesChannelSchema>;

export const sellableVariantAvailabilitySchema = Type.Union([
  OpenObject({ state: Type.Literal("available") }),
  OpenObject({ state: Type.Literal("unavailable") }),
  OpenObject({
    state: Type.Literal("backordered"),
    expectedAt: commerceTimestampSchema,
  }),
]);
export type SellableVariantAvailability = Static<
  typeof sellableVariantAvailabilitySchema
>;

export const offerLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("prepared"),
    preparedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("listed"),
    listedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("archived"),
    archivedAt: commerceTimestampSchema,
  }),
]);
export type OfferLifecycle = Static<typeof offerLifecycleSchema>;

export const offerSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  variantId: resourceIdSchema,
  salesChannelId: resourceIdSchema,
  price: moneySchema,
  availability: sellableVariantAvailabilitySchema,
  lifecycle: offerLifecycleSchema,
});
export type Offer = Static<typeof offerSchema>;

export const quantitySchema = OpenObject({
  amount: SafeInteger,
  scale: SafeInteger,
  unit: quantityUnitSchema,
});
export type Quantity = Static<typeof quantitySchema>;

export const inventoryBalanceSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("accounted"),
    onHand: quantitySchema,
    allocated: quantitySchema,
    available: quantitySchema,
  }),
  OpenObject({
    kind: Type.Literal("available_only"),
    available: availableQuantitySchema,
  }),
]);
export type InventoryBalance = Static<typeof inventoryBalanceSchema>;

export const inventoryPositionSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  balance: inventoryBalanceSchema,
});
export type InventoryPosition = Static<typeof inventoryPositionSchema>;

export const inventoryReceiptPurchaseSchema = Type.Union([
  OpenObject({ kind: Type.Literal("unlinked") }),
  OpenObject({
    kind: Type.Literal("replenishment"),
    entryId: Type.String(),
    entryRevision: SafeInteger,
  }),
]);
export type InventoryReceiptPurchase = Static<
  typeof inventoryReceiptPurchaseSchema
>;

export const inventoryIncreaseReasonSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("stock_count"),
    countId: resourceIdSchema,
    explanation: Type.String(),
    observedQuantity: quantitySchema,
  }),
  OpenObject({ kind: Type.Literal("correction"), explanation: Type.String() }),
  OpenObject({
    kind: Type.Literal("receipt"),
    receiptId: resourceIdSchema,
    receiptLineId: resourceIdSchema,
    purchase: inventoryReceiptPurchaseSchema,
  }),
  OpenObject({
    kind: Type.Literal("production"),
    productionBatchId: resourceIdSchema,
    recipeRevision: SafeInteger,
  }),
]);
export type InventoryIncreaseReason = Static<
  typeof inventoryIncreaseReasonSchema
>;

export const inventoryDecreaseReasonSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("stock_count"),
    countId: resourceIdSchema,
    explanation: Type.String(),
    observedQuantity: quantitySchema,
  }),
  OpenObject({ kind: Type.Literal("correction"), explanation: Type.String() }),
  OpenObject({ kind: Type.Literal("waste"), explanation: Type.String() }),
  OpenObject({ kind: Type.Literal("damage"), explanation: Type.String() }),
  OpenObject({
    kind: Type.Literal("sale"),
    orderId: resourceIdSchema,
    orderLineId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("preparation"),
    ticketId: resourceIdSchema,
    recipeRevision: SafeInteger,
  }),
  OpenObject({
    kind: Type.Literal("production"),
    productionBatchId: resourceIdSchema,
    recipeRevision: SafeInteger,
  }),
]);
export type InventoryDecreaseReason = Static<
  typeof inventoryDecreaseReasonSchema
>;

export const lotAllocationSchema = OpenObject({
  lotId: resourceIdSchema,
  quantity: quantitySchema,
});
export type LotAllocation = Static<typeof lotAllocationSchema>;

export const inventoryLotAllocationSchema = Type.Union([
  OpenObject({ kind: Type.Literal("not_tracked") }),
  OpenObject({
    kind: Type.Literal("allocated"),
    lots: Type.Array(lotAllocationSchema),
  }),
]);
export type InventoryLotAllocation = Static<
  typeof inventoryLotAllocationSchema
>;

export const inventoryMovementChangeSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("increase"),
    quantity: quantitySchema,
    reason: inventoryIncreaseReasonSchema,
  }),
  OpenObject({
    kind: Type.Literal("decrease"),
    quantity: quantitySchema,
    reason: inventoryDecreaseReasonSchema,
    lotAllocation: inventoryLotAllocationSchema,
  }),
]);
export type InventoryMovementChange = Static<
  typeof inventoryMovementChangeSchema
>;

export const inventoryMovementProjectionSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  change: inventoryMovementChangeSchema,
  idempotencyKey: Type.String(),
});
export type InventoryMovementProjection = Static<
  typeof inventoryMovementProjectionSchema
>;

export const inventoryLotExpirySchema = Type.Union([
  OpenObject({ kind: Type.Literal("not_tracked") }),
  OpenObject({
    kind: Type.Literal("expires"),
    expiresAt: commerceTimestampSchema,
  }),
]);
export type InventoryLotExpiry = Static<typeof inventoryLotExpirySchema>;

export const inventoryLotLifecycleSchema = Type.Union([
  OpenObject({ state: Type.Literal("available") }),
  OpenObject({ state: Type.Literal("depleted") }),
  OpenObject({ state: Type.Literal("quarantined"), reason: Type.String() }),
  OpenObject({ state: Type.Literal("expired") }),
]);
export type InventoryLotLifecycle = Static<typeof inventoryLotLifecycleSchema>;

export const inventoryLotProjectionSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  lotCode: Type.String(),
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  sourceMovementId: resourceIdSchema,
  receivedQuantity: quantitySchema,
  remainingQuantity: quantitySchema,
  expiry: inventoryLotExpirySchema,
  lifecycle: inventoryLotLifecycleSchema,
});
export type InventoryLotProjection = Static<
  typeof inventoryLotProjectionSchema
>;

export const onlineOrderConfigurationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("checkout_profile"),
    checkoutProfile: checkoutProfileReferenceSchema,
  }),
  OpenObject({ kind: Type.Literal("external_authority") }),
]);
export type OnlineOrderConfiguration = Static<
  typeof onlineOrderConfigurationSchema
>;

export const orderOriginSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("online"),
    salesChannelId: resourceIdSchema,
    storefrontId: Type.String(),
    checkoutId: resourceIdSchema,
    configuration: onlineOrderConfigurationSchema,
  }),
  OpenObject({
    kind: Type.Literal("point_of_sale"),
    salesChannelId: resourceIdSchema,
    locationId: resourceIdSchema,
    checkoutId: resourceIdSchema,
    terminalId: Type.Union([Type.String(), Type.Null()]),
    receiptNumber: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("marketplace"),
    salesChannelId: resourceIdSchema,
    marketplaceOrderId: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("agent"),
    salesChannelId: resourceIdSchema,
    caseId: Type.String(),
    externalReference: Type.String(),
  }),
]);
export type OrderOrigin = Static<typeof orderOriginSchema>;

export const inventoryRequirementSchema = OpenObject({
  inventoryItemId: resourceIdSchema,
  quantity: quantitySchema,
});
export type InventoryRequirement = Static<typeof inventoryRequirementSchema>;

export const orderLineInventorySchema = Type.Union([
  OpenObject({ kind: Type.Literal("untracked") }),
  OpenObject({
    kind: Type.Literal("requirements"),
    items: Type.Array(inventoryRequirementSchema),
  }),
]);
export type OrderLineInventory = Static<typeof orderLineInventorySchema>;

export const foodServicePreparationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("immediate_recipe"),
    recipeId: recipeIdSchema,
    recipeRevision: SafeInteger,
  }),
  OpenObject({ kind: Type.Literal("stocked_inventory") }),
]);
export type FoodServicePreparation = Static<
  typeof foodServicePreparationSchema
>;

export const inventoryRequirementAdjustmentSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("add"),
    inventoryItemId: resourceIdSchema,
    quantity: quantitySchema,
  }),
  OpenObject({
    kind: Type.Literal("reduce"),
    inventoryItemId: resourceIdSchema,
    quantity: quantitySchema,
  }),
]);
export type InventoryRequirementAdjustment = Static<
  typeof inventoryRequirementAdjustmentSchema
>;

export const modifierSelectionSnapshotSchema = OpenObject({
  modifierGroupId: modifierGroupIdSchema,
  modifierGroupRevision: SafeInteger,
  modifierOptionId: modifierOptionIdSchema,
  name: Type.String(),
  priceDelta: moneySchema,
  requirementAdjustments: Type.Array(inventoryRequirementAdjustmentSchema),
});
export type ModifierSelectionSnapshot = Static<
  typeof modifierSelectionSnapshotSchema
>;

export const orderLineSourceSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("catalog"),
    variantId: resourceIdSchema,
    variantRevision: SafeInteger,
    merchantCode: Type.String(),
    optionValues: Type.Array(productOptionSchema),
    offerId: resourceIdSchema,
    offerRevision: SafeInteger,
    consumptionPlanId: resourceIdSchema,
    consumptionPlanRevision: SafeInteger,
    inventory: orderLineInventorySchema,
  }),
  OpenObject({
    kind: Type.Literal("food_service"),
    variantId: resourceIdSchema,
    variantRevision: SafeInteger,
    merchantCode: Type.String(),
    optionValues: Type.Array(productOptionSchema),
    menuId: menuIdSchema,
    menuRevision: SafeInteger,
    menuEntryId: menuEntryIdSchema,
    menuEntryRevision: SafeInteger,
    offerId: resourceIdSchema,
    offerRevision: SafeInteger,
    consumptionPlanId: resourceIdSchema,
    consumptionPlanRevision: SafeInteger,
    preparation: foodServicePreparationSchema,
    modifiers: Type.Array(modifierSelectionSnapshotSchema),
    inventory: orderLineInventorySchema,
  }),
  OpenObject({
    kind: Type.Literal("source_only"),
    sourceItemReference: Type.String(),
  }),
]);
export type OrderLineSource = Static<typeof orderLineSourceSchema>;

export const orderLineItemSchema = OpenObject({
  lineItemId: resourceIdSchema,
  source: orderLineSourceSchema,
  sku: Type.String(),
  title: Type.String(),
  quantity: quantitySchema,
  fulfilledQuantity: quantitySchema,
  unitPrice: moneySchema,
  tax: moneySchema,
  discount: moneySchema,
  lineTotal: moneySchema,
});
export type OrderLineItem = Static<typeof orderLineItemSchema>;

export const orderTotalsSchema = OpenObject({
  subtotal: moneySchema,
  discount: moneySchema,
  tax: moneySchema,
  duty: moneySchema,
  shipping: moneySchema,
  serviceFee: moneySchema,
  tip: moneySchema,
  rounding: moneySchema,
  total: moneySchema,
  /** The listed prices include the tax, so the total does not add it. */
  taxIncluded: Type.Optional(Type.Literal(true)),
});
export type OrderTotals = Static<typeof orderTotalsSchema>;

export const orderAdjustmentKindSchema = Type.Union([
  Type.Literal("refund"),
  Type.Literal("credit"),
  Type.Literal("price_adjustment"),
  Type.Literal("dispute"),
  Type.Literal("cancellation"),
]);
export type OrderAdjustmentKind = Static<typeof orderAdjustmentKindSchema>;

export const orderAdjustmentStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export type OrderAdjustmentStatus = Static<typeof orderAdjustmentStatusSchema>;

export const orderAdjustmentSchema = OpenObject({
  adjustmentId: resourceIdSchema,
  kind: orderAdjustmentKindSchema,
  status: orderAdjustmentStatusSchema,
  occurredAt: commerceTimestampSchema,
  amount: moneySchema,
  reason: Type.String(),
});
export type OrderAdjustment = Static<typeof orderAdjustmentSchema>;

export const orderLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("pending_confirmation"),
    createdAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("confirmed"),
    confirmedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("fulfillment_pending"),
    since: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("partially_fulfilled"),
    since: commerceTimestampSchema,
    fulfilledLineItemIds: Type.Array(resourceIdSchema),
  }),
  OpenObject({
    state: Type.Literal("fulfilled"),
    fulfilledAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type OrderLifecycle = Static<typeof orderLifecycleSchema>;

export const commerceOrderSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  origin: orderOriginSchema,
  buyer: buyerSchema,
  lineItems: Type.Array(orderLineItemSchema),
  totals: orderTotalsSchema,
  adjustments: Type.Array(orderAdjustmentSchema),
  lifecycle: orderLifecycleSchema,
});
export type CommerceOrder = Static<typeof commerceOrderSchema>;

export const paymentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("pending"),
    createdAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("authorized"),
    authorizedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("captured"),
    capturedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("failed"),
    failedAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("partially_refunded"),
    refundedAt: commerceTimestampSchema,
    refundedAmount: moneySchema,
  }),
  OpenObject({
    state: Type.Literal("refunded"),
    refundedAt: commerceTimestampSchema,
    refundedAmount: moneySchema,
  }),
]);
export type PaymentLifecycle = Static<typeof paymentLifecycleSchema>;

export const paymentSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  orderId: resourceIdSchema,
  amount: moneySchema,
  lifecycle: paymentLifecycleSchema,
});
export type Payment = Static<typeof paymentSchema>;

export const fulfillmentLineItemSchema = OpenObject({
  lineItemId: resourceIdSchema,
  quantity: SafeInteger,
});
export type FulfillmentLineItem = Static<typeof fulfillmentLineItemSchema>;

export const internationalDutyIncotermSchema = Type.Union([
  Type.Literal("ddp"),
  Type.Literal("dap"),
]);
export type InternationalDutyIncoterm = Static<
  typeof internationalDutyIncotermSchema
>;

export const countryCodeSchema = Type.String();
export type CountryCode = Static<typeof countryCodeSchema>;

// The client reads the shipping and checkout records below with the rules of
// commerce-resources.ts (Plan 78 step 2); these local field schemas carry them.
export const recordTextSchema = normalizedTextSchema;
export const recordQuantitySchema = quantityRecordSchema(quantityUnitSchema);
export const recordMoneySchema = nonNegativeMoneySchema;

const shippingServiceCodesSchema = Type.Refine(
  Type.Array(recordTextSchema, { minItems: 1 }),
  hasUniqueValues,
  uniqueValuesError,
);

const destinationCountriesSchema = Type.Refine(
  Type.Array(countryCodeTextSchema, { minItems: 1 }),
  hasUniqueValues,
  uniqueValuesError,
);

export const shippingRouteBindingSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("domestic_japan"),
    routeId: recordTextSchema,
    zoneId: recordTextSchema,
    carrierRateCapabilityId: recordTextSchema,
    serviceCodes: shippingServiceCodesSchema,
  }),
  StrictObject({
    kind: Type.Literal("japan_to_singapore"),
    routeId: recordTextSchema,
    zoneId: recordTextSchema,
    carrierRateCapabilityId: recordTextSchema,
    serviceCodes: shippingServiceCodesSchema,
    dutyCapabilityId: recordTextSchema,
    incoterm: internationalDutyIncotermSchema,
  }),
  StrictObject({
    kind: Type.Literal("international"),
    routeId: recordTextSchema,
    zoneId: recordTextSchema,
    carrierRateCapabilityId: recordTextSchema,
    serviceCodes: shippingServiceCodesSchema,
    destinationCountries: destinationCountriesSchema,
    dutyCapabilityId: recordTextSchema,
    incoterm: internationalDutyIncotermSchema,
  }),
]);
export type ShippingRouteBinding = Static<typeof shippingRouteBindingSchema>;

export const carrierServiceSnapshotSchema = OpenObject({
  code: Type.String(),
  name: Type.String(),
});
export type CarrierServiceSnapshot = Static<
  typeof carrierServiceSnapshotSchema
>;

export const carrierServiceRecordSchema = OpenObject({
  code: recordTextSchema,
  name: recordTextSchema,
});

export const checkoutLineChargeAllocationSchema = OpenObject({
  checkoutLineId: recordTextSchema,
  amount: recordMoneySchema,
});
export type CheckoutLineChargeAllocation = Static<
  typeof checkoutLineChargeAllocationSchema
>;

const checkoutLineChargeAllocationsSchema = Type.Array(
  checkoutLineChargeAllocationSchema,
  { minItems: 1 },
);

export const carrierRateSnapshotSchema = Type.Refine(
  OpenObject({
    providerAccountReference: recordTextSchema,
    rateReference: recordTextSchema,
    service: carrierServiceRecordSchema,
    shippingAmount: recordMoneySchema,
    lineAllocations: checkoutLineChargeAllocationsSchema,
  }),
  carrierRateAllocationsMatch,
  chargeAllocationsError,
);
export type CarrierRateSnapshot = Static<typeof carrierRateSnapshotSchema>;

export const taxQuoteSnapshotSchema = Type.Refine(
  OpenObject({
    providerAccountReference: recordTextSchema,
    registrationPolicyReference: recordTextSchema,
    quoteReference: recordTextSchema,
    taxAmount: recordMoneySchema,
    lineAllocations: checkoutLineChargeAllocationsSchema,
  }),
  taxQuoteAllocationsMatch,
  chargeAllocationsError,
);
export type TaxQuoteSnapshot = Static<typeof taxQuoteSnapshotSchema>;

export const dutyIncotermSchema = Type.Union([
  Type.Literal("not_applicable"),
  Type.Literal("ddp"),
  Type.Literal("dap"),
]);
export type DutyIncoterm = Static<typeof dutyIncotermSchema>;

export const dutyQuoteSnapshotSchema = Type.Refine(
  OpenObject({
    providerAccountReference: recordTextSchema,
    quoteReference: recordTextSchema,
    incoterm: dutyIncotermSchema,
    dutyAmount: recordMoneySchema,
    lineAllocations: checkoutLineChargeAllocationsSchema,
  }),
  dutyQuoteAllocationsMatch,
  chargeAllocationsError,
);
export type DutyQuoteSnapshot = Static<typeof dutyQuoteSnapshotSchema>;

export const estimatedDeliverySnapshotSchema = Type.Union([
  OpenObject({ kind: Type.Literal("unavailable") }),
  OpenObject({
    kind: Type.Literal("window"),
    earliest: utcTimestampSchema,
    latest: utcTimestampSchema,
  }),
]);
export type EstimatedDeliverySnapshot = Static<
  typeof estimatedDeliverySnapshotSchema
>;

export const protectedShippingAddressSchema = OpenObject({
  protectedAddressReference: recordTextSchema,
  destinationCountry: countryCodeTextSchema,
  addressValidationReference: recordTextSchema,
  addressDigest: sha256HexSchema,
});
export type ProtectedShippingAddress = Static<
  typeof protectedShippingAddressSchema
>;

export const shippingWeightSchema = OpenObject({ grams: PositiveInteger });
export type ShippingWeight = Static<typeof shippingWeightSchema>;

export const shippingDimensionsSchema = OpenObject({
  lengthMillimeters: PositiveInteger,
  widthMillimeters: PositiveInteger,
  heightMillimeters: PositiveInteger,
});
export type ShippingDimensions = Static<typeof shippingDimensionsSchema>;

export const shippingLineQuantitySchema = OpenObject({
  checkoutLineId: recordTextSchema,
  quantity: recordQuantitySchema,
});
export type ShippingLineQuantity = Static<typeof shippingLineQuantitySchema>;

export const customsLineSnapshotSchema = OpenObject({
  checkoutLineId: recordTextSchema,
  description: recordTextSchema,
  quantity: recordQuantitySchema,
  weight: shippingWeightSchema,
  declaredValue: recordMoneySchema,
  countryOfOrigin: countryCodeTextSchema,
  hsCode: hsCodeSchema,
});
export type CustomsLineSnapshot = Static<typeof customsLineSnapshotSchema>;

export const plannedPackageSchema = OpenObject({
  packageId: recordTextSchema,
  weight: shippingWeightSchema,
  dimensions: shippingDimensionsSchema,
  lineQuantities: Type.Array(shippingLineQuantitySchema),
  customsLines: Type.Array(customsLineSnapshotSchema),
});
export type PlannedPackage = Static<typeof plannedPackageSchema>;

export const packagePlanSnapshotSchema = OpenObject({
  packagePlanDigest: sha256HexSchema,
  package: plannedPackageSchema,
});
export type PackagePlanSnapshot = Static<typeof packagePlanSnapshotSchema>;

export const shippingQuoteSnapshotSchema = Type.Refine(
  OpenObject({
    shippingQuoteId: recordTextSchema,
    routeBinding: shippingRouteBindingSchema,
    carrierRate: carrierRateSnapshotSchema,
    taxQuote: taxQuoteSnapshotSchema,
    dutyQuote: dutyQuoteSnapshotSchema,
    itemSubtotal: recordMoneySchema,
    total: recordMoneySchema,
    estimatedDelivery: estimatedDeliverySnapshotSchema,
    address: protectedShippingAddressSchema,
    packagePlan: packagePlanSnapshotSchema,
    inputDigest: sha256HexSchema,
    quotedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
  }),
  shippingQuoteCoversPackageLines,
  shippingQuoteCoverageError,
);
export type ShippingQuoteSnapshot = Static<typeof shippingQuoteSnapshotSchema>;

type ChargeAllocation = Readonly<{
  checkoutLineId: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
}>;

/**
 * Whether the line allocations of one quote component are unique lines in
 * its currency that sum, without leaving the safe range, to its amount.
 */
function chargeAllocationsMatch(
  total: Readonly<{ amountMinor: number; currency: string }>,
  allocations: readonly ChargeAllocation[],
): boolean {
  const lineIds = new Set<string>();
  let allocatedMinor = 0;
  for (const allocation of allocations) {
    if (
      lineIds.has(allocation.checkoutLineId) ||
      allocation.amount.currency !== total.currency
    )
      return false;
    lineIds.add(allocation.checkoutLineId);
    allocatedMinor += allocation.amount.amountMinor;
    if (!Number.isSafeInteger(allocatedMinor)) return false;
  }
  return allocatedMinor === total.amountMinor;
}

function carrierRateAllocationsMatch(
  rate: Readonly<{
    shippingAmount: ChargeAllocation["amount"];
    lineAllocations: readonly ChargeAllocation[];
  }>,
): boolean {
  return chargeAllocationsMatch(rate.shippingAmount, rate.lineAllocations);
}

function taxQuoteAllocationsMatch(
  quote: Readonly<{
    taxAmount: ChargeAllocation["amount"];
    lineAllocations: readonly ChargeAllocation[];
  }>,
): boolean {
  return chargeAllocationsMatch(quote.taxAmount, quote.lineAllocations);
}

function dutyQuoteAllocationsMatch(
  quote: Readonly<{
    dutyAmount: ChargeAllocation["amount"];
    lineAllocations: readonly ChargeAllocation[];
  }>,
): boolean {
  return chargeAllocationsMatch(quote.dutyAmount, quote.lineAllocations);
}

function chargeAllocationsError(): string {
  return "line allocations must be unique lines in the component currency that sum to its amount";
}

/** Whether each allocation group names every package line exactly once. */
function shippingQuoteCoversPackageLines(
  quote: Readonly<{
    carrierRate: Readonly<{ lineAllocations: readonly ChargeAllocation[] }>;
    taxQuote: Readonly<{ lineAllocations: readonly ChargeAllocation[] }>;
    dutyQuote: Readonly<{ lineAllocations: readonly ChargeAllocation[] }>;
    packagePlan: Readonly<{
      package: Readonly<{
        lineQuantities: readonly Readonly<{ checkoutLineId: string }>[];
      }>;
    }>;
  }>,
): boolean {
  const packageLineIds = new Set(
    quote.packagePlan.package.lineQuantities.map(readCheckoutLineId),
  );
  return [
    quote.carrierRate.lineAllocations,
    quote.taxQuote.lineAllocations,
    quote.dutyQuote.lineAllocations,
  ].every(coversLineIds.bind(undefined, packageLineIds));
}

function coversLineIds(
  lineIds: ReadonlySet<string>,
  allocations: readonly ChargeAllocation[],
): boolean {
  return (
    allocations.length === lineIds.size &&
    allocations.every(namesLineIn.bind(undefined, lineIds))
  );
}

function namesLineIn(
  lineIds: ReadonlySet<string>,
  allocation: ChargeAllocation,
): boolean {
  return lineIds.has(allocation.checkoutLineId);
}

function readCheckoutLineId(line: Readonly<{ checkoutLineId: string }>) {
  return line.checkoutLineId;
}

function shippingQuoteCoverageError(): string {
  return "shipping quote allocations must cover every package line exactly once";
}

export const shippingFulfillmentBindingSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("first_party_checkout"),
    protectedAddressReference: recordTextSchema,
    acceptedShippingQuote: shippingQuoteSnapshotSchema,
  }),
  OpenObject({
    kind: Type.Literal("external"),
    sourceReference: recordTextSchema,
  }),
]);
export type ShippingFulfillmentBinding = Static<
  typeof shippingFulfillmentBindingSchema
>;

export const shippingFulfillmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("preparing"),
    startedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("blocked"),
    blockedAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("handed_to_carrier"),
    handedOverAt: commerceTimestampSchema,
    shipmentId: resourceIdSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type ShippingFulfillmentLifecycle = Static<
  typeof shippingFulfillmentLifecycleSchema
>;

export const pickupFulfillmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("preparing"),
    startedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("blocked"),
    blockedAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("ready_for_pickup"),
    readyAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("completed"),
    completedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type PickupFulfillmentLifecycle = Static<
  typeof pickupFulfillmentLifecycleSchema
>;

export const localDeliveryFulfillmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("preparing"),
    startedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("blocked"),
    blockedAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("completed"),
    completedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type LocalDeliveryFulfillmentLifecycle = Static<
  typeof localDeliveryFulfillmentLifecycleSchema
>;

export const immediateHandoffFulfillmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("completed"),
    completedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type ImmediateHandoffFulfillmentLifecycle = Static<
  typeof immediateHandoffFulfillmentLifecycleSchema
>;

export const onPremiseFulfillmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("preparing"),
    startedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("blocked"),
    blockedAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
  OpenObject({
    state: Type.Literal("completed"),
    completedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
    reason: Type.String(),
  }),
]);
export type OnPremiseFulfillmentLifecycle = Static<
  typeof onPremiseFulfillmentLifecycleSchema
>;

export const fulfillmentSchema = Type.Intersect([
  OpenObject({
    provenance: sourceProvenanceSchema,
    orderId: resourceIdSchema,
    lineItems: Type.Array(fulfillmentLineItemSchema),
    locationId: resourceIdSchema,
    expectedBy: commerceTimestampSchema,
  }),
  Type.Union([
    OpenObject({
      kind: Type.Literal("shipping"),
      binding: shippingFulfillmentBindingSchema,
      lifecycle: shippingFulfillmentLifecycleSchema,
    }),
    OpenObject({
      kind: Type.Literal("pickup"),
      lifecycle: pickupFulfillmentLifecycleSchema,
    }),
    OpenObject({
      kind: Type.Literal("local_delivery"),
      lifecycle: localDeliveryFulfillmentLifecycleSchema,
    }),
    OpenObject({
      kind: Type.Literal("immediate_handoff"),
      lifecycle: immediateHandoffFulfillmentLifecycleSchema,
    }),
    OpenObject({
      kind: Type.Literal("on_premise"),
      lifecycle: onPremiseFulfillmentLifecycleSchema,
    }),
  ]),
]);
export type Fulfillment = Static<typeof fulfillmentSchema>;

export const orderLineQuantitySchema = OpenObject({
  orderLineId: recordTextSchema,
  quantity: recordQuantitySchema,
});
export type OrderLineQuantity = Static<typeof orderLineQuantitySchema>;

export const shipmentCustomsLineSnapshotSchema = OpenObject({
  orderLineId: recordTextSchema,
  description: recordTextSchema,
  quantity: recordQuantitySchema,
  weight: shippingWeightSchema,
  declaredValue: recordMoneySchema,
  countryOfOrigin: countryCodeTextSchema,
  hsCode: hsCodeSchema,
});
export type ShipmentCustomsLineSnapshot = Static<
  typeof shipmentCustomsLineSnapshotSchema
>;

export const shipmentPackageSchema = OpenObject({
  packageId: recordTextSchema,
  weight: shippingWeightSchema,
  dimensions: shippingDimensionsSchema,
  lineQuantities: Type.Array(orderLineQuantitySchema),
  customsLines: Type.Array(shipmentCustomsLineSnapshotSchema),
});
export type ShipmentPackage = Static<typeof shipmentPackageSchema>;

export const firstPartyShipmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("ready"),
    readyAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("label_purchased"),
    labelAttemptId: recordTextSchema,
    trackingNumber: recordTextSchema,
    purchasedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("in_transit"),
    labelAttemptId: recordTextSchema,
    trackingNumber: recordTextSchema,
    handedOverAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("delivered"),
    labelAttemptId: recordTextSchema,
    trackingNumber: recordTextSchema,
    handedOverAt: utcTimestampSchema,
    deliveredAt: utcTimestampSchema,
  }),
]);
export type FirstPartyShipmentLifecycle = Static<
  typeof firstPartyShipmentLifecycleSchema
>;

export const trackingEventKindSchema = Type.Union([
  OpenObject({ kind: Type.Literal("label_created") }),
  OpenObject({ kind: Type.Literal("in_transit") }),
  OpenObject({
    kind: Type.Literal("delivery_exception"),
    reason: Type.String(),
  }),
  OpenObject({ kind: Type.Literal("delivered") }),
  OpenObject({ kind: Type.Literal("returned") }),
]);
export type TrackingEventKind = Static<typeof trackingEventKindSchema>;

export const trackingEventSchema = OpenObject({
  eventId: resourceIdSchema,
  occurredAt: commerceTimestampSchema,
  kind: trackingEventKindSchema,
  location: Type.String(),
});
export type TrackingEvent = Static<typeof trackingEventSchema>;

export const externalShipmentLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("label_created"),
    createdAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("in_transit"),
    since: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("delivery_exception"),
    occurredAt: utcTimestampSchema,
    reason: recordTextSchema,
  }),
  OpenObject({
    state: Type.Literal("delivered"),
    deliveredAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("returned"),
    returnedAt: utcTimestampSchema,
    reason: recordTextSchema,
  }),
]);
export type ExternalShipmentLifecycle = Static<
  typeof externalShipmentLifecycleSchema
>;

export const shipmentSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("first_party"),
    provenance: sourceProvenanceSchema,
    orderId: resourceIdSchema,
    fulfillmentId: resourceIdSchema,
    package: shipmentPackageSchema,
    lifecycle: firstPartyShipmentLifecycleSchema,
    events: Type.Array(trackingEventSchema),
  }),
  OpenObject({
    kind: Type.Literal("external"),
    provenance: sourceProvenanceSchema,
    orderId: resourceIdSchema,
    fulfillmentId: resourceIdSchema,
    carrier: Type.String(),
    trackingNumber: Type.String(),
    estimatedDeliveryAt: commerceTimestampSchema,
    lifecycle: externalShipmentLifecycleSchema,
    events: Type.Array(trackingEventSchema),
  }),
]);
export type Shipment = Static<typeof shipmentSchema>;

export const menuScopeSchema = Type.Union([
  OpenObject({ kind: Type.Literal("location"), locationId: resourceIdSchema }),
  OpenObject({
    kind: Type.Literal("location_group"),
    locationIds: Type.Array(resourceIdSchema),
  }),
]);
export type MenuScope = Static<typeof menuScopeSchema>;

export const menuValiditySchema = Type.Union([
  OpenObject({ kind: Type.Literal("always") }),
  OpenObject({
    kind: Type.Literal("window"),
    startsAt: commerceTimestampSchema,
    endsAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("schedule"),
    timeZone: Type.String(),
    slots: Type.Array(
      OpenObject({
        days: Type.Array(
          Type.Union([
            Type.Literal("mon"), Type.Literal("tue"), Type.Literal("wed"), Type.Literal("thu"), Type.Literal("fri"), Type.Literal("sat"), Type.Literal("sun"),
          ]),
        ),
        startsAt: Type.String(),
        endsAt: Type.String(),
      }),
    ),
  }),
]);
export type MenuValidity = Static<typeof menuValiditySchema>;

export const menuSectionSchema = OpenObject({
  sectionId: menuSectionIdSchema,
  menuId: menuIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  position: SafeInteger,
});
export type MenuSection = Static<typeof menuSectionSchema>;

export const modifierGroupRevisionReferenceSchema = OpenObject({
  modifierGroupId: modifierGroupIdSchema,
  revision: SafeInteger,
});
export type ModifierGroupRevisionReference = Static<
  typeof modifierGroupRevisionReferenceSchema
>;

export const menuEntryLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type MenuEntryLifecycle = Static<typeof menuEntryLifecycleSchema>;

export const menuEntrySchema = OpenObject({
  menuEntryId: menuEntryIdSchema,
  sectionId: menuSectionIdSchema,
  revision: SafeInteger,
  offerId: resourceIdSchema,
  offerRevision: SafeInteger,
  consumptionPlanId: resourceIdSchema,
  consumptionPlanRevision: SafeInteger,
  modifierGroupRevisions: Type.Array(modifierGroupRevisionReferenceSchema),
  lifecycle: menuEntryLifecycleSchema,
});
export type MenuEntry = Static<typeof menuEntrySchema>;

export const menuLifecycleSchema = Type.Union([
  OpenObject({ state: Type.Literal("draft") }),
  OpenObject({
    state: Type.Literal("published"),
    publishedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("archived"),
    archivedAt: commerceTimestampSchema,
  }),
]);
export type MenuLifecycle = Static<typeof menuLifecycleSchema>;

export const menuSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  menuId: menuIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  salesChannelId: resourceIdSchema,
  scope: menuScopeSchema,
  validity: menuValiditySchema,
  sections: Type.Array(menuSectionSchema),
  entries: Type.Array(menuEntrySchema),
  lifecycle: menuLifecycleSchema,
});
export type Menu = Static<typeof menuSchema>;

export const modifierOptionSchema = OpenObject({
  modifierOptionId: modifierOptionIdSchema,
  name: Type.String(),
  priceDelta: moneySchema,
  requirementAdjustments: Type.Array(inventoryRequirementAdjustmentSchema),
});
export type ModifierOption = Static<typeof modifierOptionSchema>;

export const modifierGroupRevisionLifecycleSchema = Type.Union([
  OpenObject({ state: Type.Literal("draft") }),
  OpenObject({
    state: Type.Literal("active"),
    activeAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("retired"),
    retiredAt: commerceTimestampSchema,
  }),
]);
export type ModifierGroupRevisionLifecycle = Static<
  typeof modifierGroupRevisionLifecycleSchema
>;

export const modifierGroupRevisionSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  modifierGroupId: modifierGroupIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  minimumSelections: SafeInteger,
  maximumSelections: SafeInteger,
  options: Type.Array(modifierOptionSchema),
  lifecycle: modifierGroupRevisionLifecycleSchema,
});
export type ModifierGroupRevision = Static<typeof modifierGroupRevisionSchema>;

export const recipeOutputSchema = Type.Union([
  OpenObject({ kind: Type.Literal("immediate") }),
  OpenObject({
    kind: Type.Literal("stocked"),
    inventoryItemId: resourceIdSchema,
    yieldQuantity: quantitySchema,
  }),
]);
export type RecipeOutput = Static<typeof recipeOutputSchema>;

export const recipeRevisionLifecycleSchema = Type.Union([
  OpenObject({ state: Type.Literal("draft") }),
  OpenObject({
    state: Type.Literal("active"),
    activeAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("retired"),
    retiredAt: commerceTimestampSchema,
  }),
]);
export type RecipeRevisionLifecycle = Static<
  typeof recipeRevisionLifecycleSchema
>;

export const recipeRevisionSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  recipeId: recipeIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  inputs: Type.Array(inventoryRequirementSchema),
  output: recipeOutputSchema,
  lifecycle: recipeRevisionLifecycleSchema,
});
export type RecipeRevision = Static<typeof recipeRevisionSchema>;

export const preparationStationLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type PreparationStationLifecycle = Static<
  typeof preparationStationLifecycleSchema
>;

export const preparationStationSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  stationId: preparationStationIdSchema,
  locationId: resourceIdSchema,
  revision: SafeInteger,
  name: Type.String(),
  lifecycle: preparationStationLifecycleSchema,
});
export type PreparationStation = Static<typeof preparationStationSchema>;

export const preparationTicketLineSnapshotSchema = OpenObject({
  orderLineId: resourceIdSchema,
  menuEntryId: menuEntryIdSchema,
  menuEntryRevision: SafeInteger,
  recipeId: recipeIdSchema,
  recipeRevision: SafeInteger,
  modifiers: Type.Array(modifierSelectionSnapshotSchema),
  requirements: Type.Array(inventoryRequirementSchema),
});
export type PreparationTicketLineSnapshot = Static<
  typeof preparationTicketLineSnapshotSchema
>;

export const preparationTicketSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  ticketId: preparationTicketIdSchema,
  orderId: resourceIdSchema,
  fulfillmentId: resourceIdSchema,
  locationId: resourceIdSchema,
  stationId: preparationStationIdSchema,
  revision: SafeInteger,
  lineSnapshots: Type.Array(preparationTicketLineSnapshotSchema),
  lifecycle: preparationTicketLifecycleSchema,
});
export type PreparationTicket = Static<typeof preparationTicketSchema>;

export const productionBatchDemandSchema = Type.Union([
  OpenObject({ kind: Type.Literal("stock") }),
  OpenObject({
    kind: Type.Literal("request"),
    requestId: Type.String(),
    requestRevision: SafeInteger,
  }),
  OpenObject({
    kind: Type.Literal("shipment"),
    shipmentId: shipmentEntityIdSchema,
  }),
]);
export type ProductionBatchDemand = Static<typeof productionBatchDemandSchema>;

export const productionBatchSchema = OpenObject({
  provenance: sourceProvenanceSchema,
  productionBatchId: productionBatchIdSchema,
  demand: productionBatchDemandSchema,
  recipeId: recipeIdSchema,
  recipeRevision: SafeInteger,
  locationId: resourceIdSchema,
  stationId: preparationStationIdSchema,
  revision: SafeInteger,
  plannedYield: quantitySchema,
  actualYield: quantitySchema,
  completedAt: commerceTimestampSchema,
  inputMovementIds: Type.Array(resourceIdSchema),
  outputMovementId: resourceIdSchema,
  outputLotId: resourceIdSchema,
});
export type ProductionBatch = Static<typeof productionBatchSchema>;

export const inventoryReplenishmentPolicySchema = Type.Union([
  OpenObject({ kind: Type.Literal("none") }),
  OpenObject({
    kind: Type.Literal("threshold"),
    reorderPoint: quantitySchema,
    targetQuantity: quantitySchema,
  }),
]);
export type InventoryReplenishmentPolicy = Static<
  typeof inventoryReplenishmentPolicySchema
>;

export const stockPolicyLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type StockPolicyLifecycle = Static<typeof stockPolicyLifecycleSchema>;

export const stockPolicySchema = OpenObject({
  provenance: sourceProvenanceSchema,
  stockPolicyId: resourceIdSchema,
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  revision: SafeInteger,
  replenishment: inventoryReplenishmentPolicySchema,
  lifecycle: stockPolicyLifecycleSchema,
});
export type StockPolicy = Static<typeof stockPolicySchema>;

export const commerceProjectionSchema = Type.Union([
  OpenObject({ kind: Type.Literal("product"), projection: productSchema }),
  OpenObject({
    kind: Type.Literal("sellable_variant"),
    projection: sellableVariantSchema,
  }),
  OpenObject({
    kind: Type.Literal("inventory_item"),
    projection: inventoryItemSchema,
  }),
  OpenObject({ kind: Type.Literal("location"), projection: locationSchema }),
  OpenObject({
    kind: Type.Literal("sales_channel"),
    projection: salesChannelSchema,
  }),
  OpenObject({ kind: Type.Literal("offer"), projection: offerSchema }),
  OpenObject({
    kind: Type.Literal("inventory_position"),
    projection: inventoryPositionSchema,
  }),
  OpenObject({
    kind: Type.Literal("inventory_movement"),
    projection: inventoryMovementProjectionSchema,
  }),
  OpenObject({
    kind: Type.Literal("inventory_lot"),
    projection: inventoryLotProjectionSchema,
  }),
  OpenObject({
    kind: Type.Literal("commerce_order"),
    projection: commerceOrderSchema,
  }),
  OpenObject({ kind: Type.Literal("payment"), projection: paymentSchema }),
  OpenObject({
    kind: Type.Literal("fulfillment"),
    projection: fulfillmentSchema,
  }),
  OpenObject({ kind: Type.Literal("shipment"), projection: shipmentSchema }),
  OpenObject({ kind: Type.Literal("menu"), projection: menuSchema }),
  OpenObject({
    kind: Type.Literal("modifier_group_revision"),
    projection: modifierGroupRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("recipe_revision"),
    projection: recipeRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("preparation_station"),
    projection: preparationStationSchema,
  }),
  OpenObject({
    kind: Type.Literal("preparation_ticket"),
    projection: preparationTicketSchema,
  }),
  OpenObject({
    kind: Type.Literal("production_batch"),
    projection: productionBatchSchema,
  }),
  OpenObject({
    kind: Type.Literal("stock_policy"),
    projection: stockPolicySchema,
  }),
]);
export type CommerceProjection = Static<typeof commerceProjectionSchema>;

export const canonicalCommerceObservationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("upsert"),
    observationId: resourceIdSchema,
    projection: commerceProjectionSchema,
  }),
  OpenObject({
    kind: Type.Literal("delete"),
    observationId: resourceIdSchema,
    provenance: sourceProvenanceSchema,
  }),
]);
export type CanonicalCommerceObservation = Static<
  typeof canonicalCommerceObservationSchema
>;

export const canonicalCommerceDeliverySchema = OpenObject({
  schemaVersion: Type.Literal(1),
  providerDeliveryId: providerDeliveryIdSchema,
  observations: Type.Array(canonicalCommerceObservationSchema),
});
export type CanonicalCommerceDelivery = Static<
  typeof canonicalCommerceDeliverySchema
>;

/** A cart or checkout line quantity: a positive count of `each`. */
const eachLineQuantitySchema = Type.Refine(
  recordQuantitySchema,
  isPositiveEachQuantity,
  positiveEachQuantityError,
);

/** A published checkout profile and revision, and nothing else. */
export const checkoutProfileRecordReferenceSchema = StrictObject({
  checkoutProfileId: recordTextSchema,
  revision: PositiveInteger,
});

export const cartLineSourceSchema = Type.Union([
  OpenObject({ kind: Type.Literal("catalog"), variantId: recordTextSchema }),
  OpenObject({
    kind: Type.Literal("food_service"),
    variantId: recordTextSchema,
    menuId: recordTextSchema,
    menuEntryId: recordTextSchema,
    modifierOptionIds: Type.Array(recordTextSchema),
  }),
]);
export type CartLineSource = Static<typeof cartLineSourceSchema>;

export const cartLineSchema = OpenObject({
  cartLineId: recordTextSchema,
  source: cartLineSourceSchema,
  quantity: eachLineQuantitySchema,
});
export type CartLine = Static<typeof cartLineSchema>;

export const cartLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("active"),
    updatedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("submitted"),
    checkoutId: recordTextSchema,
    submittedAt: utcTimestampSchema,
  }),
]);
export type CartLifecycle = Static<typeof cartLifecycleSchema>;

export const cartSchema = OpenObject({
  cartId: recordTextSchema,
  storefrontId: recordTextSchema,
  checkoutProfile: checkoutProfileRecordReferenceSchema,
  buyerSessionDigest: sha256HexSchema,
  revision: PositiveInteger,
  lines: Type.Array(cartLineSchema),
  lifecycle: cartLifecycleSchema,
});
export type Cart = Static<typeof cartSchema>;

export const protectedBuyerContactSchema = Type.Union([
  StrictObject({ kind: Type.Literal("email"), emailDigest: sha256HexSchema }),
  StrictObject({
    kind: Type.Literal("email_and_phone"),
    emailDigest: sha256HexSchema,
    phoneDigest: sha256HexSchema,
  }),
]);
export type ProtectedBuyerContact = Static<typeof protectedBuyerContactSchema>;

/**
 * Who is buying at a terminal. An anonymous sale owns no customer identity,
 * so none can be read from it.
 */
export const pointOfSaleBuyerSchema = Type.Union([
  StrictObject({ kind: Type.Literal("anonymous") }),
  StrictObject({
    kind: Type.Literal("identified_customer"),
    customerId: recordTextSchema,
  }),
]);
export type PointOfSaleBuyer = Static<typeof pointOfSaleBuyerSchema>;

/**
 * Where a Checkout came from. Core Checkout and Order logic switches on this
 * once, at placement, rather than inferring a channel from absent fields.
 * The branches share no fields, so an online checkout cannot carry a terminal
 * assignment and a counter sale cannot carry a storefront.
 */
export const checkoutSourceSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("online"),
    storefrontId: recordTextSchema,
    cartId: recordTextSchema,
    buyerSessionDigest: sha256HexSchema,
    buyerContact: protectedBuyerContactSchema,
    checkoutProfile: checkoutProfileRecordReferenceSchema,
  }),
  StrictObject({
    kind: Type.Literal("point_of_sale"),
    satyrLocationId: recordTextSchema,
    posConfigurationRevision: PositiveInteger,
    operatorIdentity: recordTextSchema,
    terminalAssignmentRevision: Type.Union([PositiveInteger, Type.Null()]),
    buyer: pointOfSaleBuyerSchema,
  }),
]);
export type CheckoutSource = Static<typeof checkoutSourceSchema>;

/** An inventory item and a positive quantity of it, and nothing else. */
export const checkoutInventoryRequirementSchema = StrictObject({
  inventoryItemId: recordTextSchema,
  quantity: Type.Refine(
    recordQuantitySchema,
    hasPositiveAmount,
    positiveAmountError,
  ),
});

export const checkoutLineInventorySchema = Type.Union([
  StrictObject({ kind: Type.Literal("untracked") }),
  StrictObject({
    kind: Type.Literal("requirements"),
    items: Type.Array(checkoutInventoryRequirementSchema),
  }),
]);

export const checkoutPreparationSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("immediate_recipe"),
    recipeId: recordTextSchema,
    recipeRevision: PositiveInteger,
  }),
  StrictObject({ kind: Type.Literal("stocked_inventory") }),
]);

export const checkoutOptionValueSchema = StrictObject({
  name: recordTextSchema,
  value: recordTextSchema,
});

const checkoutRequirementAdjustmentSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("add"),
    inventoryItemId: recordTextSchema,
    quantity: recordQuantitySchema,
  }),
  StrictObject({
    kind: Type.Literal("reduce"),
    inventoryItemId: recordTextSchema,
    quantity: recordQuantitySchema,
  }),
]);

export const checkoutModifierSelectionSchema = StrictObject({
  modifierGroupId: recordTextSchema,
  modifierGroupRevision: PositiveInteger,
  modifierOptionId: recordTextSchema,
  name: recordTextSchema,
  priceDelta: recordMoneySchema,
  requirementAdjustments: Type.Array(checkoutRequirementAdjustmentSchema),
});

export const checkoutLineSourceSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("catalog"),
    variantId: recordTextSchema,
    variantRevision: PositiveInteger,
    merchantCode: recordTextSchema,
    optionValues: Type.Array(checkoutOptionValueSchema),
    offerId: recordTextSchema,
    offerRevision: PositiveInteger,
    consumptionPlanId: recordTextSchema,
    consumptionPlanRevision: PositiveInteger,
    inventory: checkoutLineInventorySchema,
  }),
  StrictObject({
    kind: Type.Literal("food_service"),
    variantId: recordTextSchema,
    variantRevision: PositiveInteger,
    merchantCode: recordTextSchema,
    optionValues: Type.Array(checkoutOptionValueSchema),
    menuId: recordTextSchema,
    menuRevision: PositiveInteger,
    menuEntryId: recordTextSchema,
    menuEntryRevision: PositiveInteger,
    offerId: recordTextSchema,
    offerRevision: PositiveInteger,
    consumptionPlanId: recordTextSchema,
    consumptionPlanRevision: PositiveInteger,
    preparation: checkoutPreparationSchema,
    modifiers: Type.Array(checkoutModifierSelectionSchema),
    inventory: checkoutLineInventorySchema,
  }),
  StrictObject({
    kind: Type.Literal("order_balance"),
    orderId: recordTextSchema,
    orderRevision: PositiveInteger,
  }),
]);
export type CheckoutLineSource = Static<typeof checkoutLineSourceSchema>;

export const checkoutPriceOverrideSchema = StrictObject({
  offerPrice: recordMoneySchema,
  reason: recordTextSchema,
});
export type CheckoutPriceOverride = Static<typeof checkoutPriceOverrideSchema>;

export const checkoutLineSnapshotSchema = Type.Refine(
  StrictObject({
    checkoutLineId: recordTextSchema,
    source: checkoutLineSourceSchema,
    quantity: eachLineQuantitySchema,
    unitPrice: recordMoneySchema,
    lineTotal: recordMoneySchema,
    allocationIds: Type.Array(recordTextSchema) /**
     * The catalog title at quote time. Order placement copies it, so a later
     * catalog edit cannot change the order. Quotes made before the title was
     * frozen have none and must be refreshed before payment.
     */,
    title: Type.Optional(recordTextSchema) /**
     * A staff price that replaces the offer price, for example on a draft
     * order. The unit price is the staff price; this keeps what the catalog
     * asked and why it changed.
     */,
    priceOverride: Type.Optional(checkoutPriceOverrideSchema) /**
     * The discounts on this line. The line total is the unit price times
     * the quantity, less this amount.
     */,
    discount: Type.Optional(recordMoneySchema),
  }),
  checkoutLineIsConsistent,
  checkoutLineError,
);
export type CheckoutLineSnapshot = Static<typeof checkoutLineSnapshotSchema>;

export const checkoutTotalsSchema = StrictObject({
  /**
   * The sum of the line totals, after line discounts.
   */
  subtotal: recordMoneySchema,
  tax: recordMoneySchema,
  duty: recordMoneySchema,
  shipping: recordMoneySchema,
  total: recordMoneySchema /**
   * The sum of the line discounts already taken from the subtotal.
   */,
  discount: Type.Optional(recordMoneySchema),
  /** The listed prices include the tax, so the total does not add it. */
  taxIncluded: Type.Optional(Type.Literal(true)),
});
export type CheckoutTotals = Static<typeof checkoutTotalsSchema>;

export const pickupPromiseSnapshotSchema = StrictObject({
  locationId: recordTextSchema,
  readyAt: utcTimestampSchema,
});
export type PickupPromiseSnapshot = Static<typeof pickupPromiseSnapshotSchema>;

export const checkoutFulfillmentQuoteSnapshotSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("pickup"),
    promise: pickupPromiseSnapshotSchema,
  }),
  StrictObject({
    kind: Type.Literal("shipping"),
    quote: shippingQuoteSnapshotSchema,
  }),
]);
export type CheckoutFulfillmentQuoteSnapshot = Static<
  typeof checkoutFulfillmentQuoteSnapshotSchema
>;

export const checkoutMarketSnapshotSchema = StrictObject({
  marketId: recordTextSchema,
  marketRevision: PositiveInteger,
  shopCurrency: marketCurrencySchema /**
   * Market currency for one unit of shop currency; none for a price list.
   */,
  rate: Type.Union([marketRateSchema, Type.Null()]) /**
   * The same lines at shop prices, before discounts and tax.
   */,
  shopSubtotal: StrictObject({
    amountMinor: NonNegativeInteger,
    currency: marketCurrencySchema,
  }),
  /** The rounding of a converted rate; quotes from before it have none. */
  roundingIncrement: Type.Optional(PositiveInteger),
});
export type CheckoutMarketSnapshot = Static<
  typeof checkoutMarketSnapshotSchema
>;

export const storedValueKindSchema = Type.Union([
  Type.Literal("gift_card"),
  Type.Literal("store_credit"),
]);
export type StoredValueKind = Static<typeof storedValueKindSchema>;

/**
 * One gift card or store credit account and what it pays of a quote. Only a
 * gift card has, and must have, its last characters.
 */
export const checkoutStoredValueTenderSchema = Type.Refine(
  StrictObject({
    accountId: recordTextSchema,
    kind: storedValueKindSchema /**
     * The last characters of a gift card code; never the code.
     */,
    lastCharacters: Type.Optional(recordTextSchema),
    amount: OpenObject({
      amountMinor: PositiveInteger,
      currency: currencyCodeTextSchema,
    }),
  }),
  onlyGiftCardHasLastCharacters,
  lastCharactersError,
);
export type CheckoutStoredValueTender = Static<
  typeof checkoutStoredValueTenderSchema
>;

/**
 * What gift cards and store credit pay of a quote, and what is left due. The
 * quote checks it against its total.
 */
export const checkoutStoredValueSchema = StrictObject({
  tenders: Type.Array(checkoutStoredValueTenderSchema, {
    minItems: 1,
  }) /**
   * The sum of the tenders.
   */,
  amount: recordMoneySchema /**
   * The total less the tenders; zero when they pay everything.
   */,
  due: recordMoneySchema,
});
export type CheckoutStoredValue = Static<typeof checkoutStoredValueSchema>;

/**
 * How one merchant plugin function ended for a quote. A function that
 * refuses the checkout leaves no quote, so only these two remain.
 */
export const checkoutPluginRunOutcomeSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("skipped"),
]);
export type CheckoutPluginRunOutcome = Static<
  typeof checkoutPluginRunOutcomeSchema
>;

/**
 * One run of a merchant plugin function on a quote.
 */
export const checkoutPluginRunSchema = StrictObject({
  pluginId: recordTextSchema,
  version: PositiveInteger,
  functionId: recordTextSchema /**
   * SHA-256 of the function source.
   */,
  codeDigest: sha256HexSchema /**
   * SHA-256 of the canonical input.
   */,
  inputDigest: sha256HexSchema,
  outcome: checkoutPluginRunOutcomeSchema,
});
export type CheckoutPluginRun = Static<typeof checkoutPluginRunSchema>;

export const checkoutQuoteSnapshotSchema = Type.Refine(
  StrictObject({
    quoteDigest: recordTextSchema,
    checkoutRevision: PositiveInteger,
    lines: Type.Array(checkoutLineSnapshotSchema, { minItems: 1 }),
    totals: checkoutTotalsSchema,
    fulfillment: checkoutFulfillmentQuoteSnapshotSchema,
    quotedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema /**
     * The market a quote in another currency was priced for, with the rate
     * it used; it keeps that rate until it expires.
     */,
    market: Type.Optional(checkoutMarketSnapshotSchema) /**
     * Gift cards and store credit that pay part or all of the total; the
     * buyer pays the rest with a payment provider.
     */,
    storedValue: Type.Optional(checkoutStoredValueSchema) /**
     * The merchant plugin functions that checked the quote (Plan 77 step
     * 4). The quote digest covers them, so a replay gets the same result.
     */,
    pluginRuns: Type.Optional(Type.Array(checkoutPluginRunSchema)),
  }),
  checkoutQuoteIsConsistent,
  checkoutQuoteError,
);
export type CheckoutQuoteSnapshot = Static<typeof checkoutQuoteSnapshotSchema>;

export const checkoutLifecycleSchema = Type.Union([
  StrictObject({
    state: Type.Literal("quoted"),
    quote: checkoutQuoteSnapshotSchema,
  }),
  StrictObject({
    state: Type.Literal("payment_pending"),
    quote: checkoutQuoteSnapshotSchema,
    paymentAttemptId: recordTextSchema,
  }),
  Type.Refine(
    StrictObject({
      state: Type.Literal("accepted"),
      quote: checkoutQuoteSnapshotSchema /**
       * None when gift cards and store credit, or a manual tender, paid
       * the whole total.
       */,
      paymentAttemptId: Type.Optional(recordTextSchema) /**
       * The payment that staff took in cash or by bank transfer.
       */,
      manualPaymentId: Type.Optional(recordTextSchema),
      orderId: recordTextSchema,
      acceptedAt: utcTimestampSchema,
    }),
    acceptedCheckoutIsPaid,
    acceptedCheckoutPaymentError,
  ),
  StrictObject({
    state: Type.Literal("expired"),
    quote: checkoutQuoteSnapshotSchema,
    expiredAt: utcTimestampSchema,
  }),
]);
export type CheckoutLifecycle = Static<typeof checkoutLifecycleSchema>;

/**
 * One Checkout, from either channel.
 *
 * `source` holds everything that differs by channel, including what priced
 * the sale: an online Checkout pins a published checkout profile, a counter
 * sale pins its own published point-of-sale configuration. Neither is a field
 * the other has to carry as empty, and a counter therefore needs no storefront
 * profile to exist.
 */
export const checkoutSchema = StrictObject({
  checkoutId: recordTextSchema,
  source: checkoutSourceSchema,
  revision: PositiveInteger,
  lifecycle: checkoutLifecycleSchema,
});
export type Checkout = Static<typeof checkoutSchema>;

export const paymentEnvironmentSchema = Type.Union([
  Type.Literal("development"),
  Type.Literal("production"),
]);
export type PaymentEnvironment = Static<typeof paymentEnvironmentSchema>;

export const paymentProviderAccountBindingSchema = OpenObject({
  integrationAccountId: integrationAccountIdSchema,
  providerAccountId: Type.String(),
  environment: paymentEnvironmentSchema,
  capabilityRevision: SafeInteger,
  country: countryCodeSchema,
  currency: currencyCodeSchema,
});
export type PaymentProviderAccountBinding = Static<
  typeof paymentProviderAccountBindingSchema
>;

/** The provider account of a checkout payment (`parsePaymentProviderAccountBinding`). */
const paymentAccountRecordSchema = StrictObject({
  integrationAccountId: identityTextSchema,
  providerAccountId: identityTextSchema,
  environment: paymentEnvironmentSchema,
  capabilityRevision: PositiveInteger,
  country: countryCodeTextSchema,
  currency: currencyCodeTextSchema,
});

export const stripeOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);
export type StripeOnlineCollection = Static<
  typeof stripeOnlineCollectionSchema
>;

export const gmoPgOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);
export type GmoPgOnlineCollection = Static<typeof gmoPgOnlineCollectionSchema>;

export const onlinePaymentBindingSchema = Type.Union([
  StrictObject({
    provider: Type.Literal("stripe_online"),
    account: paymentAccountRecordSchema,
    collection: stripeOnlineCollectionSchema,
  }),
  StrictObject({
    provider: Type.Literal("gmo_pg_online"),
    account: paymentAccountRecordSchema,
    collection: gmoPgOnlineCollectionSchema,
  }),
  StrictObject({
    provider: Type.Literal("square_online"),
    account: paymentAccountRecordSchema,
    applicationId: identityTextSchema,
    locationId: identityTextSchema,
  }),
]);
export type OnlinePaymentBinding = Static<typeof onlinePaymentBindingSchema>;

/**
 * Square Terminal connected mode. Plan 33C ships server-controlled
 * collection only; a POS-app handoff is a different ceremony and would need
 * its own measured slice.
 */
export const squareTerminalTransportSchema = Type.Literal("server_terminal");
export type SquareTerminalTransport = Static<
  typeof squareTerminalTransportSchema
>;

export const inPersonPaymentBindingSchema = StrictObject({
  provider: Type.Literal("square_terminal"),
  account: paymentAccountRecordSchema,
  locationId: identityTextSchema,
  deviceId: identityTextSchema,
  transport: squareTerminalTransportSchema,
});
export type InPersonPaymentBinding = Static<
  typeof inPersonPaymentBindingSchema
>;

export const checkoutPaymentProviderBindingSchema = Type.Union([
  onlinePaymentBindingSchema,
  inPersonPaymentBindingSchema,
]);
export type CheckoutPaymentProviderBinding = Static<
  typeof checkoutPaymentProviderBindingSchema
>;

export const checkoutPaymentBindingSchema = StrictObject({
  checkoutId: recordTextSchema,
  checkoutRevision: PositiveInteger,
  quoteDigest: recordTextSchema,
  amount: recordMoneySchema,
  paymentBinding: checkoutPaymentProviderBindingSchema,
  providerRequestId: recordTextSchema,
  idempotencyKey: recordTextSchema,
});
export type CheckoutPaymentBinding = Static<
  typeof checkoutPaymentBindingSchema
>;

export const inPersonPaymentMethodSchema = Type.Union([
  Type.Literal("card"),
  Type.Literal("felica"),
  Type.Literal("qr_code"),
]);
export type InPersonPaymentMethod = Static<typeof inPersonPaymentMethodSchema>;

export const checkoutPaymentAttemptLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("pending"),
    createdAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("processing"),
    reasonCode: recordTextSchema,
    reconcileAfter: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("captured"),
    providerPaymentReference: recordTextSchema,
    capturedAt: utcTimestampSchema,
    paymentMethod: Type.Optional(inPersonPaymentMethodSchema),
    tenderBrand: Type.Optional(recordTextSchema),
    providerRefundable: Type.Optional(Type.Boolean()),
  }),
  OpenObject({
    state: Type.Literal("declined"),
    reasonCode: recordTextSchema,
    declinedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("indeterminate"),
    reasonCode: recordTextSchema,
    reconcileAfter: utcTimestampSchema,
  }),
]);
export type CheckoutPaymentAttemptLifecycle = Static<
  typeof checkoutPaymentAttemptLifecycleSchema
>;

export const checkoutPaymentAttemptSchema = StrictObject({
  paymentAttemptId: recordTextSchema,
  revision: PositiveInteger,
  binding: checkoutPaymentBindingSchema,
  lifecycle: checkoutPaymentAttemptLifecycleSchema,
});
export type CheckoutPaymentAttempt = Static<
  typeof checkoutPaymentAttemptSchema
>;

type RecordMoney = Readonly<{ amountMinor: number; currency: string }>;

function isPositiveEachQuantity(
  quantity: Readonly<{ amount: number; scale: number; unit: string }>,
): boolean {
  return (
    quantity.amount > 0 && quantity.scale === 0 && quantity.unit === "each"
  );
}

function positiveEachQuantityError(): string {
  return "must be a positive each quantity";
}

function hasPositiveAmount(quantity: Readonly<{ amount: number }>): boolean {
  return quantity.amount > 0;
}

function positiveAmountError(): string {
  return "amount must be positive";
}

/**
 * The line total is the unit price times the quantity, less the discount, in
 * one currency; the override uses that currency too. Allocations hold only
 * the inventory a line reserves (`validateCheckoutLineAllocations`).
 */
function checkoutLineIsConsistent(
  line: Readonly<{
    source: CheckoutLineSource;
    quantity: Readonly<{ amount: number }>;
    unitPrice: RecordMoney;
    lineTotal: RecordMoney;
    allocationIds: readonly string[];
    priceOverride?: Readonly<{ offerPrice: RecordMoney }>;
    discount?: RecordMoney;
  }>,
): boolean {
  const { unitPrice, lineTotal, discount, priceOverride } = line;
  if (unitPrice.currency !== lineTotal.currency) return false;
  if (discount !== undefined && discount.currency !== lineTotal.currency)
    return false;
  const expectedTotal =
    BigInt(unitPrice.amountMinor) * BigInt(line.quantity.amount) -
    BigInt(discount?.amountMinor ?? 0);
  if (expectedTotal !== BigInt(lineTotal.amountMinor)) return false;
  if (
    priceOverride !== undefined &&
    priceOverride.offerPrice.currency !== unitPrice.currency
  )
    return false;
  const allocationIds = line.allocationIds;
  if (line.source.kind === "order_balance") return allocationIds.length === 0;
  switch (line.source.inventory.kind) {
    case "untracked":
      return allocationIds.length === 0;
    case "requirements":
      return allocationIds.length > 0 && hasUniqueValues(allocationIds);
  }
}

function checkoutLineError(): string {
  return "line amounts, currencies or allocations are inconsistent";
}

/**
 * The totals share the subtotal currency with every line, the subtotal is the
 * sum of the line totals and the total is the sum of its components
 * (`validateQuoteTotals`). Stored value pays at most the total, in its
 * currency (`parseCheckoutStoredValue`).
 */
function checkoutQuoteIsConsistent(
  quote: Readonly<{
    lines: readonly Readonly<{ lineTotal: RecordMoney }>[];
    totals: CheckoutTotals;
    storedValue?: CheckoutStoredValue;
  }>,
): boolean {
  const { totals } = quote;
  const currency = totals.subtotal.currency;
  for (const money of [totals.tax, totals.duty, totals.shipping, totals.total])
    if (money.currency !== currency) return false;
  let subtotalMinor = 0n;
  for (const line of quote.lines) {
    if (line.lineTotal.currency !== currency) return false;
    subtotalMinor += BigInt(line.lineTotal.amountMinor);
  }
  if (subtotalMinor !== BigInt(totals.subtotal.amountMinor)) return false;
  const expectedTotal =
    BigInt(totals.subtotal.amountMinor) +
    (totals.taxIncluded === true ? 0n : BigInt(totals.tax.amountMinor)) +
    BigInt(totals.duty.amountMinor) +
    BigInt(totals.shipping.amountMinor);
  if (expectedTotal !== BigInt(totals.total.amountMinor)) return false;
  return (
    quote.storedValue === undefined ||
    storedValuePaysTotal(quote.storedValue, totals.total)
  );
}

function storedValuePaysTotal(
  storedValue: CheckoutStoredValue,
  total: RecordMoney,
): boolean {
  const { tenders, amount, due } = storedValue;
  let sum = 0;
  for (const tender of tenders) sum += tender.amount.amountMinor;
  return (
    hasUniqueValues(tenders.map(readAccountId)) &&
    tenders.every(paysIn.bind(undefined, total.currency)) &&
    amount.currency === total.currency &&
    due.currency === total.currency &&
    amount.amountMinor === sum &&
    due.amountMinor === total.amountMinor - sum &&
    due.amountMinor >= 0
  );
}

function readAccountId(tender: CheckoutStoredValueTender): string {
  return tender.accountId;
}

function paysIn(currency: string, tender: CheckoutStoredValueTender): boolean {
  return tender.amount.currency === currency;
}

function checkoutQuoteError(): string {
  return "quote totals or stored value do not match the lines";
}

function onlyGiftCardHasLastCharacters(
  tender: Readonly<{ kind: StoredValueKind; lastCharacters?: string }>,
): boolean {
  return (
    (tender.kind === "gift_card") === (tender.lastCharacters !== undefined)
  );
}

function lastCharactersError(): string {
  return "only a gift card has last characters";
}

/**
 * An accepted Checkout names its payment attempt, or a manual payment that
 * paid alone, or stored value that left nothing due.
 */
function acceptedCheckoutIsPaid(
  lifecycle: Readonly<{
    quote: Readonly<{ storedValue?: CheckoutStoredValue }>;
    paymentAttemptId?: string;
    manualPaymentId?: string;
  }>,
): boolean {
  const { quote, paymentAttemptId, manualPaymentId } = lifecycle;
  if (
    paymentAttemptId === undefined &&
    manualPaymentId === undefined &&
    quote.storedValue?.due.amountMinor !== 0
  )
    return false;
  return (
    manualPaymentId === undefined ||
    (paymentAttemptId === undefined && quote.storedValue === undefined)
  );
}

function acceptedCheckoutPaymentError(): string {
  return "an accepted checkout needs one way it was paid";
}

export const commerceValidationErrorSchema = Type.Union([
  OpenObject({ code: Type.Literal("invalid_currency") }),
  OpenObject({ code: Type.Literal("negative_money") }),
  OpenObject({ code: Type.Literal("invalid_identity"), field: Type.String() }),
  OpenObject({ code: Type.Literal("invalid_timestamp") }),
  OpenObject({ code: Type.Literal("invalid_revision") }),
  OpenObject({ code: Type.Literal("observed_before_occurred") }),
  OpenObject({ code: Type.Literal("empty_collection"), field: Type.String() }),
  OpenObject({
    code: Type.Literal("duplicate_observation"),
    observationId: Type.String(),
  }),
  OpenObject({ code: Type.Literal("invalid_quantity"), field: Type.String() }),
  OpenObject({ code: Type.Literal("currency_mismatch") }),
  OpenObject({ code: Type.Literal("resource_type_mismatch") }),
  OpenObject({
    code: Type.Literal("invalid_lifecycle"),
    reason: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("unsupported_version"),
    expected: Type.String(),
    received: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("unsupported_external_code"),
    field: Type.String(),
    value: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("invalid_boundary_payload"),
    reason: Type.String(),
  }),
  OpenObject({ code: Type.Literal("location_classification_required") }),
]);
export type CommerceValidationError = Static<
  typeof commerceValidationErrorSchema
>;

export const directConsumptionCommitPointSchema = Type.Union([
  Type.Literal("order_placed"),
  Type.Literal("fulfillment_started"),
  Type.Literal("fulfillment_completed"),
]);
export type DirectConsumptionCommitPoint = Static<
  typeof directConsumptionCommitPointSchema
>;

export const foodServiceValidationErrorSchema = Type.Union([
  OpenObject({ code: Type.Literal("invalid_identity"), field: Type.String() }),
  OpenObject({
    code: Type.Literal("invalid_revision"),
    expected: SafeInteger,
    received: SafeInteger,
  }),
  OpenObject({ code: Type.Literal("invalid_quantity"), field: Type.String() }),
  OpenObject({ code: Type.Literal("empty_collection"), field: Type.String() }),
  OpenObject({
    code: Type.Literal("duplicate_identity"),
    field: Type.String(),
    id: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("invalid_reference"),
    field: Type.String(),
    id: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("resource_type_mismatch"),
    expected: Type.String(),
    received: Type.String(),
  }),
  OpenObject({ code: Type.Literal("invalid_selection_bounds") }),
  OpenObject({ code: Type.Literal("invalid_validity") }),
  OpenObject({
    code: Type.Literal("invalid_lifecycle"),
    operation: Type.String(),
    state: Type.String(),
  }),
  OpenObject({
    code: Type.Literal("requirement_underflow"),
    inventoryItemId: resourceIdSchema,
  }),
  OpenObject({
    code: Type.Literal("quantity_unit_mismatch"),
    inventoryItemId: resourceIdSchema,
  }),
  OpenObject({
    code: Type.Literal("invalid_requirement_adjustment"),
    inventoryItemId: resourceIdSchema,
  }),
]);
export type FoodServiceValidationError = Static<
  typeof foodServiceValidationErrorSchema
>;

export const inventoryAllocationCommitPointSchema = Type.Union([
  Type.Literal("order_placed"),
  Type.Literal("fulfillment_started"),
  Type.Literal("fulfillment_completed"),
  Type.Literal("preparation_completed"),
]);
export type InventoryAllocationCommitPoint = Static<
  typeof inventoryAllocationCommitPointSchema
>;

export const inventoryAllocationHeldDemandSchema = OpenObject({
  kind: Type.Literal("checkout"),
  checkoutId: recordTextSchema,
  checkoutLineId: recordTextSchema,
  consumeOn: Type.Refine(
    inventoryAllocationCommitPointSchema,
    isOrderCommitPoint,
    orderCommitPointError,
  ),
});
export type InventoryAllocationHeldDemand = Static<
  typeof inventoryAllocationHeldDemandSchema
>;

export const inventoryAllocationOrderCommitPointSchema = Type.Union([
  Type.Literal("fulfillment_started"),
  Type.Literal("fulfillment_completed"),
  Type.Literal("preparation_completed"),
]);
export type InventoryAllocationOrderCommitPoint = Static<
  typeof inventoryAllocationOrderCommitPointSchema
>;

export const inventoryAllocationCommittedDemandSchema = OpenObject({
  kind: Type.Literal("order"),
  orderId: recordTextSchema,
  orderLineId: recordTextSchema,
});
export type InventoryAllocationCommittedDemand = Static<
  typeof inventoryAllocationCommittedDemandSchema
>;

export const inventoryAllocationOwnerSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("checkout"),
    checkoutId: recordTextSchema,
    checkoutLineId: recordTextSchema,
  }),
  OpenObject({
    kind: Type.Literal("order"),
    orderId: recordTextSchema,
    orderLineId: recordTextSchema,
  }),
]);
export type InventoryAllocationOwner = Static<
  typeof inventoryAllocationOwnerSchema
>;

export const inventoryAllocationLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("held"),
    demand: inventoryAllocationHeldDemandSchema,
    expiresAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("allocated_to_order"),
    orderId: recordTextSchema,
    orderLineId: recordTextSchema,
    consumeOn: inventoryAllocationOrderCommitPointSchema,
    allocatedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("committed"),
    demand: inventoryAllocationCommittedDemandSchema,
    movementId: recordTextSchema,
    committedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("released"),
    demand: inventoryAllocationOwnerSchema,
    reason: recordTextSchema,
    releasedAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("expired"),
    demand: inventoryAllocationOwnerSchema,
    expiredAt: utcTimestampSchema,
  }),
]);
export type InventoryAllocationLifecycle = Static<
  typeof inventoryAllocationLifecycleSchema
>;

export const inventoryAllocationSchema = OpenObject({
  allocationId: recordTextSchema,
  inventoryItemId: recordTextSchema,
  locationId: recordTextSchema,
  quantity: Type.Refine(
    recordQuantitySchema,
    hasPositiveAmount,
    positiveAmountError,
  ),
  revision: PositiveInteger,
  lifecycle: inventoryAllocationLifecycleSchema,
});
export type InventoryAllocation = Static<typeof inventoryAllocationSchema>;

export const inventoryConsumptionModeSchema = Type.Union([
  OpenObject({ kind: Type.Literal("untracked") }),
  OpenObject({
    kind: Type.Literal("direct"),
    components: Type.Array(checkoutInventoryRequirementSchema),
    commitOn: directConsumptionCommitPointSchema,
  }),
  OpenObject({
    kind: Type.Literal("prepared"),
    recipeId: recordTextSchema,
    recipeRevision: PositiveInteger,
  }),
]);
export type InventoryConsumptionMode = Static<
  typeof inventoryConsumptionModeSchema
>;

export const inventoryConsumptionScopeSchema = Type.Union([
  OpenObject({ kind: Type.Literal("organisation") }),
  OpenObject({ kind: Type.Literal("location"), locationId: recordTextSchema }),
]);
export type InventoryConsumptionScope = Static<
  typeof inventoryConsumptionScopeSchema
>;

export const inventoryConsumptionPlanLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type InventoryConsumptionPlanLifecycle = Static<
  typeof inventoryConsumptionPlanLifecycleSchema
>;

export const inventoryConsumptionPlanSchema = OpenObject({
  consumptionPlanId: recordTextSchema,
  variantId: recordTextSchema,
  revision: PositiveInteger,
  scope: inventoryConsumptionScopeSchema,
  mode: inventoryConsumptionModeSchema,
  lifecycle: inventoryConsumptionPlanLifecycleSchema,
});
export type InventoryConsumptionPlan = Static<
  typeof inventoryConsumptionPlanSchema
>;

function isOrderCommitPoint(point: string): boolean {
  return point !== "order_placed";
}

function orderCommitPointError(): string {
  return "a held allocation is consumed after the order";
}

export const inventoryLotSchema = OpenObject({
  lotId: resourceIdSchema,
  lotCode: Type.String(),
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  revision: SafeInteger,
  sourceMovementId: resourceIdSchema,
  receivedQuantity: quantitySchema,
  remainingQuantity: quantitySchema,
  expiry: inventoryLotExpirySchema,
  lifecycle: inventoryLotLifecycleSchema,
});
export type InventoryLot = Static<typeof inventoryLotSchema>;

export const inventoryMovementSchema = OpenObject({
  movementId: resourceIdSchema,
  inventoryItemId: resourceIdSchema,
  locationId: resourceIdSchema,
  change: inventoryMovementChangeSchema,
  occurredAt: commerceTimestampSchema,
  idempotencyKey: Type.String(),
});
export type InventoryMovement = Static<typeof inventoryMovementSchema>;

export const orderTotalComponentKindSchema = Type.Union([
  Type.Literal("subtotal"),
  Type.Literal("discount"),
  Type.Literal("tax"),
  Type.Literal("duty"),
  Type.Literal("shipping"),
  Type.Literal("service_fee"),
  Type.Literal("tip"),
  Type.Literal("rounding"),
  Type.Literal("total"),
]);
export type OrderTotalComponentKind = Static<
  typeof orderTotalComponentKindSchema
>;

export const shipmentLabelAttemptLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("purchased"),
    providerLabelReference: Type.String(),
    trackingNumber: Type.String(),
    purchasedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("rejected"),
    reason: Type.String(),
    rejectedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("indeterminate"),
    lastAttemptAt: commerceTimestampSchema,
  }),
]);
export type ShipmentLabelAttemptLifecycle = Static<
  typeof shipmentLabelAttemptLifecycleSchema
>;

export const shipmentLabelAttemptSchema = OpenObject({
  labelAttemptId: resourceIdSchema,
  shipmentId: resourceIdSchema,
  shipmentRevision: SafeInteger,
  labelRateId: resourceIdSchema,
  rateReference: Type.String(),
  packagePlanDigest: Type.String(),
  idempotencyKey: Type.String(),
  revision: SafeInteger,
  lifecycle: shipmentLabelAttemptLifecycleSchema,
});
export type ShipmentLabelAttempt = Static<typeof shipmentLabelAttemptSchema>;

export const shipmentLabelRateSnapshotSchema = OpenObject({
  labelRateId: resourceIdSchema,
  shipmentId: resourceIdSchema,
  shipmentRevision: SafeInteger,
  providerAccountReference: Type.String(),
  rateReference: Type.String(),
  service: carrierServiceSnapshotSchema,
  amount: moneySchema,
  packagePlanDigest: Type.String(),
  quotedAt: commerceTimestampSchema,
  expiresAt: commerceTimestampSchema,
});
export type ShipmentLabelRateSnapshot = Static<
  typeof shipmentLabelRateSnapshotSchema
>;

export const shippingEligibilitySchema = Type.Union([
  OpenObject({ kind: Type.Literal("prohibited"), reason: recordTextSchema }),
  OpenObject({
    kind: Type.Literal("physical"),
    weight: shippingWeightSchema,
    dimensions: shippingDimensionsSchema,
    countryOfOrigin: countryCodeTextSchema,
    hsCode: hsCodeSchema,
    description: recordTextSchema,
  }),
]);
export type ShippingEligibility = Static<typeof shippingEligibilitySchema>;

export const shippingProfileLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("active"),
    activeAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("inactive"),
    inactiveAt: utcTimestampSchema,
  }),
]);
export type ShippingProfileLifecycle = Static<
  typeof shippingProfileLifecycleSchema
>;

export const shippingProfileSchema = StrictObject({
  shippingProfileId: recordTextSchema,
  revision: PositiveInteger,
  name: recordTextSchema,
  originLocationId: recordTextSchema,
  routes: Type.Refine(
    Type.Array(shippingRouteBindingSchema, { minItems: 1 }),
    hasUniqueRouteIds,
    uniqueRouteIdsError,
  ),
  lifecycle: shippingProfileLifecycleSchema,
});
export type ShippingProfile = Static<typeof shippingProfileSchema>;

export const storefrontFulfillmentConfigurationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("pickup"),
    locationId: recordTextSchema,
    readyLeadTimeSeconds: PositiveInteger,
  }),
  OpenObject({
    kind: Type.Literal("shipping"),
    originLocationId: recordTextSchema,
    shippingProfileId: recordTextSchema,
  }),
]);
export type StorefrontFulfillmentConfiguration = Static<
  typeof storefrontFulfillmentConfigurationSchema
>;

export const storefrontTaxConfigurationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("percentage"),
    basisPoints: Type.Integer({ minimum: 0, maximum: 10_000 }),
    // "included": listed prices already hold the tax, as Japan requires;
    // the buyer pays the subtotal. Absent means "added" on top.
    inclusion: Type.Optional(
      Type.Union([Type.Literal("added"), Type.Literal("included")]),
    ),
  }),
  OpenObject({
    kind: Type.Literal("provider_quoted"),
    providerAccountReference: recordTextSchema,
  }),
]);
export type StorefrontTaxConfiguration = Static<
  typeof storefrontTaxConfigurationSchema
>;

export const storefrontCheckoutConfigurationSchema = OpenObject({
  quoteTtlSeconds: PositiveInteger,
  tax: storefrontTaxConfigurationSchema,
});
export type StorefrontCheckoutConfiguration = Static<
  typeof storefrontCheckoutConfigurationSchema
>;

export const storefrontLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("active"),
    activeAt: utcTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("inactive"),
    inactiveAt: utcTimestampSchema,
  }),
]);
export type StorefrontLifecycle = Static<typeof storefrontLifecycleSchema>;

export const storefrontSchema = OpenObject({
  storefrontId: recordTextSchema,
  revision: PositiveInteger,
  name: recordTextSchema,
  salesChannelId: recordTextSchema,
  fulfillment: storefrontFulfillmentConfigurationSchema,
  checkout: storefrontCheckoutConfigurationSchema,
  lifecycle: storefrontLifecycleSchema,
});
export type Storefront = Static<typeof storefrontSchema>;

export const variantShippingSpecificationSchema = OpenObject({
  variantId: recordTextSchema,
  variantRevision: PositiveInteger,
  shippingProfileId: recordTextSchema,
  shippingProfileRevision: PositiveInteger,
  eligibility: shippingEligibilitySchema,
});
export type VariantShippingSpecification = Static<
  typeof variantShippingSpecificationSchema
>;

function hasUniqueRouteIds(
  routes: readonly Readonly<{ routeId: string }>[],
): boolean {
  return hasUniqueValues(routes.map(readRouteId));
}

function readRouteId(route: Readonly<{ routeId: string }>): string {
  return route.routeId;
}

function uniqueRouteIdsError(): string {
  return "routes must have unique route ids";
}

// Parsers of the records above (Plan 78 step 2).
export const parseQuantityUnit = recordParser(quantityUnitSchema);
export const parseAvailableQuantity = recordParser(availableQuantitySchema);
export const parseBuyer = recordParser(buyerSchema);
export const parseProduct = recordParser(productSchema);
export const parseProductOption = recordParser(productOptionSchema);
export const parseProductMediaKind = recordParser(productMediaKindSchema);
export const parseProductMedia = recordParser(productMediaSchema);
export const parseSellableVariant = recordParser(sellableVariantSchema);
export const parseInventoryItemCategory = recordParser(
  inventoryItemCategorySchema,
);
export const parseInventoryExpiryTracking = recordParser(
  inventoryExpiryTrackingSchema,
);
export const parseInventoryTrackingPolicy = recordParser(
  inventoryTrackingPolicySchema,
);
export const parseInventoryItemLifecycle = recordParser(
  inventoryItemLifecycleSchema,
);
export const parseInventoryItem = recordParser(inventoryItemSchema);
export const parseLocationKind = recordParser(locationKindSchema);
export const parseLocationLifecycle = recordParser(locationLifecycleSchema);
export const parseLocation = recordParser(locationSchema);
export const parseSalesChannelKind = recordParser(salesChannelKindSchema);
export const parseSalesChannelLifecycle = recordParser(
  salesChannelLifecycleSchema,
);
export const parseSalesChannel = recordParser(salesChannelSchema);
export const parseSellableVariantAvailability = recordParser(
  sellableVariantAvailabilitySchema,
);
export const parseOfferLifecycle = recordParser(offerLifecycleSchema);
export const parseOffer = recordParser(offerSchema);
export const parseQuantity = recordParser(quantitySchema);
export const parseInventoryBalance = recordParser(inventoryBalanceSchema);
export const parseInventoryPosition = recordParser(inventoryPositionSchema);
export const parseInventoryReceiptPurchase = recordParser(
  inventoryReceiptPurchaseSchema,
);
export const parseInventoryIncreaseReason = recordParser(
  inventoryIncreaseReasonSchema,
);
export const parseInventoryDecreaseReason = recordParser(
  inventoryDecreaseReasonSchema,
);
export const parseLotAllocation = recordParser(lotAllocationSchema);
export const parseInventoryLotAllocation = recordParser(
  inventoryLotAllocationSchema,
);
export const parseInventoryMovementChange = recordParser(
  inventoryMovementChangeSchema,
);
export const parseInventoryMovementProjection = recordParser(
  inventoryMovementProjectionSchema,
);
export const parseInventoryLotExpiry = recordParser(inventoryLotExpirySchema);
export const parseInventoryLotLifecycle = recordParser(
  inventoryLotLifecycleSchema,
);
export const parseInventoryLotProjection = recordParser(
  inventoryLotProjectionSchema,
);
export const parseOnlineOrderConfiguration = recordParser(
  onlineOrderConfigurationSchema,
);
export const parseOrderOrigin = recordParser(orderOriginSchema);
export const parseInventoryRequirement = recordParser(
  inventoryRequirementSchema,
);
export const parseOrderLineInventory = recordParser(orderLineInventorySchema);
export const parseFoodServicePreparation = recordParser(
  foodServicePreparationSchema,
);
export const parseInventoryRequirementAdjustment = recordParser(
  inventoryRequirementAdjustmentSchema,
);
export const parseModifierSelectionSnapshot = recordParser(
  modifierSelectionSnapshotSchema,
);
export const parseOrderLineSource = recordParser(orderLineSourceSchema);
export const parseOrderLineItem = recordParser(orderLineItemSchema);
export const parseOrderTotals = recordParser(orderTotalsSchema);
export const parseOrderAdjustmentKind = recordParser(orderAdjustmentKindSchema);
export const parseOrderAdjustmentStatus = recordParser(
  orderAdjustmentStatusSchema,
);
export const parseOrderAdjustment = recordParser(orderAdjustmentSchema);
export const parseOrderLifecycle = recordParser(orderLifecycleSchema);
export const parseCommerceOrder = recordParser(commerceOrderSchema);
export const parsePaymentLifecycle = recordParser(paymentLifecycleSchema);
export const parsePayment = recordParser(paymentSchema);
export const parseFulfillmentLineItem = recordParser(fulfillmentLineItemSchema);
export const parseInternationalDutyIncoterm = recordParser(
  internationalDutyIncotermSchema,
);
export const parseShippingRouteBinding = recordParser(
  shippingRouteBindingSchema,
);
export const parseCarrierServiceSnapshot = recordParser(
  carrierServiceSnapshotSchema,
);
export const parseCheckoutLineChargeAllocation = recordParser(
  checkoutLineChargeAllocationSchema,
);
export const parseCarrierRateSnapshot = recordParser(carrierRateSnapshotSchema);
export const parseTaxQuoteSnapshot = recordParser(taxQuoteSnapshotSchema);
export const parseDutyIncoterm = recordParser(dutyIncotermSchema);
export const parseDutyQuoteSnapshot = recordParser(dutyQuoteSnapshotSchema);
export const parseEstimatedDeliverySnapshot = recordParser(
  estimatedDeliverySnapshotSchema,
);
export const parseProtectedShippingAddress = recordParser(
  protectedShippingAddressSchema,
);
export const parseShippingWeight = recordParser(shippingWeightSchema);
export const parseShippingDimensions = recordParser(shippingDimensionsSchema);
export const parseShippingLineQuantity = recordParser(
  shippingLineQuantitySchema,
);
export const parseCustomsLineSnapshot = recordParser(customsLineSnapshotSchema);
export const parsePlannedPackage = recordParser(plannedPackageSchema);
export const parsePackagePlanSnapshot = recordParser(packagePlanSnapshotSchema);
export const parseShippingQuoteSnapshot = recordParser(
  shippingQuoteSnapshotSchema,
  "shippingQuote",
);
export const parseShippingFulfillmentBinding = recordParser(
  shippingFulfillmentBindingSchema,
);
export const parseShippingFulfillmentLifecycle = recordParser(
  shippingFulfillmentLifecycleSchema,
);
export const parsePickupFulfillmentLifecycle = recordParser(
  pickupFulfillmentLifecycleSchema,
);
export const parseLocalDeliveryFulfillmentLifecycle = recordParser(
  localDeliveryFulfillmentLifecycleSchema,
);
export const parseImmediateHandoffFulfillmentLifecycle = recordParser(
  immediateHandoffFulfillmentLifecycleSchema,
);
export const parseOnPremiseFulfillmentLifecycle = recordParser(
  onPremiseFulfillmentLifecycleSchema,
);
export const parseFulfillment = recordParser(fulfillmentSchema);
export const parseOrderLineQuantity = recordParser(orderLineQuantitySchema);
export const parseShipmentCustomsLineSnapshot = recordParser(
  shipmentCustomsLineSnapshotSchema,
);
export const parseShipmentPackage = recordParser(shipmentPackageSchema);
export const parseFirstPartyShipmentLifecycle = recordParser(
  firstPartyShipmentLifecycleSchema,
);
export const parseTrackingEventKind = recordParser(trackingEventKindSchema);
export const parseTrackingEvent = recordParser(trackingEventSchema);
export const parseExternalShipmentLifecycle = recordParser(
  externalShipmentLifecycleSchema,
);
export const parseShipment = recordParser(shipmentSchema);
export const parseMenuScope = recordParser(menuScopeSchema);
export const parseMenuValidity = recordParser(menuValiditySchema);
export const parseMenuSection = recordParser(menuSectionSchema);
export const parseModifierGroupRevisionReference = recordParser(
  modifierGroupRevisionReferenceSchema,
);
export const parseMenuEntryLifecycle = recordParser(menuEntryLifecycleSchema);
export const parseMenuEntry = recordParser(menuEntrySchema);
export const parseMenuLifecycle = recordParser(menuLifecycleSchema);
export const parseMenu = recordParser(menuSchema);
export const parseModifierOption = recordParser(modifierOptionSchema);
export const parseModifierGroupRevisionLifecycle = recordParser(
  modifierGroupRevisionLifecycleSchema,
);
export const parseModifierGroupRevision = recordParser(
  modifierGroupRevisionSchema,
);
export const parseRecipeOutput = recordParser(recipeOutputSchema);
export const parseRecipeRevisionLifecycle = recordParser(
  recipeRevisionLifecycleSchema,
);
export const parseRecipeRevision = recordParser(recipeRevisionSchema);
export const parsePreparationStationLifecycle = recordParser(
  preparationStationLifecycleSchema,
);
export const parsePreparationStation = recordParser(preparationStationSchema);
export const parsePreparationTicketLineSnapshot = recordParser(
  preparationTicketLineSnapshotSchema,
);
export const parsePreparationTicketLifecycle = recordParser(
  preparationTicketLifecycleSchema,
);
export const parsePreparationTicket = recordParser(preparationTicketSchema);
export const parseProductionBatchDemand = recordParser(
  productionBatchDemandSchema,
);
export const parseProductionBatch = recordParser(productionBatchSchema);
export const parseInventoryReplenishmentPolicy = recordParser(
  inventoryReplenishmentPolicySchema,
);
export const parseStockPolicyLifecycle = recordParser(
  stockPolicyLifecycleSchema,
);
export const parseStockPolicy = recordParser(stockPolicySchema);
export const parseCommerceProjection = recordParser(commerceProjectionSchema);
export const parseCanonicalCommerceObservation = recordParser(
  canonicalCommerceObservationSchema,
);
export const parseCanonicalCommerceDelivery = recordParser(
  canonicalCommerceDeliverySchema,
);
export const parseCartLineSource = recordParser(cartLineSourceSchema);
export const parseCartLine = recordParser(cartLineSchema);
export const parseCartLifecycle = recordParser(cartLifecycleSchema);
export const parseCart = recordParser(cartSchema, "cart");
export const parseProtectedBuyerContact = recordParser(
  protectedBuyerContactSchema,
);
export const parsePointOfSaleBuyer = recordParser(
  pointOfSaleBuyerSchema,
  "checkout.source.buyer",
);
export const parseCheckoutSource = recordParser(
  checkoutSourceSchema,
  "checkout.source",
);
export const parseCheckoutLineSource = recordParser(checkoutLineSourceSchema);
export const parseCheckoutPriceOverride = recordParser(
  checkoutPriceOverrideSchema,
);
export const parseCheckoutLineSnapshot = recordParser(
  checkoutLineSnapshotSchema,
);
export const parseCheckoutTotals = recordParser(checkoutTotalsSchema);
export const parsePickupPromiseSnapshot = recordParser(
  pickupPromiseSnapshotSchema,
);
export const parseCheckoutFulfillmentQuoteSnapshot = recordParser(
  checkoutFulfillmentQuoteSnapshotSchema,
);
export const parseCheckoutMarketSnapshot = recordParser(
  checkoutMarketSnapshotSchema,
);
export const parseStoredValueKind = recordParser(storedValueKindSchema);
export const parseCheckoutStoredValueTender = recordParser(
  checkoutStoredValueTenderSchema,
);
export const parseCheckoutStoredValue = recordParser(checkoutStoredValueSchema);
export const parseCheckoutPluginRunOutcome = recordParser(
  checkoutPluginRunOutcomeSchema,
);
export const parseCheckoutPluginRun = recordParser(checkoutPluginRunSchema);
export const parseCheckoutQuoteSnapshot = recordParser(
  checkoutQuoteSnapshotSchema,
);
export const parseCheckoutLifecycle = recordParser(checkoutLifecycleSchema);
export const parseCheckout = recordParser(checkoutSchema, "checkout");
export const parsePaymentEnvironment = recordParser(paymentEnvironmentSchema);
export const parsePaymentProviderAccountBinding = recordParser(
  paymentProviderAccountBindingSchema,
);
export const parseStripeOnlineCollection = recordParser(
  stripeOnlineCollectionSchema,
);
export const parseGmoPgOnlineCollection = recordParser(
  gmoPgOnlineCollectionSchema,
);
export const parseOnlinePaymentBinding = recordParser(
  onlinePaymentBindingSchema,
);
export const parseInPersonPaymentBinding = recordParser(
  inPersonPaymentBindingSchema,
);
export const parseCheckoutPaymentProviderBinding = recordParser(
  checkoutPaymentProviderBindingSchema,
);
export const parseCheckoutPaymentBinding = recordParser(
  checkoutPaymentBindingSchema,
);
export const parseCheckoutPaymentAttemptLifecycle = recordParser(
  checkoutPaymentAttemptLifecycleSchema,
);
export const parseCheckoutPaymentAttempt = recordParser(
  checkoutPaymentAttemptSchema,
  "checkoutPaymentAttempt",
);
export const parseCommerceValidationError = recordParser(
  commerceValidationErrorSchema,
);
export const parseDirectConsumptionCommitPoint = recordParser(
  directConsumptionCommitPointSchema,
);
export const parseFoodServiceValidationError = recordParser(
  foodServiceValidationErrorSchema,
);
export const parseInventoryAllocationCommitPoint = recordParser(
  inventoryAllocationCommitPointSchema,
);
export const parseInventoryAllocationHeldDemand = recordParser(
  inventoryAllocationHeldDemandSchema,
);
export const parseInventoryAllocationOrderCommitPoint = recordParser(
  inventoryAllocationOrderCommitPointSchema,
);
export const parseInventoryAllocationCommittedDemand = recordParser(
  inventoryAllocationCommittedDemandSchema,
);
export const parseInventoryAllocationOwner = recordParser(
  inventoryAllocationOwnerSchema,
);
export const parseInventoryAllocationLifecycle = recordParser(
  inventoryAllocationLifecycleSchema,
);
export const parseInventoryAllocation = recordParser(
  inventoryAllocationSchema,
  "inventoryAllocation",
);
export const parseInventoryConsumptionMode = recordParser(
  inventoryConsumptionModeSchema,
);
export const parseInventoryConsumptionScope = recordParser(
  inventoryConsumptionScopeSchema,
);
export const parseInventoryConsumptionPlanLifecycle = recordParser(
  inventoryConsumptionPlanLifecycleSchema,
);
export const parseInventoryConsumptionPlan = recordParser(
  inventoryConsumptionPlanSchema,
  "inventoryConsumptionPlan",
);
export const parseInventoryLot = recordParser(inventoryLotSchema);
export const parseInventoryMovement = recordParser(inventoryMovementSchema);
export const parseOrderTotalComponentKind = recordParser(
  orderTotalComponentKindSchema,
);
export const parseShipmentLabelAttemptLifecycle = recordParser(
  shipmentLabelAttemptLifecycleSchema,
);
export const parseShipmentLabelAttempt = recordParser(
  shipmentLabelAttemptSchema,
);
export const parseShipmentLabelRateSnapshot = recordParser(
  shipmentLabelRateSnapshotSchema,
);
export const parseShippingEligibility = recordParser(shippingEligibilitySchema);
export const parseShippingProfileLifecycle = recordParser(
  shippingProfileLifecycleSchema,
);
export const parseShippingProfile = recordParser(
  shippingProfileSchema,
  "shippingProfile",
);
export const parseStorefrontFulfillmentConfiguration = recordParser(
  storefrontFulfillmentConfigurationSchema,
);
export const parseStorefrontTaxConfiguration = recordParser(
  storefrontTaxConfigurationSchema,
);
export const parseStorefrontCheckoutConfiguration = recordParser(
  storefrontCheckoutConfigurationSchema,
);
export const parseStorefrontLifecycle = recordParser(storefrontLifecycleSchema);
export const parseStorefront = recordParser(storefrontSchema, "storefront");
export const parseVariantShippingSpecification = recordParser(
  variantShippingSpecificationSchema,
  "shippingSpecification",
);
