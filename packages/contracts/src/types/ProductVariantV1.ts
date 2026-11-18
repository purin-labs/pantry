import type { Money } from "@seams/commerce-contracts";
import type { ResourceId } from "@seams/commerce-contracts";

export type ProductVariantV1 = {
  variantId: ResourceId;
  sku: string;
  title: string;
  price: Money;
};
