import type { Settings } from "@purin-labs/bakery-model/bakery";
import type { WorkcellResourceId } from "./workcell-input.ts";
import {
  RESOURCE_INSTANCES,
  resourceInstance,
  type ResourceInstance,
} from "./workcell-instances.ts";
import { hasExactKeys } from "@purin-labs/std";

// Assumptions compared against a pinned baseline. An outage postpones new
// dispatches that need its resource; running work continues. An injected
// failure ends a staging, human transfer or clearance task early. An assumed recovery models
// inspection and a reset to the source state: after its duration it releases
// the failed task's baker and cell, while the failed tray and work that depends
// on it stay blocked. Native failures come only from recordings.
export type OutageResource = `human-${number}` | WorkcellResourceId;
export type HandlingTaskId =
  `batch:${string}:handoff:${number}-${"stage" | "clear" | "transfer"}`;
type ResourceOutage = Readonly<{
  resource: OutageResource;
  start: number;
  end: number;
}>;
type InjectedFailure = Readonly<{
  bakeryTaskId: HandlingTaskId;
  afterSeconds: number;
}>;
type AssumedRecovery = Readonly<{
  bakeryTaskId: string;
  seconds: number;
}>;
export type RunFaults = Readonly<{
  outage: ResourceOutage | null;
  failure: InjectedFailure | null;
  recovery: AssumedRecovery | null;
}>;

export const NO_FAULTS: RunFaults = Object.freeze({
  outage: null,
  failure: null,
  recovery: null,
});
const MAX_FAILURE_AFTER_SECONDS = 600;
const MAX_RECOVERY_SECONDS = 3600;

// The workcell resources an outage may name. The tray is the material itself.
export const OUTAGE_WORKCELL_RESOURCES: readonly WorkcellResourceId[] =
  RESOURCE_INSTANCES.filter(isFixedResource).map(instanceId);

type FaultScope = Readonly<{
  settings: Settings;
  handlingTasks: readonly HandlingTaskId[];
  recoverableTasks: readonly string[];
}>;

export function hasFaults(faults: RunFaults): boolean {
  return (
    faults.outage !== null ||
    faults.failure !== null ||
    faults.recovery !== null
  );
}

/**
 * A baker's handling of one cold tray: staging before its robot chain and
 * clearance after it. The schedule times these steps, and each production
 * fingerprint records the same values.
 */
export const COLD_TRAY_HANDLING = Object.freeze({
  stagingSeconds: 30,
  clearanceSeconds: 15,
  material: "cold-proxy",
} as const);

/** A baker's time to stage a cold tray, or to clear it after its chain. */
export function coldTrayHandlingSeconds(phase: "stage" | "clear"): number {
  return phase === "stage"
    ? COLD_TRAY_HANDLING.stagingSeconds
    : COLD_TRAY_HANDLING.clearanceSeconds;
}

export function handlingTaskId(
  batchId: string,
  tray: number,
  phase: "stage" | "clear" | "transfer",
): HandlingTaskId {
  return `batch:${batchId}:handoff:${tray}-${phase}`;
}

// Returns the reason a fault set does not fit its run, or null.
export function faultProblem(
  faults: RunFaults,
  scope: FaultScope,
): string | null {
  const horizon = scope.settings.horizonMinutes * 60;
  const outage = faults.outage;
  if (outage !== null) {
    if (!outageResource(outage.resource, scope.settings))
      return "Choose a baker or workcell resource for the outage.";
    if (
      !Number.isInteger(outage.start) ||
      !Number.isInteger(outage.end) ||
      outage.start < 0 ||
      outage.end <= outage.start ||
      outage.end > horizon
    )
      return "An outage must end after it starts, within this shift.";
  }
  const failure = faults.failure;
  if (failure !== null) {
    if (!scope.handlingTasks.includes(failure.bakeryTaskId))
      return "Inject a failure into staging, human transfer or clearance. Native failures come from recordings.";
    if (
      !Number.isInteger(failure.afterSeconds) ||
      failure.afterSeconds < 1 ||
      failure.afterSeconds > MAX_FAILURE_AFTER_SECONDS
    )
      return `Fail a task from 1 to ${MAX_FAILURE_AFTER_SECONDS} seconds after it starts.`;
  }
  const recovery = faults.recovery;
  if (recovery !== null) {
    if (!scope.recoverableTasks.includes(recovery.bakeryTaskId))
      return "Choose a staging, human transfer, clearance or native step to recover.";
    if (
      !Number.isInteger(recovery.seconds) ||
      recovery.seconds < 1 ||
      recovery.seconds > MAX_RECOVERY_SECONDS
    )
      return `Choose a recovery from 1 to ${MAX_RECOVERY_SECONDS} seconds.`;
  }
  return null;
}

export function parseRunFaults(value: unknown): RunFaults {
  const raw = record(value);
  if (!hasExactKeys(raw, ["outage", "failure", "recovery"]))
    throw new Error("Save faults as an outage, a failure and a recovery.");
  let outage: ResourceOutage | null = null;
  if (raw.outage !== null) {
    const item = record(raw.outage);
    if (
      !hasExactKeys(item, ["resource", "start", "end"]) ||
      typeof item.resource !== "string" ||
      !isOutageResource(item.resource)
    )
      throw new Error("A saved outage names a baker or workcell resource.");
    outage = Object.freeze({
      resource: item.resource,
      start: whole(item.start),
      end: whole(item.end),
    });
  }
  let failure: InjectedFailure | null = null;
  if (raw.failure !== null) {
    const item = record(raw.failure);
    if (
      !hasExactKeys(item, ["bakeryTaskId", "afterSeconds"]) ||
      typeof item.bakeryTaskId !== "string" ||
      !isHandlingTaskId(item.bakeryTaskId)
    )
      throw new Error(
        "A saved failure names staging, human transfer or clearance.",
      );
    failure = Object.freeze({
      bakeryTaskId: item.bakeryTaskId,
      afterSeconds: whole(item.afterSeconds),
    });
  }
  let recovery: AssumedRecovery | null = null;
  if (raw.recovery !== null) {
    const item = record(raw.recovery);
    if (
      !hasExactKeys(item, ["bakeryTaskId", "seconds"]) ||
      typeof item.bakeryTaskId !== "string"
    )
      throw new Error("A saved recovery names its task and duration.");
    recovery = Object.freeze({
      bakeryTaskId: item.bakeryTaskId,
      seconds: whole(item.seconds),
    });
  }
  return Object.freeze({ outage, failure, recovery });
}

// The outage that postpones work needing any of these resources at this time.
export function resourceOutage(
  faults: RunFaults,
  resources: readonly OutageResource[],
  time: number,
): ResourceOutage | null {
  const outage = faults.outage;
  return outage !== null &&
    time >= outage.start &&
    time < outage.end &&
    resources.includes(outage.resource)
    ? outage
    : null;
}

// The baker an outage keeps from new work at this time.
export function absentBaker(
  faults: RunFaults,
  time: number,
): `human-${number}` | null {
  const outage = faults.outage;
  return outage !== null &&
    isBaker(outage.resource) &&
    time >= outage.start &&
    time < outage.end
    ? outage.resource
    : null;
}

export function recoveryFor(
  faults: RunFaults,
  bakeryTaskId: string,
): AssumedRecovery | null {
  return faults.recovery?.bakeryTaskId === bakeryTaskId
    ? faults.recovery
    : null;
}

export function outageResourceName(resource: OutageResource): string {
  if (isBaker(resource)) return `Baker ${resource.slice(6)}`;
  return resourceInstance(resource).name;
}
function isFixedResource(instance: ResourceInstance): boolean {
  return instance.role !== "tray";
}
function instanceId(instance: ResourceInstance): WorkcellResourceId {
  return instance.id;
}

function isBaker(resource: OutageResource): resource is `human-${number}` {
  return resource.startsWith("human-");
}
function outageResource(resource: OutageResource, settings: Settings): boolean {
  if (!isBaker(resource)) return isOutageResource(resource);
  const worker = Number(resource.slice(6));
  return (
    resource === `human-${worker}` &&
    Number.isInteger(worker) &&
    worker >= 1 &&
    worker <= settings.workerCount
  );
}
function isOutageResource(value: string): value is OutageResource {
  return (
    /^human-[1-9][0-9]*$/.test(value) ||
    new Set<string>(OUTAGE_WORKCELL_RESOURCES).has(value)
  );
}
function isHandlingTaskId(value: string): value is HandlingTaskId {
  return /^batch:[A-Z]+:handoff:[0-9]+-(stage|clear|transfer)$/.test(value);
}
function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error("Save fault times as whole seconds.");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Save faults as an object.");
  return Object.fromEntries(Object.entries(value));
}
