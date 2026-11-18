import type { CurrencyCode } from "@seams/commerce-contracts";
import type { ProductVariantV1 } from "./ProductVariantV1";
import type { ResourceId } from "@seams/commerce-contracts";

export type ProductDocumentV1 = {
  productId: ResourceId;
  slug: string;
  title: string;
  description: string;
  currency: CurrencyCode;
  variants: Array<ProductVariantV1>;
};
