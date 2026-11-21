import type { SingleDatabase } from "../src/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  parseOrganisationInferenceSelection,
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../src/data/organisation-inference-selection";
import { parseSessionModelRoute } from "../src/policy-snapshot";
import {
  digestModelRoute,
  resolvePantryPlatformModelRoute,
} from "../src/models/route";
import { d1Database } from "./sqlite-d1";
import { readMigration } from "./sqlite-d1";
import { requireUserId, requireOrganisationId } from "./test-ids";

describe("organisation inference selection", () => {
  it("defaults to Codex and persists a versioned Pantry selection", async () => {
    const fixture = createFixture();
    await expect(
      readOrganisationInferenceSelection({
        db: fixture.db,
        organisationId: fixture.organisationId,
      }),
    ).resolves.toEqual({
      organisationId: fixture.organisationId,
      selection: { kind: "codex_subscription" },
      configurationVersion: 1,
      slackReasoningEffort: null,
    });

    const selected = await selectOrganisationInferenceSelection({
      db: fixture.db,
      organisationId: fixture.organisationId,
      selection: { kind: "pantry_platform" },
      expectedConfigurationVersion: 1,
      selectedByUserId: fixture.userId,
      now: 2,
    });
    expect(selected).toEqual({
      ok: true,
      value: {
        organisationId: fixture.organisationId,
        selection: { kind: "pantry_platform" },
        configurationVersion: 2,
      },
    });
    await expect(
      readOrganisationInferenceSelection({
        db: fixture.db,
        organisationId: fixture.organisationId,
      }),
    ).resolves.toMatchObject({
      selection: { kind: "pantry_platform" },
      configurationVersion: 2,
    });

    const organisationOpenAi = await selectOrganisationInferenceSelection({
      db: fixture.db,
      organisationId: fixture.organisationId,
      selection: { kind: "organisation_openai_api_key" },
      expectedConfigurationVersion: 2,
      selectedByUserId: fixture.userId,
      now: 3,
    });
    expect(organisationOpenAi).toMatchObject({
      ok: true,
      value: {
        selection: { kind: "organisation_openai_api_key" },
        configurationVersion: 3,
      },
    });
  });

  it("accepts the organisation OpenAI key source and rejects unknown selections", () => {
    expect(
      parseOrganisationInferenceSelection({ kind: "organisation_openai_api_key" }),
    ).toEqual({
      ok: true,
      value: { kind: "organisation_openai_api_key" },
    });
    expect(
      parseOrganisationInferenceSelection({ kind: "organisation_anthropic_api_key" }),
    ).toEqual({
      ok: true,
      value: { kind: "organisation_anthropic_api_key" },
    });
    expect(parseOrganisationInferenceSelection({ kind: "organisation_byo" })).toEqual({
      ok: false,
      error: { code: "inference_selection_invalid" },
    });
    expect(
      parseOrganisationInferenceSelection({ kind: "pantry_platform", extra: true }),
    ).toEqual({
      ok: false,
      error: { code: "inference_selection_invalid" },
    });
  });

  it("refuses the Pantry selection without the OpenRouter credential", () => {
    expect(resolvePantryPlatformModelRoute({})).toEqual({
      ok: false,
      error: { code: "pantry_platform_credential_unavailable" },
    });
  });

  it("rejects unknown ModelRoute fields", () => {
    expect(
      parseSessionModelRoute({
        keySource: "platform",
        provider: "openai-compatible",
        model: "moonshotai/kimi-k3",
        options: null,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "invalid session modelRoute",
      },
    });
  });

  it("rejects ModelRoute provider pairs outside the executable authorities", () => {
    expect(
      parseSessionModelRoute({
        keySource: "platform",
        provider: "openai",
        model: "gpt-5.6-luna",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "invalid session modelRoute",
      },
    });
    expect(
      parseSessionModelRoute({
        keySource: "organisation_byo",
        provider: "openai-compatible",
        model: "moonshotai/kimi-k3",
        byoKeyRef: "vault:organisation:model:openai:g1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "invalid session modelRoute",
      },
    });
    expect(
      parseSessionModelRoute({
        keySource: "organisation_subscription",
        provider: "anthropic",
        model: "claude-sonnet",
        connectionRevision: 3,
        authProfileGeneration: 7,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "invalid session modelRoute",
      },
    });
  });

  it("matches the canonical route digests without legacy options", async () => {
    await expect(
      digestModelRoute({
        keySource: "platform",
        provider: "openai-compatible",
        model: "moonshotai/kimi-k3",
      }),
    ).resolves.toBe(
      "b1cb2ef60df8212bf12e482db1f74ce7c921ba34585a1cb56de4cfde3d0b47cc",
    );
    await expect(
      digestModelRoute({
        keySource: "organisation_byo",
        provider: "openai",
        model: "gpt-5.6-luna",
        byoKeyRef: "vault:organisation:model:openai:g1",
      }),
    ).resolves.toBe(
      "cf1a708167faf396fd99fd5c7431fa7d2bd4ac0ffee2aecee33d76d49fa8bd55",
    );
    await expect(
      digestModelRoute({
        keySource: "organisation_subscription",
        provider: "openai",
        model: "gpt-5.6-luna",
        connectionRevision: 3,
        authProfileGeneration: 7,
      }),
    ).resolves.toBe(
      "66bb0ac378743cb48918609404d5fab5a7e5c54ebb00d4f8bc3df931c590ea94",
    );
  });
});

function createFixture(): {
  readonly db: SingleDatabase;
  readonly organisationId: ReturnType<typeof requireOrganisationId>;
  readonly userId: ReturnType<typeof requireUserId>;
} {
  const database = new DatabaseSync(":memory:");
  database.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requireOrganisationId("organisation_inference_selection");
  const userId = requireUserId(
    "user_0364b27d-7fe1-5669-8708-799b493b062b",
  );
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Inference Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES (?, 'https://accounts.google.com', ?, ?, 'Inference Owner', 1, 1, 1)`,
    )
    .run(
      userId,
      userId,
      `${userId}@example.com`,
    );
  database
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, updated_at
     ) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
    )
    .run(organisationId);
  return {
    db: d1Database(database),
    organisationId,
    userId,
  };
}
