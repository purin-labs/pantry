import { backoffDelay, canonicalJson, sha256Hex } from "@purin-labs/std";
import {
  sendStripeJevMeterEvent,
  stripeBillingConfig,
  type StripeBillingBindings,
} from "@purin-labs/area-organisation-contract/server/billing/stripe-client";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  JEV_FEATURE_OF_PURPOSE,
  JEV_PRICE,
  readJevPaidHold,
  readJevPaymentAccount,
  type JevPaidFeature,
} from "./paid-use";
import {
  typeSafeMonth,
  type TypeSafePurpose,
} from "@purin-labs/agent/typesafe/usage-store";

/**
 * Plan 88 section 3: each closed UTC hour of Jev use on Pantry's key becomes one
 * record for each feature. The Organisation Actor seals the hour from the
 * TypeSafe ledger. The record is the Organisation's own record of use.
 *
 * Plan 95 step 6: a paid hour (a feature-hour with a paid hold) with tokens
 * above the free use of its month is `pending`. The Actor sends one Stripe
 * meter event for it, with those tokens only, and the record is then
 * `recorded`. The identifier of the event is fixed for each feature and
 * hour, so a repeated send charges nothing more. Every other hour is
 * `not_billed`.
 */
const HOUR_MS = 60 * 60 * 1_000;
/** A call settles within its 10 s timeout; an hour closes 5 minutes after it ends. */
const SEAL_GRACE_MS = 5 * 60 * 1_000;

/** Stripe takes a meter event of the last 35 days; an older hour is refused. */
const METER_EVENT_MAX_AGE_MS = 34 * 24 * HOUR_MS;
const MAX_RETRY_MS = HOUR_MS;

type SealedGroup = Readonly<{
  purpose: string;
  hour_start: number;
  input_tokens: number;
  evaluations: number;
  evaluation_ids: string;
}>;

function featureOfPurpose(purpose: string): JevPaidFeature | undefined {
  return Object.hasOwn(JEV_FEATURE_OF_PURPOSE, purpose)
    ? JEV_FEATURE_OF_PURPOSE[purpose as TypeSafePurpose]
    : undefined;
}

/** Called inside the owning Actor's synchronous schema transaction. */
export function createJevUsageRecordSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_usage_hour (
    organisation_id TEXT NOT NULL,
    feature TEXT NOT NULL CHECK (feature IN ('mail_classification', 'related_cases', 'screen_relevance')),
    hour_start INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    evaluations INTEGER NOT NULL CHECK (evaluations >= 0),
    source_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'recorded', 'not_billed', 'refused')),
    outcome TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    PRIMARY KEY (organisation_id, feature, hour_start)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_usage_cursor (
    organisation_id TEXT PRIMARY KEY,
    sealed_before INTEGER NOT NULL
  )`);
}

/**
 * Seals every closed hour after the cursor. Runs in one synchronous
 * transaction, so no hour is sealed twice.
 */
export function sealJevUsageHours(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): void {
  const sealedBefore = readCursor(sql, organisationId);
  const limit = Math.floor((now - SEAL_GRACE_MS) / HOUR_MS) * HOUR_MS;
  if (limit <= sealedBefore) return;
  const groups = sql
    .exec<SealedGroup>(
      `SELECT purpose, (reserved_at / ${HOUR_MS}) * ${HOUR_MS} AS hour_start,
        COALESCE(SUM(input_tokens), 0) AS input_tokens, COUNT(*) AS evaluations,
        GROUP_CONCAT(evaluation_id, ' ') AS evaluation_ids
      FROM typesafe_evaluation
      WHERE organisation_id = ? AND funding = 'pantry_platform'
        AND reserved_at >= ? AND reserved_at < ?
      GROUP BY purpose, hour_start`,
      organisationId,
      sealedBefore,
      limit,
    )
    .toArray();
  for (const group of groups) {
    const feature = featureOfPurpose(group.purpose);
    if (feature === undefined) continue;
    // A paid hour waits for its meter event. The tokens above the free use
    // are counted at the delivery, when each record of the month is sealed.
    const paid =
      group.input_tokens > 0 &&
      readJevPaidHold(sql, organisationId, feature, group.hour_start);
    sql.exec(
      `INSERT INTO jev_usage_hour
        (organisation_id, feature, hour_start, input_tokens, evaluations, source_digest, state, outcome, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organisation_id, feature, hour_start) DO NOTHING`,
      organisationId,
      feature,
      group.hour_start,
      group.input_tokens,
      group.evaluations,
      // The digest names the exact calls of the hour.
      canonicalJson({
        feature,
        hourStart: group.hour_start,
        inputTokens: group.input_tokens,
        evaluations: group.evaluation_ids.split(" ").filter(Boolean).sort(),
      }),
      paid ? "pending" : "not_billed",
      paid
        ? null
        : group.input_tokens === 0
          ? "no_measured_tokens"
          : "free_use",
      now,
    );
  }
  // Closed hours with no call need no cursor move: the next seal reads the
  // same empty hours again. So an idle Organisation writes nothing here.
  if (groups.length === 0) return;
  sql.exec(
    `INSERT INTO jev_usage_cursor (organisation_id, sealed_before) VALUES (?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET sealed_before = excluded.sealed_before`,
    organisationId,
    limit,
  );
}

/**
 * The alarm step of the Organisation actor: the next closed hour of Jev use
 * to seal for the Organisation of the Actor, or null.
 */
export function jevUsageDueAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM organisation_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const organisationId = parseOrganisationId(row.organisation_id);
  return organisationId.ok ? nextJevUsageAt(sql, organisationId.value) : null;
}

type PendingHour = Readonly<{
  feature: JevPaidFeature;
  hour_start: number;
  input_tokens: number;
  attempts: number;
}>;

/**
 * Sends the paid hours that are due to the Stripe meter of Pantry's own
 * Stripe account: one event for each hour, with the tokens above the free
 * use of the month. An hour inside the free use is `not_billed`.
 */
export async function deliverJevUsageHours(
  input: Readonly<{
    sql: SqlStorage;
    env: StripeBillingBindings;
    organisationId: OrganisationId;
    now: number;
    fetcher?: typeof fetch;
  }>,
): Promise<void> {
  const { sql, organisationId } = input;
  const due = sql
    .exec<PendingHour>(
      `SELECT feature, hour_start, input_tokens, attempts FROM jev_usage_hour
      WHERE organisation_id = ? AND state = 'pending' AND due_at <= ?
      ORDER BY hour_start, feature LIMIT 24`,
      organisationId,
      input.now,
    )
    .toArray();
  if (due.length === 0) return;
  const config = stripeBillingConfig(input.env);
  const customerId = readJevPaymentAccount(
    sql,
    organisationId,
  ).stripeCustomerId;
  for (const hour of due) {
    const paidTokens = paidTokensOfHour(sql, organisationId, hour);
    if (paidTokens === 0) {
      finish(sql, organisationId, hour, "not_billed", "inside_free_use");
      continue;
    }
    if (input.now - hour.hour_start > METER_EVENT_MAX_AGE_MS) {
      finish(sql, organisationId, hour, "refused", "meter_event_too_old");
      continue;
    }
    if (config === null || customerId === null) {
      retry(sql, organisationId, hour, input.now);
      continue;
    }
    const sent = await sendStripeJevMeterEvent(
      {
        config,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      },
      {
        customerId,
        value: paidTokens,
        identifier: await jevUsageEventId(
          organisationId,
          hour.feature,
          hour.hour_start,
        ),
        timestamp: Math.floor((hour.hour_start + HOUR_MS - 1) / 1_000),
      },
    );
    if (sent.ok)
      finish(sql, organisationId, hour, "recorded", `metered:${paidTokens}`);
    else if (sent.error.code === "stripe_billing_refused")
      finish(
        sql,
        organisationId,
        hour,
        "refused",
        `stripe_refused:${sent.error.status}`,
      );
    else retry(sql, organisationId, hour, input.now);
  }
}

/**
 * The event id of the record of one feature-hour. It is the identifier of the
 * Stripe meter event, so Stripe keeps one event for each record.
 */
async function jevUsageEventId(
  organisationId: OrganisationId,
  feature: JevPaidFeature,
  hourStart: number,
): Promise<string> {
  return `jev_${await sha256Hex(
    canonicalJson([
      "pantry_jev",
      organisationId,
      feature,
      new Date(hourStart).toISOString(),
    ]),
  )}`;
}

/**
 * The tokens of one paid record above the free use of its UTC month. The
 * records of a month count in the order of their hour. Inside one hour, the
 * records with no paid hold count first, so that the free use goes to them
 * and the paid records of the hour carry what is above it.
 */
function paidTokensOfHour(
  sql: SqlStorage,
  organisationId: OrganisationId,
  hour: PendingHour,
): number {
  const month = typeSafeMonth(hour.hour_start);
  const before =
    sql
      .exec<{ tokens: number }>(
        `SELECT COALESCE(SUM(record.input_tokens), 0) AS tokens
        FROM jev_usage_hour AS record
        LEFT JOIN jev_paid_hold AS hold
          ON hold.organisation_id = record.organisation_id
          AND hold.feature = record.feature AND hold.hour_start = record.hour_start
        WHERE record.organisation_id = ? AND record.hour_start >= ?
          AND (record.hour_start < ?
            OR (record.hour_start = ? AND (hold.feature IS NULL OR record.feature < ?)))`,
        organisationId,
        month.start,
        hour.hour_start,
        hour.hour_start,
        hour.feature,
      )
      .toArray()[0]?.tokens ?? 0;
  const above = (tokens: number) =>
    Math.max(0, tokens - JEV_PRICE.includedUnits);
  return above(before + hour.input_tokens) - above(before);
}

function finish(
  sql: SqlStorage,
  organisationId: OrganisationId,
  hour: PendingHour,
  state: "recorded" | "not_billed" | "refused",
  outcome: string,
): void {
  sql.exec(
    `UPDATE jev_usage_hour SET state = ?, outcome = ?, attempts = attempts + 1
    WHERE organisation_id = ? AND feature = ? AND hour_start = ? AND state = 'pending'`,
    state,
    outcome,
    organisationId,
    hour.feature,
    hour.hour_start,
  );
}

function retry(
  sql: SqlStorage,
  organisationId: OrganisationId,
  hour: PendingHour,
  now: number,
): void {
  sql.exec(
    `UPDATE jev_usage_hour SET attempts = attempts + 1, due_at = ?
    WHERE organisation_id = ? AND feature = ? AND hour_start = ? AND state = 'pending'`,
    now + backoffDelay(hour.attempts, 60_000, MAX_RETRY_MS),
    organisationId,
    hour.feature,
    hour.hour_start,
  );
}

/**
 * When the alarm must run next for the Jev usage records: to seal a closed
 * hour, or to send a paid hour that is due. Null when there is no such work.
 */
function nextJevUsageAt(
  sql: SqlStorage,
  organisationId: OrganisationId,
): number | null {
  const pending = sql
    .exec<{ at: number | null }>(
      "SELECT MIN(due_at) AS at FROM jev_usage_hour WHERE organisation_id = ? AND state = 'pending'",
      organisationId,
    )
    .toArray()[0]?.at;
  const unsealed = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(reserved_at) AS at FROM typesafe_evaluation
      WHERE organisation_id = ? AND funding = 'pantry_platform' AND reserved_at >= ?`,
      organisationId,
      readCursor(sql, organisationId),
    )
    .toArray()[0]?.at;
  const sealAt =
    unsealed === null || unsealed === undefined
      ? null
      : (Math.floor(unsealed / HOUR_MS) + 1) * HOUR_MS + SEAL_GRACE_MS;
  if (pending === null || pending === undefined) return sealAt;
  return sealAt === null ? pending : Math.min(pending, sealAt);
}

function readCursor(sql: SqlStorage, organisationId: OrganisationId): number {
  return (
    sql
      .exec<{ sealed_before: number }>(
        "SELECT sealed_before FROM jev_usage_cursor WHERE organisation_id = ?",
        organisationId,
      )
      .toArray()[0]?.sealed_before ?? 0
  );
}
