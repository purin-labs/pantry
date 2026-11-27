import type { PendingEmailReview } from "@purin-labs/control-api";
import type { OrganisationReader } from "@purin-labs/control/worker/authorization";
import { listEmailReviewProjections } from "../data/email-review";

/** The most email proposals that one read looks at. */
const EMAIL_REVIEW_READ_LIMIT = 100;

/**
 * The email proposals that wait for an approval: the reader of the email
 * reviews for `listPendingDecisions`. The mailbox page reads the same
 * projection rows.
 */
export async function pendingEmailReviews(
  authorized: OrganisationReader,
): Promise<readonly PendingEmailReview[]> {
  const reviews = await listEmailReviewProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: EMAIL_REVIEW_READ_LIMIT,
  });
  const waiting: PendingEmailReview[] = [];
  for (const review of reviews) {
    if (review.lifecycleKind !== "awaiting_approval") continue;
    waiting.push({
      kind: "email_review",
      id: review.proposalId,
      message: review.kind,
      integrationAccountId: review.integrationAccountId,
      caseId: review.caseId,
      version: review.version,
      createdAt: review.createdAt,
    });
  }
  return waiting;
}
