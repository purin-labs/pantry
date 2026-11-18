import type { Sha256Digest } from "./Sha256Digest";

export type MailboxReplyScope =
  | { kind: "source_only" }
  | {
      kind: "case_context_collection_evidence";
      recipientDigest: Sha256Digest;
      dependencyDigest: Sha256Digest;
    };
