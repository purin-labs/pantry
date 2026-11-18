import type { CatalogMediaReferenceV1 } from "./CatalogMediaReferenceV1";
import type { CatalogOfferRefV1 } from "./CatalogOfferRefV1";
import type { ProductDocumentV1 } from "./ProductDocumentV1";
import type { Sha256Digest } from "./Sha256Digest";

export type CatalogPayloadV1 = {
  digest: Sha256Digest;
  products: Array<ProductDocumentV1>;
  offers: Array<CatalogOfferRefV1>;
  mediaReferences: Array<CatalogMediaReferenceV1>;
};
