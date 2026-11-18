import { assertNever, isRecord, parseJsonOrNull, sha256Hex } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import {
  MAX_RUN_SNAPSHOT_BYTES,
  isRunSnapshotId,
  parseRunSnapshot,
  parseRunSnapshotSummary,
  type RunSnapshotSummary,
} from "@seams/bakery-model/bakery-run-snapshot";
import type { OrganisationId } from "../../ids";

export type SavedBakeryRunQuery = StrictUnion<
  | Readonly<{ kind: "list"; cursor: string | null }>
  | Readonly<{ kind: "read"; id: string }>
  | Readonly<{ kind: "latest" }>
>;

export type SavedBakeryRunContext = Readonly<{
  kind: "saved_bakery_run";
  source: RunSnapshotSummary;
  revision: string;
  observedAt: number;
  evidence: "saved_simulation";
  settings: Readonly<Record<string, number>>;
  trays: number | null;
  operations: number | null;
  recordedOperations: number | null;
  assumptions: readonly string[];
}>;

export type SavedBakeryRunResult =
  | SavedBakeryRunContext
  | Readonly<{
      kind: "saved_bakery_runs";
      snapshots: readonly RunSnapshotSummary[];
      nextCursor: string | null;
      observedAt: number;
    }>
  | Readonly<{ kind: "unavailable"; reason: "missing" | "invalid" }>;

export function bakeryRunSnapshotPrefix(
  organisationId: OrganisationId,
): string {
  return `bakery-runs/${encodeURIComponent(organisationId)}/`;
}

export function bakeryRunSnapshotSummary(
  prefix: string,
  object: R2Object,
): RunSnapshotSummary {
  const summary = parseRunSnapshotSummary({
    id: object.key.slice(prefix.length),
    name: object.customMetadata?.name,
    kind: object.customMetadata?.kind,
    savedAt: object.uploaded.toISOString(),
    bytes: object.size,
  });
  if (!object.key.startsWith(prefix) || summary === null)
    throw new Error("Invalid stored run metadata");
  return summary;
}

export async function readSavedBakeryRun(
  archive: Pick<R2Bucket, "get" | "list">,
  organisationId: OrganisationId,
  query: SavedBakeryRunQuery,
): Promise<SavedBakeryRunResult> {
  const prefix = bakeryRunSnapshotPrefix(organisationId);
  switch (query.kind) {
    case "list": {
      const page = await archive.list({
        prefix,
        limit: 8,
        include: ["customMetadata"],
        ...(query.cursor === null ? {} : { cursor: query.cursor }),
      });
      return {
        kind: "saved_bakery_runs",
        snapshots: page.objects.map(
          bakeryRunSnapshotSummary.bind(null, prefix),
        ),
        nextCursor: page.truncated ? page.cursor : null,
        observedAt: Date.now(),
      };
    }
    case "latest": {
      const latest = await latestSavedBakeryRun(archive, prefix);
      if (latest === null) return { kind: "unavailable", reason: "missing" };
      return readSavedBakeryRunSnapshot(archive, prefix, latest.id);
    }
    case "read":
      return readSavedBakeryRunSnapshot(archive, prefix, query.id);
    default:
      return assertNever(query);
  }
}

async function latestSavedBakeryRun(
  archive: Pick<R2Bucket, "get" | "list">,
  prefix: string,
): Promise<RunSnapshotSummary | null> {
  let latest: RunSnapshotSummary | null = null;
  let cursor: string | null = null;
  do {
    const page = await archive.list({
      prefix,
      limit: 1000,
      include: ["customMetadata"],
      ...(cursor === null ? {} : { cursor }),
    });
    // R2 lists content-addressed keys, so key order cannot identify the latest save.
    for (const object of page.objects) {
      const summary = bakeryRunSnapshotSummary(prefix, object);
      if (
        latest === null ||
        summary.savedAt > latest.savedAt ||
        (summary.savedAt === latest.savedAt && summary.id > latest.id)
      )
        latest = summary;
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor !== null);
  return latest;
}

async function readSavedBakeryRunSnapshot(
  archive: Pick<R2Bucket, "get" | "list">,
  prefix: string,
  id: string,
): Promise<SavedBakeryRunResult> {
  if (!isRunSnapshotId(id)) throw new Error("Invalid saved run identity");
  const object = await archive.get(prefix + id);
  if (object === null) return { kind: "unavailable", reason: "missing" };
  if (object.size > MAX_RUN_SNAPSHOT_BYTES) {
    await object.body.cancel();
    return { kind: "unavailable", reason: "invalid" };
  }
  const content = await object.text();
  const raw = parseJsonOrNull(content);
  const snapshot = parseRunSnapshot(raw);
  if (
    snapshot === null ||
    !isRecord(raw) ||
    !isRecord(raw.document) ||
    (await sha256Hex(content)) !== id
  )
    return { kind: "unavailable", reason: "invalid" };
  const document = raw.document;
  if (snapshot.kind === "persistent-production")
    return {
      kind: "saved_bakery_run",
      source: bakeryRunSnapshotSummary(prefix, object),
      revision: id,
      observedAt: Date.now(),
      evidence: "saved_simulation",
      settings: {},
      trays: null,
      operations: null,
      recordedOperations: null,
      assumptions: [
        "Persistent production snapshot. Open it in Recipes to validate and inspect its tasks, material quantities and observations.",
        "This archive read checks content integrity only. Counts and physical results are unavailable in this summary. It does not continue execution.",
      ],
    };
  const settings: Record<string, number> = {};
  const rawSettings = isRecord(document.settings)
    ? document.settings
    : isRecord(document.input)
      ? document.input
      : {};
  for (const field of [
    "batchCount",
    "traysPerBatch",
    "piecesPerTray",
    "bakerCount",
    "workerCount",
    "rackTrays",
    "ovenTrays",
    "stage",
    "portion",
    "bake",
    "cool",
    "demould",
    "finishCooling",
    "pack",
    "horizonMinutes",
  ]) {
    const value = rawSettings[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      settings[field] = value;
  }
  const operations = savedOperations(document);
  return {
    kind: "saved_bakery_run",
    source: bakeryRunSnapshotSummary(prefix, object),
    revision: id,
    observedAt: Date.now(),
    evidence: "saved_simulation",
    settings,
    trays: Array.isArray(document.trays) ? document.trays.length : 0,
    operations: operations.length,
    recordedOperations: operations.filter(hasSavedRecording).length,
    assumptions: [
      "Saved simulation assumptions; real shop capacity and physical execution are unverified.",
      "Frame data is omitted from this summary; recorded results were not accepted or physically verified.",
    ],
  };
}

function savedOperations(
  document: Record<string, unknown>,
): readonly unknown[] {
  if (document.kind !== "bakery-rehearsal-run")
    return Array.isArray(document.operations) ? document.operations : [];
  const operations: unknown[] = [];
  if (!Array.isArray(document.trays)) return operations;
  for (const tray of document.trays) {
    if (isRecord(tray) && Array.isArray(tray.steps))
      operations.push(...tray.steps);
  }
  return operations;
}

function hasSavedRecording(operation: unknown): boolean {
  if (!isRecord(operation)) return false;
  if (
    (operation.kind === "accepted" || operation.kind === "held") &&
    typeof operation.file === "string"
  )
    return true;
  const recording = isRecord(operation.attempt)
    ? operation.attempt.recording
    : (operation.recording ?? operation.evidence);
  return recording !== null && recording !== undefined;
}

export async function savedBakeryRunArchiveKeys(
  archive: Pick<R2Bucket, "get" | "list">,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const prefix = bakeryRunSnapshotPrefix(organisationId);
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await archive.list({
      prefix,
      limit: 1000,
      include: ["customMetadata"],
      ...(cursor === null ? {} : { cursor }),
    });
    for (const object of page.objects) {
      const summary = bakeryRunSnapshotSummary(prefix, object);
      const snapshot = await readSavedBakeryRunSnapshot(
        archive,
        prefix,
        summary.id,
      );
      if (snapshot.kind !== "saved_bakery_run")
        throw new Error("saved_bakery_run_archive_invalid");
      keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor !== null);
  return keys;
}
