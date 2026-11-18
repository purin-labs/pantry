import type { ActorRefV1 } from "./ActorRefV1";
import type { CatalogActivationManifestV1 } from "./CatalogActivationManifestV1";
import type { CommerceTimestamp } from "@seams/commerce-contracts";
import type { IdempotencyKey } from "./IdempotencyKey";

export type ActivateCatalogReleaseV1 = {
  manifest: CatalogActivationManifestV1;
  idempotencyKey: IdempotencyKey;
  requestedBy: ActorRefV1;
  requestedAt: CommerceTimestamp;
};
