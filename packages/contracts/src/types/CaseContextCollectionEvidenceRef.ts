import type { CaseId } from "./CaseId";

export type CaseContextCollectionEvidenceRef = {
  caseId: CaseId;
  integrationAccountId: string;
  reference: string;
  sourceRevision: number;
  verificationId: string;
  verificationRevision: number;
  relationshipId: string | null;
  acceptedAtRevision: number;
};
