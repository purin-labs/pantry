import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationQuerySource } from "../../data/query-source";
import type { ModelRoute } from "@purin-labs/contracts";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { isNonBlankString, isNonNegativeInteger } from "@purin-labs/std";
import {
  findGmailModelReview,
  type GmailModelReview,
} from "./gmail-model-reviews";

type GmailInferenceEligibility =
  | { readonly kind: "blocked" }
  | {
      readonly kind: "eligible";
      readonly evidenceReference: string;
      readonly reviewExpiresAt: number;
    };

/**
 * Recheck the exact pinned model at dispatch. Mail goes to the model only
 * while Purin's review of the route stands (`gmail-model-reviews.ts`) and
 * an owner or admin accepted that review's terms: a new provider or model,
 * new terms, an ended review or a withdrawn acceptance blocks it.
 */
export async function readGmailInferenceEligibility(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly modelRoute: ModelRoute;
  readonly now: number;
}): Promise<GmailInferenceEligibility> {
  const review = findGmailModelReview(input.modelRoute, input.now);
  if (review === null) return { kind: "blocked" };
  const row = await input.db
    .prepare(
      `SELECT evidence_reference, evidence_owner, disclosed_recipients,
      permitted_purpose, consent_reference, reviewed_at, review_expires_at,
      consented_at, revoked_at
     FROM gmail_inference_eligibility
     WHERE organisation_id = ? AND key_source = ? AND provider = ? AND model = ?`,
    )
    .bind(
      input.organisationId,
      input.modelRoute.keySource,
      input.modelRoute.provider,
      input.modelRoute.model,
    )
    .first<Record<string, unknown>>();
  if (
    row === null ||
    row.revoked_at !== null ||
    row.evidence_reference !== review.evidenceReference ||
    !isNonBlankString(row.evidence_reference) ||
    !isNonBlankString(row.evidence_owner) ||
    !isNonBlankString(row.disclosed_recipients) ||
    !isNonBlankString(row.permitted_purpose) ||
    !isNonBlankString(row.consent_reference) ||
    !isNonNegativeInteger(row.reviewed_at) ||
    !isNonNegativeInteger(row.review_expires_at) ||
    !isNonNegativeInteger(row.consented_at) ||
    row.reviewed_at > input.now ||
    row.consented_at > input.now ||
    row.review_expires_at <= input.now ||
    row.review_expires_at <= row.reviewed_at
  ) {
    return { kind: "blocked" };
  }
  return {
    kind: "eligible",
    evidenceReference: row.evidence_reference,
    reviewExpiresAt: row.review_expires_at,
  };
}

/**
 * The acceptance of one review, written in the batch of the mutation's
 * receipt and after it: it is written only when the receipt is.
 * `consentReference` is that receipt, and `consentedBy` the person who
 * accepted. A new acceptance of the same route replaces the earlier one and
 * ends its withdrawal.
 */
export function prepareGmailModelConsentAfterReceipt(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    review: GmailModelReview;
    consentReference: string;
    consentedBy: UserId;
    now: number;
  }>,
): D1PreparedStatement {
  const { review } = input;
  return db
    .prepare(
      `INSERT INTO gmail_inference_eligibility (
         organisation_id, key_source, provider, model, evidence_reference,
         evidence_owner, disclosed_recipients, permitted_purpose,
         consent_reference, reviewed_at, review_expires_at, consented_at,
         consented_by_user_id, revoked_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE changes() = 1
       ON CONFLICT (organisation_id, key_source, provider, model) DO UPDATE SET
         evidence_reference = excluded.evidence_reference,
         evidence_owner = excluded.evidence_owner,
         disclosed_recipients = excluded.disclosed_recipients,
         permitted_purpose = excluded.permitted_purpose,
         consent_reference = excluded.consent_reference,
         reviewed_at = excluded.reviewed_at,
         review_expires_at = excluded.review_expires_at,
         consented_at = excluded.consented_at,
         consented_by_user_id = excluded.consented_by_user_id,
         revoked_at = NULL`,
    )
    .bind(
      input.organisationId,
      review.route.keySource,
      review.route.provider,
      review.route.model,
      review.evidenceReference,
      review.evidenceOwner,
      review.disclosedRecipients,
      review.permittedPurpose,
      input.consentReference,
      review.reviewedAt,
      review.reviewExpiresAt,
      input.now,
      input.consentedBy,
    );
}

/**
 * Withdraws each acceptance of the Organisation once none of its mailboxes
 * is on: the next Turn on asks again. While another mailbox stays on, its
 * acceptance stands. A run that finds nothing to withdraw writes nothing.
 */
export async function withdrawGmailModelConsentsWhenNoMailboxIsOn(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<void> {
  await input.db
    .prepare(
      `UPDATE gmail_inference_eligibility
       SET revoked_at = MAX(?, reviewed_at)
       WHERE organisation_id = ? AND revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_ingress_policy AS policy
           JOIN mailbox_ingress_policy_revision AS revision
             ON revision.integration_account_id = policy.integration_account_id
             AND revision.policy_version = policy.current_version
           WHERE policy.organisation_id = ? AND revision.kind = 'enabled'
         )`,
    )
    .bind(input.now, input.organisationId, input.organisationId)
    .run();
}
