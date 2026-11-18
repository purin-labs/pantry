import type { OrganisationId } from "@seams/commerce-contracts";
import type { ProductFolderDiffV1 } from "./ProductFolderDiffV1";
import type { Sha256Digest } from "./Sha256Digest";
import type { WorkspaceId } from "./WorkspaceId";
import type { WorkspaceRevision } from "./WorkspaceRevision";

export type ValidatedProductFolderChangesetV1 = {
  schemaVersion: string;
  organisationId: OrganisationId;
  workspaceId: WorkspaceId;
  baseRevision: WorkspaceRevision;
  resultingSemanticHash: Sha256Digest;
  diff: ProductFolderDiffV1;
  changesetDigest: Sha256Digest;
};
