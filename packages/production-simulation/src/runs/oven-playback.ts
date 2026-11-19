import {
  readOperationContacts,
  type ContactObservation,
} from "../index.ts";
import { parseSha256Hex } from "../index.ts";
import { nativeIdentity } from "../native/cell-adapter.ts";
import {
  isRecord,
  isNonNegativeInteger,
  parseJsonOrNull,
  sha256Hex,
  canonicalJson,
} from "@seams/std";
import {
  parsePersistentPhysicsMotion,
  type PersistentPhysicsScene,
} from "@seams/bakery-model/bakery-physics";
import type { OvenSave } from "./oven-run-file.ts";
import { ovenOperation, type OvenLiveFrame } from "./oven-live-physics.ts";

export type OvenPlayback = Extract<
  OvenLiveFrame,
  { purpose: "operation" | "recovery" }
>;

/** Validates selected operation records. It never asks physics to advance. */
export async function readOvenPlayback(
  save: Pick<OvenSave, "document">,
  scene: PersistentPhysicsScene,
  task: string,
  records: readonly Readonly<{ digest: string; content: string }>[],
): Promise<OvenPlayback> {
  const run = save.document.state;
  const cell = scene.cell;
  const selected = ovenOperation(run, task);
  if (selected.cell !== cell.cellId)
    throw new Error("The task belongs to another cell.");
  let attempt: string | null = null;
  let startedAt = 0;
  let terminalAt: number | null = null;
  for (const event of run.events) {
    if (
      event.kind === "task-started" &&
      event.task === task &&
      event.attempt !== null
    ) {
      attempt = nativeIdentity(event.attempt);
      startedAt = event.time;
    }
    if (
      (event.kind === "task-completed" || event.kind === "task-failed") &&
      event.task === task
    )
      terminalAt = event.time;
  }
  if (attempt === null)
    throw new Error("This task has no accepted physics samples yet.");
  const samples: unknown[] = [];
  const contacts: ContactObservation[] = [];
  let contactsRecorded = true;
  let sequence = 0;
  let endStep = 0;
  let predecessor: string | null = null;
  for (const record of records) {
    const raw = parseJsonOrNull(record.content);
    if (!isRecord(raw)) throw new Error("Invalid recording segment.");
    if (raw.attemptId !== attempt) continue;
    const checkpoint = parseSha256Hex(raw.checkpoint);
    const previous = parseSha256Hex(raw.predecessor);
    if (
      (await sha256Hex(record.content)) !== record.digest ||
      raw.schemaVersion !== 1 ||
      raw.runId !== cell.runId ||
      raw.modelHash !== cell.modelHash ||
      raw.runnerSha256 !== cell.execution.controllerHash ||
      raw.runtimeSha256 !== cell.execution.runtimeHash ||
      raw.sequence !== sequence ||
      !checkpoint.ok ||
      !previous.ok ||
      raw.startStep !== endStep ||
      !isNonNegativeInteger(raw.endStep) ||
      raw.endStep <= endStep ||
      raw.endStep - endStep > 32 ||
      !Array.isArray(raw.samples) ||
      raw.samples.length === 0 ||
      (sequence > 0 && raw.predecessor !== predecessor)
    )
      throw new Error("Recording segments do not form one accepted operation.");
    const first: unknown = raw.samples[0];
    const last: unknown = raw.samples[raw.samples.length - 1];
    if (
      !isRecord(first) ||
      !isRecord(last) ||
      first.step !== endStep ||
      last.step !== raw.endStep
    )
      throw new Error("Recording boundary samples are missing.");
    if (
      sequence > 0 &&
      canonicalJson(samples[samples.length - 1]) !== canonicalJson(first)
    )
      throw new Error("Recording boundary poses differ.");
    const evidence = readOperationContacts(
      raw.contacts ?? { kind: "not-recorded" },
      endStep,
      raw.endStep,
    );
    if (evidence.kind === "not-recorded") contactsRecorded = false;
    else contacts.push(...evidence.observations);
    samples.push(...raw.samples.slice(sequence === 0 ? 0 : 1));
    endStep = raw.endStep;
    predecessor = checkpoint.value;
    sequence++;
  }
  if (samples.length === 0)
    throw new Error("This task has no accepted physics samples yet.");
  const endAt = startedAt + endStep * 2000;
  if (
    endAt > run.position.time ||
    (terminalAt !== null && endAt !== terminalAt)
  )
    throw new Error(
      "The recording extends beyond its accepted task boundary or is incomplete.",
    );
  return {
    purpose: "operation",
    contacts: contactsRecorded
      ? { kind: "dense", observations: contacts }
      : { kind: "not-recorded" },
    at: endAt,
    task,
    cell: cell.cellId,
    startedAt,
    committedAt: run.position.time,
    motion: parsePersistentPhysicsMotion(scene, samples),
  };
}
