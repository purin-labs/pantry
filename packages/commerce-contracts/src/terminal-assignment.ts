import type { CommerceMerchantId } from "./records/identifiers.ts";
import type { InPersonPaymentBinding } from "./commerce-domain";
import type {
  InPersonTerminalTransport,
  PaymentEnvironment,
} from "./records/commerce-records.ts";
import type { TerminalAssignment } from "./records/terminal.ts";
import type { TerminalAssignmentState } from "./records/terminal.ts";
import type { TerminalDeviceHealth } from "./records/terminal.ts";
import type { TerminalHealthSource } from "./records/terminal.ts";
import type { TerminalPairingAttempt } from "./records/terminal.ts";
import type { TerminalPairingAttemptState } from "./records/terminal.ts";
import type { TerminalPaymentLifecycle } from "./records/terminal.ts";
import type { TerminalPaymentObservation } from "./records/terminal.ts";
import type { TerminalRetirementReason } from "./records/terminal.ts";
import type { TerminalTarget } from "./records/terminal.ts";
import { parsePaymentProviderAccountBinding } from "./payment-binding.ts";
import { hasExactKeys, isRecord } from "@purin-labs/std";

const IDENTITY_MAX_LENGTH = 255;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export type TerminalAssignmentParseError = Readonly<{
  code: "terminal_assignment_invalid";
  field: string;
}>;

export type TerminalAuthorityError =
  | Readonly<{
      code: "terminal_assignment_retired";
      reason: TerminalRetirementReason;
    }>
  | Readonly<{ code: "terminal_observation_mismatch"; field: string }>;

type ParseResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: TerminalAssignmentParseError }>;

type AuthorityResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: TerminalAuthorityError }>;

/**
 * Parse one persisted terminal assignment. Keys are exact: a provider payload
 * carrying catalog, order, inventory, customer, or fulfillment fields cannot
 * become an assignment. Device health is not a field here, so a diagnostic
 * cannot reach payment authority.
 */
export function parseTerminalAssignment(
  raw: unknown,
): ParseResult<TerminalAssignment> {
  if (!isRecord(raw)) return invalid("terminalAssignment");
  if (
    !hasExactKeys(raw, [
      "assignmentId",
      "organisationId",
      "merchantId",
      "pantryLocationId",
      "account",
      "providerLocationId",
      "target",
      "transport",
      "adapterVersion",
      "revision",
      "state",
    ])
  )
    return invalid("terminalAssignment");
  const assignmentId = readText(
    raw.assignmentId,
    "terminalAssignment.assignmentId",
  );
  if (!assignmentId.ok) return assignmentId;
  const organisationId = readText(
    raw.organisationId,
    "terminalAssignment.organisationId",
  );
  if (!organisationId.ok) return organisationId;
  const merchantId = readText(raw.merchantId, "terminalAssignment.merchantId");
  if (!merchantId.ok) return merchantId;
  const pantryLocationId = readText(
    raw.pantryLocationId,
    "terminalAssignment.pantryLocationId",
  );
  if (!pantryLocationId.ok) return pantryLocationId;
  const account = parsePaymentProviderAccountBinding(raw.account);
  if (!account.ok) return invalid("terminalAssignment.account");
  const providerLocationId = readText(
    raw.providerLocationId,
    "terminalAssignment.providerLocationId",
  );
  if (!providerLocationId.ok) return providerLocationId;
  const target = parseTerminalTarget(raw.target);
  if (!target.ok) return target;
  if (!targetPermitsEnvironment(target.value, account.value.environment)) {
    return invalid("terminalAssignment.target.environment");
  }
  const transport = readEnum(raw.transport, "terminalAssignment.transport", [
    "server_terminal",
    "client_app_handoff",
    "lan_gateway",
  ] satisfies readonly InPersonTerminalTransport[]);
  if (!transport.ok) return transport;
  if (transport.value !== targetTransport(target.value)) {
    return invalid("terminalAssignment.transport");
  }
  const adapterVersion = readText(
    raw.adapterVersion,
    "terminalAssignment.adapterVersion",
  );
  if (!adapterVersion.ok) return adapterVersion;
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) <= 0) {
    return invalid("terminalAssignment.revision");
  }
  const state = parseTerminalAssignmentState(raw.state);
  if (!state.ok) return state;
  return {
    ok: true,
    value: {
      assignmentId: assignmentId.value,
      organisationId: organisationId.value,
      merchantId: merchantId.value as CommerceMerchantId,
      pantryLocationId: pantryLocationId.value,
      account: account.value,
      providerLocationId: providerLocationId.value,
      target: target.value,
      transport: transport.value,
      adapterVersion: adapterVersion.value,
      revision: Number(raw.revision),
      state: state.value,
    },
  };
}

/**
 * Parse the terminal target. A Sandbox simulation target and a paired physical
 * device are different things and never share an identifier field.
 */
export function parseTerminalTarget(raw: unknown): ParseResult<TerminalTarget> {
  if (!isRecord(raw)) return invalid("terminalAssignment.target");
  const kind = readEnum(raw.kind, "terminalAssignment.target.kind", [
    "sandbox_simulated",
    "paired_physical",
    "lan_gateway_device",
    "square_pos_app",
  ] as const);
  if (!kind.ok) return kind;
  if (kind.value === "square_pos_app") {
    return hasExactKeys(raw, ["kind"])
      ? { ok: true, value: { kind: "square_pos_app" } }
      : invalid("terminalAssignment.target");
  }
  if (kind.value === "sandbox_simulated") {
    if (!hasExactKeys(raw, ["kind", "testDeviceId"])) {
      return invalid("terminalAssignment.target");
    }
    const testDeviceId = readText(
      raw.testDeviceId,
      "terminalAssignment.target.testDeviceId",
    );
    return testDeviceId.ok
      ? {
          ok: true,
          value: {
            kind: "sandbox_simulated",
            testDeviceId: testDeviceId.value,
          },
        }
      : testDeviceId;
  }
  if (kind.value === "lan_gateway_device") {
    if (!hasExactKeys(raw, ["kind", "gatewayId", "deviceSourceKey"])) {
      return invalid("terminalAssignment.target");
    }
    const gatewayId = readText(
      raw.gatewayId,
      "terminalAssignment.target.gatewayId",
    );
    if (!gatewayId.ok) return gatewayId;
    const deviceSourceKey = readText(
      raw.deviceSourceKey,
      "terminalAssignment.target.deviceSourceKey",
    );
    return deviceSourceKey.ok
      ? {
          ok: true,
          value: {
            kind: "lan_gateway_device",
            gatewayId: gatewayId.value,
            deviceSourceKey: deviceSourceKey.value,
          },
        }
      : deviceSourceKey;
  }
  if (!hasExactKeys(raw, ["kind", "providerDeviceId"])) {
    return invalid("terminalAssignment.target");
  }
  const providerDeviceId = readText(
    raw.providerDeviceId,
    "terminalAssignment.target.providerDeviceId",
  );
  return providerDeviceId.ok
    ? {
        ok: true,
        value: {
          kind: "paired_physical",
          providerDeviceId: providerDeviceId.value,
        },
      }
    : providerDeviceId;
}

/**
 * Parse a pairing attempt.
 *
 * A Square production pairing code lives about five minutes. Expiry is decided
 * against the recorded `expiresAt`, never against whether a code "looks" used,
 * so a stale code cannot quietly complete a pairing later.
 */
export function parseTerminalPairingAttempt(
  raw: unknown,
): ParseResult<TerminalPairingAttempt> {
  if (!isRecord(raw)) return invalid("terminalPairingAttempt");
  if (
    !hasExactKeys(raw, [
      "attemptId",
      "organisationId",
      "merchantId",
      "pantryLocationId",
      "account",
      "providerLocationId",
      "state",
    ])
  )
    return invalid("terminalPairingAttempt");
  const attemptId = readText(raw.attemptId, "terminalPairingAttempt.attemptId");
  if (!attemptId.ok) return attemptId;
  const organisationId = readText(
    raw.organisationId,
    "terminalPairingAttempt.organisationId",
  );
  if (!organisationId.ok) return organisationId;
  const merchantId = readText(
    raw.merchantId,
    "terminalPairingAttempt.merchantId",
  );
  if (!merchantId.ok) return merchantId;
  const pantryLocationId = readText(
    raw.pantryLocationId,
    "terminalPairingAttempt.pantryLocationId",
  );
  if (!pantryLocationId.ok) return pantryLocationId;
  const account = parsePaymentProviderAccountBinding(raw.account);
  if (!account.ok) return invalid("terminalPairingAttempt.account");
  // Square Sandbox does not implement Devices API pairing, so a pairing
  // attempt is a production ceremony by construction.
  if (account.value.environment !== "production") {
    return invalid("terminalPairingAttempt.account.environment");
  }
  const providerLocationId = readText(
    raw.providerLocationId,
    "terminalPairingAttempt.providerLocationId",
  );
  if (!providerLocationId.ok) return providerLocationId;
  const state = parseTerminalPairingAttemptState(raw.state);
  if (!state.ok) return state;
  return {
    ok: true,
    value: {
      attemptId: attemptId.value,
      organisationId: organisationId.value,
      merchantId: merchantId.value as CommerceMerchantId,
      pantryLocationId: pantryLocationId.value,
      account: account.value,
      providerLocationId: providerLocationId.value,
      state: state.value,
    },
  };
}

/** Parse the pairing ceremony state. Only a completed pairing names a device. */
export function parseTerminalPairingAttemptState(
  raw: unknown,
): ParseResult<TerminalPairingAttemptState> {
  if (!isRecord(raw)) return invalid("terminalPairingAttempt.state");
  const kind = readEnum(raw.kind, "terminalPairingAttempt.state.kind", [
    "open",
    "paired",
    "expired",
    "cancelled",
  ] as const);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case "open": {
      if (!hasExactKeys(raw, ["kind", "pairingCodeId", "expiresAt"])) {
        return invalid("terminalPairingAttempt.state");
      }
      const pairingCodeId = readText(
        raw.pairingCodeId,
        "terminalPairingAttempt.state.pairingCodeId",
      );
      if (!pairingCodeId.ok) return pairingCodeId;
      const expiresAt = readTimestamp(
        raw.expiresAt,
        "terminalPairingAttempt.state.expiresAt",
      );
      return expiresAt.ok
        ? {
            ok: true,
            value: {
              kind: "open",
              pairingCodeId: pairingCodeId.value,
              expiresAt: expiresAt.value,
            },
          }
        : expiresAt;
    }
    case "paired": {
      if (!hasExactKeys(raw, ["kind", "providerDeviceId", "pairedAt"])) {
        return invalid("terminalPairingAttempt.state");
      }
      const providerDeviceId = readText(
        raw.providerDeviceId,
        "terminalPairingAttempt.state.providerDeviceId",
      );
      if (!providerDeviceId.ok) return providerDeviceId;
      const pairedAt = readTimestamp(
        raw.pairedAt,
        "terminalPairingAttempt.state.pairedAt",
      );
      return pairedAt.ok
        ? {
            ok: true,
            value: {
              kind: "paired",
              providerDeviceId: providerDeviceId.value,
              pairedAt: pairedAt.value,
            },
          }
        : pairedAt;
    }
    case "expired": {
      if (!hasExactKeys(raw, ["kind", "expiredAt"])) {
        return invalid("terminalPairingAttempt.state");
      }
      const expiredAt = readTimestamp(
        raw.expiredAt,
        "terminalPairingAttempt.state.expiredAt",
      );
      return expiredAt.ok
        ? { ok: true, value: { kind: "expired", expiredAt: expiredAt.value } }
        : expiredAt;
    }
    default: {
      if (!hasExactKeys(raw, ["kind", "cancelledAt"])) {
        return invalid("terminalPairingAttempt.state");
      }
      const cancelledAt = readTimestamp(
        raw.cancelledAt,
        "terminalPairingAttempt.state.cancelledAt",
      );
      return cancelledAt.ok
        ? {
            ok: true,
            value: { kind: "cancelled", cancelledAt: cancelledAt.value },
          }
        : cancelledAt;
    }
  }
}

/**
 * Whether an open pairing code has run out.
 *
 * Expiry is read from the code's own deadline, so a code that was never used
 * cannot be completed later just because nothing marked it expired.
 */
export function terminalPairingAttemptHasExpired(
  attempt: TerminalPairingAttempt,
  now: string,
): boolean {
  return attempt.state.kind === "open" && attempt.state.expiresAt <= now;
}

/** Parse the assignment state. Retirement is an operator or credential fact. */
export function parseTerminalAssignmentState(
  raw: unknown,
): ParseResult<TerminalAssignmentState> {
  if (!isRecord(raw)) return invalid("terminalAssignment.state");
  const kind = readEnum(raw.kind, "terminalAssignment.state.kind", [
    "active",
    "retired",
  ] as const);
  if (!kind.ok) return kind;
  if (kind.value === "active") {
    return hasExactKeys(raw, ["kind"])
      ? { ok: true, value: { kind: "active" } }
      : invalid("terminalAssignment.state");
  }
  if (!hasExactKeys(raw, ["kind", "reason", "retiredAt"])) {
    return invalid("terminalAssignment.state");
  }
  const reason = readEnum(raw.reason, "terminalAssignment.state.reason", [
    "replaced",
    "revoked",
    "connection_removed",
  ] satisfies readonly TerminalRetirementReason[]);
  if (!reason.ok) return reason;
  const retiredAt = readTimestamp(
    raw.retiredAt,
    "terminalAssignment.state.retiredAt",
  );
  return retiredAt.ok
    ? {
        ok: true,
        value: {
          kind: "retired",
          reason: reason.value,
          retiredAt: retiredAt.value,
        },
      }
    : retiredAt;
}

/**
 * Parse one normalized terminal payment observation. The shape is exact, so a
 * raw provider payload cannot be handed through: an adapter must first drop
 * every catalog, order, inventory, customer, and fulfillment field.
 */
export function parseTerminalPaymentObservation(
  raw: unknown,
): ParseResult<TerminalPaymentObservation> {
  if (!isRecord(raw)) return invalid("terminalObservation");
  if (
    !hasExactKeys(raw, [
      "providerDeliveryId",
      "providerAccountId",
      "terminalCheckoutId",
      "providerLocationId",
      "deviceId",
      "amount",
      "lifecycle",
      "observedAt",
    ])
  )
    return invalid("terminalObservation");
  const providerDeliveryId = readText(
    raw.providerDeliveryId,
    "terminalObservation.providerDeliveryId",
  );
  if (!providerDeliveryId.ok) return providerDeliveryId;
  const providerAccountId = readText(
    raw.providerAccountId,
    "terminalObservation.providerAccountId",
  );
  if (!providerAccountId.ok) return providerAccountId;
  const terminalCheckoutId = readText(
    raw.terminalCheckoutId,
    "terminalObservation.terminalCheckoutId",
  );
  if (!terminalCheckoutId.ok) return terminalCheckoutId;
  const providerLocationId = readText(
    raw.providerLocationId,
    "terminalObservation.providerLocationId",
  );
  if (!providerLocationId.ok) return providerLocationId;
  const deviceId = readText(raw.deviceId, "terminalObservation.deviceId");
  if (!deviceId.ok) return deviceId;
  const amount = parseTerminalMoney(raw.amount);
  if (!amount.ok) return amount;
  const lifecycle = parseTerminalPaymentLifecycle(raw.lifecycle);
  if (!lifecycle.ok) return lifecycle;
  const observedAt = readTimestamp(
    raw.observedAt,
    "terminalObservation.observedAt",
  );
  if (!observedAt.ok) return observedAt;
  return {
    ok: true,
    value: {
      providerDeliveryId: providerDeliveryId.value,
      providerAccountId: providerAccountId.value,
      terminalCheckoutId: terminalCheckoutId.value,
      providerLocationId: providerLocationId.value,
      deviceId: deviceId.value,
      amount: amount.value,
      lifecycle: lifecycle.value,
      observedAt: observedAt.value,
    },
  };
}

function parseTerminalPaymentLifecycle(
  raw: unknown,
): ParseResult<TerminalPaymentLifecycle> {
  if (!isRecord(raw)) return invalid("terminalObservation.lifecycle");
  const kind = readEnum(raw.kind, "terminalObservation.lifecycle.kind", [
    "pending",
    "in_progress",
    "completed",
    "cancelled",
    "failed",
  ] as const);
  if (!kind.ok) return kind;
  if (kind.value === "completed") {
    if (!hasExactKeys(raw, ["kind", "paymentId"])) {
      return invalid("terminalObservation.lifecycle");
    }
    const paymentId = readText(
      raw.paymentId,
      "terminalObservation.lifecycle.paymentId",
    );
    return paymentId.ok
      ? { ok: true, value: { kind: "completed", paymentId: paymentId.value } }
      : paymentId;
  }
  return hasExactKeys(raw, ["kind"])
    ? { ok: true, value: { kind: kind.value } }
    : invalid("terminalObservation.lifecycle");
}

/**
 * Payment authority for one assignment. Only an active assignment has any, and
 * device health is deliberately not consulted: an offline device is a
 * provider-time collection failure, not a loss of authority.
 */
export function terminalAssignmentPaymentBinding(
  assignment: TerminalAssignment,
): AuthorityResult<InPersonPaymentBinding> {
  if (assignment.state.kind === "retired") {
    return {
      ok: false,
      error: {
        code: "terminal_assignment_retired",
        reason: assignment.state.reason,
      },
    };
  }
  if (
    assignment.target.kind === "lan_gateway_device" &&
    assignment.transport === "lan_gateway"
  ) {
    return {
      ok: true,
      value: {
        provider: "gmo_stera",
        account: assignment.account,
        locationId: assignment.providerLocationId,
        gatewayId: assignment.target.gatewayId,
        deviceSourceKey: assignment.target.deviceSourceKey,
        transport: "lan_gateway",
      },
    };
  }
  if (
    assignment.target.kind === "square_pos_app" &&
    assignment.transport === "client_app_handoff"
  ) {
    return {
      ok: true,
      value: {
        provider: "square_terminal",
        account: assignment.account,
        locationId: assignment.providerLocationId,
        transport: "client_app_handoff",
      },
    };
  }
  return {
    ok: true,
    value: {
      provider: "square_terminal",
      account: assignment.account,
      locationId: assignment.providerLocationId,
      deviceId: terminalTargetDeviceId(assignment.target),
      transport: "server_terminal",
    },
  };
}

/**
 * Bind a verified observation to its assignment. Settlement evidence is
 * admitted for a retired assignment too, so retiring a device cannot erase a
 * payment it already took.
 */
export function acceptTerminalPaymentObservation(
  assignment: TerminalAssignment,
  observation: TerminalPaymentObservation,
): AuthorityResult<TerminalPaymentObservation> {
  if (observation.providerAccountId !== assignment.account.providerAccountId) {
    return { ok: false, error: mismatch("providerAccountId") };
  }
  if (observation.providerLocationId !== assignment.providerLocationId) {
    return { ok: false, error: mismatch("providerLocationId") };
  }
  if (observation.deviceId !== terminalTargetDeviceId(assignment.target)) {
    return { ok: false, error: mismatch("deviceId") };
  }
  if (observation.amount.currency !== assignment.account.currency) {
    return { ok: false, error: mismatch("amount.currency") };
  }
  return { ok: true, value: observation };
}

/** The device identifier the provider expects on a collection request. */
export function terminalTargetDeviceId(target: TerminalTarget): string {
  switch (target.kind) {
    case "sandbox_simulated":
      return target.testDeviceId;
    case "paired_physical":
      return target.providerDeviceId;
    case "lan_gateway_device":
      return `${target.gatewayId}:${target.deviceSourceKey}`;
    case "square_pos_app":
      return "square_pos_app";
  }
}

/** The one transport that can reach a target. */
function targetTransport(target: TerminalTarget): InPersonTerminalTransport {
  switch (target.kind) {
    case "lan_gateway_device":
      return "lan_gateway";
    case "square_pos_app":
      return "client_app_handoff";
    case "sandbox_simulated":
    case "paired_physical":
      return "server_terminal";
  }
}

/**
 * A simulated target is not a provider device resource, so it can only ever
 * report unknown health.
 */
export function terminalTargetHealthIsObservable(
  target: TerminalTarget,
): boolean {
  return (
    target.kind === "paired_physical" || target.kind === "lan_gateway_device"
  );
}

/**
 * The health reading an assignment's target is allowed to report.
 *
 * A simulated target has no provider device behind it, so it may only report
 * unknown health from a simulated source; a physical target may never be
 * reported as a simulation. Either way this is advisory — collection
 * eligibility never consults it.
 */
export function acceptTerminalDeviceHealth(
  assignment: TerminalAssignment,
  health: TerminalDeviceHealth,
  source: TerminalHealthSource,
): AuthorityResult<TerminalDeviceHealth> {
  const physical = terminalTargetHealthIsObservable(assignment.target);
  if (!physical && (health !== "unknown" || source !== "simulated_target")) {
    return { ok: false, error: mismatch("health") };
  }
  if (physical && source === "simulated_target") {
    return { ok: false, error: mismatch("health.source") };
  }
  return { ok: true, value: health };
}

/** The provider payment identity, which exists exactly when the payment completed. */
export function terminalObservationPaymentId(
  observation: TerminalPaymentObservation,
): string | null {
  return observation.lifecycle.kind === "completed"
    ? observation.lifecycle.paymentId
    : null;
}

// Square Sandbox simulates Terminal checkouts but not Devices API pairing, so a
// simulated target belongs to development and a paired device to production.
function targetPermitsEnvironment(
  target: TerminalTarget,
  environment: PaymentEnvironment,
): boolean {
  if (target.kind === "lan_gateway_device") return true;
  // Square's Sandbox has no Point of Sale API, so a POS app target is a
  // production target like a paired device.
  return target.kind === "sandbox_simulated"
    ? environment === "development"
    : environment === "production";
}

function parseTerminalMoney(
  raw: unknown,
): ParseResult<TerminalPaymentObservation["amount"]> {
  if (!isRecord(raw) || !hasExactKeys(raw, ["amountMinor", "currency"])) {
    return invalid("terminalObservation.amount");
  }
  if (!Number.isSafeInteger(raw.amountMinor) || Number(raw.amountMinor) < 0) {
    return invalid("terminalObservation.amount.amountMinor");
  }
  if (
    typeof raw.currency !== "string" ||
    !CURRENCY_PATTERN.test(raw.currency)
  ) {
    return invalid("terminalObservation.amount.currency");
  }
  return {
    ok: true,
    value: { amountMinor: Number(raw.amountMinor), currency: raw.currency },
  };
}

function readText(raw: unknown, field: string): ParseResult<string> {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= IDENTITY_MAX_LENGTH &&
    raw.trim() === raw
    ? { ok: true, value: raw }
    : invalid(field);
}

function readTimestamp(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw)))
    return invalid(field);
  return { ok: true, value: raw };
}

function readEnum<const TValue extends string>(
  raw: unknown,
  field: string,
  values: readonly TValue[],
): ParseResult<TValue> {
  if (typeof raw !== "string") return invalid(field);
  for (const value of values) {
    if (raw === value) return { ok: true, value };
  }
  return invalid(field);
}

function mismatch(field: string): TerminalAuthorityError {
  return { code: "terminal_observation_mismatch", field };
}

function invalid(field: string): ParseResult<never> {
  return { ok: false, error: { code: "terminal_assignment_invalid", field } };
}
