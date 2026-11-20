import {
  type Cart,
  type Checkout,
  type CheckoutPaymentAttempt,
  type CheckoutProfileReference,
  type CheckoutSource,
  type InventoryAllocation,
  type InventoryConsumptionPlan,
  type LocationKind,
  type Menu,
  type ModifierGroupRevision,
  type PointOfSaleBuyer,
  type PointOfSaleCatalogScope,
  type PointOfSaleConfiguration,
  type PreparationStation,
  type PreparationTicket,
  type ProductionBatch,
  type ProtectedBuyerContact,
  type QuantityUnit,
  type RecipeRevision,
  type SalesChannelKind,
  type ShippingProfile,
  type ShippingQuoteSnapshot,
  type StockPolicy,
  type Storefront,
  type VariantShippingSpecification,
} from "@purin-labs/commerce-contracts";
import { parseCommerceStockSnapshotV1Record } from "@purin-labs/commerce-contracts/records/api-stock";
import type { Variant } from "@purin-labs/type-utils";
import { type CommerceFoodServiceSnapshotV1 } from "./food-service.ts";
import {
  parseCart as parseCartRecord,
  parseCheckout as parseCheckoutRecord,
  parseCheckoutPaymentAttempt as parseCheckoutPaymentAttemptRecord,
  parseCheckoutSource as parseCheckoutSourceRecord,
  parseInventoryAllocation as parseInventoryAllocationRecord,
  parseInventoryConsumptionPlan as parseInventoryConsumptionPlanRecord,
  parsePointOfSaleBuyer as parsePointOfSaleBuyerRecord,
  parseShippingProfile as parseShippingProfileRecord,
  parseShippingQuoteSnapshot as parseShippingQuoteSnapshotRecord,
  parseStorefront as parseStorefrontRecord,
  parseVariantShippingSpecification as parseVariantShippingSpecificationRecord,
} from "@purin-labs/commerce-contracts/records/commerce-records";
import {
  checkoutProfileRecordReferenceSchema,
} from "@purin-labs/commerce-contracts/records/commerce-records";
import { parsePointOfSaleConfiguration as parsePointOfSaleConfigurationRecord } from "@purin-labs/commerce-contracts/records/point-of-sale-configuration";
import {
  fieldRecordParser,
  parseCommerceFulfillmentV1 as parseCommerceFulfillmentV1Record,
  parseCommerceInventoryItemV1 as parseCommerceInventoryItemV1Record,
  parseCommerceInventoryLotV1 as parseCommerceInventoryLotV1Record,
  parseCommerceInventoryMovementV1 as parseCommerceInventoryMovementV1Record,
  parseCommerceInventoryPositionV1 as parseCommerceInventoryPositionV1Record,
  parseCommerceInventoryReceiptPurchaseV1 as parseCommerceInventoryReceiptPurchaseV1Record,
  parseCommerceLocationV1 as parseCommerceLocationV1Record,
  parseCommerceMerchantSnapshotV1 as parseCommerceMerchantSnapshotV1Record,
  parseCommerceOfferV1 as parseCommerceOfferV1Record,
  parseCommerceOrderV1 as parseCommerceOrderV1Record,
  parseCommercePaymentV1 as parseCommercePaymentV1Record,
  parseCommerceProductV1 as parseCommerceProductV1Record,
  parseCommerceSalesChannelV1 as parseCommerceSalesChannelV1Record,
  parseCommerceShipmentV1 as parseCommerceShipmentV1Record,
  parseCommerceVariantV1 as parseCommerceVariantV1Record,
} from "@purin-labs/commerce-contracts/records/api-resources";
import {
  wireMoneySchema,
  wireQuantitySchema,
} from "@purin-labs/commerce-contracts/records/api-common";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import type * as ApiResources from "@purin-labs/commerce-contracts/records/api-resources";
import type * as ApiResourcesB from "@purin-labs/commerce-contracts/records/api-common";

export type CommerceEngineTimestamp = string;

export type CommerceLocationKind = LocationKind;

export type CommerceSalesChannelKind = SalesChannelKind;

export type CommerceLocationLifecycle =
  ApiResourcesB.CommerceLocationLifecycle;

export type CommerceSalesChannelLifecycle = CommerceLocationLifecycle;

export type CommerceOfferLifecycle =
  | Readonly<{ state: "prepared"; preparedAt: CommerceEngineTimestamp }>
  | Readonly<{ state: "listed"; listedAt: CommerceEngineTimestamp }>
  | Readonly<{ state: "archived"; archivedAt: CommerceEngineTimestamp }>;

export type CommerceVariantAvailability =
  | Readonly<{ state: "available" }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "backordered"; expectedAt: CommerceEngineTimestamp }>;

export type CommerceAvailableQuantityV1 =
  ApiResources.CommerceAvailableQuantityV1;

export type CommerceInventoryBalanceV1 =
  ApiResources.CommerceInventoryBalanceV1;

export type CommerceQuantityUnit = QuantityUnit;

export type CommerceLocationV1 = ApiResourcesB.CommerceLocationV1;

export type CommerceSalesChannelV1 = ApiResourcesB.CommerceSalesChannelV1;

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type CommerceProductStatus = (typeof PRODUCT_STATUSES)[number];

export const VARIANT_STATUSES = ["active", "archived"] as const;
export type CommerceVariantStatus = (typeof VARIANT_STATUSES)[number];

export type CommerceProductV1 = ApiResources.CommerceProductV1;

export type CommerceVariantV1 = ApiResources.CommerceVariantV1;

export type CommerceInventoryItemV1 = ApiResources.CommerceInventoryItemV1;

export type CommerceOfferV1 = ApiResourcesB.CommerceOfferV1;

export type CommerceInventoryPositionV1 =
  ApiResources.CommerceInventoryPositionV1;

export type CommerceQuantityV1 = ApiResourcesB.CommerceQuantityV1;

export type CommerceOnlineOrderConfigurationV1 =
  ApiResources.CommerceOnlineOrderConfigurationV1;

export type CommerceOrderOriginV1 = ApiResources.CommerceOrderOriginV1;

export type CommerceBuyerV1 = ApiResourcesB.CommerceBuyerV1;

export type CommerceOrderLineSourceV1 =
  ApiResources.CommerceOrderLineSourceV1;

export type CommerceOrderLineItemV1 = ApiResources.CommerceOrderLineItemV1;

export type CommerceOrderTotalsV1 = ApiResources.CommerceOrderTotalsV1;

export type CommerceOrderLifecycleV1 =
  ApiResources.CommerceOrderLifecycleV1;

export type CommerceOrderAdjustmentV1 =
  ApiResources.CommerceOrderAdjustmentV1;

export type CommerceOrderV1 = ApiResources.CommerceOrderV1;

export type CommercePaymentLifecycleV1 =
  ApiResources.CommercePaymentLifecycleV1;

export type CommercePaymentV1 = ApiResources.CommercePaymentV1;

export type CommercePickupFulfillmentLifecycleV1 =
  ApiResources.CommercePickupFulfillmentLifecycleV1;

export type CommerceShippingFulfillmentLifecycleV1 =
  ApiResources.CommerceShippingFulfillmentLifecycleV1;

export type CommerceLocalDeliveryFulfillmentLifecycleV1 =
  ApiResources.CommerceLocalDeliveryFulfillmentLifecycleV1;

export type CommerceImmediateHandoffFulfillmentLifecycleV1 =
  ApiResources.CommerceImmediateHandoffFulfillmentLifecycleV1;

export type CommerceOnPremiseFulfillmentLifecycleV1 =
  ApiResources.CommerceOnPremiseFulfillmentLifecycleV1;

export type CommerceFulfillmentLineItemV1 =
  ApiResources.CommerceFulfillmentLineItemV1;

export type CommerceFulfillmentV1 = ApiResources.CommerceFulfillmentV1;

export type CommercePickupFulfillmentV1 = Variant<
  CommerceFulfillmentV1,
  "pickup"
>;

export type CommerceTrackingEventKindV1 =
  ApiResources.CommerceTrackingEventKindV1;

export type CommerceTrackingEventV1 = ApiResources.CommerceTrackingEventV1;

export type CommerceShipmentV1 = ApiResources.CommerceShipmentV1;

export type CommerceFirstPartyShipmentV1 = Variant<
  CommerceShipmentV1,
  "first_party"
>;

export type CommerceResourcesV1 =
  ApiResources.CommerceResourcesV1;

export type CommerceMerchantSnapshotV1 =
  ApiResources.CommerceMerchantSnapshotV1;

export type CommerceInventoryReceiptPurchase =
  ApiResourcesB.CommerceInventoryReceiptPurchase;

export function parseInventoryReceiptPurchase(
  value: unknown,
): CommerceInventoryReceiptPurchase {
  return decodeRecord(parseCommerceInventoryReceiptPurchaseV1Record, value);
}

export type CommerceStockSnapshot = Readonly<{
  commerce: CommerceMerchantSnapshotV1;
  foodService: CommerceFoodServiceSnapshotV1;
  lots: readonly CommerceInventoryLotV1[];
  usable: readonly { positionId: string; quantity: CommerceQuantityV1 }[];
  movements: readonly CommerceInventoryMovementV1[];
  allocations: readonly InventoryAllocation[];
  consumptionPlans: readonly InventoryConsumptionPlan[];
}>;

export function parseStockSnapshot(value: unknown): CommerceStockSnapshot {
  return decodeRecord(parseCommerceStockSnapshotV1Record, value);
}

export type CommerceMenuV1 = Menu;

export type CommerceModifierGroupRevisionV1 = ModifierGroupRevision;

export type CommerceRecipeRevisionV1 = RecipeRevision;

export type CommercePreparationStationV1 = PreparationStation;

export type CommercePreparationTicketV1 = PreparationTicket;

export type CommerceProductionBatchV1 = ProductionBatch;

export type CommerceStockPolicyV1 = StockPolicy;

export type CommerceInventoryLotV1 = ApiResources.CommerceInventoryLotV1;

export type CommerceLotAllocationV1 = ApiResources.CommerceLotAllocationV1;

export type CommerceStockCountReason =
  ApiResources.CommerceStockCountReason;

export type CommerceInventoryMovementV1 =
  ApiResources.CommerceInventoryMovementV1;

export type CommerceProtectedBuyerContactV1 = ProtectedBuyerContact;

export function parseMerchantSnapshot(
  value: unknown,
): CommerceMerchantSnapshotV1 {
  return decodeRecord(parseCommerceMerchantSnapshotV1Record, value);
}

export function parseInventoryLot(value: unknown): CommerceInventoryLotV1 {
  return decodeRecord(parseCommerceInventoryLotV1Record, value);
}

export function parseInventoryMovement(
  value: unknown,
): CommerceInventoryMovementV1 {
  return decodeRecord(parseCommerceInventoryMovementV1Record, value);
}

export function parseStorefront(value: unknown): Storefront {
  return decodeRecord(parseStorefrontRecord, value);
}

export function parseShippingProfile(value: unknown): ShippingProfile {
  return decodeRecord(parseShippingProfileRecord, value);
}

export function parseVariantShippingSpecification(
  value: unknown,
): VariantShippingSpecification {
  return decodeRecord(parseVariantShippingSpecificationRecord, value);
}

export function parseInventoryConsumptionPlan(
  value: unknown,
): InventoryConsumptionPlan {
  return decodeRecord(parseInventoryConsumptionPlanRecord, value);
}

export function parseCart(value: unknown): Cart {
  return decodeRecord(parseCartRecord, value);
}

export type OnlineCheckoutSource = Variant<CheckoutSource, "online">;

export type PointOfSaleCheckoutSource = Variant<
  CheckoutSource,
  "point_of_sale"
>;

export function parseCheckout(value: unknown): Checkout {
  return decodeRecord(parseCheckoutRecord, value);
}

/**
 * Parse where a Checkout came from. The branches share no fields, so an online
 * checkout cannot smuggle a terminal assignment and a counter sale cannot
 * carry a storefront or a fabricated buyer session.
 */
export function parseCheckoutSource(value: unknown): CheckoutSource {
  return decodeRecord(parseCheckoutSourceRecord, value);
}

/**
 * An anonymous counter sale owns no customer identity, so none can be parsed
 * into it.
 */
export function parsePointOfSaleBuyer(value: unknown): PointOfSaleBuyer {
  return decodeRecord(parsePointOfSaleBuyerRecord, value);
}

/** The online facts of a Checkout, or `undefined` for a counter sale. */
export function checkoutOnlineSource(
  checkout: Checkout,
): OnlineCheckoutSource | undefined {
  return checkout.source.kind === "online" ? checkout.source : undefined;
}

/**
 * The online facts of a Checkout, for paths that only an online checkout can
 * reach. Throwing here is deliberate: a caller that needs a storefront and got
 * a counter sale has a routing bug, not a missing field.
 */
export function requireCheckoutOnlineSource(
  checkout: Checkout,
): OnlineCheckoutSource {
  const source = checkoutOnlineSource(checkout);
  if (source === undefined) {
    throw new Error("checkout.source is not online");
  }
  return source;
}

/**
 * The published profile an online Checkout was priced under, or `undefined` at
 * a counter — which is priced by its own point-of-sale configuration instead.
 */
export function checkoutProfileOf(
  checkout: Readonly<{ source: CheckoutSource }>,
): CheckoutProfileReference | undefined {
  return checkout.source.kind === "online"
    ? checkout.source.checkoutProfile
    : undefined;
}

/**
 * The profile of a Checkout on a path only an online one can reach. Throwing
 * is deliberate for the same reason `requireCheckoutOnlineSource` throws: a
 * caller that needs a storefront profile and got a counter sale has a routing
 * bug, not a missing field.
 */
export function requireCheckoutProfile(
  checkout: Readonly<{ source: CheckoutSource }>,
): CheckoutProfileReference {
  const profile = checkoutProfileOf(checkout);
  if (profile === undefined) {
    throw new Error(
      "checkout.source is not online, so it pins no checkout profile",
    );
  }
  return profile;
}

/** The point-of-sale facts of a Checkout, or `undefined` for an online one. */
export function checkoutPointOfSaleSource(
  checkout: Checkout,
): PointOfSaleCheckoutSource | undefined {
  return checkout.source.kind === "point_of_sale" ? checkout.source : undefined;
}

export function parseCheckoutProfileReference(
  value: unknown,
  field = "checkoutProfile",
): CheckoutProfileReference {
  return decodeRecord(
    fieldRecordParser(checkoutProfileRecordReferenceSchema, field),
    value,
  );
}

export function parseCheckoutPaymentAttempt(
  value: unknown,
): CheckoutPaymentAttempt {
  return decodeRecord(parseCheckoutPaymentAttemptRecord, value);
}

export function parseInventoryAllocation(value: unknown): InventoryAllocation {
  return decodeRecord(parseInventoryAllocationRecord, value);
}

/**
 * Parse the published policy a counter sells under.
 *
 * Every field is required: a counter policy that is missing its tax rate or
 * item list is not a partial policy, it is an unsellable one.
 */
export function parsePointOfSaleConfiguration(
  value: unknown,
): PointOfSaleConfiguration {
  return decodeRecord(parsePointOfSaleConfigurationRecord, value);
}

/** Whether a counter policy revision may still ring up new sales. */
export function pointOfSaleConfigurationIsSellable(
  configuration: PointOfSaleConfiguration,
): boolean {
  return configuration.lifecycle.state === "published";
}

/** The catalog surface a counter sells from (defaults to `supported_items`). */
export function pointOfSaleCatalogScope(
  configuration: PointOfSaleConfiguration,
): PointOfSaleCatalogScope {
  return configuration.catalogScope ?? { kind: "supported_items" };
}

/** Whether cash tender is enabled on a counter policy (defaults to `false`). */
export function pointOfSaleCashEnabled(
  configuration: PointOfSaleConfiguration,
): boolean {
  return configuration.cashEnabled === true;
}

/** The quantity ceiling for one variant, or `undefined` if it is not sold. */
export function pointOfSaleQuantityCeiling(
  configuration: PointOfSaleConfiguration,
  variantId: string,
): number | undefined {
  return configuration.supportedItems.find(
    (item) => item.variantId === variantId,
  )?.maxQuantityPerLine;
}

export type ParsedQuoteTotals = ApiResources.ParsedQuoteTotals;

export function parseShippingQuoteSnapshot(
  value: unknown,
): ShippingQuoteSnapshot {
  return decodeRecord(parseShippingQuoteSnapshotRecord, value);
}

export function parseLocation(value: unknown): CommerceLocationV1 {
  return decodeRecord(parseCommerceLocationV1Record, value);
}

export function parseSalesChannel(value: unknown): CommerceSalesChannelV1 {
  return decodeRecord(parseCommerceSalesChannelV1Record, value);
}

export function parseProduct(value: unknown): CommerceProductV1 {
  return decodeRecord(parseCommerceProductV1Record, value);
}

// Callers that predate product editing send no details; they get the defaults
// of a new product.

export function parseVariant(value: unknown): CommerceVariantV1 {
  return decodeRecord(parseCommerceVariantV1Record, value);
}

export function parseInventoryItem(value: unknown): CommerceInventoryItemV1 {
  return decodeRecord(parseCommerceInventoryItemV1Record, value);
}

export function parseOffer(value: unknown): CommerceOfferV1 {
  return decodeRecord(parseCommerceOfferV1Record, value);
}

export function parseInventoryPosition(
  value: unknown,
): CommerceInventoryPositionV1 {
  return decodeRecord(parseCommerceInventoryPositionV1Record, value);
}

export function parseOrder(value: unknown): CommerceOrderV1 {
  return decodeRecord(parseCommerceOrderV1Record, value);
}

/**
 * The Checkout an Order was placed from, when its channel has one. Online and
 * point-of-sale Orders both come from a Checkout; marketplace and agent Orders
 * do not, so downstream lifecycle reads this instead of assuming `online`.
 */
export function orderOriginCheckoutId(
  origin: CommerceOrderOriginV1,
): string | undefined {
  switch (origin.kind) {
    case "online":
    case "point_of_sale":
      return origin.checkoutId;
    case "marketplace":
    case "agent":
      return undefined;
  }
}

export function parseQuantity(
  value: unknown,
  field: string,
): CommerceQuantityV1 {
  return decodeRecord(fieldRecordParser(wireQuantitySchema, field), value);
}

export function parseMoney(
  value: unknown,
  field: string,
): Readonly<{ amountMinor: number; currency: string }> {
  return decodeRecord(fieldRecordParser(wireMoneySchema, field), value);
}

export function parsePayment(value: unknown): CommercePaymentV1 {
  return decodeRecord(parseCommercePaymentV1Record, value);
}

export function parseFulfillment(value: unknown): CommerceFulfillmentV1 {
  return decodeRecord(parseCommerceFulfillmentV1Record, value);
}

export function parseShipment(value: unknown): CommerceShipmentV1 {
  return decodeRecord(parseCommerceShipmentV1Record, value);
}
