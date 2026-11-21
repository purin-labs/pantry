import { assertRequiredColumns } from "../../actors/schema-migrations";
import type { OrganisationId } from "../../ids";

export type TypeSafePurpose =
  | "case_context_discovery_relationship"
  | "mail_classification"
  | "screen_relevance";

type DailyTypeSafeUsage = {
  evaluations: number;
  bytes: number;
  wall: number;
  cost: number;
  observedInputTokens: number;
  observedOutputTokens: number;
  unmeasuredEvaluations: number;
  chargedInputTokens: number;
};

export function readDailyTypeSafeUsage(
  sql: SqlStorage,
  organisationId: OrganisationId,
  purpose: TypeSafePurpose,
  now: number,
): DailyTypeSafeUsage {
  const dayMs = 24 * 60 * 60 * 1_000;
  const dayStart = Math.floor(now / dayMs) * dayMs;
  const row = sql
    .exec<DailyTypeSafeUsage>(
      `SELECT COUNT(*) AS evaluations, COALESCE(SUM(input_bytes), 0) AS bytes,
      COALESCE(SUM(reserved_wall_ms), 0) AS wall,
      COALESCE(SUM(MAX(reserved_cost_microusd, COALESCE(estimated_cost_microusd, 0))), 0) AS cost,
      COALESCE(SUM(input_tokens), 0) AS observedInputTokens,
      COALESCE(SUM(MAX(reserved_input_tokens, COALESCE(input_tokens, 0))), 0) AS chargedInputTokens,
      COALESCE(SUM(output_tokens), 0) AS observedOutputTokens,
      COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unmeasuredEvaluations
      FROM typesafe_evaluation WHERE organisation_id = ? AND purpose = ?
        AND reserved_at >= ? AND reserved_at < ?`,
      organisationId,
      purpose,
      dayStart,
      dayStart + dayMs,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row;
}

/** The first millisecond of the UTC month of `now`, and of the month after it. */
export function typeSafeMonth(
  now: number,
): Readonly<{ start: number; next: number }> {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    next: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/**
 * The TypeSafe cost of Pantry's key this UTC month, across every Jev feature
 * (Plan 88 section 3). A settled call counts its measured cost; a call with no
 * measure yet counts its reservation.
 */
export function readMonthlyPantryTypeSafeCost(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  const month = typeSafeMonth(now);
  const row = sql
    .exec<{ cost: number }>(
      `SELECT COALESCE(SUM(CASE
        WHEN settlement_state = 'settled' AND estimated_cost_microusd IS NOT NULL
        THEN estimated_cost_microusd ELSE reserved_cost_microusd END), 0) AS cost
      FROM typesafe_evaluation WHERE organisation_id = ? AND funding = 'pantry_platform'
        AND reserved_at >= ? AND reserved_at < ?`,
      organisationId,
      month.start,
      month.next,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row.cost;
}

/** Pantry-funded calls of the Organisation in the last second (the fair share). */
export function readRecentPantryTypeSafeCount(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  const row = sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM typesafe_evaluation
      WHERE organisation_id = ? AND funding = 'pantry_platform' AND reserved_at > ?`,
      organisationId,
      now - 1_000,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row.count;
}

export function readTypeSafeInFlightCount(
  sql: SqlStorage,
  organisationId: OrganisationId,
  purpose: TypeSafePurpose,
  now: number,
): number {
  // Invalidation prevents use of an answer; it does not cancel the provider request.
  const row = sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM typesafe_evaluation
    WHERE organisation_id = ? AND purpose = ? AND settlement_state = 'pending' AND expires_at > ?`,
      organisationId,
      purpose,
      now,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("typesafe_usage_corrupt");
  return row.count;
}

/** Called inside the owning Actor's synchronous schema transaction. */
export function createTypeSafeUsageSchema(sql: SqlStorage): void {
  sql.exec(typeSafeEvaluationTable("typesafe_evaluation"));
  sql.exec(`CREATE INDEX IF NOT EXISTS typesafe_evaluation_budget
    ON typesafe_evaluation (organisation_id, purpose, reserved_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS typesafe_evaluation_funding_month
    ON typesafe_evaluation (organisation_id, funding, reserved_at)`);
  assertRequiredColumns(
    sql,
    "typesafe_evaluation",
    TYPESAFE_EVALUATION_COLUMNS,
  );
}

const TYPESAFE_EVALUATION_COLUMNS = [
  "organisation_id",
  "purpose",
  "evaluation_id",
  "request_digest",
  "policy_revision",
  "funding",
  "connection_revision",
  "input_bytes",
  "disclosure_decision_digest",
  "reserved_input_tokens",
  "reserved_wall_ms",
  "reserved_cost_microusd",
  "estimated_cost_microusd",
  "input_tokens",
  "output_tokens",
  "reserved_at",
  "expires_at",
  "state",
  "settlement_state",
  "failure_code",
] as const;

function typeSafeEvaluationTable(name: string): string {
  // Withdrawn Plan 48 purposes stay in the CHECK so retained historical usage rows remain valid.
  return `CREATE TABLE IF NOT EXISTS ${name} (
    organisation_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (
      'case_context_discovery_relationship', 'mail_classification', 'screen_relevance',
      'ecommerce_execution_selection', 'ecommerce_response_verification', 'ecommerce_proposal_verification'
    )),
    evaluation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    funding TEXT CHECK (funding IN ('pantry_platform', 'organisation_byo')),
    connection_revision INTEGER CHECK (connection_revision > 0),
    disclosure_decision_digest TEXT,
    input_bytes INTEGER NOT NULL CHECK (input_bytes > 0),
    reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens > 0),
    reserved_wall_ms INTEGER NOT NULL CHECK (reserved_wall_ms > 0),
    reserved_cost_microusd INTEGER NOT NULL CHECK (reserved_cost_microusd > 0),
    estimated_cost_microusd INTEGER,
    input_tokens INTEGER CHECK (input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens >= 0),
    reserved_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'evaluated', 'failed', 'stale')),
    settlement_state TEXT NOT NULL DEFAULT 'pending' CHECK (settlement_state IN ('pending', 'settled')),
    failure_code TEXT,
    PRIMARY KEY (organisation_id, purpose, evaluation_id)
  )`;
}
