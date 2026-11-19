import type { TerminalAssignment } from "@seams/contracts";
import {
  acceptTerminalDeviceHealth,
  parseTerminalPairingAttempt,
  terminalPairingAttemptHasExpired,
  acceptTerminalPaymentObservation,
  parseTerminalAssignment,
  parseTerminalPaymentObservation,
  terminalAssignmentPaymentBinding,
  terminalObservationPaymentId,
} from "@seams/contracts";
import { describe, expect, it } from "vitest";

const ADAPTER_VERSION = "square_terminal@2026-08-19";

// Square's documented Terminal checkout test device identifier.
const SANDBOX_TEST_DEVICE = "9fa747a2-25ff-48ee-b078-04381f7c828f";

function account(environment: "development" | "production") {
  return {
    integrationAccountId: "integration_square",
    providerAccountId: "merchant_square",
    environment,
    capabilityRevision: 1,
    country: "JP",
    currency: "JPY",
  };
}

function assignmentRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assignmentId: "terminal_assignment_1",
    organisationId: "organisation_1",
    merchantId: "merchant_1",
    satyrLocationId: "pantry_location_1",
    account: account("production"),
    providerLocationId: "provider_location_1",
    target: { kind: "paired_physical", providerDeviceId: "device_1" },
    transport: "server_terminal",
    adapterVersion: ADAPTER_VERSION,
    revision: 1,
    state: { kind: "active" },
    ...overrides,
  };
}

function assignment(
  overrides: Record<string, unknown> = {},
): TerminalAssignment {
  const parsed = parseTerminalAssignment(assignmentRecord(overrides));
  if (!parsed.ok)
    throw new Error(`fixture assignment is invalid: ${parsed.error.field}`);
  return parsed.value;
}

function simulatedAssignment(): TerminalAssignment {
  return assignment({
    account: account("development"),
    target: { kind: "sandbox_simulated", testDeviceId: SANDBOX_TEST_DEVICE },
  });
}

function observationRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerDeliveryId: "delivery_1",
    providerAccountId: "merchant_square",
    terminalCheckoutId: "terminal_checkout_1",
    providerLocationId: "provider_location_1",
    deviceId: "device_1",
    amount: { amountMinor: 1_200, currency: "JPY" },
    lifecycle: { kind: "completed", paymentId: "payment_1" },
    observedAt: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  const parsed = parseTerminalPaymentObservation(observationRecord(overrides));
  if (!parsed.ok)
    throw new Error(`fixture observation is invalid: ${parsed.error.field}`);
  return parsed.value;
}

function pairingRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: "terminal_pairing_1",
    organisationId: "organisation_1",
    merchantId: "merchant_1",
    satyrLocationId: "pantry_location_1",
    account: account("production"),
    providerLocationId: "provider_location_1",
    state: {
      kind: "open",
      pairingCodeId: "pairing_code_1",
      expiresAt: "2026-09-06T00:05:00Z",
    },
    ...overrides,
  };
}

const RETIRED = {
  kind: "retired",
  reason: "replaced",
  retiredAt: "2026-09-05T02:00:00Z",
} as const;

describe("terminal assignment boundary", function terminalAssignmentSuite() {
  it("keeps pairing a production ceremony", function pairingIsProduction() {
    // Square Sandbox does not implement Devices API pairing, so a Sandbox
    // pairing attempt is not a thing that can exist.
    expect(
      parseTerminalPairingAttempt(
        pairingRecord({ account: account("development") }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalPairingAttempt.account.environment",
      },
    });
    expect(parseTerminalPairingAttempt(pairingRecord()).ok).toBe(true);
  });

  it("never lets an open pairing code name a device", function openHasNoDevice() {
    expect(
      parseTerminalPairingAttempt(
        pairingRecord({
          state: {
            kind: "open",
            pairingCodeId: "pairing_code_1",
            expiresAt: "2026-09-06T00:05:00Z",
            providerDeviceId: "device_1",
          },
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalPairingAttempt.state",
      },
    });
  });

  it("decides expiry from the code's own deadline", function expiryFromDeadline() {
    const parsed = parseTerminalPairingAttempt(pairingRecord());
    if (!parsed.ok) throw new Error("fixture invalid");
    // Square production pairing codes live about five minutes.
    expect(
      terminalPairingAttemptHasExpired(parsed.value, "2026-09-06T00:04:59Z"),
    ).toBe(false);
    expect(
      terminalPairingAttemptHasExpired(parsed.value, "2026-09-06T00:05:00Z"),
    ).toBe(true);

    const paired = parseTerminalPairingAttempt(
      pairingRecord({
        state: {
          kind: "paired",
          providerDeviceId: "device_1",
          pairedAt: "2026-09-06T00:01:00Z",
        },
      }),
    );
    if (!paired.ok) throw new Error("fixture invalid");
    // A completed pairing does not expire; only an open code does.
    expect(
      terminalPairingAttemptHasExpired(paired.value, "2026-09-30T00:00:00Z"),
    ).toBe(false);
  });

  it("requires each ended state to record when it ended", function endedStatesCarryTime() {
    for (const state of [{ kind: "expired" }, { kind: "cancelled" }]) {
      expect(parseTerminalPairingAttempt(pairingRecord({ state }))).toEqual({
        ok: false,
        error: {
          code: "terminal_assignment_invalid",
          field: "terminalPairingAttempt.state",
        },
      });
    }
    expect(
      parseTerminalPairingAttempt(
        pairingRecord({
          state: { kind: "expired", expiredAt: "2026-09-06T00:05:00Z" },
        }),
      ).ok,
    ).toBe(true);
  });

  it("grants payment authority while the assignment is active", function activeAuthority() {
    expect(terminalAssignmentPaymentBinding(assignment())).toEqual({
      ok: true,
      value: {
        provider: "square_terminal",
        account: account("production"),
        locationId: "provider_location_1",
        deviceId: "device_1",
        transport: "server_terminal",
      },
    });
  });

  it("grants no payment authority once the assignment is retired", function retiredAuthority() {
    expect(
      terminalAssignmentPaymentBinding(assignment({ state: RETIRED })),
    ).toEqual({
      ok: false,
      error: { code: "terminal_assignment_retired", reason: "replaced" },
    });
  });

  it("keeps a simulated target out of production", function simulationEnvironment() {
    expect(
      parseTerminalAssignment(
        assignmentRecord({
          target: {
            kind: "sandbox_simulated",
            testDeviceId: SANDBOX_TEST_DEVICE,
          },
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalAssignment.target.environment",
      },
    });
  });

  it("keeps a paired physical device out of Sandbox", function pairingEnvironment() {
    expect(
      parseTerminalAssignment(
        assignmentRecord({
          account: account("development"),
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalAssignment.target.environment",
      },
    });
  });

  it("reports only unknown health for a simulated target", function simulatedHealth() {
    const simulated = simulatedAssignment();
    expect(
      acceptTerminalDeviceHealth(simulated, "unknown", "simulated_target").ok,
    ).toBe(true);
    // A simulation can never claim a physical terminal is available.
    expect(
      acceptTerminalDeviceHealth(simulated, "available", "simulated_target"),
    ).toEqual({
      ok: false,
      error: { code: "terminal_observation_mismatch", field: "health" },
    });
    // Nor can it be labelled as a provider readback.
    expect(
      acceptTerminalDeviceHealth(simulated, "unknown", "provider_readback"),
    ).toEqual({
      ok: false,
      error: { code: "terminal_observation_mismatch", field: "health" },
    });
    // A real device's reading is never labelled a simulation.
    expect(
      acceptTerminalDeviceHealth(assignment(), "unknown", "simulated_target"),
    ).toEqual({
      ok: false,
      error: { code: "terminal_observation_mismatch", field: "health.source" },
    });
    expect(
      acceptTerminalDeviceHealth(
        assignment(),
        "unavailable",
        "provider_readback",
      ).ok,
    ).toBe(true);
  });

  it("has no device-health field that could reach payment authority", function healthIsSeparate() {
    expect(
      parseTerminalAssignment(
        assignmentRecord({
          health: { kind: "unavailable", observedAt: "2026-09-05T01:00:00Z" },
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalAssignment",
      },
    });
  });

  it("requires a retirement reason and time", function retirementEvidence() {
    expect(
      parseTerminalAssignment(assignmentRecord({ state: { kind: "retired" } })),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalAssignment.state",
      },
    });
  });

  it("never lets a target carry another target's identifier", function exclusiveTargetFields() {
    expect(
      parseTerminalAssignment(
        assignmentRecord({
          target: {
            kind: "paired_physical",
            testDeviceId: SANDBOX_TEST_DEVICE,
          },
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalAssignment.target",
      },
    });
  });

  it("binds an observation to its exact account, location, device, and currency", function exactBinding() {
    const active = assignment();
    expect(acceptTerminalPaymentObservation(active, observation()).ok).toBe(
      true,
    );

    for (const [field, overrides] of [
      ["providerAccountId", { providerAccountId: "merchant_other" }],
      ["providerLocationId", { providerLocationId: "provider_location_2" }],
      ["deviceId", { deviceId: "device_2" }],
      ["amount.currency", { amount: { amountMinor: 1_200, currency: "USD" } }],
    ] as const) {
      expect(
        acceptTerminalPaymentObservation(active, observation(overrides)),
      ).toEqual({
        ok: false,
        error: { code: "terminal_observation_mismatch", field },
      });
    }
  });

  it("keeps settlement evidence after the assignment is retired", function retiredEvidence() {
    const retired = assignment({ state: RETIRED });
    expect(terminalAssignmentPaymentBinding(retired).ok).toBe(false);
    expect(acceptTerminalPaymentObservation(retired, observation()).ok).toBe(
      true,
    );
  });

  it("drops provider commerce data at the observation boundary", function noCommerceData() {
    expect(
      parseTerminalPaymentObservation(
        observationRecord({ orderId: "provider_order_1" }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalObservation",
      },
    });
  });

  it("owns a payment identity exactly when the payment completed", function paymentIdentity() {
    expect(terminalObservationPaymentId(observation())).toBe("payment_1");
    expect(
      terminalObservationPaymentId(
        observation({ lifecycle: { kind: "pending" } }),
      ),
    ).toBe(null);
    expect(
      parseTerminalPaymentObservation(
        observationRecord({
          lifecycle: { kind: "pending", paymentId: "payment_1" },
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "terminal_assignment_invalid",
        field: "terminalObservation.lifecycle",
      },
    });
  });
});
