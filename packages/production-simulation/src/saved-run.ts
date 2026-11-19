import { canonicalJson, isRecord, sameJson, sha256Hex } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { admitScenario } from "./admission.ts";
import * as d from "./document-values.ts";
import { parseExecutionBundle } from "./execution-bundle.ts";
import { readScenario } from "./scenario-document.ts";
import { readState } from "./state-document.ts";
import { validateState } from "./state-invariants.ts";
import type { AcceptedEvent } from "./events.ts";
import {
  parseId,
  type AttemptId,
  type CellId,
  type Sha256Hex,
  type SnapshotId,
} from "./identity.ts";
import {
  resumeSupport,
  type ExecutionBackend,
  type ExecutionBundle,
  type ResumeSupport,
} from "./physics.ts";
import { err, ok, type Result } from "./result.ts";
import type { CompiledScenario } from "./scenario.ts";
import type { ExecutionIdentity, RunState } from "./state.ts";

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * The persistent-run format. The document carries logical state and an index;
 * recordings and checkpoints are separate immutable artifacts it references,
 * so no save embeds a trajectory prefix again.
 */

export const RUN_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACTS = 512;
export const MAX_REFERENCED_BYTES = 512 * 1024 * 1024;

/** What an artifact is for. Only checkpoints can make a run resumable. */
export type ArtifactRole =
  | "recording-segment"
  | "cell-checkpoint"
  | "pending-checkpoint"
  | "native-request";

/**
 * A digest is an integrity check, never an access grant: reads go through a
 * referring snapshot and its contributing-source checks.
 */
export type ArtifactEntry = Readonly<{
  role: ArtifactRole;
  digest: Sha256Hex;
  byteLength: number;
  schemaVersion: number;
  binding: Readonly<{ cell: CellId; attempt: AttemptId | null }> | null;
}>;

/**
 * A resumable document holds everything a compatible host needs to continue.
 * An evidence document can be inspected and replayed, and nothing in it can
 * become executable through a missing-field default.
 */
export type RunDocument = Readonly<{
  schemaVersion: typeof RUN_DOCUMENT_SCHEMA_VERSION;
  snapshot: SnapshotId;
  artifacts: readonly ArtifactEntry[];
}> &
  (
    | Readonly<{
        kind: "resumable";
        state: RunState;
        bundle: ExecutionBundle;
        identity?: never;
        scenario?: never;
        events?: never;
      }>
    | Readonly<{
        kind: "evidence";
        identity: ExecutionIdentity;
        scenario: CompiledScenario;
        events: readonly AcceptedEvent[];
        state?: never;
        bundle?: never;
      }>
  );

export type ArtifactIndexProblem =
  | Readonly<{ code: "too_many_artifacts"; count: number }>
  | Readonly<{
      code: "artifact_too_large";
      digest: Sha256Hex;
      byteLength: number;
    }>
  | Readonly<{ code: "invalid_length"; digest: Sha256Hex; byteLength: number }>
  | Readonly<{ code: "referenced_bytes_exceeded"; byteLength: number }>
  | Readonly<{ code: "conflicting_entry"; digest: Sha256Hex }>
  | Readonly<{ code: "missing_checkpoint"; cell: CellId; digest: Sha256Hex }>;

/**
 * Checks declared sizes before any artifact is loaded, and that every cell
 * checkpoint a resumable state names is indexed. Bytes shared by several
 * entries count once. A failure leaves the previous complete save in place.
 */
export function checkArtifactIndex(
  document: RunDocument,
): Result<number, readonly ArtifactIndexProblem[]> {
  const problems: ArtifactIndexProblem[] = [];
  if (document.artifacts.length > MAX_ARTIFACTS)
    problems.push({
      code: "too_many_artifacts",
      count: document.artifacts.length,
    });
  const seen = new Map<Sha256Hex, ArtifactEntry>();
  let total = 0;
  for (const entry of document.artifacts) {
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength <= 0)
      problems.push({
        code: "invalid_length",
        digest: entry.digest,
        byteLength: entry.byteLength,
      });
    else if (entry.byteLength > MAX_ARTIFACT_BYTES)
      problems.push({
        code: "artifact_too_large",
        digest: entry.digest,
        byteLength: entry.byteLength,
      });
    const earlier = seen.get(entry.digest);
    if (earlier === undefined) {
      seen.set(entry.digest, entry);
      total += entry.byteLength;
    } else if (
      earlier.byteLength !== entry.byteLength ||
      earlier.schemaVersion !== entry.schemaVersion ||
      earlier.role !== entry.role ||
      !sameJson(earlier.binding, entry.binding)
    )
      problems.push({ code: "conflicting_entry", digest: entry.digest });
  }
  if (total > MAX_REFERENCED_BYTES)
    problems.push({ code: "referenced_bytes_exceeded", byteLength: total });
  if (document.kind === "resumable")
    for (const cell of document.state.cells) {
      const digest = cell.committed.checkpoint.digest;
      const entry = seen.get(digest);
      if (
        entry?.role !== "cell-checkpoint" ||
        entry.byteLength !== cell.committed.checkpoint.byteLength ||
        entry.schemaVersion !== document.bundle.checkpointSchemaVersion ||
        entry.binding?.cell !== cell.id ||
        entry.binding.attempt !== (cell.attempt?.id ?? null)
      )
        problems.push({ code: "missing_checkpoint", cell: cell.id, digest });
      if (
        cell.pending !== null &&
        seen.get(cell.pending.checkpoint.digest)?.role !== "pending-checkpoint"
      )
        problems.push({
          code: "missing_checkpoint",
          cell: cell.id,
          digest: cell.pending.checkpoint.digest,
        });
    }
  return problems.length === 0 ? ok(total) : err(problems);
}

export type ResumableDocument = Variant<RunDocument, "resumable">;

// A snapshot is named by its own content, so equal saves are one snapshot.
async function contentIdentity(content: unknown): Promise<SnapshotId> {
  const identity = parseId("snapshot", await sha256Hex(canonicalJson(content)));
  if (!identity.ok) throw new Error("A digest names a snapshot");
  return identity.value;
}

/**
 * The document a host publishes to make a run resumable. Saving the same
 * state with the same artifacts and bundle yields the same snapshot.
 */
export async function resumableDocument(
  state: RunState,
  bundle: ExecutionBundle,
  artifacts: readonly ArtifactEntry[],
): Promise<ResumableDocument> {
  const content = {
    schemaVersion: RUN_DOCUMENT_SCHEMA_VERSION,
    kind: "resumable",
    artifacts,
    state,
    bundle,
  } as const;
  return { ...content, snapshot: await contentIdentity(content) };
}

export type OpenProblem =
  | Readonly<{ code: "unsupported_document" }>
  | Readonly<{ code: "invalid_document" }>
  | Readonly<{ code: "snapshot_differs"; expected: SnapshotId }>
  | Readonly<{
      code: "inspection_only";
      reason: Variant<ResumeSupport, "inspection-only">["reason"];
    }>
  | Readonly<{ code: "definition_differs" }>
  | Readonly<{
      code: "artifact_index";
      problems: readonly ArtifactIndexProblem[];
    }>;

/**
 * Admits a saved document for continuation in this host. Its snapshot
 * identity must match its content, its bundle must be one this host has
 * approved, its artifact index must be complete, and its pinned scenario
 * must still admit to the digest it was pinned at.
 *
 * A matching digest checks integrity. Structural and relationship checks
 * establish that the document is valid input; the digest grants no authority.
 */
export async function openResumable(
  raw: unknown,
  backend: ExecutionBackend,
  approved: readonly ExecutionBundle[],
): Promise<Result<ResumableDocument, OpenProblem>> {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== RUN_DOCUMENT_SCHEMA_VERSION ||
    raw.kind !== "resumable"
  )
    return err({ code: "unsupported_document" });
  const { snapshot, ...content } = raw;
  let expected: SnapshotId;
  try {
    if (
      new TextEncoder().encode(canonicalJson(raw)).byteLength >
      MAX_DOCUMENT_BYTES
    )
      return err({ code: "invalid_document" });
    expected = await contentIdentity(content);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      return err({ code: "invalid_document" });
    throw error;
  }
  if (snapshot !== expected) return err({ code: "snapshot_differs", expected });
  let document: ResumableDocument;
  try {
    const r = d.record(raw, [
      "schemaVersion",
      "kind",
      "snapshot",
      "artifacts",
      "state",
      "bundle",
    ]);
    d.requireValue(isRecord(r.state));
    const definition = d.record(r.state.definition, ["scenario", "digest"]);
    const admitted = await admitScenario(readScenario(definition.scenario));
    if (!admitted.ok || admitted.value.digest !== definition.digest)
      return err({ code: "definition_differs" });
    const bundle = parseExecutionBundle(r.bundle);
    d.requireValue(bundle !== null);
    const state = readState(r.state, admitted.value);
    validateState(state);
    // Every resumable run pins its engine, including declared-only recipes.
    d.requireValue(state.identity.bundle === bundle.id);
    document = {
      schemaVersion: RUN_DOCUMENT_SCHEMA_VERSION,
      kind: "resumable",
      snapshot: expected,
      artifacts: d.array(r.artifacts, readArtifact),
      state,
      bundle,
    };
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_document" });
    throw error;
  }
  const support = resumeSupport(document.bundle, backend, approved);
  if (support.kind === "inspection-only")
    return err({ code: "inspection_only", reason: support.reason });
  const index = checkArtifactIndex(document);
  if (!index.ok) return err({ code: "artifact_index", problems: index.error });
  return ok(document);
}

function readBinding(raw: unknown): NonNullable<ArtifactEntry["binding"]> {
  const r = d.record(raw, ["cell", "attempt"]);
  return {
    cell: d.id("cell", r.cell),
    attempt: r.attempt === null ? null : d.id("attempt", r.attempt),
  };
}

function readArtifact(raw: unknown): ArtifactEntry {
  const r = d.record(raw, [
    "role",
    "digest",
    "byteLength",
    "schemaVersion",
    "binding",
  ]);
  return {
    role: d.choice(
      r.role,
      "recording-segment",
      "cell-checkpoint",
      "pending-checkpoint",
      "native-request",
    ),
    digest: d.digest(r.digest),
    byteLength: d.positive(r.byteLength),
    schemaVersion: d.positive(r.schemaVersion),
    binding: d.nullable(r.binding, readBinding),
  };
}
