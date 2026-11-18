import type { ResourceId } from "@seams/commerce-contracts";
import type { Sha256Digest } from "./Sha256Digest";

export type CatalogMediaReferenceV1 = {
  mediaId: ResourceId;
  digest: Sha256Digest;
};
