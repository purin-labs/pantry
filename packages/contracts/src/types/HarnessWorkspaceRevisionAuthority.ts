import type { Sha256Digest } from "./Sha256Digest";
import type { WorkspaceRevision } from "./WorkspaceRevision";
import type { WorkspaceRevisionReceiptId } from "./WorkspaceRevisionReceiptId";

export type HarnessWorkspaceRevisionAuthority = {
  kind: "workspace_revision";
  receiptId: WorkspaceRevisionReceiptId;
  revision: WorkspaceRevision;
  resultDigest: Sha256Digest;
};
