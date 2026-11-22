import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import type { ControlMutationIdentity } from "../src/data/control-mutation";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  applyVersionedAccessDefaults,
  changeVersionedCapabilityPolicy,
} from "../src/access-control/capability-mutations";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
} from "../src/authorization/capability-catalogue";
import { prepareReadAndProposeCapabilityPolicies } from "../src/data/capability-policy";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { prepareInitialOrganisationPlacementInsert } from "../src/data/shared-rows/placement-row";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { d1Database } from "./sqlite-d1";
const baselineSql = singleDatabaseSchema();

const ORGANISATION_ID = requireOrganisationId();
const CONTROL_IDENTITY_ID = requireUserId();

describe("versioned access capability mutations", function accessCapabilityMutationSuite() {
  it(
    "commits one current policy with its receipt",
    testCapabilityChangeAndRecovery,
  );
  it(
    "rejects stale aggregate, record, and unsupported-mode mutations",
    testCapabilityConflicts,
  );
  it(
    "applies the complete baseline without restoring revoked grants",
    testApplyDefaults,
  );
});

async function testCapabilityChangeAndRecovery(): Promise<void> {
  const fixture = await createFixture(true);
  const first = await changeVersionedCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),

    capabilityId: CAPABILITY_KEYS.fileRead,
    capabilityVersion: 1,
    mode: "disabled",
    expectedProjectionRevision: 7,
    expectedCapabilityRevision: 1,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_capability_change", 100),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_capability_change",
      requestHash: "fixture-capability-request",
    },
  });
  expect(first).toEqual({
    ok: true,
    value: {
      policy: {
        organisationId: ORGANISATION_ID,
        capabilityId: CAPABILITY_KEYS.fileRead,
        capabilityVersion: 1,
        mode: "disabled",
        provenance: {
          kind: "operator",
          userId: CONTROL_IDENTITY_ID,
          mutationReceiptId: "receipt_access_capability_change",
        },
        revision: 2,
        changedAt: 100,
      },
      environment: "production",
      configurationVersion: 4,
      projectionRevision: 8,
    },
  });
  fixture.sqlite.close();
}

async function testCapabilityConflicts(): Promise<void> {
  const staleAggregate = await createFixture(true);
  const stale = await changeVersionedCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(
      {
        DB: staleAggregate.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),

    capabilityId: CAPABILITY_KEYS.fileRead,
    capabilityVersion: 1,
    mode: "disabled",
    expectedProjectionRevision: 6,
    expectedCapabilityRevision: 1,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_stale_aggregate", 100),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_stale_aggregate",
      requestHash: "fixture-capability-request",
    },
  });
  expect(stale).toEqual({
    ok: false,
    error: { code: "access_control_revision_conflict", expected: 6, actual: 7 },
  });
  staleAggregate.sqlite.close();

  const staleRecord = await createFixture(true);
  const record = await changeVersionedCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(
      {
        DB: staleRecord.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),

    capabilityId: CAPABILITY_KEYS.fileRead,
    capabilityVersion: 1,
    mode: "disabled",
    expectedProjectionRevision: 7,
    expectedCapabilityRevision: 2,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_stale_record", 100),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_stale_record",
      requestHash: "fixture-capability-request",
    },
  });
  expect(record).toEqual({
    ok: false,
    error: {
      code: "capability_policy_revision_conflict",
      expected: 2,
      actual: 1,
    },
  });
  staleRecord.sqlite.close();

  const unsupportedMode = await createFixture(true);
  const unsupported = await changeVersionedCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(
      {
        DB: unsupportedMode.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),

    capabilityId: CAPABILITY_KEYS.contextCaseRead,
    capabilityVersion: 1,
    mode: "approval_required",
    expectedProjectionRevision: 7,
    expectedCapabilityRevision: 1,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_unsupported_mode", 100),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_unsupported_mode",
      requestHash: "fixture-capability-request",
    },
  });
  expect(unsupported).toEqual({
    ok: false,
    error: { code: "capability_policy_mode_unsupported" },
  });
  unsupportedMode.sqlite.close();
}

async function testApplyDefaults(): Promise<void> {
  const fixture = await createFixture(false);
  const first = await applyVersionedAccessDefaults({
    scope: await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),
    expectedProjectionRevision: 7,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_defaults_first", 100),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_defaults_first",
      requestHash: "fixture-defaults-first",
    },
  });
  expect(first).toEqual({
    ok: true,
    value: {
      environment: "production",
      configurationVersion: 4,
      projectionRevision: 8,
      changed: true,
    },
  });
  expect(
    fixture.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM organisation_capability_policy WHERE organisation_id = ?",
      )
      .get(ORGANISATION_ID),
  ).toEqual({ count: CAPABILITY_CATALOGUE.length });
  fixture.sqlite
    .prepare(
      `UPDATE access_grant
        SET lifecycle = 'revoked', revision = 2, reason = 'operator revoked', changed_at = 150
      WHERE organisation_id = ? AND grant_id = 'grant_baseline_owner_integration_discovery_read'`,
    )
    .run(ORGANISATION_ID);
  const second = await applyVersionedAccessDefaults({
    scope: await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION_ID,
    ),
    expectedProjectionRevision: 8,
    actorUserId: CONTROL_IDENTITY_ID,
    identity: mutationIdentity("receipt_access_defaults_second", 200),
    boundary: {
      kind: "unversioned",
      idempotencyKey: "receipt_access_defaults_second",
      requestHash: "fixture-defaults-second",
    },
  });
  expect(second).toEqual({
    ok: true,
    value: {
      environment: "production",
      configurationVersion: 4,
      projectionRevision: 8,
      changed: false,
    },
  });
  expect(
    fixture.sqlite
      .prepare(
        `SELECT lifecycle, revision FROM access_grant
      WHERE organisation_id = ? AND grant_id = 'grant_baseline_owner_integration_discovery_read'`,
      )
      .get(ORGANISATION_ID),
  ).toEqual({ lifecycle: "revoked", revision: 2 });
  fixture.sqlite.close();
}

async function createFixture(withPolicies: boolean): Promise<
  Readonly<{
    sqlite: DatabaseSync;
    db: SingleDatabase;
  }>
> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(baselineSql);
  sqlite
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, ?, ?)",
    )
    .run(ORGANISATION_ID, "Access Mutation", 1);
  sqlite
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, updated_at
     ) VALUES (?, 'production', 'configuring', 'read_and_propose', 3, 7, 1)`,
    )
    .run(ORGANISATION_ID);
  sqlite
    .prepare(
      `INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at)
    VALUES (?, 'test', 'capability-operator', 'operator@example.test', 'Operator', 1, 1, 1)`,
    )
    .run(CONTROL_IDENTITY_ID);
  const db = d1Database(sqlite);
  await prepareInitialOrganisationPlacementInsert(
    db,
    ORGANISATION_ID,
    "production",
    TEST_INITIAL_ORGANISATION_PLACEMENT,
    1,
  ).run();
  if (withPolicies) {
    await db.batch([
      ...prepareReadAndProposeCapabilityPolicies({
        source: db,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            ORGANISATION_ID,
          ),
        },
        materializationReceiptId: "receipt_access_fixture",
        now: 10,
      }),
    ]);
  }
  return { sqlite, db };
}

function requireOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId("organisation_access_capability_mutation");
  if (!parsed.ok) throw new Error("Test organisation ID is invalid");
  return parsed.value;
}

function requireUserId(): UserId {
  const parsed = parseUserId("user_cfb3c491-ee39-5f88-b52c-126a4763d67b");
  if (!parsed.ok) throw new Error("Test control identity ID is invalid");
  return parsed.value;
}

function mutationIdentity(
  receiptId: string,
  now: number,
): ControlMutationIdentity {
  return {
    receiptId,
    auditEventId: `audit_${receiptId}`,
    correlationId: `correlation_${receiptId}`,
    causationId: receiptId,
    portalSubjectHash: "capability-operator",
    createdAt: now,
  };
}
