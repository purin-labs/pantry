import { isNonNegativeInteger, isPositiveInteger } from "@seams/std";
import { err, ok, type Result } from "./result.ts";

declare const idBrand: unique symbol;
declare const digestBrand: unique symbol;

/** Every identity kind the engine distinguishes. A raw string is none of them. */
export type IdKind =
  | "run"
  | "execution"
  | "snapshot"
  | "host-session"
  | "command"
  | "scenario"
  | "source"
  | "workflow"
  | "workflow-instance"
  | "task-key"
  | "task"
  | "attempt"
  | "arrival-source"
  | "availability"
  | "product"
  | "lot-key"
  | "lot"
  | "destination"
  | "resource"
  | "location"
  | "configuration"
  | "batch-program"
  | "storage"
  | "carrier"
  | "carrier-role"
  | "cell"
  | "skill"
  | "hold-model"
  | "boundary"
  | "measurement";

export type Id<Kind extends IdKind> = string & { readonly [idBrand]: Kind };

/** Production ancestry, shared by an execution and its continuations. */
export type RunId = Id<"run">;
/** One independent writer. A fresh-host continuation receives a new one. */
export type ExecutionId = Id<"execution">;
export type SnapshotId = Id<"snapshot">;
export type HostSessionId = Id<"host-session">;
export type CommandId = Id<"command">;
export type ScenarioId = Id<"scenario">;
export type SourceId = Id<"source">;
export type WorkflowId = Id<"workflow">;
export type WorkflowInstanceId = Id<"workflow-instance">;
export type TaskKey = Id<"task-key">;
export type TaskId = Id<"task">;
export type AttemptId = Id<"attempt">;
export type ArrivalSourceId = Id<"arrival-source">;
export type AvailabilityId = Id<"availability">;
export type ProductId = Id<"product">;
export type LotKey = Id<"lot-key">;
export type LotId = Id<"lot">;
export type DestinationId = Id<"destination">;
export type ResourceId = Id<"resource">;
export type LocationId = Id<"location">;
export type ConfigurationId = Id<"configuration">;
export type BatchProgramId = Id<"batch-program">;
export type StorageId = Id<"storage">;
export type CarrierId = Id<"carrier">;
export type CarrierRole = Id<"carrier-role">;
export type CellId = Id<"cell">;
export type SkillId = Id<"skill">;
export type HoldModelId = Id<"hold-model">;
export type BoundaryId = Id<"boundary">;
/** A quantity a native controller measures and reports at completion. */
export type MeasurementId = Id<"measurement">;

export type Sha256Hex = string & { readonly [digestBrand]: "Sha256Hex" };

export type IdError = Readonly<{
  code: "invalid_identity";
  kind: IdKind;
  value: unknown;
}>;
export type DigestError = Readonly<{ code: "invalid_digest"; value: unknown }>;

// Authored identities exclude the separators that derived identities add.
const AUTHORED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function parseId<Kind extends IdKind>(
  kind: Kind,
  raw: unknown,
): Result<Id<Kind>, IdError> {
  return typeof raw === "string" && AUTHORED.test(raw)
    ? ok(raw as Id<Kind>)
    : err({ code: "invalid_identity", kind, value: raw });
}

/** Restores authored and engine-derived identities without accepting arbitrary text. */
export function parseStoredId<Kind extends IdKind>(
  kind: Kind,
  raw: unknown,
): Result<Id<Kind>, IdError> {
  const authored = parseId(kind, raw);
  if (authored.ok) return authored;
  if (typeof raw !== "string" || raw.length > 240) return authored;
  const part = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
  const instance = `${part}#(0|[1-9][0-9]{0,15})`;
  const task = `(?:${instance}/${part}|${part}~[1-9][0-9]{0,15})`;
  let pattern: string;
  switch (kind) {
    case "workflow-instance":
      pattern = instance;
      break;
    case "task":
      pattern = task;
      break;
    case "attempt":
      pattern = `${task}@[1-9][0-9]{0,15}`;
      break;
    case "lot":
      pattern = `${instance}/${part}`;
      break;
    case "boundary":
      pattern = `${task}!(0|[1-9][0-9]{0,15})!(admission|removal)`;
      break;
    default:
      return authored;
  }
  return new RegExp(`^${pattern}$`, "u").test(raw)
    ? ok(raw as Id<Kind>)
    : authored;
}

/**
 * An identity written in adapter source, such as a resource a recipe names.
 * A malformed one is a programming error. Data goes through {@link parseId}.
 */
export function authoredId<Kind extends IdKind>(
  kind: Kind,
  literal: string,
): Id<Kind> {
  const parsed = parseId(kind, literal);
  if (!parsed.ok) throw new Error(`Invalid ${kind} identity: ${literal}`);
  return parsed.value;
}

export function parseSha256Hex(raw: unknown): Result<Sha256Hex, DigestError> {
  return typeof raw === "string" && SHA256.test(raw)
    ? ok(raw as Sha256Hex)
    : err({ code: "invalid_digest", value: raw });
}

/**
 * Instance identities derive from the arrival source and its sequence, so a
 * resumed run can neither duplicate nor skip an arrival.
 */
export function workflowInstanceId(
  source: ArrivalSourceId,
  sequence: number,
): WorkflowInstanceId {
  if (!isNonNegativeInteger(sequence))
    throw new RangeError("An arrival sequence is a non-negative integer");
  return `${source}#${sequence}` as WorkflowInstanceId;
}

export function taskId(instance: WorkflowInstanceId, key: TaskKey): TaskId {
  return `${instance}/${key}` as TaskId;
}

/** A resource's changeover tasks are numbered from one in the order they start. */
export function changeoverTaskId(
  resource: ResourceId,
  sequence: number,
): TaskId {
  if (!isPositiveInteger(sequence))
    throw new RangeError("A changeover sequence is a positive integer");
  return `${resource}~${sequence}` as TaskId;
}

/** Attempts of one task are numbered from one; a retry never reuses a number. */
export function attemptId(task: TaskId, attempt: number): AttemptId {
  if (!isPositiveInteger(attempt))
    throw new RangeError("An attempt number is a positive integer");
  return `${task}@${attempt}` as AttemptId;
}

/**
 * A carrier entering or leaving a cell through one step of one task. The
 * identity is the same however often the boundary is prepared.
 */
export function boundaryId(
  task: TaskId,
  carrierStep: number,
  kind: "admission" | "removal",
): BoundaryId {
  if (!isNonNegativeInteger(carrierStep))
    throw new RangeError("A carrier step is a non-negative integer");
  return `${task}!${carrierStep}!${kind}` as BoundaryId;
}

export function instanceLotId(
  instance: WorkflowInstanceId,
  key: LotKey,
): LotId {
  return `${instance}/${key}` as LotId;
}
