#!/usr/bin/env node
// Plan 24 S2: the cobot controller simulator, through its own ports.
//
// The journey starts `cobot-controller`, connects to each device port as the
// gateway adapter does, and checks what a controller reports: a move on each
// arm, a bake and a retrieval go accepted, running and completed; a duplicate
// submit runs nothing; each injected fault (lost grip, blocked door, arm stop,
// emergency stop) and a door conflict give their task and fault events. It
// runs the same physics cases again with the `bakery-native` command line and
// checks that each move took the time of its engine run.
//
// It writes output/plan-24/controller-journey.json.
//
//   node scripts/plan-24/controller-journey.mjs
//
// The binary comes from PANTRY_COBOT_CONTROLLER_BINARY. If it is unset, the
// journey builds the crate with MUJOCO_DIR (about 1 minute).
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT = join(root, "output/plan-24");
const TIME_SCALE = 20;
const CRATE = join(root, "crates/bakery-native");

const steps = [];
const failures = [];

function check(name, ok, detail = {}) {
  steps.push({ name, ok: Boolean(ok), ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
}

function binaries() {
  const controller = process.env.PANTRY_COBOT_CONTROLLER_BINARY;
  if (controller !== undefined && controller !== "")
    return {
      controller,
      engine:
        process.env.BAKERY_NATIVE_BINARY ??
        join(dirname(controller), "bakery-native"),
    };
  if (!process.env.MUJOCO_DIR)
    throw new Error(
      "Set PANTRY_COBOT_CONTROLLER_BINARY, or MUJOCO_DIR to build the crate.",
    );
  const built = spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      join(CRATE, "Cargo.toml"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (built.status !== 0) throw new Error("The bakery-native build failed.");
  const target = join(CRATE, "target/release");
  return {
    controller: join(target, "cobot-controller"),
    engine: join(target, "bakery-native"),
  };
}

/** One device connection, as the gateway adapter holds it. */
async function device(port, name) {
  const socket = connect(port, "127.0.0.1");
  await new Promise((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  const events = [];
  createInterface({ input: socket }).on("line", (line) =>
    events.push(JSON.parse(line)),
  );
  return {
    name,
    events,
    send: (op) => socket.write(`${JSON.stringify(op)}\n`),
    close: () => socket.destroy(),
    /** The events after `from`, without the clock. */
    since: (from) =>
      events.slice(from).filter((event) => event.event !== "clock"),
    async until(predicate, timeoutMs = 20_000) {
      const started = Date.now();
      for (;;) {
        const found = events.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() - started > timeoutMs)
          throw new Error(`${name}: no event in ${timeoutMs} ms`);
        await delay(20);
      }
    },
  };
}

async function controlPort(port) {
  const socket = connect(port, "127.0.0.1");
  await new Promise((done) => socket.once("connect", done));
  const lines = createInterface({ input: socket });
  const answers = [];
  lines.on("line", (line) => answers.push(JSON.parse(line)));
  return {
    async ask(op) {
      const before = answers.length;
      socket.write(`${JSON.stringify(op)}\n`);
      while (answers.length === before) await delay(5);
      return answers[before];
    },
    close: () => socket.destroy(),
  };
}

let dispatch = 0;
function dispatchId() {
  dispatch += 1;
  return `dsp_${dispatch.toString(16).padStart(24, "0")}`;
}

const place = (station, shelf) => ({ station, shelf });
const move = (group, from, to) => ({
  kind: "move_mould_group",
  mouldGroup: group,
  from,
  to,
});

/** The task events of one task, in order. */
function taskEvents(link, taskId) {
  return link.events.filter(
    (event) => event.event === "task" && event.taskId === taskId,
  );
}

async function settled(link, taskId) {
  return link.until(
    (event) =>
      event.event === "task" &&
      event.taskId === taskId &&
      ["completed", "rejected", "indeterminate"].includes(event.state),
    60_000,
  );
}

/** The time of one engine run, from the `bakery-native` command line. */
function engineSeconds(engine, work) {
  const run = (args) => {
    const done = spawnSync(engine, ["--root", root, ...args], {
      encoding: "utf8",
    });
    if (done.status !== 0)
      throw new Error(`bakery-native ${args.join(" ")}: ${done.stderr}`);
  };
  const read = (file) => JSON.parse(readFileSync(join(work, file), "utf8"));
  const seconds = (recording) =>
    recording.outcome.step * recording.request.timestep;
  run([
    "--output",
    join(work, "nominal.json"),
    "prepare",
    "--task",
    "table-to-oven",
  ]);
  run([
    "--output",
    join(work, "slip.json"),
    "prepare",
    "--task",
    "table-to-oven",
    "--case",
    "slip",
  ]);
  run([
    "--output",
    join(work, "cycle.json"),
    "cycle",
    join(work, "nominal.json"),
  ]);
  run([
    "--output",
    join(work, "slip-run.json"),
    "run",
    join(work, "slip.json"),
  ]);
  const cycle = read("cycle.json");
  return {
    load: seconds(cycle.loading),
    unload: seconds(cycle.unloading),
    slip: seconds(read("slip-run.json")),
  };
}

const near = (left, right) => Math.abs(left - right) < 0.002;

async function journey() {
  const { controller, engine } = binaries();
  mkdirSync(OUTPUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "plan-24-controller-"));
  const engineRun = engineSeconds(engine, work);
  const stateDir = join(OUTPUT, "controller-state");
  rmSync(stateDir, { recursive: true, force: true });
  const process_ = spawn(
    controller,
    [
      "--root",
      root,
      // The system picks the four ports; the ready line names them.
      "--port",
      "0",
      "--time-scale",
      String(TIME_SCALE),
      "--state-dir",
      stateDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr = [];
  process_.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const ready = JSON.parse(
    await new Promise((done) =>
      createInterface({ input: process_.stdout }).once("line", done),
    ),
  );
  const result = { ready, engineRun, timeScale: TIME_SCALE };
  try {
    const { ports } = ready;
    const cobot1 = await device(ports["cobot-1"], "cobot-1");
    const cobot2 = await device(ports["cobot-2"], "cobot-2");
    const oven = await device(ports["oven-1"], "oven-1");
    const control = await controlPort(ports.control);
    const physics = Object.fromEntries(
      ready.physics.map((run) => [run.case, run]),
    );

    // 1. Each device says what it is.
    for (const [link, kind, capability] of [
      [cobot1, "cobot", "move_mould_group"],
      [cobot2, "cobot", "move_mould_group"],
      [oven, "appliance", "bake"],
    ]) {
      link.send({ op: "hello" });
      const hello = await link.until((event) => event.event === "hello");
      check(
        `${link.name} hello`,
        hello.device.sourceKey === link.name &&
          hello.device.kind === kind &&
          hello.device.capabilities[0].id === capability &&
          hello.state === "idle",
        { hello },
      );
    }

    // 2. The physics cases match a separate engine run.
    check(
      "load time is the engine's table-to-oven time",
      near(physics["table-to-oven-nominal"].seconds, engineRun.load),
    );
    check(
      "unload time is the engine's oven-to-table time",
      near(physics["oven-to-table-nominal"].seconds, engineRun.unload),
    );

    // 3. cobot-1 loads group 1: accepted, running, completed, with the time
    //    of the physics run.
    const load1 = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: load1,
      task: move(1, place("cold_rack", 1), place("oven", 1)),
    });
    const end1 = await settled(cobot1, load1);
    const states1 = taskEvents(cobot1, load1).map((event) => event.state);
    check(
      "cobot-1 load: accepted, running, completed",
      end1.state === "completed" &&
        states1[0] === "accepted" &&
        states1.includes("running") &&
        near(end1.observedSeconds, engineRun.load) &&
        end1.carrierAt === "destination",
      { states: states1, end: end1 },
    );
    const sequences = cobot1.events.map((event) => event.sequence);
    check(
      "cobot-1 sequence only rises",
      sequences.every(
        (value, index) => index === 0 || value > sequences[index - 1],
      ),
    );

    // 4. A duplicate submit runs nothing and answers the present state.
    const before = cobot1.events.length;
    cobot1.send({
      op: "submit",
      taskId: load1,
      task: move(1, place("cold_rack", 1), place("oven", 1)),
    });
    const duplicate = await cobot1.until(
      (event, index) =>
        index >= before && event.event === "task" && event.taskId === load1,
    );
    const afterDuplicate = await control.ask({ op: "state" });
    const cobot1State = afterDuplicate.devices.find(
      (d) => d.sourceKey === "cobot-1",
    );
    check(
      "duplicate submit runs nothing",
      duplicate.state === "completed" &&
        cobot1State.tasksStarted === 1 &&
        cobot1State.operations.submit === 2,
      { duplicate, operations: cobot1State.operations },
    );
    const recorded = afterDuplicate.tasks.find((task) => task.taskId === load1);
    check(
      "the state answer names the physics run",
      recorded.physicsCase === "table-to-oven-nominal" &&
        recorded.physicsDigest === physics["table-to-oven-nominal"].digest,
    );

    // 5. cobot-2 loads group 2, the oven bakes, cobot-1 unloads group 1.
    const load2 = dispatchId();
    cobot2.send({
      op: "submit",
      taskId: load2,
      task: move(2, place("cold_rack", 2), place("oven", 2)),
    });
    const end2 = await settled(cobot2, load2);
    check(
      "cobot-2 load completes",
      end2.state === "completed" && near(end2.observedSeconds, engineRun.load),
    );
    const bake = dispatchId();
    oven.send({
      op: "submit",
      taskId: bake,
      task: { kind: "bake", programSeconds: 60, temperatureC: 180 },
    });
    await oven.until(
      (event) => event.taskId === bake && event.state === "running",
    );
    const blockedByBake = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: blockedByBake,
      task: move(1, place("oven", 1), place("cooling_rack", 1)),
    });
    const ovenBusy = await settled(cobot1, blockedByBake);
    check(
      "a move out of a baking oven is rejected",
      ovenBusy.state === "rejected" && ovenBusy.reason === "oven_baking",
    );
    const bakeEnd = await settled(oven, bake);
    const bakeStates = taskEvents(oven, bake).map((event) => event.state);
    check(
      "oven bake: accepted, running, completed",
      bakeEnd.state === "completed" &&
        bakeStates[0] === "accepted" &&
        near(bakeEnd.observedSeconds, 60) &&
        bakeEnd.carrierAt === null,
      { states: bakeStates },
    );
    const unload1 = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: unload1,
      task: move(1, place("oven", 1), place("cooling_rack", 1)),
    });
    const unloadEnd = await settled(cobot1, unload1);
    check(
      "cobot-1 unload completes with the engine's retrieval time",
      unloadEnd.state === "completed" &&
        near(unloadEnd.observedSeconds, engineRun.unload),
    );

    // 6. The world refuses a move that does not fit it, and status of a task
    //    that the device never saw is unknown.
    const again = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: again,
      task: move(1, place("cold_rack", 1), place("oven", 3)),
    });
    check(
      "not_at_source",
      (await settled(cobot1, again)).reason === "not_at_source",
    );
    const occupied = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: occupied,
      task: move(3, place("cold_rack", 3), place("oven", 2)),
    });
    check(
      "destination_occupied",
      (await settled(cobot1, occupied)).reason === "destination_occupied",
    );
    const never = dispatchId();
    cobot1.send({ op: "status", taskId: never });
    check(
      "status of an unseen task is unknown",
      (await cobot1.until((event) => event.taskId === never)).state ===
        "unknown",
    );

    // 7. Lost grip: the engine's slip run decides when and where.
    await control.ask({ op: "inject", device: "cobot-1", fault: "grip_lost" });
    const slip = dispatchId();
    let from = cobot1.events.length;
    cobot1.send({
      op: "submit",
      taskId: slip,
      task: move(3, place("cold_rack", 3), place("oven", 3)),
    });
    const slipEnd = await settled(cobot1, slip);
    const gripFault = await cobot1.until(
      (event, index) => index >= from && event.event === "fault",
    );
    const slipState = (await control.ask({ op: "state" })).tasks.find(
      (task) => task.taskId === slip,
    );
    check(
      "grip_lost from physics",
      slipEnd.state === "indeterminate" &&
        slipEnd.reason === "grip_lost" &&
        slipEnd.carrierAt === "unknown" &&
        near(slipEnd.observedSeconds, engineRun.slip) &&
        gripFault.code === "GRIP_LOST" &&
        slipState.physicsCase === "table-to-oven-slip",
      { end: slipEnd, fault: gripFault },
    );
    const refusedWhileFaulted = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: refusedWhileFaulted,
      task: move(5, place("cold_rack", 5), place("oven", 3)),
    });
    check(
      "a faulted arm refuses a task",
      (await settled(cobot1, refusedWhileFaulted)).reason === "device_fault",
    );
    from = cobot1.events.length;
    await control.ask({ op: "clear", device: "cobot-1" });
    const gripCleared = await cobot1.until(
      (event, index) => index >= from && event.event === "fault_cleared",
    );
    check("clear ends the lost grip", gripCleared.code === "GRIP_LOST");

    // 8. Blocked door: the engine's closed-door run refuses the loading.
    await control.ask({
      op: "inject",
      device: "cobot-2",
      fault: "door_blocked",
    });
    from = cobot2.events.length;
    const blocked = dispatchId();
    cobot2.send({
      op: "submit",
      taskId: blocked,
      task: move(4, place("cold_rack", 4), place("oven", 3)),
    });
    const blockedEnd = await settled(cobot2, blocked);
    const doorFault = await cobot2.until(
      (event, index) => index >= from && event.event === "fault",
    );
    const blockedState = (await control.ask({ op: "state" })).tasks.find(
      (task) => task.taskId === blocked,
    );
    check(
      "door_blocked from physics",
      blockedEnd.state === "rejected" &&
        blockedEnd.reason === "door_blocked" &&
        doorFault.code === "DOOR_BLOCKED" &&
        blockedState.physicsCase === "table-to-oven-closed-door",
    );
    await control.ask({ op: "clear", device: "cobot-2" });

    // 9. Arm stop at 40 % of a loading: the arm holds the tray on its tool.
    const stopped = dispatchId();
    from = cobot2.events.length;
    cobot2.send({
      op: "submit",
      taskId: stopped,
      task: move(4, place("cold_rack", 4), place("oven", 3)),
    });
    await cobot2.until(
      (event) => event.taskId === stopped && event.state === "running",
    );
    await control.ask({
      op: "inject",
      device: "cobot-2",
      fault: "arm_stop",
      atProgress: 0.4,
    });
    const stopEnd = await settled(cobot2, stopped);
    const armFault = await cobot2.until(
      (event, index) => index >= from && event.event === "fault",
    );
    check(
      "arm_stop at its progress",
      stopEnd.state === "indeterminate" &&
        stopEnd.reason === "arm_stop" &&
        stopEnd.carrierAt === "tool" &&
        Math.abs(stopEnd.progress - 0.4) < 0.01 &&
        armFault.code === "ARM_STOP",
      { end: stopEnd },
    );
    await control.ask({ op: "clear", device: "cobot-2" });

    // 10. Local emergency stop: every device stops, and only clear ends it.
    const estopped = dispatchId();
    const marks = [cobot1, cobot2, oven].map((link) => link.events.length);
    cobot1.send({
      op: "submit",
      taskId: estopped,
      task: move(5, place("cold_rack", 5), place("oven", 1)),
    });
    await cobot1.until(
      (event) => event.taskId === estopped && event.state === "running",
    );
    await control.ask({ op: "inject", device: "cobot-1", fault: "estop" });
    const estopEnd = await settled(cobot1, estopped);
    const estopFaults = await Promise.all(
      [cobot1, cobot2, oven].map((link, index) =>
        link.until(
          (event, at) => at >= marks[index] && event.event === "fault",
        ),
      ),
    );
    check(
      "estop stops every device",
      estopEnd.state === "indeterminate" &&
        estopEnd.reason === "estop" &&
        estopEnd.carrierAt === "source" &&
        estopFaults.every((fault) => fault.code === "ESTOP"),
      { end: estopEnd },
    );
    const underEstop = dispatchId();
    oven.send({
      op: "submit",
      taskId: underEstop,
      task: { kind: "bake", programSeconds: 30, temperatureC: 170 },
    });
    check(
      "a task under estop is rejected",
      (await settled(oven, underEstop)).reason === "estop_active",
    );
    let pauseAt = cobot2.events.length;
    cobot2.send({ op: "pause" });
    const pauseRefused = await cobot2.until(
      (event, index) => index >= pauseAt && event.event === "control",
    );
    check("a pause under estop is refused", pauseRefused.outcome === "refused");
    const clearMarks = [cobot1, cobot2, oven].map((link) => link.events.length);
    await control.ask({ op: "clear", device: "oven-1" });
    const cleared = await Promise.all(
      [cobot1, cobot2, oven].map((link, index) =>
        link.until(
          (event, at) =>
            at >= clearMarks[index] && event.event === "fault_cleared",
        ),
      ),
    );
    check(
      "clear ends the estop on every device",
      cleared.every((event) => event.code === "ESTOP"),
    );

    // 11. Pause, resume and stop each get their own answer.
    await control.ask({ op: "reset" });
    pauseAt = cobot1.events.length;
    const held = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: held,
      task: move(6, place("cold_rack", 6), place("oven", 1)),
    });
    await cobot1.until(
      (event) => event.taskId === held && event.state === "running",
    );
    cobot1.send({ op: "pause" });
    const paused = await cobot1.until(
      (event, index) => index >= pauseAt && event.event === "control",
    );
    const pausedProgress = (await control.ask({ op: "state" })).tasks.find(
      (task) => task.taskId === held,
    ).progress;
    await delay(400);
    const stillProgress = (await control.ask({ op: "state" })).tasks.find(
      (task) => task.taskId === held,
    ).progress;
    const pausedClock = await cobot1.until(
      (event, index) =>
        index >= pauseAt && event.event === "clock" && event.state === "paused",
    );
    pauseAt = cobot1.events.length;
    cobot1.send({ op: "resume" });
    const resumed = await cobot1.until(
      (event, index) => index >= pauseAt && event.event === "control",
    );
    pauseAt = cobot1.events.length;
    cobot1.send({ op: "stop" });
    const stopAnswer = await cobot1.until(
      (event, index) => index >= pauseAt && event.event === "control",
    );
    const heldEnd = await settled(cobot1, held);
    check(
      "pause holds the task, resume and stop answer",
      paused.op === "pause" &&
        paused.outcome === "done" &&
        pausedProgress === stillProgress &&
        pausedClock !== undefined &&
        resumed.op === "resume" &&
        resumed.outcome === "done" &&
        stopAnswer.op === "stop" &&
        stopAnswer.outcome === "done" &&
        heldEnd.reason === "stop_requested",
    );
    pauseAt = cobot1.events.length;
    cobot1.send({ op: "resume" });
    await cobot1.until(
      (event, index) => index >= pauseAt && event.event === "control",
    );

    // 12. Two arms inside the oven door at the same time both stop.
    await control.ask({ op: "reset" });
    const conflictMarks = [cobot1.events.length, cobot2.events.length];
    const left = dispatchId();
    const right = dispatchId();
    cobot1.send({
      op: "submit",
      taskId: left,
      task: move(1, place("cold_rack", 1), place("oven", 1)),
    });
    cobot2.send({
      op: "submit",
      taskId: right,
      task: move(2, place("cold_rack", 2), place("oven", 2)),
    });
    const [leftEnd, rightEnd] = await Promise.all([
      settled(cobot1, left),
      settled(cobot2, right),
    ]);
    const conflictFaults = await Promise.all(
      [cobot1, cobot2].map((link, index) =>
        link.until(
          (event, at) => at >= conflictMarks[index] && event.event === "fault",
        ),
      ),
    );
    check(
      "door conflict stops both arms",
      [leftEnd, rightEnd].every(
        (end) =>
          end.state === "indeterminate" &&
          end.reason === "door_conflict" &&
          end.carrierAt === "tool",
      ) && conflictFaults.every((fault) => fault.code === "DOOR_CONFLICT"),
      { left: leftEnd, right: rightEnd },
    );

    // 13. A stale event comes again with a lower sequence; a frozen device
    //     sends nothing until a person clears it.
    const latest = Math.max(...cobot1.events.map((event) => event.sequence));
    const staleMark = cobot1.events.length;
    const stale = await control.ask({ op: "stale", device: "cobot-1" });
    const resent = await cobot1.until(
      (event, index) => index >= staleMark && event.sequence < latest,
    );
    check(
      "stale resends an older event",
      stale.ok && resent.sequence === stale.sent.sequence,
    );
    await control.ask({ op: "freeze", device: "cobot-2" });
    await delay(100);
    const frozenMark = cobot2.events.length;
    cobot2.send({ op: "status", taskId: right });
    await delay(800);
    check(
      "a frozen device sends and answers nothing",
      cobot2.events.length === frozenMark,
    );
    await control.ask({ op: "clear", device: "cobot-2" });
    await cobot2.until(
      (event, index) => index >= frozenMark && event.event === "clock",
    );

    result.finalState = await control.ask({ op: "state" });
    result.events = {
      "cobot-1": cobot1.since(0),
      "cobot-2": cobot2.since(0),
      "oven-1": oven.since(0),
    };
    for (const link of [cobot1, cobot2, oven]) link.close();
    control.close();
  } finally {
    process_.kill();
    rmSync(work, { recursive: true, force: true });
  }
  result.steps = steps;
  result.passed = failures.length === 0;
  result.stderr = stderr.join("");
  const artifact = join(OUTPUT, "controller-journey.json");
  writeFileSync(artifact, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${result.passed ? "PASSED" : "FAILED"} ${steps.length} checks; ${artifact}`,
  );
  if (!result.passed) process.exit(1);
}

await journey();
