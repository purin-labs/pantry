// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiAfterSale from "@seams/commerce-contracts/records/api-after-sale";
import type {
  CancelCommerceOrderV1,
  RefundCommerceOrderTendersV1,
  RefundCommerceOrderV1,
  CommerceTenderRefundPartV1,
  CommerceTenderRefundV1,
} from "./after-sale.ts";
export type CancelCommerceOrderV1Parity = Assert<
  Equal<CancelCommerceOrderV1, apiAfterSale.CancelCommerceOrderV1>
>;
export type RefundCommerceOrderTendersV1Parity = Assert<
  Equal<
    RefundCommerceOrderTendersV1,
    apiAfterSale.RefundCommerceOrderTendersV1
  >
>;
export type RefundCommerceOrderV1Parity = Assert<
  Equal<RefundCommerceOrderV1, apiAfterSale.RefundCommerceOrderV1>
>;
export type CommerceTenderRefundPartV1Parity = Assert<
  Equal<CommerceTenderRefundPartV1, apiAfterSale.CommerceTenderRefundPartV1>
>;
export type CommerceTenderRefundV1Parity = Assert<
  Equal<CommerceTenderRefundV1, apiAfterSale.CommerceTenderRefundV1>
>;
