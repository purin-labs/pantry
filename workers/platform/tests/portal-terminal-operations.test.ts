import { describe, expect, it } from "vitest";

import {
  readTerminalOperations,
  retireTerminalCounter,
  type TerminalMutationTransport,
  type TerminalReadTransport,
} from "@purin-labs/area-cafe/ui/features/terminals/api";
import type { TerminalCounterReadback } from "@purin-labs/control-api";

const ORGANISATION = "organisation_1";
const PATH = `/v1/control/organisations/${ORGANISATION}/commerce/terminal-operations`;

function assignment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assignmentId: "terminal_assignment_1",
    revision: 2,
    merchantId: "merchant_1",
    integrationAccountId: "integration_square",
    capabilityRevision: 7,
    capabilityCurrent: true,
    providerLocationId: "provider_location_1",
    targetKind: "paired_physical",
    deviceId: "device_1",
    adapterVersion: "square_terminal@2026-08-19",
    environment: "production",
    healthIsObservable: true,
    ...overrides,
  };
}

function operations(counters: readonly unknown[]): Record<string, unknown> {
  return {
    ok: true,
    terminalOperations: {
      schemaVersion: "pantry.terminal-operations.v2",
      organisationId: ORGANISATION,
      generatedAt: new Date(5).toISOString(),
      counters,
      unreadableAssignments: 0,
    },
    configuration: { kind: "blocked", reason: "commerce_system_missing" },
  };
}

function counter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pantryLocationId: "pantry_location_1",
    blockedReason: null,
    assignment: assignment(),
    credentialHealth: "active",
    webhook: {
      kind: "configured",
      lifecycle: "live",
      credentialCurrent: true,
      lastVerifiedAt: 4,
      updatedAt: 4,
    },
    paymentsLinked: true,
    ...overrides,
  };
}

describe("Portal terminal-operations boundary", function terminalBoundarySuite() {
  it("parses a counter and whether Commerce takes its payments", async function parses() {
    const read: TerminalReadTransport = async (path) => {
      expect(path).toBe(PATH);
      return operations([counter({ paymentsLinked: false })]);
    };
    const parsed = await readTerminalOperations(ORGANISATION, read);
    expect(parsed.operations.counters).toHaveLength(1);
    expect(parsed.operations.counters[0]?.blockedReason).toBeNull();
    expect(parsed.operations.counters[0]?.paymentsLinked).toBe(false);
    expect(parsed.operations.counters[0]?.assignment.revision).toBe(2);
  });

  it("refuses a readback in a version it cannot read", async function versioned() {
    const read: TerminalReadTransport = async () => ({
      ok: true,
      terminalOperations: {
        ...(operations([]).terminalOperations as Record<string, unknown>),
        schemaVersion: "pantry.terminal-operations.v1",
      },
      configuration: { kind: "blocked", reason: "commerce_system_missing" },
    });
    await expect(readTerminalOperations(ORGANISATION, read)).rejects.toThrow(
      /version/u,
    );
  });

  it("refuses a counter carrying a field it does not model", async function exactKeys() {
    const read: TerminalReadTransport = async () =>
      operations([counter({ deviceHealth: "available" })]);
    await expect(readTerminalOperations(ORGANISATION, read)).rejects.toThrow(
      /fields are invalid/u,
    );
  });

  it("refuses a blocked reason it does not recognise", async function unknownReason() {
    const read: TerminalReadTransport = async () =>
      operations([counter({ blockedReason: "device_offline" })]);
    await expect(readTerminalOperations(ORGANISATION, read)).rejects.toThrow(
      /invalid/u,
    );
  });

  it("addresses retirement at the counter's own location and revision", async function retires() {
    const parsed = await readTerminalOperations(ORGANISATION, async () =>
      operations([counter()]),
    );
    const target = parsed.operations.counters[0] as TerminalCounterReadback;
    const mutate: TerminalMutationTransport = async (
      path,
      method,
      body,
      intent,
    ) => {
      expect(path).toBe(`${PATH}/pantry_location_1/retirement`);
      expect(method).toBe("POST");
      expect(body).toEqual({});
      expect(intent).toBe("terminal-retire:terminal_assignment_1:2");
      return {
        ok: true,
        terminalOperations: operations([]).terminalOperations,
      };
    };
    expect(
      (await retireTerminalCounter(ORGANISATION, target, mutate)).counters,
    ).toEqual([]);
  });

  it("reports a rejected retirement rather than treating it as done", async function rejected() {
    const parsed = await readTerminalOperations(ORGANISATION, async () =>
      operations([counter()]),
    );
    const mutate: TerminalMutationTransport = async () => ({
      ok: false,
      error: "terminal_collection_unresolved",
      paymentAttemptId: "payment_attempt_1",
    });
    await expect(
      retireTerminalCounter(
        ORGANISATION,
        parsed.operations.counters[0] as TerminalCounterReadback,
        mutate,
      ),
    ).rejects.toThrow(/fields are invalid|unavailable/u);
  });
});
