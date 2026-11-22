import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { CueSource } from "../cues/engine";
import type { Result } from "@purin-labs/kernel/result";
import {
  assertRequiredColumns,
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
  type SchemaTransaction,
} from "@purin-labs/actor-runtime/actors/schema-migrations";

export type CueClaimInput = {
  organisationId: OrganisationId;
  subscriptionId: string;
  source: CueSource;
  nativeId: string;
  debounceMs: number;
  maxPerHour: number;
  now: number;
  leaseDurationMs: number;
};

export type CueClaimResult =
  | { kind: "claimed"; cueId: string; leaseId: string; leaseExpiresAt: number }
  | { kind: "duplicate"; cueId: string }
  | { kind: "in_progress"; cueId: string; retryAt: number }
  | { kind: "suppressed"; cueId: string; reason: "debounce" | "max_per_hour" };

export type ClaimedCueCompletionInput = {
  organisationId: OrganisationId;
  cueId: string;
  leaseId: string;
  outcome: "proposed" | "failed";
  now: number;
};

export type CueDeliveryError =
  | { code: "cue_not_found" }
  | { code: "cue_lease_mismatch" }
  | { code: "cue_invalid_input" };

type CueDeliveryRow = {
  cue_id: string;
  state: string;
  outcome: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
};

const HOUR_MS = 60 * 60 * 1000;
/**
 * A claim whose lease ended this long ago is abandoned: the queue's five
 * retries, 30 s apart, come well inside it. The alarm ends such a claim as a
 * failed delivery, so a message that went to the dead-letter queue leaves no
 * claim behind.
 */
export const CUE_CLAIM_ABANDONED_AFTER_MS = 15 * 60 * 1000;
const CUE_DELIVERY_COLUMNS = [
  "organisation_id",
  "cue_id",
  "dedup_key",
  "subscription_id",
  "source",
  "native_id",
  "state",
  "outcome",
  "lease_id",
  "lease_expires_at",
  "claimed_at",
  "delivered_at",
] as const;

/**
 * Version 1 is the table that the Organisation created before Refactor 15,
 * with a `scheduled` state that no code wrote. Version 2 removes it.
 */
const CUE_DELIVERY_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: "cue_delivery",
  currentVersion: 2,
  preservedTables: ["cue_delivery"],
  baseline: {
    version: 1,
    apply: (sql) => {
      createVersionOneCueDeliveryTable(sql);
      createCueDeliveryIndexes(sql);
    },
    validate: (sql) => assertTableExists(sql, "cue_delivery"),
  },
  steps: [
    {
      version: 2,
      apply: rebuildCueDeliveryWithoutScheduled,
      validate: validateCueDeliverySchema,
    },
  ],
};

export function createCueDeliverySchema(
  sql: SqlStorage,
  transaction: SchemaTransaction = (operation) => operation(),
): void {
  runSchemaMigrations(sql, CUE_DELIVERY_SCHEMA_PLAN, transaction);
}

function createVersionOneCueDeliveryTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS cue_delivery (
       organisation_id TEXT NOT NULL,
       cue_id TEXT PRIMARY KEY,
       dedup_key TEXT NOT NULL UNIQUE,
       subscription_id TEXT NOT NULL,
       source TEXT NOT NULL,
       native_id TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('claimed', 'scheduled', 'delivered')),
       outcome TEXT CHECK (outcome IS NULL OR outcome IN (
         'proposed', 'failed', 'debounce', 'max_per_hour'
       )),
       lease_id TEXT,
       lease_expires_at INTEGER,
       claimed_at INTEGER NOT NULL,
       scheduled_at INTEGER,
       delivered_at INTEGER,
       CHECK (
         (state = 'claimed' AND outcome IS NULL AND lease_id IS NOT NULL
          AND lease_expires_at IS NOT NULL AND scheduled_at IS NULL
          AND delivered_at IS NULL) OR
         (state = 'scheduled' AND outcome IS NULL AND lease_id IS NULL
          AND lease_expires_at IS NULL AND scheduled_at IS NOT NULL
          AND delivered_at IS NULL) OR
         (state = 'delivered' AND outcome IS NOT NULL AND lease_id IS NULL
          AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
       )
     )`,
  );
}

function rebuildCueDeliveryWithoutScheduled(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE cue_delivery_next (
       organisation_id TEXT NOT NULL,
       cue_id TEXT PRIMARY KEY,
       dedup_key TEXT NOT NULL UNIQUE,
       subscription_id TEXT NOT NULL,
       source TEXT NOT NULL,
       native_id TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('claimed', 'delivered')),
       outcome TEXT CHECK (outcome IS NULL OR outcome IN (
         'proposed', 'failed', 'debounce', 'max_per_hour'
       )),
       lease_id TEXT,
       lease_expires_at INTEGER,
       claimed_at INTEGER NOT NULL,
       delivered_at INTEGER,
       CHECK (
         (state = 'claimed' AND outcome IS NULL AND lease_id IS NOT NULL
          AND lease_expires_at IS NOT NULL AND delivered_at IS NULL) OR
         (state = 'delivered' AND outcome IS NOT NULL AND lease_id IS NULL
          AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
       )
     )`,
  );
  // No code wrote `scheduled`. A row in it would be a damaged one; it ends as
  // a failed delivery rather than an adapter.
  sql.exec(
    `INSERT INTO cue_delivery_next (
       organisation_id, cue_id, dedup_key, subscription_id, source, native_id,
       state, outcome, lease_id, lease_expires_at, claimed_at, delivered_at
     )
     SELECT organisation_id, cue_id, dedup_key, subscription_id, source, native_id,
       CASE WHEN state = 'scheduled' THEN 'delivered' ELSE state END,
       CASE WHEN state = 'scheduled' THEN 'failed' ELSE outcome END,
       lease_id, lease_expires_at, claimed_at,
       CASE WHEN state = 'scheduled' THEN scheduled_at ELSE delivered_at END
     FROM cue_delivery`,
  );
  sql.exec("DROP TABLE cue_delivery");
  sql.exec("ALTER TABLE cue_delivery_next RENAME TO cue_delivery");
  createCueDeliveryIndexes(sql);
}

function createCueDeliveryIndexes(sql: SqlStorage): void {
  sql.exec(
    `CREATE INDEX IF NOT EXISTS cue_delivery_subscription_time
     ON cue_delivery (organisation_id, subscription_id, delivered_at)`,
  );
}

function validateCueDeliverySchema(sql: SqlStorage): void {
  assertTableExists(sql, "cue_delivery");
  assertRequiredColumns(sql, "cue_delivery", CUE_DELIVERY_COLUMNS);
}

export function claimCueDelivery(
  sql: SqlStorage,
  input: CueClaimInput,
): Result<CueClaimResult, CueDeliveryError> {
  if (!validClaimInput(input)) {
    return { ok: false, error: { code: "cue_invalid_input" } };
  }

  const dedupKey = cueDedupKey(input);
  const existing = readCueDelivery(sql, input.organisationId, dedupKey);

  if (existing !== undefined) {
    return reclaimOrReplayCue(sql, input, dedupKey, existing);
  }

  const suppression = cueSuppressionReason(sql, input);
  const cueId = crypto.randomUUID();

  if (suppression !== null) {
    writeSuppressedCue(sql, input, cueId, dedupKey, suppression);
    return {
      ok: true,
      value: { kind: "suppressed", cueId, reason: suppression },
    };
  }

  return writeClaimedCue(sql, input, cueId, dedupKey);
}

export function completeClaimedCueDelivery(
  sql: SqlStorage,
  input: ClaimedCueCompletionInput,
): Result<null, CueDeliveryError> {
  const row = sql
    .exec<CueDeliveryRow>(
      `SELECT cue_id, state, outcome, lease_id, lease_expires_at
       FROM cue_delivery WHERE organisation_id = ? AND cue_id = ?`,
      input.organisationId,
      input.cueId,
    )
    .toArray()[0];

  if (row === undefined) {
    return { ok: false, error: { code: "cue_not_found" } };
  }

  if (row.state === "delivered") {
    return { ok: true, value: null };
  }

  if (row.lease_id !== input.leaseId || row.lease_expires_at === null) {
    return { ok: false, error: { code: "cue_lease_mismatch" } };
  }

  sql.exec(
    `UPDATE cue_delivery
     SET state = 'delivered', outcome = ?, lease_id = NULL,
         lease_expires_at = NULL, delivered_at = ?
     WHERE organisation_id = ? AND cue_id = ? AND state = 'claimed' AND lease_id = ?`,
    input.outcome,
    input.now,
    input.organisationId,
    input.cueId,
    input.leaseId,
  );
  return { ok: true, value: null };
}

function reclaimOrReplayCue(
  sql: SqlStorage,
  input: CueClaimInput,
  dedupKey: string,
  existing: CueDeliveryRow,
): Result<CueClaimResult, CueDeliveryError> {
  if (existing.state === "delivered") {
    return { ok: true, value: { kind: "duplicate", cueId: existing.cue_id } };
  }

  if (
    existing.lease_expires_at !== null &&
    existing.lease_expires_at > input.now
  ) {
    return {
      ok: true,
      value: {
        kind: "in_progress",
        cueId: existing.cue_id,
        retryAt: existing.lease_expires_at,
      },
    };
  }

  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = input.now + input.leaseDurationMs;
  sql.exec(
    `UPDATE cue_delivery
     SET lease_id = ?, lease_expires_at = ?, claimed_at = ?
     WHERE organisation_id = ? AND dedup_key = ? AND state = 'claimed'`,
    leaseId,
    leaseExpiresAt,
    input.now,
    input.organisationId,
    dedupKey,
  );
  return {
    ok: true,
    value: { kind: "claimed", cueId: existing.cue_id, leaseId, leaseExpiresAt },
  };
}

function writeSuppressedCue(
  sql: SqlStorage,
  input: CueClaimInput,
  cueId: string,
  dedupKey: string,
  suppression: "debounce" | "max_per_hour",
): void {
  sql.exec(
    `INSERT INTO cue_delivery (
       organisation_id, cue_id, dedup_key, subscription_id, source, native_id,
       state, outcome, lease_id, lease_expires_at, claimed_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, NULL, NULL, ?, ?)`,
    input.organisationId,
    cueId,
    dedupKey,
    input.subscriptionId,
    input.source,
    input.nativeId,
    suppression,
    input.now,
    input.now,
  );
}

function writeClaimedCue(
  sql: SqlStorage,
  input: CueClaimInput,
  cueId: string,
  dedupKey: string,
): Result<CueClaimResult, CueDeliveryError> {
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = input.now + input.leaseDurationMs;
  sql.exec(
    `INSERT INTO cue_delivery (
       organisation_id, cue_id, dedup_key, subscription_id, source, native_id,
       state, outcome, lease_id, lease_expires_at, claimed_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', NULL, ?, ?, ?, NULL)`,
    input.organisationId,
    cueId,
    dedupKey,
    input.subscriptionId,
    input.source,
    input.nativeId,
    leaseId,
    leaseExpiresAt,
    input.now,
  );
  return {
    ok: true,
    value: { kind: "claimed", cueId, leaseId, leaseExpiresAt },
  };
}

function cueSuppressionReason(
  sql: SqlStorage,
  input: CueClaimInput,
): "debounce" | "max_per_hour" | null {
  const last = sql
    .exec<{ delivered_at: number }>(
      `SELECT delivered_at
       FROM cue_delivery
       WHERE organisation_id = ? AND subscription_id = ? AND outcome = 'proposed'
       ORDER BY delivered_at DESC LIMIT 1`,
      input.organisationId,
      input.subscriptionId,
    )
    .toArray()[0];

  if (last !== undefined && last.delivered_at + input.debounceMs > input.now) {
    return "debounce";
  }

  const hourly = sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM cue_delivery
       WHERE organisation_id = ? AND subscription_id = ? AND outcome = 'proposed'
         AND delivered_at >= ?`,
      input.organisationId,
      input.subscriptionId,
      input.now - HOUR_MS,
    )
    .toArray()[0];
  return (hourly?.count ?? 0) >= input.maxPerHour ? "max_per_hour" : null;
}

/**
 * Ends each claim whose lease ended at least `CUE_CLAIM_ABANDONED_AFTER_MS`
 * ago as a failed delivery. The Organisation's alarm runs it; nothing else
 * would end a claim whose message went to the dead-letter queue.
 */
export function expireAbandonedCueClaims(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  return sql.exec(
    `UPDATE cue_delivery
     SET state = 'delivered', outcome = 'failed', lease_id = NULL,
         lease_expires_at = NULL, delivered_at = ?
     WHERE organisation_id = ? AND state = 'claimed' AND lease_expires_at <= ?`,
    now,
    organisationId,
    now - CUE_CLAIM_ABANDONED_AFTER_MS,
  ).rowsWritten;
}

/** When the next claim becomes abandoned, or null with no claim. */
export function nextAbandonedCueClaimAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ dueAt: number | null }>(
      "SELECT MIN(lease_expires_at) AS dueAt FROM cue_delivery WHERE state = 'claimed'",
    )
    .toArray()[0];
  return row?.dueAt === null || row?.dueAt === undefined
    ? null
    : row.dueAt + CUE_CLAIM_ABANDONED_AFTER_MS;
}

function readCueDelivery(
  sql: SqlStorage,
  organisationId: OrganisationId,
  dedupKey: string,
): CueDeliveryRow | undefined {
  return sql
    .exec<CueDeliveryRow>(
      `SELECT cue_id, state, outcome, lease_id, lease_expires_at
       FROM cue_delivery WHERE organisation_id = ? AND dedup_key = ?`,
      organisationId,
      dedupKey,
    )
    .toArray()[0];
}

function cueDedupKey(input: CueClaimInput): string {
  return `${input.subscriptionId}:${input.source}:${input.nativeId}`;
}

function validClaimInput(input: CueClaimInput): boolean {
  return (
    input.subscriptionId.length > 0 &&
    input.nativeId.length > 0 &&
    Number.isSafeInteger(input.debounceMs) &&
    input.debounceMs >= 0 &&
    Number.isSafeInteger(input.maxPerHour) &&
    input.maxPerHour > 0 &&
    Number.isSafeInteger(input.leaseDurationMs) &&
    input.leaseDurationMs > 0
  );
}

/**
 * Ends a cue claim that an Organisation cutover waits for after its lease
 * has expired: the cue is delivered as failed.
 */
export function settleExpiredOrganisationCutoverCue(
  sql: SqlStorage,
  organisationId: OrganisationId,
  settledAt: number,
): boolean {
  sql.exec(
    `UPDATE cue_delivery
     SET state = 'delivered',
         outcome = 'failed',
         lease_id = NULL,
         lease_expires_at = NULL,
         delivered_at = ?
     WHERE organisation_id = ?
       AND state = 'claimed'
       AND lease_expires_at <= ?`,
    settledAt,
    organisationId,
    settledAt,
  );
  const changed = sql
    .exec<{ count: number }>("SELECT changes() AS count")
    .toArray()[0];
  return changed?.count === 1;
}
