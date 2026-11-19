import type { SingleDatabase } from "../src/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  parseAnthropicApiKey,
  resolveCurrentOrganisationAnthropicModelCredential,
  resolveOrganisationAnthropicModelCredentialForRoute,
  storeOrganisationAnthropicModelCredential,
} from "../src/credential-vault";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId } from "./test-ids";
import { readMigration } from "./sqlite-d1";
import { testRoot } from "./secrets-store";
describe("organisation Anthropic model credentials", () => {
  it("stores and resolves the current Claude key while fencing the old route", async () => {
    const fixture = createFixture();
    const firstKey = requiredApiKey("sk-ant-api03-first-organisation-key-1234567890");
    const first = await storeOrganisationAnthropicModelCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      apiKey: firstKey,
      now: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await expect(
      resolveCurrentOrganisationAnthropicModelCredential({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.organisationId,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { provider: "anthropic", handle: first.value, apiKey: firstKey },
    });

    const secondKey = requiredApiKey("sk-ant-api03-second-organisation-key-0987654321");
    const second = await storeOrganisationAnthropicModelCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      apiKey: secondKey,
      now: 3,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).not.toBe(first.value);

    await expect(
      resolveOrganisationAnthropicModelCredentialForRoute({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.organisationId,
        route: anthropicRoute(first.value),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "organisation_anthropic_credential_scope_mismatch" },
    });
    await expect(
      resolveOrganisationAnthropicModelCredentialForRoute({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.organisationId,
        route: anthropicRoute(second.value),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { provider: "anthropic", handle: second.value, apiKey: secondKey },
    });

    const row = fixture.sqlite
      .prepare(
        `SELECT provider, host_pattern AS hostPattern, inject_as AS injectAs,
                revoked_at AS revokedAt
         FROM credential_ref
         WHERE organisation_id = ? AND name = 'model'`,
      )
      .get(fixture.organisationId) as {
      readonly provider: string;
      readonly hostPattern: string;
      readonly injectAs: string;
      readonly revokedAt: number | null;
    };
    expect(row.provider).toBe("anthropic");
    expect(row.hostPattern).toBe("api.anthropic.com");
    expect(row.injectAs).toContain("x-api-key");
    expect(row.revokedAt).toBeNull();
  });

  it("uses an Anthropic-specific parser and rejects OpenAI-shaped keys", () => {
    expect(parseAnthropicApiKey("sk-project-openai-key-1234567890")).toEqual({
      ok: false,
      error: { code: "organisation_anthropic_credential_invalid" },
    });
    expect(parseAnthropicApiKey("sk-ant-api03-valid-key-1234567890").ok).toBe(
      true,
    );
  });
});

function anthropicRoute(handle: string) {
  return {
    keySource: "organisation_byo" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    byoKeyRef: handle,
  };
}

function createFixture(): {
  readonly db: SingleDatabase;
  readonly sqlite: DatabaseSync;
  readonly organisationId: ReturnType<typeof requireOrganisationId>;
  readonly keys: CredentialVaultBindings;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requireOrganisationId("organisation_anthropic_model");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Anthropic Model Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  return {
    db: d1Database(sqlite),
    sqlite,
    organisationId,
    keys: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRoot(29),
    },
  };
}

function requiredApiKey(raw: string) {
  const parsed = parseAnthropicApiKey(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
