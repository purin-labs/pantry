// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiStoredValue from "@purin-labs/commerce-contracts/records/api-stored-value";
import type {
  CreditCommerceStoreCreditV1,
  DisableCommerceStoredValueAccountV1,
  IssueCommerceGiftCardV1,
  CommerceGiftCardBalanceV1,
  CommerceStoredValueKindV1,
  CommerceStoredValueAccountV1,
  CommerceStoredValueCommandV1,
  CommerceStoredValueLiabilityV1,
} from "./stored-value.ts";
export type CreditCommerceStoreCreditV1Parity = Assert<
  Equal<
    CreditCommerceStoreCreditV1,
    apiStoredValue.CreditCommerceStoreCreditV1
  >
>;
export type DisableCommerceStoredValueAccountV1Parity = Assert<
  Equal<
    DisableCommerceStoredValueAccountV1,
    apiStoredValue.DisableCommerceStoredValueAccountV1
  >
>;
export type IssueCommerceGiftCardV1Parity = Assert<
  Equal<IssueCommerceGiftCardV1, apiStoredValue.IssueCommerceGiftCardV1>
>;
export type CommerceGiftCardBalanceV1Parity = Assert<
  Equal<CommerceGiftCardBalanceV1, apiStoredValue.CommerceGiftCardBalanceV1>
>;
export type CommerceStoredValueKindV1Parity = Assert<
  Equal<CommerceStoredValueKindV1, apiStoredValue.CommerceStoredValueKindV1>
>;
export type CommerceStoredValueAccountV1Parity = Assert<
  Equal<
    CommerceStoredValueAccountV1,
    apiStoredValue.CommerceStoredValueAccountV1
  >
>;
export type CommerceStoredValueCommandV1Parity = Assert<
  Equal<
    CommerceStoredValueCommandV1,
    apiStoredValue.CommerceStoredValueCommandV1
  >
>;
export type CommerceStoredValueLiabilityV1Parity = Assert<
  Equal<
    CommerceStoredValueLiabilityV1,
    apiStoredValue.CommerceStoredValueLiabilityV1
  >
>;
