async function verifyOvenWorkspaceBrowser(page) {
  await exposeCheckout(page);
  globalThis.ovenRecipeArchive = new Map();
  globalThis.ovenRecipeLoseReply = true;
  await page.route(
    "**/v1/control/organisations/oven-ui-acceptance/bakery/runs**",
    recipeArchiveRequest,
  );
  const evidence = new URL(page.url()).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the full recipe evidence URL.");
  const fixture = await page.request.get(
    new URL(`${evidence}/shared-definition.json`, page.url()).href,
  );
  if (!fixture.ok()) throw new Error("The shared oven definition is missing.");
  const definition = await fixture.json();
  globalThis.ovenExecutionDirectory =
    decodeURIComponent(new URL(evidence, page.url()).pathname).replace(
      /^\/@fs\/+/u,
      "/",
    ) + `/executions/${definition.executionBundleId}`;
  await page.route(
    `**/bakery-physics/executions/${definition.executionBundleId}/*`,
    serveOvenRetainedExecution,
  );
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.reload();
  await installRecipeMutation(page, saveRecipeCopyWithArtifacts);
  await page.evaluate(mountConnectedOvenWorkspace, portalSimulationSource());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openOvenProduction(page);
  const recipe = await exerciseFinancierOperator(page);
  // Back to recipes reloads the production scene, which blocks the page.
  await waitForProductionScene(page);
  await page.evaluate(rememberOvenSurface);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles({
      name: "oven-route.json",
      mimeType: "application/json",
      buffer: await fixture.body(),
    });
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page.evaluate(checkOvenSurfaceSuspended);
  await page.waitForFunction(pressPauseWhen, ovenHasActiveTransfer.toString(), {
    timeout: 120000,
    polling: 50,
  });
  await page.waitForFunction(ovenPaused);
  const first = await saveOvenDownload(page, "first-pause");
  await page.waitForFunction(ovenLiveReady);
  const firstLive = await page.evaluate(checkLiveOvenPhysics, first);
  await page.screenshot({ path: "oven-live-loading.png", fullPage: true });
  await showFactoryTimeline(page);
  const firstLogistics = await page.evaluate(checkOvenLogistics, {
    path: first,
    phase: "loading",
  });
  await openFactoryHistory(page);
  const firstResources = await page.evaluate(checkResourceHistory, first);
  const firstStorage = await page.evaluate(checkStorageHistory, first);
  const firstScheduling = await page.evaluate(checkSchedulingHistory, first);
  const activePlayback = await inspectOvenPhysics(
    page,
    first,
    "batch-A#0/oven-load",
    "oven-physics-active.png",
  );
  await page
    .getByRole("button", { name: "Resume production run", exact: true })
    .click();
  await page.waitForFunction(
    pressPauseWhen,
    ovenPassedCoolingBlock.toString(),
    { timeout: 120000, polling: 50 },
  );
  await page.waitForFunction(ovenPaused);
  const second = await saveOvenDownload(page, "second-pause");
  const secondLive = await page.evaluate(checkLiveOvenPhysics, second);
  await showFactoryTimeline(page);
  const blockedLogistics = await page.evaluate(checkOvenLogistics, {
    path: second,
    phase: "blocked",
  });
  await openFactoryHistory(page);
  const blockedResources = await page.evaluate(checkResourceHistory, second);
  const blockedStorage = await page.evaluate(checkStorageHistory, second);
  const blockedScheduling = await page.evaluate(checkSchedulingHistory, second);
  await page
    .getByLabel("Resource state accounting", { exact: true })
    .screenshot({ path: "oven-resource-states.png" });
  await page.locator('[aria-label="Scheduling history"] summary').click();
  await page
    .locator('[data-wait-task="batch-B#0/transfer-bake-cool"]')
    .last()
    .getByRole("button")
    .click();
  // Selecting the task opens the Inspector; the waits are in History.
  await openFactoryHistory(page);
  await page
    .getByLabel("Accepted task wait intervals", { exact: true })
    .screenshot({ path: "oven-wait-history.png" });
  const waitSelection = await page
    .locator(
      '[aria-label="Scheduling history"] [data-wait-task="batch-B#0/transfer-bake-cool"]',
    )
    .last()
    .getByRole("button")
    .getAttribute("aria-pressed");
  if (waitSelection !== "true")
    throw new Error("Wait history did not select its task.");
  await page.screenshot({ path: "oven-logistics-queue.png", fullPage: true });
  await openFactoryPanel(page, "Logistics");
  await page.locator('[data-queue="cool"] a').click();
  if (
    (await page.locator("tr:target").getAttribute("data-task")) !==
    "batch-B#0/transfer-bake-cool"
  )
    throw new Error("The cooling queue did not select its waiting task.");
  const selection = await checkSharedTaskSelection(page);
  const completedPlayback = await inspectOvenPhysics(
    page,
    second,
    "batch-B#0/oven-retrieve",
    "oven-physics-retrieved.png",
  );
  await page.screenshot({ path: "oven-paused.png", fullPage: true });

  // A page reload destroys the original worker and all its in-memory worlds.
  await page.reload();
  await installRecipeMutation(page, saveRecipeCopyWithArtifacts);
  await page.evaluate(mountConnectedOvenWorkspace, portalSimulationSource());
  await openOvenProduction(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles(second);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page.waitForFunction(ovenCompleted, null, { timeout: 120000 });
  const final = await saveOvenDownload(page, "completed");
  await page.waitForFunction(ovenLiveReady);
  const finalLive = await page.evaluate(checkLiveOvenPhysics, final);
  if (finalLive.kind !== "current" || finalLive.purpose !== "idle")
    throw new Error(
      "The completed live view must display the current idle cell pose.",
    );
  await page.screenshot({
    path: "oven-live-completed-idle.png",
    fullPage: true,
  });
  await showFactoryTimeline(page);
  const finalLogistics = await page.evaluate(checkOvenLogistics, {
    path: final,
    phase: "completed",
  });
  await openFactoryHistory(page);
  const finalResources = await page.evaluate(checkResourceHistory, final);
  const finalStorage = await page.evaluate(checkStorageHistory, final);
  const finalScheduling = await page.evaluate(checkSchedulingHistory, final);
  const restoredPlayback = await inspectOvenPhysics(
    page,
    final,
    "batch-A#0/oven-load",
    "oven-physics-restored.png",
  );
  await page.screenshot({ path: "oven-completed.png", fullPage: true });
  const compared = await page.evaluate(compareOvenDownloads, {
    evidence,
    first,
    second,
    final,
  });
  const cellInspection = await inspectCellRecordings(page, final);
  const indexedRecordings = await page.evaluate(checkIndexedRecordingAccess, {
    first,
    second,
    final,
  });
  const liveBoundaries = await page.evaluate(
    checkLiveRecordingBoundaries,
    evidence,
  );
  await backToRecipes(page);
  await page.reload();
  await installRecipeMutation(page, saveRecipeCopyWithArtifacts);
  await page.evaluate(mountConnectedOvenWorkspace, portalSimulationSource());
  await openOvenProduction(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles(final);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page.waitForFunction(ovenCompleted);
  await page.waitForFunction(ovenLiveReady);
  const reopenedLive = await page.evaluate(checkLiveOvenPhysics, final);
  if (JSON.stringify(reopenedLive) !== JSON.stringify(finalLive))
    throw new Error("A completed save reopened with another live pose.");
  await page.screenshot({
    path: "oven-live-reopened-idle.png",
    fullPage: true,
  });
  await backToRecipes(page);
  // Back to recipes reloads the production scene, which blocks the page.
  await waitForProductionScene(page);
  await page.evaluate(rememberOvenSurface);
  const damagedPath = await downloadOvenFixture(page, "damaged-run", {
    url: `/@fs/${second}`,
    kind: "damaged",
  });
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles(damagedPath);
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "integrity check" })
    .waitFor();
  if (
    (await page
      .getByRole("region", { name: "Persistent production", exact: true })
      .count()) !== 0
  )
    throw new Error("A damaged save replaced the current workspace.");
  const failureResponse = await page.request.get(
    new URL(`${evidence}/failed-A.json`, page.url()).href,
  );
  const failure = await failureResponse.json();
  const failurePath = await downloadOvenFixture(page, "failed-oven-run", {
    url: new URL(`${evidence}/failed-A.json`, page.url()).href,
    kind: "failed",
  });
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles(failurePath);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "blocked" })
    .waitFor();
  await showFactoryWorkflow(page);
  await page.locator('[data-graph-task="batch-A#0/oven-load"]').click();
  await showFactoryTimeline(page);
  const failureTimeline = await page.evaluate(
    checkFailedOvenTimeline,
    failure.failed,
  );
  const failedPath = await saveOvenDownload(page, "failed-playback");
  await openFactoryHistory(page);
  const failedResources = await page.evaluate(checkResourceHistory, failedPath);
  const failedStorage = await page.evaluate(checkStorageHistory, failedPath);
  const failedScheduling = await page.evaluate(
    checkSchedulingHistory,
    failedPath,
  );
  const failedPlayback = await inspectOvenPhysics(
    page,
    failedPath,
    "batch-A#0/oven-load",
    "oven-physics-failure.png",
  );
  await page.screenshot({ path: "oven-failure.png", fullPage: true });
  return {
    result: "passed",
    ...compared,
    recipe,
    damagedArtifactRefused: true,
    finiteSurfaceSuspended: true,
    livePhysics: {
      loading: firstLive,
      blocked: secondLive,
      restored: finalLive,
      reopened: reopenedLive,
      boundaries: liveBoundaries,
      inspection: cellInspection,
      indexedRecordings,
    },
    logistics: {
      first: firstLogistics,
      blocked: blockedLogistics,
      final: finalLogistics,
      queueTaskNavigation: true,
      selection,
      failureTimeline,
      failedResources,
      schedulingHistory: {
        first: firstScheduling,
        blocked: blockedScheduling,
        final: finalScheduling,
        failed: failedScheduling,
      },
      storageHistory: {
        first: firstStorage,
        blocked: blockedStorage,
        final: finalStorage,
        failed: failedStorage,
      },
      resourceHistory: {
        first: firstResources,
        blocked: blockedResources,
        final: finalResources,
      },
      playback: {
        active: activePlayback,
        completed: completedPlayback,
        restored: restoredPlayback,
        failed: failedPlayback,
      },
    },
    downloads: [first, second, final],
  };
}

// Serve the fixture's exact retained build without changing the Portal's pin.
async function serveOvenRetainedExecution(route) {
  const file = new URL(route.request().url()).pathname.split("/").at(-1);
  if (file !== "execution.json" && file !== "production-engine.mjs")
    throw new Error("The oven fixture requested an unexpected execution file.");
  await route.fulfill({
    status: 200,
    contentType:
      file === "execution.json" ? "application/json" : "application/javascript",
    path: `${globalThis.ovenExecutionDirectory}/${file}`,
  });
}

function ovenLiveReady() {
  const scene = document.querySelector('[aria-label="Live accepted physics"]')
    ?.dataset.scene;
  return scene === "ready" || scene === "unavailable";
}

async function checkLiveOvenPhysics(path) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const section = document.querySelector(
    '[aria-label="Live accepted physics"]',
  );
  if (section === null) throw new Error("The accepted live scene is missing.");
  const task = section.dataset.physicsTask;
  const purpose = section.dataset.purpose;
  const { nativeIdentity } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/native/cell-adapter.ts`
  );
  let attempt = null;
  let startedAt = 0;
  for (const event of saved.document.state.events) {
    if (
      (event.kind === "task-started" || event.kind === "recovery-started") &&
      event.task === task &&
      event.attempt !== null
    ) {
      attempt = nativeIdentity(event.attempt);
      startedAt = event.time;
    }
  }
  let expected = null;
  let at = 0;
  for (const artifact of saved.artifacts) {
    const newline = artifact.content.indexOf("\n");
    if (newline < 0) continue;
    const pack = JSON.parse(artifact.content.slice(0, newline));
    if (pack.kind !== "recording-pack") continue;
    const { readRecordingPack } =
      await import("/@id/@purin-labs/production-simulation");
    const decoded = readRecordingPack(artifact.content);
    if (!decoded.ok) throw new Error("Invalid recording pack");
    for (const record of decoded.value.records) {
      const raw = JSON.parse(
        decoded.value.body.slice(
          record.offset,
          record.offset + record.byteLength,
        ),
      );
      if (raw.kind === "accepted-cell-recording" && raw.time.kind === purpose) {
        const motion = JSON.parse(raw.native).motion;
        expected = purpose === "idle" ? motion.samples.at(-1) : motion.after;
        at = purpose === "idle" ? raw.time.through : raw.time.at;
      } else if (raw.attemptId === attempt) {
        expected = raw.samples.at(-1);
        at = startedAt + expected.step * 2000;
      }
    }
  }
  if (expected === null)
    throw new Error("Live pose has no retained solver sample.");
  const actual = JSON.parse(
    section.querySelector('[aria-label="Exact physics sample"]').textContent,
  );
  for (const key of ["step", "joints", "tool", "jaw", "tray"])
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      throw new Error(`Live ${key} differs from its saved solver sample.`);
  if (
    Number(section.dataset.time) !== at ||
    at > saved.document.state.position.time
  )
    throw new Error("Live pose crossed its committed boundary.");
  const gap = at < saved.document.state.position.time;
  if (section.dataset.observation !== (gap ? "gap" : "current"))
    throw new Error("The live view concealed a recording gap.");
  if (
    gap &&
    !section.textContent.includes(
      "The live view holds the last accepted sample",
    )
  )
    throw new Error("The held operation sample has no explanation.");
  const webgl = document.createElement("canvas").getContext("webgl2") !== null;
  if (section.dataset.scene !== (webgl ? "ready" : "unavailable"))
    throw new Error(
      "The live renderer did not reach its expected presentation.",
    );
  return {
    task,
    purpose,
    at,
    step: expected.step,
    kind: gap ? "gap" : "current",
    exactSample: true,
    scene: section.dataset.scene,
  };
}

async function checkLiveRecordingBoundaries(evidence) {
  const records = await (
    await fetch(`${evidence}/live-observations.json`)
  ).json();
  const { readPhysicsView } = await import("/@id/@purin-labs/production-simulation");
  const { parsePersistentCell } = await import(
    `/@fs${window.pantryCheckout}/packages/bakery-model/src/bakery-physics.ts`
  );
  const { readOvenScene, readOvenLiveFrame, ovenFrameMotion, ovenSampleTime } =
    await import(
      `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-live-physics.ts`
    );
  const { PhysicsModel, disposePhysicsObject, samplePhysics } =
    await import("/src/features/workflow-simulator/spatial/physics-model.ts");
  const { ROBOTS } = await import(
    `/@fs${window.pantryCheckout}/packages/bakery-model/src/bakery-robots.ts`
  );
  const scenes = new Map();
  let model = null;
  let previousScene = null;
  let recoveries = 0;
  let idle = 0;
  let handoffs = 0;
  for (const record of records) {
    const cell = parsePersistentCell(record.cellDefinition);
    if (cell === null) throw new Error("Missing live acceptance cell.");
    const key = JSON.stringify(record.cellDefinition);
    let scene = scenes.get(key);
    if (scene === undefined) {
      const setup = await (
        await fetch(
          `/@fs${window.pantryCheckout}/assets/bakery-mujoco/fr10-workcell/native/${cell.robot}/combined-nominal.json`,
        )
      ).json();
      scene = readOvenScene(cell, {
        kind: "scene",
        version: 1,
        cell: cell.cellId,
        modelHash: cell.modelHash,
        setup,
        robotGlbSha256: ROBOTS[cell.robot].glbSha256,
      });
      scenes.set(key, scene);
    }
    const observation = readPhysicsView(record.observation, record.committedAt);
    if (observation.kind === "unavailable")
      throw new Error("Missing accepted observation.");
    const frame = await readOvenLiveFrame(
      scene,
      observation,
      record.committedAt,
    );
    if (frame.purpose === "recovery") recoveries++;
    const raw = JSON.parse(observation.content);
    const cellRecord =
      observation.kind === "cell-recorded"
        ? JSON.parse(raw.native).motion
        : null;
    const endpoints =
      frame.purpose === "admission" || frame.purpose === "removal"
        ? ["before", "after"]
        : ["after"];
    if (frame.purpose === "idle") idle++;
    if (endpoints.length === 2) handoffs++;
    for (const endpoint of endpoints) {
      const motion = ovenFrameMotion(frame, endpoint);
      if (previousScene !== scene) {
        model?.root.traverse(disposePhysicsObject);
        model = new PhysicsModel(motion);
        previousScene = scene;
      } else model.setPersistentMotion(motion);
      const samples =
        cellRecord === null
          ? raw.samples
          : cellRecord.kind === "idle"
            ? cellRecord.samples
            : [cellRecord[endpoint]];
      const first = samplePhysics(motion, 0);
      for (const key of ["step", "joints", "tool", "jaw", "tray"])
        if (JSON.stringify(first[key]) !== JSON.stringify(samples[0][key]))
          throw new Error(
            "A partial live segment extrapolated before its first sample.",
          );
      const expected = samples.at(-1);
      if (ovenSampleTime(frame, motion.samples.at(-1)) !== frame.at)
        throw new Error("The observation uses another factory clock.");
      if (endpoints.length === 2 && motion.samples.length !== 1)
        throw new Error("A handoff became a continuous trajectory.");
      model.update(expected.step * cell.timestep);
      for (const body of ["tool", "jaw", "tray"]) {
        const pose = [
          ...model[body].position.toArray(),
          model[body].quaternion.w,
          model[body].quaternion.x,
          model[body].quaternion.y,
          model[body].quaternion.z,
        ];
        if (JSON.stringify(pose) !== JSON.stringify(expected[body]))
          throw new Error(
            `Live ${body} pose changed across a recorded boundary.`,
          );
      }
    }
    let refused = false;
    try {
      await readOvenLiveFrame(
        scene,
        { ...observation, content: observation.content + " " },
        record.committedAt,
      );
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("An edited live recording was accepted.");
  }
  model?.root.traverse(disposePhysicsObject);
  if (records.length !== 13 || recoveries !== 2 || idle !== 1 || handoffs !== 4)
    throw new Error("Live operation and recovery coverage is incomplete.");
  return {
    operations: 6,
    recoveries,
    idle,
    handoffs,
    exactTransforms: true,
    editedRecordRefused: true,
  };
}

function checkFailedOvenTimeline(run) {
  let failed = null;
  for (const task of run.tasks)
    if (task.id === "batch-A#0/oven-load") failed = task;
  if (failed?.kind !== "recovery-required")
    throw new Error("Missing failed load fixture.");
  const track = document.querySelector(
    '[data-timeline-task="batch-A#0/oven-load"]',
  );
  if (track?.dataset.kind !== "recovery-required")
    throw new Error("Failure state is missing.");
  const execution = track.querySelector('[data-phase="execution"]');
  const recovery = track.querySelector('[data-phase="unresolved"]');
  if (
    Number(execution?.dataset.start) !== failed.startedAt ||
    Number(execution?.dataset.end) !== failed.failedAt ||
    Number(recovery?.dataset.start) !== failed.failedAt ||
    Number(recovery?.dataset.end) !== run.position.time
  )
    throw new Error(
      "The failure display continued the execution interval past failure.",
    );
  return { executionEndsAtFailure: true, unresolvedTimeShownSeparately: true };
}

async function checkOvenLogistics({ path, phase }) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const run = saved.document.state;
  const region = document.querySelector('[aria-label="Committed logistics"]');
  if (region === null) throw new Error("The worker did not expose logistics.");
  for (const task of run.tasks) {
    const row = region.querySelector(`[data-task="${CSS.escape(task.id)}"]`);
    if (row?.dataset.kind !== task.kind)
      throw new Error(`Task ${task.id} differs from its committed save.`);
  }
  // The workflow graph and the timeline are separate task views now.
  const views = [
    ...document.querySelectorAll('[aria-label="Persistent task views"]'),
  ];
  if (
    views.length < 2 ||
    views.some((view) => Number(view.dataset.time) !== run.position.time)
  )
    throw new Error("The visual clock differs from the saved boundary.");
  const inViews = (selector) =>
    views.map((view) => view.querySelector(selector)).find(Boolean) ?? null;
  for (const task of run.tasks) {
    const card = inViews(`[data-graph-task="${CSS.escape(task.id)}"]`);
    const track = inViews(`[data-timeline-task="${CSS.escape(task.id)}"]`);
    if (card?.dataset.kind !== task.kind || track?.dataset.kind !== task.kind)
      throw new Error(`Visual state differs for ${task.id}.`);
    const span = track.querySelector("[data-phase]");
    const start = task.kind === "waiting" ? task.since : task.startedAt;
    const end =
      task.kind === "completed" ? task.completedAt : run.position.time;
    if (
      Number(span?.dataset.start) !== start ||
      Number(span?.dataset.end) !== end
    )
      throw new Error(`Visual interval differs for ${task.id}.`);
    if (Number(span.dataset.end) > run.position.time)
      throw new Error("The timeline displayed uncommitted time.");
  }
  if (
    inViews(
      '[data-prerequisite="batch-A#0/portion"][data-dependent="batch-B#0/stage"]',
    ) === null
  )
    throw new Error("The cross-batch graph dependency is missing.");
  if (phase === "loading") {
    let operation = null;
    for (const task of run.tasks)
      if (task.kind === "executing" && task.id.endsWith("/oven-load"))
        operation = task;
    if (operation === null) throw new Error("Expected an executing oven load.");
    const row = region.querySelector(
      `[data-task="${CSS.escape(operation.id)}"]`,
    );
    if (!row?.textContent.includes("end awaits physics"))
      throw new Error("Native work displayed an invented completion time.");
    const destination = region.querySelector('[data-storage="bake"]');
    if (!destination?.textContent.includes("tray-group-A"))
      throw new Error("The load destination reservation is missing.");
  }
  if (phase === "blocked") {
    const queue = region.querySelector('[data-queue="cool"]');
    if (
      queue?.textContent.includes("1 task") !== true ||
      !queue.textContent.includes("batch-B#0/transfer-bake-cool")
    )
      throw new Error("The cooling capacity queue is missing.");
    const waiting = region.querySelector(
      `[data-task="${CSS.escape("batch-B#0/transfer-bake-cool")}"]`,
    );
    if (
      !waiting?.textContent.includes("Destination cool: capacity unavailable")
    )
      throw new Error("The blocked transfer has no capacity explanation.");
    for (const [store, carrier] of [
      ["cool", "tray-group-A"],
      ["oven-rack", "tray-group-B"],
    ]) {
      const storage = region.querySelector(`[data-storage="${store}"]`);
      if (!storage?.textContent.includes(carrier))
        throw new Error(`The carrier in ${store} is missing.`);
    }
  }
  if (
    phase === "completed" &&
    region.querySelectorAll("[data-queue]").length !== 0
  )
    throw new Error("Completed production retained a waiting queue.");
  return {
    time: run.position.time,
    tasks: run.tasks.length,
    queues: region.querySelectorAll("[data-queue]").length,
  };
}

async function checkResourceHistory(path) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const run = saved.document.state;
  const engine = await import(
    `/bakery-physics/executions/${saved.document.bundle.id}/production-engine.mjs`
  );
  const expected = engine.runResults(run, {
    after: null,
    through: run.position.time,
  }).resources;
  const region = document.querySelector('[aria-label="Resource history"]');
  if (Number(region?.dataset.time) !== run.position.time)
    throw new Error("Resource history differs from the committed clock.");
  let intervals = 0;
  for (const resource of expected) {
    const row = region.querySelector(
      `[data-resource-usage="${CSS.escape(resource.resource)}"]`,
    );
    for (const metric of row.querySelectorAll("[data-metric]"))
      if (Number(metric.dataset.value) !== resource[metric.dataset.metric])
        throw new Error(
          `Resource total differs: ${resource.resource}/${metric.dataset.metric}`,
        );
    const details = region.querySelector(
      `[data-resource-history="${CSS.escape(resource.resource)}"]`,
    );
    const displayed = details.querySelectorAll("[data-claim-task]");
    if (displayed.length !== resource.intervals.length)
      throw new Error("Resource history lost a released claim.");
    for (let index = 0; index < displayed.length; index++) {
      const actual = displayed[index].dataset;
      const span = resource.intervals[index];
      if (
        actual.claimTask !== span.task ||
        actual.kind !== span.kind ||
        Number(actual.start) !== span.start ||
        Number(actual.end) !== span.end ||
        Number(actual.units) !== span.units ||
        actual.ongoing !== String(span.ongoing)
      )
        throw new Error("Resource interval differs from its retained engine.");
      if (span.end > run.position.time)
        throw new Error("Resource history includes future time.");
      intervals++;
    }
  }
  return {
    time: run.position.time,
    resources: expected.length,
    intervals,
    exactTotals: true,
  };
}

async function checkStorageHistory(path) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const run = saved.document.state;
  const engine = await import(
    `/bakery-physics/executions/${saved.document.bundle.id}/production-engine.mjs`
  );
  const expected = engine.runResults(run, {
    after: null,
    through: run.position.time,
  }).storageHistory;
  if (expected.kind !== "available")
    throw new Error("The new run must expose carrier storage history.");
  const region = document.querySelector(
    '[aria-label="Carrier storage history"]',
  );
  if (Number(region?.dataset.time) !== run.position.time)
    throw new Error("Storage history differs from committed time.");
  let intervals = 0;
  for (const storage of expected.storages) {
    const row = region.querySelector(
      `[data-storage-usage="${CSS.escape(storage.storage)}"]`,
    );
    for (const metric of row.querySelectorAll("[data-metric]"))
      if (Number(metric.dataset.value) !== storage[metric.dataset.metric])
        throw new Error(
          `Storage total differs: ${storage.storage}/${metric.dataset.metric}`,
        );
    const details = region.querySelector(
      `[data-storage-history="${CSS.escape(storage.storage)}"]`,
    );
    const displayed = details.querySelectorAll("[data-storage-start]");
    if (displayed.length !== storage.intervals.length)
      throw new Error("Storage history lost an accepted interval.");
    for (let index = 0; index < displayed.length; index++) {
      const actual = displayed[index].dataset;
      const span = storage.intervals[index];
      if (
        Number(actual.storageStart) !== span.start ||
        Number(actual.end) !== span.end ||
        actual.ongoing !== String(span.ongoing) ||
        actual.occupants !== JSON.stringify(span.occupants) ||
        actual.reservations !== JSON.stringify(span.reservations)
      )
        throw new Error("Storage interval differs from its retained engine.");
      if (span.end > run.position.time)
        throw new Error("Storage history includes future time.");
      intervals++;
    }
  }
  return {
    time: run.position.time,
    storages: expected.storages.length,
    intervals,
    exactTotals: true,
  };
}

// The stubbed preview module would turn on the evidence views; the mount
// does it on the Portal's own module instance.
async function mountConnectedOvenWorkspace(simulationSource) {
  const { showPhysicsEvidence } = await import(
    `${simulationSource}/runs/physics-evidence.ts`
  );
  showPhysicsEvidence();
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: WorkflowSimulatorRoute } =
    await import("/src/features/workflow-simulator/route.tsx");
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkflowSimulatorRoute, {
        connection: {
          kind: "workspace",
          organisationId: "oven-ui-acceptance",
          canManage: true,
          mutate: window.saveRecipeCopy,
        },
      }),
    ),
  );
}

async function rememberOvenSurface() {
  const { bakerySurfaceForOrganisation } =
    await import("/src/features/bakery-surface-registry.ts");
  const surface = bakerySurfaceForOrganisation("oven-ui-acceptance");
  if (surface === null)
    throw new Error("The finite workspace surface was not restored.");
  window.ovenSurfaceBefore = surface;
}

async function checkOvenSurfaceSuspended() {
  const { bakerySurfaceForOrganisation } =
    await import("/src/features/bakery-surface-registry.ts");
  if (bakerySurfaceForOrganisation("oven-ui-acceptance") !== null)
    throw new Error(
      "The hidden finite run is still exposed to agent controls.",
    );
  let refused = false;
  try {
    await window.ovenSurfaceBefore.capture();
  } catch {
    refused = true;
  }
  if (!refused)
    throw new Error(
      "A stale surface reference captured the hidden finite run.",
    );
}

async function financierRecipeFile(simulationSource) {
  const { financierRecipeInput } = await import(
    `${simulationSource}/recipes/bakery/financier.ts`
  );
  return JSON.stringify({
    kind: "financier-recipe",
    recipe: financierRecipeInput(3, 1, 15 * 60),
  });
}

async function openOvenProduction(page) {
  await openMultiBatchProduction(page);
  await showProductionCatalog(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .waitFor();
}

async function saveOvenDownload(page, name) {
  const pending = downloadFactorySave(page);
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await (await pending).saveAs(path);
  return path;
}

async function downloadOvenFixture(page, name, input) {
  const pending = page.waitForEvent("download");
  await page.evaluate(prepareOvenFixtureDownload, input);
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await (await pending).saveAs(path);
  return path;
}

async function prepareOvenFixtureDownload(input) {
  const raw = await (await fetch(input.url)).json();
  const saved = input.kind === "failed" ? raw.saved : raw;
  if (input.kind === "damaged") saved.artifacts[0].content += " ";
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(saved)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "oven-fixture.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function ovenHasActiveTransfer() {
  const region = document.querySelector('[aria-label="Persistent production"]');
  return (
    region !== null &&
    region.querySelector('[data-task$="/oven-load"][data-kind="executing"]') !==
      null &&
    region.dataset.lifecycle === "running"
  );
}
function ovenPaused() {
  return (
    document.querySelector('[aria-label="Execution status"]')?.textContent ===
    "paused"
  );
}
// The run loop and the 3D view share the page thread, so the run can pass a
// short state between two Playwright actions. The person's Pause press
// happens in the same page task that sees the state.
function pressPauseWhen(conditionSource) {
  if (!new Function(`return (${conditionSource})();`)()) return false;
  const pause = [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "Pause production run",
  );
  if (pause === undefined || pause.disabled) return false;
  pause.click();
  return true;
}
function ovenPassedCoolingBlock() {
  return (
    Number(
      document.querySelector('[aria-label="Simulation seconds"]')?.textContent,
    ) >= 600
  );
}
function ovenCompleted() {
  return (
    document.querySelector('[aria-label="Execution status"]')?.textContent ===
    "completed"
  );
}

async function compareOvenDownloads(paths) {
  const { canonicalJson } = await import("/@id/@purin-labs/std");
  const baseline = await (
    await fetch(`${paths.evidence}/baseline.json`)
  ).json();
  const saves = [];
  for (const path of [paths.first, paths.second, paths.final])
    saves.push(await (await fetch(`/@fs/${path}`)).json());
  const final = saves[2].document.state;
  const histories = [];
  const worlds = [];
  for (const run of [baseline, final]) {
    const events = [];
    for (const { sequence, execution, ...event } of run.events)
      if (event.kind !== "command-admitted") events.push(event);
    histories.push(canonicalJson(events));
    const { identity, events: history, commands, position, ...world } = run;
    worlds.push(canonicalJson({ time: position.time, world }));
  }
  if (histories[0] !== histories[1] || worlds[0] !== worlds[1])
    throw new Error(
      "The UI save/reopen journey differs from the uninterrupted recipe.",
    );
  const artifactCounts = [];
  for (const save of saves) {
    artifactCounts.push(save.artifacts.length);
    for (const entry of save.document.artifacts) {
      let matches = 0;
      for (const artifact of save.artifacts)
        if (artifact.digest === entry.digest) matches++;
      if (matches !== 1)
        throw new Error("An exported artifact is missing or duplicated.");
    }
  }
  return {
    simulatedSeconds: final.position.time / 1_000_000,
    exactHistory: true,
    exactWorld: true,
    artifactCounts,
    execution: final.identity.executionId,
  };
}

async function checkSharedTaskSelection(page) {
  const time = await page
    .getByLabel("Simulation seconds", { exact: true })
    .textContent();
  const blocked = "batch-B#0/transfer-bake-cool";
  await page.evaluate(assertSharedTaskSelection, blocked);
  const graphTask = "batch-A#0/portion";
  await showFactoryWorkflow(page);
  await page.locator(`[data-graph-task="${graphTask}"]`).click();
  await page.evaluate(assertSharedTaskSelection, graphTask);
  const timelineTask = "batch-B#0/oven-load";
  await showFactoryTimeline(page);
  const button = page.locator(
    `[data-timeline-task="${timelineTask}"] > button`,
  );
  await button.focus();
  await page.keyboard.press("Enter");
  await page.evaluate(assertSharedTaskSelection, timelineTask);
  // A selection opens the Inspector; the histories are in History.
  await openFactoryHistory(page);
  const ovenHistory = page.locator('[data-resource-history="oven"]');
  await ovenHistory.locator("summary").click();
  const resourceTask = "batch-A#0/bake";
  await ovenHistory
    .locator(`[data-claim-task="${resourceTask}"] button`)
    .click();
  await page.evaluate(assertSharedTaskSelection, resourceTask);
  await openFactoryHistory(page);
  await page
    .getByRole("region", { name: "Resource history", exact: true })
    .screenshot({ path: "oven-resource-history.png" });
  const storageHistory = page.locator('[data-storage-history="cool"]');
  await storageHistory.locator("summary").click();
  const storageTask = "batch-A#0/transfer-bake-cool";
  await storageHistory
    .getByRole("button", { name: `tray-group-A · ${storageTask}`, exact: true })
    .click();
  await page.evaluate(assertSharedTaskSelection, storageTask);
  await openFactoryHistory(page);
  await page
    .getByLabel("Carrier storage accounting", { exact: true })
    .screenshot({ path: "oven-storage-history.png" });
  await storageHistory.screenshot({ path: "oven-storage-cooling-history.png" });
  await showFactoryWorkflow(page);
  await page.locator(`[data-graph-task="${blocked}"]`).click();
  await page.evaluate(assertSharedTaskSelection, blocked);
  const currentTime = await page
    .getByLabel("Simulation seconds", { exact: true })
    .textContent();
  if (currentTime !== time) throw new Error("Inspection advanced execution.");
  return {
    queue: true,
    graph: true,
    timelineKeyboard: true,
    resourceHistory: true,
    storageHistory: true,
    timeUnchanged: true,
  };
}

function assertSharedTaskSelection(task) {
  for (const selector of [
    `[data-graph-task="${CSS.escape(task)}"]`,
    `[data-timeline-task="${CSS.escape(task)}"] > button`,
  ])
    if (
      document.querySelector(selector)?.getAttribute("aria-pressed") !== "true"
    )
      throw new Error(`Selection differs in ${selector}.`);
  if (
    document.querySelector(`[data-task="${CSS.escape(task)}"]`)?.dataset
      .selected !== "true"
  )
    throw new Error("Task table selection differs.");
  if (
    document.querySelector('[aria-label="Selected oven task"]')?.dataset
      .selectedTask !== task
  )
    throw new Error("Task inspector selection differs.");
}

async function inspectOvenPhysics(page, path, task, screenshot) {
  const time = await page
    .getByLabel("Simulation seconds", { exact: true })
    .textContent();
  await showFactoryWorkflow(page);
  await page.locator(`[data-graph-task="${task}"]`).click();
  await openPhysicsDetails(page);
  await page
    .getByRole("button", { name: "Inspect selected physics", exact: true })
    .click();
  await page.waitForFunction(ovenPhysicsReady, null, { timeout: 120000 });
  const start = await page.evaluate(checkOvenPhysicsSample, {
    path,
    task,
    endpoint: "first",
  });
  const slider = page.getByLabel("Recorded physics sample", { exact: true });
  await slider.focus();
  await page.keyboard.press("End");
  const end = await page.evaluate(checkOvenPhysicsSample, {
    path,
    task,
    endpoint: "last",
  });
  if (
    (await page
      .getByLabel("Simulation seconds", { exact: true })
      .textContent()) !== time
  )
    throw new Error("Physics inspection advanced the simulation.");
  await page
    .getByRole("region", { name: "Accepted physics inspection", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot, fullPage: true });
  return {
    task,
    firstStep: start.step,
    lastStep: end.step,
    exactSamples: true,
    simulationUnchanged: true,
    scene: end.scene,
  };
}

function ovenPhysicsReady() {
  const scene = document.querySelector(
    '[aria-label="Accepted physics inspection"]',
  )?.dataset.scene;
  return scene === "ready" || scene === "unavailable";
}

async function checkOvenPhysicsSample({ path, task, endpoint }) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const { nativeIdentity } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/native/cell-adapter.ts`
  );
  let native = null;
  let startedAt = 0;
  for (const event of saved.document.state.events) {
    if (
      event.kind === "task-started" &&
      event.task === task &&
      event.attempt !== null
    ) {
      native = nativeIdentity(event.attempt);
      startedAt = event.time;
    }
  }
  const samples = [];
  for (const artifact of saved.artifacts) {
    const newline = artifact.content.indexOf("\n");
    if (newline < 0) continue;
    const header = JSON.parse(artifact.content.slice(0, newline));
    if (header.kind !== "recording-pack") continue;
    const { readRecordingPack } =
      await import("/@id/@purin-labs/production-simulation");
    const decoded = readRecordingPack(artifact.content);
    if (!decoded.ok) throw new Error("Invalid recording pack");
    for (const item of decoded.value.records) {
      const raw = JSON.parse(
        decoded.value.body.slice(item.offset, item.offset + item.byteLength),
      );
      if (raw.attemptId === native) samples.push(...raw.samples);
    }
  }
  const expected = endpoint === "first" ? samples[0] : samples.at(-1);
  const section = document.querySelector(
    '[aria-label="Accepted physics inspection"]',
  );
  const actual = JSON.parse(
    section.querySelector('[aria-label="Exact physics sample"]').textContent,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // The boundary parser changes property order only.
    for (const key of ["step", "joints", "tool", "jaw", "tray"])
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
        throw new Error(
          `The inspected ${key} differs from its recorded sample.`,
        );
  }
  if (
    Number(section.dataset.time) !== startedAt + expected.step * 2000 ||
    Number(section.dataset.time) > saved.document.state.position.time
  )
    throw new Error("Inspection crossed its committed boundary.");
  const webgl = document.createElement("canvas").getContext("webgl2") !== null;
  if (webgl && section.dataset.scene !== "ready")
    throw new Error("The persistent scene did not load in WebGL.");
  if (!webgl && section.dataset.scene !== "unavailable")
    throw new Error("Expected the floor-plan fallback.");
  if (!webgl) {
    const drawing = section.querySelector(".spatial-plan-drawing");
    if (drawing === null || drawing.getBoundingClientRect().height < 200)
      throw new Error("The fallback floor plan has no usable drawing area.");
  }
  if (endpoint === "last") {
    const { readOvenSave } = await import(
      `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-run-file.ts`
    );
    const { OvenRecordings, ovenRecordingArchive } = await import(
      `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-recordings.ts`
    );
    const { readOvenScene } = await import(
      `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-live-physics.ts`
    );
    const { PhysicsModel, disposePhysicsObject, samplePhysics } =
      await import("/src/features/workflow-simulator/spatial/physics-model.ts");
    const { ROBOTS } = await import(
      `/@fs${window.pantryCheckout}/packages/bakery-model/src/bakery-robots.ts`
    );
    const checked = await readOvenSave(saved, new Map());
    if (!checked.ok) throw new Error(checked.error);
    const cell = checked.value.cells[0];
    const setup = await (
      await fetch(
        `/@fs${window.pantryCheckout}/assets/bakery-mujoco/fr10-workcell/native/${cell.robot}/combined-nominal.json`,
      )
    ).json();
    const scene = {
      kind: "scene",
      version: 1,
      cell: cell.cellId,
      modelHash: cell.modelHash,
      setup,
      robotGlbSha256: ROBOTS[cell.robot].glbSha256,
    };
    const recordings = new OvenRecordings();
    const playback = await recordings.operation(
      ovenRecordingArchive(checked.value.save),
      readOvenScene(cell, scene),
      task,
    );
    const seconds = expected.step * cell.timestep;
    const sampled = samplePhysics(playback.motion, seconds);
    for (const key of ["step", "joints", "tool", "jaw", "tray"])
      if (JSON.stringify(sampled[key]) !== JSON.stringify(expected[key]))
        throw new Error(`The renderer interpolated an exact ${key} sample.`);
    const model = new PhysicsModel(playback.motion);
    model.update(seconds);
    for (const body of ["tool", "jaw", "tray"]) {
      const pose = [
        ...model[body].position.toArray(),
        model[body].quaternion.w,
        model[body].quaternion.x,
        model[body].quaternion.y,
        model[body].quaternion.z,
      ];
      if (JSON.stringify(pose) !== JSON.stringify(expected[body]))
        throw new Error(
          `Rendered ${body} transform differs from its solver sample.`,
        );
    }
    model.root.traverse(disposePhysicsObject);
    let refusedVisual = false;
    try {
      await recordings.operation(
        ovenRecordingArchive(checked.value.save),
        readOvenScene(cell, {
          ...scene,
          robotGlbSha256: "0".repeat(64),
        }),
        task,
      );
    } catch {
      refusedVisual = true;
    }
    if (!refusedVisual)
      throw new Error("A different retained visual was accepted.");
  }
  return { step: actual.step, scene: section.dataset.scene };
}

async function inspectCellRecordings(page, path) {
  const targets = await page.evaluate(cellInspectionTargets, path);
  const committed = await page
    .getByLabel("Simulation seconds", { exact: true })
    .textContent();
  await page
    .getByRole("button", { name: "Close physics inspection", exact: true })
    .click();
  for (const target of targets) {
    await openPhysicsDetails(page);
    await page
      .getByLabel("Cell recording seconds", { exact: true })
      .fill(String(target.at / 1_000_000));
    await page
      .getByRole("button", { name: "Inspect cell recording", exact: true })
      .click();
    // The inspection loads its own 3D scene, about 40 s under SwiftShader.
    await page.waitForFunction(ovenPhysicsReady, null, { timeout: 120000 });
    if (target.purpose === "admission" || target.purpose === "removal") {
      for (const endpoint of ["before", "after"]) {
        await chooseOption(
          page,
          page.getByLabel("Handoff endpoint", { exact: true }),
          { value: endpoint },
        );
        await page.evaluate(checkCellInspection, { target, endpoint });
      }
    } else {
      const slider = page.getByLabel("Recorded physics sample", {
        exact: true,
      });
      await slider.fill("0");
      await page.evaluate(checkCellInspection, { target, endpoint: "first" });
      await slider.fill(String(target.samples.length - 1));
      await page.evaluate(checkCellInspection, { target, endpoint: "last" });
    }
    if (
      (await page
        .getByLabel("Simulation seconds", { exact: true })
        .textContent()) !== committed
    )
      throw new Error("Cell inspection advanced the run.");
    await page.screenshot({
      path: `oven-cell-${target.purpose}-${target.at}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close physics inspection", exact: true })
      .click();
  }
  return {
    idle: true,
    handoffs: targets.length - 1,
    exactEndpoints: true,
    simulationUnchanged: true,
  };
}

async function cellInspectionTargets(path) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const targets = [];
  let idle = null;
  for (const artifact of saved.artifacts) {
    const newline = artifact.content.indexOf("\n");
    if (newline < 0) continue;
    const pack = JSON.parse(artifact.content.slice(0, newline));
    if (pack.kind !== "recording-pack") continue;
    const { readRecordingPack } =
      await import("/@id/@purin-labs/production-simulation");
    const decoded = readRecordingPack(artifact.content);
    if (!decoded.ok) throw new Error("Invalid recording pack");
    for (const record of decoded.value.records) {
      const raw = JSON.parse(
        decoded.value.body.slice(
          record.offset,
          record.offset + record.byteLength,
        ),
      );
      if (raw.kind !== "accepted-cell-recording") continue;
      const motion = JSON.parse(raw.native).motion;
      if (raw.time.kind === "idle")
        idle = {
          purpose: "idle",
          at: raw.time.through,
          after: raw.time.after,
          samples: motion.samples,
        };
      else
        targets.push({
          purpose: raw.time.kind,
          at: raw.time.at,
          boundary: raw.time.boundary,
          before: motion.before,
          after: motion.after,
          beforeSlot: motion.beforeSlot,
          afterSlot: motion.afterSlot,
        });
    }
  }
  if (targets.length !== 4 || idle === null)
    throw new Error("Cell inspection evidence is incomplete.");
  return [...targets, idle];
}

function checkCellInspection({ target, endpoint }) {
  const section = document.querySelector(
    '[aria-label="Accepted physics inspection"]',
  );
  if (section.dataset.purpose !== target.purpose)
    throw new Error("Inspection selected another recording kind.");
  const expected =
    target.purpose === "idle"
      ? endpoint === "first"
        ? target.samples[0]
        : target.samples.at(-1)
      : target[endpoint];
  const actual = JSON.parse(
    section.querySelector('[aria-label="Exact physics sample"]').textContent,
  );
  for (const key of ["step", "joints", "tool", "jaw", "tray"])
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      throw new Error(`Inspected cell ${key} differs from its solver sample.`);
  const at =
    target.purpose === "idle"
      ? target.after + (expected.step - target.samples[0].step) * 2000
      : target.at;
  if (Number(section.dataset.time) !== at)
    throw new Error("Cell inspection changed the factory clock.");
  if (target.purpose !== "idle") {
    if (
      section.dataset.endpoint !== endpoint ||
      section.dataset.slot !== target[`${endpoint}Slot`].kind ||
      section.dataset.physicsTask !== undefined
    )
      throw new Error("Handoff identity or endpoint is incorrect.");
    if (
      section.querySelector('[aria-label="Recorded physics sample"]') !== null
    )
      throw new Error("A handoff exposes interpolated motion.");
  }
}

async function checkSchedulingHistory(path) {
  const saved = await (await fetch(`/@fs/${path}`)).json();
  const run = saved.document.state;
  const engine = await import(
    `/bakery-physics/executions/${saved.document.bundle.id}/production-engine.mjs`
  );
  const expected = engine.runResults(run, {
    after: null,
    through: run.position.time,
  }).schedulingHistory;
  const region = document.querySelector('[aria-label="Scheduling history"]');
  if (
    Number(region?.dataset.time) !== run.position.time ||
    expected.kind !== "available"
  )
    throw new Error("Scheduling history differs from the committed clock.");
  for (const resource of expected.resources) {
    const row = region.querySelector(
      `[data-resource-categories="${CSS.escape(resource.resource)}"]`,
    );
    for (const kind of engine.CAPACITY_CATEGORIES) {
      const metric = row?.querySelector(`[data-category="${kind}"]`);
      if (Number(metric?.dataset.value) !== resource.unitSeconds[kind])
        throw new Error(
          `Resource category differs: ${resource.resource}/${kind}`,
        );
    }
  }
  const rows = region.querySelectorAll("[data-wait-task]");
  if (rows.length !== expected.waits.length)
    throw new Error("Wait history lost an interval.");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const wait = expected.waits[index];
    if (
      row.dataset.waitTask !== wait.task ||
      Number(row.dataset.start) !== wait.start ||
      Number(row.dataset.end) !== wait.end ||
      row.querySelectorAll("li").length !== wait.blockers.length
    )
      throw new Error("Wait interval differs from its accepted blockers.");
  }
  return {
    time: run.position.time,
    resources: expected.resources.length,
    waits: expected.waits.length,
    exactTotals: true,
  };
}

async function checkIndexedRecordingAccess(paths) {
  const { readOvenSave } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-run-file.ts`
  );
  const { OvenRecordings, ovenRecordingArchive } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-recordings.ts`
  );
  const { readOvenScene, ovenFrameMotion, ovenSampleTime } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-live-physics.ts`
  );
  const { ROBOTS } = await import(
    `/@fs${window.pantryCheckout}/packages/bakery-model/src/bakery-robots.ts`
  );
  const reader = new OvenRecordings();
  const seenPacks = new Set();
  const stages = [];
  let latestSave;
  let scene;
  for (const [name, path] of Object.entries(paths)) {
    const saved = await (await fetch(`/@fs/${path}`)).json();
    const checked = await readOvenSave(saved, new Map());
    if (!checked.ok) throw new Error(checked.error);
    latestSave = checked.value.save;
    const cell = checked.value.cells[0];
    if (scene === undefined) {
      const setup = await (
        await fetch(
          `/@fs${window.pantryCheckout}/assets/bakery-mujoco/fr10-workcell/native/${cell.robot}/combined-nominal.json`,
        )
      ).json();
      scene = readOvenScene(cell, {
        kind: "scene",
        version: 1,
        cell: cell.cellId,
        modelHash: cell.modelHash,
        setup,
        robotGlbSha256: ROBOTS[cell.robot].glbSha256,
      });
    }
    for (const artifact of saved.document.artifacts)
      if (artifact.role === "recording-segment") seenPacks.add(artifact.digest);
    const started = performance.now();
    const frame = await reader.latest(
      ovenRecordingArchive(latestSave),
      scene,
      latestSave.document.state.position.time,
    );
    const elapsedMs = performance.now() - started;
    if (frame === null || frame.at > latestSave.document.state.position.time)
      throw new Error("Indexed inspection lost its accepted boundary.");
    const stats = reader.stats();
    if (stats.scannedPacks !== seenPacks.size)
      throw new Error("Continuation rescanned a retained recording pack.");
    stages.push({ name, elapsedMs, stats });
  }
  const before = reader.stats();
  const times = [];
  for (let seek = 0; seek < 40; seek++) {
    const through = (seek % 2 === 0 ? 600 : 1225) * 1_000_000;
    const started = performance.now();
    const frame = await reader.latest(
      ovenRecordingArchive(latestSave),
      scene,
      through,
    );
    times.push(performance.now() - started);
    if (frame === null)
      throw new Error("A recorded interval disappeared during seek.");
    const motion = ovenFrameMotion(frame, "after");
    if (ovenSampleTime(frame, motion.samples.at(-1)) > through)
      throw new Error("Indexed seek showed a future pose.");
  }
  const after = reader.stats();
  if (
    after.scannedRecords !== before.scannedRecords ||
    after.scannedPacks !== before.scannedPacks ||
    after.selectedRecords !== before.selectedRecords + 40
  )
    throw new Error("A timestamp seek scanned or decoded unrelated records.");
  const operationBefore = reader.stats();
  const playback = await reader.operation(
    ovenRecordingArchive(latestSave),
    scene,
    "batch-A#0/oven-load",
  );
  const operationAfter = reader.stats();
  if (
    playback.at > latestSave.document.state.position.time ||
    operationAfter.scannedRecords !== operationBefore.scannedRecords ||
    operationAfter.selectedBytes - operationBefore.selectedBytes >
      64 * 1024 * 1024
  )
    throw new Error("Operation inspection crossed its recording bounds.");
  let futureRefused = false;
  try {
    await reader.latest(
      ovenRecordingArchive(latestSave),
      scene,
      latestSave.document.state.position.time + 2000,
    );
  } catch {
    futureRefused = true;
  }
  if (!futureRefused)
    throw new Error("Future recording inspection was accepted.");

  // The outer pack and save have valid new hashes. Its internal offsets remain invalid.
  const engine = await import(
    `/bakery-physics/executions/${latestSave.document.bundle.id}/production-engine.mjs`
  );
  const { exportOvenSave } = await import(
    `/@fs${window.pantryCheckout}/packages/production-simulation/src/runs/oven-run-file.ts`
  );
  const edited = JSON.parse(await exportOvenSave(latestSave).text());
  let packEntry;
  for (const entry of edited.document.artifacts)
    if (entry.role === "recording-segment") {
      packEntry = entry;
      break;
    }
  let content;
  for (const artifact of edited.artifacts)
    if (artifact.digest === packEntry.digest) {
      content = artifact;
      break;
    }
  const { readRecordingPack } =
    await import("/@id/@purin-labs/production-simulation");
  const decoded = readRecordingPack(content.content);
  if (!decoded.ok) throw new Error("The fixture pack cannot be decoded.");
  const header = {
    kind: "recording-pack",
    schemaVersion: 1,
    records: decoded.value.records,
  };
  header.records[0].offset += 1;
  content.content = JSON.stringify(header) + "\n" + decoded.value.body;
  const bytes = new TextEncoder().encode(content.content);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let digest = "";
  for (const byte of hash) digest += byte.toString(16).padStart(2, "0");
  content.digest = digest;
  packEntry.digest = digest;
  packEntry.byteLength = bytes.byteLength;
  edited.document = await engine.resumableDocument(
    edited.document.state,
    edited.document.bundle,
    edited.document.artifacts,
  );
  const admitted = await readOvenSave(edited, new Map());
  if (!admitted.ok)
    throw new Error(
      "The pack-offset probe did not reach the recording boundary.",
    );
  let offsetsRefused = false;
  try {
    await new OvenRecordings().latest(
      ovenRecordingArchive(admitted.value.save),
      scene,
      admitted.value.save.document.state.position.time,
    );
  } catch {
    offsetsRefused = true;
  }
  if (!offsetsRefused)
    throw new Error("Rehashed invalid recording offsets were accepted.");
  // Sort numeric durations within this browser-evaluated function.
  for (let index = 1; index < times.length; index++) {
    const value = times[index];
    let destination = index;
    while (destination > 0 && times[destination - 1] > value) {
      times[destination] = times[destination - 1];
      destination--;
    }
    times[destination] = value;
  }
  const p95SeekMs = times[Math.ceil(times.length * 0.95) - 1];
  const maximumSeekMs = times.at(-1);
  return {
    stages,
    repeatedSeeks: 40,
    p95SeekMs,
    maximumSeekMs,
    selectedBytes: after.selectedBytes - before.selectedBytes,
    noRepeatedPackScans: true,
    oneRecordPerTimestamp: true,
    futureRefused,
    offsetsRefused,
  };
}

// The recipe form left the catalog in 4f14e14dd. A person opens the same full
// financier recipe (3 loads, 1 cooling grid, 15 bake minutes) as a recipe file,
// which the Portal prepares with the same prepareFinancierRecipe.
async function exerciseFinancierOperator(page) {
  const recipe = await page.evaluate(
    financierRecipeFile,
    portalSimulationSource(),
  );
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles({
      name: "financier-recipe.json",
      mimeType: "application/json",
      buffer: Buffer.from(recipe),
    });
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "awaiting-inspection" })
    .waitFor();
  const held = await saveOvenDownload(page, "recipe-held-inspection");
  // The workspace save form is in the factory's Save panel.
  await openFactoryPanel(page, "Save");
  const shared = page.getByRole("region", {
    name: "Workspace saved runs",
    exact: true,
  });
  await shared
    .getByLabel("Run name (required)")
    .fill("Financier held for inspection");
  await shared
    .getByRole("button", { name: "Review save", exact: true })
    .click();
  await shared
    .getByRole("button", { name: "Confirm save", exact: true })
    .click();
  await shared
    .getByRole("status")
    .filter({ hasText: "save response is uncertain" })
    .waitFor();
  const confirm = shared.getByRole("button", {
    name: "Confirm save",
    exact: true,
  });
  if ((await confirm.count()) > 0 && (await confirm.isEnabled()))
    throw new Error("An uncertain save permits another submission.");
  await shared.getByRole("button", { name: /^Check saved run / }).click();
  await shared
    .getByRole("status")
    .filter({ hasText: "verified by exact readback" })
    .waitFor();
  if (globalThis.ovenRecipeArchive.size !== 1)
    throw new Error("Shared save was duplicated.");
  await page.screenshot({
    path: "recipe-shared-save-recovered.png",
    fullPage: true,
  });
  await page.reload();
  await installRecipeMutation(page, saveRecipeCopyWithArtifacts);
  await page.evaluate(mountConnectedOvenWorkspace, portalSimulationSource());
  await openOvenProduction(page);
  await page
    .locator(".production-panel")
    .getByRole("button", { name: /^Shared production runs/ })
    .click();
  await page
    .getByRole("button", {
      name: "Open Financier held for inspection",
      exact: true,
    })
    .click();
  if (
    await page
      .getByRole("button", { name: "Continue saved run", exact: true })
      .isDisabled()
  )
    throw new Error(
      "Opening a shared run did not leave it ready for explicit continuation.",
    );
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "awaiting-inspection" })
    .waitFor();
  await page.screenshot({
    path: "recipe-inspection-reopened.png",
    fullPage: true,
  });
  const decisions = [];
  for (let turn = 0; turn < 6; turn++) {
    // Pending inspections are listed in the Inspector panel.
    await openFactoryPanel(page, "Inspector");
    const row = page.locator('[data-inspection-state="pending"]').first();
    await row.waitFor();
    const task = await row.getAttribute("data-inspection-task");
    const outcome = task.startsWith("load-hazelnut-b#") ? "Reject" : "Accept";
    await page
      .getByLabel("Inspection observation", { exact: true })
      .fill(
        `Synthetic operator check: ${outcome.toLowerCase()} this material.`,
      );
    await row.getByRole("button", { name: outcome, exact: true }).click();
    await page
      .getByLabel("Execution status", { exact: true })
      .filter({ hasText: turn === 5 ? "completed" : "awaiting-inspection" })
      .waitFor();
    decisions.push({ task, outcome });
  }
  const completed = await saveOvenDownload(page, "recipe-completed");
  const result = await page.evaluate(checkFinancierOperatorFiles, {
    held,
    completed,
  });
  await page.screenshot({ path: "recipe-completed.png", fullPage: true });
  await backToRecipes(page);
  return { ...result, decisions, held, completed };
}

async function checkFinancierOperatorFiles({ held, completed }) {
  const heldResponse = await fetch(`/@fs/${held}`);
  const completedResponse = await fetch(`/@fs/${completed}`);
  if (!heldResponse.ok || !completedResponse.ok)
    throw new Error("Missing recipe downloads");
  const first = (await heldResponse.json()).document.state;
  const final = (await completedResponse.json()).document.state;
  if (
    first.status.kind !== "awaiting-inspection" ||
    final.status.kind !== "completed"
  )
    throw new Error("Wrong saved recipe lifecycle");
  const observations = [];
  for (const entry of final.commands)
    if (entry.command.kind === "inspect") observations.push(entry.command);
  if (observations.length !== 6)
    throw new Error("Inspection decisions were lost or duplicated");
  let packed = 0;
  let rejected = 0;
  let mass = 0;
  for (const lot of final.lots)
    if (lot.remaining.unit === "milligram") mass += lot.remaining.amount;
  for (const event of final.events) {
    if (event.kind !== "quantity-reported") continue;
    if (event.destination === "packed-pieces") packed += event.quantity.amount;
    if (event.destination === "rejected-pieces")
      rejected += event.quantity.amount;
    if (
      event.quantity.unit === "milligram" &&
      event.role !== "intermediate-stock"
    )
      mass += event.quantity.amount;
  }
  if (packed !== 15 || rejected !== 8 || mass !== 775000)
    throw new Error("Recipe output or mass balance differs");
  if (
    first.identity.runId !== final.identity.runId ||
    first.identity.executionId === final.identity.executionId
  )
    throw new Error("Recipe did not continue in a fresh execution");
  return {
    result: "passed",
    packed,
    rejected,
    massMg: mass,
    inspections: observations.length,
  };
}

async function saveRecipeCopyWithArtifacts(path, body) {
  // A save with artifacts also posts to runs/prepared/<id> and its artifacts.
  const runs = "/v1/control/organisations/oven-ui-acceptance/bakery/runs";
  if (path !== runs && !path.startsWith(`${runs}/prepared/`))
    throw new Error("This journey must not mutate commerce.");
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error("The shared run save did not return a receipt.");
  return response.json();
}

// HTTP storage fixture for UI acceptance. Workerd E2E verifies the real archive,
// authorization, revocation, lost receipts and identical file continuation.
async function recipeArchiveRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  const prefix = "/v1/control/organisations/oven-ui-acceptance/bakery/runs";
  const id = url.pathname.slice(prefix.length + 1);
  const archive = globalThis.ovenRecipeArchive;
  // A save with artifacts first sends its artifact index to prepared/<id>,
  // uploads each missing artifact there, and then posts the run.
  const artifacts = (globalThis.ovenRecipeArtifacts ??= new Map());
  const prepared = id.match(
    /^prepared\/([0-9a-f]+)(?:\/artifacts\/([0-9a-f]+))?$/u,
  );
  if (request.method() === "POST" && prepared !== null) {
    const body = request.postDataJSON();
    if (prepared[2] === undefined) {
      const entries = body.document?.document?.artifacts ?? [];
      const lengths = (globalThis.ovenRecipeArtifactLengths ??= new Map());
      for (const entry of entries) lengths.set(entry.digest, entry.byteLength);
      await route.fulfill({
        json: {
          ok: true,
          id: prepared[1],
          missing: entries
            .map((entry) => entry.digest)
            .filter((digest) => !artifacts.has(digest)),
        },
      });
      return;
    }
    artifacts.set(prepared[2], body.content);
    await route.fulfill({
      json: {
        ok: true,
        digest: prepared[2],
        byteLength: globalThis.ovenRecipeArtifactLengths.get(prepared[2]),
      },
    });
    return;
  }
  const artifact = id.match(/^[0-9a-f]+\/artifacts\/([0-9a-f]+)$/u);
  if (request.method() === "GET" && artifact !== null) {
    const content = artifacts.get(artifact[1]);
    await route.fulfill(
      content === undefined
        ? { status: 404, json: { error: "bakery_run_artifact_not_found" } }
        : { json: { digest: artifact[1], content } },
    );
    return;
  }
  if (request.method() === "POST") {
    const { expectedId, name, document } = request.postDataJSON();
    const content = JSON.stringify({ name, document });
    const summary = {
      id: expectedId,
      name,
      kind: "persistent-production",
      bytes: Buffer.byteLength(content),
      savedAt: "2026-10-11T00:00:00.000Z",
    };
    const existed = archive.has(expectedId);
    archive.set(expectedId, { summary, content });
    if (globalThis.ovenRecipeLoseReply) {
      globalThis.ovenRecipeLoseReply = false;
      await route.abort("failed");
    } else
      await route.fulfill({
        status: existed ? 200 : 201,
        json: { ok: true, snapshot: summary },
      });
  } else if (id !== "") {
    const entry = archive.get(id);
    await route.fulfill(
      entry === undefined
        ? { status: 404, json: { error: "bakery_run_not_found" } }
        : { status: 200, body: entry.content, contentType: "application/json" },
    );
  } else {
    const snapshots = [];
    for (const entry of archive.values()) snapshots.push(entry.summary);
    await route.fulfill({
      status: 200,
      json: { ok: true, snapshots, nextCursor: null },
    });
  }
}
