// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiOrderEdits from "@purin-labs/commerce-contracts/records/api-order-edits";
import type {
  EditCommerceOrderV1,
  ExchangeCommerceOrderLinesV1,
  OpenCommerceBuyerOrderBalanceV1,
  RecordCommerceOrderManualPaymentV1,
  CommerceOrderBalanceCheckoutV1,
  CommerceOrderBalanceV1,
  CommerceOrderChangeLineV1,
  CommerceOrderEditV1,
  CommerceOrderExchangeV1,
  CommerceOrderPaymentChangeV1,
  CommerceOrderChangeV1,
  CommerceOrderChangesV1,
} from "./order-edits.ts";
export type EditCommerceOrderV1Parity = Assert<
  Equal<EditCommerceOrderV1, apiOrderEdits.EditCommerceOrderV1>
>;
export type ExchangeCommerceOrderLinesV1Parity = Assert<
  Equal<
    ExchangeCommerceOrderLinesV1,
    apiOrderEdits.ExchangeCommerceOrderLinesV1
  >
>;
export type OpenCommerceBuyerOrderBalanceV1Parity = Assert<
  Equal<
    OpenCommerceBuyerOrderBalanceV1,
    apiOrderEdits.OpenCommerceBuyerOrderBalanceV1
  >
>;
export type RecordCommerceOrderManualPaymentV1Parity = Assert<
  Equal<
    RecordCommerceOrderManualPaymentV1,
    apiOrderEdits.RecordCommerceOrderManualPaymentV1
  >
>;
export type CommerceOrderBalanceCheckoutV1Parity = Assert<
  Equal<
    CommerceOrderBalanceCheckoutV1,
    apiOrderEdits.CommerceOrderBalanceCheckoutV1
  >
>;
export type CommerceOrderBalanceV1Parity = Assert<
  Equal<CommerceOrderBalanceV1, apiOrderEdits.CommerceOrderBalanceV1>
>;
export type CommerceOrderChangeLineV1Parity = Assert<
  Equal<CommerceOrderChangeLineV1, apiOrderEdits.CommerceOrderChangeLineV1>
>;
export type CommerceOrderEditV1Parity = Assert<
  Equal<CommerceOrderEditV1, apiOrderEdits.CommerceOrderEditV1>
>;
export type CommerceOrderExchangeV1Parity = Assert<
  Equal<CommerceOrderExchangeV1, apiOrderEdits.CommerceOrderExchangeV1>
>;
export type CommerceOrderPaymentChangeV1Parity = Assert<
  Equal<
    CommerceOrderPaymentChangeV1,
    apiOrderEdits.CommerceOrderPaymentChangeV1
  >
>;
export type CommerceOrderChangeV1Parity = Assert<
  Equal<CommerceOrderChangeV1, apiOrderEdits.CommerceOrderChangeV1>
>;
export type CommerceOrderChangesV1Parity = Assert<
  Equal<CommerceOrderChangesV1, apiOrderEdits.CommerceOrderChangesV1>
>;
