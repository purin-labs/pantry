import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readGmailInferenceEligibility } from "../src/mail-inbox/contract/gmail-inference-eligibility";
import { GMAIL_MODEL_REVIEWS } from "../src/mail-inbox/contract/gmail-model-reviews";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";

it("sends mail only to a reviewed route whose terms the Organisation accepted, until the review ends", async function checksEligibility() {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(singleDatabaseSchema());
    sqlite.exec(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES ('organisation_eligibility', 'eligibility', 'Eligibility', 1)",
    );
    const organisation = parseOrganisationId("organisation_eligibility");
    if (!organisation.ok) throw new Error("Invalid fixture organisation");
    const [review] = GMAIL_MODEL_REVIEWS;
    if (review === undefined) throw new Error("No reviewed route");
    const now = review.reviewedAt + 86_400_000;
    const input = {
      db: d1Database(sqlite),
      organisationId: organisation.value,
      modelRoute: review.route,
      now,
    };
    const accept = (model: string, evidence: string) =>
      sqlite
        .prepare(
          `INSERT INTO gmail_inference_eligibility (organisation_id, key_source,
             provider, model, evidence_reference, evidence_owner,
             disclosed_recipients, permitted_purpose, consent_reference,
             reviewed_at, review_expires_at, consented_at, consented_by_user_id,
             revoked_at)
           VALUES ('organisation_eligibility', 'platform', 'openai-compatible',
             ?, ?, 'Purin', 'OpenRouter', 'email_processing', 'receipt_1', ?, ?,
             ?, 'user_owner', NULL)
           ON CONFLICT DO UPDATE SET evidence_reference = excluded.evidence_reference`,
        )
        .run(
          model,
          evidence,
          review.reviewedAt,
          review.reviewExpiresAt,
          now - 1,
        );
    // No acceptance.
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "blocked",
    });
    accept(review.route.model, review.evidenceReference);
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "eligible",
      evidenceReference: review.evidenceReference,
      reviewExpiresAt: review.reviewExpiresAt,
    });
    // The review ended.
    expect(
      await readGmailInferenceEligibility({
        ...input,
        now: review.reviewExpiresAt,
      }),
    ).toEqual({ kind: "blocked" });
    // An acceptance of a route that Purin did not review.
    accept("qwen/qwen3.7-flash", review.evidenceReference);
    expect(
      await readGmailInferenceEligibility({
        ...input,
        modelRoute: { ...review.route, model: "qwen/qwen3.7-flash" },
      }),
    ).toEqual({ kind: "blocked" });
    // The person accepted other terms than the review names now.
    accept(review.route.model, "https://example.test/older-terms");
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "blocked",
    });
    accept(review.route.model, review.evidenceReference);
    // The acceptance was withdrawn.
    sqlite.exec(`UPDATE gmail_inference_eligibility SET revoked_at = ${now}`);
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "blocked",
    });
  } finally {
    sqlite.close();
  }
});
