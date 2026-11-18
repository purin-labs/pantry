import type { CaseContextCollectionEvidenceRef } from "./CaseContextCollectionEvidenceRef";
import type { Sha256Digest } from "./Sha256Digest";

export type CaseEvidenceDependency =
  | { kind: "source_only" }
  | {
      kind: "case_context_collection_evidence";
      caseContextCollectionId: string;
      caseContextCollectionRevision: number;
      policyRevision: number;
      recipientDigest: Sha256Digest;
      dependencyDigest: Sha256Digest;
      selections: Array<CaseContextCollectionEvidenceRef>;
    };
