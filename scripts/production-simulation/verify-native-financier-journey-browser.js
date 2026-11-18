async function verifyNativeFinancierJourneyBrowser(page) {
  await page.waitForFunction(nativeFinancierReady);
  return page.evaluate(nativeFinancierBrowser);
}
function nativeFinancierReady() {
  return "productionRunPreview" in window;
}

async function nativeFinancierBrowser() {
  const { compileProductionFinancier } =
    await import("/@id/@seams/production-simulation/recipes/bakery/financier");
  const { compileProductionWorkcells } =
    await import("/@id/@seams/production-simulation/recipes/bakery/production-workcells");
  const { compileWorkcellInput } =
    await import("/@id/@seams/production-simulation/recipes/bakery/workcell-input");
  const { parsePhysicsRequest } =
    await import("/@id/@seams/bakery-model/bakery-physics");
  const { parseSettings, sampleSettings } =
    await import("/@id/@seams/bakery-model/bakery");
  const { canonicalJson } = await import("/@id/@seams/std");
  const api = window.productionRunPreview;
  const prepared = await api.openExecutionWorker(null);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const bundle = prepared.value.manifest.bundle;
  const defined = await prepared.value.request({
    kind: "define",
    cell: "cold-cell-1",
  });
  if (defined.kind !== "defined") throw new Error(JSON.stringify(defined));
  const cell = { ...defined.definition, runId: "native-financier-cell" };
  prepared.value.terminate();
  const parsed = parseSettings({
    ...sampleSettings(),
    batchCount: 3,
    traysPerBatch: 1,
    workerCount: 2,
    rackTrays: 6,
    horizonMinutes: 240,
  });
  if (parsed.kind !== "valid") throw new Error(parsed.message);
  const settings = parsed.settings;
  const assignments = [];
  for (const batchId of ["A", "B"]) {
    const raw = {
      schemaVersion: 7,
      source: "local-simulation",
      runId: `financier-${batchId}`,
      attemptId: `request-${batchId}`,
      bakeryTaskId: "table-to-rack",
      case: "nominal",
      layout: { kind: "fixed" },
      robot: cell.robot,
      ingredients: cell.ingredients,
      clampForceN: cell.clampForceN,
      timestep: cell.timestep,
      modelHash: cell.modelHash,
      execution: { controller: "bakery-native", ...cell.execution },
    };
    const request = parsePhysicsRequest(JSON.stringify(raw));
    if (request.kind !== "accepted") throw new Error(request.message);
    const input = compileWorkcellInput(request.request, "0", "cold-cell-1");
    if (input.kind !== "ready") throw new Error(input.message);
    assignments.push({
      batchId,
      tray: 1,
      workerId: "human-1",
      earliestStartSeconds: 0,
      dependsOn: batchId === "A" ? ["batch:C:process:portion"] : [],
      input: input.input,
    });
  }
  const manualTasks = [
    {
      bakeryTaskId: "batch:B:process:stage",
      workerId: "human-2",
      dependsOn: ["batch:A:native:1"],
      earliestStartSeconds: 3000,
    },
    {
      bakeryTaskId: "batch:C:process:pack",
      workerId: "human-1",
      dependsOn: ["batch:B:process:stage"],
      earliestStartSeconds: 0,
    },
  ];
  const plan = await compileProductionWorkcells(
    settings,
    "normal",
    assignments,
    { manualTasks, procedureFingerprint: null },
  );
  if (plan.kind !== "ready") throw new Error(plan.message);
  const compiled = await compileProductionFinancier(plan.plan, [cell]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const scenario = compiled.value;
  const horizon = settings.horizonMinutes * 60_000_000;
  let baseline = null;
  let continued = null;
  let saved = null;
  const saves = [];
  const stops = [horizon];
  for (let leg = 0; leg < 5; leg++) {
    const opened = await api.openExecutionWorker(bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const began = await worker.request({
      kind: "begin",
      bundle,
      cells: [cell],
      identity: {
        runId: "native-financier",
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
    if (began.kind !== "began") throw new Error(JSON.stringify(began));
    let reached = false;
    for (let turn = 0; turn < 2000; turn++) {
      const reply = await worker.request({
        kind: "drive",
        turns: 128,
        until: stops[leg],
      });
      if (reply.kind !== "drove" || reply.view.status.kind === "blocked")
        throw new Error(JSON.stringify(reply));
      if (
        reply.view.time >= stops[leg] ||
        reply.view.status.kind === "completed"
      ) {
        reached = true;
        break;
      }
    }
    if (!reached)
      throw new Error("Native browser journey exceeded its host-call bound");
    const state = await worker.request({ kind: "state" });
    if (state.kind !== "state") throw new Error(JSON.stringify(state));
    if (leg === 0) {
      baseline = state.run;
      let first = null;
      let second = null;
      for (const task of baseline.tasks) {
        if (task.id === "batch-A#0/native-1") first = task;
        if (task.id === "batch-B#0/native-1") second = task;
      }
      if (first?.kind !== "completed" || second?.kind !== "completed")
        throw new Error("Both native operations must complete");
      stops.push(
        first.startedAt + 10_000_000,
        first.completedAt + 5_000_000,
        second.startedAt + 10_000_000,
        horizon,
      );
    } else if (leg < 4) {
      const paused = await worker.request({
        kind: "pause",
        commandId: `pause-${leg}`,
      });
      if (paused.receipt?.status !== "accepted")
        throw new Error(JSON.stringify(paused));
      saved = await worker.request({ kind: "save" });
      if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
      saves.push(saved);
    } else continued = state.run;
    worker.terminate();
  }
  if (
    baseline?.status.kind !== "completed" ||
    continued?.status.kind !== "completed"
  )
    throw new Error("The native recipe did not finish");
  const histories = [];
  const worlds = [];
  for (const run of [baseline, continued]) {
    const accepted = [];
    for (const { sequence, execution, ...event } of run.events)
      if (event.kind !== "command-admitted") accepted.push(event);
    histories.push(canonicalJson(accepted));
    const { identity, events, commands, position, ...state } = run;
    worlds.push(canonicalJson({ ...state, time: position.time }));
  }
  if (histories[0] !== histories[1] || worlds[0] !== worlds[1])
    throw new Error("Native browser restore changed accepted state");
  let packed = 0;
  for (const event of continued.events)
    if (
      event.kind === "quantity-reported" &&
      event.destination === "packed-financiers"
    )
      packed += event.quantity.amount;
  if (packed !== 72) throw new Error("Native recipe output differs");
  const weakCell = {
    ...cell,
    clampForceN: 20,
    ingredients: { ...cell.ingredients, massKg: 2.5 },
  };
  const weakAssignments = [];
  for (const assignment of assignments) {
    const parsed = parsePhysicsRequest(
      JSON.stringify({
        ...assignment.input.request,
        clampForceN: 20,
        ingredients: weakCell.ingredients,
      }),
    );
    if (parsed.kind !== "accepted") throw new Error(parsed.message);
    const input = compileWorkcellInput(parsed.request, "0", "cold-cell-1");
    if (input.kind !== "ready") throw new Error(input.message);
    weakAssignments.push({ ...assignment, input: input.input });
  }
  const weakPlan = await compileProductionWorkcells(
    settings,
    "normal",
    weakAssignments,
    { manualTasks, procedureFingerprint: null },
  );
  if (weakPlan.kind !== "ready") throw new Error(weakPlan.message);
  const weakCompiled = await compileProductionFinancier(weakPlan.plan, [
    weakCell,
  ]);
  if (!weakCompiled.ok) throw new Error(JSON.stringify(weakCompiled.error));
  const recoveryCommand = {
    kind: "recover-with-worker",
    commandId: "worker-recovery",
    task: "batch-A#0/native-1",
    resource: "human-1",
    location: "cool",
    storage: "rejected-tray-groups",
    handling: 5_000_000,
    evidence: "assumed",
    reports: [{ product: "financiers", destination: "rejected-financiers" }],
  };
  let failedSave = null;
  let recoverySave = null;
  let recoveryBaseline = null;
  let recoveryContinued = null;
  const recoverySaves = [];
  const recoveryStops = [];
  for (let leg = 0; leg < 6; leg++) {
    const opened = await api.openExecutionWorker(bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const source = leg === 0 ? null : leg <= 2 ? failedSave : recoverySave;
    const began = await worker.request({
      kind: "begin",
      bundle,
      cells: [weakCell],
      identity: {
        runId: "native-financier",
        executionId: `recovery-${leg}`,
        hostSession: `recovery-host-${leg}`,
        parent:
          source === null
            ? null
            : {
                snapshot: source.document.snapshot,
                execution: source.document.state.identity.executionId,
              },
      },
      origin:
        source === null
          ? { kind: "scenario", scenario: weakCompiled.value }
          : {
              kind: "snapshot",
              document: source.document,
              checkpoints: source.artifacts,
            },
    });
    if (began.kind !== "began") throw new Error(JSON.stringify(began));
    if (leg === 1 || leg === 2) {
      const admitted = await worker.request(recoveryCommand);
      if (admitted.receipt?.status !== "accepted")
        throw new Error(JSON.stringify(admitted));
      const assigned = await worker.request({ kind: "state" });
      let recovery = null;
      for (const task of assigned.run.tasks)
        if (task.id === recoveryCommand.task) recovery = task.recovery;
      if (recovery === null || recovery.arrivesAt <= recovery.startedAt)
        throw new Error(
          "The recovery worker must travel from the packing station",
        );
      if (leg === 1)
        recoveryStops.push(
          recovery.startedAt + 2_000,
          recovery.arrivesAt + 2_000_000,
          recovery.removesAt + 2_000_000,
        );
    }
    const until = leg >= 2 && leg <= 4 ? recoveryStops[leg - 2] : horizon;
    let reached = false;
    for (let calls = 0; calls < 2000; calls++) {
      const reply = await worker.request({ kind: "drive", turns: 128, until });
      if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
      if (
        reply.view.time >= until ||
        ["completed", "blocked"].includes(reply.view.status.kind)
      ) {
        reached = true;
        break;
      }
    }
    if (!reached) throw new Error("Worker recovery exceeded its call bound");
    const state = await worker.request({ kind: "state" });
    if (leg === 0) {
      failedSave = await worker.request({ kind: "save" });
      if (failedSave.kind !== "saved")
        throw new Error(JSON.stringify(failedSave));
    } else if (leg === 1) recoveryBaseline = state.run;
    else if (leg === 5) recoveryContinued = state.run;
    else {
      let transfer = null;
      let baker = null;
      for (const task of state.run.tasks)
        if (task.id === recoveryCommand.task) transfer = task;
      for (const resource of state.run.resources)
        if (resource.id === "human-1") baker = resource;
      if (
        transfer?.kind !== "recovering" ||
        transfer.recovery.phase !== (leg === 4 ? "returning" : "handling") ||
        baker?.position.kind !== (leg === 4 ? "idle" : "assigned")
      )
        throw new Error("Worker release and physical recovery phase disagree");
      const paused = await worker.request({
        kind: "pause",
        commandId: `recovery-pause-${leg - 2}`,
      });
      if (paused.receipt?.status !== "accepted")
        throw new Error(JSON.stringify(paused));
      recoverySave = await worker.request({ kind: "save" });
      if (recoverySave.kind !== "saved")
        throw new Error(JSON.stringify(recoverySave));
      recoverySaves.push(recoverySave);
    }
    worker.terminate();
  }
  const recoveryHistories = [];
  const recoveryWorlds = [];
  for (const run of [recoveryBaseline, recoveryContinued]) {
    const accepted = [];
    let rejected = 0;
    let resolved = false;
    for (const task of run.tasks)
      if (task.id === recoveryCommand.task) resolved = task.kind === "failed";
    for (const { sequence, execution, ...event } of run.events) {
      if (event.kind !== "command-admitted") accepted.push(event);
      if (
        event.kind === "quantity-reported" &&
        event.destination === "rejected-financiers"
      )
        rejected += event.quantity.amount;
    }
    if (
      !resolved ||
      rejected !== 24 ||
      run.cells[0].slot.kind !== "inactive" ||
      run.cells[0].attempt !== null
    )
      throw new Error(
        "Recovery did not reject one tray and release its physical cell",
      );
    recoveryHistories.push(canonicalJson(accepted));
    const { identity, events, commands, position, ...state } = run;
    recoveryWorlds.push(canonicalJson({ ...state, time: position.time }));
  }
  if (
    recoveryHistories[0] !== recoveryHistories[1] ||
    recoveryWorlds[0] !== recoveryWorlds[1]
  )
    throw new Error("Worker replacement changed the recovery outcome");
  return {
    result: "passed",
    bundle: bundle.id,
    scenario,
    baseline,
    continued,
    saves,
    stops,
    packed,
    simulatedSeconds: continued.position.time / 1_000_000,
    workerRecovery: {
      baseline: recoveryBaseline,
      continued: recoveryContinued,
      saves: recoverySaves,
      stops: recoveryStops,
    },
  };
}
