import type { OrganisationId } from "@purin-labs/kernel/ids";
import { typeSafeMonth } from "@purin-labs/agent/typesafe/usage-store";

/**
 * Plan 88 section 4: paid Jev use above the free use of the month. The owner
 * sets it with a monthly spending limit.
 *
 * Plan 95 step 3: paid use is closed. Pantry no longer bills through the
 * Console, and Pantry's own Stripe billing (Plan 95 step 6) does not exist
 * yet. A call above the free use stops, as at the end of the free use. The
 * owner can still turn paid use off and change the limit, but not turn it on.
 */
export const JEV_PAID_USE_OPEN = false;

/** The Jev price above the free use: 84 cents for 10 million input tokens. */
const JEV_PRICE = Object.freeze({
  rateMinor: 84,
  rateUnits: 10_000_000,
  includedUnits: 23_809_523,
});
const JEV_DEFAULT_SPENDING_LIMIT_MINOR = 500;

type JevPaidUse = Readonly<{
  enabled: boolean;
  spendingLimitMinor: number;
}>;

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

/** The month's charge for a token total. */
function jevMonthChargeMinor(tokens: number): number {
  const above = Math.max(0, tokens - JEV_PRICE.includedUnits);
  return Math.ceil((above * JEV_PRICE.rateMinor) / JEV_PRICE.rateUnits);
}

/**
 * Input tokens on Pantry's key this UTC month: measured tokens for a settled
 * call, the reservation for a call with no measure.
 */
function readMonthlyPantryJevTokens(
  sql: SqlStorage,
  organisationId: OrganisationId,
  since: number,
  until: number,
): number {
  const row = sql
    .exec<{ tokens: number }>(
      `SELECT COALESCE(SUM(CASE
        WHEN settlement_state = 'settled' AND input_tokens IS NOT NULL THEN input_tokens
        ELSE reserved_input_tokens END), 0) AS tokens
      FROM typesafe_evaluation WHERE organisation_id = ? AND funding = 'pantry_platform'
        AND reserved_at >= ? AND reserved_at < ?`,
      organisationId,
      since,
      until,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row.tokens;
}

export function readJevPaidSpendMinor(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  const month = typeSafeMonth(now);
  return jevMonthChargeMinor(
    readMonthlyPantryJevTokens(sql, organisationId, month.start, month.next),
  );
}
