import type { ApprovalV1 } from "./ApprovalV1";
import type { CatalogPayloadV1 } from "./CatalogPayloadV1";
import type { CatalogRevision } from "./CatalogRevision";
import type { CommerceTimestamp } from "@seams/commerce-contracts";
import type { ManifestSignerV1 } from "./ManifestSignerV1";
import type { MerchantId } from "./MerchantId";
import type { OrganisationId } from "@seams/commerce-contracts";
import type { ReleaseId } from "./ReleaseId";
import type { Sha256Digest } from "./Sha256Digest";

export type CatalogActivationManifestV1 = {
  schemaVersion: string;
  organisationId: OrganisationId;
  merchantId: MerchantId;
  releaseId: ReleaseId;
  releaseHash: Sha256Digest;
  baseCatalogRevision: CatalogRevision;
  createdAt: CommerceTimestamp;
  catalog: CatalogPayloadV1;
  approval: ApprovalV1;
  signer: ManifestSignerV1;
};
