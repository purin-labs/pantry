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
  const { parseProductionScenario } =
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
  const unavailable = parseProductionScenario({
    ...definition,
    executionBundleId: "0".repeat(64),
  });
  if (unavailable?.route !== "oven-rack")
    throw new Error("Invalid unavailable-build fixture");
  const missingBuild = await api.openAuthoredCellWorker(unavailable);
  if (missingBuild.ok || missingBuild.error.code !== "inspection_only")
    throw new Error("A missing authored build must not use the current build");
  const altered = parseProductionScenario({
    ...definition,
    cell: {
      ...definition.cell,
      execution: { ...definition.cell.execution, runtimeHash: "0".repeat(64) },
    },
  });
  if (altered?.route !== "oven-rack")
    throw new Error("Invalid changed-runtime fixture");
  const mismatch = await api.openAuthoredCellWorker(altered);
  if (mismatch.ok || mismatch.error.code !== "fixture_bundle_mismatch")
    throw new Error("A different runtime must not execute the pinned fixture");
  let saved = null;
  const saves = [];
  let final = null;
  const stops = [...expectedReport.restores, input.scenario.limits.horizon];
  for (const [leg, until] of stops.entries()) {
    const opened = await api.openAuthoredCellWorker(definition);
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
    refusedBuilds: [missingBuild.error, mismatch.error],
    simulatedSeconds: final.position.time / 1_000_000,
    saves,
    final,
  };
}
