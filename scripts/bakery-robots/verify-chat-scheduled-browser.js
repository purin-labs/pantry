// Plan 42F F1c: chat drives a rehearsal on the production scheduler through
// the real mounted route, effect bridge and browser MuJoCo, over a controlled
// HTTP transport. A signed-in run repeats this with a real agent (Plan 42C).
async function verifyScheduledChatParity(page) {
  // Each bakery scene (production, rack preview) blocks the page for about
  // 50 seconds while it loads under SwiftShader in CI.
  page.setDefaultTimeout(90000);
  // This journey mounts its own connected workspace. Do not leave a second
  // React root and its WebGL resources alive behind the fixture.
  await page.route("**/src/dev/workflow-preview.tsx", serveWorkspaceStyles, {
    times: 1,
  });
  await page.goto(
    `${globalThis.bakeryBase ?? new URL(page.url()).origin}/workflow-preview.html?conversation=ingredient-chat-acceptance`,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async function mountWorkspace() {
    const { default: React } = await import("/@id/react");
    const { default: ReactDOM } = await import("/@id/react-dom/client");
    const { MemoryRouter } = await import("/@id/react-router");
    const { default: WorkflowSimulatorRoute } =
      await import("/src/features/workflow-simulator/route.tsx");
    const { BakerySurfaceEffectBridge } =
      await import("/src/features/bakery-surface-effect-bridge.tsx");
    const { bakerySurfaceForOrganisation } =
      await import("/src/features/bakery-surface-registry.ts");
    const { createBakerySurfaceEffect } =
      await import("/@id/@seams/bakery-model/bakery-surface");
    const { parseRunSnapshot } =
      await import("/@id/@seams/bakery-model/bakery-run-snapshot");
    const fixture = {
      effects: [],
      receipts: [],
      deadlines: [],
      writes: [],
      saveRequests: [],
      snapshots: new Map(),
      savedReadMode: "normal",
      holdNextSavedRead: false,
      heldSavedRead: null,
      capture,
      enqueue,
    };
    window.chatParityAcceptance = fixture;
    const originalFetch = window.fetch.bind(window);
    document.cookie = "satyr_control_csrf=parity-fixture; path=/";
    window.fetch = async function transport(input, init) {
      const url = new URL(
        typeof input === "string" ? input : input.url,
        location.origin,
      );
      if (url.pathname.endsWith("/chat/surface-effects"))
        return Response.json({ ok: true, effects: fixture.effects });
      if (url.pathname.endsWith("/receipt")) {
        const receipt = JSON.parse(init.body).receipt;
        for (const pending of fixture.effects) {
          if (pending.effect.effectId !== receipt.effectId) continue;
          console.info(
            "[bakery-acceptance]",
            JSON.stringify({
              phase: "settled",
              command: pending.effect.command.kind,
              effectId: receipt.effectId,
              outcome: receipt.outcome.kind,
            }),
          );
        }
        fixture.receipts.push(receipt);
        fixture.effects = fixture.effects.filter(function keepPending(pending) {
          return pending.effect.effectId !== receipt.effectId;
        });
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/bakery/runs"))
        return Response.json({
          ok: true,
          snapshots: Array.from(fixture.snapshots.values(), savedSummary),
          nextCursor: null,
        });
      if (url.pathname.includes("/bakery/runs/")) {
        if (fixture.holdNextSavedRead) {
          fixture.holdNextSavedRead = false;
          await new Promise(holdSavedRead);
        }
        if (fixture.savedReadMode === "missing")
          return Response.json(
            { error: "bakery_run_not_found" },
            { status: 404 },
          );
        const saved = fixture.snapshots.get(url.pathname.split("/").at(-1));
        return Response.json(
          saved
            ? {
                name:
                  fixture.savedReadMode === "corrupt"
                    ? "Altered saved copy"
                    : saved.name,
                document: saved.document,
              }
            : { error: "missing" },
          { status: saved ? 200 : 404 },
        );
      }
      return originalFetch(input, init);
    };
    function holdSavedRead(resolve) {
      fixture.heldSavedRead = resolve;
    }
    function savedSummary(saved) {
      return saved.summary;
    }
    async function capture() {
      return (await bakerySurfaceForOrganisation("parity-42f").capture())
        .context;
    }
    async function enqueue(command) {
      const context = await capture();
      const effect = await createBakerySurfaceEffect({
        effectId: `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`,
        dispatchId: crypto.randomUUID(),
        deadlineAt:
          Date.now() + (command.kind === "simulate_workcell" ? 150000 : 30000),
        command: {
          schemaVersion: 1,
          target: {
            surfaceSessionId: context.surfaceSessionId,
            surfaceEpoch: context.surfaceEpoch,
          },
          ...command,
        },
      });
      fixture.effects.push({ effect });
      fixture.deadlines.push(effect.deadlineAt);
      console.info(
        "[bakery-acceptance]",
        JSON.stringify({
          phase: "started",
          command: command.kind,
          effectId: effect.effectId,
        }),
      );
      return effect.effectId;
    }
    async function mutate(path, body) {
      if (!path.endsWith("/bakery/runs") || !body.agentEffectId)
        throw new Error("Expected confirmed agent save");
      fixture.saveRequests.push(body);
      const existing = fixture.snapshots.get(body.expectedId);
      if (existing) {
        if (JSON.stringify(fixture.writes[0]) !== JSON.stringify(body))
          throw new Error("Recovery changed the frozen save request");
        return { ok: true, snapshot: existing.summary };
      }
      const snapshot = parseRunSnapshot({
        name: body.name,
        document: body.document,
      });
      if (snapshot === null) throw new Error("Invalid saved run");
      const summary = {
        id: body.expectedId,
        name: body.name,
        kind: snapshot.kind,
        bytes: new TextEncoder().encode(snapshot.content).length,
        savedAt: new Date().toISOString(),
      };
      fixture.writes.push(body);
      fixture.snapshots.set(body.expectedId, {
        name: body.name,
        document: body.document,
        summary,
      });
      throw new TypeError("Injected connection loss after persistence");
    }
    document.getElementById("root").remove();
    const host = document.createElement("div");
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(WorkflowSimulatorRoute, {
          connection: {
            kind: "workspace",
            organisationId: "parity-42f",
            canManage: true,
            mutate,
          },
        }),
        React.createElement(BakerySurfaceEffectBridge, {
          organisationId: "parity-42f",
          active: true,
          reveal: Promise.resolve.bind(Promise),
        }),
      ),
    );
  });
  await page.getByRole("button", { name: "Play shift", exact: true }).waitFor();
  const evidence =
    globalThis.bakeryEvidence ?? "output/playwright/plan42f-chat-scheduled";
  function settled(id) {
    return page.waitForFunction(
      function hasReceipt(effectId) {
        return window.chatParityAcceptance.receipts.some(
          function matches(receipt) {
            return receipt.effectId === effectId;
          },
        );
      },
      id,
      { timeout: 150000 },
    );
  }
  async function run(command) {
    // Pace this long journey within the real duplicate-delivery retention limit.
    await page.waitForFunction(scheduledLedgerHasRoom, null, {
      timeout: 160000,
    });
    const id = await page.evaluate(function send(value) {
      return window.chatParityAcceptance.enqueue(value);
    }, command);
    await settled(id);
    const receipt = await page.evaluate(function read(effectId) {
      return window.chatParityAcceptance.receipts.find(function matches(item) {
        return item.effectId === effectId;
      });
    }, id);
    const result = receipt.outcome.result;
    if (receipt.outcome.kind !== "completed" || result.kind !== "succeeded")
      throw new Error(`${command.kind}: ${JSON.stringify(receipt.outcome)}`);
    return result;
  }
  function capture() {
    return page.evaluate(function read() {
      return window.chatParityAcceptance.capture();
    });
  }
  // Simulate the awaited step in the browser, then accept its candidate.
  async function simulateAndAccept(acceptance = "chat") {
    const before = await capture();
    const pending = before.active.pendingOperation;
    if (pending === null) throw new Error("No step awaits a result");
    const simulated = await run({
      schemaVersion: 2,
      kind: "simulate_workcell",
      operationId: pending.operationId,
      planFingerprint: before.active.planFingerprint,
      mode: pending.mode,
    });
    const review = await capture();
    if (
      review.active.candidate?.operationId !== pending.operationId ||
      review.active.candidate.recordingDigest !==
        simulated.output.recordingDigest
    )
      throw new Error("The simulated result is not the reviewed candidate");
    await run({ kind: "show_production_panel", panel: "timeline" });
    await page
      .getByRole("heading", {
        name: "Shared resource timeline",
        exact: true,
      })
      .waitFor();
    const timeline = await capture();
    if (
      timeline.active.panel !== "timeline" ||
      JSON.stringify(timeline.active.candidate) !==
        JSON.stringify(review.active.candidate) ||
      timeline.surfaceEpoch !== review.surfaceEpoch
    )
      throw new Error(
        "Opening the rehearsal timeline changed the pending candidate",
      );
    await run({ kind: "show_production_panel", panel: "files" });
    if (acceptance === "canvas") {
      await page
        .getByRole("button", {
          name: "Accept matching native result",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: "Accept matching native result",
          exact: true,
        })
        .waitFor({ state: "hidden" });
    } else {
      await run({
        kind: "accept_candidate",
        candidate: review.active.candidate,
      });
    }
    return {
      operationId: pending.operationId,
      mode: pending.mode,
      outcome: simulated.output.outcome,
      elapsedMs: simulated.output.elapsedMs,
      recordingDigest: simulated.output.recordingDigest,
      epochs: [before.surfaceEpoch, review.surfaceEpoch],
    };
  }

  // Chat prepares a one-tray rehearsal from the table-to-rack example.
  await run({
    kind: "prepare_workcell",
    preparation: {
      source: "example",
      example: "table-to-rack",
      dispatchSeconds: 0,
    },
  });
  const prepared = await capture();
  if (
    prepared.active.rehearsalKind !== "scheduled" ||
    prepared.active.pendingOperation?.operationId !== "batch:A:native:1"
  )
    throw new Error(JSON.stringify(prepared.active));
  await waitForProductionScene(page);

  // The bundled rack and oven examples use different arms in separate cells.
  await run({
    kind: "edit_rehearsal",
    planFingerprint: prepared.active.planFingerprint,
    edit: { kind: "set_cell", batchId: "A", cellId: "cold-cell-2" },
  });
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  // Chat prepares a rack move; the operator applies it.
  const layout = (await capture()).active.rackLayout;
  await run({
    schemaVersion: 2,
    kind: "prepare_layout",
    operationId: layout.operationId,
    baseModelHash: layout.modelHash,
    xMm: 100,
    yMm: 0,
  });
  await page.screenshot({ path: `${evidence}/layout-review.png` });
  await page
    .getByRole("button", { name: "Apply rack placement", exact: true })
    .click();
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Rack placement applied to tray A." })
    .waitFor();
  const moved = await capture();
  if (moved.active.rackLayout.xMm !== 100)
    throw new Error("The applied rack placement is not in the context");
  const steps = [await simulateAndAccept()];

  // Chat adds a browser chain as tray B, makes it wait for tray A and gives it
  // the second baker. Edit trays shows each edit; chat then runs B's steps.
  async function edit(change) {
    const before = await capture();
    await run({
      kind: "edit_rehearsal",
      planFingerprint: before.active.planFingerprint,
      edit: change,
    });
    const after = await capture();
    if (
      after.surfaceEpoch !== before.surfaceEpoch + 1 ||
      after.active.planFingerprint === before.active.planFingerprint
    )
      throw new Error(`${change.kind} did not change the rehearsal once`);
    return {
      edit: change.kind,
      epochs: [before.surfaceEpoch, after.surfaceEpoch],
    };
  }
  const edits = [await edit({ kind: "add_tray_chain", rackCase: "nominal" })];
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Loading, retrieval and racking are planned." })
    .waitFor();
  edits.push(
    await edit({
      kind: "set_prerequisites",
      batchId: "B",
      dependsOn: ["batch:A:native:1"],
    }),
  );
  edits.push(await edit({ kind: "set_baker", batchId: "B", baker: 2 }));
  const trayB = (await capture()).active.trays[1];
  if (
    JSON.stringify(trayB) !==
    JSON.stringify({
      ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
      batchId: "B",
      cellId: "cold-cell-1",
      baker: 2,
      dependsOn: ["batch:A:native:1"],
      earliestStartSeconds: 0,
    })
  )
    throw new Error(JSON.stringify(trayB));
  await editInputs(page);
  const trayFieldset = page.getByRole("group", { name: /^Tray B · / });
  // The baker select is the fieldset's first control.
  if (
    (await selectValue(
      trayFieldset.locator(".pantry-select-trigger").first(),
    )) !== "2"
  )
    throw new Error("Edit trays does not show chat's baker");
  await trayFieldset.getByText("Prerequisites (1)").waitFor();
  await page.screenshot({ path: `${evidence}/chat-edits.png` });
  for (let step = 0; step < 3; step++) steps.push(await simulateAndAccept());
  const finished = await capture();
  if (finished.active.pendingOperation !== null)
    throw new Error("A step still awaits a result");
  await run({
    kind: "control_baseline",
    action: "pin",
    comparison: finished.comparison,
  });
  const pinned = await capture();
  if (
    JSON.stringify(pinned.comparison.baseline) !==
    JSON.stringify(finished.comparison.current)
  )
    throw new Error("Chat did not pin the displayed run");
  // Chat and clicks share fault edits, including preserved accepted recordings.
  const faults = {
    outage: { resource: "human-2", start: 0, end: 120 },
    failure: { bakeryTaskId: "batch:B:handoff:1-stage", afterSeconds: 10 },
    recovery: { bakeryTaskId: "batch:B:handoff:1-stage", seconds: 60 },
  };
  await run({
    kind: "edit_rehearsal",
    planFingerprint: finished.active.planFingerprint,
    edit: { kind: "set_faults", faults },
  });
  const faulted = await capture();
  if (JSON.stringify(faulted.active.faults) !== JSON.stringify(faults))
    throw new Error("Chat fault assumptions were not projected");
  if (
    !(await page
      .getByRole("combobox", { name: "Injected failure", exact: true })
      .isVisible())
  )
    await editInputs(page);
  if (
    (await selectValue(
      page.getByRole("combobox", { name: "Injected failure", exact: true }),
    )) !== faults.failure.bakeryTaskId
  )
    throw new Error("Edit trays does not show chat's injected failure");
  await page
    .getByRole("spinbutton", { name: "Recovery duration (s)", exact: true })
    .fill("90");
  await page
    .getByRole("spinbutton", { name: "Recovery duration (s)", exact: true })
    .blur();
  await page.waitForFunction(function clickedRecovery() {
    return window.chatParityAcceptance
      .capture()
      .then(function changed(context) {
        return context.active.faults?.recovery?.seconds === 90;
      });
  });
  await page.screenshot({ path: `${evidence}/fault-assumptions.png` });
  const afterClick = await capture();
  if (
    JSON.stringify(afterClick.comparison.baseline) !==
    JSON.stringify(pinned.comparison.baseline)
  )
    throw new Error("Editing fault assumptions moved the baseline");
  if (
    JSON.stringify(afterClick.comparison.current) ===
    JSON.stringify(pinned.comparison.current)
  )
    throw new Error("Fault assumptions did not change the comparison outcome");
  const staleBaselineId = await page.evaluate(function staleBaseline(
    comparison,
  ) {
    return window.chatParityAcceptance.enqueue({
      kind: "control_baseline",
      action: "pin",
      comparison,
    });
  }, pinned.comparison);
  await settled(staleBaselineId);
  const staleBaseline = await page.evaluate(function baselineRejection(id) {
    return window.chatParityAcceptance.receipts.find(function matches(receipt) {
      return receipt.effectId === id;
    }).outcome.result;
  }, staleBaselineId);
  if (
    staleBaseline.kind !== "rejected" ||
    staleBaseline.code !== "stale_surface"
  )
    throw new Error("A stale baseline command was accepted");
  await page.screenshot({ path: `${evidence}/baseline-comparison.png` });
  await page
    .getByRole("button", { name: "Clear baseline", exact: true })
    .click();
  const clearedByClick = await capture();
  if (clearedByClick.comparison.baseline !== null)
    throw new Error("Click clear was not projected");
  await page
    .getByRole("button", {
      name: "Pin current run as baseline",
      exact: true,
    })
    .click();
  const pinnedByClick = await capture();
  if (
    JSON.stringify(pinnedByClick.comparison.baseline) !==
    JSON.stringify(afterClick.comparison.current)
  )
    throw new Error("Click pin was not projected");
  await run({
    kind: "control_baseline",
    action: "clear",
    comparison: pinnedByClick.comparison,
  });
  if ((await capture()).comparison.baseline !== null)
    throw new Error("Chat clear failed");
  const rejections = [];
  for (const invalid of [
    {
      expected: "stale_surface",
      fingerprint: finished.active.planFingerprint,
      faults,
    },
    {
      expected: "invalid_edit",
      fingerprint: afterClick.active.planFingerprint,
      faults: {
        ...faults,
        failure: { bakeryTaskId: "batch:B:native:1", afterSeconds: 10 },
      },
    },
  ]) {
    const id = await page.evaluate(
      function sendInvalid(command) {
        return window.chatParityAcceptance.enqueue(command);
      },
      {
        kind: "edit_rehearsal",
        planFingerprint: invalid.fingerprint,
        edit: { kind: "set_faults", faults: invalid.faults },
      },
    );
    await settled(id);
    const rejected = await page.evaluate(function readRejected(effectId) {
      return window.chatParityAcceptance.receipts.find(function matches(item) {
        return item.effectId === effectId;
      }).outcome.result;
    }, id);
    if (rejected.kind !== "rejected" || rejected.code !== invalid.expected)
      throw new Error(JSON.stringify(rejected));
    const unchanged = await capture();
    if (unchanged.active.planFingerprint !== afterClick.active.planFingerprint)
      throw new Error("A rejected fault edit changed the rehearsal");
    rejections.push(rejected.code);
  }
  const savedFaults = {
    outage: faults.outage,
    failure: null,
    recovery: null,
  };
  await run({
    kind: "edit_rehearsal",
    planFingerprint: afterClick.active.planFingerprint,
    edit: { kind: "set_faults", faults: savedFaults },
  });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${evidence}/accepted.png` });

  const files = await verifyScheduledFiles(page, run, capture, evidence);

  // Chat prepares a save; the operator confirms it; a lost acknowledgement
  // recovers by exact readback.
  const proposal = await run({
    kind: "prepare_run_save",
    name: "42F scheduled rehearsal",
  });
  await page
    .getByRole("heading", { name: "Review shared run save", exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/save-review.png` });
  const idleSave = await run({
    kind: "inspect_run_save",
    runKind: "rehearsal",
  });
  if (idleSave.output.save.kind !== "idle")
    throw new Error("An unconfirmed proposal was reported as a save");
  await page.getByRole("button", { name: "Confirm save", exact: true }).click();
  await page.getByRole("button", { name: /^Check saved run / }).waitFor();
  const saveInspection = await verifySaveInspection(
    page,
    run,
    capture,
    settled,
    evidence,
  );
  const saved = await page.evaluate(function written() {
    const fixture = window.chatParityAcceptance;
    return {
      writes: fixture.writes.length,
      saveRequests: fixture.saveRequests.length,
      document: fixture.writes[0]?.document ?? null,
      expectedId: fixture.writes[0]?.expectedId ?? null,
    };
  });
  if (saved.expectedId !== proposal.output.manifest.id)
    throw new Error("Saved identity differs from the proposal");
  const ingredientBefore = await capture();
  const changedIngredients = { massKg: 0.5, forwardMm: 0, lateralMm: 0 };
  await run({
    kind: "edit_rehearsal",
    planFingerprint: ingredientBefore.active.planFingerprint,
    edit: {
      kind: "set_ingredients",
      batchId: "B",
      ingredients: changedIngredients,
    },
  });
  const ingredientReview = await capture();
  if (
    ingredientReview.active.planFingerprint !==
      ingredientBefore.active.planFingerprint ||
    ingredientReview.active.editReview?.proposedResults !== 1
  )
    throw new Error(
      "Ingredient review changed results before apply or affected another tray",
    );
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const ingredientApplied = await capture();
  if (
    JSON.stringify(ingredientApplied.active.trays[1].ingredients) !==
    JSON.stringify(changedIngredients)
  )
    throw new Error("Agent ingredient edit missing from shared context");
  await simulateAndAccept();
  await simulateAndAccept();
  await simulateAndAccept();
  const beforeReview = await capture();
  await run({
    kind: "edit_rehearsal",
    planFingerprint: beforeReview.active.planFingerprint,
    edit: { kind: "clear_results", batchId: "B" },
  });
  const clearReview = await capture();
  if (
    clearReview.active.planFingerprint !==
      beforeReview.active.planFingerprint ||
    clearReview.surfaceEpoch !== beforeReview.surfaceEpoch ||
    clearReview.active.editReview?.currentResults !== 4 ||
    clearReview.active.editReview?.proposedResults !== 1
  )
    throw new Error(
      "Preparing clear mutated the run or misreported affected evidence",
    );
  await page
    .getByRole("region", { name: "Review rehearsal change", exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/clear-review.png` });
  await page
    .getByRole("button", { name: "Discard rehearsal change", exact: true })
    .click();
  if (
    (await capture()).active.planFingerprint !==
    beforeReview.active.planFingerprint
  )
    throw new Error("Discard changed the run");
  await run({
    kind: "edit_rehearsal",
    planFingerprint: beforeReview.active.planFingerprint,
    edit: { kind: "remove_tray", batchId: "B" },
  });
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const removed = await capture();
  if (
    removed.active.trays.length !== 1 ||
    removed.surfaceEpoch !== beforeReview.surfaceEpoch + 1 ||
    removed.active.editReview !== null
  )
    throw new Error("Confirmed remove did not commit exactly once");
  await run({
    kind: "edit_rehearsal",
    planFingerprint: removed.active.planFingerprint,
    edit: { kind: "replace_preset", preset: "two-trays" },
  });
  const presetReview = await capture();
  if (
    presetReview.active.planFingerprint !== removed.active.planFingerprint ||
    presetReview.active.editReview?.proposedResults !== 2
  )
    throw new Error("Preset replaced the run without confirmation");
  await page.screenshot({ path: `${evidence}/preset-review.png` });
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const replaced = await capture();
  if (
    replaced.active.trays.length !== 2 ||
    replaced.surfaceEpoch !== removed.surfaceEpoch + 1
  )
    throw new Error("Preset confirmation failed");
  // The same review is prepared by the operator's Clear tray results button.
  await page
    .getByRole("button", { name: "Clear tray A results", exact: true })
    .first()
    .click();
  const clickedReview = await capture();
  if (
    clickedReview.active.editReview?.change.kind !== "clear_results" ||
    clickedReview.active.planFingerprint !== replaced.active.planFingerprint
  )
    throw new Error("Click clear bypassed the shared review");
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const cleared = await capture();
  if (
    cleared.active.pendingOperation === null ||
    cleared.surfaceEpoch !== replaced.surfaceEpoch + 1
  )
    throw new Error("Confirmed clear did not make the tray runnable");
  const twoCells = await verifyTwoCells(
    page,
    run,
    capture,
    simulateAndAccept,
    evidence,
  );
  return {
    result: "passed",
    twoCells,
    files,
    reviewedChanges: {
      ingredients: changedIngredients,
      unaffectedTrayResults: 1,
      clearDiscarded: true,
      removedTrays: removed.active.trays.length,
      presetTrays: replaced.active.trays.length,
      clearedOperation: cleared.active.pendingOperation,
    },
    transport:
      "controlled HTTP; real mounted route, effect bridge, production scheduler and browser MuJoCo",
    steps,
    edits,
    faults: { saved: savedFaults, rejections, operatorRecoverySeconds: 90 },
    baseline: {
      pinned: pinned.comparison.baseline,
      changed: afterClick.comparison.current,
      rejection: staleBaseline.code,
      cleared: true,
    },
    save: {
      inspection: saveInspection,
      id: saved.expectedId,
      writes: saved.writes,
      saveRequests: saved.saveRequests,
    },
    savedDocumentBytes: new TextEncoder().encode(saved.document).length,
    // A duplicate delivery replays its stored receipt; count each effect once.
    settledCommands: await page.evaluate(function commands() {
      const receipts = window.chatParityAcceptance.receipts;
      return receipts
        .filter(function first(item, index) {
          return (
            receipts.findIndex(function same(other) {
              return other.effectId === item.effectId;
            }) === index
          );
        })
        .map(function command(item) {
          return item.outcome.result.command;
        });
    }),
  };
}

async function verifySaveInspection(page, run, capture, settled, evidence) {
  const before = await capture();
  const reads = [];
  for (const [mode, expected] of [
    ["normal", "verified"],
    ["missing", "missing"],
    ["corrupt", "unavailable"],
  ]) {
    await page.evaluate(setSavedReadMode, mode);
    const result = await run({
      kind: "inspect_run_save",
      runKind: "rehearsal",
    });
    const save = result.output.save;
    if (
      save.kind !== "outcome-unknown" ||
      save.readback !== expected ||
      save.reference.origin !== "agent"
    )
      throw new Error(`Incorrect save inspection: ${JSON.stringify(save)}`);
    reads.push({ mode, readback: save.readback, id: save.reference.id });
  }
  await page.evaluate(setSavedReadMode, "normal");
  const after = await capture();
  const writes = await page.evaluate(saveRequestCount);
  if (
    writes !== 1 ||
    after.surfaceEpoch !== before.surfaceEpoch ||
    JSON.stringify(after.active) !== JSON.stringify(before.active)
  )
    throw new Error(
      "Read-only save inspection changed the workspace or replayed approval",
    );
  await page.screenshot({ path: `${evidence}/uncertain-save.png` });
  await page.evaluate(holdNextSavedRead);
  const pending = await page.evaluate(enqueueSaveInspection);
  await page.waitForFunction(savedInspectionHeld);
  await page.getByRole("button", { name: /^Check saved run / }).click();
  await page
    .getByText(/^Saved copy .* was verified by exact readback/)
    .waitFor();
  await page.evaluate(releaseSavedInspection);
  await settled(pending);
  const stale = await page.evaluate(readSaveInspectionReceipt, pending);
  if (stale.kind !== "rejected" || stale.code !== "stale_surface")
    throw new Error("A late inspection reported an obsolete save attempt");
  const verified = await run({
    kind: "inspect_run_save",
    runKind: "rehearsal",
  });
  if (
    verified.output.save.kind !== "readback-confirmed" ||
    (await page.evaluate(saveRequestCount)) !== 2
  )
    throw new Error("Operator recovery did not repair the exact save once");
  await page.screenshot({ path: `${evidence}/recovered-save.png` });
  return {
    reads,
    inspectionWrites: 0,
    staleReadRejected: true,
    operatorRepairedReceipt: true,
  };
}
function setSavedReadMode(mode) {
  window.chatParityAcceptance.savedReadMode = mode;
}
function saveRequestCount() {
  return window.chatParityAcceptance.saveRequests.length;
}
function holdNextSavedRead() {
  window.chatParityAcceptance.holdNextSavedRead = true;
}
function enqueueSaveInspection() {
  return window.chatParityAcceptance.enqueue({
    kind: "inspect_run_save",
    runKind: "rehearsal",
  });
}
function savedInspectionHeld() {
  return window.chatParityAcceptance.heldSavedRead !== null;
}
function releaseSavedInspection() {
  window.chatParityAcceptance.heldSavedRead();
  window.chatParityAcceptance.heldSavedRead = null;
}
function readSaveInspectionReceipt(id) {
  for (const receipt of window.chatParityAcceptance.receipts)
    if (receipt.effectId === id) return receipt.outcome.result;
  throw new Error("Missing save inspection receipt");
}

async function serveWorkspaceStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css"; import "/src/dev/workflow-preview.css";',
  });
}

function scheduledLedgerHasRoom() {
  let retained = 0;
  for (const deadline of window.chatParityAcceptance.deadlines)
    if (deadline > Date.now()) retained++;
  return retained < 30;
}

async function verifyScheduledFiles(page, run, capture, evidence) {
  const before = await capture();
  const waiting = page.waitForEvent("download");
  const exported = await run({
    kind: "file_action",
    action: { kind: "export", format: "run" },
  });
  const download = await waiting;
  await download.saveAs(`${evidence}/chat-exported-rehearsal.json`);
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("Missing chat export");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  const attached = await page.evaluate(attachScheduledFile, text);
  if (
    attached.digest !== exported.output.manifest.digest ||
    attached.bytes !== exported.output.manifest.bytes
  )
    throw new Error("The download differs from its receipt");
  const imported = await run({
    kind: "file_action",
    action: { kind: "import", digest: attached.digest },
  });
  if (imported.output.manifest.digest !== attached.digest)
    throw new Error("Import lost its attachment identity");
  const review = page.getByRole("region", {
    name: "Review saved run",
    exact: true,
  });
  await review.waitFor();
  await page.screenshot({ path: `${evidence}/attached-file-review.png` });
  if (
    (await capture()).active.planFingerprint !== before.active.planFingerprint
  )
    throw new Error("File import bypassed operator review");
  await review
    .getByRole("button", { name: "Keep current run", exact: true })
    .click();
  await run({
    kind: "file_action",
    action: { kind: "import", digest: attached.digest },
  });
  const beforeApply = await capture();
  await review
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  const after = await capture();
  if (
    after.active.planFingerprint !== before.active.planFingerprint ||
    after.surfaceEpoch !== beforeApply.surfaceEpoch + 1
  )
    throw new Error("Reviewed file did not reopen the exact run");
  return {
    digest: attached.digest,
    bytes: attached.bytes,
    unchangedBeforeReview: true,
    reopenedExactly: true,
  };
}

async function attachScheduledFile(text) {
  const { bakerySurfaceForOrganisation } =
    await import("/src/features/bakery-surface-registry.ts");
  return bakerySurfaceForOrganisation("parity-42f").attachFile(
    new File([text], "attached-rehearsal.json", {
      type: "application/json",
    }),
  );
}

async function twoColdTrays() {
  const {
    parseRehearsalWorkcells,
    compileRehearsalWorkcells,
    exportRehearsalWorkcells,
  } =
    await import("/@id/@seams/production-simulation/recipes/bakery/production-workcells");
  const { readBundledExample } =
    await import("/src/features/workflow-simulator/bundled-example.ts");
  const { compileWorkcellInput } =
    await import("/@id/@seams/production-simulation/recipes/bakery/workcell-input");
  const saved = await parseRehearsalWorkcells(
    JSON.stringify(window.chatParityAcceptance.writes[0].document),
  );
  if (saved.kind !== "ready") throw new Error(saved.message);
  const recording = await readBundledExample("table-to-rack");
  const trays = [];
  for (const batchId of ["A", "B"]) {
    const input = compileWorkcellInput(
      {
        ...recording.request,
        runId: `two-cells-${batchId}`,
        attemptId: `two-cells-${batchId}`,
      },
      "0",
      "cold-cell-1",
    );
    if (input.kind === "invalid") throw new Error(input.message);
    trays.push({
      batchId,
      workerId: "human-1",
      dependsOn: [],
      earliestStartSeconds: 0,
      input: input.input,
      successors: [],
    });
  }
  const compiled = await compileRehearsalWorkcells(saved.plan.settings, trays);
  if (compiled.kind !== "ready") throw new Error(compiled.message);
  return exportRehearsalWorkcells(compiled.plan);
}

async function verifyTwoCells(page, run, capture, simulateAndAccept, evidence) {
  const coldTrays = await page.evaluate(twoColdTrays);
  const attached = await page.evaluate(attachScheduledFile, coldTrays);
  await run({
    kind: "file_action",
    action: { kind: "import", digest: attached.digest },
  });
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await run({
    kind: "edit_rehearsal",
    planFingerprint: (await capture()).active.planFingerprint,
    edit: { kind: "set_baker", batchId: "B", baker: 2 },
  });
  const before = await capture();
  await run({
    kind: "edit_rehearsal",
    planFingerprint: before.active.planFingerprint,
    edit: { kind: "set_cell", batchId: "B", cellId: "cold-cell-2" },
  });
  const review = await capture();
  if (
    review.active.planFingerprint !== before.active.planFingerprint ||
    review.active.trays[1].cellId !== "cold-cell-1"
  )
    throw new Error("Cell reassignment bypassed operator review");
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const assigned = await capture();
  if (assigned.active.trays[1].cellId !== "cold-cell-2")
    throw new Error("Cell assignment was lost");
  const results = [];
  for (let index = 0; index < 2; index++)
    results.push(await simulateAndAccept());
  const downloadEvent = page.waitForEvent("download");
  await run({
    kind: "file_action",
    action: { kind: "export", format: "run" },
  });
  const download = await downloadEvent;
  await download.saveAs(`${evidence}/two-cells.json`);
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("Missing two-cell export");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const file = Buffer.concat(chunks).toString();
  const schedule = await page.evaluate(inspectTwoCellRun, file);
  if (
    !schedule.overlap ||
    !schedule.crossCellRejected ||
    !schedule.reopenedExactly
  )
    throw new Error(`Two-cell evidence failed: ${JSON.stringify(schedule)}`);
  const handoff = await verifyHumanTransfer(
    page,
    run,
    capture,
    simulateAndAccept,
    evidence,
  );
  await run({
    kind: "edit_rehearsal",
    planFingerprint: (await capture()).active.planFingerprint,
    edit: {
      kind: "set_faults",
      faults: {
        outage: null,
        failure: { bakeryTaskId: "batch:A:handoff:1-stage", afterSeconds: 10 },
        recovery: null,
      },
    },
  });
  await run({
    kind: "edit_rehearsal",
    planFingerprint: (await capture()).active.planFingerprint,
    edit: { kind: "clear_results", batchId: "B" },
  });
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  for (let index = 0; index < 1; index++)
    results.push(await simulateAndAccept());
  await run({ kind: "show_production_panel", panel: "timeline" });
  await page
    .getByRole("group", { name: "Robot cell 1 allocations", exact: true })
    .waitFor();
  await page
    .getByRole("group", { name: "Robot cell 2 allocations", exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/two-cell-failure.png` });
  return {
    operatorReviewed: true,
    ...schedule,
    independentCellCompletedDuringFailure: true,
    handoff,
    results,
  };
}

async function inspectTwoCellRun(text) {
  const { parseRehearsalWorkcells, exportRehearsalWorkcells } =
    await import("/@id/@seams/production-simulation/recipes/bakery/production-workcells");
  const { simulateProduction } =
    await import("/@id/@seams/production-simulation/recipes/bakery/schedule");
  const { acceptProductionRecording, editRehearsalWorkcells } =
    await import("/@id/@seams/production-simulation/recipes/bakery/production-workcells");
  const parsed = await parseRehearsalWorkcells(text);
  if (parsed.kind !== "ready") throw new Error(JSON.stringify(parsed));
  const plan = parsed.plan;
  const run = simulateProduction(plan);
  const tasks = [];
  const cells = new Set();
  let first = null;
  let second = null;
  for (const task of run.intervals) {
    if (task.kind !== "native") continue;
    const cell = task.operation.attempt.input.bindings.cell;
    cells.add(cell);
    tasks.push({ id: task.id, start: task.start, end: task.end, cell });
    if (cell === "cold-cell-1" && first === null) first = task;
    if (cell === "cold-cell-2" && second === null) second = task;
  }
  if (first === null || second === null)
    throw new Error("Missing cell execution");
  const reset = await editRehearsalWorkcells(plan, {
    kind: "reset",
    batchId: "B",
  });
  if (reset.kind !== "ready") throw new Error(reset.message);
  const wrong = acceptProductionRecording(
    reset.plan,
    reset.plan.fingerprint,
    second.operation.id,
    first.recording,
    null,
  );
  const sharedBaker = await editRehearsalWorkcells(plan, {
    kind: "worker",
    batchId: "B",
    workerId: "human-1",
  });
  if (sharedBaker.kind !== "ready") throw new Error(sharedBaker.message);
  const sharedRun = simulateProduction(sharedBaker.plan);
  let lastEnd = 0;
  let sharedBakerWait = false;
  for (const interval of sharedRun.intervals) {
    if (interval.kind === "wait" && interval.reason === "worker")
      sharedBakerWait = true;
    if (interval.kind === "wait" || !interval.attended) continue;
    if (interval.start < lastEnd)
      throw new Error("Shared baker was double-booked");
    lastEnd = interval.end;
  }
  if (!sharedBakerWait) throw new Error("Expected shared baker contention");

  return {
    overlap:
      Math.max(first.start, second.start) < Math.min(first.end, second.end),
    crossCellRejected: wrong.kind === "rejected",
    sharedBakerWait,
    reopenedExactly: exportRehearsalWorkcells(plan) === text,
    cells: [...cells],
    tasks,
  };
}

async function verifyHumanTransfer(
  page,
  run,
  capture,
  simulateAndAccept,
  evidence,
) {
  const before = await capture();
  await run({
    kind: "edit_rehearsal",
    planFingerprint: before.active.planFingerprint,
    edit: { kind: "add_human_transfer", batchId: "A" },
  });
  if (
    (await capture()).active.planFingerprint !== before.active.planFingerprint
  )
    throw new Error("Human transfer bypassed review");
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  const results = [await simulateAndAccept("canvas")];
  // Repeat from a cleared source to exercise binding after fresh browser evidence.
  await run({
    kind: "edit_rehearsal",
    planFingerprint: (await capture()).active.planFingerprint,
    edit: { kind: "clear_results", batchId: "A" },
  });
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  results.push(await simulateAndAccept());
  results.push(await simulateAndAccept());
  const waiting = page.waitForEvent("download");
  await run({ kind: "file_action", action: { kind: "export", format: "run" } });
  const download = await waiting;
  await download.saveAs(`${evidence}/human-transfer.json`);
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("Missing human-transfer export");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  // The Portal runs its schedule on the live floor plan's walk routes (since
  // Refactor 16 step 15A an input of each run); the check builds that layout
  // with the Portal's own module instances and gives it to each run.
  const portalSource = `${portalSimulationSource()}/recipes/bakery`;
  const inspection = await page.evaluate(inspectHumanTransfer, {
    text,
    portalSource,
  });
  const attached = await page.evaluate(
    attachScheduledFile,
    inspection.failedFile,
  );
  await run({
    kind: "file_action",
    action: { kind: "import", digest: attached.digest },
  });
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .waitFor({ state: "hidden" });
  await run({
    kind: "control_playback",
    action: { kind: "seek", seconds: inspection.failedAt },
  });
  await run({ kind: "show_production_panel", panel: "timeline" });
  await page
    .getByRole("group", { name: "Transfer buffer allocations", exact: true })
    .waitFor();
  const failed = await capture();
  if (
    failed.active.pendingOperation !== null ||
    !failed.active.resources.some(bufferHeld)
  )
    throw new Error("Interrupted transfer lost its hold in chat context");
  await page.screenshot({ path: `${evidence}/human-transfer-interrupted.png` });
  const failedDownload = page.waitForEvent("download");
  await run({ kind: "file_action", action: { kind: "export", format: "run" } });
  await (
    await failedDownload
  ).saveAs(`${evidence}/human-transfer-interrupted.json`);
  const { failedFile, ...summary } = inspection;
  return { ...summary, operatorReviewed: true, results };
}

function bufferHeld(resource) {
  return (
    resource.id === "cold-transfer-buffer" &&
    resource.state.includes("held") &&
    resource.state.includes("uncertain")
  );
}

async function inspectHumanTransfer({ text, portalSource }) {
  const m = await import(`${portalSource}/production-workcells.ts`);
  const { simulateProduction } = await import(`${portalSource}/schedule.ts`);
  const { productionMaterialAt } = await import(
    `${portalSource}/production-material.ts`
  );
  const { HUMAN_CELL_TRANSFER } = await import(
    `${portalSource}/human-cell-transfer.ts`
  );
  const { parsePhysicsReplay } =
    await import("/@id/@seams/bakery-model/bakery-physics");
  const { buildLiveScheduleSpatialLayout } =
    await import("/src/features/workflow-simulator/bakery-appliance-layout.ts");
  const layout = buildLiveScheduleSpatialLayout();
  const parsed = await m.parseRehearsalWorkcells(text);
  if (parsed.kind !== "ready") throw new Error(parsed.message);
  const plan = parsed.plan;
  let source;
  let receiver;
  for (const operation of plan.operations) {
    if (operation.id === "batch:A:native:1") source = operation;
    if (operation.id === "batch:A:native:1:2") receiver = operation;
  }
  if (
    source === undefined ||
    receiver === undefined ||
    source.attempt.kind !== "completed" ||
    receiver.attempt.kind !== "completed"
  )
    throw new Error("Missing accepted transfer operations");
  const schedule = simulateProduction(plan, layout);
  let transfer;
  let destinationClear;
  for (const task of schedule.intervals) {
    if (task.kind === "handoff" && task.phase === "transfer") transfer = task;
    if (task.kind === "handoff" && task.batch === "B" && task.phase === "clear")
      destinationClear = task;
  }
  if (
    transfer === undefined ||
    destinationClear === undefined ||
    transfer.start < destinationClear.end
  )
    throw new Error(
      "Human pickup released the source before receiving capacity was free",
    );
  if (
    source.material.materialId !== receiver.material.materialId ||
    receiver.attempt.input.bindings.cell !== "cold-cell-2"
  )
    throw new Error("Human transfer changed physical tray identity");
  const reservations = [];
  let combined;
  for (const reservation of schedule.nativeReservations) {
    if (reservation.operationId === "batch:A:native:1")
      reservations.push(reservation);
    if (reservation.resources.includes("cold-transfer-buffer"))
      combined = reservation;
  }
  if (
    combined === undefined ||
    !combined.resources.includes("cold-cell-1") ||
    !combined.resources.includes("cold-cell-2") ||
    combined.start !== transfer.start ||
    combined.end !== transfer.end
  )
    throw new Error(
      "Transfer failed to reserve both cells and the single buffer together",
    );
  let lastEnd = -Infinity;
  for (const reservation of reservations) {
    if (reservation.start < lastEnd || reservation.kind !== "released")
      throw new Error("Tray acquired duplicate active owners");
    lastEnd = reservation.end;
  }
  const pickup = productionMaterialAt(schedule, source, transfer.arrival + 5);
  const carried = productionMaterialAt(schedule, source, transfer.arrival + 15);
  if (pickup.location !== "cell-1-rack" || carried.location !== "baker")
    throw new Error("Human custody changed before its pickup boundary");
  const buffer = productionMaterialAt(schedule, source, transfer.arrival + 35);
  if (buffer.location !== "buffer")
    throw new Error("Assumed buffer placement is missing");
  const reset = await m.editRehearsalWorkcells(plan, {
    kind: "reset",
    batchId: "A",
  });
  if (reset.kind !== "ready") throw new Error(reset.message);
  const wrong = m.acceptProductionRecording(
    reset.plan,
    reset.plan.fingerprint,
    source.id,
    receiver.attempt.recording,
  );
  if (wrong.kind !== "rejected")
    throw new Error("Wrong-cell recording accepted for source tray");
  const badPose = structuredClone(source.attempt.recording);
  badPose.samples[badPose.samples.length - 1].tray[0] += 0.1;
  const parsedPose = parsePhysicsReplay(JSON.stringify(badPose));
  const poseRejected =
    parsedPose.kind === "rejected" ||
    m.acceptProductionRecording(
      reset.plan,
      reset.plan.fingerprint,
      source.id,
      parsedPose.recording,
    ).kind === "rejected";
  if (!poseRejected)
    throw new Error("Bad source resting pose was accepted for human pickup");
  const interrupted = await m.editRehearsalWorkcells(plan, {
    kind: "faults",
    faults: {
      outage: null,
      failure: { bakeryTaskId: "batch:A:handoff:1-transfer", afterSeconds: 25 },
      recovery: null,
    },
  });
  if (interrupted.kind !== "ready") throw new Error(interrupted.message);
  const failedRun = simulateProduction(interrupted.plan, layout);
  const failure = failedRun.handlingFailures[0];
  let held;
  let receivingDispatched = false;
  for (const reservation of failedRun.nativeReservations)
    if (
      reservation.kind === "held" &&
      reservation.resources.includes("cold-transfer-buffer")
    )
      held = reservation;
  for (const task of failedRun.intervals)
    if (task.kind === "native" && task.operation.id === "batch:A:native:1:2")
      receivingDispatched = true;
  if (
    failure === undefined ||
    held === undefined ||
    !held.resources.includes("cold-cell-1") ||
    !held.resources.includes("cold-cell-2") ||
    receivingDispatched
  )
    throw new Error(
      "Interrupted transfer released custody or dispatched the receiver",
    );
  const material = productionMaterialAt(
    failedRun,
    source,
    failure.failedAt + 1,
  );
  if (material.kind !== "recovery-required" || material.location !== "unknown")
    throw new Error("Interrupted transfer invented a tray endpoint");
  const placementFailure = await m.editRehearsalWorkcells(plan, {
    kind: "faults",
    faults: {
      outage: null,
      failure: { bakeryTaskId: "batch:A:handoff:1-transfer", afterSeconds: 35 },
      recovery: null,
    },
  });
  if (placementFailure.kind !== "ready")
    throw new Error(placementFailure.message);
  const placementRun = simulateProduction(placementFailure.plan, layout);
  const failedPlacement = productionMaterialAt(
    placementRun,
    source,
    transfer.start + 35,
  );
  if (failedPlacement.location !== "unknown" || failedPlacement.tool !== "held")
    throw new Error("Failed placement invented a receiving pose");
  const recovered = await m.editRehearsalWorkcells(interrupted.plan, {
    kind: "faults",
    faults: {
      ...interrupted.plan.faults,
      recovery: { bakeryTaskId: "batch:A:handoff:1-transfer", seconds: 60 },
    },
  });
  if (recovered.kind !== "ready") throw new Error(recovered.message);
  const recoveredRun = simulateProduction(recovered.plan, layout);
  for (const reservation of recoveredRun.nativeReservations)
    if (
      reservation.operationId === source.id &&
      reservation.kind !== "released"
    )
      throw new Error("Assumed recovery retained a transfer resource");
  for (const task of recoveredRun.intervals)
    if (task.kind === "native" && task.operation.id === receiver.id)
      throw new Error("Assumed recovery resumed the failed tray");
  const recoveryState = productionMaterialAt(
    recoveredRun,
    source,
    failure.failedAt + 60,
  );
  if (
    recoveryState.kind !== "recovered" ||
    recoveryState.location !== "cell-1-source"
  )
    throw new Error("Recovery lost its assumed source frame");
  const failedFile = m.exportRehearsalWorkcells(interrupted.plan);
  const reopened = await m.parseRehearsalWorkcells(failedFile);
  if (
    reopened.kind !== "ready" ||
    m.exportRehearsalWorkcells(reopened.plan) !== failedFile
  )
    throw new Error("Reopen lost interrupted-transfer holds");
  return {
    route: HUMAN_CELL_TRANSFER,
    materialId: source.material.materialId,
    sourceStep: source.id,
    receiverStep: receiver.id,
    waitedForReceivingCapacity: true,
    oneOwner: true,
    wrongIdentityRejected: true,
    badPoseRejected: true,
    assumedBufferPlacement: true,
    interruptedLocation: material.location,
    failedPlacementHeld: true,
    assumedRecoveryReleasedWithoutResuming: true,
    heldResources: held.resources,
    failedAt: failure.failedAt,
    exactReopen: m.exportRehearsalWorkcells(plan) === text,
    failedFile,
  };
}
