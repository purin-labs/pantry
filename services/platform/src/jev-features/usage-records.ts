import { canonicalJson, sha256Hex } from "@seams/std";
import { createAccountPlatformClient } from "../account-platform/client";
import { resolvePantryAccountBinding } from "../account-platform/binding";
import type { AccountPlatformBindings } from "../account-platform/config";
import type { AccountUsageRequest } from "../account-platform/types";
import type { OrganisationId } from "../ids";
import { listJevPaidHolds, readJevPaidHold } from "./paid-use";

/**
 * Plan 88 section 3: each closed UTC hour of Jev use on Pantry's key becomes one
 * usage record for each feature on the Account Platform meter
 * `pantry.jev_input_tokens`. The Organisation Actor seals the hour from the
 * TypeSafe ledger, then delivers it. The event id is fixed for each feature
 * and hour, so a repeated delivery adds nothing.
 */
const HOUR_MS = 60 * 60 * 1_000;
/** A call settles within its 10 s timeout; an hour closes 5 minutes after it ends. */
const SEAL_GRACE_MS = 5 * 60 * 1_000;
const MAX_RETRY_MS = HOUR_MS;

type JevFeature = "mail_classification" | "related_cases" | "screen_relevance";

const FEATURE_OF_PURPOSE: Readonly<Record<string, JevFeature>> = {
  mail_classification: "mail_classification",
  case_context_discovery_relationship: "related_cases",
  screen_relevance: "screen_relevance",
};

const PURPOSE_OF_FEATURE: Readonly<Record<JevFeature, string>> = {
  mail_classification: "mail_classification",
  related_cases: "case_context_discovery_relationship",
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
      WHERE organisation_id = ? AND funding = 'satyr_platform'
        AND reserved_at >= ? AND reserved_at < ?
      GROUP BY purpose, hour_start`,
      organisationId,
      sealedBefore,
      limit,
    )
    .toArray();
  const sealed: {
    purpose: string;
    hour_start: number;
    input_tokens: number;
    evaluations: number;
    evaluation_ids: string;
  }[] = [...groups];
  // A paid hold of an hour with no calls is released by a zero-token record.
  for (const hold of listJevPaidHolds(sql, organisationId, sealedBefore, limit))
    if (
      !sealed.some(
        (group) =>
          FEATURE_OF_PURPOSE[group.purpose] === hold.feature &&
          group.hour_start === hold.hourStart,
      )
    )
      sealed.push({
        purpose: PURPOSE_OF_FEATURE[hold.feature],
        hour_start: hold.hourStart,
        input_tokens: 0,
        evaluations: 0,
        evaluation_ids: "",
      });
  for (const group of sealed) {
    const feature = FEATURE_OF_PURPOSE[group.purpose];
    if (feature === undefined) continue;
    const held =
      readJevPaidHold(sql, organisationId, feature, group.hour_start) !== null;
    sql.exec(
      `INSERT INTO jev_usage_hour
        (organisation_id, feature, hour_start, input_tokens, evaluations, source_digest, state, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organisation_id, feature, hour_start) DO NOTHING`,
      organisationId,
      feature,
      group.hour_start,
      group.input_tokens,
      group.evaluations,
      // The digest names the exact calls of the hour; sha256 runs at delivery.
      canonicalJson({
        feature,
        hourStart: group.hour_start,
        inputTokens: group.input_tokens,
        evaluations: group.evaluation_ids.split(" ").filter(Boolean).sort(),
      }),
      group.input_tokens === 0 && !held ? "not_billed" : "pending",
      now,
    );
    if (group.input_tokens === 0 && !held)
      sql.exec(
        "UPDATE jev_usage_hour SET outcome = 'no_measured_tokens' WHERE organisation_id = ? AND feature = ? AND hour_start = ?",
        organisationId,
        feature,
        group.hour_start,
      );
  }
  sql.exec(
    `INSERT INTO jev_usage_cursor (organisation_id, sealed_before) VALUES (?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET sealed_before = excluded.sealed_before`,
    organisationId,
    limit,
  );
}

type PendingHour = Readonly<{
  feature: JevFeature;
  hour_start: number;
  input_tokens: number;
  source_digest: string;
  attempts: number;
}>;

/**
 * Delivers the sealed hours that are due to the meter. The Account Platform
 * prices them with the account's Jev price version (D9): inside the free use a
 * record charges nothing.
 */
export async function deliverJevUsageHours(
  input: Readonly<{
    sql: SqlStorage;
    env: AccountPlatformBindings;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<void> {
  const due = input.sql
    .exec<PendingHour>(
      `SELECT feature, hour_start, input_tokens, source_digest, attempts FROM jev_usage_hour
      WHERE organisation_id = ? AND state = 'pending' AND due_at <= ?
      ORDER BY hour_start, feature LIMIT 24`,
      input.organisationId,
      input.now,
    )
    .toArray();
  if (due.length === 0) return;
  const binding = await resolvePantryAccountBinding(
    input.env,
    input.organisationId,
  );
  if (!binding.ok) {
    for (const hour of due)
      retry(input.sql, input.organisationId, hour, input.now);
    return;
  }
  const client = createAccountPlatformClient(input.env);
  if (!client.ok) {
    for (const hour of due)
      retry(input.sql, input.organisationId, hour, input.now);
    return;
  }
  for (const hour of due) {
    const hourStart = new Date(hour.hour_start).toISOString();
    const request: AccountUsageRequest = {
      version: 1,
      eventId: JSON.stringify([
        "satyr_jev",
        binding.value.instanceId,
        hour.feature,
        hourStart,
      ]),
      instanceId: binding.value.instanceId,
      occurredAt: new Date(hour.hour_start + HOUR_MS - 1).toISOString(),
      meterId: "satyr.jev_input_tokens",
      unit: "input_token",
      quantity: hour.input_tokens,
      evidence: {
        kind: "satyr_jev_hour",
        hourStart,
        feature: hour.feature,
        // Inside the free use no record raises the month's charge. Paid use
        // holds each feature-hour first; the record settles or releases it.
        reservationId: readJevPaidHold(
          input.sql,
          input.organisationId,
          hour.feature,
          hour.hour_start,
        ),
        sourceRecordId: JSON.stringify([
          "satyr_jev",
          input.organisationId,
          hour.feature,
          hourStart,
        ]),
        sourceDigest: await sha256Hex(hour.source_digest),
      },
    };
    const receipt = await client.value.recordUsage(request);
    if (receipt.ok) {
      finish(
        input.sql,
        input.organisationId,
        hour,
        "recorded",
        receipt.value.kind === "charged"
          ? `charged:${receipt.value.amountMinor}`
          : receipt.value.reason,
      );
      continue;
    }
    switch (receipt.error.code) {
      case "price_unavailable":
      case "event_conflict":
      case "meter_unknown":
      case "scope_forbidden":
      case "insufficient_funds":
        finish(
          input.sql,
          input.organisationId,
          hour,
          "refused",
          receipt.error.code,
        );
        break;
      default:
        retry(input.sql, input.organisationId, hour, input.now);
    }
  }
}

/** When the alarm must run next for Jev usage records, or null. */
export function nextJevUsageAt(
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
      WHERE organisation_id = ? AND funding = 'satyr_platform' AND reserved_at >= ?`,
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
    now + Math.min(60_000 * 2 ** hour.attempts, MAX_RETRY_MS),
    organisationId,
    hour.feature,
    hour.hour_start,
  );
}
