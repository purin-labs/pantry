import { sha256Hex } from "@purin-labs/std";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import * as d from "./document-values.ts";
import type {
  BoundaryId,
  CellId,
  ExecutionId,
  RunId,
  Sha256Hex,
} from "./identity.ts";
import type { CellRecording } from "./physics.ts";
import { advance, stepsDuration, type LogicalTime } from "./time.ts";

/** Factory time is explicit because a qualified hold skips solver steps. */
export type CellRecordingTime = StrictUnion<
  | Readonly<{ kind: "idle"; after: LogicalTime; through: LogicalTime }>
  | Readonly<{
      kind: "admission" | "removal";
      at: LogicalTime;
      boundary: BoundaryId;
    }>
>;

export type CellRecordingDocument = Readonly<{
  kind: "accepted-cell-recording";
  schemaVersion: 1;
  runId: RunId;
  executionId: ExecutionId;
  bundle: Sha256Hex;
  cellId: CellId;
  time: CellRecordingTime;
  /** The native document keeps both sides of a zero-time handoff. */
  native: string;
}>;

export type StoredCellRecording = Readonly<{
  digest: Sha256Hex;
  content: string;
  document: CellRecordingDocument;
}>;

export type CellRecordingExecution = Pick<
  CellRecordingDocument,
  "runId" | "executionId" | "bundle"
>;

async function storeCellRecording(
  identity: CellRecordingExecution,
  recording: CellRecording,
  time: CellRecordingTime,
): Promise<StoredCellRecording> {
  const document: CellRecordingDocument = {
    kind: "accepted-cell-recording",
    schemaVersion: 1,
    runId: identity.runId,
    executionId: identity.executionId,
    bundle: identity.bundle,
    cellId: recording.cellId,
    time,
    native: recording.content,
  };
  const content = JSON.stringify(document);
  return { digest: d.digest(await sha256Hex(content)), content, document };
}

export function storeIdleRecording(
  identity: CellRecordingExecution,
  recording: Variant<CellRecording, "idle">,
  after: LogicalTime,
): Promise<StoredCellRecording> {
  const steps = d.steps(recording.steps.end - recording.steps.start);
  return storeCellRecording(identity, recording, {
    kind: "idle",
    after,
    through: advance(after, stepsDuration(steps)),
  });
}

export function storeHandoffRecording(
  identity: CellRecordingExecution,
  recording: Variant<CellRecording, "admission" | "removal">,
  at: LogicalTime,
  boundary: BoundaryId,
): Promise<StoredCellRecording> {
  return storeCellRecording(identity, recording, {
    kind: recording.kind,
    at,
    boundary,
  });
}

/** A saved pack is an untrusted persistence boundary. */
export function readCellRecordingDocument(raw: unknown): CellRecordingDocument {
  const record = d.record(raw, [
    "kind",
    "schemaVersion",
    "runId",
    "executionId",
    "bundle",
    "cellId",
    "time",
    "native",
  ]);
  d.requireValue(
    record.kind === "accepted-cell-recording" && record.schemaVersion === 1,
  );
  const kind = d.kind(record.time);
  let time: CellRecordingTime;
  if (kind === "idle") {
    const interval = d.record(record.time, ["kind", "after", "through"]);
    const after = d.time(interval.after);
    const through = d.time(interval.through);
    d.requireValue(through > after && through - after <= 64_000);
    time = { kind, after, through };
  } else {
    const boundary = d.record(record.time, ["kind", "at", "boundary"]);
    time = {
      kind: d.choice(kind, "admission", "removal"),
      at: d.time(boundary.at),
      boundary: d.id("boundary", boundary.boundary),
    };
  }
  const native = d.text(record.native);
  d.requireValue(native.length <= 512 * 1024);
  return {
    kind: "accepted-cell-recording",
    schemaVersion: 1,
    runId: d.id("run", record.runId),
    executionId: d.id("execution", record.executionId),
    bundle: d.digest(record.bundle),
    cellId: d.id("cell", record.cellId),
    time,
    native,
  };
}
