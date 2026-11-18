import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTypeSafeConnectionSchema,
  mutateTypeSafeConnection,
  readTypeSafeConnection,
} from "../src/integrations/typesafe/connection";
import { resolveTypeSafeCredential as resolveTypeSafeConnection } from "../src/integrations/typesafe/authority";
import {
  createCaseContextDiscoveryEvaluationSchema,
  publishCaseContextDiscoveryPolicy,
  readCaseContextDiscoveryPolicy,
} from "../src/case-context-discovery/evaluation-store";
import {
  caseContextDiscoveryReadiness,
  parseCaseContextDiscoveryPolicy,
} from "../src/case-context-discovery/policy";
import { SqliteD1Database } from "./sqlite-d1";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireOrganisationId } from "./test-ids";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { platformEnv } from "./worker-fakes";

const KEY = "apikey_organisation-test-key-1234567890";
const databases: DatabaseSync[] = [];

describe("organisation JEV connections", suite);

function suite(): void {
  afterEach(closeDatabases);
  it(
    "encrypts keys, isolates organisations and fences old credentials on replacement and disconnect",
    lifecycle,
  );
  it(
    "rejects an invalid provider key without saving it and bounds test calls",
    rejectsInvalid,
  );
  it(
    "cannot commit a probe after a concurrent disconnect",
    concurrentDisconnect,
  );
}

function closeDatabases(): void {
  for (const database of databases.splice(0)) database.close();
}

async function fixture() {
  const actor = emptySqliteFixture();
  const sql = sqlStorage(actor.storage);
  const database = new DatabaseSync(":memory:");
  databases.push(actor.database, database);
  database.exec(singleDatabaseSchema());
  const organisationId = requireOrganisationId("organisation_jev_connection");
  database
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'JEV test', 'beta', 1, 'active')",
    )
    .run(organisationId);
  createCaseContextDiscoveryEvaluationSchema(sql);
  createTypeSafeConnectionSchema(sql);
  sql.exec(
    "CREATE TABLE state_object_policy_export_barrier (singleton INTEGER PRIMARY KEY)",
  );
  const root = {
    get: vi
      .fn()
      .mockResolvedValue(
        btoa(String.fromCharCode(...new Uint8Array(32).fill(23))),
      ),
  };
  const env = platformEnv({
    DB: new SqliteD1Database(database),
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: root,
  });
  const placement = await ensureInitialOrganisationPlacement({
    db: env.DB,
    organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 1,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const admission = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!admission.ok) throw new Error(admission.error.code);
  return {
    scope: admission.value,
    sql,
    transaction: actor.storage.transactionSync.bind(actor.storage),
    env,
    db: env.DB,
    keys: env,
    organisationId,
    database,
  };
}

function response(model = "jev-1.13.0"): Response {
  return Response.json({
    model,
    answers: {
      in_transit: { type: "noul", noul: 0.95 },
    },
    usage: { input_tokens: 1000, output_tokens: 20, cost: 0.000042 },
  });
}

/**
 * A fetch with the rule of the Workers runtime: it throws when it is called
 * as a property of another object. The Actor passes the runtime's own fetch.
 */
function receiverSensitiveFetch(responses: Response[]) {
  return vi.fn<typeof fetch>(function fetchLikeTheRuntime(this: unknown) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected provider request");
    return Promise.resolve(next);
  });
}

function now(): number {
  return 100_000;
}
function later(): number {
  return 200_000;
}

async function lifecycle(): Promise<void> {
  const f = await fixture();
  await expect(resolveTypeSafeConnection(f)).resolves.toBeNull();
  const fetcher = receiverSensitiveFetch([response(), response("jev-1.13.0")]);
  const saved = await mutateTypeSafeConnection({
    ...f,
    actorId: "admin",
    body: {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: KEY,
    },
    fetcher,
    now,
  });
  expect(saved).toEqual({
    ok: true,
    value: {
      kind: "connected",
      provider: "typesafe",
      revision: 1,
      testedAt: now(),
    },
  });
  expect(JSON.stringify(saved)).not.toContain(KEY);
  expect(JSON.stringify(saved)).not.toContain("vault:");
  const credential = await resolveTypeSafeConnection(f);
  expect(credential).toEqual({
    provider: "typesafe",
    apiKey: KEY,
    authority: { kind: "organisation_byo", connectionRevision: 1 },
  });
  await expect(
    resolveTypeSafeConnection({
      ...f,
      organisationId: requireOrganisationId("organisation_other"),
    }),
  ).resolves.toBeNull();
  expect(
    JSON.stringify(f.database.prepare("SELECT * FROM vault_secret").all()),
  ).not.toContain(KEY);
  const policy = configuredPolicy();
  expect(
    publishCaseContextDiscoveryPolicy({
      ...f,
      commandId: "enable",
      requestDigest: "a".repeat(64),
      expectedRevision: 0,
      policy,
      actorId: "admin",
      now: now(),
    }),
  ).toMatchObject({ ok: true });
  const changed = await mutateTypeSafeConnection({
    ...f,
    actorId: "admin",
    body: {
      operation: "connect",
      expectedRevision: 1,
      provider: "typesafe",
      apiKey: "typesafe-organisation-key-123456789",
    },
    fetcher,
    now: later,
  });
  expect(changed).toMatchObject({
    ok: true,
    value: { revision: 2, provider: "typesafe" },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 1,
    policy,
  });
  expect(
    caseContextDiscoveryReadiness({
      policy,
      credential: await resolveTypeSafeConnection(f),
      source: "commerce",
      integrationAccountId: "synthetic-evaluation",
    }),
  ).toEqual({ kind: "inactive", reason: "credential_unavailable" });
  expect(
    f.database
      .prepare(
        "SELECT COUNT(*) AS count FROM vault_secret WHERE revoked_at IS NOT NULL",
      )
      .get(),
  ).toEqual({ count: 1 });
  await expect(
    mutateTypeSafeConnection({
      ...f,
      actorId: "admin",
      body: { operation: "disconnect", expectedRevision: 2 },
      fetcher,
      now: later,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "disconnected", revision: 3 },
  });
  await expect(resolveTypeSafeConnection(f)).resolves.toBeNull();
  expect(
    f.database
      .prepare(
        "SELECT COUNT(*) AS count FROM vault_secret WHERE revoked_at IS NULL",
      )
      .get(),
  ).toEqual({ count: 0 });
}

async function rejectsInvalid(): Promise<void> {
  const f = await fixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  const input = {
    ...f,
    actorId: "admin",
    body: {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: KEY,
    },
    fetcher,
    now,
  };
  await expect(mutateTypeSafeConnection(input)).resolves.toMatchObject({
    ok: false,
    error: { code: "jev_credential_rejected" },
  });
  expect(readTypeSafeConnection(f.sql, f.organisationId)).toEqual({
    kind: "disconnected",
    revision: 0,
  });
  await expect(mutateTypeSafeConnection(input)).resolves.toMatchObject({
    ok: false,
    error: { code: "jev_test_rate_limited" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    f.database.prepare("SELECT COUNT(*) AS count FROM vault_secret").get(),
  ).toEqual({ count: 0 });
}

async function concurrentDisconnect(): Promise<void> {
  const f = await fixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(disconnectDuringFetch.bind(null, f));
  await expect(
    mutateTypeSafeConnection({
      ...f,
      actorId: "admin",
      body: {
        operation: "connect",
        expectedRevision: 0,
        provider: "typesafe",
        apiKey: KEY,
      },
      fetcher,
      now,
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "typesafe_revision_conflict" },
  });
  expect(readTypeSafeConnection(f.sql, f.organisationId)).toEqual({
    kind: "disconnected",
    revision: 1,
  });
  expect(
    f.database.prepare("SELECT COUNT(*) AS count FROM vault_secret").get(),
  ).toEqual({ count: 0 });
}

async function disconnectDuringFetch(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<Response> {
  await mutateTypeSafeConnection({
    ...f,
    actorId: "admin",
    body: { operation: "disconnect", expectedRevision: 0 },
    fetcher: vi.fn<typeof fetch>(),
    now,
  });
  return response();
}

function configuredPolicy() {
  const parsed = parseCaseContextDiscoveryPolicy({
    mode: "shadow",
    route: {
      provider: "typesafe",
      connectionRevision: 1,
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
    },
    sources: [
      { source: "commerce", integrationAccountId: "synthetic-evaluation" },
    ],
    limits: {
      maxEvaluations: 5,
      maxConcurrentEvaluations: 5,
      maxInputBytes: 122880,
      maxInputTokens: 5 * 65_536,
      maxWallMs: 50000,
      maxCostMicrousd: 50000,
      reservationMicrousd: 10000,
      requestTimeoutMs: 10000,
    },
  });
  if (!parsed.ok) throw new Error("invalid fixture policy");
  return parsed.value;
}
