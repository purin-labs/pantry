import type { EffectReceiptId } from "./EffectReceiptId";
import type { Sha256Digest } from "./Sha256Digest";
import type { WorkspaceRevision } from "./WorkspaceRevision";
import type { WorkspaceRevisionReceiptId } from "./WorkspaceRevisionReceiptId";

export type HarnessToolAuthority =
  | { kind: "read"; resultDigest: Sha256Digest }
  | {
      kind: "provider_effect";
      receiptId: EffectReceiptId;
      resultDigest: Sha256Digest;
    }
  | {
      kind: "surface_effect";
      receiptId: EffectReceiptId;
      resultDigest: Sha256Digest;
    }
  | {
      kind: "code_execution";
      receiptId: EffectReceiptId;
      resultDigest: Sha256Digest;
    }
  | {
      kind: "workspace_revision";
      receiptId: WorkspaceRevisionReceiptId;
      revision: WorkspaceRevision;
      resultDigest: Sha256Digest;
    };
