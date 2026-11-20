import type {
  CobotClockEntry,
  CobotRunSignal,
  CobotTaskMessage,
} from "@purin-labs/control-api";
import type {
  BakeRunHold,
  BakeRunRecord,
} from "@purin-labs/kitchen-control-api";
import { timeFromSeconds } from "@purin-labs/production-simulation";
import {
  compileBakeRun,
  drivePhysicalRun,
  observeBakeRun,
  openDisposition,
  startPhysicalRun,
  type BakeRunInput,
  type BakeRunView,
  type ClockOrigin,
  type PhysicalEvidence,
  type PhysicalRun,
  type PhysicalStop,
} from "@purin-labs/production-simulation/physical";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { writeBakeRunStarted, writeBakeRunState } from "./run-records";
import {
  listBakeRunActions,
  loadBakeRun,
  saveBakeRun,
  setBakeRunActionState,
  writeBakeRunAction,
  type BakeRunApproval,
  type BakeRunDevice,
  type StoredBakeRun,
} from "./run-store";

/**
 * One approved bake run on the server (Plan 24 S4). The run's Durable Object
 * calls these functions; they drive the production engine through the
 * physical execution adapter, and only device receipts move it on.
 *
 * For each task the run writes its action record (the approval, the task,
 * the device and the dispatch identity), reserves the device through
 * Plan 85, records the dispatch identity in its evidence, and only then asks
 * the device fleet Actor to send it. Uncertain evidence stops the next
 * dispatch: a refused or stale report, a failed attempt, an unknown result,
 * a fault, a lost clock or a device that is not ready. The run then shows one
 * hold that a person settles. The Platform never retries a move.
 *
 * Kitchen imports no file of the devices area. The run asks for what it needs
 * from the devices through `BakeRunDevicePorts`; the Worker gives the
 * implementation.
 */

export type RunActor = Readonly<{ kind: "person" | "agent"; id: string }>;

export type BakeRunDevicePorts = Readonly<{
  reserve(
    device: BakeRunDevice,
    input: Readonly<{ taskRef: string; runRef: string; label: string }>,
  ): Promise<boolean>;
  /** Writes the fleet's dispatch record, then sends. Same identity, same task. */
  dispatch(
    device: BakeRunDevice,
    input: Readonly<{
      message: CobotTaskMessage;
      runActorId: string;
      approval: BakeRunApproval;
    }>,
  ): Promise<"sent" | "unsent" | "known">;
  /** The clock of each device behind this device's gateway, now. */
  readClocks(device: BakeRunDevice): Promise<readonly CobotClockEntry[] | null>;
  watch(runActorId: string, devices: readonly BakeRunDevice[]): Promise<void>;
  unwatch(runActorId: string, devices: readonly BakeRunDevice[]): Promise<void>;
  pause(device: BakeRunDevice, actor: RunActor): Promise<boolean>;
  resume(device: BakeRunDevice, actor: RunActor): Promise<boolean>;
  stop(device: BakeRunDevice, requestId: string): Promise<boolean>;
  /** The device's Work fact of this task goes back to idle. */
  release(device: BakeRunDevice, taskRef: string): Promise<void>;
  /** A person checked the machine: an unknown result goes back to idle. */
  settle(device: BakeRunDevice, actor: RunActor): Promise<boolean>;
}>;

export type BakeRunContext = Readonly<{
  sql: SqlStorage;
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  /** The id string of the run's Durable Object, which the fleet calls. */
  actorId: string;
  devices: BakeRunDevicePorts;
  /** Ends the run's proposal through the Organisation Actor (S1's end). */
  endProposal(reason: string): Promise<void>;
  alarm: Readonly<{
    at(time: number): Promise<void>;
    clear(): Promise<void>;
  }>;
}>;

export type BakeRunStart = Readonly<{
  runId: string;
  proposalId: string;
  productName: string;
  input: BakeRunInput;
  devices: readonly BakeRunDevice[];
  approval: BakeRunApproval;
}>;

export type BakeRunError = Readonly<{
  code:
    | "bake_run_missing"
    | "bake_run_invalid"
    | "bake_run_no_clock"
    | "bake_run_not_running"
    | "bake_run_not_paused"
    | "bake_run_not_held"
    | "bake_run_ended"
    | "bake_run_attempt_failed"
    | "bake_run_result_open";
  message: string;
}>;

/** The alarm watches a running run this often, and only while it runs. */
const WATCH_MS = 10_000;
/** An open dispatch with no signal of its devices for this long is lost. */
const EVIDENCE_LOST_MS = 30_000;
/** An unload this much later than its plan after the bake shows a risk. */
const UNLOAD_MARGIN_SECONDS = 60;
const HORIZON = (() => {
  const parsed = timeFromSeconds(12 * 3_600);
  if (!parsed.ok) throw new Error("The run horizon is invalid.");
  return parsed.value;
})();

function refuse(
  code: BakeRunError["code"],
  message: string,
): Result<never, BakeRunError> {
  return { ok: false, error: { code, message } };
}

function deviceOf(run: StoredBakeRun, sourceKey: string): BakeRunDevice {
  const device = run.devices.find((entry) => entry.sourceKey === sourceKey);
  if (device === undefined) throw new Error(`The run has no ${sourceKey}`);
  return device;
}

function held(
  run: StoredBakeRun,
  hold: Omit<BakeRunHold, "at">,
  now: number,
): StoredBakeRun {
  if (run.hold !== null || run.state === "completed" || run.state === "stopped")
    return run;
  return { ...run, state: "held", hold: { ...hold, at: now } };
}

/** Saves the run, and writes its summary and its alarm only on a change. */
async function persist(
  ctx: BakeRunContext,
  before: StoredBakeRun | null,
  after: StoredBakeRun,
  now: number,
): Promise<void> {
  saveBakeRun(ctx.sql, after, now);
  if (before?.state === after.state && before.hold?.code === after.hold?.code)
    return;
  await writeBakeRunState(ctx.db, ctx.organisationId, {
    runId: after.runId,
    state: after.state,
    holdCode: after.hold?.code ?? null,
    endedAt: after.endedAt,
    now,
  });
  if (after.state === "running") await ctx.alarm.at(now + WATCH_MS);
  else await ctx.alarm.clear();
  if (after.state === "completed" || after.state === "stopped")
    await ctx.devices.unwatch(ctx.actorId, after.devices);
}

/**
 * Starts the run of an approved proposal: compiles it, reads each device's
 * clock as the run's logical zero, watches the devices and sends the first
 * task. A second start reads the run that exists.
 */
export async function startBakeRun(
  ctx: BakeRunContext,
  start: BakeRunStart,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const existing = loadBakeRun(ctx.sql);
  if (existing !== null) return { ok: true, value: existing };
  const compiled = await compileBakeRun(start.input);
  if (!compiled.ok)
    return refuse(
      "bake_run_invalid",
      `The run does not compile: ${compiled.error
        .map((problem) => `${problem.field} (${problem.reason})`)
        .join(", ")}.`,
    );
  const origin: Record<string, number> = {};
  const gateways = new Map(start.devices.map((d) => [d.gatewayId, d]));
  for (const device of gateways.values()) {
    const clocks = (await ctx.devices.readClocks(device)) ?? [];
    for (const entry of clocks) origin[entry.sourceKey] = entry.deviceClockMs;
  }
  const clockOrigin: ClockOrigin = Object.fromEntries(
    start.devices
      .filter((device) => origin[device.sourceKey] !== undefined)
      .map((device) => [device.sourceKey, origin[device.sourceKey] ?? 0]),
  );
  const missing = start.devices.find(
    (device) => clockOrigin[device.sourceKey] === undefined,
  );
  if (missing !== undefined)
    return refuse(
      "bake_run_no_clock",
      `The gateway gave no clock for ${missing.name}. Check that its controller is on, then start the run again.`,
    );
  const physical = startPhysicalRun(
    compiled.value,
    { executionId: `exec-${start.runId}`, hostSession: "bake-run-actor" },
    clockOrigin,
  );
  if (!physical.ok)
    return refuse(
      "bake_run_invalid",
      `The run does not start: ${physical.error.code}.`,
    );
  const run: StoredBakeRun = {
    organisationId: ctx.organisationId,
    runId: start.runId,
    proposalId: start.proposalId,
    productName: start.productName,
    state: "running",
    input: start.input,
    devices: start.devices,
    approval: start.approval,
    physical: physical.value,
    hold: null,
    pausedDevices: [],
    lastEvidenceAt: now,
    startedAt: now,
    endedAt: null,
  };
  await ctx.devices.watch(ctx.actorId, run.devices);
  saveBakeRun(ctx.sql, run, now);
  await writeBakeRunStarted(ctx.db, ctx.organisationId, {
    runId: run.runId,
    proposalId: run.proposalId,
    actorId: ctx.actorId,
    now,
  });
  await ctx.alarm.at(now + WATCH_MS);
  return { ok: true, value: await advance(ctx, run, [], now) };
}

/**
 * Drives the run as far as its evidence allows, and sends each task that the
 * engine wants while the run runs. A held or paused run still takes in
 * evidence, so its views stay current, but it sends nothing.
 */
async function advance(
  ctx: BakeRunContext,
  start: StoredBakeRun,
  evidence: readonly PhysicalEvidence[],
  now: number,
): Promise<StoredBakeRun> {
  let run = await resendWritten(ctx, start, now);
  let driven: PhysicalStop = drivePhysicalRun(run.physical, evidence, HORIZON);
  for (let turn = 0; turn < 256; turn += 1) {
    run = { ...run, physical: driven.run };
    const refused = driven.dispositions.find(
      (item) => item.outcome === "refused",
    );
    if (refused !== undefined)
      run = held(
        run,
        {
          code: "stale_evidence",
          message: `${refused.evidence.sourceKey} sent ${refused.evidence.type} that the run refused (${refused.reason ?? "refused"}). Check the device before the run goes on.`,
          step: null,
          requestId: refused.evidence.requestId,
          sourceKey: refused.evidence.sourceKey,
        },
        now,
      );
    const stop = driven.stop;
    if (stop.kind === "evidence") break;
    if (stop.kind === "completed") {
      if (run.state === "running")
        run = { ...run, state: "completed", endedAt: now };
      break;
    }
    if (stop.kind === "disposition") {
      run = held(
        run,
        {
          code: "failed_attempt",
          message: `${stop.step} on ${stop.sourceKey} did not finish (${stop.reason}). The mould group is at: ${stop.carrierAt}. A person checks the machine.`,
          step: stop.step,
          requestId: stop.requestId,
          sourceKey: stop.sourceKey,
        },
        now,
      );
      break;
    }
    if (stop.kind !== "dispatch") {
      run = held(
        run,
        {
          code: "engine_stop",
          message: `The run's engine stopped (${stop.kind}). Stop the run and report it.`,
          step: null,
          requestId: null,
          sourceKey: null,
        },
        now,
      );
      break;
    }
    if (run.state !== "running") break;
    const sent = await dispatchStep(ctx, run, stop.step, stop.message, now);
    run = sent.run;
    driven = sent.driven;
  }
  await persist(ctx, start, run, now);
  return run;
}

/**
 * Writes the action record, reserves the device, records the dispatch
 * identity in the run's evidence and saves it, and only then sends.
 */
async function dispatchStep(
  ctx: BakeRunContext,
  start: StoredBakeRun,
  step: string,
  message: CobotTaskMessage,
  now: number,
): Promise<Readonly<{ run: StoredBakeRun; driven: PhysicalStop }>> {
  const device = deviceOf(start, message.sourceKey);
  writeBakeRunAction(ctx.sql, {
    requestId: message.requestId,
    step,
    deviceId: device.deviceId,
    sourceKey: device.sourceKey,
    task: message.task,
    approval: start.approval,
    writtenAt: now,
  });
  const reserved = await ctx.devices.reserve(device, {
    taskRef: message.requestId,
    runRef: start.runId,
    label: `${start.productName}: ${step}`,
  });
  if (!reserved) {
    setBakeRunActionState(ctx.sql, message.requestId, "refused", now);
    const run = held(
      start,
      {
        code: "device_not_ready",
        message: `${device.name} is not ready for ${step}. Check it on the Devices page, then settle the run.`,
        step,
        requestId: message.requestId,
        sourceKey: device.sourceKey,
      },
      now,
    );
    return {
      run,
      driven: drivePhysicalRun(run.physical, [], HORIZON),
    };
  }
  const driven = drivePhysicalRun(start.physical, [message], HORIZON);
  let run: StoredBakeRun = { ...start, physical: driven.run };
  saveBakeRun(ctx.sql, run, now);
  const sent = await ctx.devices.dispatch(device, {
    message,
    runActorId: ctx.actorId,
    approval: run.approval,
  });
  setBakeRunActionState(
    ctx.sql,
    message.requestId,
    sent === "unsent" ? "unsent" : "sent",
    now,
  );
  if (sent === "unsent")
    run = held(
      run,
      {
        code: "dispatch_unsent",
        message: `The gateway of ${device.name} was not connected, so ${step} was not sent. Settle the run to send it when the gateway is back.`,
        step,
        requestId: message.requestId,
        sourceKey: device.sourceKey,
      },
      now,
    );
  return { run, driven };
}

/**
 * An action that the run wrote and recorded but did not send (the process
 * ended between) goes to the fleet again with the same identity. The fleet's
 * ledger and the gateway's journal make it one task.
 */
async function resendWritten(
  ctx: BakeRunContext,
  run: StoredBakeRun,
  now: number,
): Promise<StoredBakeRun> {
  if (run.state !== "running") return run;
  for (const action of listBakeRunActions(ctx.sql)) {
    if (action.state !== "written") continue;
    const record = run.physical.ledger.dispatches[action.requestId];
    if (record === undefined) continue;
    const device = deviceOf(run, action.sourceKey);
    const sent = await ctx.devices.dispatch(device, {
      message: {
        type: "cobot_task",
        requestId: action.requestId,
        sourceKey: action.sourceKey,
        runId: run.physical.bake.runId,
        taskId: record.engineTask,
        task: action.task,
      },
      runActorId: ctx.actorId,
      approval: run.approval,
    });
    setBakeRunActionState(
      ctx.sql,
      action.requestId,
      sent === "unsent" ? "unsent" : "sent",
      now,
    );
  }
  return run;
}

/** A report, clock, observed move or fault of one of the run's devices. */
export async function receiveBakeRunSignal(
  ctx: BakeRunContext,
  signal: CobotRunSignal,
  now: number,
): Promise<void> {
  const stored = loadBakeRun(ctx.sql);
  if (stored === null || stored.state === "stopped") return;
  const keys = new Set(stored.devices.map((device) => device.sourceKey));
  let run: StoredBakeRun = { ...stored, lastEvidenceAt: now };
  const evidence: PhysicalEvidence[] = [];
  switch (signal.kind) {
    case "report":
      if (!keys.has(signal.report.sourceKey)) return;
      evidence.push(signal.report);
      break;
    case "clock": {
      const clocks = signal.clock.clocks.filter((entry) =>
        keys.has(entry.sourceKey),
      );
      if (clocks.length === 0) return;
      evidence.push({ type: "cobot_clock", clocks });
      break;
    }
    case "observed":
      // Shadow mode (S5) correlates these; an approved run sends its tasks.
      return;
    case "fault":
      if (!keys.has(signal.sourceKey)) return;
      run = held(
        run,
        {
          code: "device_fault",
          message: `${deviceOf(run, signal.sourceKey).name} reported the fault ${signal.faultCode ?? "FAULT"}. A person checks the machine.`,
          step: null,
          requestId: null,
          sourceKey: signal.sourceKey,
        },
        signal.at,
      );
      break;
    case "connection_lost":
      run = held(
        run,
        {
          code: "result_unknown",
          message:
            "The gateway's connection ended while a task was open. Pantry asks the gateway for the task's state when it connects again; a person checks the machine and settles the run.",
          step: null,
          requestId: signal.requestIds[0] ?? null,
          sourceKey: null,
        },
        signal.at,
      );
      break;
  }
  if (run.state === "completed") {
    // A late report after the end only updates the record.
    saveBakeRun(ctx.sql, run, now);
    return;
  }
  await advanceSaved(ctx, stored, run, evidence, now);
}

/** Saves a change that `advance` does not see, then advances. */
async function advanceSaved(
  ctx: BakeRunContext,
  before: StoredBakeRun,
  run: StoredBakeRun,
  evidence: readonly PhysicalEvidence[],
  now: number,
): Promise<StoredBakeRun> {
  if (before.state !== run.state || before.hold !== run.hold)
    await persist(ctx, before, run, now);
  return advance(ctx, run, evidence, now);
}

/** The alarm of a running run: a dispatch whose evidence stopped is held. */
export async function watchBakeRun(
  ctx: BakeRunContext,
  now: number,
): Promise<void> {
  const run = loadBakeRun(ctx.sql);
  if (run?.state !== "running") {
    await ctx.alarm.clear();
    return;
  }
  const open = Object.values(run.physical.ledger.dispatches).find(
    (record) =>
      record.lost === null &&
      !record.reports.some(
        (report) =>
          report.state === "completed" ||
          report.state === "rejected" ||
          report.state === "indeterminate",
      ),
  );
  if (open !== undefined && now - run.lastEvidenceAt > EVIDENCE_LOST_MS) {
    const after = held(
      run,
      {
        code: "evidence_lost",
        message: `${deviceOf(run, open.sourceKey).name} sent no report or clock for ${Math.round(EVIDENCE_LOST_MS / 1000)} s while its task was open. A person checks the machine.`,
        step: null,
        requestId: open.requestId,
        sourceKey: open.sourceKey,
      },
      now,
    );
    await persist(ctx, run, after, now);
    return;
  }
  await ctx.alarm.at(now + WATCH_MS);
}

function loaded(ctx: BakeRunContext): Result<StoredBakeRun, BakeRunError> {
  const run = loadBakeRun(ctx.sql);
  return run === null
    ? refuse("bake_run_missing", "This bake run has not started.")
    : { ok: true, value: run };
}

/**
 * A pause stops the next dispatch and pauses the run's cobots through the
 * Devices page's own pause. The oven keeps its program: a paused oven door
 * would burn the bake. A person resumes it.
 */
export async function pauseBakeRun(
  ctx: BakeRunContext,
  actor: RunActor,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const found = loaded(ctx);
  if (!found.ok) return found;
  const run = found.value;
  if (run.state === "paused") return { ok: true, value: run };
  if (run.state !== "running" && run.state !== "held")
    return refuse(
      "bake_run_not_running",
      `The run is ${run.state}; only a running or held run pauses.`,
    );
  const paused: string[] = [...run.pausedDevices];
  for (const device of run.devices)
    if (
      device.role === "cobot" &&
      !paused.includes(device.deviceId) &&
      (await ctx.devices.pause(device, actor))
    )
      paused.push(device.deviceId);
  const after: StoredBakeRun = {
    ...run,
    state: run.state === "held" ? "held" : "paused",
    pausedDevices: paused,
  };
  await persist(ctx, run, after, now);
  return { ok: true, value: after };
}

export async function resumeBakeRun(
  ctx: BakeRunContext,
  actor: RunActor,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const found = loaded(ctx);
  if (!found.ok) return found;
  const run = found.value;
  if (run.state !== "paused")
    return refuse("bake_run_not_paused", "The run is not paused.");
  for (const device of run.devices)
    if (run.pausedDevices.includes(device.deviceId))
      await ctx.devices.resume(device, actor);
  const after: StoredBakeRun = { ...run, state: "running", pausedDevices: [] };
  return { ok: true, value: await advanceSaved(ctx, run, after, [], now) };
}

/**
 * Stops the run: each device with an open task gets the controller's stop,
 * a task that was never sent frees its device, and the proposal ends. The
 * stock does not change. A position that no receipt proves stays unknown.
 */
export async function stopBakeRun(
  ctx: BakeRunContext,
  actor: RunActor,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const found = loaded(ctx);
  if (!found.ok) return found;
  const run = found.value;
  if (run.state === "stopped") return { ok: true, value: run };
  if (run.state === "completed")
    return refuse("bake_run_ended", "The run has ended.");
  const ledger = run.physical.ledger.dispatches;
  for (const action of listBakeRunActions(ctx.sql)) {
    const device = deviceOf(run, action.sourceKey);
    const record = ledger[action.requestId];
    const ended =
      record !== undefined &&
      (record.lost !== null ||
        record.reports.some(
          (report) =>
            report.state === "completed" ||
            report.state === "rejected" ||
            report.state === "indeterminate",
        ));
    if (action.state === "sent" && !ended)
      await ctx.devices.stop(device, `stop_${action.requestId.slice(4)}`);
    else if (action.state !== "sent")
      await ctx.devices.release(device, action.requestId);
  }
  const after: StoredBakeRun = { ...run, state: "stopped", endedAt: now };
  await persist(ctx, run, after, now);
  await ctx.endProposal(
    `The run was stopped by ${actor.kind === "agent" ? "the agent for " : ""}${actor.id}. Nothing was added to the stock.`,
  );
  return { ok: true, value: after };
}

/**
 * A person settles the run's hold. `stop` stops the run. `continue` lifts
 * the hold after the person checked the machine: an unknown result needs the
 * task's end from the controller first, and an unsent task goes once more
 * with the same identity. A failed attempt cannot continue yet (S6 adds its
 * recovery); stop the run.
 */
export async function settleBakeRun(
  ctx: BakeRunContext,
  decision: "continue" | "stop",
  actor: RunActor,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const found = loaded(ctx);
  if (!found.ok) return found;
  const run = found.value;
  if (run.hold === null)
    return refuse("bake_run_not_held", "The run has nothing to settle.");
  if (decision === "stop") return stopBakeRun(ctx, actor, now);
  if (openDisposition(run.physical) !== null)
    return refuse(
      "bake_run_attempt_failed",
      "A task failed, and the run cannot continue it yet. Check the machine, then stop the run.",
    );
  const actions = listBakeRunActions(ctx.sql);
  if (run.hold.code === "result_unknown" || run.hold.code === "evidence_lost") {
    for (const action of actions) {
      const record = run.physical.ledger.dispatches[action.requestId];
      if (action.state !== "sent" || record === undefined) continue;
      const end = record.reports.find(
        (report) =>
          report.state === "completed" ||
          report.state === "rejected" ||
          report.state === "indeterminate",
      );
      if (end === undefined)
        return refuse(
          "bake_run_result_open",
          `The controller has not reported the end of ${action.step} yet. Wait for the gateway, or stop the run.`,
        );
      await ctx.devices.settle(deviceOf(run, action.sourceKey), actor);
    }
  }
  if (run.hold.code === "dispatch_unsent")
    for (const action of actions) {
      if (action.state !== "unsent") continue;
      const record = run.physical.ledger.dispatches[action.requestId];
      if (record === undefined) continue;
      const sent = await ctx.devices.dispatch(deviceOf(run, action.sourceKey), {
        message: {
          type: "cobot_task",
          requestId: action.requestId,
          sourceKey: action.sourceKey,
          runId: run.physical.bake.runId,
          taskId: record.engineTask,
          task: action.task,
        },
        runActorId: ctx.actorId,
        approval: run.approval,
      });
      if (sent === "unsent")
        return refuse(
          "bake_run_result_open",
          "The gateway is still not connected. Settle the run again when it is back.",
        );
      setBakeRunActionState(ctx.sql, action.requestId, "sent", now);
    }
  const after: StoredBakeRun = {
    ...run,
    hold: null,
    state: run.pausedDevices.length > 0 ? "paused" : "running",
    lastEvidenceAt: now,
  };
  return { ok: true, value: await advanceSaved(ctx, run, after, [], now) };
}

/** The late unload whose delay can burn the bake, once the bake ended. */
function unloadRisk(
  view: BakeRunView,
  physical: PhysicalRun,
): BakeRunRecord["unloadRisk"] {
  const bake = view.tasks.find((task) => task.kind === "bake");
  const ended = bake?.observed.endSeconds ?? null;
  if (bake === undefined || bake.state !== "completed" || ended === null)
    return null;
  let latest = 0;
  for (const [sourceKey, device] of Object.entries(physical.ledger.devices))
    latest = Math.max(
      latest,
      (device.clockMs - (physical.ledger.origin[sourceKey] ?? 0)) / 1_000,
    );
  for (const task of view.tasks) {
    if (task.kind !== "unload" || task.state === "completed") continue;
    const due =
      ended +
      (task.planned.endSeconds - bake.planned.endSeconds) +
      UNLOAD_MARGIN_SECONDS;
    if (latest > due) return { step: task.key, lateSeconds: latest - due };
  }
  return null;
}

/** The run's part of the one read; the Worker adds the D1 summary. */
export function readBakeRunRecord(
  ctx: BakeRunContext,
): Omit<BakeRunRecord, "check" | "problem"> | null {
  const run = loadBakeRun(ctx.sql);
  if (run === null) return null;
  const view = observeBakeRun(run.physical);
  return {
    runId: run.runId,
    proposalId: run.proposalId,
    productName: run.productName,
    state: run.state,
    hold: run.hold,
    approval: run.approval,
    devices: run.devices.map((device) => ({
      deviceId: device.deviceId,
      sourceKey: device.sourceKey,
      name: device.name,
      role: device.role,
    })),
    oven: run.input.oven,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    dispatches: listBakeRunActions(ctx.sql).map((action) => ({
      requestId: action.requestId,
      step: action.step,
      deviceId: action.deviceId,
      sourceKey: action.sourceKey,
      task: action.task,
      state: action.state,
      writtenAt: action.writtenAt,
      sentAt: action.sentAt,
    })),
    unloadRisk: unloadRisk(view, run.physical),
    view: { ...view, tasks: [...view.tasks], groups: [...view.groups] },
  };
}
