import type { ProductFieldV1 } from "./ProductFieldV1";
import type { ResourceId } from "@seams/commerce-contracts";

export type ProductFolderDiffV1 = {
  productId: ResourceId;
  fields: Array<ProductFieldV1>;
  variantIds: Array<ResourceId>;
};
