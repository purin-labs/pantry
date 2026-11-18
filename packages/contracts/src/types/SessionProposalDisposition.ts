import type { CaseProposalRejection } from "./CaseProposalRejection";
import type { CaseRevision } from "./CaseRevision";

export type SessionProposalDisposition =
  | { kind: "accepted"; revision: CaseRevision }
  | { kind: "rebase_required"; revision: CaseRevision }
  | { kind: "rejected"; reason: CaseProposalRejection };
