import { canonicalJson } from "@purin-labs/std";
import type { TaskId } from "../identity.ts";
import type { BakeStep, CompiledBakeRun } from "./compile.ts";
import {
  dispatchIdentity,
  sameTask,
  type ClockOrigin,
  type CobotClockEntry,
  type CobotReport,
  type CobotTask,
  type CobotTaskMessage,
  type DeviceRunState,
  type PhysicalEvidence,
} from "./protocol.ts";

/**
 * The evidence a physical run has accepted, kept beside the engine state.
 * A report is evidence, not authority: a report for an unknown dispatch, a
 * sequence that does not rise or a clock that goes back is refused here and
 * named, and the run never sees it.
 */

type DeviceRecord = Readonly<{
  /** The last accepted controller sequence and device clock. */
  sequence: number;
  clockMs: number;
  state: DeviceRunState | null;
  /** Each accepted message by its sequence, to recognize a replay. */
  seen: Readonly<Record<string, string>>;
}>;

/** One dispatch the caller wrote before the gateway sent the task. */
export type DispatchRecord = Readonly<{
  requestId: string;
  sourceKey: string;
  task: CobotTask;
  engineTask: TaskId;
  /** Accepted reports in controller order. */
  reports: readonly CobotReport[];
  /** A device clock that showed the device idle while the task was open. */
  lost: Readonly<{ sequence: number; clockMs: number }> | null;
}>;

export type EvidenceLedger = Readonly<{
  origin: ClockOrigin;
  devices: Readonly<Record<string, DeviceRecord>>;
  dispatches: Readonly<Record<string, DispatchRecord>>;
}>;

type DispositionReason =
  | "unknown_device"
  | "unknown_task"
  | "dispatch_differs"
  | "unknown_dispatch"
  | "source_differs"
  | "stale_sequence"
  | "clock_regressed"
  | "before_origin"
  | "after_terminal";

/** Evidence that the run did not apply, and why. */
export type EvidenceDisposition = Readonly<{
  evidence: Readonly<{
    type: PhysicalEvidence["type"];
    sourceKey: string;
    requestId: string | null;
    sequence: number | null;
  }>;
  outcome: "duplicate" | "refused";
  reason: DispositionReason | null;
}>;

export function emptyLedger(origin: ClockOrigin): EvidenceLedger {
  const devices: Record<string, DeviceRecord> = {};
  for (const [sourceKey, clockMs] of Object.entries(origin))
    devices[sourceKey] = { sequence: -1, clockMs, state: null, seen: {} };
  return { origin, devices, dispatches: {} };
}

export function terminalReport(record: DispatchRecord): CobotReport | null {
  for (const report of record.reports)
    if (
      report.state === "completed" ||
      report.state === "rejected" ||
      report.state === "indeterminate"
    )
      return report;
  return null;
}

/** The dispatch record of an engine task, once the caller wrote it. */
export function dispatchOfTask(
  ledger: EvidenceLedger,
  task: TaskId,
): DispatchRecord | null {
  for (const record of Object.values(ledger.dispatches))
    if (record.engineTask === task) return record;
  return null;
}

/** Whether the dispatch still waits for its end. */
function isOpen(record: DispatchRecord): boolean {
  return record.lost === null && terminalReport(record) === null;
}

function stepOfTask(bake: CompiledBakeRun, task: string): BakeStep | null {
  for (const step of bake.steps) if (step.engineTask === task) return step;
  return null;
}

// A replay from the gateway journal says `replayed`; its content is the same.
function fingerprint(value: CobotReport | CobotClockEntry): string {
  return canonicalJson({ ...value, replayed: false });
}

type Check = Readonly<{
  ledger: EvidenceLedger;
  disposition: EvidenceDisposition | null;
}>;

function refuse(
  ledger: EvidenceLedger,
  evidence: EvidenceDisposition["evidence"],
  outcome: EvidenceDisposition["outcome"],
  reason: DispositionReason | null,
): Check {
  return { ledger, disposition: { evidence, outcome, reason } };
}

/** The ordering checks that every message of one device passes. */
function deviceCheck(
  ledger: EvidenceLedger,
  message: CobotReport | CobotClockEntry,
): Readonly<{
  outcome: "duplicate" | "refused";
  reason: DispositionReason | null;
}> | null {
  const device = ledger.devices[message.sourceKey];
  if (device === undefined)
    return { outcome: "refused", reason: "unknown_device" };
  if (message.sequence <= device.sequence) {
    if (device.seen[String(message.sequence)] === fingerprint(message))
      return { outcome: "duplicate", reason: null };
    // The gateway builds each clock message from the device's last line, so
    // a clock entry can repeat the sequence of a report that came first. It
    // repeats time that the run already holds, and it says nothing new.
    return !("type" in message) && message.deviceClockMs <= device.clockMs
      ? { outcome: "duplicate", reason: null }
      : { outcome: "refused", reason: "stale_sequence" };
  }
  if (message.deviceClockMs < (ledger.origin[message.sourceKey] ?? 0))
    return { outcome: "refused", reason: "before_origin" };
  if (message.deviceClockMs < device.clockMs)
    return { outcome: "refused", reason: "clock_regressed" };
  return null;
}

function withDevice(
  ledger: EvidenceLedger,
  message: CobotReport | CobotClockEntry,
  state: DeviceRunState | null,
): EvidenceLedger {
  const device = ledger.devices[message.sourceKey];
  if (device === undefined) throw new Error("A checked device is missing");
  return {
    ...ledger,
    devices: {
      ...ledger.devices,
      [message.sourceKey]: {
        sequence: message.sequence,
        clockMs: message.deviceClockMs,
        state: state ?? device.state,
        seen: {
          ...device.seen,
          [String(message.sequence)]: fingerprint(message),
        },
      },
    },
  };
}

function withDispatch(
  ledger: EvidenceLedger,
  record: DispatchRecord,
): EvidenceLedger {
  return {
    ...ledger,
    dispatches: { ...ledger.dispatches, [record.requestId]: record },
  };
}

/**
 * A dispatch record is the caller's own write, made before the send. It
 * must name a task of this run, its pinned device and the identity of the
 * task's first attempt; a second identical record is the same dispatch.
 */
function recordDispatch(
  bake: CompiledBakeRun,
  executionId: string,
  ledger: EvidenceLedger,
  message: CobotTaskMessage,
): Check {
  const evidence = {
    type: message.type,
    sourceKey: message.sourceKey,
    requestId: message.requestId,
    sequence: null,
  };
  const step = stepOfTask(bake, message.taskId);
  if (step === null) return refuse(ledger, evidence, "refused", "unknown_task");
  const known = ledger.dispatches[message.requestId];
  const expected = dispatchIdentity(
    bake.runId,
    executionId,
    `${step.engineTask}@1`,
  );
  if (
    message.requestId !== expected ||
    message.runId !== bake.runId ||
    message.sourceKey !== step.sourceKey ||
    !sameTask(message.task, step.task)
  )
    return refuse(ledger, evidence, "refused", "dispatch_differs");
  if (known !== undefined) return refuse(ledger, evidence, "duplicate", null);
  return {
    ledger: withDispatch(ledger, {
      requestId: message.requestId,
      sourceKey: message.sourceKey,
      task: message.task,
      engineTask: step.engineTask,
      reports: [],
      lost: null,
    }),
    disposition: null,
  };
}

function acceptReport(ledger: EvidenceLedger, report: CobotReport): Check {
  const evidence = {
    type: report.type,
    sourceKey: report.sourceKey,
    requestId: report.requestId,
    sequence: report.sequence,
  };
  const record = ledger.dispatches[report.requestId];
  if (record === undefined)
    return refuse(ledger, evidence, "refused", "unknown_dispatch");
  if (record.sourceKey !== report.sourceKey)
    return refuse(ledger, evidence, "refused", "source_differs");
  const ordered = deviceCheck(ledger, report);
  if (ordered !== null)
    return refuse(ledger, evidence, ordered.outcome, ordered.reason);
  if (!isOpen(record)) {
    // After a reconnect the controller states a task's end again, for the
    // gateway's own status ask and for the Platform's inquiry. The same end
    // says nothing new; a different one is refused.
    const end = terminalReport(record);
    return end !== null &&
      end.state === report.state &&
      end.carrierAt === report.carrierAt &&
      end.reason === report.reason
      ? refuse(ledger, evidence, "duplicate", null)
      : refuse(ledger, evidence, "refused", "after_terminal");
  }
  return {
    ledger: withDispatch(withDevice(ledger, report, null), {
      ...record,
      reports: [...record.reports, report],
    }),
    disposition: null,
  };
}

/**
 * A clock is evidence of time on its device. An idle device with an open,
 * accepted task proves that the task's end was never reported.
 */
function acceptClock(ledger: EvidenceLedger, entry: CobotClockEntry): Check {
  const ordered = deviceCheck(ledger, entry);
  if (ordered !== null)
    return refuse(
      ledger,
      {
        type: "cobot_clock",
        sourceKey: entry.sourceKey,
        requestId: null,
        sequence: entry.sequence,
      },
      ordered.outcome,
      ordered.reason,
    );
  let next = withDevice(ledger, entry, entry.state);
  if (entry.state === "idle")
    for (const record of Object.values(ledger.dispatches))
      if (
        record.sourceKey === entry.sourceKey &&
        record.reports.length > 0 &&
        isOpen(record)
      )
        next = withDispatch(next, {
          ...record,
          lost: { sequence: entry.sequence, clockMs: entry.deviceClockMs },
        });
  return { ledger: next, disposition: null };
}

/** Adds new evidence in arrival order and names each item it refused. */
export function ingestEvidence(
  bake: CompiledBakeRun,
  executionId: string,
  ledger: EvidenceLedger,
  evidence: readonly PhysicalEvidence[],
): Readonly<{
  ledger: EvidenceLedger;
  dispositions: readonly EvidenceDisposition[];
}> {
  let current = ledger;
  const dispositions: EvidenceDisposition[] = [];
  const apply = (check: Check) => {
    current = check.ledger;
    if (check.disposition !== null) dispositions.push(check.disposition);
  };
  for (const item of evidence) {
    if (item.type === "cobot_task")
      apply(recordDispatch(bake, executionId, current, item));
    else if (item.type === "cobot_report") apply(acceptReport(current, item));
    else for (const entry of item.clocks) apply(acceptClock(current, entry));
  }
  return { ledger: current, dispositions };
}
