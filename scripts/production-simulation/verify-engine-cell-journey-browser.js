// Plan 70 J1 in a browser: the Portal starts the worker of its execution
// bundle and drives the single-cell journey through the host protocol. The
// run is paused and saved four times; each time its worker is destroyed and
// a fresh worker continues it from the checkpoints of the save. The result
// must equal the same journey run without interruption. The last save then
// runs again from its inputs (Refactor 16, step 8), and that run must equal
// the saved recording and the uninterrupted journey.
// Run with: pnpm bakery:browser --journey <this file>
//   --url http://<portal>/production-run-preview.html --output <directory>
const journeyEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan-70-j1-browser";

const JOURNEY_STOPS = [
  "tray-a-after-pickup",
  "empty-cell-at-rest",
  "tray-b-returning",
  "tray-b-after-pickup",
];

function journeyCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function journeyDataset(page) {
  return page.evaluate(() => ({ ...document.body.dataset }));
}

function journeyPhase(page, phase) {
  return page.waitForFunction(
    (expected) => document.body.dataset.phase === expected,
    phase,
    { timeout: 120000 },
  );
}

// What a run did, apart from which execution did it and when it was paused.
function journeyHistory(events) {
  const history = [];
  for (const { sequence: _sequence, execution: _execution, ...event } of events)
    if (event.kind !== "command-admitted") history.push(JSON.stringify(event));
  return history;
}

function journeyWorld(run) {
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    position,
    ...state
  } = run;
  return JSON.stringify({ ...state, time: position.time }, journeySortedFields);
}

function journeySortedFields(_key, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

async function verifyEngineCellJourneyBrowser(page) {
  await page.waitForFunction(() => "productionRunPreview" in window);

  // The uninterrupted journey, in its own worker.
  const reference = await page.evaluate(async () => {
    const api = window.productionRunPreview;
    const opening = performance.now();
    const opened = await api.openExecutionWorker();
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const openMs = performance.now() - opening;
    const definition = await api.define(worker);
    const began = await worker.request({
      kind: "begin",
      bundle: worker.manifest.bundle,
      cells: [definition],
      identity: { ...api.identity(0, null), runId: "production-run-preview" },
      origin: { kind: "scenario", scenario: await api.scenarioFor(definition) },
    });
    if (began.kind !== "began") throw new Error(JSON.stringify(began));
    const events = [];
    const turns = [];
    const started = performance.now();
    for (;;) {
      const turnStarted = performance.now();
      const reply = await worker.request({
        kind: "drive",
        turns: 8,
        until: 600_000_000,
      });
      turns.push(performance.now() - turnStarted);
      if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
      events.push(...reply.events);
      if (reply.view.status.kind !== "awaiting-execution") break;
    }
    const wallMs = performance.now() - started;
    const state = await worker.request({ kind: "state" });
    worker.terminate();
    turns.sort((left, right) => left - right);
    return {
      definition,
      bundle: worker.manifest.bundle,
      runtime: worker.manifest.runtime.id,
      openMs,
      wallMs,
      turns: {
        count: turns.length,
        meanMs: turns.reduce((sum, turn) => sum + turn, 0) / turns.length,
        p95Ms: turns[Math.ceil(turns.length * 0.95) - 1],
        slowestMs: turns.at(-1),
      },
      events,
      view: state.view,
      run: state.run,
    };
  });
  journeyCheck(
    reference.view.status.kind === "completed",
    `The reference run is ${reference.view.status.kind}`,
  );

  // The operator's path: the same world, interrupted at four named points.
  await page.evaluate((definition) => {
    window.productionRunPreview.session.definition = definition;
  }, reference.definition);
  const legs = [];
  for (const [index, stop] of JOURNEY_STOPS.entries()) {
    // The stop choice is in the collapsed "Simulation details" section.
    await openDisclosure(
      page.locator("details.production-run-diagnostics"),
      "Simulation details",
    );
    await chooseOption(
      page,
      page.locator('.pantry-select-trigger[data-name="stop"]'),
      { value: stop },
    );
    await page
      .getByRole("button", {
        name: index === 0 ? "Start run" : "Continue from save",
      })
      .click();
    await journeyPhase(page, "saved");
    const saved = await journeyDataset(page);
    journeyCheck(saved.status === "paused", `${stop}: the run is not paused`);
    journeyCheck(
      Number(saved.execution) === index + 1,
      `${stop}: expected execution ${index + 1}`,
    );
    // The empty cell has rested for its second and holds without stepping.
    if (stop === "empty-cell-at-rest")
      journeyCheck(
        saved.carrier === "" &&
          saved.attempt === "" &&
          saved.hold === "settled",
        "The cell is not empty and held",
      );
    else
      journeyCheck(
        saved.attempt.endsWith("/transfer@1"),
        `${stop}: no transfer is in progress`,
      );
    legs.push({
      stop,
      execution: Number(saved.execution),
      pausedAtSeconds: Number(saved.time) / 1_000_000,
      attempt: saved.attempt || null,
      attemptSteps: Number(saved.attemptSteps),
      snapshot: saved.snapshot,
      checkpoint: saved.checkpoint,
    });
    if (index === 0)
      await page.screenshot({ path: `${journeyEvidence}/saved.png` });
    await page.getByRole("button", { name: "Destroy worker" }).click();
    await journeyPhase(page, "destroyed");
  }
  await page.getByRole("button", { name: "Continue from save" }).click();
  await journeyPhase(page, "ended");
  await page.screenshot({ path: `${journeyEvidence}/completed.png` });

  const interrupted = await page.evaluate(async () => {
    const { session } = window.productionRunPreview;
    const state = await window.productionRunPreview
      .currentWorker()
      .request({ kind: "state" });
    const artifacts = [];
    for (const artifact of session.artifacts.values())
      artifacts.push(artifact.byteLength);
    return {
      events: session.events,
      view: state.view,
      run: state.run,
      timings: session.timings,
      saved: session.saved,
      artifacts,
    };
  });
  journeyCheck(
    interrupted.view.status.kind === "completed",
    `The interrupted run is ${interrupted.view.status.kind}`,
  );
  journeyCheck(
    interrupted.view.cells[0].checkpoint === reference.view.cells[0].checkpoint,
    "The interrupted run ends in another physical state",
  );
  journeyCheck(
    JSON.stringify(journeyHistory(interrupted.events)) ===
      JSON.stringify(journeyHistory(reference.events)),
    "The interrupted run accepted another history",
  );
  journeyCheck(
    journeyWorld(interrupted.run) === journeyWorld(reference.run),
    "The interrupted run ends in another production state",
  );
  // Accepted events never step back in time, pauses and holds included.
  for (const [index, event] of interrupted.events.entries())
    journeyCheck(
      index === 0 || event.time >= interrupted.events[index - 1].time,
      `Event ${event.sequence} (${event.kind}) steps back in time`,
    );
  const executions = new Set(
    interrupted.events.map((event) => event.execution),
  );
  journeyCheck(
    executions.size === 5,
    "Each worker wrote under its own execution",
  );
  journeyCheck(
    new Set(legs.map((leg) => leg.snapshot)).size === legs.length,
    "Each save names its own snapshot",
  );
  journeyCheck(
    interrupted.events.length - reference.events.length === legs.length,
    "The only additional events are the admitted pauses",
  );

  // What a worker refuses, in this browser.
  const rejections = await page.evaluate(async () => {
    const api = window.productionRunPreview;
    const { saved } = api.session;
    const pinned = api.pinned;
    const found = {};

    const definition = api.savedDefinition(saved);
    async function refusedBegin(
      document,
      checkpoints,
      expectedCode = null,
      kind = "snapshot",
    ) {
      const opened = await api.openExecutionWorker();
      if (!opened.ok) throw new Error(JSON.stringify(opened.error));
      const reply = await opened.value.request({
        kind: "begin",
        bundle: pinned,
        cells: [definition],
        identity: api.identity(9, {
          snapshot: saved.document.snapshot,
          execution: "browser-4",
        }),
        origin:
          kind === "snapshot"
            ? { kind, document, checkpoints }
            : { kind, document },
      });
      const early = await opened.value.request({
        kind: "drive",
        turns: 1,
        until: 2000,
      });
      opened.value.terminate();
      if (expectedCode !== null && reply.detail?.code !== expectedCode)
        throw new Error(
          `Expected ${expectedCode}, received ${JSON.stringify(reply)}`,
        );
      return reply.kind === "refused"
        ? `${reply.reason}${early.kind === "refused" ? "" : " (then drove)"}`
        : reply.kind;
    }
    const edited = structuredClone(saved.document);
    edited.state.position.time += 2000;
    found.saveWithAnEditedRecord = await refusedBegin(
      edited,
      saved.checkpoints,
    );
    // A save is its inputs. An edited input is not that save.
    found.replayOfAnEditedSave = await refusedBegin(
      edited,
      saved.checkpoints,
      "snapshot_differs",
      "replay",
    );
    const malformed = structuredClone(saved.document);
    malformed.state.carriers[1].custody = { kind: "stored", storage: "rack" };
    const { snapshot: _snapshot, ...content } = malformed;
    // A sorted replacer reproduces canonical JSON for these plain records.
    const keys = new Set();
    const pendingRecords = [content];
    while (pendingRecords.length > 0) {
      const record = pendingRecords.pop();
      for (const [key, value] of Object.entries(record)) {
        keys.add(key);
        if (value !== null && typeof value === "object")
          pendingRecords.push(value);
      }
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(content, [...keys].sort())),
    );
    let hex = "";
    for (const byte of new Uint8Array(digest))
      hex += byte.toString(16).padStart(2, "0");
    malformed.snapshot = hex;
    found.rehashedCustodyMismatch = await refusedBegin(
      malformed,
      saved.checkpoints,
      "invalid_document",
    );
    found.saveWithoutItsCheckpoint = await refusedBegin(saved.document, []);
    found.checkpointWithChangedContent = await refusedBegin(saved.document, [
      {
        digest: saved.checkpoints[0].digest,
        content: saved.checkpoints[0].content.replace(
          /"steps":(\d+)/u,
          '"steps":1$1',
        ),
      },
    ]);

    const opened = await api.openExecutionWorker();
    const worker = opened.value;
    found.driveBeforeBegin = (
      await worker.request({ kind: "drive", turns: 1, until: 2000 })
    ).reason;
    found.malformedScenario = (
      await worker.request({
        kind: "begin",
        bundle: pinned,
        cells: [definition],
        identity: api.identity(10, null),
        origin: { kind: "scenario", scenario: { workflows: null } },
      })
    ).reason;
    const pending = worker.request({ kind: "state" });
    worker.terminate();
    found.requestToADestroyedWorker = await pending.then(
      () => "answered",
      (error) => error.message,
    );
    return found;
  });
  const expected = {
    saveWithAnEditedRecord: "save_not_opened",
    replayOfAnEditedSave: "save_not_opened",
    rehashedCustodyMismatch: "save_not_opened",
    malformedScenario: "invalid_scenario",
    saveWithoutItsCheckpoint: "checkpoint_missing",
    checkpointWithChangedContent: "cell_not_restored",
    driveBeforeBegin: "not_begun",
    requestToADestroyedWorker: "The execution worker was terminated",
  };
  for (const [name, reason] of Object.entries(expected))
    journeyCheck(
      rejections[name] === reason,
      `${name}: expected ${reason}, received ${rejections[name]}`,
    );

  // The last save runs again from its inputs. Each of its four pauses is one
  // input; a later worker continued from the first three, so the replay
  // releases them, and it stops at the fourth, where the save stopped.
  const replayed = await page.evaluate(replaySavedJourney);
  journeyCheck(
    replayed.commandWhileReplaying === "replaying",
    `A command during the replay: ${replayed.commandWhileReplaying}`,
  );
  journeyCheck(
    replayed.report.state === "replayed" &&
      replayed.report.commands === legs.length &&
      replayed.report.applied === legs.length &&
      replayed.report.refused.length === 0,
    `The replay did not apply each pause: ${JSON.stringify(replayed.report)}`,
  );
  journeyCheck(
    replayed.report.difference === null,
    "The replay differs from the saved recording on one engine",
  );
  journeyCheck(
    replayed.paused.status === "paused" &&
      replayed.paused.time === replayed.report.saved.time &&
      replayed.paused.time === legs.at(-1).pausedAtSeconds * 1_000_000,
    "The replay did not stop where the save stopped",
  );
  journeyCheck(
    replayed.view.status.kind === "completed",
    `The replayed run is ${replayed.view.status.kind}`,
  );
  journeyCheck(
    JSON.stringify(journeyHistory(replayed.events)) ===
      JSON.stringify(journeyHistory(reference.events)),
    "The replayed run accepted another history",
  );
  journeyCheck(
    journeyWorld(replayed.run) === journeyWorld(reference.run),
    "The replayed run ends in another production state",
  );

  return {
    result: "passed",
    plan: "70 J1",
    userAgent: await page.evaluate(() => navigator.userAgent),
    bundle: reference.bundle,
    runtime: reference.runtime,
    journey: {
      completedAtSeconds: reference.view.time / 1_000_000,
      events: reference.events.length,
      cellSteps: reference.view.cells[0].steps,
      heldSeconds:
        (reference.view.time - reference.view.cells[0].steps * 2000) /
        1_000_000,
      finalCheckpoint: reference.view.cells[0].checkpoint,
    },
    legs,
    agreement: {
      sameHistory: true,
      sameFinalState: true,
      sameFinalCheckpoint: true,
      executions: [...executions],
    },
    rejections,
    replay: {
      report: replayed.report,
      pausedAtSeconds: replayed.paused.time / 1_000_000,
      wallMs: replayed.wallMs,
      sameHistory: true,
      sameFinalState: true,
    },
    measurements: {
      referenceOpenMs: reference.openMs,
      referenceWallMs: reference.wallMs,
      simulatedSecondsPerWallSecond:
        reference.view.time / 1_000_000 / (reference.wallMs / 1000),
      driveTurnsOfEightNeeds: reference.turns,
      executions: interrupted.timings,
      savedArtifactBytes: interrupted.artifacts.reduce(
        (total, bytes) => total + bytes,
        0,
      ),
    },
    checks: [
      "the Portal starts the worker of its execution bundle and runs the journey through the host protocol",
      "the run is paused and saved twice after a pickup, once with the arm returning and once with the cell empty",
      "each save's worker is destroyed and a fresh worker continues it from its checkpoints",
      "the interrupted run ends in the same history, production state and cell checkpoint",
      "edited saves and changed checkpoints are refused, for a restore and for a replay",
      "the last save runs again from its inputs: the replay takes no command, equals the saved recording, stops where the save stopped and ends as the uninterrupted journey",
    ],
  };
}

async function replaySavedJourney() {
  const api = window.productionRunPreview;
  const { saved } = api.session;
  const opened = await api.openExecutionWorker();
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const worker = opened.value;
  const started = performance.now();
  const began = await worker.request({
    kind: "begin",
    bundle: worker.manifest.bundle,
    cells: [api.savedDefinition(saved)],
    identity: api.identity(11, {
      snapshot: saved.document.snapshot,
      execution: saved.document.state.identity.executionId,
    }),
    origin: { kind: "replay", document: saved.document },
  });
  if (began.kind !== "began" || began.replay?.state !== "replaying")
    throw new Error(JSON.stringify(began));
  const early = await worker.request({
    kind: "pause",
    commandId: "pause-during-replay",
  });
  const events = [];
  let reply;
  for (let turn = 0; turn < 100_000; turn += 1) {
    reply = await worker.request({
      kind: "drive",
      turns: 8,
      until: 600_000_000,
    });
    if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
    events.push(...reply.events);
    if (reply.replay?.state === "replayed") break;
  }
  const report = reply.replay;
  const paused = { time: reply.view.time, status: reply.view.status.kind };
  const resumed = await worker.request({
    kind: "resume",
    commandId: "resume-after-replay",
  });
  if (resumed.kind !== "commanded" || resumed.receipt.status !== "accepted")
    throw new Error(JSON.stringify(resumed));
  events.push(...resumed.events);
  for (let turn = 0; turn < 100_000; turn += 1) {
    reply = await worker.request({
      kind: "drive",
      turns: 8,
      until: 600_000_000,
    });
    if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
    events.push(...reply.events);
    if (
      reply.view.status.kind !== "awaiting-execution" &&
      reply.view.status.kind !== "advancing"
    )
      break;
  }
  const wallMs = performance.now() - started;
  const state = await worker.request({ kind: "state" });
  worker.terminate();
  if (state.kind !== "state") throw new Error(JSON.stringify(state));
  return {
    commandWhileReplaying: early.kind === "refused" ? early.reason : early.kind,
    report,
    paused,
    events,
    view: state.view,
    run: state.run,
    wallMs,
  };
}
