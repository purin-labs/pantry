import type { CaseContextEntryRef } from "./CaseContextEntryRef";
import type { CaseEvidenceDependency } from "./CaseEvidenceDependency";
import type { CaseId } from "./CaseId";
import type { CaseJournalCursor } from "./CaseJournalCursor";
import type { CaseRevision } from "./CaseRevision";
import type { WorkspaceRevision } from "./WorkspaceRevision";

export type CaseContextSnapshot = {
  caseId: CaseId;
  revision: CaseRevision;
  journalCursor: CaseJournalCursor;
  workspaceRevision: WorkspaceRevision;
  entries: Array<CaseContextEntryRef>;
  evidenceDependency: CaseEvidenceDependency;
};
