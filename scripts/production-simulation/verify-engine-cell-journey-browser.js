// Plan 70 J1 in a browser: the Portal starts a retained execution bundle's
// worker and drives the single-cell journey through the host protocol. The
// run is paused and saved four times; each time its worker is destroyed and
// a fresh worker, resolved from the bundle the save names, continues it.
// The result must equal the same journey run without interruption.
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
    const opened = await api.openExecutionWorker(null);
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

  // What a worker and the resolver refuse, in this browser.
  const rejections = await page.evaluate(async () => {
    const api = window.productionRunPreview;
    const { saved } = api.session;
    const pinned = api.pinned;
    const found = {};
    const unknown = await api.openExecutionWorker({
      ...pinned,
      id: "0".repeat(64),
    });
    found.bundleNotRetained = unknown.ok ? "opened" : unknown.error.reason;
    const altered = await api.openExecutionWorker({
      ...pinned,
      controllerHash: "0".repeat(64),
    });
    found.bundleWithAnotherController = altered.ok
      ? "opened"
      : altered.error.reason;

    const definition = api.savedDefinition(saved);
    async function refusedBegin(document, checkpoints, expectedCode = null) {
      const opened = await api.openExecutionWorker(pinned);
      if (!opened.ok) throw new Error(JSON.stringify(opened.error));
      const reply = await opened.value.request({
        kind: "begin",
        bundle: pinned,
        cells: [definition],
        identity: api.identity(9, {
          snapshot: saved.document.snapshot,
          execution: "browser-4",
        }),
        origin: { kind: "snapshot", document, checkpoints },
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

    const opened = await api.openExecutionWorker(pinned);
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
    bundleNotRetained: "bundle_unavailable",
    bundleWithAnotherController: "bundle_altered",
    saveWithAnEditedRecord: "save_not_opened",
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

  const retainedScenarios = [];
  for (const previous of [
    {
      id: "bed7d40dd7986ba58b5d20798da823a13a105f3d11a8caadd4e89e031846fc44",
      schemaVersion: 1,
    },
    {
      id: "c5cba9f372024f8b51949b13bdeee6bb0df641305424fa9114f89217f3381366",
      schemaVersion: 2,
    },
    {
      id: "f6c717fd9975c0bda6fdf08f12c6a40cffd77826373e167b4dd7e2e78fd5a27c",
      schemaVersion: 3,
    },
    {
      id: "5c62de98106ce0d2e8f3ce18040e192ebb599573e889dfab8fe6e6bd8845f1ab",
      schemaVersion: 4,
    },
  ]) {
    const retained = await page.evaluate(continueRetainedScenario, previous);
    journeyCheck(
      retained.schemaVersion === previous.schemaVersion,
      "The old scenario keeps its schema",
    );
    journeyCheck(
      retained.status === "completed",
      "The old bundle continues its save",
    );
    retainedScenarios.push(retained);
  }

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
    retainedScenarios,
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
      "the Portal starts the retained bundle's worker and runs the journey through the host protocol",
      "the run is paused and saved twice after a pickup, once with the arm returning and once with the cell empty",
      "each save's worker is destroyed and a fresh worker resolved from the save's bundle continues it",
      "the interrupted run ends in the same history, production state and cell checkpoint",
      "unretained and altered bundles, edited saves and changed checkpoints are refused",
      "the current Portal restores schema-1, schema-2 and schema-3 saves through their retained engines after new runs move to schema 4",
    ],
  };
}

// The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
// combobox that opens a listbox popup. Choose by { value }, { label } or
// { index }. { values } sets the items of a multiple Select, then Escape
// closes its popup.
async function chooseOption(page, trigger, choice) {
  await trigger.click();
  const popup = page.locator(".pantry-select-popup[data-open]");
  await popup.waitFor();
  const items = popup.locator(".pantry-select-item");
  if ("values" in choice) {
    const wanted = choice.values.map(String);
    for (const item of await items.all()) {
      const chosen = wanted.includes(await item.getAttribute("data-value"));
      const selected = (await item.getAttribute("aria-selected")) === "true";
      if (chosen !== selected) await item.click();
    }
    await page.keyboard.press("Escape");
  } else if ("value" in choice) {
    await popup
      .locator(
        `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
      )
      .click();
  } else if ("label" in choice) {
    await popup
      .getByRole("option", { name: choice.label, exact: true })
      .click();
  } else {
    await items.nth(choice.index).click();
  }
  await popup.waitFor({ state: "hidden" });
}

async function continueRetainedScenario({ id, schemaVersion }) {
  const api = window.productionRunPreview;
  // Keep actual prior builds so a source rebuild cannot masquerade as old code.
  const response = await fetch(
    `/bakery-physics/executions/${id}/execution.json`,
  );
  if (!response.ok) throw new Error("The previous execution bundle is missing");
  const manifest = await response.json();
  if (manifest.bundle.id === api.pinned.id)
    throw new Error("The current and previous bundles must differ");
  const opened = await api.openExecutionWorker(manifest.bundle);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  let worker = opened.value;
  const definition = await api.define(worker);
  const scenario = await api.scenarioFor(definition);
  // Construct the historical request shape for the historical engine only.
  scenario.schemaVersion = schemaVersion;
  if (schemaVersion < 5) delete scenario.dependencies;
  if (schemaVersion < 3)
    for (const resource of scenario.resources) delete resource.kind;
  if (schemaVersion === 1)
    for (const workflow of scenario.workflows)
      for (const task of workflow.tasks) delete task.releaseAfter;
  let reply = await worker.request({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [definition],
    identity: {
      runId: `retained-schema-${schemaVersion}`,
      executionId: "previous-run",
      hostSession: "previous-host",
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  if (reply.kind !== "began") throw new Error(JSON.stringify(reply));
  for (let turn = 0; turn < 10_000; turn += 1) {
    reply = await worker.request({
      kind: "drive",
      turns: 128,
      until: 16_000_000,
    });
    if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
    if (reply.view.time === 16_000_000) break;
  }
  if (reply.view.time !== 16_000_000)
    throw new Error("The historical run did not reach its save boundary");
  const paused = await worker.request({
    kind: "pause",
    commandId: "historical-pause",
  });
  if (paused.kind !== "commanded" || paused.receipt.status !== "accepted")
    throw new Error(JSON.stringify(paused));
  const saved = await worker.request({ kind: "save" });
  if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
  worker.terminate();

  const restored = await api.openExecutionWorker(saved.document.bundle);
  if (!restored.ok) throw new Error(JSON.stringify(restored.error));
  worker = restored.value;
  reply = await worker.request({
    kind: "begin",
    bundle: worker.manifest.bundle,
    cells: [definition],
    identity: {
      runId: `retained-schema-${schemaVersion}`,
      executionId: "continued-old-run",
      hostSession: "new-portal-host",
      parent: {
        snapshot: saved.document.snapshot,
        execution: saved.document.state.identity.executionId,
      },
    },
    origin: {
      kind: "snapshot",
      document: saved.document,
      checkpoints: saved.artifacts,
    },
  });
  if (reply.kind !== "began") throw new Error(JSON.stringify(reply));
  for (let turn = 0; turn < 10_000; turn += 1) {
    reply = await worker.request({
      kind: "drive",
      turns: 128,
      until: 600_000_000,
    });
    if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
    if (reply.view.status.kind === "completed") break;
  }
  const final = await worker.request({ kind: "state" });
  worker.terminate();
  if (final.kind !== "state") throw new Error(JSON.stringify(final));
  return {
    bundle: manifest.bundle.id,
    currentBundle: api.pinned.id,
    schemaVersion: final.run.definition.scenario.schemaVersion,
    status: final.run.status.kind,
    completedAtSeconds: final.run.position.time / 1_000_000,
    saved,
    final: final.run,
  };
}
