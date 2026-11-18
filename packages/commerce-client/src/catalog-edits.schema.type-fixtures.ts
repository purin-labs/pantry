// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiCatalogEdits from "@seams/commerce-contracts/records/api-catalog-edits";
import type {
  CommerceOfferChangesV1,
  CommerceProductChangesV1,
  CommerceVariantChangesV1,
  UpdateCommerceOfferV1,
  UpdateCommerceProductV1,
  UpdateCommerceVariantV1,
} from "./catalog-edits.ts";
export type CommerceOfferChangesV1Parity = Assert<
  Equal<CommerceOfferChangesV1, apiCatalogEdits.CommerceOfferChangesV1>
>;
export type CommerceProductChangesV1Parity = Assert<
  Equal<CommerceProductChangesV1, apiCatalogEdits.CommerceProductChangesV1>
>;
export type CommerceVariantChangesV1Parity = Assert<
  Equal<CommerceVariantChangesV1, apiCatalogEdits.CommerceVariantChangesV1>
>;
export type UpdateCommerceOfferV1Parity = Assert<
  Equal<UpdateCommerceOfferV1, apiCatalogEdits.UpdateCommerceOfferV1>
>;
export type UpdateCommerceProductV1Parity = Assert<
  Equal<UpdateCommerceProductV1, apiCatalogEdits.UpdateCommerceProductV1>
>;
export type UpdateCommerceVariantV1Parity = Assert<
  Equal<UpdateCommerceVariantV1, apiCatalogEdits.UpdateCommerceVariantV1>
>;
