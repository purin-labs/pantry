import { satyrJevExecutionIdV1 as pantryJevExecutionIdV1 } from "@seams-internal/console-shared/accountPlatform";
import { resolvePantryAccountBinding } from "../account-platform/binding";
import { createAccountPlatformClient } from "../account-platform/client";
import type { AccountPlatformBindings } from "../account-platform/config";
import type { OrganisationId } from "../ids";

/**
 * Plan 88 section 4: paid Jev use above the free use of the month. The owner
 * turns it on with a monthly spending limit. Each feature-hour of paid use
 * holds 5 cents on the Account Platform first; the hourly record of that
 * feature-hour settles the hold, or releases it when the hour charged nothing.
 */
export const JEV_PRICE = Object.freeze({
  /** The price of isolated test accounts. */
  version: "satyr-jev-input-tokens-v1",
  /** The price that the owner approved for customer accounts (D9, 7 November 2026). */
  customerVersion: "satyr-jev-input-tokens-customer-v1",
  rateMinor: 84,
  rateUnits: 10_000_000,
  includedUnits: 23_809_523,
});
export const JEV_HOLD_MINOR = 5;
export const JEV_DEFAULT_SPENDING_LIMIT_MINOR = 500;
export const JEV_MAX_SPENDING_LIMIT_MINOR = 100_000;
const HOUR_MS = 60 * 60 * 1_000;
/** One cent of each hold covers the rounding of the month's charge. */
const HOLD_TOKENS = Math.floor(
  ((JEV_HOLD_MINOR - 1) * JEV_PRICE.rateUnits) / JEV_PRICE.rateMinor,
);

export type JevPaidFeature =
  "mail_classification" | "related_cases" | "screen_relevance";

export const JEV_FEATURE_OF_PURPOSE: Readonly<Record<string, JevPaidFeature>> =
  {
    mail_classification: "mail_classification",
    case_context_discovery_relationship: "related_cases",
    screen_relevance: "screen_relevance",
  };

export type JevPaidUse = Readonly<{
  enabled: boolean;
  spendingLimitMinor: number;
}>;

export type JevPaidRefusal =
  "allowance_reached" | "spending_limit_reached" | "paid_use_unfunded";

/** Called inside the owning Actor's synchronous schema transaction. */
export function createJevPaidUseSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_paid_use (
    organisation_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    spending_limit_minor INTEGER NOT NULL CHECK (spending_limit_minor >= 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_paid_hold (
    organisation_id TEXT NOT NULL,
    feature TEXT NOT NULL CHECK (feature IN ('mail_classification', 'related_cases', 'screen_relevance')),
    hour_start INTEGER NOT NULL,
    reservation_id TEXT NOT NULL,
    hold_minor INTEGER NOT NULL CHECK (hold_minor > 0),
    PRIMARY KEY (organisation_id, feature, hour_start)
  )`);
}

export function readJevPaidUse(
  sql: SqlStorage,
  organisationId: OrganisationId,
): JevPaidUse {
  const row = sql
    .exec<{ enabled: number; spending_limit_minor: number }>(
      "SELECT enabled, spending_limit_minor FROM jev_paid_use WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  return row === undefined
    ? { enabled: false, spendingLimitMinor: JEV_DEFAULT_SPENDING_LIMIT_MINOR }
    : {
        enabled: row.enabled === 1,
        spendingLimitMinor: row.spending_limit_minor,
      };
}

export function writeJevPaidUse(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    enabled: boolean;
    spendingLimitMinor: number;
    actorId: string;
    now: number;
  }>,
): void {
  sql.exec(
    `INSERT INTO jev_paid_use (organisation_id, enabled, spending_limit_minor, revision, updated_by, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET enabled = excluded.enabled,
      spending_limit_minor = excluded.spending_limit_minor, revision = revision + 1,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    input.organisationId,
    input.enabled ? 1 : 0,
    input.spendingLimitMinor,
    input.actorId,
    input.now,
  );
}

/** The month's charge for a token total, as the Account Platform computes it. */
export function jevMonthChargeMinor(tokens: number): number {
  const above = Math.max(0, tokens - JEV_PRICE.includedUnits);
  return Math.ceil((above * JEV_PRICE.rateMinor) / JEV_PRICE.rateUnits);
}

/**
 * Input tokens on Pantry's key this UTC month: measured tokens for a settled
 * call, the reservation for a call with no measure.
 */
export function readMonthlyPantryJevTokens(
  sql: SqlStorage,
  organisationId: OrganisationId,
  since: number,
  until: number,
  purpose?: string,
): number {
  const row = sql
    .exec<{ tokens: number }>(
      `SELECT COALESCE(SUM(CASE
        WHEN settlement_state = 'settled' AND input_tokens IS NOT NULL THEN input_tokens
        ELSE reserved_input_tokens END), 0) AS tokens
      FROM typesafe_evaluation WHERE organisation_id = ? AND funding = 'satyr_platform'
        AND reserved_at >= ? AND reserved_at < ? AND (? IS NULL OR purpose = ?)`,
      organisationId,
      since,
      until,
      purpose ?? null,
      purpose ?? null,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row.tokens;
}

function monthBounds(now: number): Readonly<{ start: number; next: number }> {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    next: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

export function readJevPaidSpendMinor(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  const month = monthBounds(now);
  return jevMonthChargeMinor(
    readMonthlyPantryJevTokens(sql, organisationId, month.start, month.next),
  );
}

/**
 * Synchronous admission of one Pantry-funded call above the free use, inside
 * the ledger's reservation transaction.
 */
export function admitJevPaidCall(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    purpose: string;
    reservedInputTokens: number;
    now: number;
  }>,
): JevPaidRefusal | null {
  const paid = readJevPaidUse(sql, input.organisationId);
  if (!paid.enabled) return "allowance_reached";
  const month = monthBounds(input.now);
  const monthTokens = readMonthlyPantryJevTokens(
    sql,
    input.organisationId,
    month.start,
    month.next,
  );
  if (
    jevMonthChargeMinor(monthTokens + input.reservedInputTokens) >
    paid.spendingLimitMinor
  )
    return "spending_limit_reached";
  const feature = JEV_FEATURE_OF_PURPOSE[input.purpose];
  if (feature === undefined) return "allowance_reached";
  const hourStart = Math.floor(input.now / HOUR_MS) * HOUR_MS;
  const hold = readHold(sql, input.organisationId, feature, hourStart);
  if (hold === null) return "paid_use_unfunded";
  const hourTokens = readMonthlyPantryJevTokens(
    sql,
    input.organisationId,
    hourStart,
    hourStart + HOUR_MS,
    input.purpose,
  );
  // The hold must cover the rise of the month's charge in this feature-hour.
  if (hourTokens + input.reservedInputTokens > HOLD_TOKENS)
    return "paid_use_unfunded";
  return null;
}

export function readJevPaidHold(
  sql: SqlStorage,
  organisationId: OrganisationId,
  feature: string,
  hourStart: number,
): string | null {
  return (
    readHold(sql, organisationId, feature, hourStart)?.reservationId ?? null
  );
}

/** Holds of sealed hours, so that each hold is settled or released. */
export function listJevPaidHolds(
  sql: SqlStorage,
  organisationId: OrganisationId,
  since: number,
  until: number,
): readonly Readonly<{ feature: JevPaidFeature; hourStart: number }>[] {
  return sql
    .exec<{ feature: JevPaidFeature; hour_start: number }>(
      "SELECT feature, hour_start FROM jev_paid_hold WHERE organisation_id = ? AND hour_start >= ? AND hour_start < ?",
      organisationId,
      since,
      until,
    )
    .toArray()
    .map((row) => ({ feature: row.feature, hourStart: row.hour_start }));
}

/**
 * Before a Pantry-funded call that the free use no longer covers: when paid use
 * is on, hold 5 cents on the Account Platform for this feature-hour, once.
 * The ledger's reservation then admits the call against the hold.
 */
export async function ensureJevPaidHold(
  input: Readonly<{
    sql: SqlStorage;
    env: AccountPlatformBindings;
    organisationId: OrganisationId;
    purpose: string;
    freeUseCovers: boolean;
    now: number;
  }>,
): Promise<void> {
  const feature = JEV_FEATURE_OF_PURPOSE[input.purpose];
  if (
    input.freeUseCovers ||
    feature === undefined ||
    !readJevPaidUse(input.sql, input.organisationId).enabled
  )
    return;
  const hourStart = Math.floor(input.now / HOUR_MS) * HOUR_MS;
  if (readHold(input.sql, input.organisationId, feature, hourStart) !== null)
    return;
  const binding = await resolvePantryAccountBinding(
    input.env,
    input.organisationId,
  );
  if (!binding.ok) return;
  const client = createAccountPlatformClient(input.env);
  if (!client.ok) return;
  const executionId = pantryJevExecutionIdV1(
    feature,
    new Date(hourStart).toISOString(),
  );
  const reserved = await client.value.reserveFunds({
    version: 1,
    operationId: JSON.stringify([
      "satyr_jev_hold",
      binding.value.instanceId,
      executionId,
    ]),
    instanceId: binding.value.instanceId,
    executionId,
    requestedMinor: JEV_HOLD_MINOR,
    priceVersion: jevPriceVersion(binding.value.feePolicy.kind),
  });
  if (
    !reserved.ok ||
    reserved.value.reservation.kind !== "reserved" ||
    reserved.value.reservation.executionId !== executionId
  )
    return;
  input.sql.exec(
    `INSERT INTO jev_paid_hold (organisation_id, feature, hour_start, reservation_id, hold_minor)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (organisation_id, feature, hour_start) DO NOTHING`,
    input.organisationId,
    feature,
    hourStart,
    reserved.value.reservation.reservationId,
    JEV_HOLD_MINOR,
  );
}

/**
 * The Jev price version of an account. The Account Platform applies the same
 * rule: an isolated test account (the turn test fee policy) uses the test
 * version; every other account uses the customer version.
 */
export function jevPriceVersion(
  feePolicy: "customer_unpriced" | "isolated_e2e_completed_turn",
): string {
  return feePolicy === "isolated_e2e_completed_turn"
    ? JEV_PRICE.version
    : JEV_PRICE.customerVersion;
}

function readHold(
  sql: SqlStorage,
  organisationId: OrganisationId,
  feature: string,
  hourStart: number,
): Readonly<{ reservationId: string }> | null {
  const row = sql
    .exec<{ reservation_id: string }>(
      "SELECT reservation_id FROM jev_paid_hold WHERE organisation_id = ? AND feature = ? AND hour_start = ?",
      organisationId,
      feature,
      hourStart,
    )
    .toArray()[0];
  return row === undefined ? null : { reservationId: row.reservation_id };
}
