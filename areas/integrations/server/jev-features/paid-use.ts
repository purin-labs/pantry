import type { BillingPaymentState } from "@purin-labs/control-api/portal/billing";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  DEFAULT_PLAN_ID,
  organisationPlan,
  parseOrganisationPlan,
  type OrganisationPlan,
} from "@purin-labs/tenancy/plans";
import type { TypeSafePaidUse } from "@purin-labs/agent/typesafe/evaluation-ledger";
import {
  typeSafeMonth,
  type TypeSafePurpose,
} from "@purin-labs/agent/typesafe/usage-store";

/**
 * Plan 88 section 4 and Plan 95 step 6: paid Jev use above the free use of
 * the month. The owner sets up payment in Stripe, turns paid use on and sets
 * a monthly spending limit. The Organisation Actor admits each paid call from
 * its own rows, with no outside call:
 *
 * - `jev_paid_use`: the owner's switch and limit.
 * - `jev_payment_account`: the Actor's copy of the payment state of the
 *   billing account. The Stripe webhook writes it, only on a change.
 * - `jev_paid_hold`: the 5-cent hold of each feature-hour of paid use. It
 *   marks the hour as a paid hour; the hourly record of that hour sends its
 *   tokens above the free use to the Stripe meter.
 */

/** The Jev price above the free use: 84 cents for 10 million input tokens. */
export const JEV_PRICE = Object.freeze({
  rateMinor: 84,
  rateUnits: 10_000_000,
  /** The input tokens that the free use of the `beta` plan covers. */
  includedUnits: 23_809_523,
});

/**
 * The hold of a feature-hour of paid use. A paid call runs only while the
 * month's charge with that call and this hold stay inside the spending limit.
 */
const JEV_HOLD_MINOR = 5;
const HOUR_MS = 60 * 60 * 1_000;

export type JevPaidFeature =
  "mail_classification" | "related_cases" | "screen_relevance";

export const JEV_FEATURE_OF_PURPOSE: Readonly<
  Record<TypeSafePurpose, JevPaidFeature>
> = {
  mail_classification: "mail_classification",
  case_context_discovery_relationship: "related_cases",
  screen_relevance: "screen_relevance",
};

export type JevPaymentAccount = Readonly<{
  /** The payment state of the billing account (Plan 95, "Billing"). */
  paymentState: BillingPaymentState;
  /** The Stripe customer that the meter events name, or null before payment setup. */
  stripeCustomerId: string | null;
}>;

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
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_payment_account (
    organisation_id TEXT PRIMARY KEY,
    payment_state TEXT NOT NULL CHECK (payment_state IN ('none', 'active', 'past_due', 'canceled')),
    stripe_customer_id TEXT,
    updated_at INTEGER NOT NULL
  )`);
  // An Actor from before Plan 95 step 3 can hold the Console form of the
  // table, whose rows named a Console reservation. That form goes, one time.
  if (
    sql
      .exec(
        "SELECT 1 FROM pragma_table_info('jev_paid_hold') WHERE name = 'reservation_id'",
      )
      .toArray().length > 0
  )
    sql.exec("DROP TABLE jev_paid_hold");
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_paid_hold (
    organisation_id TEXT NOT NULL,
    feature TEXT NOT NULL CHECK (feature IN ('mail_classification', 'related_cases', 'screen_relevance')),
    hour_start INTEGER NOT NULL,
    hold_minor INTEGER NOT NULL CHECK (hold_minor > 0),
    PRIMARY KEY (organisation_id, feature, hour_start)
  )`);
}

/** The catalog entry of the plan in the Actor's Organisation record. */
export function readJevPlan(sql: SqlStorage): OrganisationPlan {
  const row = sql
    .exec<{ plan: string }>("SELECT plan FROM organisation_meta LIMIT 1")
    .toArray()[0];
  return parseOrganisationPlan(row?.plan) ?? organisationPlan(DEFAULT_PLAN_ID);
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
    ? {
        enabled: false,
        spendingLimitMinor: readJevPlan(sql).defaultSpendingLimitMinor,
      }
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

/** An Organisation that never started payment setup has no row. */
export function readJevPaymentAccount(
  sql: SqlStorage,
  organisationId: OrganisationId,
): JevPaymentAccount {
  const row = sql
    .exec<{
      payment_state: BillingPaymentState;
      stripe_customer_id: string | null;
    }>(
      "SELECT payment_state, stripe_customer_id FROM jev_payment_account WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  return row === undefined
    ? { paymentState: "none", stripeCustomerId: null }
    : {
        paymentState: row.payment_state,
        stripeCustomerId: row.stripe_customer_id,
      };
}

/**
 * Stores the payment state that the billing account now has. It writes only
 * on a change, so a repeated webhook writes nothing. True when it wrote.
 */
export function writeJevPaymentAccount(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    account: JevPaymentAccount;
    now: number;
  }>,
): boolean {
  const current = readJevPaymentAccount(sql, input.organisationId);
  if (
    current.paymentState === input.account.paymentState &&
    current.stripeCustomerId === input.account.stripeCustomerId
  )
    return false;
  sql.exec(
    `INSERT INTO jev_payment_account (organisation_id, payment_state, stripe_customer_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET payment_state = excluded.payment_state,
      stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at`,
    input.organisationId,
    input.account.paymentState,
    input.account.stripeCustomerId,
    input.now,
  );
  return true;
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

/**
 * True when paid use is at its limit: the month's charge and the 5-cent hold
 * leave no room for a call.
 */
export function jevSpendingLimitReached(
  spentMinor: number,
  spendingLimitMinor: number,
): boolean {
  return spentMinor + JEV_HOLD_MINOR >= spendingLimitMinor;
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

/**
 * Admission of one Pantry-funded call above the free use, inside the ledger's
 * reservation transaction. Paid use must be on, the payment state must be
 * `active`, and the month's charge with this call plus the 5-cent hold must
 * be inside the spending limit. It reads only the Actor's own rows. `commit`
 * stores the hold of the feature-hour, if the hour has none. The Worker
 * registers it as the paid use of the TypeSafe ledger (`worker-ports.ts`).
 */
export const admitJevPaidUse: TypeSafePaidUse = (sql, call) => {
  const paid = readJevPaidUse(sql, call.organisationId);
  if (!paid.enabled) return { ok: false, error: "allowance_reached" };
  if (readJevPaymentAccount(sql, call.organisationId).paymentState !== "active")
    return { ok: false, error: "paid_use_unfunded" };
  const month = typeSafeMonth(call.now);
  const chargeMinor = jevMonthChargeMinor(
    readMonthlyPantryJevTokens(
      sql,
      call.organisationId,
      month.start,
      month.next,
    ) + call.reservedInputTokens,
  );
  if (chargeMinor + JEV_HOLD_MINOR > paid.spendingLimitMinor)
    return { ok: false, error: "spending_limit_reached" };
  const feature = JEV_FEATURE_OF_PURPOSE[call.purpose];
  const hourStart = Math.floor(call.now / HOUR_MS) * HOUR_MS;
  return {
    ok: true,
    value: {
      commit: () => {
        sql.exec(
          `INSERT INTO jev_paid_hold (organisation_id, feature, hour_start, hold_minor)
          VALUES (?, ?, ?, ?) ON CONFLICT (organisation_id, feature, hour_start) DO NOTHING`,
          call.organisationId,
          feature,
          hourStart,
          JEV_HOLD_MINOR,
        );
      },
    },
  };
};

/** True when the feature-hour is a paid hour. */
export function readJevPaidHold(
  sql: SqlStorage,
  organisationId: OrganisationId,
  feature: JevPaidFeature,
  hourStart: number,
): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM jev_paid_hold WHERE organisation_id = ? AND feature = ? AND hour_start = ?",
        organisationId,
        feature,
        hourStart,
      )
      .toArray().length > 0
  );
}
