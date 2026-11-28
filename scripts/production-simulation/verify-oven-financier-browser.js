async function verifyOvenFinancierBrowser(page) {
  await page.waitForFunction(ovenFinancierReady);
  return page.evaluate(ovenFinancierBrowser);
}
function ovenFinancierReady() {
  return "productionRunPreview" in window;
}

async function ovenFinancierBrowser() {
  const evidence = new URL(location.href).searchParams.get("evidence");
  if (evidence === null) throw new Error("Provide the headless evidence URL");
  const { canonicalJson } = await import("/@id/@purin-labs/std");
  const { compileSavedOvenFinancier } =
    await import("/@id/@purin-labs/production-simulation/recipes/bakery/financier");
  const inputResponse = await fetch(`${evidence}/input.json`);
  const reportResponse = await fetch(`${evidence}/report.json`);
  const baselineResponse = await fetch(`${evidence}/baseline.json`);
  if (!inputResponse.ok || !reportResponse.ok || !baselineResponse.ok)
    throw new Error("Missing full-route evidence");
  const input = await inputResponse.json();
  const expectedReport = await reportResponse.json();
  const baseline = await baselineResponse.json();
  const { parseProductionScenario, productionDefinitionFingerprint } =
    await import("/@id/@purin-labs/bakery-model/bakery-production-scenario");
  const definitionResponse = await fetch(`${evidence}/shared-definition.json`);
  if (!definitionResponse.ok) throw new Error("Missing shared definition");
  const definition = parseProductionScenario(await definitionResponse.json());
  if (definition?.route !== "oven-rack")
    throw new Error("Expected the saved oven route");
  const compiled = await compileSavedOvenFinancier(definition);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  if (canonicalJson(compiled.value) !== canonicalJson(input.scenario))
    throw new Error("Browser and headless recipe compilation differ");
  const api = window.productionRunPreview;
  // A route that another engine build authored names that build, its
  // runtime and its model. The engine of this Portal defines the same cell
  // again, and the route runs as the present definition does (Refactor 16,
  // step 8).
  const earlierRoute = {
    route: "oven-rack",
    executionBundleId: "0".repeat(64),
    cell: {
      ...definition.cell,
      modelHash: "1".repeat(64),
      execution: { ...definition.cell.execution, runtimeHash: "0".repeat(64) },
    },
  };
  const earlier = parseProductionScenario({
    ...definition,
    ...earlierRoute,
    definitionFingerprint: await productionDefinitionFingerprint(
      definition.sourceFingerprint,
      definition.settings,
      definition.variant,
      definition.assignments,
      definition.manualTasks,
      earlierRoute,
    ),
  });
  if (earlier?.route !== "oven-rack")
    throw new Error("Invalid earlier-build fixture");
  const earlierScenario = await compileSavedOvenFinancier(earlier);
  if (!earlierScenario.ok)
    throw new Error(JSON.stringify(earlierScenario.error));
  if (canonicalJson(earlierScenario.value) === canonicalJson(input.scenario))
    throw new Error("The earlier route must name another model");
  const rebound = await api.openExecutionWorker();
  if (!rebound.ok) throw new Error(JSON.stringify(rebound.error));
  const reboundBegan = await rebound.value.request({
    kind: "begin",
    bundle: rebound.value.manifest.bundle,
    cells: [earlier.cell],
    identity: {
      runId: "oven-financier-earlier-build",
      executionId: "browser-earlier",
      hostSession: "browser-earlier",
      parent: null,
    },
    origin: { kind: "scenario", scenario: earlierScenario.value },
  });
  if (reboundBegan.kind !== "began")
    throw new Error(JSON.stringify(reboundBegan));
  if (canonicalJson(reboundBegan.cells) !== canonicalJson([input.cell]))
    throw new Error("The engine must define the earlier cell as its own");
  const reboundState = await rebound.value.request({ kind: "state" });
  rebound.value.terminate();
  // The route keeps its own source revision, in its sources and in each
  // workflow. Each other part of the scenario is that of the present route.
  const withoutRevision = ({ sources, workflows, ...rest }) => ({
    ...rest,
    workflows: workflows.map(({ revision: _revision, ...flow }) => flow),
    revision: sources,
  });
  const { revision: earlierSources, ...reboundScenario } = withoutRevision(
    reboundState.run.definition.scenario,
  );
  const { revision: presentSources, ...presentScenario } = withoutRevision(
    input.scenario,
  );
  if (canonicalJson(earlierSources) === canonicalJson(presentSources))
    throw new Error("The earlier route must keep its own source revision");
  const differing = [];
  for (const key of Object.keys(presentScenario))
    if (
      canonicalJson(reboundScenario[key]) !==
      canonicalJson(presentScenario[key])
    )
      differing.push(key);
  if (differing.length > 0)
    throw new Error(
      `The earlier route must run as the present route; these parts differ: ${differing.join(", ")}`,
    );
  let saved = null;
  const saves = [];
  let final = null;
  const stops = [...expectedReport.restores, input.scenario.limits.horizon];
  for (const [leg, until] of stops.entries()) {
    const opened = await api.openExecutionWorker();
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const bundle = worker.manifest.bundle;
    if (bundle.id !== input.bundle.id)
      throw new Error("Execution bundle differs");
    const began = await worker.request({
      kind: "begin",
      bundle,
      cells: [input.cell],
      identity: {
        runId: "oven-financier",
        executionId: `browser-${leg}`,
        hostSession: `browser-${leg}`,
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
          ? { kind: "scenario", scenario: compiled.value }
          : {
              kind: "snapshot",
              document: saved.document,
              checkpoints: saved.artifacts,
            },
    });
    if (began.kind !== "began") throw new Error(JSON.stringify(began));
    let done = false;
    for (let call = 0; call < 4000; call++) {
      const progress = await worker.request({
        kind: "drive",
        turns: 128,
        until,
      });
      if (progress.kind !== "drove") throw new Error(JSON.stringify(progress));
      if (
        progress.view.time >= until ||
        ["completed", "blocked", "stopped-at-limit"].includes(
          progress.view.status.kind,
        )
      ) {
        done = true;
        break;
      }
    }
    if (!done) throw new Error("Recipe exceeded its host-call bound");
    const state = await worker.request({ kind: "state" });
    if (state.kind !== "state") throw new Error(JSON.stringify(state));
    if (leg === stops.length - 1) {
      final = state.run;
      worker.terminate();
      break;
    }
    if (state.run.status.kind !== "advancing")
      throw new Error("Recipe stopped before its restore point");
    const paused = await worker.request({
      kind: "pause",
      commandId: `browser-pause-${leg}`,
    });
    if (paused.receipt?.status !== "accepted")
      throw new Error(JSON.stringify(paused));
    saved = await worker.request({ kind: "save" });
    if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
    saves.push(saved);
    worker.terminate();
  }
  if (final?.status.kind !== "completed")
    throw new Error("Recipe did not finish");
  const expectedEvents = [];
  const actualEvents = [];
  for (const { sequence, execution, ...event } of baseline.events)
    if (event.kind !== "command-admitted") expectedEvents.push(event);
  for (const { sequence, execution, ...event } of final.events)
    if (event.kind !== "command-admitted") actualEvents.push(event);
  if (canonicalJson(expectedEvents) !== canonicalJson(actualEvents))
    throw new Error("Browser and headless recipe events differ");
  const {
    identity: expectedIdentity,
    events: expectedHistory,
    commands: expectedCommands,
    position: expectedPosition,
    ...expectedWorld
  } = baseline;
  const {
    identity: actualIdentity,
    events: actualHistory,
    commands: actualCommands,
    position: actualPosition,
    ...actualWorld
  } = final;
  if (
    canonicalJson(expectedWorld) !== canonicalJson(actualWorld) ||
    expectedPosition.time !== actualPosition.time
  )
    throw new Error("Browser and headless recipe states differ");
  return {
    result: "passed",
    bundle: input.bundle.id,
    restores: saves.length,
    earlierBuildRouteRunsOnThisEngine: true,
    simulatedSeconds: final.position.time / 1_000_000,
    saves,
    final,
  };
}
