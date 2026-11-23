/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import {
  parseTerminalAssignment,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { activateTerminalAssignment } from "@purin-labs/area-cafe/server/data/terminal-assignment-store";
import { readTerminalOperations } from "@purin-labs/area-cafe/server/data/terminal-operations-readback";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_1" as OrganisationId;
const OTHER_ORGANISATION = "organisation_2" as OrganisationId;
const ADAPTER = "square_terminal@2026-08-19";

let db: SingleDatabase;
let database: DatabaseSync;

function assignment(
  overrides: Record<string, unknown> = {},
): TerminalAssignment {
  const parsed = parseTerminalAssignment({
    assignmentId: "terminal_assignment_1",
    organisationId: ORGANISATION,
    merchantId: "merchant_1",
    pantryLocationId: "pantry_location_1",
    account: {
      integrationAccountId: "integration_square",
      providerAccountId: "merchant_square",
      environment: "production",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    providerLocationId: "provider_location_1",
    target: { kind: "paired_physical", providerDeviceId: "device_1" },
    transport: "server_terminal",
    adapterVersion: ADAPTER,
    revision: 1,
    state: { kind: "active" },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.field}`);
  return parsed.value;
}

/**
 * Seed the rows a certification and a collection are required to reference. The
 * foreign keys are part of what is under test: a certification packet cannot
 * exist without the integration account it certifies, and a terminal cannot be
 * held by an attempt that was never dispatched.
 */
function seedOrganisation(): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Terminal operations readback', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES (
       'app_user_terminal_operations', 'https://accounts.google.com',
       'terminal-operations', 'terminal-operations@test.invalid',
       'Terminal Operations', 1, 1, 1
     )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment
     ) VALUES (
       'connection_square', ?, 'square', 'api_key', 'connection_credential',
       1, 'credential_square', 'active', '["payments.read"]',
       'app_user_terminal_operations', 1, 1, 'production'
     )`,
    )
    .run(ORGANISATION);
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES (
       'integration_square', ?, 'connection_square', 'square',
       'merchant_square', 'merchant_account', 'Square', 'active',
       NULL, '["payments.read"]', '{"kind":"operator"}',
       '{"kind":"organisation_default"}', 1, 1, 'production', 1
     )`,
    )
    .run(ORGANISATION);
}

describe("terminal operations readback", function readbackSuite() {
  beforeEach(function freshDatabase() {
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seedOrganisation();
  });

  it("reports a counter that can take a payment", async function collectable() {
    const active = assignment();
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: active,
      now: 1,
    });
    const operations = await readTerminalOperations({
      db,
      organisationId: ORGANISATION,
      now: 5,
      linkedLocationIds: new Set([active.providerLocationId]),
    });
    expect(operations.counters).toHaveLength(1);
    const [counter] = operations.counters;
    expect(counter?.blockedReason).toBeNull();
    expect(counter?.paymentsLinked).toBe(true);
    expect(counter?.assignment.deviceId).toBe("device_1");
    expect(counter?.assignment.revision).toBe(1);
    expect(counter?.assignment.integrationAccountId).toBe("integration_square");
    expect(counter?.assignment.capabilityRevision).toBe(1);
    expect(counter?.assignment.capabilityCurrent).toBe(true);
    expect(counter?.assignment.healthIsObservable).toBe(true);
    expect(counter?.credentialHealth).toBe("active");
  });

  it("marks an assignment stale after its account capability revision changes", async function staleCapability() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    database
      .prepare(
        "UPDATE integration_account SET updated_at = 2 WHERE integration_account_id = 'integration_square'",
      )
      .run();
    const operations = await readTerminalOperations({
      db,
      organisationId: ORGANISATION,
      now: 5,
      linkedLocationIds: new Set(),
    });
    expect(operations.counters[0]?.assignment.capabilityCurrent).toBe(false);
  });

  it("surfaces reconnection-required credentials without changing the assignment", async function reauthenticationRequired() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    database
      .prepare(
        "UPDATE provider_connection SET lifecycle = 'reauth_required' WHERE provider_connection_id = 'connection_square'",
      )
      .run();
    const operations = await readTerminalOperations({
      db,
      organisationId: ORGANISATION,
      now: 5,
      linkedLocationIds: new Set(),
    });
    expect(operations.counters[0]?.credentialHealth).toBe("reauth_required");
    expect(operations.counters[0]?.blockedReason).toBeNull();
  });

  it("reports a sandbox counter as one whose health cannot be observed", async function simulated() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment({
        account: {
          integrationAccountId: "integration_square",
          providerAccountId: "merchant_square",
          environment: "development",
          capabilityRevision: 1,
          country: "JP",
          currency: "JPY",
        },
        target: { kind: "sandbox_simulated", testDeviceId: "device_simulated" },
      }),
      now: 1,
    });
    const operations = await readTerminalOperations({
      db,
      organisationId: ORGANISATION,
      now: 5,
      linkedLocationIds: new Set(),
    });
    expect(operations.counters[0]?.assignment.healthIsObservable).toBe(false);
    expect(operations.counters[0]?.assignment.targetKind).toBe(
      "sandbox_simulated",
    );
  });

  it("counts an unreadable assignment instead of hiding the counters beside it", async function corrupt() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment({
        assignmentId: "terminal_assignment_2",
        pantryLocationId: "pantry_location_2",
      }),
      now: 1,
    });
    database.exec(
      `UPDATE cafe_terminal_assignment
       SET assignment_json = '{"assignmentId":"terminal_assignment_2"}'
       WHERE assignment_id = 'terminal_assignment_2'`,
    );
    const operations = await readTerminalOperations({
      db,
      organisationId: ORGANISATION,
      now: 5,
      linkedLocationIds: new Set(),
    });
    expect(operations.counters).toHaveLength(1);
    expect(operations.counters[0]?.pantryLocationId).toBe("pantry_location_1");
    expect(operations.unreadableAssignments).toBe(1);
  });

  it("does not report another organisation's counters", async function organisationScoped() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    expect(
      (
        await readTerminalOperations({
          db,
          organisationId: OTHER_ORGANISATION,
          now: 5,
          linkedLocationIds: new Set(),
        })
      ).counters,
    ).toEqual([]);
  });
});
