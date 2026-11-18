async function verifyOvenEngineJourneyBrowser(page) {
  await page.waitForFunction(ovenEngineReady);
  return page.evaluate(ovenEngineBrowser);
}
function ovenEngineReady() {
  return "productionRunPreview" in window;
}
async function ovenEngineBrowser() {
  const { coldCellJourneyAdapter, coldCellJourneySnapshot } =
    await import("/@id/@seams/production-simulation/recipes/cold-cell-journey");
  const { canonicalJson } = await import("/@id/@seams/std");
  const api = window.productionRunPreview;
  const prepared = await api.openExecutionWorker(null);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const bundle = prepared.value.manifest.bundle;
  const defined = await prepared.value.request({
    kind: "define",
    cell: "cold-cell-1",
    fixture: "oven-rack",
    robot: "universal-robots-ur5e",
  });
  if (defined.kind !== "defined") throw new Error(JSON.stringify(defined));
  const refused = await prepared.value.request({
    kind: "define",
    cell: "cold-cell-1",
    robot: "unknown-robot",
  });
  if (refused.kind !== "refused")
    throw new Error("Invalid definition reused an earlier result");
  const cell = { ...defined.definition, runId: "oven-engine-cell" };
  prepared.value.terminate();
  const compiled = coldCellJourneyAdapter.compile(
    await coldCellJourneySnapshot(
      {
        horizonSeconds: 360,
        orders: 2,
        trays: ["tray-a", "tray-b"],
        cell: {
          id: cell.cellId,
          modelHash: cell.modelHash,
          controllerSourceHash: cell.execution.controllerSourceHash,
          timestepSeconds: cell.timestep,
          holdModel: null,
        },
        load: { pickupSeconds: 2, placementSeconds: 4, durationSeconds: 5 },
        unload: { pickupSeconds: 2, placementSeconds: 4, durationSeconds: 5 },
      },
      1,
    ),
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const scenario = structuredClone(compiled.value);
  const workflow = scenario.workflows[0];
  const [admission, transfer, removal] = workflow.tasks;
  const source = transfer.carriers[0].from;
  const rack = transfer.carriers[0].to;
  scenario.storages.push({
    id: "oven-slot",
    capacity: { kind: "carriers", slots: 1 },
    cell: cell.cellId,
  });
  scenario.resources.push({
    kind: "batch",
    id: "oven",
    capacity: 1,
    configuration: null,
    storage: "oven-slot",
    loadWindow: 0,
    programs: [{ id: "financier", duration: 5_000_000, evidence: "assumed" }],
  });
  scenario.resources.push({
    kind: "capacity",
    id: "retrieval-access",
    capacity: 1,
    configuration: null,
  });
  scenario.availability = [
    {
      id: "retrieval-blocked",
      resource: "retrieval-access",
      interval: { start: 0, end: 70_000_000 },
    },
  ];
  const native = [];
  for (const [key, skill, from, to, prerequisite] of [
    ["oven-load", "oven-loading", source, "oven-slot", admission.key],
    ["oven-retrieve", "oven-retrieval", "oven-slot", source, "oven-wait"],
    [transfer.key, "rack-transfer", source, rack, "oven-retrieve"],
  ])
    native.push({
      key,
      priority: 0,
      releaseAfter: 0,
      prerequisites: [prerequisite],
      claims: transfer.claims,
      executor: {
        kind: "native",
        operation: { cell: cell.cellId, skill, parameters: cell.modelHash },
      },
      inputs: [],
      outputs: [],
      releases: [],
      carriers: [
        {
          kind: "move",
          role: transfer.carriers[0].role,
          from,
          to,
          timing: { kind: "native" },
        },
      ],
    });
  const wait = {
    key: "oven-wait",
    priority: 0,
    releaseAfter: 0,
    prerequisites: ["oven-load"],
    claims: [],
    executor: {
      kind: "batch",
      resource: "oven",
      program: "financier",
      carrier: transfer.carriers[0].role,
      load: "oven-load",
      unload: "oven-retrieve",
    },
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [],
  };
  native[1].claims = [
    ...native[1].claims,
    { resource: "retrieval-access", units: 1, configuration: null },
  ];
  workflow.tasks = [admission, native[0], wait, native[1], native[2], removal];
  let baseline = null;
  let continued = null;
  let saved = null;
  const saves = [];
  const stops = [];
  for (let leg = 0; leg < 11; leg++) {
    const opened = await api.openExecutionWorker(bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    const began = await worker.request({
      kind: "begin",
      bundle,
      cells: [cell],
      identity: {
        runId: "oven-engine",
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
    const until =
      leg === 0 || leg === 10 ? scenario.limits.horizon : stops[leg - 1];
    let reached = false;
    for (let calls = 0; calls < 2000; calls++) {
      const reply = await worker.request({ kind: "drive", turns: 128, until });
      if (reply.kind !== "drove" || reply.view.status.kind === "blocked")
        throw new Error(JSON.stringify(reply));
      if (reply.view.time >= until || reply.view.status.kind === "completed") {
        reached = true;
        break;
      }
    }
    if (!reached)
      throw new Error("Oven browser journey exceeded its call bound");
    const state = await worker.request({ kind: "state" });
    if (leg === 0) {
      baseline = state.run;
      for (const task of baseline.tasks)
        if (
          task.kind === "completed" &&
          ["oven-load", "oven-wait", "oven-retrieve", transfer.key].includes(
            task.subject.key,
          )
        )
          stops.push(
            task.startedAt +
              (task.subject.key === "oven-wait" ? 2_000_000 : 10_000_000),
          );
      // Instances and their tasks are in execution order in this serial cell journey.
      if (stops.length !== 8)
        throw new Error("Expected six physical operations and two oven cycles");
      // Insert the first cycle's blocked retrieval after its processing pause.
      stops.splice(2, 0, 50_000_000);
    } else if (leg === 10) continued = state.run;
    else {
      const paused = await worker.request({
        kind: "pause",
        commandId: `pause-${leg - 1}`,
      });
      if (paused.receipt?.status !== "accepted")
        throw new Error(JSON.stringify(paused));
      saved = await worker.request({ kind: "save" });
      if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
      saves.push(saved);
    }
    worker.terminate();
  }
  const histories = [];
  const worlds = [];
  for (const run of [baseline, continued]) {
    if (run.status.kind !== "completed")
      throw new Error("Oven journey did not complete");
    const accepted = [];
    for (const { sequence, execution, ...event } of run.events)
      if (event.kind !== "command-admitted") accepted.push(event);
    histories.push(canonicalJson(accepted));
    const { identity, events, commands, position, ...state } = run;
    worlds.push(canonicalJson({ ...state, time: position.time }));
  }
  if (histories[0] !== histories[1] || worlds[0] !== worlds[1])
    throw new Error("Worker replacement changed the oven run");
  return {
    result: "passed",
    bundle: bundle.id,
    baseline,
    continued,
    stops,
    saves,
    seconds: continued.position.time / 1_000_000,
  };
}
