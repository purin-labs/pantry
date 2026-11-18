import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  authorizeCloudflareAuthoritativeMutation,
  parseAuthoritativeRuntimeCutover,
  readAuthoritativeRuntime,
} from "../src/data/authoritative-runtime-cutover";
import { type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId } from "./test-ids";

const PREPARED_AT = 10_000;
const ACTIVATED_AT = 20_000;
const FIRST_WRITE_AT = 21_000;

describe("authoritative runtime cutover", authoritativeRuntimeCutoverSuite);

function authoritativeRuntimeCutoverSuite(): void {
  it(
    "authorizes mutations only after Cloudflare becomes authoritative",
    authorizesOnlyCloudflareMutations,
  );
  it(
    "rejects mutations admitted before activation in every Cloudflare state",
    rejectsPreactivationMutations,
  );
  it(
    "rejects persistence shapes with conflicting authority",
    rejectsInvalidPersistenceState,
  );
}

async function authorizesOnlyCloudflareMutations(): Promise<void> {
  const fixture = createFixture();

  await expect(
    authorizeCloudflareAuthoritativeMutation({
      ...fixture,
      occurredAt: FIRST_WRITE_AT,
    }),
  ).resolves.toEqual({
    ok: false,
    error: {
      code: "runtime_not_authoritative",
      state: "inherited_authoritative",
    },
  });

  prepare(fixture);
  await expect(
    authorizeCloudflareAuthoritativeMutation({
      ...fixture,
      occurredAt: FIRST_WRITE_AT,
    }),
  ).resolves.toEqual({
    ok: false,
    error: {
      code: "runtime_not_authoritative",
      state: "cloudflare_prepared",
    },
  });

  activate(fixture);
  const first = await authorizeCloudflareAuthoritativeMutation({
    ...fixture,
    occurredAt: FIRST_WRITE_AT,
  });
  const replay = await authorizeCloudflareAuthoritativeMutation({
    ...fixture,
    occurredAt: FIRST_WRITE_AT + 1_000,
  });

  expect(first).toMatchObject({
    ok: true,
    value: {
      state: "cloudflare_forward_only",
      firstAuthoritativeWriteAt: FIRST_WRITE_AT,
    },
  });
  expect(replay).toEqual(first);
}

async function rejectsPreactivationMutations(): Promise<void> {
  const fixture = createFixture();
  prepare(fixture);
  activate(fixture);

  const stale = {
    ok: false,
    error: {
      code: "mutation_precedes_activation",
      activatedAt: ACTIVATED_AT,
    },
  } as const;

  await expect(
    authorizeCloudflareAuthoritativeMutation({
      ...fixture,
      occurredAt: ACTIVATED_AT - 1,
    }),
  ).resolves.toEqual(stale);
  await expect(readAuthoritativeRuntime(fixture)).resolves.toMatchObject({
    ok: true,
    value: {
      state: "cloudflare_rollback_open",
      firstAuthoritativeWriteAt: null,
    },
  });

  await expect(
    authorizeCloudflareAuthoritativeMutation({
      ...fixture,
      occurredAt: FIRST_WRITE_AT,
    }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    authorizeCloudflareAuthoritativeMutation({
      ...fixture,
      occurredAt: ACTIVATED_AT - 1,
    }),
  ).resolves.toEqual(stale);
}

function rejectsInvalidPersistenceState(): void {
  expect(
    parseAuthoritativeRuntimeCutover({
      authoritativeRuntime: "inherited",
      state: "cloudflare_rollback_open",
      preparedAt: PREPARED_AT,
      activatedAt: ACTIVATED_AT,
      rollbackExpiresAt: ACTIVATED_AT + 5_000,
      firstAuthoritativeWriteAt: null,
      rolledBackAt: null,
    }),
  ).toEqual({
    ok: false,
    error: { code: "runtime_cutover_state_invalid" },
  });
}

function prepare(fixture: Fixture): void {
  fixture.sqlite
    .prepare(
      `UPDATE organisation
     SET runtime_cutover_state = 'cloudflare_prepared',
         cloudflare_prepared_at = ?
     WHERE organisation_id = ?`,
    )
    .run(PREPARED_AT, fixture.organisationId);
}

function activate(fixture: Fixture): void {
  fixture.sqlite
    .prepare(
      `UPDATE organisation
     SET authoritative_runtime = 'cloudflare',
         runtime_cutover_state = 'cloudflare_rollback_open',
         cloudflare_activated_at = ?,
         runtime_rollback_expires_at = ?
     WHERE organisation_id = ?`,
    )
    .run(ACTIVATED_AT, ACTIVATED_AT + 5_000, fixture.organisationId);
}

type Fixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
};

function createFixture(): Fixture {
  const sqlite = new DatabaseSync(":memory:");

  sqlite.exec(singleDatabaseSchema());

  const organisationId = requireOrganisationId("organisation_runtime_cutover");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Runtime Cutover Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);

  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId,
  };
}
