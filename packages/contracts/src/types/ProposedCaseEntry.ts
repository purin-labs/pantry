import type { CaseContent } from "./CaseContent";
import type { CaseEntryId } from "./CaseEntryId";
import type { CaseRevision } from "./CaseRevision";

export type ProposedCaseEntry =
  | { kind: "observation"; entryId: CaseEntryId; content: CaseContent }
  | {
      kind: "shared_change";
      entryId: CaseEntryId;
      baseRevision: CaseRevision;
      content: CaseContent;
    };
