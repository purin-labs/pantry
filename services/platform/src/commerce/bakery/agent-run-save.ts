import type { OrganisationDatabase } from "../../database-handles";
import {
  MAX_RUN_SNAPSHOT_BYTES,
  parseRunSnapshot,
  parseRunSnapshotSummary,
  type RunSnapshotSummary,
} from "@purin-labs/bakery-model/bakery-run-snapshot";
import type { OrganisationId } from "../../ids";
import { sha256Hex } from "@purin-labs/std";

export type AgentRunSaveVerification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "read_failed" }>
  | Readonly<{ kind: "unavailable"; effectId: string }>
  | Readonly<{
      kind: "verified";
      effectId: string;
      snapshot: RunSnapshotSummary;
    }>;

type SavedAgentRunRow = Readonly<{
  effectId: string;
  contentId: string;
  name: string;
  summaryJson: string;
}>;

export async function readLatestAgentRunSave(
  input: Readonly<{
    db: OrganisationDatabase;
    archive: R2Bucket;
    organisationId: OrganisationId;
    userId: string;
    surfaceSessionId: string;
  }>,
): Promise<AgentRunSaveVerification> {
  const row = await input.db
    .prepare(
      `SELECT save.effect_id AS effectId, save.content_id AS contentId,
              save.name, save.summary_json AS summaryJson
       FROM bakery_agent_run_save AS save
       JOIN bakery_surface_effect_delivery AS effect
         ON effect.effect_id = save.effect_id
       WHERE save.organisation_id = ? AND save.user_id = ?
         AND effect.surface_session_id = ? AND save.state_kind = 'saved'
       ORDER BY save.updated_at DESC, save.effect_id DESC LIMIT 1`,
    )
    .bind(input.organisationId, input.userId, input.surfaceSessionId)
    .first<SavedAgentRunRow>();
  if (row === null) return { kind: "none" };
  const snapshot = parseSavedSummary(row);
  if (snapshot === null) return { kind: "unavailable", effectId: row.effectId };
  let object: R2ObjectBody | null;
  try {
    object = await input.archive.get(
      `bakery-runs/${encodeURIComponent(input.organisationId)}/${snapshot.id}`,
    );
  } catch {
    return { kind: "unavailable", effectId: row.effectId };
  }
  if (object === null) return { kind: "unavailable", effectId: row.effectId };
  if (object.size > MAX_RUN_SNAPSHOT_BYTES) {
    await object.body.cancel();
    return { kind: "unavailable", effectId: row.effectId };
  }
  let content: string;
  let document: unknown;
  try {
    content = await object.text();
    document = JSON.parse(content);
  } catch {
    return { kind: "unavailable", effectId: row.effectId };
  }
  const parsed = parseRunSnapshot(document);
  if (
    parsed === null ||
    parsed.content !== content ||
    parsed.name !== snapshot.name ||
    parsed.kind !== snapshot.kind ||
    object.size !== snapshot.bytes ||
    object.uploaded.toISOString() !== snapshot.savedAt ||
    object.customMetadata?.name !== snapshot.name ||
    object.customMetadata?.kind !== snapshot.kind
  )
    return { kind: "unavailable", effectId: row.effectId };
  return (await sha256Hex(content)) === snapshot.id
    ? { kind: "verified", effectId: row.effectId, snapshot }
    : { kind: "unavailable", effectId: row.effectId };
}

function parseSavedSummary(row: SavedAgentRunRow): RunSnapshotSummary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.summaryJson);
  } catch {
    return null;
  }
  const summary = parseRunSnapshotSummary(raw);
  return summary !== null &&
    summary.id === row.contentId &&
    summary.name === row.name
    ? summary
    : null;
}
