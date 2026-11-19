// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiResources from "@purin-labs/commerce-contracts/records/api-resources";
import type * as apiResourcesB from "@purin-labs/commerce-contracts/records/api-common";
import type * as client from "./commerce-resources.ts";
import type { CommerceOrderMarketV1 } from "./markets.ts";
export type CommerceProductV1Parity = Assert<
  Equal<client.CommerceProductV1, apiResources.CommerceProductV1>
>;
export type CommerceVariantV1Parity = Assert<
  Equal<client.CommerceVariantV1, apiResources.CommerceVariantV1>
>;
export type CommerceInventoryItemV1Parity = Assert<
  Equal<
    client.CommerceInventoryItemV1,
    apiResources.CommerceInventoryItemV1
  >
>;
export type CommerceAvailableQuantityV1Parity = Assert<
  Equal<
    client.CommerceAvailableQuantityV1,
    apiResources.CommerceAvailableQuantityV1
  >
>;
export type CommerceInventoryBalanceV1Parity = Assert<
  Equal<
    client.CommerceInventoryBalanceV1,
    apiResources.CommerceInventoryBalanceV1
  >
>;
export type CommerceInventoryPositionV1Parity = Assert<
  Equal<
    client.CommerceInventoryPositionV1,
    apiResources.CommerceInventoryPositionV1
  >
>;
export type CommerceOnlineOrderConfigurationV1Parity = Assert<
  Equal<
    client.CommerceOnlineOrderConfigurationV1,
    apiResources.CommerceOnlineOrderConfigurationV1
  >
>;
export type CommerceOrderOriginV1Parity = Assert<
  Equal<client.CommerceOrderOriginV1, apiResources.CommerceOrderOriginV1>
>;
export type CommerceOrderLineSourceV1Parity = Assert<
  Equal<
    client.CommerceOrderLineSourceV1,
    apiResources.CommerceOrderLineSourceV1
  >
>;
export type CommerceOrderLineItemV1Parity = Assert<
  Equal<
    client.CommerceOrderLineItemV1,
    apiResources.CommerceOrderLineItemV1
  >
>;
export type CommerceOrderTotalsV1Parity = Assert<
  Equal<client.CommerceOrderTotalsV1, apiResources.CommerceOrderTotalsV1>
>;
export type CommerceOrderLifecycleV1Parity = Assert<
  Equal<
    client.CommerceOrderLifecycleV1,
    apiResources.CommerceOrderLifecycleV1
  >
>;
export type CommerceOrderAdjustmentV1Parity = Assert<
  Equal<
    client.CommerceOrderAdjustmentV1,
    apiResources.CommerceOrderAdjustmentV1
  >
>;
export type CommerceOrderV1Parity = Assert<
  Equal<client.CommerceOrderV1, apiResources.CommerceOrderV1>
>;
export type CommercePaymentLifecycleV1Parity = Assert<
  Equal<
    client.CommercePaymentLifecycleV1,
    apiResources.CommercePaymentLifecycleV1
  >
>;
export type CommercePaymentV1Parity = Assert<
  Equal<client.CommercePaymentV1, apiResources.CommercePaymentV1>
>;
export type CommercePickupFulfillmentLifecycleV1Parity = Assert<
  Equal<
    client.CommercePickupFulfillmentLifecycleV1,
    apiResources.CommercePickupFulfillmentLifecycleV1
  >
>;
export type CommerceShippingFulfillmentLifecycleV1Parity = Assert<
  Equal<
    client.CommerceShippingFulfillmentLifecycleV1,
    apiResources.CommerceShippingFulfillmentLifecycleV1
  >
>;
export type CommerceLocalDeliveryFulfillmentLifecycleV1Parity = Assert<
  Equal<
    client.CommerceLocalDeliveryFulfillmentLifecycleV1,
    apiResources.CommerceLocalDeliveryFulfillmentLifecycleV1
  >
>;
export type CommerceImmediateHandoffFulfillmentLifecycleV1Parity = Assert<
  Equal<
    client.CommerceImmediateHandoffFulfillmentLifecycleV1,
    apiResources.CommerceImmediateHandoffFulfillmentLifecycleV1
  >
>;
export type CommerceOnPremiseFulfillmentLifecycleV1Parity = Assert<
  Equal<
    client.CommerceOnPremiseFulfillmentLifecycleV1,
    apiResources.CommerceOnPremiseFulfillmentLifecycleV1
  >
>;
export type CommerceFulfillmentLineItemV1Parity = Assert<
  Equal<
    client.CommerceFulfillmentLineItemV1,
    apiResources.CommerceFulfillmentLineItemV1
  >
>;
export type CommerceFulfillmentV1Parity = Assert<
  Equal<client.CommerceFulfillmentV1, apiResources.CommerceFulfillmentV1>
>;
export type CommerceTrackingEventKindV1Parity = Assert<
  Equal<
    client.CommerceTrackingEventKindV1,
    apiResources.CommerceTrackingEventKindV1
  >
>;
export type CommerceTrackingEventV1Parity = Assert<
  Equal<
    client.CommerceTrackingEventV1,
    apiResources.CommerceTrackingEventV1
  >
>;
export type CommerceShipmentV1Parity = Assert<
  Equal<client.CommerceShipmentV1, apiResources.CommerceShipmentV1>
>;
export type CommerceResourcesV1Parity = Assert<
  Equal<
    client.CommerceResourcesV1,
    apiResources.CommerceResourcesV1
  >
>;
export type CommerceMerchantSnapshotV1Parity = Assert<
  Equal<
    client.CommerceMerchantSnapshotV1,
    apiResources.CommerceMerchantSnapshotV1
  >
>;
export type CommerceInventoryLotV1Parity = Assert<
  Equal<client.CommerceInventoryLotV1, apiResources.CommerceInventoryLotV1>
>;
export type CommerceLotAllocationV1Parity = Assert<
  Equal<
    client.CommerceLotAllocationV1,
    apiResources.CommerceLotAllocationV1
  >
>;
export type CommerceStockCountReasonParity = Assert<
  Equal<
    client.CommerceStockCountReason,
    apiResources.CommerceStockCountReason
  >
>;
export type CommerceInventoryMovementV1Parity = Assert<
  Equal<
    client.CommerceInventoryMovementV1,
    apiResources.CommerceInventoryMovementV1
  >
>;
export type ParsedQuoteTotalsParity = Assert<
  Equal<client.ParsedQuoteTotals, apiResources.ParsedQuoteTotals>
>;
export type CommerceLocationV1Parity = Assert<
  Equal<client.CommerceLocationV1, apiResourcesB.CommerceLocationV1>
>;
export type CommerceSalesChannelV1Parity = Assert<
  Equal<client.CommerceSalesChannelV1, apiResourcesB.CommerceSalesChannelV1>
>;
export type CommerceOfferV1Parity = Assert<
  Equal<client.CommerceOfferV1, apiResourcesB.CommerceOfferV1>
>;
export type CommerceBuyerV1Parity = Assert<
  Equal<client.CommerceBuyerV1, apiResourcesB.CommerceBuyerV1>
>;
export type CommerceQuantityV1Parity = Assert<
  Equal<client.CommerceQuantityV1, apiResourcesB.CommerceQuantityV1>
>;
export type CommerceLocationLifecycleParity = Assert<
  Equal<
    client.CommerceLocationLifecycle,
    apiResourcesB.CommerceLocationLifecycle
  >
>;
export type CommerceInventoryReceiptPurchaseParity = Assert<
  Equal<
    client.CommerceInventoryReceiptPurchase,
    apiResourcesB.CommerceInventoryReceiptPurchase
  >
>;
export type CommerceProtectedBuyerContactV1Parity = Assert<
  Equal<
    client.CommerceProtectedBuyerContactV1,
    apiResourcesB.CommerceProtectedBuyerContactV1
  >
>;
export type CommerceOrderMarketV1Parity = Assert<
  Equal<CommerceOrderMarketV1, apiResources.CommerceOrderMarketV1>
>;
