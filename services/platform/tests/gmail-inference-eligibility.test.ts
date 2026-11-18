import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readGmailInferenceEligibility } from "../src/data/gmail-inference-eligibility";
import { parseOrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";

it("requires current evidence and consent for the exact organisation, funding route, provider and model", async function checksEligibility() {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(singleDatabaseSchema());
    sqlite.exec(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES ('organisation_eligibility', 'eligibility', 'Eligibility', 1)",
    );
    const organisation = parseOrganisationId("organisation_eligibility");
    if (!organisation.ok) throw new Error("Invalid fixture organisation");
    const input = {
      db: d1Database(sqlite),
      organisationId: organisation.value,
      modelRoute: {
        keySource: "platform" as const,
        provider: "openai-compatible" as const,
        model: "reviewed-model",
      },
      now: 20,
    };
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "blocked",
    });
    sqlite.exec(`INSERT INTO gmail_inference_eligibility VALUES (
      'organisation_eligibility', 'platform', 'openai-compatible', 'reviewed-model',
      'review-1', 'reviewer-1', 'provider and downstream recipient', 'email triage',
      'consent-1', 10, 30, 15, NULL
    )`);
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "eligible",
      evidenceReference: "review-1",
      reviewExpiresAt: 30,
    });
    expect(await readGmailInferenceEligibility({ ...input, now: 30 })).toEqual({
      kind: "blocked",
    });
    expect(
      await readGmailInferenceEligibility({
        ...input,
        modelRoute: {
          keySource: "platform",
          provider: "openai-compatible",
          model: "unreviewed-model",
        },
      }),
    ).toEqual({ kind: "blocked" });
    sqlite.exec("UPDATE gmail_inference_eligibility SET revoked_at = 20");
    expect(await readGmailInferenceEligibility(input)).toEqual({
      kind: "blocked",
    });
  } finally {
    sqlite.close();
  }
});
