import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  parseModelApiKey,
  resolveCurrentOrganisationModelCredential,
  resolveOrganisationModelCredentialForRoute,
  storeOrganisationModelCredential,
} from "@purin-labs/authority/credential-vault/index";
import type { CredentialVaultBindings } from "@purin-labs/authority/credential-vault/keyring";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId } from "./test-ids";
import { readMigration } from "./sqlite-d1";
import { testRoot } from "./secrets-store";
describe(
  "organisation OpenAI model credentials",
  organisationOpenAiModelCredentialSuite,
);

function organisationOpenAiModelCredentialSuite(): void {
  it(
    "stores an organisation key encrypted and fences a superseded route",
    storesAndRotatesKey,
  );
  it(
    "rejects malformed OpenAI keys at the request boundary",
    rejectsMalformedKey,
  );
}

async function storesAndRotatesKey(): Promise<void> {
  const fixture = createFixture();
  const firstKey = requiredApiKey(
    "sk-project-first-organisation-key-1234567890",
  );
  const first = await storeOrganisationModelCredential({
    provider: "openai",
    db: fixture.db,
    keys: fixture.keys,
    organisationId: fixture.organisationId,
    apiKey: firstKey,
    now: 2,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  await expect(
    resolveCurrentOrganisationModelCredential({
      provider: "openai",
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { provider: "openai", handle: first.value, apiKey: firstKey },
  });

  const secondKey = requiredApiKey(
    "sk-project-second-organisation-key-0987654321",
  );
  const second = await storeOrganisationModelCredential({
    provider: "openai",
    db: fixture.db,
    keys: fixture.keys,
    organisationId: fixture.organisationId,
    apiKey: secondKey,
    now: 3,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value).not.toBe(first.value);
  expect(
    fixture.sqlite
      .prepare(
        `SELECT revoked_at AS revokedAt
     FROM vault_secret
     WHERE organisation_id = ? AND vault_handle = ?`,
      )
      .get(fixture.organisationId, first.value),
  ).toEqual({ revokedAt: 3 });

  await expect(
    resolveOrganisationModelCredentialForRoute({
      provider: "openai",
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      route: organisationOpenAiRoute(first.value),
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "organisation_openai_credential_scope_mismatch" },
  });
  await expect(
    resolveOrganisationModelCredentialForRoute({
      provider: "openai",
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      route: organisationOpenAiRoute(second.value),
    }),
  ).resolves.toEqual({
    ok: true,
    value: { provider: "openai", handle: second.value, apiKey: secondKey },
  });

  const plaintextCount = fixture.sqlite
    .prepare(
      `SELECT COUNT(*) AS count
     FROM vault_secret
     WHERE ciphertext_b64 LIKE ?`,
    )
    .get(`%${secondKey}%`) as { readonly count: number };
  expect(plaintextCount.count).toBe(0);
}

function rejectsMalformedKey(): void {
  expect(parseModelApiKey("openai", "short")).toEqual({
    ok: false,
    error: { code: "organisation_openai_credential_invalid" },
  });
}

function organisationOpenAiRoute(handle: string) {
  return {
    keySource: "organisation_byo" as const,
    provider: "openai" as const,
    model: "gpt-5.6-luna",
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
  const organisationId = requireOrganisationId("organisation_openai_model");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'OpenAI Model Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  return {
    db: d1Database(sqlite),
    sqlite,
    organisationId,
    keys: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRoot(23),
    },
  };
}

function requiredApiKey(raw: string) {
  const parsed = parseModelApiKey("openai", raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
