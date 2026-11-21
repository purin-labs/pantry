/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import {
  acceptTerminalPaymentObservation,
  parseTerminalAssignment,
  terminalAssignmentPaymentBinding,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  activateTerminalAssignment,
  readActiveTerminalAssignment,
  readTerminalAssignmentRevision,
  retireTerminalAssignment,
} from "../src/data/terminal-assignment-store";
import type { OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_1" as OrganisationId;
const ADAPTER = "square_terminal@2026-08-19";

let db: SingleDatabase;

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

describe("terminal assignment store", function assignmentStoreSuite() {
  beforeEach(function freshDatabase() {
    const database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
  });

  it("resolves the terminal a Pantry location sells through", async function readsActive() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    const active = await readActiveTerminalAssignment(
      db,
      ORGANISATION,
      "pantry_location_1",
    );
    expect(active.ok && active.value.target).toEqual({
      kind: "paired_physical",
      providerDeviceId: "device_1",
    });
  });

  it("reports no assignment for a location that has none", async function noAssignment() {
    expect(
      await readActiveTerminalAssignment(
        db,
        ORGANISATION,
        "pantry_location_other",
      ),
    ).toEqual({
      ok: false,
      error: { code: "terminal_assignment_not_found" },
    });
  });

  it("leaves a location on exactly one terminal when replaced", async function oneActive() {
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
        target: { kind: "paired_physical", providerDeviceId: "device_2" },
        revision: 2,
      }),
      now: 2,
    });
    const active = await readActiveTerminalAssignment(
      db,
      ORGANISATION,
      "pantry_location_1",
    );
    expect(active.ok && active.value.assignmentId).toBe(
      "terminal_assignment_2",
    );
  });

  it("keeps a retired revision readable for recovery", async function retiredStaysReadable() {
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
        target: { kind: "paired_physical", providerDeviceId: "device_2" },
        revision: 2,
      }),
      now: 2,
    });
    // An attempt dispatched under the old revision still needs its binding.
    const earlier = await readTerminalAssignmentRevision(
      db,
      ORGANISATION,
      "terminal_assignment_1",
      1,
    );
    expect(earlier.ok && earlier.value.target).toEqual({
      kind: "paired_physical",
      providerDeviceId: "device_1",
    });
    // Readable is not the same as authorised. The replaced assignment records
    // its own retirement, so it can still bind settlement evidence for the
    // payment it took, but it can no longer start a new collection.
    expect(earlier.ok && earlier.value.state).toEqual({
      kind: "retired",
      reason: "replaced",
      retiredAt: new Date(2).toISOString(),
    });
    expect(
      earlier.ok && terminalAssignmentPaymentBinding(earlier.value).ok,
    ).toBe(false);
    expect(
      earlier.ok &&
        acceptTerminalPaymentObservation(earlier.value, {
          providerAccountId: "merchant_square",
          providerLocationId: "provider_location_1",
          deviceId: "device_1",
          terminalCheckoutId: "checkout_1",
          providerDeliveryId: "delivery_1",
          amount: { currency: "JPY", amountMinor: 1200 },
          lifecycle: { kind: "completed", paymentId: "payment_1" },
          observedAt: new Date(2).toISOString(),
        }).ok,
    ).toBe(true);
  });

  it("stops card-present payments when retired without replacement", async function retireLeavesNone() {
    await activateTerminalAssignment({
      db,
      organisationId: ORGANISATION,
      assignment: assignment(),
      now: 1,
    });
    expect(
      await retireTerminalAssignment({
        db,
        organisationId: ORGANISATION,
        assignmentId: "terminal_assignment_1",
        revision: 1,
        reason: "revoked",
        now: 2,
      }),
    ).toBe(true);
    expect(
      await readActiveTerminalAssignment(db, ORGANISATION, "pantry_location_1"),
    ).toEqual({
      ok: false,
      error: { code: "terminal_assignment_not_found" },
    });
    // Retiring twice is not a second retirement.
    expect(
      await retireTerminalAssignment({
        db,
        organisationId: ORGANISATION,
        assignmentId: "terminal_assignment_1",
        revision: 1,
        reason: "revoked",
        now: 3,
      }),
    ).toBe(false);

    // The stored assignment records the retirement too, so reading the exact
    // revision an in-flight collection was dispatched under cannot hand back
    // payment authority the operator has withdrawn.
    const stored = await readTerminalAssignmentRevision(
      db,
      ORGANISATION,
      "terminal_assignment_1",
      1,
    );
    expect(stored.ok && stored.value.state).toEqual({
      kind: "retired",
      reason: "revoked",
      retiredAt: new Date(2).toISOString(),
    });
    expect(stored.ok && terminalAssignmentPaymentBinding(stored.value).ok).toBe(
      false,
    );
  });

  it("refuses to store a simulated target in production", async function environmentGuard() {
    await expect(
      activateTerminalAssignment({
        db,
        organisationId: ORGANISATION,
        assignment: {
          ...assignment(),
          // Bypass the contract parser to prove the DDL also refuses it.
          target: { kind: "sandbox_simulated", testDeviceId: "test_device" },
        } as TerminalAssignment,
        now: 1,
      }),
    ).rejects.toThrow();
  });
});
