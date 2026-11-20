import type { OrganisationDatabase } from "../../database-handles";
import type { ModelRoute } from "@purin-labs/contracts";
import type { OrganisationId } from "../../ids";
import { isNonBlankString, isNonNegativeInteger } from "@purin-labs/std";

type GmailInferenceEligibility =
  | { readonly kind: "blocked" }
  | {
      readonly kind: "eligible";
      readonly evidenceReference: string;
      readonly reviewExpiresAt: number;
    };

/** Recheck the exact pinned model at dispatch; changing provider or model needs fresh evidence. */
export async function readGmailInferenceEligibility(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly modelRoute: ModelRoute;
  readonly now: number;
}): Promise<GmailInferenceEligibility> {
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
