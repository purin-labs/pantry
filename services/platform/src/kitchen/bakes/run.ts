import type {
  CobotClockEntry,
  CobotObserved,
  CobotRunSignal,
  CobotTaskMessage,
} from "@purin-labs/control-api";
import type {
  BakeAuthorityMode,
  BakeRunHold,
  BakeRunRecord,
  BakeRunSeen,
} from "@purin-labs/kitchen-control-api";
import { timeFromSeconds } from "@purin-labs/production-simulation";
import {
  compileBakeRun,
  correlateShadowMoves,
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
  nextBakeRunCardRevision,
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
 *
 * S5, shadow mode: a run at a location in shadow mode compiles the same plan,
 * reserves nothing and sends nothing. The controller runs the bake from its
 * own script, as a person at the teach pendant would; the device fleet Actor
 * gives the run each observed move, and the run matches it to its planned
 * task with the difference of the times. A shadow run changes no stock.
 *
 * S6, faults: each uncertain outcome holds the run, and the hold is the one
 * visible disposition on the Bakes page and on the run's Slack card. A person
 * settles it with what they saw; settling never sends a move again. A revoke
 * of a device holds the run at once. When the bake ends and no unload starts
 * within the recipe's grace time, the run shows the over-bake risk and tells
 * the person on shift once in the proposal's Slack thread.
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
  ): Promise<"sent" | "unsent" | "known" | "refused">;
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

/** The run's part of the one read, as the Bakes page and Slack show it. */
export type BakeRunRunRecord = Omit<BakeRunRecord, "check" | "problem">;

/** What the run tells the people of the shop, in the proposal's Slack thread. */
export type BakeRunNotices = Readonly<{
  /** Posts the run's card, or updates it to this revision. */
  card(record: BakeRunRunRecord, revision: number): Promise<void>;
  /** Tells the person on shift of the over-bake risk, once. */
  overBake(
    record: BakeRunRunRecord,
    risk: NonNullable<BakeRunRecord["unloadRisk"]>,
  ): Promise<void>;
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
  notices: BakeRunNotices;
  alarm: Readonly<{
    at(time: number): Promise<void>;
    clear(): Promise<void>;
  }>;
}>;

export type BakeRunStart = Readonly<{
  runId: string;
  proposalId: string;
  productName: string;
  mode: BakeAuthorityMode;
  input: BakeRunInput;
  devices: readonly BakeRunDevice[];
  approval: BakeRunApproval;
  /** The recipe's time between the bake and the unload, in seconds. */
  unloadGraceSeconds: number;
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
    | "bake_run_result_open"
    | "bake_run_seen_required"
    | "bake_run_shadow";
  message: string;
}>;

/**
 * The alarm watches a running run this often, and a paused or held run only
 * while its bake has ended and its unload has not started.
 */
const WATCH_MS = 10_000;
/** An open dispatch with no signal of its devices for this long is lost. */
const EVIDENCE_LOST_MS = 30_000;
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

/**
 * Saves the run. Its summary row, its alarm and its Slack card change only
 * when its state or its hold changes, and Slack hears of an over-bake risk
 * once.
 */
async function persist(
  ctx: BakeRunContext,
  before: StoredBakeRun | null,
  after: StoredBakeRun,
  now: number,
): Promise<void> {
  saveBakeRun(ctx.sql, after, now);
  const changed =
    before?.state !== after.state || before.hold?.code !== after.hold?.code;
  if (changed)
    await writeBakeRunState(ctx.db, ctx.organisationId, {
      runId: after.runId,
      state: after.state,
      holdCode: after.hold?.code ?? null,
      endedAt: after.endedAt,
      now,
    });
  if (changed || (before !== null && wantsAlarm(before) !== wantsAlarm(after)))
    if (wantsAlarm(after)) await ctx.alarm.at(now + WATCH_MS);
    else await ctx.alarm.clear();
  if (changed && (after.state === "completed" || after.state === "stopped"))
    await ctx.devices.unwatch(ctx.actorId, after.devices);
  const risk = before?.overBake === null && after.overBake !== null;
  if (!changed && !risk) return;
  const record = recordOf(ctx, after);
  await ctx.notices.card(record, nextBakeRunCardRevision(ctx.sql));
  if (risk && record.unloadRisk !== null)
    await ctx.notices.overBake(record, record.unloadRisk);
}

/**
 * A shadow run sends nothing, so it has no dispatch to watch. A paused or
 * held run is watched only for the over-bake risk of its unload.
 */
function wantsAlarm(run: StoredBakeRun): boolean {
  if (run.mode === "shadow") return false;
  if (run.state === "running") return true;
  return (
    (run.state === "paused" || run.state === "held") &&
    run.overBake === null &&
    unloadWindow(observeBakeRun(run.physical)) !== null
  );
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
    mode: start.mode,
    state: "running",
    input: start.input,
    devices: start.devices,
    approval: start.approval,
    physical: physical.value,
    hold: null,
    pausedDevices: [],
    lastEvidenceAt: now,
    observed: [],
    unloadGraceSeconds: start.unloadGraceSeconds,
    progress: {},
    overBake: null,
    settlements: [],
    startedAt: now,
    endedAt: null,
  };
  await ctx.devices.watch(ctx.actorId, run.devices);
  saveBakeRun(ctx.sql, run, now);
  await writeBakeRunStarted(ctx.db, ctx.organisationId, {
    runId: run.runId,
    proposalId: run.proposalId,
    actorId: ctx.actorId,
    mode: run.mode,
    now,
  });
  await ctx.notices.card(recordOf(ctx, run), nextBakeRunCardRevision(ctx.sql));
  if (run.mode === "shadow") return { ok: true, value: run };
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
  run = withOverBake(
    withProgress(run, now),
    latestSeconds(run.physical, null),
    now,
  );
  await persist(ctx, start, run, now);
  return run;
}

/** The run with the time when each device's sequence last rose. */
function withProgress(run: StoredBakeRun, now: number): StoredBakeRun {
  let progress = run.progress;
  for (const [sourceKey, device] of Object.entries(run.physical.ledger.devices))
    if (device.sequence > (progress[sourceKey]?.sequence ?? -1))
      progress = {
        ...progress,
        [sourceKey]: { sequence: device.sequence, at: now },
      };
  return progress === run.progress ? run : { ...run, progress };
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
  let run: StoredBakeRun = {
    ...start,
    physical: driven.run,
    lastEvidenceAt: now,
  };
  saveBakeRun(ctx.sql, run, now);
  const sent = await ctx.devices.dispatch(device, {
    message,
    runActorId: ctx.actorId,
    approval: run.approval,
  });
  setBakeRunActionState(
    ctx.sql,
    message.requestId,
    sent === "known" ? "sent" : sent,
    now,
  );
  if (sent === "refused")
    run = held(
      run,
      {
        code: "dispatch_refused",
        message: `The device fleet refused ${step} for ${device.name}: the run did not watch the device. Nothing was sent. Settle the run to send it again, or stop it.`,
        step,
        requestId: message.requestId,
        sourceKey: device.sourceKey,
      },
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
      sent === "known" ? "sent" : sent,
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
  if (stored.mode === "shadow") {
    if (signal.kind === "observed")
      await observeShadowMove(ctx, stored, signal.observed, now);
    return;
  }
  const keys = new Set(stored.devices.map((device) => device.sourceKey));
  let run: StoredBakeRun = stored;
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
      // Only a shadow run (S5) correlates these; this run sends its tasks.
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
    case "device_revoked":
      if (!keys.has(signal.sourceKey)) return;
      run = held(
        run,
        {
          code: "device_revoked",
          message: `${deviceOf(run, signal.sourceKey).name} was revoked on the Devices page. Pantry sends it no task. A person checks the machine, then continues with the other devices or stops the run.`,
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
  // A late report after the end changes nothing.
  if (run.state === "completed") return;
  await advanceSaved(ctx, stored, run, evidence, now);
}

function shadowOf(run: StoredBakeRun) {
  return correlateShadowMoves(run.physical.bake.plan, {
    origin: run.physical.ledger.origin,
    messages: run.observed,
  });
}

/**
 * A shadow run keeps each observed move of its devices. When every planned
 * task has a completed move, the run completes and its proposal ends: Pantry
 * sent nothing, and the stock does not change.
 */
async function observeShadowMove(
  ctx: BakeRunContext,
  run: StoredBakeRun,
  observed: CobotObserved,
  now: number,
): Promise<void> {
  if (
    run.state !== "running" ||
    !run.devices.some((device) => device.sourceKey === observed.sourceKey) ||
    run.observed.some(
      (known) =>
        known.sourceKey === observed.sourceKey &&
        known.observationId === observed.observationId &&
        known.state === observed.state,
    )
  )
    return;
  let after: StoredBakeRun = {
    ...run,
    observed: [...run.observed, observed],
    lastEvidenceAt: now,
  };
  const shadow = shadowOf(after);
  const done =
    shadow.unobserved.length === 0 &&
    run.physical.bake.plan.steps.every((step) =>
      shadow.matches.some(
        (match) =>
          match.planned?.key === step.key && match.state === "completed",
      ),
    );
  if (done) after = { ...after, state: "completed", endedAt: now };
  await persist(ctx, run, after, now);
  if (done) {
    const steps = run.physical.bake.plan.steps.length;
    await ctx.endProposal(
      `Shadow run: the controller made each of the ${steps} planned moves. Pantry sent nothing, and the stock did not change.`,
    );
  }
}

function refuseShadow(): Result<never, BakeRunError> {
  return refuse(
    "bake_run_shadow",
    "This run is in shadow mode: it sends nothing to the devices. Pause or stop the cobots at their teach pendant, or stop watching the run.",
  );
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

/**
 * The alarm of an active run: a dispatch whose evidence stopped is held, and
 * an unload that does not start within the recipe's grace time after the
 * bake shows the over-bake risk. Device time comes from the gateway, because
 * a paused run gets no clock while no task is open.
 */
export async function watchBakeRun(
  ctx: BakeRunContext,
  now: number,
): Promise<void> {
  const run = loadBakeRun(ctx.sql);
  if (run === null || !wantsAlarm(run)) {
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
  // A device is silent when no new line of it came: a repeated or stale
  // clock of a frozen device is no sign of life.
  const heard =
    open === undefined
      ? now
      : Math.max(run.lastEvidenceAt, run.progress[open.sourceKey]?.at ?? 0);
  if (
    run.state === "running" &&
    open !== undefined &&
    now - heard > EVIDENCE_LOST_MS
  ) {
    const after = held(
      run,
      {
        code: "evidence_lost",
        message: `${deviceOf(run, open.sourceKey).name} sent no new report or clock for ${Math.round(EVIDENCE_LOST_MS / 1000)} s while its task was open: its data is stale. A person checks the machine.`,
        step: null,
        requestId: open.requestId,
        sourceKey: open.sourceKey,
      },
      now,
    );
    await persist(ctx, run, after, now);
    return;
  }
  let after = run;
  if (unloadWindow(observeBakeRun(run.physical)) !== null) {
    const oven =
      run.devices.find((device) => device.role === "oven") ?? run.devices[0];
    const clocks =
      oven === undefined ? null : await ctx.devices.readClocks(oven);
    after = withOverBake(run, latestSeconds(run.physical, clocks), now);
    if (after !== run) await persist(ctx, run, after, now);
  }
  if (wantsAlarm(after)) await ctx.alarm.at(now + WATCH_MS);
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
  if (run.mode === "shadow") return refuseShadow();
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
  if (run.mode === "shadow") return refuseShadow();
  if (run.state !== "paused")
    return refuse("bake_run_not_paused", "The run is not paused.");
  for (const device of run.devices)
    if (run.pausedDevices.includes(device.deviceId))
      await ctx.devices.resume(device, actor);
  const after: StoredBakeRun = {
    ...run,
    state: "running",
    pausedDevices: [],
    lastEvidenceAt: now,
  };
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
    `The ${run.mode === "shadow" ? "shadow run" : "run"} was stopped by ${actor.kind === "agent" ? "the agent for " : ""}${actor.id}. Nothing was added to the stock.`,
  );
  return { ok: true, value: after };
}

/**
 * A person settles the run's hold with what they saw at the machine, and the
 * settlement stays on the run. Settling never sends a move again. `stop`
 * stops the run. `continue` lifts the hold: an unknown result needs the
 * task's end from the controller first, and a task that did not reach the
 * gateway goes once more with the same identity, so the gateway's journal
 * makes it one move. A failed task does not go again: the person says where
 * the mould group is, and the run stops.
 */
export async function settleBakeRun(
  ctx: BakeRunContext,
  input: Readonly<{ decision: "continue" | "stop"; seen: BakeRunSeen | null }>,
  actor: RunActor,
  now: number,
): Promise<Result<StoredBakeRun, BakeRunError>> {
  const found = loaded(ctx);
  if (!found.ok) return found;
  const run = found.value;
  if (run.mode === "shadow") return refuseShadow();
  const hold = run.hold;
  if (hold === null)
    return refuse("bake_run_not_held", "The run has nothing to settle.");
  const failed = openDisposition(run.physical) !== null;
  if (failed && input.decision === "continue")
    return refuse(
      "bake_run_attempt_failed",
      "A task failed, and Pantry does not send a move again. Say where the mould group is, then stop the run.",
    );
  if (failed && input.seen === null)
    return refuse(
      "bake_run_seen_required",
      "Say where you saw the mould group: on its source shelf, on the cobot's tool, on its destination shelf, or lost.",
    );
  const settled: StoredBakeRun = {
    ...run,
    settlements: [
      ...run.settlements,
      {
        holdCode: hold.code,
        step: hold.step,
        decision: input.decision,
        seen: input.seen,
        by: actor.id,
        at: now,
      },
    ],
  };
  if (input.decision === "stop") {
    saveBakeRun(ctx.sql, settled, now);
    return stopBakeRun(ctx, actor, now);
  }
  const actions = listBakeRunActions(ctx.sql);
  if (hold.code === "result_unknown" || hold.code === "evidence_lost") {
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
  if (hold.code === "dispatch_unsent" || hold.code === "dispatch_refused") {
    if (hold.code === "dispatch_refused")
      await ctx.devices.watch(ctx.actorId, run.devices);
    const left = hold.code === "dispatch_refused" ? "refused" : "unsent";
    for (const action of actions) {
      if (action.state !== left) continue;
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
      if (sent === "unsent" || sent === "refused")
        return refuse(
          "bake_run_result_open",
          "The gateway did not take the task. Settle the run again when it is back.",
        );
      setBakeRunActionState(ctx.sql, action.requestId, "sent", now);
    }
  }
  const after: StoredBakeRun = {
    ...settled,
    hold: null,
    state: run.pausedDevices.length > 0 ? "paused" : "running",
    lastEvidenceAt: now,
  };
  return { ok: true, value: await advanceSaved(ctx, run, after, [], now) };
}

type EngineTask = BakeRunView["tasks"][number];

/** The bake that ended and the unloads that have not started, if any. */
function unloadWindow(view: BakeRunView): Readonly<{
  bake: EngineTask;
  endedSeconds: number;
  waiting: readonly EngineTask[];
}> | null {
  const bake = view.tasks.find((task) => task.kind === "bake");
  const endedSeconds = bake?.observed.endSeconds ?? null;
  if (bake === undefined || bake.state !== "completed" || endedSeconds === null)
    return null;
  const waiting = view.tasks.filter(
    (task) => task.kind === "unload" && task.observed.startSeconds === null,
  );
  return waiting.length === 0 ? null : { bake, endedSeconds, waiting };
}

/** The latest device time of the run, in its logical seconds. */
function latestSeconds(
  physical: PhysicalRun,
  clocks: readonly CobotClockEntry[] | null,
): number {
  const { origin, devices } = physical.ledger;
  let latest = 0;
  for (const [sourceKey, device] of Object.entries(devices))
    latest = Math.max(
      latest,
      (device.clockMs - (origin[sourceKey] ?? 0)) / 1_000,
    );
  for (const entry of clocks ?? [])
    if (origin[entry.sourceKey] !== undefined)
      latest = Math.max(
        latest,
        (entry.deviceClockMs - (origin[entry.sourceKey] ?? 0)) / 1_000,
      );
  return latest;
}

/**
 * The first unload that did not start within the grace time after the bake
 * ended, measured from its planned gap to the bake, and how late it is.
 */
function lateUnload(
  run: StoredBakeRun,
  nowSeconds: number,
): Readonly<{ step: string; lateSeconds: number }> | null {
  const window = unloadWindow(observeBakeRun(run.physical));
  if (window === null) return null;
  for (const task of window.waiting) {
    const due =
      window.endedSeconds +
      (task.planned.startSeconds - window.bake.planned.endSeconds) +
      run.unloadGraceSeconds;
    if (nowSeconds > due)
      return {
        step: task.key,
        lateSeconds: Math.round((nowSeconds - due) * 10) / 10,
      };
  }
  return null;
}

/** The run with the over-bake risk that it found now, once. */
function withOverBake(
  run: StoredBakeRun,
  nowSeconds: number,
  now: number,
): StoredBakeRun {
  if (run.mode === "shadow" || run.overBake !== null) return run;
  const late = lateUnload(run, nowSeconds);
  return late === null
    ? run
    : { ...run, overBake: { ...late, detectedAt: now } };
}

/** The run's part of the one read; the Worker adds the D1 summary. */
export function readBakeRunRecord(
  ctx: BakeRunContext,
): BakeRunRunRecord | null {
  const run = loadBakeRun(ctx.sql);
  return run === null ? null : recordOf(ctx, run);
}

function recordOf(ctx: BakeRunContext, run: StoredBakeRun): BakeRunRunRecord {
  const shadow = run.mode === "shadow" ? shadowOf(run) : null;
  const engineView = observeBakeRun(run.physical);
  const view: RecordView =
    shadow === null
      ? {
          ...engineView,
          tasks: [...engineView.tasks],
          groups: [...engineView.groups],
        }
      : shadowView(engineView, shadow);
  const late =
    run.overBake ??
    (shadow === null
      ? lateUnload(run, latestSeconds(run.physical, null))
      : null);
  return {
    runId: run.runId,
    proposalId: run.proposalId,
    productName: run.productName,
    mode: run.mode,
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
    unloadRisk:
      late === null
        ? null
        : {
            step: late.step,
            lateSeconds: late.lateSeconds,
            graceSeconds: run.unloadGraceSeconds,
            notifiedAt: run.overBake?.detectedAt ?? null,
          },
    settlements: [...run.settlements],
    view,
    shadow:
      shadow === null
        ? null
        : {
            matches: shadow.matches.map((match) => ({ ...match })),
            unobserved: [...shadow.unobserved],
          },
  };
}

type ShadowCorrelation = ReturnType<typeof correlateShadowMoves>;
type RecordView = NonNullable<BakeRunRecord["view"]>;
type ViewTask = RecordView["tasks"][number];
type ViewGroup = RecordView["groups"][number];

/**
 * The views of a shadow run: each planned task shows the times and the state
 * of the move that the controller made, and each mould group the place where
 * the last observed move left it. A task with no observed move stays planned.
 * A move of a group that the run does not bake stays in `shadow.matches`.
 */
function shadowView(view: BakeRunView, shadow: ShadowCorrelation): RecordView {
  const tasks: ViewTask[] = view.tasks.map((task) => {
    const match = shadow.matches.find((item) => item.planned?.key === task.key);
    if (match === undefined)
      return {
        ...task,
        state: task.state === "ready" ? "planned" : task.state,
      };
    const { startSeconds, endSeconds } = match.observed;
    return {
      ...task,
      state:
        match.state === "completed"
          ? "completed"
          : match.state === "failed"
            ? "failed"
            : "running",
      observed: {
        startSeconds,
        endSeconds,
        observedSeconds:
          startSeconds === null || endSeconds === null
            ? null
            : endSeconds - startSeconds,
      },
      carrierAt: match.carrierAt,
      reason: match.reason,
    };
  });
  const groups = new Map<number, ViewGroup>(
    view.groups.map((group) => [group.mouldGroup, group]),
  );
  let latest = view.logicalSeconds;
  for (const match of shadow.matches) {
    latest = Math.max(
      latest,
      match.observed.endSeconds ?? match.observed.startSeconds ?? 0,
    );
    const task = match.task;
    // A group outside the run shows in the observed moves only.
    if (
      task.kind !== "move_mould_group" ||
      match.state === "started" ||
      !groups.has(task.mouldGroup)
    )
      continue;
    const at = match.carrierAt ?? "unknown";
    groups.set(task.mouldGroup, {
      mouldGroup: task.mouldGroup,
      basis: "observed",
      position:
        at === "source" || at === "destination"
          ? { kind: "place", place: at === "source" ? task.from : task.to }
          : at === "tool"
            ? { kind: "tool", sourceKey: match.sourceKey }
            : { kind: "unknown" },
    });
  }
  return {
    ...view,
    logicalSeconds: latest,
    tasks,
    groups: [...groups.values()].sort(
      (left, right) => left.mouldGroup - right.mouldGroup,
    ),
  };
}
