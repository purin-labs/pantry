// The browser compiles the existing recipe and executes it through the Portal's
// retained worker. No main-simulator host conversion is implied by this journey.
async function verifyFinancierJourneyBrowser(page) {
  await page.waitForFunction(financierPreviewReady);
  const bundle = await page.evaluate(financierEvidenceBundle);
  const reports = [];
  for (const authored of [false, true])
    for (const variant of ["normal", "outage"])
      reports.push(
        await page.evaluate(financierBrowserCase, {
          variant,
          authored,
          bundle,
        }),
      );
  const preparation = [];
  for (const capacity of [1_490_000, 745_000])
    preparation.push(
      await page.evaluate(financierPreparationBrowserCase, {
        capacity,
        bundle,
      }),
    );
  const recipes = [];
  for (const name of ["recipe-grid-1", "recipe-grid-2"])
    recipes.push(
      await page.evaluate(financierRecipeBrowserCase, { name, bundle }),
    );
  await page.screenshot({ path: "financier-recipe.png", fullPage: true });
  return { result: "passed", reports, preparation, recipes };
}

function financierPreviewReady() {
  return "productionRunPreview" in window;
}

async function financierPreparationBrowserCase({
  capacity: holdingCapacityMg,
  bundle: initialBundle,
}) {
  const { compileFinancierPreparation } =
    await import("/@id/@seams/production-simulation/recipes/bakery/financier");
  const { canonicalJson } = await import("/@id/@seams/std");
  const input = {
    revision: 1,
    evidence: "assumed",
    flavour: "hazelnut",
    ingredientsMg: {
      butter: 180_000,
      "egg-whites": 180_000,
      "almond-flour": 60_000,
      "wheat-flour": 100_000,
      sugar: 195_000,
      "roasted-hazelnut-flour": 40_000,
      "chopped-roasted-hazelnut": 20_000,
    },
    brownedButterMg: 158_000,
    batterMg: 745_000,
    evaporationMg: 22_000,
    residueMg: 8_000,
    spillMg: 0,
    measurementDifferenceMg: 0,
    holdingCapacityMg,
    durationsSeconds: {
      weigh: 10,
      "brown-butter": 360,
      "return-pan": 10,
      mix: 120,
      "store-batter": 30,
      clean: 90,
      "put-away": 10,
    },
    travelSeconds: 5,
    arrivalsSeconds: [0, 1],
    horizonSeconds: 3600,
  };
  const compiled = await compileFinancierPreparation(input);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const scenario = compiled.value;
  const states = [];
  const saves = [];
  let saved = null;
  let bundle = initialBundle;
  // These boundaries fall inside browning, mixing, cleaning and return handling.
  // Each leg gets a new worker, including the final blocked/completed reopen.
  for (const [leg, stop] of [61, 431, 581, 671, 3600, 3600].entries()) {
    const opened =
      await window.productionRunPreview.openExecutionWorker(bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    bundle = worker.manifest.bundle;
    try {
      const begin = await worker.request({
        kind: "begin",
        bundle,
        cells: [],
        identity: {
          runId: "financier-preparation-browser",
          executionId: `leg-${leg}`,
          hostSession: `host-${leg}`,
          parent:
            saved === null
              ? null
              : {
                  snapshot: saved.document.snapshot,
                  execution: saved.document.state.identity.executionId,
                },
        },
        origin:
          saved === null
            ? { kind: "scenario", scenario }
            : {
                kind: "snapshot",
                document: saved.document,
                checkpoints: saved.artifacts,
              },
      });
      if (begin.kind !== "began") throw new Error(JSON.stringify(begin));
      const drove = await worker.request({
        kind: "drive",
        turns: 128,
        until: stop * 1_000_000,
      });
      if (drove.kind !== "drove") throw new Error(JSON.stringify(drove));
      const state = await worker.request({ kind: "state" });
      if (state.kind !== "state") throw new Error(JSON.stringify(state));
      states.push(state.run);
      if (leg < 4) {
        if (state.run.status.kind !== "advancing")
          throw new Error("Preparation stopped before the planned boundary");
        const pause = await worker.request({
          kind: "pause",
          commandId: `pause-${leg}`,
        });
        if (pause.kind !== "commanded" || pause.receipt.status !== "accepted")
          throw new Error(JSON.stringify(pause));
      }
      saved = await worker.request({ kind: "save" });
      if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
      saves.push(saved);
    } finally {
      worker.terminate();
    }
  }
  const continued = states.at(-1);
  const expected = holdingCapacityMg === 745_000 ? "blocked" : "completed";
  if (continued.status.kind !== expected)
    throw new Error("Incorrect preparation storage result");
  const before = states.at(-2);
  if (
    canonicalJson(before.lots) !== canonicalJson(continued.lots) ||
    canonicalJson(before.carriers) !== canonicalJson(continued.carriers)
  )
    throw new Error("Final reopen changed material or vessel custody");
  return {
    name: `preparation-${holdingCapacityMg}`,
    bundle: bundle.id,
    input,
    scenario,
    continued,
    states,
    saves,
    status: expected,
  };
}

async function financierBrowserCase({
  variant,
  authored,
  bundle: initialBundle,
}) {
  const { compileFinancier } =
    await import("/@id/@seams/production-simulation/recipes/bakery/financier");
  const { simulateSteps, resolveAuthoredFinancierRun } =
    await import("/@id/@seams/production-simulation/recipes/bakery/schedule");
  const { sampleSettings, parseSettings } =
    await import("/@id/@seams/bakery-model/bakery");
  const { canonicalJson } = await import("/@id/@seams/std");
  let overrides = { horizonMinutes: 240 };
  if (authored)
    overrides = { workerCount: 2, rackTrays: 6, horizonMinutes: 240 };
  else if (variant === "normal")
    overrides = {
      batchCount: 6,
      rackTrays: 2,
      loadWindow: 10,
      horizonMinutes: 240,
    };
  const parsed = parseSettings({ ...sampleSettings(), ...overrides });
  if (parsed.kind !== "valid") throw new Error(parsed.message);
  const settings = parsed.settings;
  const rules = authored
    ? [
        {
          bakeryTaskId: "batch:A:process:stage",
          workerId: "human-2",
          earliestStartSeconds: 600,
          dependsOn: ["batch:C:process:portion"],
        },
        {
          bakeryTaskId: "batch:B:process:stage",
          workerId: "human-1",
          earliestStartSeconds: 3000,
          dependsOn: ["batch:A:transfer:stage:portion"],
        },
        {
          bakeryTaskId: "batch:C:process:pack",
          workerId: "human-1",
          earliestStartSeconds: 0,
          dependsOn: ["batch:B:process:stage"],
        },
      ]
    : [];
  const resolved = resolveAuthoredFinancierRun(settings, variant, rules);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  const scenario = await compileFinancier(resolved.value);
  const steps = simulateSteps(resolved.value);
  let step = steps.next();
  while (!step.done) step = steps.next();
  const finite = step.value;
  if (finite.kind !== "complete")
    throw new Error("The reference recipe did not finish");
  const api = window.productionRunPreview;
  const referenceHost = await api.openExecutionWorker(initialBundle);
  if (!referenceHost.ok) throw new Error(JSON.stringify(referenceHost.error));
  const bundle = referenceHost.value.manifest.bundle;
  const began = await referenceHost.value.request({
    kind: "begin",
    bundle,
    cells: [],
    identity: {
      runId: "financier-browser",
      executionId: "reference",
      hostSession: "reference",
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  if (began.kind !== "began") throw new Error(JSON.stringify(began));
  const drove = await referenceHost.value.request({
    kind: "drive",
    turns: 128,
    until: settings.horizonMinutes * 60_000_000,
  });
  if (drove.kind !== "drove" || drove.view.status.kind !== "completed")
    throw new Error(JSON.stringify(drove));
  const baseline = await referenceHost.value.request({ kind: "state" });
  referenceHost.value.terminate();
  if (baseline.kind !== "state") throw new Error(JSON.stringify(baseline));
  if (baseline.run.position.time !== finite.end * 1_000_000)
    throw new Error("Browser recipe timing differs");

  const states = [];
  const saves = [];
  const stops = [
    finite.cycles[0].start + 1,
    finite.cycles[0].end + 1,
    settings.horizonMinutes * 60,
  ];
  if (authored) stops.unshift(1);
  let saved = null;
  let continued = null;
  for (const [leg, stop] of stops.entries()) {
    const opened = await api.openExecutionWorker(
      saved === null ? bundle : saved.document.bundle,
    );
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const begin = await worker.request({
      kind: "begin",
      bundle: worker.manifest.bundle,
      cells: [],
      identity: {
        runId: "financier-browser",
        executionId: `leg-${leg}`,
        hostSession: `host-${leg}`,
        parent:
          saved === null
            ? null
            : {
                snapshot: saved.document.snapshot,
                execution: saved.document.state.identity.executionId,
              },
      },
      origin:
        saved === null
          ? { kind: "scenario", scenario }
          : {
              kind: "snapshot",
              document: saved.document,
              checkpoints: saved.artifacts,
            },
    });
    if (begin.kind !== "began") throw new Error(JSON.stringify(begin));
    const drive = await worker.request({
      kind: "drive",
      turns: 128,
      until: stop * 1_000_000,
    });
    if (drive.kind !== "drove") throw new Error(JSON.stringify(drive));
    const state = await worker.request({ kind: "state" });
    if (state.kind !== "state") throw new Error(JSON.stringify(state));
    states.push(state.run);
    if (leg < stops.length - 1) {
      const pause = await worker.request({
        kind: "pause",
        commandId: `pause-${leg}`,
      });
      if (pause.kind !== "commanded" || pause.receipt.status !== "accepted")
        throw new Error(JSON.stringify(pause));
      saved = await worker.request({ kind: "save" });
      if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
      saves.push(saved);
    } else {
      continued = state.run;
    }
    worker.terminate();
  }
  if (continued === null || continued.status.kind !== "completed")
    throw new Error("The continued recipe did not finish");
  const referenceEvents = [];
  const continuedEvents = [];
  for (const { sequence, execution, ...event } of baseline.run.events)
    if (event.kind !== "command-admitted") referenceEvents.push(event);
  for (const { sequence, execution, ...event } of continued.events)
    if (event.kind !== "command-admitted") continuedEvents.push(event);
  if (canonicalJson(referenceEvents) !== canonicalJson(continuedEvents))
    throw new Error("Browser continuation changed accepted history");
  const {
    identity: referenceIdentity,
    events: referenceHistory,
    commands: referenceCommands,
    position: referencePosition,
    ...referenceWorld
  } = baseline.run;
  const {
    identity: continuedIdentity,
    events: continuedHistory,
    commands: continuedCommands,
    position: continuedPosition,
    ...continuedWorld
  } = continued;
  if (
    referencePosition.time !== continuedPosition.time ||
    canonicalJson(referenceWorld) !== canonicalJson(continuedWorld)
  )
    throw new Error("Browser continuation changed world state");
  let packed = 0;
  for (const event of continued.events)
    if (
      event.kind === "quantity-reported" &&
      event.destination === "packed-financiers"
    )
      packed += event.quantity.amount;
  if (
    packed !==
    settings.batchCount * settings.traysPerBatch * settings.piecesPerTray
  )
    throw new Error("The browser recipe changed packed output");
  return {
    variant,
    name: authored
      ? `authored-${variant}`
      : variant === "normal"
        ? "blocked-cooling"
        : "outage",
    bundle: bundle.id,
    simulatedSeconds: finite.end,
    packed,
    scenario,
    finite,
    baseline: baseline.run,
    continued,
    states,
    saves,
    sameHistoryAndWorld: true,
  };
}

async function financierRecipeBrowserCase({ name, bundle: initialBundle }) {
  const evidence = new URL(location.href).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the headless recipe evidence URL");
  const { compileFinancierRecipe } =
    await import("/@id/@seams/production-simulation/recipes/bakery/financier");
  const { canonicalJson, sha256Hex } = await import("/@id/@seams/std");
  const inputResponse = await fetch(`${evidence}/${name}-input.json`);
  const baselineResponse = await fetch(`${evidence}/${name}-baseline.json`);
  const reportResponse = await fetch(`${evidence}/report.json`);
  if (!inputResponse.ok || !baselineResponse.ok || !reportResponse.ok)
    throw new Error("Recipe evidence is incomplete");
  const { input, scenario: headlessScenario } = await inputResponse.json();
  const baseline = await baselineResponse.json();
  const report = await reportResponse.json();
  let expected = null;
  for (const recipe of report.recipes)
    if (recipe.name === name) expected = recipe;
  if (expected === null) throw new Error("Recipe case is missing");
  const compiled = await compileFinancierRecipe(input);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const scenario = compiled.value;
  if (canonicalJson(scenario) !== canonicalJson(headlessScenario))
    throw new Error("Recipe compilation differs between hosts");
  let saved = null;
  let bundle = initialBundle;
  let continued = null;
  const checkpoints = [];
  const stops = [...expected.stops, input.preparations[0].horizonSeconds];
  for (const [leg, stop] of stops.entries()) {
    const opened =
      await window.productionRunPreview.openExecutionWorker(bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    bundle = worker.manifest.bundle;
    if (bundle.id !== baseline.identity.bundle)
      throw new Error("Browser and headless engine differ");
    try {
      const begin = await worker.request({
        kind: "begin",
        bundle,
        cells: [],
        identity: {
          runId: "financier-recipe-browser",
          executionId: `leg-${leg}`,
          hostSession: `host-${leg}`,
          parent:
            saved === null
              ? null
              : {
                  snapshot: saved.document.snapshot,
                  execution: saved.document.state.identity.executionId,
                },
        },
        origin:
          saved === null
            ? { kind: "scenario", scenario }
            : {
                kind: "snapshot",
                document: saved.document,
                checkpoints: saved.artifacts,
              },
      });
      if (begin.kind !== "began") throw new Error(JSON.stringify(begin));
      for (let action = 0; action < 20; action++) {
        const drove = await worker.request({
          kind: "drive",
          turns: 128,
          until: stop * 1_000_000,
        });
        if (drove.kind !== "drove") throw new Error(JSON.stringify(drove));
        if (drove.view.status.kind !== "awaiting-inspection") break;
        let pending = null;
        for (const item of drove.view.inspections)
          if (item.kind === "pending") {
            pending = item;
            break;
          }
        if (pending === null) throw new Error("Missing inspection request");
        const admitted = await worker.request({
          kind: "inspect",
          commandId: `inspect-${pending.task.replaceAll("#", "-").replaceAll("/", "-")}`,
          expectedControlRevision: drove.view.controlRevision,
          task: pending.task,
          definition: pending.definition,
          lots: pending.lots,
          outcome: pending.task.startsWith("load-hazelnut-b#") ? "reject" : "accept",
          note: "Synthetic operator observation for the acceptance journey",
        });
        if (
          admitted.kind !== "commanded" ||
          admitted.receipt.status !== "accepted"
        )
          throw new Error(JSON.stringify(admitted));
      }
      const state = await worker.request({ kind: "state" });
      if (state.kind !== "state") throw new Error(JSON.stringify(state));
      if (leg < stops.length - 1) {
        if (state.run.status.kind !== "advancing")
          throw new Error("Recipe stopped before planned interruption");
        const paused = await worker.request({
          kind: "pause",
          commandId: `pause-${leg}`,
        });
        if (paused.kind !== "commanded" || paused.receipt.status !== "accepted")
          throw new Error(JSON.stringify(paused));
      } else continued = state.run;
      saved = await worker.request({ kind: "save" });
      if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
      checkpoints.push({
        at: state.run.position.time,
        snapshot: saved.document.snapshot,
        stateDigest: await sha256Hex(canonicalJson(state.run)),
      });
    } finally {
      worker.terminate();
    }
  }
  if (continued === null || continued.status.kind !== "completed")
    throw new Error("The recipe did not finish");
  const referenceEvents = [];
  const browserEvents = [];
  for (const { sequence, execution, ...event } of baseline.events)
    if (event.kind !== "command-admitted") referenceEvents.push(event);
  for (const { sequence, execution, ...event } of continued.events)
    if (event.kind !== "command-admitted") browserEvents.push(event);
  if (canonicalJson(referenceEvents) !== canonicalJson(browserEvents))
    throw new Error("Recipe history differs between hosts");
  const {
    identity: originalIdentity,
    events: originalEvents,
    commands: originalCommands,
    position: originalPosition,
    ...originalWorld
  } = baseline;
  const {
    identity: browserIdentity,
    events: finalEvents,
    commands: browserCommands,
    position: browserPosition,
    ...browserWorld
  } = continued;
  if (
    originalPosition.time !== browserPosition.time ||
    canonicalJson(originalWorld) !== canonicalJson(browserWorld)
  )
    throw new Error("Recipe world state differs between hosts");
  return {
    name,
    bundle: bundle.id,
    status: continued.status.kind,
    continued,
    saved,
    checkpoints,
    sameHistoryAndWorld: true,
  };
}

async function financierEvidenceBundle() {
  const evidence = new URL(location.href).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the headless recipe evidence URL");
  const response = await fetch(`${evidence}/report.json`);
  if (!response.ok) throw new Error("Missing recipe report");
  const report = await response.json();
  const manifestResponse = await fetch(
    `${evidence}/executions/${report.bundle}/execution.json`,
  );
  if (!manifestResponse.ok)
    throw new Error("Missing retained execution manifest");
  const manifest = await manifestResponse.json();
  if (manifest.bundle.id !== report.bundle)
    throw new Error("Execution identity differs from the report");
  return manifest.bundle;
}
