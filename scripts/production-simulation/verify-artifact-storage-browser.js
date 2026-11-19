async function verifyArtifactStorageBrowser(page) {
  const base = new URL(page.url()).searchParams.get("evidence");
  const fixture = await (
    await page.request.get(new URL(`${base}/fixture.json`, page.url()).href)
  ).json();
  globalThis.artifactExecutionDirectory = fixture.bundleDirectory;
  await page.route(
    `**/bakery-physics/executions/${fixture.manifest.bundle.id}/*`,
    serveArtifactExecution,
  );
  await page.addScriptTag({ content: injectedArtifactFailure.toString() });
  const connection = await page.context().newCDPSession(page);
  const first = await page.evaluate(runArtifactStorageStage, 0);
  await connection.send("HeapProfiler.collectGarbage");
  const pausedHeap = await connection.send("Runtime.getHeapUsage");
  const completed = await page.evaluate(runArtifactStorageStage, 1);
  await connection.send("HeapProfiler.collectGarbage");
  const completedHeap = await connection.send("Runtime.getHeapUsage");
  await page.screenshot({ path: "artifact-storage.png", fullPage: true });
  const pending = page.waitForEvent("download", { timeout: 120000 });
  await page.evaluate(downloadStoredRun);
  const archive = `${globalThis.bakeryEvidence}/recurring-run.json`;
  await (await pending).saveAs(archive);
  await connection.detach();
  for (const heap of [pausedHeap, completedHeap])
    if (heap.usedSize > 128 * 1024 * 1024)
      throw new Error(
        "The main page retained more than 128 MiB of JavaScript data",
      );
  return {
    result: "passed",
    first,
    completed,
    pausedHeap,
    completedHeap,
    archive: "recurring-run.json",
    memoryScope:
      "Main page after garbage collection; worker and browser process peaks remain separate gates",
  };
}

async function serveArtifactExecution(route) {
  const file = new URL(route.request().url()).pathname.split("/").at(-1);
  if (file !== "execution.json" && file !== "production-engine.mjs")
    throw new Error("Unexpected execution file");
  await route.fulfill({
    status: 200,
    contentType: file.endsWith(".mjs") ? "text/javascript" : "application/json",
    path: `${globalThis.artifactExecutionDirectory}/${file}`,
  });
}

async function injectedArtifactFailure(state, retain, digest, file) {
  if (!state.storageFailed) {
    state.storageFailed = true;
    state.failedDigest = digest;
    throw new Error("Injected local storage failure");
  }
  await retain(digest, file);
  if (digest === state.failedDigest) state.storageRetried = true;
}

async function runArtifactStorageStage(stage) {
  const { openExecutionWorker } =
    await import("/src/features/production-run/execution-client.ts");
  const { exportOvenSave, ovenCheckpointContents } =
    await import("/@id/@purin-labs/production-simulation/runs/oven-run-file");
  const { canonicalJson } = await import("/@id/@purin-labs/std");
  const base = new URL(location.href).searchParams.get("evidence");
  if (stage === 0) {
    const fixture = await (await fetch(`${base}/fixture.json`)).json();
    const source = `/@fs/${fixture.source}`;
    window.artifactJourney = {
      fixture,
      scenario: await (await fetch(`${source}/scenario.json`)).json(),
      cells: await (await fetch(`${source}/cells.json`)).json(),
      reference: await (
        await fetch(`${source}/reference/final-state.json`)
      ).json(),
      expected: await (await fetch(`${source}/reference/save-1.json`)).json(),
      files: new Map(),
      save: null,
      worker: null,
      storageFailed: false,
      storageRetried: false,
      started: performance.now(),
      maxArtifactBytes: 0,
      calls: 0,
    };
  }
  const state = window.artifactJourney;
  state.worker?.terminate();
  const opened = await openExecutionWorker(state.fixture.manifest.bundle);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const worker = opened.value;
  state.worker = worker;
  if (stage === 0)
    worker.artifacts.retain = injectedArtifactFailure.bind(
      null,
      state,
      worker.artifacts.retain.bind(worker.artifacts),
    );
  const previous = state.save;
  const began = await worker.request({
    kind: "begin",
    bundle: worker.manifest.bundle,
    cells: state.cells,
    identity: {
      runId: "recurring-logistics",
      executionId: `execution-${stage + 1}`,
      hostSession: `host-${stage + 1}`,
      parent:
        previous === null
          ? null
          : {
              snapshot: previous.document.snapshot,
              execution: previous.document.state.identity.executionId,
            },
    },
    origin:
      previous === null
        ? { kind: "scenario", scenario: state.scenario }
        : {
            kind: "snapshot",
            document: previous.document,
            checkpoints: await ovenCheckpointContents(previous),
          },
  });
  if (began.kind !== "began") throw new Error(JSON.stringify(began));
  const until = stage === 0 ? 700_000_000 : state.scenario.limits.horizon;
  for (;;) {
    let reply;
    try {
      reply = await worker.request({ kind: "drive", turns: 512, until });
    } catch (error) {
      if (
        !state.storageFailed ||
        state.storageRetried ||
        error.message !== "Injected local storage failure"
      )
        throw error;
      // The next request first retries the pending bytes, before further physics.
      const recovered = await worker.request({ kind: "state" });
      if (
        recovered.kind !== "state" ||
        !state.storageRetried ||
        !worker.artifacts.files.has(state.failedDigest)
      )
        throw new Error("Storage retry lost the pending artifact");
      continue;
    }
    if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
    state.calls++;
    document.body.dataset.simulatedTime = String(reply.view.time);
    if (reply.view.time >= until || reply.view.status.kind === "completed")
      break;
    if (reply.view.status.kind !== "awaiting-execution")
      throw new Error(JSON.stringify(reply.view));
  }
  if (stage === 0) {
    const pause = await worker.request({
      kind: "pause",
      commandId: "pause-700",
    });
    if (pause.kind !== "commanded" || pause.receipt.status !== "accepted")
      throw new Error(JSON.stringify(pause));
  }
  const saved = await worker.request({ kind: "save" });
  if (saved.kind !== "saved" || saved.artifacts.length !== 0)
    throw new Error("Save retained artifact strings");
  for (const [digest, file] of worker.artifacts.files) {
    if ("content" in file || !(file.file instanceof Blob))
      throw new Error("An artifact is not file backed");
    state.maxArtifactBytes = Math.max(state.maxArtifactBytes, file.byteLength);
    state.files.set(digest, file);
  }
  const E = await import(
    `/bakery-physics/executions/${worker.manifest.bundle.id}/production-engine.mjs`
  );
  const admitted = await E.openResumable(saved.document, "browser", [
    worker.manifest.bundle,
  ]);
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
  const artifacts = [];
  let storedBytes = 0;
  for (const entry of admitted.value.artifacts) {
    const file = state.files.get(entry.digest);
    if (file === undefined || file.byteLength !== entry.byteLength)
      throw new Error("Save references missing bytes");
    artifacts.push(file);
    storedBytes += file.byteLength;
  }
  state.save = { kind: "saved", document: admitted.value, artifacts };
  const pending = await worker.request({
    kind: "artifact",
    acknowledged: null,
  });
  if (pending.kind !== "artifact" || pending.artifact !== null)
    throw new Error("Worker retained unacknowledged bytes");
  const run = admitted.value.state;
  if (stage === 0) {
    let buffer = null;
    for (const storage of run.storages)
      if (storage.id === "intermediate-buffer") buffer = storage;
    let blocked = false;
    for (const task of run.tasks) {
      if (task.kind !== "waiting") continue;
      for (const blocker of task.blockers)
        if (
          blocker.kind === "destination" &&
          blocker.storage === "intermediate-buffer"
        )
          blocked = true;
    }
    if (buffer === null || buffer.occupants.length !== 1 || !blocked)
      throw new Error("The save must preserve buffer congestion");
    return {
      time: run.position.time,
      artifacts: artifacts.length,
      storedBytes,
      storageFailureRetried: state.storageRetried,
    };
  }
  const final = await worker.request({ kind: "state" });
  if (final.kind !== "state" || final.view.status.kind !== "completed")
    throw new Error("The factory did not drain");
  const histories = [];
  const worlds = [];
  for (const candidate of [state.reference, final.run]) {
    const events = [];
    for (const {
      sequence: _sequence,
      execution: _execution,
      ...event
    } of candidate.events)
      if (event.kind !== "command-admitted") events.push(event);
    histories.push(canonicalJson(events));
    const {
      identity: _identity,
      commands: _commands,
      events: _events,
      position,
      ...world
    } = candidate;
    worlds.push(canonicalJson({ ...world, time: position.time }));
  }
  if (histories[0] !== histories[1] || worlds[0] !== worlds[1])
    throw new Error(
      "Stored browser execution differs from the accepted headless world or history",
    );
  const terminal = [];
  for (const document of [state.expected, admitted.value]) {
    const checkpoints = [];
    for (const entry of document.artifacts)
      if (entry.role === "cell-checkpoint") checkpoints.push(entry);
    terminal.push(canonicalJson(checkpoints));
  }
  if (terminal[0] !== terminal[1])
    throw new Error("Terminal native checkpoints differ");
  const results = E.runResults(final.run, {
    after: null,
    through: final.run.position.time,
  });
  if (results.ordersCompleted !== 24)
    throw new Error("The run must complete all 24 orders");
  state.export = exportOvenSave(state.save);
  const summary = {
    snapshot: admitted.value.snapshot,
    bundle: admitted.value.bundle.id,
    completedOrders: results.ordersCompleted,
    simulatedSeconds: run.position.time / 1e6,
    artifacts: artifacts.length,
    storedBytes,
    exportBytes: state.export.size,
    maxArtifactBytes: state.maxArtifactBytes,
    milliseconds: performance.now() - state.started,
    driveCalls: state.calls,
    sameAcceptedEventsWorldAndCheckpoints: true,
    checkpointOnlyRestore: true,
  };
  document.body.textContent = JSON.stringify(summary, null, 2);
  return summary;
}

function downloadStoredRun() {
  const link = document.createElement("a");
  const url = URL.createObjectURL(window.artifactJourney.export);
  link.href = url;
  link.download = "recurring-run.json";
  link.click();
  URL.revokeObjectURL(url);
}
