import type { CaseJournalSequence } from "./CaseJournalSequence";
import type { Sha256Digest } from "./Sha256Digest";

export type CaseJournalCursor =
  | { kind: "before_first" }
  | {
      kind: "accepted";
      sequence: CaseJournalSequence;
      entryDigest: Sha256Digest;
    };
