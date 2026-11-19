// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiCollections from "@purin-labs/commerce-contracts/records/api-collections";
import type {
  CommerceCollectionSortOrder,
  CommerceCollectionConditionV1,
  CommerceCollectionRuleV1,
  CommerceCollectionSelectionV1,
  CreateCommerceCollectionV1,
  DeleteCommerceCollectionV1,
  CommerceBuyerCollectionSummaryV1,
  CommerceBuyerCollectionProductV1,
  CommerceBuyerCollectionPageV1,
  CommerceBuyerCollectionsV1,
  UpdateCommerceCollectionV1,
  CommerceCollectionCommandV1,
  CommerceCollectionPageFilterV1,
  CommerceCollectionV1,
} from "./collections.ts";
export type CommerceCollectionSortOrderParity = Assert<
  Equal<
    CommerceCollectionSortOrder,
    apiCollections.CommerceCollectionSortOrder
  >
>;
export type CommerceCollectionConditionV1Parity = Assert<
  Equal<
    CommerceCollectionConditionV1,
    apiCollections.CommerceCollectionConditionV1
  >
>;
export type CommerceCollectionRuleV1Parity = Assert<
  Equal<CommerceCollectionRuleV1, apiCollections.CommerceCollectionRuleV1>
>;
export type CommerceCollectionSelectionV1Parity = Assert<
  Equal<
    CommerceCollectionSelectionV1,
    apiCollections.CommerceCollectionSelectionV1
  >
>;
export type CreateCommerceCollectionV1Parity = Assert<
  Equal<
    CreateCommerceCollectionV1,
    apiCollections.CreateCommerceCollectionV1
  >
>;
export type DeleteCommerceCollectionV1Parity = Assert<
  Equal<
    DeleteCommerceCollectionV1,
    apiCollections.DeleteCommerceCollectionV1
  >
>;
export type CommerceBuyerCollectionSummaryV1Parity = Assert<
  Equal<
    CommerceBuyerCollectionSummaryV1,
    apiCollections.CommerceBuyerCollectionSummaryV1
  >
>;
export type CommerceBuyerCollectionProductV1Parity = Assert<
  Equal<
    CommerceBuyerCollectionProductV1,
    apiCollections.CommerceBuyerCollectionProductV1
  >
>;
export type CommerceBuyerCollectionPageV1Parity = Assert<
  Equal<
    CommerceBuyerCollectionPageV1,
    apiCollections.CommerceBuyerCollectionPageV1
  >
>;
export type CommerceBuyerCollectionsV1Parity = Assert<
  Equal<
    CommerceBuyerCollectionsV1,
    apiCollections.CommerceBuyerCollectionsV1
  >
>;
export type UpdateCommerceCollectionV1Parity = Assert<
  Equal<
    UpdateCommerceCollectionV1,
    apiCollections.UpdateCommerceCollectionV1
  >
>;
export type CommerceCollectionCommandV1Parity = Assert<
  Equal<
    CommerceCollectionCommandV1,
    apiCollections.CommerceCollectionCommandV1
  >
>;
export type CommerceCollectionPageFilterV1Parity = Assert<
  Equal<
    CommerceCollectionPageFilterV1,
    apiCollections.CommerceCollectionPageFilterV1
  >
>;
export type CommerceCollectionV1Parity = Assert<
  Equal<CommerceCollectionV1, apiCollections.CommerceCollectionV1>
>;
