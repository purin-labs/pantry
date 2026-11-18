import type { Variant } from "@seams/type-utils";
import { readSessionTurnMemoryRecords } from "./actor-journal/transactions";
import type { SessionTurnContextLookup } from "./actor-journal";
import type { EmailCueOutcome } from "./email-harness-tools";
import {
  replySourceReference,
  verifyReplySources,
  type EmailReplySourceRecord,
  type EmailReplySources,
} from "../mail-inbox/reply-sources";

/**
 * The sources of a mailbox turn's draft. A citation names a record the
 * Session holds a record of reading in this attempt: a commerce record one
 * of the turn's tools read, or a Memory revision that the attempt's recorded
 * context shows the model was given. Any other citation is dropped, and so
 * is one whose words are not in the body.
 */
export async function verifyTransientReplySources(
  sql: SqlStorage,
  input: Readonly<{
    lookup: SessionTurnContextLookup;
    bundleDigest: string;
    outcome: Variant<EmailCueOutcome, "approval_required">;
    commerceReads: ReadonlyMap<string, EmailReplySourceRecord>;
  }>,
): Promise<EmailReplySources> {
  const reads = new Map(input.commerceReads);
  const records = await readSessionTurnMemoryRecords(sql, input.lookup);
  const attempt = records.ok
    ? records.value.find((record) => record.bundleDigest === input.bundleDigest)
    : undefined;
  for (const shown of attempt?.rendering.revisions ?? []) {
    const record: EmailReplySourceRecord = {
      kind: "memory",
      memoryId: shown.memoryId,
      revision: shown.revision,
    };
    reads.set(replySourceReference(record), record);
  }
  return verifyReplySources({
    body: input.outcome.body,
    citations: input.outcome.citations,
    malformed: input.outcome.malformedCitations,
    reads,
  });
}
