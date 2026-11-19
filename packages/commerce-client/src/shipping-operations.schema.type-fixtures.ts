// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiShippingOperations from "@purin-labs/commerce-contracts/records/api-shipping-operations";
import type {
  AttachFulfillmentTrackingCommand,
  PurchaseShippingLabelCommand,
  QuoteShipmentLabelRateCommand,
  RecordShippingTrackingCommand,
  ShipmentLabelRateResult,
  CommerceShipmentLabelAttemptV1,
} from "./shipping-operations.ts";
export type AttachFulfillmentTrackingCommandParity = Assert<
  Equal<
    AttachFulfillmentTrackingCommand,
    apiShippingOperations.AttachFulfillmentTrackingCommand
  >
>;
export type PurchaseShippingLabelCommandParity = Assert<
  Equal<
    PurchaseShippingLabelCommand,
    apiShippingOperations.PurchaseShippingLabelCommand
  >
>;
export type QuoteShipmentLabelRateCommandParity = Assert<
  Equal<
    QuoteShipmentLabelRateCommand,
    apiShippingOperations.QuoteShipmentLabelRateCommand
  >
>;
export type RecordShippingTrackingCommandParity = Assert<
  Equal<
    RecordShippingTrackingCommand,
    apiShippingOperations.RecordShippingTrackingCommand
  >
>;
export type ShipmentLabelRateResultParity = Assert<
  Equal<ShipmentLabelRateResult, apiShippingOperations.ShipmentLabelRateResult>
>;
export type CommerceShipmentLabelAttemptV1Parity = Assert<
  Equal<
    CommerceShipmentLabelAttemptV1,
    apiShippingOperations.CommerceShipmentLabelAttemptV1
  >
>;
