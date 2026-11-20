#!/usr/bin/env node
// Plan 24 S4 (engine): one approved bake run with two cobots and one oven,
// driven only by dispatch records and device receipts through the physical
// execution adapter of the production engine.
//
//   node_modules/.bin/tsx scripts/plan-24/physical-run-journey.mjs [output.json]
//
// The bench below stands in for the gateway and the controller: it answers
// each dispatch with the receipts and clocks a controller would send, at
// device times that differ from the plan. It decides nothing about the run;
// the engine module must reach each outcome from that evidence alone.
// Cases:
//   full-run      a complete run, also replayed from its receipt log at once
//                 and one message at a time; the three reads must agree
//   no-receipt    a dispatch with no receipt stops the loop; nothing else starts
//   indeterminate an uncertain move leaves its group unknown and stops dispatch
//   stale         stale, unknown and regressed evidence is named and changes nothing
//   shadow        observed moves correlate to the planned tasks
// The artifact holds no wall-clock time, so a second run writes the same file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { timeFromSeconds } from "../../packages/production-simulation/src/index.ts";
import {
  compileBakeRun,
  correlateShadowMoves,
  drivePhysicalRun,
  observeBakeRun,
  planBakeRun,
  startPhysicalRun,
} from "../../packages/production-simulation/src/physical/index.ts";

const output = resolve(
  process.argv[2] ?? "output/plan-24/physical-run-journey.json",
);

function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}

function digest(content) {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

const COBOTS = ["cobot-1", "cobot-2"];
const OVEN = "oven-1";
const DEVICES = [...COBOTS, OVEN];
// Each device counts its own clock from its own start.
const ORIGIN = {
  "cobot-1": 7_200_000,
  "cobot-2": 3_600_500,
  "oven-1": 912_000,
};
const HORIZON = value(timeFromSeconds(12 * 3_600));

const INPUT = {
  runId: "bake-2026-11-21-a",
  recipeRevision: digest({ recipe: "financier", revision: 7 }),
  mouldGroups: [
    { mouldGroup: 1, coldRackShelf: 2, ovenShelf: 1, coolingRackShelf: 1 },
    { mouldGroup: 2, coldRackShelf: 4, ovenShelf: 2, coolingRackShelf: 2 },
    { mouldGroup: 3, coldRackShelf: 6, ovenShelf: 3, coolingRackShelf: 3 },
  ],
  oven: { programSeconds: 90, temperatureC: 180 },
  cobots: COBOTS,
  ovenSource: OVEN,
  moveSeconds: { load: 20, unload: 24 },
};

// The seconds each task really takes on the bench, by step key.
const OBSERVED = {
  "load-1": 22.5,
  "load-2": 23.1,
  "load-3": 21.7,
  bake: 93,
  "unload-1": 25.9,
  "unload-2": 24.4,
  "unload-3": 26.2,
};

/**
 * The gateway and controller as the run sees them: per device a rising
 * sequence and a monotonic clock, receipts for each task, and one clock
 * message each second while a task is open.
 */
class Bench {
  constructor() {
    this.seconds = 0;
    this.sequence = Object.fromEntries(DEVICES.map((key) => [key, 0]));
    this.log = [];
  }

  clockMs(sourceKey, seconds) {
    return ORIGIN[sourceKey] + Math.round(seconds * 1_000);
  }

  next(sourceKey) {
    this.sequence[sourceKey] += 1;
    return this.sequence[sourceKey];
  }

  report(message, seconds, state, fields) {
    return {
      type: "cobot_report",
      requestId: message.requestId,
      sourceKey: message.sourceKey,
      state,
      sequence: this.next(message.sourceKey),
      deviceClockMs: this.clockMs(message.sourceKey, seconds),
      progress: null,
      phase: null,
      carrierAt: null,
      reason: null,
      observedSeconds: null,
      replayed: false,
      ...fields,
    };
  }

  clock(seconds, busy) {
    return {
      type: "cobot_clock",
      clocks: DEVICES.map((sourceKey) => ({
        sourceKey,
        sequence: this.next(sourceKey),
        deviceClockMs: this.clockMs(sourceKey, seconds),
        state: sourceKey === busy ? "busy" : "idle",
      })),
    };
  }

  /** The receipt plan of one task, as offsets in seconds. */
  points(message, duration) {
    if (message.task.kind === "bake") {
      const points = [[0, "accepted", { phase: "preheated", progress: 0 }]];
      for (let at = 15; at < duration; at += 15)
        points.push([
          at,
          "running",
          { phase: "baking", progress: at / duration },
        ]);
      points.push([
        duration,
        "completed",
        { phase: "done", progress: 1, observedSeconds: duration },
      ]);
      return points;
    }
    return [
      [0, "accepted", { phase: "accepted", progress: 0, carrierAt: "source" }],
      [
        0.2,
        "running",
        { phase: "approach", progress: 0.05, carrierAt: "source" },
      ],
      [
        0.3 * duration,
        "running",
        { phase: "lift", progress: 0.3, carrierAt: "tool" },
      ],
      [
        0.55 * duration,
        "running",
        { phase: "door", progress: 0.55, carrierAt: "tool" },
      ],
      [
        0.8 * duration,
        "running",
        { phase: "release", progress: 0.8, carrierAt: "destination" },
      ],
      [
        duration,
        "completed",
        {
          phase: "done",
          progress: 1,
          carrierAt: "destination",
          observedSeconds: duration,
        },
      ],
    ];
  }

  /**
   * Runs one dispatched task. `cut` stops the receipts after that many and
   * then sends `ending` instead: a report, an idle clock, or nothing.
   */
  run(message, duration, cut = null, ending = null) {
    const start = this.seconds + 0.4;
    const items = [];
    let points = this.points(message, duration);
    if (cut !== null) points = points.slice(0, cut);
    const last = start + (points.at(-1)?.[0] ?? 0);
    const timeline = points.map(([offset, state, fields]) => [
      start + offset,
      "report",
      state,
      fields,
    ]);
    for (let at = Math.ceil(start); at < last; at += 1)
      timeline.push([at, "clock"]);
    timeline.sort((left, right) => left[0] - right[0]);
    for (const [at, kind, state, fields] of timeline)
      items.push(
        kind === "clock"
          ? this.clock(at, message.sourceKey)
          : this.report(message, at, state, fields),
      );
    if (ending?.kind === "indeterminate")
      items.push(
        this.report(message, last + 1.5, "indeterminate", {
          carrierAt: ending.carrierAt,
          reason: ending.reason,
        }),
      );
    if (ending?.kind === "idle-clock") items.push(this.clock(last + 2, null));
    this.seconds = cut === null ? last : last + 2;
    this.log.push(message, ...items);
    return [message, ...items];
  }
}

async function compiled() {
  return value(await compileBakeRun(INPUT));
}

function started(bake, name) {
  return value(
    startPhysicalRun(
      bake,
      { executionId: `physical-${name}`, hostSession: `do-${name}` },
      ORIGIN,
    ),
  );
}

/** Drives a run with the bench until the run stops for another reason. */
function driveWithBench(physical, bench, faults = {}) {
  let evidence = [];
  const stops = [];
  for (;;) {
    const result = drivePhysicalRun(physical, evidence, HORIZON);
    physical = result.run;
    assert.deepEqual(
      result.dispositions,
      [],
      "the bench sends only fresh evidence",
    );
    stops.push(result.stop.kind);
    if (result.stop.kind !== "dispatch")
      return { physical, stop: result.stop, stops };
    const { step, message } = result.stop;
    const fault = faults[step];
    if (fault?.kind === "record-only") {
      bench.log.push(message);
      evidence = [message];
      faults[step] = { kind: "done" };
      continue;
    }
    if (fault?.kind === "done") return { physical, stop: result.stop, stops };
    evidence = bench.run(
      message,
      OBSERVED[step],
      fault?.cut ?? null,
      fault ?? null,
    );
  }
}

function intervalsOf(events, resource) {
  const open = new Map();
  const spans = [];
  for (const event of events) {
    if (event.resource !== resource) continue;
    if (event.kind === "resource-claimed" && !open.has(event.task))
      open.set(event.task, event.time);
    if (event.kind === "resource-released" && open.has(event.task)) {
      spans.push({
        task: event.task,
        start: open.get(event.task),
        end: event.time,
      });
      open.delete(event.task);
    }
  }
  return spans.sort((left, right) => left.start - right.start);
}

function assertNoOverlap(spans, subject) {
  for (let index = 1; index < spans.length; index += 1)
    assert.ok(
      spans[index - 1].end <= spans[index].start,
      `${subject}: ${spans[index - 1].task} and ${spans[index].task} overlap`,
    );
}

const cases = [];

// --- full-run ----------------------------------------------------------------
{
  const bake = await compiled();
  const plan = bake.plan;
  const moves = plan.steps.filter((step) => step.kind !== "bake");
  const cobotsUsed = [...new Set(moves.map((step) => step.sourceKey))].sort();
  assert.deepEqual(cobotsUsed, COBOTS, "the plan uses both cobots");
  const planDoor = moves
    .map((step) => ({ task: step.key, start: step.start, end: step.end }))
    .sort((left, right) => left.start - right.start);
  assertNoOverlap(planDoor, "planned door use");

  // With cobot-1 withheld at the start, the engine gives its loads to cobot-2.
  const withheld = value(
    await planBakeRun({
      ...INPUT,
      unavailable: [{ sourceKey: "cobot-1", fromSeconds: 0, toSeconds: 600 }],
    }),
  );
  const withheldLoads = withheld.steps
    .filter((step) => step.kind === "load")
    .map((step) => step.sourceKey);
  assert.deepEqual(withheldLoads, ["cobot-2", "cobot-2", "cobot-2"]);

  const bench = new Bench();
  const driven = driveWithBench(started(bake, "full"), bench);
  assert.equal(driven.stop.kind, "completed", JSON.stringify(driven.stop));
  const view = observeBakeRun(driven.physical);
  for (const task of view.tasks) {
    assert.equal(task.state, "completed", task.key);
    assert.notEqual(task.observed.startSeconds, null, task.key);
    assert.notEqual(
      task.observed.endSeconds,
      task.planned.endSeconds,
      task.key,
    );
    assert.notEqual(
      task.observed.startSeconds,
      task.planned.startSeconds,
      task.key,
    );
    assert.equal(task.observed.observedSeconds, OBSERVED[task.key], task.key);
  }
  for (const group of view.groups) {
    const input = INPUT.mouldGroups.find(
      (entry) => entry.mouldGroup === group.mouldGroup,
    );
    assert.deepEqual(group.position, {
      kind: "place",
      place: { station: "cooling_rack", shelf: input.coolingRackShelf },
    });
    assert.equal(group.basis, "receipt");
  }
  assert.equal(view.disposition, null);
  const physicalDoor = intervalsOf(driven.physical.run.events, "oven-door");
  assert.equal(physicalDoor.length, 6, "each move held the oven door");
  assertNoOverlap(physicalDoor, "observed door use");

  // The receipt log replays to the same run, at once and one item at a time.
  const log = bench.log;
  const atOnce = drivePhysicalRun(started(bake, "full"), log, HORIZON);
  assert.equal(atOnce.stop.kind, "completed");
  assert.deepEqual(atOnce.dispositions, []);
  let single = started(bake, "full");
  let singleStop = null;
  for (const item of log) {
    const result = drivePhysicalRun(single, [item], HORIZON);
    assert.deepEqual(result.dispositions, []);
    single = result.run;
    singleStop = result.stop;
  }
  assert.equal(singleStop.kind, "completed");
  const runDigest = digest(driven.physical.run.events);
  assert.equal(digest(atOnce.run.run.events), runDigest, "replay at once");
  assert.equal(digest(single.run.events), runDigest, "replay one by one");
  assert.deepEqual(observeBakeRun(atOnce.run), view);
  assert.deepEqual(observeBakeRun(single), view);

  cases.push({
    name: "full-run",
    outcome: "completed with every group on the cooling rack",
    plan: plan.steps.map((step) => ({
      key: step.key,
      sourceKey: step.sourceKey,
      startSeconds: step.start / 1e6,
      endSeconds: step.end / 1e6,
    })),
    withheldPlanLoads: withheldLoads,
    view,
    observedDoor: physicalDoor.map((span) => ({
      task: span.task,
      startSeconds: span.start / 1e6,
      endSeconds: span.end / 1e6,
    })),
    receiptLog: { items: log.length, digest: digest(log) },
    engineEvents: {
      count: driven.physical.run.events.length,
      digest: runDigest,
    },
    completedAtSeconds: driven.stop.at / 1e6,
  });
}

// --- no-receipt --------------------------------------------------------------
{
  const bake = await compiled();
  const bench = new Bench();
  const driven = driveWithBench(started(bake, "silent"), bench, {
    "load-1": { kind: "record-only" },
  });
  assert.deepEqual(
    {
      kind: driven.stop.kind,
      step: driven.stop.step,
      awaiting: driven.stop.awaiting,
    },
    { kind: "evidence", step: "load-1", awaiting: "receipt" },
  );
  // Device time alone is no receipt.
  const later = drivePhysicalRun(
    driven.physical,
    [bench.clock(30, null)],
    HORIZON,
  );
  assert.equal(later.stop.kind, "evidence");
  assert.equal(later.stop.step, "load-1");
  const view = observeBakeRun(later.run);
  for (const task of view.tasks) {
    assert.equal(
      task.state,
      task.key === "load-1" ? "dispatched" : "planned",
      task.key,
    );
    assert.equal(task.reason, null, task.key);
    assert.equal(task.observed.startSeconds, null, task.key);
  }
  const dispatches = bench.log.filter((item) => item.type === "cobot_task");
  assert.equal(dispatches.length, 1, "no later task was dispatched");
  cases.push({
    name: "no-receipt",
    outcome: "the loop waits for the receipt of load-1; nothing later starts",
    stop: later.stop,
    view,
  });
}

// --- indeterminate -----------------------------------------------------------
{
  const bake = await compiled();
  const bench = new Bench();
  // load-2 lifts its group, then the gateway reconnects and the controller
  // has no record of the task.
  const driven = driveWithBench(started(bake, "uncertain"), bench, {
    "load-2": {
      kind: "indeterminate",
      cut: 4,
      carrierAt: null,
      reason: "controller_has_no_record",
    },
  });
  assert.deepEqual(
    {
      kind: driven.stop.kind,
      step: driven.stop.step,
      carrierAt: driven.stop.carrierAt,
      reason: driven.stop.reason,
    },
    {
      kind: "disposition",
      step: "load-2",
      carrierAt: "unknown",
      reason: "controller_has_no_record",
    },
  );
  const again = drivePhysicalRun(
    driven.physical,
    [bench.clock(200, null)],
    HORIZON,
  );
  assert.equal(
    again.stop.kind,
    "disposition",
    "more device time dispatches nothing",
  );
  const view = observeBakeRun(again.run);
  const byKey = Object.fromEntries(view.tasks.map((task) => [task.key, task]));
  assert.equal(byKey["load-1"].state, "completed");
  assert.equal(byKey["load-2"].state, "failed");
  for (const key of ["load-3", "bake", "unload-1", "unload-2", "unload-3"])
    assert.equal(byKey[key].state, "planned", key);
  const groups = Object.fromEntries(
    view.groups.map((group) => [group.mouldGroup, group]),
  );
  assert.deepEqual(groups[1].position, {
    kind: "place",
    place: { station: "oven", shelf: 1 },
  });
  assert.deepEqual(groups[2].position, { kind: "unknown" });
  assert.deepEqual(groups[3].position, {
    kind: "place",
    place: { station: "cold_rack", shelf: 6 },
  });
  assert.equal(groups[3].basis, "declared");
  assert.deepEqual(view.disposition, again.stop);

  // A completion report that never arrives: the device clock shows the cobot
  // idle while its task is open. The task fails with its group unknown.
  const lostBench = new Bench();
  const lost = driveWithBench(started(bake, "lost"), lostBench, {
    "load-1": { kind: "idle-clock", cut: 5 },
  });
  assert.equal(lost.stop.kind, "disposition");
  assert.equal(lost.stop.reason, "report_lost");
  const lostView = observeBakeRun(lost.physical);
  assert.deepEqual(lostView.groups[0].position, { kind: "unknown" });
  assert.equal(lostView.tasks[0].state, "failed");
  assert.equal(lostView.tasks[0].reason, "report_lost");
  assert.equal(lostView.tasks[1].reason, null);
  cases.push({
    name: "indeterminate",
    outcome:
      "group 2 is unknown, its dependent tasks never start, the loop names the disposition",
    stop: again.stop,
    view,
    lostReport: { stop: lost.stop, group: lostView.groups[0] },
  });
}

// --- stale -------------------------------------------------------------------
{
  const bake = await compiled();
  const bench = new Bench();
  // load-1 is running with its group on the tool.
  const driven = driveWithBench(started(bake, "stale"), bench, {
    "load-1": { kind: "cut", cut: 4 },
  });
  assert.equal(driven.stop.kind, "evidence");
  assert.equal(driven.stop.awaiting, "clock");
  const before = driven.physical;
  const reports = bench.log.filter((item) => item.type === "cobot_report");
  const last = reports.at(-1);
  const dispatch = bench.log.find((item) => item.type === "cobot_task");
  const stale = [
    // The device sends again an older event, with other content.
    {
      ...reports[1],
      sequence: reports[1].sequence,
      deviceClockMs: reports[1].deviceClockMs - 1,
      carrierAt: "source",
      phase: "approach-again",
    },
    // A clock that goes back, with a new sequence.
    {
      type: "cobot_clock",
      clocks: [
        {
          sourceKey: "cobot-1",
          sequence: bench.sequence["cobot-1"] + 1,
          deviceClockMs: last.deviceClockMs - 5_000,
          state: "busy",
        },
      ],
    },
    // A report for a dispatch that this run never wrote.
    {
      ...last,
      requestId: "dsp_000000000000000000000000",
      sequence: last.sequence + 2,
    },
    // The gateway answers again from its journal.
    { ...last, replayed: true },
    // A dispatch record for the same task, sent to the other cobot.
    { ...dispatch, sourceKey: "cobot-2" },
  ];
  const result = drivePhysicalRun(before, stale, HORIZON);
  assert.deepEqual(
    result.dispositions.map((item) => [item.outcome, item.reason]),
    [
      ["refused", "stale_sequence"],
      ["refused", "clock_regressed"],
      ["refused", "unknown_dispatch"],
      ["duplicate", null],
      ["refused", "dispatch_differs"],
    ],
  );
  assert.equal(
    canonicalJson(result.run.run),
    canonicalJson(before.run),
    "the run is unchanged",
  );
  assert.equal(
    canonicalJson(result.run.ledger),
    canonicalJson(before.ledger),
    "the evidence ledger is unchanged",
  );
  assert.deepEqual(result.stop, driven.stop);
  cases.push({
    name: "stale",
    outcome: "each stale item is named and the run is unchanged",
    dispositions: result.dispositions,
    stop: result.stop,
    runDigest: digest(result.run.run),
  });
}

// --- shadow ------------------------------------------------------------------
{
  const plan = value(await planBakeRun(INPUT));
  const messages = [];
  const sequence = Object.fromEntries(DEVICES.map((key) => [key, 0]));
  const offsets = [];
  for (const [index, step] of plan.steps.entries()) {
    // The teach pendant script runs unload-3 on cobot-1, not on its planned cobot.
    const sourceKey = step.key === "unload-3" ? "cobot-1" : step.sourceKey;
    const lead = 1.5 + index * 0.75;
    const observed = OBSERVED[step.key];
    offsets.push({
      key: step.key,
      start: lead,
      end: lead + observed - (step.end - step.start) / 1e6,
    });
    for (const [state, at] of [
      ["started", step.start / 1e6 + lead],
      ["completed", step.start / 1e6 + lead + observed],
    ]) {
      sequence[sourceKey] += 1;
      messages.push({
        type: "cobot_observed",
        sourceKey,
        observationId: `move-${index + 1}`,
        task: step.task,
        state,
        sequence: sequence[sourceKey],
        deviceClockMs: ORIGIN[sourceKey] + Math.round(at * 1_000),
        carrierAt:
          step.kind === "bake"
            ? null
            : state === "completed"
              ? "destination"
              : "source",
        reason: null,
      });
    }
  }
  // A move the plan does not hold.
  messages.push({
    type: "cobot_observed",
    sourceKey: "cobot-2",
    observationId: "move-extra",
    task: {
      kind: "move_mould_group",
      mouldGroup: 9,
      from: { station: "cold_rack", shelf: 9 },
      to: { station: "cooling_rack", shelf: 9 },
    },
    state: "started",
    sequence: 99,
    deviceClockMs: ORIGIN["cobot-2"] + 400_000,
    carrierAt: "source",
    reason: null,
  });
  const correlation = correlateShadowMoves(plan, { origin: ORIGIN, messages });
  assert.deepEqual(correlation.unobserved, []);
  assert.equal(correlation.matches.length, plan.steps.length + 1);
  for (const expected of offsets) {
    const match = correlation.matches.find(
      (entry) => entry.planned?.key === expected.key,
    );
    assert.ok(match, expected.key);
    assert.equal(
      match.difference.startSeconds,
      Math.round(expected.start * 1_000) / 1_000,
    );
    assert.equal(
      match.difference.endSeconds,
      Math.round(expected.end * 1_000) / 1_000,
    );
    assert.equal(match.sameCobot, expected.key !== "unload-3", expected.key);
  }
  const extra = correlation.matches.find(
    (entry) => entry.observationId === "move-extra",
  );
  assert.equal(extra.planned, null);
  cases.push({
    name: "shadow",
    outcome:
      "each observed move matches its planned task with the time difference",
    correlation,
  });
}

const artifact = {
  journey: "plan-24-physical-run",
  input: INPUT,
  origin: ORIGIN,
  cases,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `plan-24 physical run journey passed: ${cases.map((entry) => entry.name).join(", ")}`,
);
console.log(`artifact ${output} sha256 ${digest(artifact)}`);
