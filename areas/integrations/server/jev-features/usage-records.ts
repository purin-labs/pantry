import { canonicalJson } from "@purin-labs/std";
import type { OrganisationId } from "@purin-labs/kernel/ids";

/**
 * Plan 88 section 3: each closed UTC hour of Jev use on Pantry's key becomes one
 * record for each feature. The Organisation Actor seals the hour from the
 * TypeSafe ledger. The record is the Organisation's own record of use.
 *
 * Plan 95 step 3: Pantry no longer sends the hours to the Console meter. A
 * sealed hour is `not_billed`. Pantry's own billing (Plan 95 step 6) sends the
 * paid hours to Stripe.
 */
const HOUR_MS = 60 * 60 * 1_000;
/** A call settles within its 10 s timeout; an hour closes 5 minutes after it ends. */
const SEAL_GRACE_MS = 5 * 60 * 1_000;

type JevFeature = "mail_classification" | "related_cases" | "screen_relevance";

const FEATURE_OF_PURPOSE: Readonly<Record<string, JevFeature>> = {
  mail_classification: "mail_classification",
  case_context_discovery_relationship: "related_cases",
  screen_relevance: "screen_relevance",
};

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
    .exec<{
      purpose: string;
      hour_start: number;
      input_tokens: number;
      evaluations: number;
      evaluation_ids: string;
    }>(
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
    const feature = FEATURE_OF_PURPOSE[group.purpose];
    if (feature === undefined) continue;
    sql.exec(
      `INSERT INTO jev_usage_hour
        (organisation_id, feature, hour_start, input_tokens, evaluations, source_digest, state, outcome, due_at)
      VALUES (?, ?, ?, ?, ?, ?, 'not_billed', ?, ?)
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
      group.input_tokens === 0 ? "no_measured_tokens" : "unpriced",
      now,
    );
  }
  // An hour that waited for the Console meter is a record of use only. The
  // update finds no row after its first run, and then writes nothing.
  sql.exec(
    "UPDATE jev_usage_hour SET state = 'not_billed', outcome = 'unpriced' WHERE organisation_id = ? AND state = 'pending'",
    organisationId,
  );
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

/** When the alarm must run next to seal an hour of Jev use, or null. */
export function nextJevUsageAt(
  sql: SqlStorage,
  organisationId: OrganisationId,
): number | null {
  const unsealed = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(reserved_at) AS at FROM typesafe_evaluation
      WHERE organisation_id = ? AND funding = 'pantry_platform' AND reserved_at >= ?`,
      organisationId,
      readCursor(sql, organisationId),
    )
    .toArray()[0]?.at;
  return unsealed === null || unsealed === undefined
    ? null
    : (Math.floor(unsealed / HOUR_MS) + 1) * HOUR_MS + SEAL_GRACE_MS;
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
