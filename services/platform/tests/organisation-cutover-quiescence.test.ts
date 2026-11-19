/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import { describe, expect, it, vi } from "vitest";

import { OrganisationDO } from "../src/actors/organisation";
import {
  parseSessionId,
  parseOrganisationId,
  type OrganisationId,
} from "../src/ids";
import {
  emptySqliteFixture,
  sqlStorage,
  type TestSqlStorage,
} from "./sqlite-storage";
import {
  createMigratedDatabase,
  requireActorExecutionAdmission,
  requireActorRegistryAdmission,
} from "./sqlite-d1";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { prepareInitialOrganisationPlacementInsert } from "../src/data/shared-rows/placement-row";
import {
  reserveActor,
  actorActivationRequest,
  activateActorRegistryEntry,
} from "../src/actors/actor-registry";
import { ORGANISATION_ACTOR_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";

describe("OrganisationActor cutover quiescence", function organisationCutoverQuiescenceSuite() {
  it(
    "projects and replays NF9 history budget warnings in OrganisationDO",
    projectHistoryBudgetWarning,
  );
  it(
    "durably arms recovery before committing a provider execution lease",
    armProviderExecutionRecoveryFirst,
  );
  it(
    "moves an expired provider execution lease to indeterminate from its alarm",
    expireProviderExecutionLease,
  );
});

async function armProviderExecutionRecoveryFirst(): Promise<void> {
  const fixture = await organisationFixture();
  fixture.storage.failTransactions = true;

  await expect(
    fixture.organisation.beginActionExecution({
      organisationId: fixture.organisationId,
      nonce: "nonce_interrupted_before_execution_commit",
      now: 10_000,
    }),
  ).rejects.toThrow("simulated_transaction_interruption");

  expect(fixture.storage.alarmAt).toBe(310_000);
}

async function expireProviderExecutionLease(): Promise<void> {
  const fixture = await organisationFixture();
  fixture.sqlStorage.exec(
    `INSERT INTO action_ledger (
       organisation_id, integration_account_id, nonce, case_id, proposal_id, session_id,
       thread_id, resource_key, verb, args_hash, action_json, idempotency_key,
       state, approval_json, rejection_json, provider_result, execution_lease_id,
       execution_lease_expires_at, expires_at, created_at, updated_at
     ) VALUES (?, 'integration_alarm', 'nonce_alarm', 'case_alarm', 'proposal_alarm',
       'session_alarm', 'thread_alarm', 'resource_alarm', 'commerce.publish',
       'hash_alarm', '{}', 'idempotency_alarm', 'executing', '{}', NULL, NULL,
       'lease_alarm', 11000, 30000, 1, 10000)`,
    fixture.organisationId,
  );
  fixture.storage.alarmAt = 11_000;
  vi.spyOn(Date, "now").mockReturnValue(11_000);

  await fixture.organisation.alarm();

  expect(
    fixture.sqlStorage
      .exec<{
        state: string;
        execution_lease_id: string | null;
        execution_lease_expires_at: number | null;
      }>(
        `SELECT state, execution_lease_id, execution_lease_expires_at
       FROM action_ledger WHERE nonce = 'nonce_alarm'`,
      )
      .toArray(),
  ).toEqual([
    {
      state: "indeterminate",
      execution_lease_id: null,
      execution_lease_expires_at: null,
    },
  ]);
  expect(fixture.storage.alarmAt).toBeNull();
}

async function projectHistoryBudgetWarning(): Promise<void> {
  const fixture = await organisationFixture();
  const sessionId = parseSessionId("session_history_warning");
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  expect(
    await fixture.organisation.recordHarnessHistoryBudgetWarning({
      organisationId: fixture.organisationId,
      sessionId: sessionId.value,
      entryCount: 80_000,
      inlineBytes: 100,
      hardLimit: false,
      warningAt: 20_000,
    }),
  ).toMatchObject({
    ok: true,
    value: {
      organisationId: fixture.organisationId,
      sessionId: sessionId.value,
      entryCount: 80_000,
      hardLimit: false,
    },
  });
  expect(
    await fixture.organisation.recordHarnessHistoryBudgetWarning({
      organisationId: fixture.organisationId,
      sessionId: sessionId.value,
      entryCount: 100_000,
      inlineBytes: 256 * 1024 * 1024,
      hardLimit: true,
      warningAt: 21_000,
    }),
  ).toMatchObject({ ok: true, value: { hardLimit: true } });
  expect(
    await fixture.organisation.readHarnessHistoryBudgetWarnings({
      requestingOrganisationId: fixture.organisationId,
    }),
  ).toMatchObject({
    ok: true,
    value: [
      {
        sessionId: sessionId.value,
        entryCount: 100_000,
        inlineBytes: 256 * 1024 * 1024,
        hardLimit: true,
        warningAt: 20_000,
      },
    ],
  });
}

async function organisationFixture(): Promise<{
  readonly organisation: OrganisationDO;
  readonly organisationId: OrganisationId;
  readonly storage: OrganisationTestStorage;
  readonly sqlStorage: TestSqlStorage;
}> {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  const storage = new OrganisationTestStorage(sql);
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {} as UnitTestEnv;
  env.DB = createMigratedDatabase();
  env.PANTRY_ORGANISATION_PLACEMENT_PROFILE =
    TEST_ORGANISATION_PLACEMENT_PROFILE;
  const organisation = new OrganisationDO(ctx, env);
  const organisationId = requiredOrganisationId();
  await env.DB.prepare(
    "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Cutover Organisation', 'beta', 1, 'active')",
  )
    .bind(organisationId)
    .run();
  await prepareInitialOrganisationPlacementInsert(
    env.DB,
    organisationId,
    "development",
    TEST_INITIAL_ORGANISATION_PLACEMENT,
    1,
  ).run();
  const reserved = await reserveActor({
    db: env.DB,
    identity: {
      objectKind: "organisation",
      organisationId,
      logicalObjectId: organisationId,
    },
    admission: await requireActorExecutionAdmission(
      env.DB,
      organisationId,
      TEST_INITIAL_ORGANISATION_PLACEMENT,
    ),
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: 1,
  });
  if (!reserved.ok || reserved.value.lifecycleStatus !== "reserved")
    throw new Error("Missing Organisation reservation");
  const activated = await organisation.activate(
    actorActivationRequest(
      reserved.value,
      1,
      await requireActorRegistryAdmission(env.DB, reserved.value.registryId),
    ),
  );
  if (!activated.ok) throw new Error(activated.error.code);
  const published = await activateActorRegistryEntry({
    db: env.DB,
    admission: await requireActorRegistryAdmission(
      env.DB,
      reserved.value.registryId,
    ),
    registryId: reserved.value.registryId,
    activationToken: reserved.value.activationToken,
    stateVersion: activated.value.stateVersion,
    now: 1,
  });
  if (!published.ok) throw new Error(published.error.code);
  await organisation.ensureOrganisation({
    organisationId,
    name: "Cutover Organisation",
    plan: "beta",
    status: "active",
    createdAt: 1,
  });
  return { organisation, organisationId, storage, sqlStorage: sqlite.storage };
}

function requiredOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId("organisation_cutover_quiescence");

  if (!parsed.ok) {
    throw new Error("organisation fixture invalid");
  }

  return parsed.value;
}

class OrganisationTestStorage {
  alarmAt: number | null = null;
  failTransactions = false;

  constructor(readonly sql: SqlStorage) {}

  transactionSync<Value>(callback: () => Value): Value {
    if (this.failTransactions)
      throw new Error("simulated_transaction_interruption");
    return callback();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}
