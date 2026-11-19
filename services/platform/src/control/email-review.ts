import type { EmailReviewProjection } from "../data/email-review";
import { assertNever } from "@purin-labs/std";
import {
  emailReplyHeadlineWire,
  type EmailReplyHeadline,
} from "@purin-labs/control-api";
export function emailReviewQueueWire(
  review: EmailReviewProjection,
): Record<string, unknown> {
  const common = {
    kind: review.kind,
    proposal_id: review.proposalId,
    integration_account_id: review.integrationAccountId,
    case_id: review.caseId,
    version: review.version,
    lifecycle_kind: review.lifecycleKind,
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  };
  switch (review.backing.kind) {
    case "gmail_draft":
      return {
        ...common,
        backing: {
          kind: review.backing.kind,
          gmail_thread_id: review.backing.gmailThreadId,
        },
      };
    case "encrypted_connector":
      return {
        ...common,
        backing: {
          kind: review.backing.kind,
          target: review.backing.target,
          snapshot_digest: review.backing.snapshotDigest,
          indeterminate_rfc_message_id:
            review.backing.indeterminateRfcMessageId,
        },
      };
    default:
      return assertNever(review.backing);
  }
}

/**
 * An item of the review queue. A reply carries the headline of the mail that
 * it answers, or null when the queue names none for it.
 */
export function emailReviewQueueItemWire(
  headlines: ReadonlyMap<string, EmailReplyHeadline>,
  review: EmailReviewProjection,
): Record<string, unknown> {
  const wire = emailReviewQueueWire(review);
  if (review.kind !== "gmail_reply") return wire;
  const headline = headlines.get(review.proposalId);
  return {
    ...wire,
    headline: headline === undefined ? null : emailReplyHeadlineWire(headline),
  };
}
