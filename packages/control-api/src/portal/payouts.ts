import { exhaustiveList, hasExactKeys, isNonNegativeInteger } from "@purin-labs/std";
import type { SupplierPayoutStateKind } from "../index.ts";

const PAYOUT_STATES = exhaustiveList<SupplierPayoutStateKind>()([
  "approval_pending",
  "approved",
  "submitting",
  "provider_action_required",
  "provider_pending",
  "settled",
  "return_pending",
  "returned",
  "reversal_pending",
  "reversed",
  "failed",
  "indeterminate",
  "cancelled",
]);

export type SupplierPayout = Readonly<{
  payoutId: string;
  payableId: string;
  supplierId: string;
  rail: "gmo_aozora_private" | "wise_enterprise_payouts";
  destinationRevisionId: string;
  currency: string;
  recipientAmountMinor: number;
  feeCeilingMinor: number;
  state: SupplierPayoutStateKind;
  approved: boolean;
  revision: number;
}>;

export type PayoutAuditEvent = Readonly<{
  cursor: number;
  providerEventId: string;
  rail: SupplierPayout["rail"];
  integrationAccountId: string;
  environment: "development" | "production";
  targetKind: "request" | "transfer";
  targetId: string;
  payloadDigest: string;
  amountMinor: number;
  currency: string;
  observationKind: string;
  occurredAt: number;
  receivedAt: number;
  status: "pending" | "applied" | "conflict";
}>;

/** A payout with when it was proposed and when it last changed. */
export type DatedSupplierPayout = SupplierPayout &
  Readonly<{ createdAt: number; updatedAt: number }>;

export function parseDatedPayout(raw: unknown): DatedSupplierPayout {
  const { createdAt, updatedAt, ...payout } = requireObject(
    raw,
    "dated supplier payout",
  );
  if (!isNonNegativeInteger(createdAt) || !isNonNegativeInteger(updatedAt))
    throw new Error("Supplier payout times are invalid.");
  return { ...parsePayout(payout), createdAt, updatedAt };
}

export function parsePayouts(raw: unknown): readonly SupplierPayout[] {
  const object = requireObject(raw, "supplier payout response");
  requireExactKeys(
    object,
    ["ok", "supplierPayouts"],
    "supplier payout response",
  );
  if (object.ok !== true || !Array.isArray(object.supplierPayouts)) {
    throw new Error("Supplier payouts are unavailable.");
  }
  return object.supplierPayouts.map(parsePayout);
}

function parsePayout(raw: unknown): SupplierPayout {
  const object = requireObject(raw, "supplier payout");
  requireExactKeys(
    object,
    [
      "payoutId",
      "payableId",
      "supplierId",
      "rail",
      "destinationRevisionId",
      "currency",
      "recipientAmountMinor",
      "feeCeilingMinor",
      "state",
      "approved",
      "revision",
    ],
    "supplier payout",
  );
  const state = object.state;
  const rail = object.rail;
  if (!isPayoutState(state)) {
    throw new Error("Supplier payout state is invalid.");
  }
  if (rail !== "gmo_aozora_private" && rail !== "wise_enterprise_payouts") {
    throw new Error("Supplier payout rail is invalid.");
  }
  if (
    typeof object.payoutId !== "string" ||
    typeof object.payableId !== "string" ||
    typeof object.supplierId !== "string" ||
    typeof object.destinationRevisionId !== "string" ||
    typeof object.currency !== "string" ||
    typeof object.recipientAmountMinor !== "number" ||
    typeof object.feeCeilingMinor !== "number" ||
    typeof object.approved !== "boolean" ||
    typeof object.revision !== "number"
  ) {
    throw new Error("Supplier payout is invalid.");
  }
  return {
    payoutId: object.payoutId,
    payableId: object.payableId,
    supplierId: object.supplierId,
    rail,
    destinationRevisionId: object.destinationRevisionId,
    currency: object.currency,
    recipientAmountMinor: object.recipientAmountMinor,
    feeCeilingMinor: object.feeCeilingMinor,
    state,
    approved: object.approved,
    revision: object.revision,
  };
}

export function parseAuditEvent(raw: unknown): PayoutAuditEvent {
  const object = requireObject(raw, "supplier payout audit event");
  requireExactKeys(
    object,
    [
      "cursor",
      "providerEventId",
      "rail",
      "integrationAccountId",
      "environment",
      "targetKind",
      "targetId",
      "payloadDigest",
      "amountMinor",
      "currency",
      "observation",
      "occurredAt",
      "receivedAt",
      "status",
    ],
    "supplier payout audit event",
  );
  const observation = requireObject(
    object.observation,
    "supplier payout observation",
  );
  if (
    !isNonNegativeInteger(object.cursor) ||
    typeof object.providerEventId !== "string" ||
    !isPayoutRail(object.rail) ||
    typeof object.integrationAccountId !== "string" ||
    (object.environment !== "development" &&
      object.environment !== "production") ||
    (object.targetKind !== "request" && object.targetKind !== "transfer") ||
    typeof object.targetId !== "string" ||
    typeof object.payloadDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(object.payloadDigest) ||
    !isNonNegativeInteger(object.amountMinor) ||
    typeof object.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(object.currency) ||
    typeof observation.kind !== "string" ||
    !isNonNegativeInteger(object.occurredAt) ||
    !isNonNegativeInteger(object.receivedAt) ||
    (object.status !== "pending" &&
      object.status !== "applied" &&
      object.status !== "conflict")
  ) {
    throw new Error("Supplier payout audit event is invalid.");
  }
  return {
    cursor: object.cursor,
    providerEventId: object.providerEventId,
    rail: object.rail,
    integrationAccountId: object.integrationAccountId,
    environment: object.environment,
    targetKind: object.targetKind,
    targetId: object.targetId,
    payloadDigest: object.payloadDigest,
    amountMinor: object.amountMinor,
    currency: object.currency,
    observationKind: observation.kind,
    occurredAt: object.occurredAt,
    receivedAt: object.receivedAt,
    status: object.status,
  };
}

function isPayoutState(value: unknown): value is SupplierPayoutStateKind {
  return (
    typeof value === "string" &&
    PAYOUT_STATES.some(payoutStateMatches.bind(null, value))
  );
}

function payoutStateMatches(
  value: string,
  state: SupplierPayoutStateKind,
): boolean {
  return value === state;
}

function isPayoutRail(value: unknown): value is SupplierPayout["rail"] {
  return value === "gmo_aozora_private" || value === "wise_enterprise_payouts";
}

export function requireObject(
  raw: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

export function requireExactKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (!hasExactKeys(raw, keys)) throw new Error(`${field} fields are invalid.`);
}
