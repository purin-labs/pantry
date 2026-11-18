import { isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import * as d from "./document-values.ts";
import type { Segment } from "./physics.ts";
import type { RunState } from "./state.ts";
import type { StoredCellRecording } from "./cell-recording.ts";

/** A disposable observation. Durable recordings remain in the host's packs. */
export type PhysicsView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "cell-recorded";
      version: 1;
      cell: string;
      at: number;
      digest: string;
      content: string;
    }>
  | Readonly<{
      kind: "recorded";
      version: 1;
      cell: string;
      task: string;
      attempt: string;
      purpose: "operation" | "recovery";
      skill: string;
      startedAt: number;
      at: number;
      digest: string;
      content: string;
    }>
>;

export type AcceptedRecording = StrictUnion<
  | Readonly<{ kind: "operation"; segment: Segment; content: string }>
  | Readonly<{ kind: "cell"; recording: StoredCellRecording }>
>;

export type CellPhysicsViews = Readonly<{
  kind: "cells";
  version: 1;
  observations: readonly PhysicsView[];
}>;

/** Retained protocol 1/2 replies contain one observation at this boundary. */
export function readCellPhysicsViews(
  raw: unknown,
  committedAt: number,
): readonly PhysicsView[] {
  if (!isRecord(raw) || raw.kind !== "cells")
    return [readPhysicsView(raw, committedAt)];
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.observations) ||
    raw.observations.length > 64
  )
    throw new Error("Invalid cell observations.");
  const observations: PhysicsView[] = [];
  const cells = new Set<string>();
  for (const entry of raw.observations) {
    const observation = readPhysicsView(entry, committedAt);
    if (observation.kind !== "unavailable") {
      if (cells.has(observation.cell))
        throw new Error("Duplicate cell observation.");
      cells.add(observation.cell);
    }
    observations.push(observation);
  }
  return observations;
}

export function cellPhysicsViews(
  run: RunState,
  recordings: ReadonlyMap<string, AcceptedRecording>,
): CellPhysicsViews {
  const observations: PhysicsView[] = [];
  for (const cell of run.cells)
    observations.push(physicsView(run, recordings.get(cell.id) ?? null));
  return { kind: "cells", version: 1, observations };
}

export function physicsView(
  run: RunState,
  recording: AcceptedRecording | null,
): PhysicsView {
  if (recording === null) return { kind: "unavailable" };
  if (recording.kind === "cell") {
    const stored = recording.recording;
    const document = stored.document;
    const at =
      document.time.kind === "idle" ? document.time.through : document.time.at;
    if (at > run.position.time) return { kind: "unavailable" };
    return {
      kind: "cell-recorded",
      version: 1,
      cell: document.cellId,
      at,
      digest: stored.digest,
      content: stored.content,
    };
  }
  const segment = recording.segment;
  for (const event of run.events) {
    if (
      (event.kind !== "task-started" && event.kind !== "recovery-started") ||
      event.attempt !== segment.attemptId
    )
      continue;
    const at = event.time + segment.steps.end * 2000;
    if (at > run.position.time) return { kind: "unavailable" };
    for (const task of run.tasks) {
      if (task.id !== event.task || task.subject.kind !== "workflow") continue;
      for (const instance of run.instances) {
        if (instance.id !== task.subject.instance) continue;
        for (const workflow of run.definition.scenario.workflows) {
          if (workflow.id !== instance.workflow) continue;
          for (const definition of workflow.tasks) {
            if (
              definition.key !== task.subject.key ||
              definition.executor.kind !== "native" ||
              definition.executor.operation.cell !== segment.cellId
            )
              continue;
            return {
              kind: "recorded",
              version: 1,
              cell: segment.cellId,
              task: task.id,
              attempt: segment.attemptId,
              purpose:
                event.kind === "recovery-started" ? "recovery" : "operation",
              skill: definition.executor.operation.skill,
              startedAt: event.time,
              at,
              digest: segment.recording.digest,
              content: recording.content,
            };
          }
        }
      }
    }
  }
  return { kind: "unavailable" };
}

/** Missing data from an older retained worker becomes an explicit absence. */
export function readPhysicsView(
  raw: unknown,
  committedAt: number,
): PhysicsView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  if (raw.kind === "cell-recorded") {
    const record = d.record(raw, [
      "kind",
      "version",
      "cell",
      "at",
      "digest",
      "content",
    ]);
    d.requireValue(record.version === 1);
    const at = d.natural(record.at);
    const content = d.text(record.content);
    d.requireValue(at <= committedAt && content.length <= 512 * 1024);
    return {
      kind: "cell-recorded",
      version: 1,
      cell: d.text(record.cell),
      at,
      digest: d.digest(record.digest),
      content,
    };
  }
  d.requireValue(raw.kind === "recorded" && raw.version === 1);
  const startedAt = d.natural(raw.startedAt);
  const at = d.natural(raw.at);
  d.requireValue(at >= startedAt && at <= committedAt);
  const content = d.text(raw.content);
  d.requireValue(content.length <= 512 * 1024);
  return {
    kind: "recorded",
    version: 1,
    cell: d.text(raw.cell),
    task: d.text(raw.task),
    attempt: d.text(raw.attempt),
    purpose: d.choice(raw.purpose, "operation", "recovery"),
    skill: d.text(raw.skill),
    startedAt,
    at,
    digest: d.digest(raw.digest),
    content,
  };
}
