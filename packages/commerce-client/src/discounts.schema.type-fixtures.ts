// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiDiscounts from "@purin-labs/commerce-contracts/records/api-discounts";
import type {
  CommerceDiscountMethodV1,
  CommerceDiscountValueV1,
  CommerceDiscountRuleV1,
  CommerceDiscountConditionsV1,
  CreateCommerceDiscountV1,
  DeactivateCommerceDiscountV1,
  CommerceDiscountCommandV1,
  CommerceDiscountV1,
} from "./discounts.ts";
export type CommerceDiscountMethodV1Parity = Assert<
  Equal<CommerceDiscountMethodV1, apiDiscounts.CommerceDiscountMethodV1>
>;
export type CommerceDiscountValueV1Parity = Assert<
  Equal<CommerceDiscountValueV1, apiDiscounts.CommerceDiscountValueV1>
>;
export type CommerceDiscountRuleV1Parity = Assert<
  Equal<CommerceDiscountRuleV1, apiDiscounts.CommerceDiscountRuleV1>
>;
export type CommerceDiscountConditionsV1Parity = Assert<
  Equal<
    CommerceDiscountConditionsV1,
    apiDiscounts.CommerceDiscountConditionsV1
  >
>;
export type CreateCommerceDiscountV1Parity = Assert<
  Equal<CreateCommerceDiscountV1, apiDiscounts.CreateCommerceDiscountV1>
>;
export type DeactivateCommerceDiscountV1Parity = Assert<
  Equal<
    DeactivateCommerceDiscountV1,
    apiDiscounts.DeactivateCommerceDiscountV1
  >
>;
export type CommerceDiscountCommandV1Parity = Assert<
  Equal<CommerceDiscountCommandV1, apiDiscounts.CommerceDiscountCommandV1>
>;
export type CommerceDiscountV1Parity = Assert<
  Equal<CommerceDiscountV1, apiDiscounts.CommerceDiscountV1>
>;
