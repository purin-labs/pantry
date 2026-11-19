import type { Variant } from "@seams/type-utils";
import { hasExactKeys, isNonNegativeInteger } from "@seams/std";
import type {
  TerminalBlockedReason,
  TerminalCounterReadback,
  TerminalPairingReadback,
} from "../index.ts";

export type TerminalOperations = Readonly<{
  generatedAt: string;
  counters: readonly TerminalCounterReadback[];
  unreadableAssignments: number;
}>;

export type TerminalConfiguration =
  | Readonly<{ kind: "blocked"; reason: "commerce_system_missing" }>
  | Readonly<{
      kind: "ready";
      merchantId: string;
      /** Development binds Sandbox test devices; production pairs Terminals. */
      environment: "development" | "production";
      satyrLocations: readonly Readonly<{
        satyrLocationId: string;
        currency: string;
        supportedItems: readonly Readonly<{
          variantId: string;
          maxQuantityPerLine: number;
        }>[];
      }>[];
      squareAccounts: readonly Readonly<{
        integrationAccountId: string;
        providerAccountId: string;
        displayName: string;
        locations: readonly Readonly<{
          providerLocationId: string;
          displayName: string;
          country: string;
          currency: string;
        }>[];
      }>[];
      testDevices: readonly Readonly<{
        testDeviceId: string;
        label: string;
        expectedOutcome: "success" | "buyer_cancel" | "timeout";
      }>[];
    }>;

export type ReadyTerminalConfiguration = Variant<
  TerminalConfiguration,
  "ready"
>;

export type TerminalOperationsView = Readonly<{
  operations: TerminalOperations;
  configuration: TerminalConfiguration;
}>;

export function parsePairingEnvelope(raw: unknown): TerminalPairingReadback {
  const envelope = requireObject(raw, "terminal pairing response");
  requireExactKeys(envelope, ["ok", "pairing"], "terminal pairing response");
  const pairing = requireObject(envelope.pairing, "terminal pairing");
  requireExactKeys(
    pairing,
    ["deviceCodeId", "code", "providerLocationId", "pairBy", "status"],
    "terminal pairing",
  );
  if (
    envelope.ok !== true ||
    typeof pairing.deviceCodeId !== "string" ||
    typeof pairing.code !== "string" ||
    typeof pairing.providerLocationId !== "string" ||
    (pairing.pairBy !== null && typeof pairing.pairBy !== "string") ||
    (pairing.status !== "open" &&
      pairing.status !== "paired" &&
      pairing.status !== "expired")
  )
    throw new Error("Terminal pairing is invalid.");
  return {
    deviceCodeId: pairing.deviceCodeId,
    code: pairing.code,
    providerLocationId: pairing.providerLocationId,
    pairBy: pairing.pairBy,
    status: pairing.status,
  };
}

export function parseOperationsOnlyEnvelope(raw: unknown): TerminalOperations {
  const object = requireObject(raw, "terminal operations response");
  requireExactKeys(
    object,
    ["ok", "terminalOperations"],
    "terminal operations response",
  );
  if (object.ok !== true)
    throw new Error("Terminal operations are unavailable.");
  return parseOperations(object.terminalOperations);
}

export function parseOperationsEnvelope(raw: unknown): TerminalOperationsView {
  const object = requireObject(raw, "terminal operations response");
  requireExactKeys(
    object,
    ["ok", "terminalOperations", "configuration"],
    "terminal operations response",
  );
  if (object.ok !== true)
    throw new Error("Terminal operations are unavailable.");
  return {
    operations: parseOperations(object.terminalOperations),
    configuration: parseTerminalConfiguration(object.configuration),
  };
}

function parseTerminalConfiguration(raw: unknown): TerminalConfiguration {
  const object = requireObject(raw, "terminal configuration");
  if (object.kind === "blocked") {
    requireExactKeys(object, ["kind", "reason"], "terminal configuration");
    if (object.reason !== "commerce_system_missing") {
      throw new Error("Terminal configuration block is invalid.");
    }
    return { kind: "blocked", reason: object.reason };
  }
  requireExactKeys(
    object,
    [
      "kind",
      "merchantId",
      "environment",
      "satyrLocations",
      "squareAccounts",
      "testDevices",
    ],
    "terminal configuration",
  );
  if (
    object.kind !== "ready" ||
    typeof object.merchantId !== "string" ||
    (object.environment !== "development" &&
      object.environment !== "production") ||
    !Array.isArray(object.satyrLocations) ||
    !Array.isArray(object.squareAccounts) ||
    !Array.isArray(object.testDevices)
  ) {
    throw new Error("Terminal configuration is invalid.");
  }
  return {
    kind: "ready",
    merchantId: object.merchantId,
    environment: object.environment,
    satyrLocations: object.satyrLocations.map(parsePantryLocation),
    squareAccounts: object.squareAccounts.map(parseSquareAccount),
    testDevices: object.testDevices.map(parseTestDevice),
  };
}

function parsePantryLocation(
  raw: unknown,
): ReadyTerminalConfiguration["satyrLocations"][number] {
  const object = requireObject(raw, "Seams Checkout location");
  requireExactKeys(
    object,
    ["satyrLocationId", "currency", "supportedItems"],
    "Seams Checkout location",
  );
  if (
    typeof object.satyrLocationId !== "string" ||
    typeof object.currency !== "string" ||
    !Array.isArray(object.supportedItems)
  ) {
    throw new Error("Seams Checkout location is invalid.");
  }
  return {
    satyrLocationId: object.satyrLocationId,
    currency: object.currency,
    supportedItems: object.supportedItems.map(parseSupportedItem),
  };
}

function parseSupportedItem(raw: unknown): Readonly<{
  variantId: string;
  maxQuantityPerLine: number;
}> {
  const object = requireObject(raw, "counter item");
  requireExactKeys(object, ["variantId", "maxQuantityPerLine"], "counter item");
  if (
    typeof object.variantId !== "string" ||
    typeof object.maxQuantityPerLine !== "number" ||
    !Number.isSafeInteger(object.maxQuantityPerLine) ||
    object.maxQuantityPerLine < 1
  ) {
    throw new Error("Counter item is invalid.");
  }
  return {
    variantId: object.variantId,
    maxQuantityPerLine: object.maxQuantityPerLine,
  };
}

function parseSquareAccount(
  raw: unknown,
): ReadyTerminalConfiguration["squareAccounts"][number] {
  const object = requireObject(raw, "Square account");
  requireExactKeys(
    object,
    ["integrationAccountId", "providerAccountId", "displayName", "locations"],
    "Square account",
  );
  if (
    typeof object.integrationAccountId !== "string" ||
    typeof object.providerAccountId !== "string" ||
    typeof object.displayName !== "string" ||
    !Array.isArray(object.locations)
  ) {
    throw new Error("Square account is invalid.");
  }
  return {
    integrationAccountId: object.integrationAccountId,
    providerAccountId: object.providerAccountId,
    displayName: object.displayName,
    locations: object.locations.map(parseSquareLocation),
  };
}

function parseSquareLocation(
  raw: unknown,
): ReadyTerminalConfiguration["squareAccounts"][number]["locations"][number] {
  const object = requireObject(raw, "Square location");
  requireExactKeys(
    object,
    ["providerLocationId", "displayName", "country", "currency"],
    "Square location",
  );
  if (
    typeof object.providerLocationId !== "string" ||
    typeof object.displayName !== "string" ||
    typeof object.country !== "string" ||
    typeof object.currency !== "string"
  ) {
    throw new Error("Square location is invalid.");
  }
  return {
    providerLocationId: object.providerLocationId,
    displayName: object.displayName,
    country: object.country,
    currency: object.currency,
  };
}

function parseTestDevice(
  raw: unknown,
): ReadyTerminalConfiguration["testDevices"][number] {
  const object = requireObject(raw, "Square Sandbox test device");
  requireExactKeys(
    object,
    ["testDeviceId", "label", "expectedOutcome"],
    "Square Sandbox test device",
  );
  if (
    typeof object.testDeviceId !== "string" ||
    typeof object.label !== "string" ||
    (object.expectedOutcome !== "success" &&
      object.expectedOutcome !== "buyer_cancel" &&
      object.expectedOutcome !== "timeout")
  ) {
    throw new Error("Square Sandbox test device is invalid.");
  }
  return {
    testDeviceId: object.testDeviceId,
    label: object.label,
    expectedOutcome: object.expectedOutcome,
  };
}

function parseOperations(raw: unknown): TerminalOperations {
  const object = requireObject(raw, "terminal operations");
  requireExactKeys(
    object,
    [
      "schemaVersion",
      "organisationId",
      "generatedAt",
      "counters",
      "unreadableAssignments",
    ],
    "terminal operations",
  );
  if (object.schemaVersion !== "satyr.terminal-operations.v2") {
    throw new Error(
      "Terminal operations are reported in a version this portal cannot read.",
    );
  }
  if (
    !Array.isArray(object.counters) ||
    typeof object.generatedAt !== "string" ||
    typeof object.unreadableAssignments !== "number"
  ) {
    throw new Error("Terminal operations are invalid.");
  }
  return {
    generatedAt: object.generatedAt,
    counters: object.counters.map(parseCounter),
    unreadableAssignments: object.unreadableAssignments,
  };
}

function parseCounter(raw: unknown): TerminalCounterReadback {
  const object = requireObject(raw, "terminal counter");
  requireExactKeys(
    object,
    [
      "satyrLocationId",
      "blockedReason",
      "assignment",
      "credentialHealth",
      "webhook",
      "paymentsLinked",
    ],
    "terminal counter",
  );
  if (
    typeof object.satyrLocationId !== "string" ||
    typeof object.paymentsLinked !== "boolean"
  ) {
    throw new Error("Terminal counter is invalid.");
  }
  return {
    satyrLocationId: object.satyrLocationId,
    blockedReason: parseBlockedReason(object.blockedReason),
    assignment: parseAssignment(object.assignment),
    credentialHealth: parseCredentialHealth(object.credentialHealth),
    webhook: parseWebhook(object.webhook),
    paymentsLinked: object.paymentsLinked,
  };
}

function parseBlockedReason(raw: unknown): TerminalBlockedReason | null {
  if (raw === null) return null;
  if (raw === "assignment_retired") return raw;
  throw new Error("Terminal counter state is invalid.");
}

function parseAssignment(raw: unknown): TerminalCounterReadback["assignment"] {
  const object = requireObject(raw, "terminal assignment");
  requireExactKeys(
    object,
    [
      "assignmentId",
      "revision",
      "merchantId",
      "integrationAccountId",
      "capabilityRevision",
      "capabilityCurrent",
      "providerLocationId",
      "targetKind",
      "deviceId",
      "adapterVersion",
      "environment",
      "healthIsObservable",
    ],
    "terminal assignment",
  );
  const targetKind = object.targetKind;
  const environment = object.environment;
  if (
    typeof object.assignmentId !== "string" ||
    typeof object.revision !== "number" ||
    typeof object.merchantId !== "string" ||
    typeof object.integrationAccountId !== "string" ||
    typeof object.capabilityRevision !== "number" ||
    !Number.isSafeInteger(object.capabilityRevision) ||
    object.capabilityRevision < 1 ||
    typeof object.capabilityCurrent !== "boolean" ||
    typeof object.providerLocationId !== "string" ||
    typeof object.deviceId !== "string" ||
    typeof object.adapterVersion !== "string" ||
    typeof object.healthIsObservable !== "boolean" ||
    (targetKind !== "sandbox_simulated" &&
      targetKind !== "paired_physical" &&
      targetKind !== "lan_gateway_device") ||
    (environment !== "development" && environment !== "production")
  ) {
    throw new Error("Terminal assignment is invalid.");
  }
  return {
    assignmentId: object.assignmentId,
    revision: object.revision,
    merchantId: object.merchantId,
    integrationAccountId: object.integrationAccountId,
    capabilityRevision: object.capabilityRevision,
    capabilityCurrent: object.capabilityCurrent,
    providerLocationId: object.providerLocationId,
    targetKind,
    deviceId: object.deviceId,
    adapterVersion: object.adapterVersion,
    environment,
    healthIsObservable: object.healthIsObservable,
  };
}

function parseCredentialHealth(
  raw: unknown,
): TerminalCounterReadback["credentialHealth"] {
  switch (raw) {
    case "active":
    case "degraded":
    case "reauth_required":
    case "disabled":
    case "revoked":
    case "unavailable":
      return raw;
    default:
      throw new Error("Terminal credential health is invalid.");
  }
}

function parseWebhook(raw: unknown): TerminalCounterReadback["webhook"] {
  const object = requireObject(raw, "terminal webhook");
  if (object.kind === "unconfigured") {
    requireExactKeys(object, ["kind"], "terminal webhook");
    return { kind: "unconfigured" };
  }
  requireExactKeys(
    object,
    ["kind", "lifecycle", "credentialCurrent", "lastVerifiedAt", "updatedAt"],
    "terminal webhook",
  );
  if (
    object.kind !== "configured" ||
    (object.lifecycle !== "pending" &&
      object.lifecycle !== "live" &&
      object.lifecycle !== "degraded" &&
      object.lifecycle !== "disabled" &&
      object.lifecycle !== "revoked") ||
    typeof object.credentialCurrent !== "boolean" ||
    (object.lastVerifiedAt !== null &&
      !isNonNegativeInteger(object.lastVerifiedAt)) ||
    !isNonNegativeInteger(object.updatedAt)
  ) {
    throw new Error("Terminal webhook is invalid.");
  }
  return {
    kind: "configured",
    lifecycle: object.lifecycle,
    credentialCurrent: object.credentialCurrent,
    lastVerifiedAt: object.lastVerifiedAt,
    updatedAt: object.updatedAt,
  };
}

function requireObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

function requireExactKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (!hasExactKeys(raw, keys)) throw new Error(`${field} fields are invalid.`);
}
