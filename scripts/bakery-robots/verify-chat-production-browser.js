// Plan 42E: chat authors a financier production run through the real mounted
// route and effect bridge, over a controlled HTTP transport. Chat edits the
// draft, previews and applies it; Edit scenario shows each change, and the
// operator's own edits share the same draft.
async function verifyProductionChatParity(page) {
  page.setDefaultTimeout(15000);
  // This journey mounts its own connected workspace, so the preview entry
  // only loads the styles: no second React root and its WebGL resources. The
  // effect bridge polls only for the conversation that the URL names.
  await page.route("**/src/dev/workflow-preview.tsx", serveParityStyles, {
    times: 1,
  });
  await page.goto(
    `${globalThis.bakeryBase ?? new URL(page.url()).origin}/workflow-preview.html?conversation=production-chat-acceptance`,
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
      await import("/@id/@purin-labs/bakery-model/bakery-surface");
    const fixture = {
      effects: [],
      receipts: [],
      deadlines: [],
      savedRuns: [],
      changedSavedContent: false,
      holdSavedRead: false,
      heldSavedRead: null,
      capture,
      enqueue,
    };
    window.chatParityAcceptance = fixture;
    const originalFetch = window.fetch.bind(window);
    document.cookie = "pantry_csrf=parity-fixture; path=/";
    window.fetch = async function transport(input, init) {
      const url = new URL(
        typeof input === "string" ? input : input.url,
        location.origin,
      );
      if (url.pathname.endsWith("/chat/surface-effects"))
        return Response.json({ ok: true, effects: fixture.effects });
      if (url.pathname.endsWith("/receipt")) {
        const receipt = JSON.parse(init.body).receipt;
        fixture.receipts.push(receipt);
        fixture.effects = fixture.effects.filter(function keepPending(pending) {
          return pending.effect.effectId !== receipt.effectId;
        });
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/bakery/runs")) {
        if (fixture.savedRuns.length > 0 && !url.searchParams.has("cursor"))
          return Response.json({
            ok: true,
            snapshots: [
              {
                ...fixture.savedRuns[0].summary,
                id: "b".repeat(64),
                name: "Other rehearsal",
                kind: "rehearsal",
              },
            ],
            nextCursor: "production-page",
          });
        return Response.json({
          ok: true,
          snapshots: fixture.savedRuns.map(savedRunSummary),
          nextCursor: null,
        });
      }
      if (url.pathname.includes("/bakery/runs/")) {
        const saved = fixture.savedRuns.find(function matchingRun(item) {
          return url.pathname.endsWith(`/${item.summary.id}`);
        });
        if (!saved) return Response.json({ error: "missing" }, { status: 404 });
        if (fixture.holdSavedRead) await new Promise(holdSavedRead);
        return Response.json({
          name: fixture.changedSavedContent ? "Altered copy" : saved.body.name,
          document: saved.body.document,
        });
      }
      return originalFetch(input, init);
    };
    function savedRunSummary(saved) {
      return saved.summary;
    }
    function holdSavedRead(resolve) {
      fixture.heldSavedRead = resolve;
    }
    async function capture() {
      return (await bakerySurfaceForOrganisation("parity-42e").capture())
        .context;
    }
    async function enqueue(command) {
      const context = await capture();
      const effect = await createBakerySurfaceEffect({
        effectId: `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`,
        dispatchId: crypto.randomUUID(),
        deadlineAt: Date.now() + 30000,
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
      return effect.effectId;
    }
    async function mutate() {
      throw new Error("This journey saves nothing");
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
            organisationId: "parity-42e",
            canManage: true,
            mutate,
          },
        }),
        React.createElement(BakerySurfaceEffectBridge, {
          organisationId: "parity-42e",
          active: true,
          reveal: Promise.resolve.bind(Promise),
        }),
      ),
    );
  });
  // The page keeps one engine worker for all its jobs, so the result gate
  // must wrap Worker before the first job opens that worker.
  await page.evaluate(installSimulationResultGate);
  await page.getByRole("button", { name: "Play shift", exact: true }).waitFor();
  const evidence =
    globalThis.bakeryEvidence ?? "output/playwright/plan42e-production-chat";

  async function receiptFor(command) {
    // This long journey shares the real 32-entry duplicate-delivery ledger.
    await page.waitForFunction(
      function ledgerHasRoom() {
        let retained = 0;
        for (const deadline of window.chatParityAcceptance.deadlines)
          if (deadline > Date.now()) retained++;
        return retained < 30;
      },
      null,
      { timeout: 35000 },
    );
    const id = await page.evaluate(function send(value) {
      return window.chatParityAcceptance.enqueue(value);
    }, command);
    await page.waitForFunction(
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
    const receipt = await page.evaluate(function read(effectId) {
      return window.chatParityAcceptance.receipts.find(function matches(item) {
        return item.effectId === effectId;
      });
    }, id);
    if (receipt.outcome.kind !== "completed")
      throw new Error(`${command.kind}: ${JSON.stringify(receipt.outcome)}`);
    return receipt.outcome.result;
  }
  async function run(command) {
    const result = await receiptFor(command);
    if (result.kind !== "succeeded")
      throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
    return result;
  }
  async function refused(command, code) {
    const result = await receiptFor(command);
    if (result.kind !== "rejected" || result.code !== code)
      throw new Error(
        `${command.kind} was not refused: ${JSON.stringify(result)}`,
      );
    return result.message;
  }
  function capture() {
    return page.evaluate(function read() {
      return window.chatParityAcceptance.capture();
    });
  }
  function status(text) {
    return page
      .locator(".production-panel .production-notice")
      .filter({ hasText: text })
      .waitFor();
  }
  // A chat edit keeps the run and its epoch and changes the draft digest.
  async function edit(change) {
    const before = await capture();
    await run({
      kind: "edit_production",
      draftDigest: before.active.draft.digest,
      edit: change,
    });
    const after = await capture();
    if (
      after.surfaceEpoch !== before.surfaceEpoch ||
      after.active.planFingerprint !== before.active.planFingerprint ||
      after.active.draft.digest === before.active.draft.digest
    )
      throw new Error(`${change.kind} did not change only the draft`);
    return { edit: change.kind, epoch: after.surfaceEpoch };
  }
  function tray(draft, batchId, number) {
    return draft.assignments.find(function matches(assignment) {
      return assignment.batchId === batchId && assignment.tray === number;
    });
  }

  const shift = await capture();
  await page.getByRole("button", { name: "Top view", exact: true }).waitFor();
  await page.waitForFunction(function sceneReady() {
    return !document.querySelector('button[aria-label="Top view"]')?.disabled;
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setCamera", camera: "overhead" },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setCamera", camera: "overhead" },
  });
  if (
    (await page
      .getByRole("button", { name: "Top view", exact: true })
      .getAttribute("aria-pressed")) !== "true"
  )
    throw new Error("Repeated camera commands toggled the view");
  await page.screenshot({ path: `${evidence}/shift-overhead.png` });
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  if ((await capture()).active.view.camera !== "perspective")
    throw new Error("Clicked camera setting was absent from chat context");
  await run({
    kind: "control_workspace_view",
    action: { kind: "setLabels", labels: "all" },
  });
  await page
    .getByRole("button", { name: "Labels: All details", exact: true })
    .waitFor();
  await run({
    kind: "control_workspace_view",
    action: { kind: "setMinimap", visible: true },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "openDock", dock: "floorPlan" },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setChrome", chrome: "hidden" },
  });
  await page.waitForFunction(function restoreFocused() {
    return document.activeElement?.id === "workflow-chrome-restore";
  });
  await page.keyboard.press("Enter");
  await run({
    kind: "control_workspace_view",
    action: { kind: "resetCamera" },
  });
  await run({ kind: "control_workspace_view", action: { kind: "resetView" } });
  const viewReset = await capture();
  if (
    viewReset.active.view.dock !== "closed" ||
    viewReset.active.view.chrome !== "shown" ||
    viewReset.active.view.camera !== "perspective" ||
    viewReset.surfaceEpoch !== shift.surfaceEpoch ||
    JSON.stringify(viewReset.active.draft) !==
      JSON.stringify(shift.active.draft) ||
    JSON.stringify(viewReset.active.playback) !==
      JSON.stringify(shift.active.playback)
  )
    throw new Error(
      "View controls changed the shift or failed to restore the interface",
    );

  // The operator opens a financier production run.
  await openRecordingViewer(page);
  await page.getByRole("button", { name: /^Table to rack/ }).click();
  const recordingCamera = await verifyWorkspaceCamera(
    page,
    ".physics-replay",
    capture,
    run,
    evidence,
    "recording",
  );
  const recordingFocus = await verifyRecordingCameraFocus(
    page,
    capture,
    run,
    refused,
    evidence,
  );
  const recordingNavigation = await verifyRecordingNavigation(
    page,
    capture,
    run,
    refused,
    evidence,
  );
  const doorInspection = await verifyDoorInspection(
    page,
    capture,
    run,
    refused,
    evidence,
  );
  const recordingOnly = await refused(
    {
      kind: "control_workspace_view",
      action: { kind: "setLabels", labels: "off" },
    },
    "unsupported_command",
  );
  await run({
    kind: "prepare_workcell",
    preparation: {
      source: "example",
      example: "table-to-rack",
      dispatchSeconds: 0,
    },
  });
  const rehearsalCamera = await verifyWorkspaceCamera(
    page,
    ".production-workspace",
    capture,
    run,
    evidence,
    "rehearsal",
  );
  await backToExamples(page);
  await page
    .locator(".physics-replay")
    .getByRole("tab", { name: "Examples", exact: true })
    .click();
  await page.getByRole("button", { name: /^Multi-batch \+ robot/ }).click();
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .waitFor();
  const opened = await capture();
  if (
    opened.active.kind !== "production" ||
    opened.active.draft === null ||
    !opened.supportedCommands.includes("edit_production") ||
    opened.supportedCommands.includes("apply_production")
  )
    throw new Error(JSON.stringify(opened));
  const productionCamera = await verifyWorkspaceCamera(
    page,
    ".production-workspace",
    capture,
    run,
    evidence,
    "production",
  );
  const nativeOperation = opened.active.operations.at(-1);
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "operation", id: nativeOperation.id },
      cursorSeconds: 0,
      playback: "paused",
    },
  });
  const nativeView = await capture();
  if (
    nativeView.active.selection.kind !== "operation" ||
    nativeView.active.selection.id !== nativeOperation.id ||
    nativeView.active.playback.playback !== "paused"
  )
    throw new Error("Chat did not select the exact native operation");
  const operationSelector = page.getByRole("combobox", {
    name: "Native operation",
    exact: true,
  });
  if ((await selectValue(operationSelector)) !== nativeOperation.id)
    throw new Error("Files did not show chat's operation");
  const pendingTask = await refused(
    {
      kind: "set_view",
      view: {
        selection: { kind: "task", id: nativeOperation.id },
        cursorSeconds: 0,
        playback: "paused",
      },
    },
    "target_not_found",
  );
  await chooseOption(page, operationSelector, {
    value: opened.active.operations[0].id,
  });
  if ((await capture()).active.selection.id !== opened.active.operations[0].id)
    throw new Error("Operator selection did not reach chat context");
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "resource", id: "human-1" },
      cursorSeconds: 0,
      playback: "paused",
    },
  });
  const resourceView = await capture();
  if (
    resourceView.active.selection.kind !== "resource" ||
    resourceView.active.selection.id !== "human-1"
  )
    throw new Error("Resource navigation failed");
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "station", id: "stage" },
      cursorSeconds: 0,
      playback: "paused",
    },
  });
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "batch", id: "B" },
      cursorSeconds: 0,
      playback: "paused",
    },
  });
  const navigated = await capture();
  if (
    navigated.active.planFingerprint !== opened.active.planFingerprint ||
    navigated.surfaceEpoch !== opened.surfaceEpoch ||
    navigated.active.selection.id !== "B"
  )
    throw new Error("Navigation mutated the production run");
  await page.screenshot({ path: `${evidence}/production-navigation.png` });
  const initial = opened.active.draft;
  const staleShiftView = await refused(
    {
      kind: "control_workspace_view",
      target: {
        surfaceSessionId: shift.surfaceSessionId,
        surfaceEpoch: shift.surfaceEpoch,
      },
      action: { kind: "setCamera", camera: "overhead" },
    },
    "stale_surface",
  );
  const beforePanels = await capture();
  await run({ kind: "show_production_panel", panel: "timeline" });
  await page
    .getByRole("heading", { name: "Shared resource timeline", exact: true })
    .waitFor();
  const timelinePanel = await capture();
  if (
    timelinePanel.active.panel !== "timeline" ||
    timelinePanel.surfaceEpoch !== beforePanels.surfaceEpoch ||
    timelinePanel.active.planFingerprint !==
      beforePanels.active.planFingerprint ||
    JSON.stringify(timelinePanel.active.playback) !==
      JSON.stringify(beforePanels.active.playback)
  )
    throw new Error("Opening the timeline changed the run or playback");
  await page.screenshot({ path: `${evidence}/production-panel.png` });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  if ((await capture()).active.panel !== "files")
    throw new Error("The clicked Files panel was absent from chat context");
  await run({ kind: "show_production_panel", panel: "author" });
  await page
    .getByRole("heading", { name: "Edit production scenario", exact: true })
    .waitFor();
  const last = initial.assignments.at(-1);

  // Chat edits the draft: one tray fewer, a second baker for A1, B1 after
  // A1, a manual stage task and the assumed oven outage.
  const edits = [
    await edit({
      kind: "unassign_tray",
      batchId: last.batchId,
      tray: last.tray,
    }),
    await edit({ kind: "set_baker", batchId: "A", tray: 1, baker: 2 }),
    await edit({
      kind: "set_prerequisites",
      batchId: "B",
      tray: 1,
      dependsOn: ["batch:A:native:1"],
    }),
    await edit({
      kind: "set_manual_task",
      bakeryTaskId: "batch:B:process:stage",
      baker: 2,
      dependsOn: ["batch:A:native:1"],
      earliestStartSeconds: 0,
    }),
    await edit({ kind: "set_variant", variant: "outage" }),
  ];
  const stale = await refused(
    {
      kind: "edit_production",
      draftDigest: initial.digest,
      edit: { kind: "set_variant", variant: "normal" },
    },
    "stale_draft",
  );

  // Edit scenario shows chat's draft. Each label wraps its control.
  await editInputs(page);
  const trayA1 = page.getByRole("group", { name: "Batch A · tray 1" });
  if (
    (await selectValue(trayA1.getByLabel(/^Staging and clearance baker/))) !==
    "2"
  )
    throw new Error("Edit scenario does not show chat's baker");
  await page
    .getByRole("group", { name: "Batch B · tray 1" })
    .getByText("After completed tasks (1)")
    .waitFor();
  if (
    await page
      .getByRole("group", { name: `Batch ${last.batchId} · tray ${last.tray}` })
      .getByRole("checkbox", { name: "Use Robot cold transfer" })
      .isChecked()
  )
    throw new Error("Edit scenario still assigns the removed tray");
  if ((await selectValue(page.getByLabel(/^Oven availability/))) !== "outage")
    throw new Error("Edit scenario does not show chat's oven variant");
  const manual = page.getByRole("group", {
    name: "Manual operations and transfers",
  });
  await chooseOption(page, manual.getByLabel(/^Task/), {
    value: "batch:B:process:stage",
  });
  if ((await selectValue(manual.getByLabel(/^Assigned baker/))) !== "2")
    throw new Error("Edit scenario does not show chat's manual task");
  await page.screenshot({ path: `${evidence}/chat-edits.png` });

  // The operator's edit lands in the same draft chat sees.
  await page
    .getByRole("group", { name: "Batch B · tray 1" })
    .getByLabel(/^Earliest staging time/)
    .fill("60");
  const clicked = await capture();
  if (tray(clicked.active.draft, "B", 1).earliestStartSeconds !== 60)
    throw new Error("The operator's edit is not in chat's draft");

  // Chat previews the draft; Edit scenario shows the preview.
  await run({
    kind: "preview_production",
    draftDigest: clicked.active.draft.digest,
  });
  await status("Draft compiled.");
  const validPreview = page.getByText("Valid preview:", { exact: false });
  await validPreview.waitFor();
  await validPreview.scrollIntoViewIfNeeded();
  const previewed = await capture();
  const preview = previewed.active.draft.preview;
  if (
    preview === null ||
    preview.planFingerprint === previewed.active.planFingerprint ||
    preview.operationCount !== initial.assignments.length - 1 ||
    previewed.surfaceEpoch !== clicked.surfaceEpoch ||
    !previewed.supportedCommands.includes("apply_production")
  )
    throw new Error(JSON.stringify(previewed.active.draft));
  await page.screenshot({ path: `${evidence}/chat-preview.png` });

  // A baseline pins the displayed preview, with the old applied run rejected.
  await refused(
    { kind: "control_baseline", action: "pin", comparison: opened.comparison },
    "stale_surface",
  );
  await run({
    kind: "control_baseline",
    action: "pin",
    comparison: previewed.comparison,
  });
  const baseline = await capture();
  if (
    JSON.stringify(baseline.comparison.baseline) !==
    JSON.stringify(previewed.comparison.current)
  )
    throw new Error(
      "The baseline did not pin the displayed production preview",
    );
  await page
    .getByRole("button", { name: "Clear baseline", exact: true })
    .click();
  if ((await capture()).comparison.baseline !== null)
    throw new Error("Production baseline clear failed");

  // Chat applies exactly that preview as a fresh run on the next epoch.
  await run({
    kind: "apply_production",
    draftDigest: previewed.active.draft.digest,
    planFingerprint: preview.planFingerprint,
  });
  await status("Preview applied.");
  const applied = await capture();
  if (
    applied.surfaceEpoch !== previewed.surfaceEpoch + 1 ||
    applied.active.planFingerprint !== preview.planFingerprint ||
    applied.active.variant !== "outage" ||
    applied.active.operationCount !== preview.operationCount ||
    applied.supportedCommands.includes("apply_production")
  )
    throw new Error(JSON.stringify(applied.active));

  // Chat changes the draft back to the normal oven, then discards it.
  edits.push(await edit({ kind: "set_variant", variant: "normal" }));
  edits.push(await edit({ kind: "discard_draft" }));
  const discarded = await capture();
  if (
    JSON.stringify(discarded.active.draft) !==
    JSON.stringify(applied.active.draft)
  )
    throw new Error("Discarding did not return the draft to the applied run");

  const execution = [];
  let cancellation = null;
  for (let index = 0; index < applied.active.operationCount; index++) {
    const before = await capture();
    const pending = before.active.pendingOperation;
    if (
      pending === null ||
      !before.supportedCommands.includes("simulate_workcell")
    )
      throw new Error(
        "The production scheduler did not expose its awaited operation",
      );
    let simulated = await run({
      schemaVersion: 2,
      kind: "simulate_workcell",
      operationId: pending.operationId,
      planFingerprint: before.active.planFingerprint,
      mode: pending.mode,
    });
    let review = await capture();
    if (
      review.active.candidate?.operationId !== pending.operationId ||
      review.active.candidate.recordingDigest !==
        simulated.output.recordingDigest ||
      review.supportedCommands.includes("simulate_workcell")
    )
      throw new Error(
        "Production execution did not retain the exact result for review",
      );
    if (index === 0) {
      const discardedCandidate = review.active.candidate;
      await run({ kind: "discard_candidate", candidate: discardedCandidate });
      const kept = await capture();
      if (
        kept.active.candidate !== null ||
        kept.active.planFingerprint !== review.active.planFingerprint
      )
        throw new Error("Discard changed the accepted production run");
      simulated = await run({
        schemaVersion: 2,
        kind: "simulate_workcell",
        operationId: kept.active.pendingOperation.operationId,
        planFingerprint: kept.active.planFingerprint,
        mode: kept.active.pendingOperation.mode,
      });
      review = await capture();
      await refused(
        {
          kind: "discard_candidate",
          candidate: discardedCandidate,
          target: {
            surfaceSessionId: discardedCandidate.surfaceSessionId,
            surfaceEpoch: discardedCandidate.surfaceEpoch,
          },
        },
        "stale_surface",
      );
      if (
        JSON.stringify((await capture()).active.candidate) !==
        JSON.stringify(review.active.candidate)
      )
        throw new Error("A stale discard removed the replacement candidate");
      await run({ kind: "show_production_panel", panel: "timeline" });
      await run({ kind: "show_production_panel", panel: "files" });
    }
    await run({ kind: "accept_candidate", candidate: review.active.candidate });
    if (index === 0)
      cancellation = await verifyManualSimulationStop(
        page,
        capture,
        run,
        refused,
        evidence,
      );
    execution.push({
      operationId: pending.operationId,
      recordingDigest: simulated.output.recordingDigest,
    });
  }
  if ((await capture()).active.pendingOperation !== null)
    throw new Error("The completed run still advertises native work");
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "task", id: opened.active.operations[0].id },
      cursorSeconds: 0,
      playback: "paused",
    },
  });
  const settledTask = await capture();
  if (
    settledTask.active.selection.kind !== "task" ||
    settledTask.active.selection.id !== opened.active.operations[0].id
  )
    throw new Error("Accepted native task could not be selected");
  const savedCopy = await captureSavedProduction(page, run, evidence);
  edits.push(await edit({ kind: "set_variant", variant: "normal" }));
  const accepted = await capture();
  await run({
    kind: "preview_production",
    draftDigest: accepted.active.draft.digest,
  });
  const reviewed = await capture();
  // Over accepted results, chat's Apply opens the operator's replacement
  // review, as the Apply button does: it replaces nothing by itself.
  await run({
    kind: "apply_production",
    draftDigest: reviewed.active.draft.digest,
    planFingerprint: reviewed.active.draft.preview.planFingerprint,
  });
  await page.screenshot({ path: `${evidence}/apply-review.png` });
  const proposed = await capture();
  if (
    proposed.active.planFingerprint !== reviewed.active.planFingerprint ||
    proposed.surfaceEpoch !== reviewed.surfaceEpoch ||
    proposed.active.draft.replacement?.currentResults !==
      reviewed.active.operationCount
  )
    throw new Error(
      "Replacement proposal changed the run or lost its result count",
    );
  await run({ kind: "show_production_panel", panel: "details" });
  await run({ kind: "show_production_panel", panel: "author" });
  if (
    JSON.stringify((await capture()).active.draft.replacement) !==
    JSON.stringify(proposed.active.draft.replacement)
  )
    throw new Error("Panel navigation changed the pending replacement review");
  await page
    .getByRole("region", { name: "Review production replacement", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/replacement-review.png` });
  await page
    .getByRole("button", {
      name: "Discard production replacement",
      exact: true,
    })
    .click();
  const kept = await capture();
  if (
    kept.active.planFingerprint !== reviewed.active.planFingerprint ||
    kept.active.draft.replacement !== null
  )
    throw new Error("Discard changed the production run");
  await run({
    kind: "edit_production",
    draftDigest: kept.active.draft.digest,
    edit: { kind: "prepare_replacement", source: "preview" },
  });
  // Changing the draft invalidates the proposal before it can be confirmed.
  await chooseOption(page, page.getByLabel(/^Oven availability/), {
    value: "outage",
  });
  const invalidated = await capture();
  if (
    invalidated.active.draft.replacement !== null ||
    invalidated.active.planFingerprint !== reviewed.active.planFingerprint
  )
    throw new Error("An obsolete replacement survived a draft edit");
  await run({
    kind: "preview_production",
    draftDigest: invalidated.active.draft.digest,
  });
  const refreshed = await capture();
  // The operator's apply button prepares the same review over accepted results.
  await page
    .getByRole("button", {
      name: "Apply preview and prepare new requests",
      exact: true,
    })
    .click();
  const clickedReplacement = await capture();
  if (
    clickedReplacement.active.draft.replacement?.source !== "preview" ||
    clickedReplacement.surfaceEpoch !== refreshed.surfaceEpoch
  )
    throw new Error("Click apply bypassed replacement review");
  await page
    .getByRole("button", {
      name: "Confirm production replacement",
      exact: true,
    })
    .click();
  const replaced = await capture();
  if (
    replaced.active.planFingerprint !==
      refreshed.active.draft.preview.planFingerprint ||
    replaced.surfaceEpoch !== refreshed.surfaceEpoch + 1 ||
    replaced.active.draft.replacement !== null
  )
    throw new Error("Confirmed preview did not apply exactly once");
  await run({
    kind: "edit_production",
    draftDigest: replaced.active.draft.digest,
    edit: { kind: "prepare_replacement", source: "one-batch" },
  });
  const preset = await capture();
  if (
    preset.active.planFingerprint !== replaced.active.planFingerprint ||
    preset.active.draft.replacement?.proposedOperations !== 1
  )
    throw new Error("One-batch preset bypassed review");
  await page
    .getByRole("button", {
      name: "Confirm production replacement",
      exact: true,
    })
    .click();
  const oneBatch = await capture();
  if (
    oneBatch.active.draft.batchCount !== 1 ||
    oneBatch.active.draft.traysPerBatch !== 1 ||
    oneBatch.active.operationCount !== 1
  )
    throw new Error("One-batch preset did not apply");
  await chooseOption(
    page,
    page.locator(".production-rehearsal-preset .pantry-select-trigger"),
    { value: "procedure" },
  );
  await page
    .getByRole("button", { name: "Replace with preset", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Review production replacement", exact: true })
    .waitFor();
  const procedurePreset = await capture();
  if (
    procedurePreset.active.draft.replacement?.source !== "procedure" ||
    procedurePreset.active.operationCount !== 1
  )
    throw new Error("Click preset bypassed shared review");
  await page
    .getByRole("button", {
      name: "Confirm production replacement",
      exact: true,
    })
    .click();
  const restored = await capture();
  if (
    restored.active.operationCount !== initial.assignments.length ||
    restored.surfaceEpoch !== oneBatch.surfaceEpoch + 1
  )
    throw new Error(
      "Procedure preset did not restore the original shift capacity",
    );

  const staleView = await refused(
    {
      kind: "set_view",
      target: {
        surfaceSessionId: opened.surfaceSessionId,
        surfaceEpoch: opened.surfaceEpoch,
      },
      view: {
        selection: { kind: "operation", id: opened.active.operations[0].id },
        cursorSeconds: 0,
        playback: "paused",
      },
    },
    "stale_surface",
  );
  const afterStaleView = await capture();
  const stalePanel = await refused(
    {
      kind: "show_production_panel",
      panel: "files",
      target: {
        surfaceSessionId: opened.surfaceSessionId,
        surfaceEpoch: opened.surfaceEpoch,
      },
    },
    "stale_surface",
  );
  if ((await capture()).active.panel !== restored.active.panel)
    throw new Error("An old panel command changed the replacement run");
  if (
    JSON.stringify(afterStaleView.active.selection) !==
      JSON.stringify(restored.active.selection) ||
    afterStaleView.active.planFingerprint !== restored.active.planFingerprint
  )
    throw new Error("An old navigation moved the replacement run");
  const savedRunOpen = await verifySavedRunOpen(
    page,
    capture,
    run,
    refused,
    savedCopy,
    evidence,
  );
  return {
    result: "passed",
    savedRunOpen,
    transport:
      "controlled HTTP; real mounted route, effect bridge, production scheduler and browser MuJoCo",
    initialTrays: initial.assignments.length,
    execution,
    cancellation,
    replacement: {
      acceptedResults: proposed.active.draft.replacement.currentResults,
      discardPreservedRun: true,
      draftEditInvalidated: true,
      previewEpochs: [refreshed.surfaceEpoch, replaced.surfaceEpoch],
      oneBatchOperations: oneBatch.active.operationCount,
      restoredOperations: restored.active.operationCount,
    },
    edits,
    refused: {
      stale,
      pendingTask,
      staleView,
      stalePanel,
      staleShiftView,
    },
    shiftView: viewReset.active.view,
    cameras: {
      recording: recordingCamera,
      recordingFocus,
      recordingNavigation,
      doorInspection,
      rehearsal: rehearsalCamera,
      production: productionCamera,
      recordingOnly,
    },
    panels: {
      chat: timelinePanel.active.panel,
      click: "files",
      reviewPreserved: true,
    },
    navigation: {
      nativeOperation: nativeOperation.id,
      acceptedTask: settledTask.active.selection.id,
      resource: resourceView.active.selection.id,
      batch: navigated.active.selection.id,
      unchangedEpoch: navigated.surfaceEpoch,
    },
    preview: {
      planFingerprint: preview.planFingerprint,
      operationCount: preview.operationCount,
      epochs: [previewed.surfaceEpoch, applied.surfaceEpoch],
    },
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
          return `${item.outcome.result.command}:${item.outcome.result.kind}`;
        });
    }),
  };
}

async function verifyRecordingCameraFocus(
  page,
  capture,
  run,
  refused,
  evidence,
) {
  const workspace = page.locator(".physics-replay");
  const canvas = workspace.locator("canvas");
  const before = await capture();
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  const mask = workspace.locator(
    ".physics-header, .physics-controls, .physics-setup, .spatial-floor-plan, .spatial-inspection-panel, .spatial-view-controls",
  );
  await refused(
    {
      kind: "control_workspace_view",
      action: { kind: "setCamera", camera: "selection" },
    },
    "unsupported_command",
  );
  const views = [
    { camera: "cell", button: "Focus robot cell" },
    { camera: "task", button: "Selected task" },
    { camera: "operator", button: "Operator height · 1.6 m" },
    { camera: "inspectionOverhead", button: "Top view" },
  ];
  const matched = [];
  for (const view of views) {
    const controls =
      view.camera === "inspectionOverhead"
        ? workspace.locator(".spatial-inspection-panel")
        : workspace;
    await controls
      .getByRole("button", { name: view.button, exact: true })
      .click();
    if ((await capture()).active.view.camera !== view.camera)
      throw new Error(
        `${view.camera} click did not reach the attached context`,
      );
    const clickImage = await canvas.screenshot({
      mask: [mask],
      path: `${evidence}/recording-${view.camera}-click.png`,
    });
    await run({
      kind: "control_workspace_view",
      action: { kind: "resetCamera" },
    });
    const wholeScene = await canvas.screenshot({ mask: [mask] });
    await run({
      kind: "control_workspace_view",
      action: { kind: "setCamera", camera: view.camera },
    });
    const chatImage = await canvas.screenshot({
      mask: [mask],
      path: `${evidence}/recording-${view.camera}.png`,
    });
    if (wholeScene.equals(chatImage))
      throw new Error(`${view.camera} did not change the rendered camera`);
    if (!(await sameView(page, clickImage, chatImage)))
      throw new Error(`${view.camera} chat and click camera images differ`);
    await page.screenshot({
      path: `${evidence}/recording-${view.camera}-view.png`,
    });
    matched.push(view.camera);
  }
  await workspace
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Rack slot", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Focus selection", exact: true })
    .click();
  if ((await capture()).active.view.camera !== "selection")
    throw new Error("Selection focus click did not reach chat context");
  const selectedClick = await canvas.screenshot({ mask: [mask] });
  await run({
    kind: "control_workspace_view",
    action: { kind: "resetCamera" },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setCamera", camera: "selection" },
  });
  const selectedChat = await canvas.screenshot({
    mask: [mask],
    path: `${evidence}/recording-selection.png`,
  });
  if (!(await sameView(page, selectedClick, selectedChat)))
    throw new Error("Selected-equipment chat and click camera images differ");
  await page.screenshot({ path: `${evidence}/recording-selection-view.png` });
  matched.push("selection");
  await workspace
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await run({
    kind: "control_workspace_view",
    action: { kind: "resetCamera" },
  });
  const after = await capture();
  if (
    before.surfaceEpoch !== after.surfaceEpoch ||
    JSON.stringify({
      ...cameraRunState(before),
      selection: after.active.selection,
    }) !== JSON.stringify(cameraRunState(after))
  )
    throw new Error("Recording focus changed the source or playback");
  await openRecordingExamples(workspace);
  await workspace.getByRole("button", { name: /^Table to oven/ }).click();
  await workspace
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .click({ trial: true });
  const replacement = await capture();
  if (replacement.surfaceEpoch === before.surfaceEpoch)
    throw new Error(
      "Opening the replacement recording preserved the old epoch",
    );
  await refused(
    {
      kind: "control_workspace_view",
      target: {
        surfaceSessionId: before.surfaceSessionId,
        surfaceEpoch: before.surfaceEpoch,
      },
      action: { kind: "setCamera", camera: "cell" },
    },
    "stale_surface",
  );
  if (
    JSON.stringify(replacement.active) !==
    JSON.stringify((await capture()).active)
  )
    throw new Error("A stale camera request changed the replacement recording");
  return {
    matchedCameraImages: matched,
    preservedEpoch: after.surfaceEpoch,
    noSelectionRejected: true,
    staleRecordingRejected: true,
  };
}

async function verifyWorkspaceCamera(
  page,
  selector,
  capture,
  run,
  evidence,
  name,
) {
  const workspace = page.locator(selector);
  // The camera bar's Top view; the inspection panel has one of its own.
  const top = workspace
    .getByRole("group", { name: /^(3D camera|Camera controls)$/u })
    .getByRole("button", { name: "Top view", exact: true });
  await top.click({ trial: true });
  const before = await capture();
  await run({
    kind: "control_workspace_view",
    action: { kind: "setCamera", camera: "overhead" },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setCamera", camera: "overhead" },
  });
  if (
    (await top.getAttribute("aria-pressed")) !== "true" ||
    (await capture()).active.view.camera !== "overhead"
  )
    throw new Error(
      `${name} repeated overhead requests changed the requested camera`,
    );
  await page.screenshot({ path: `${evidence}/${name}-overhead.png` });
  const reset = workspace.getByRole("button", {
    name: name === "recording" ? "Show entire bakery" : "Recenter camera",
    exact: true,
  });
  await reset.click();
  if ((await capture()).active.view.camera !== "perspective")
    throw new Error(`${name} recenter click did not reach chat context`);
  await run({
    kind: "control_workspace_view",
    action: { kind: "resetCamera" },
  });
  await run({
    kind: "control_workspace_view",
    action: { kind: "resetCamera" },
  });
  const after = await capture();
  if (
    before.surfaceEpoch !== after.surfaceEpoch ||
    JSON.stringify(cameraRunState(before)) !==
      JSON.stringify(cameraRunState(after))
  )
    throw new Error(
      `${name} camera actions changed the run, selection, candidate or playback`,
    );
  return { view: after.active.view, preservedEpoch: after.surfaceEpoch };
}

function cameraRunState(context) {
  const { view, ...run } = context.active;
  return run;
}

async function verifyManualSimulationStop(
  page,
  capture,
  run,
  refused,
  evidence,
) {
  await page.evaluate(holdSimulationResults);
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await page.waitForFunction(heldSimulationResult, 1);
  const before = await capture();
  if (
    before.simulation === null ||
    !before.supportedCommands.includes("stop_simulation")
  )
    throw new Error(
      "The manually started operation was absent from chat context",
    );
  await run({ kind: "stop_simulation", simulation: before.simulation });
  const stopped = await capture();
  await page.evaluate(releaseHeldSimulationResults);
  const afterLateResult = await capture();
  if (
    stopped.simulation !== null ||
    afterLateResult.simulation !== null ||
    JSON.stringify(before.active) !== JSON.stringify(afterLateResult.active) ||
    before.surfaceEpoch !== afterLateResult.surfaceEpoch
  )
    throw new Error(
      "Stopping changed accepted work or allowed a late native result to commit",
    );
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await page.waitForFunction(heldSimulationResult, 2);
  const restarted = await capture();
  if (
    restarted.simulation === null ||
    restarted.simulation.generation === before.simulation.generation
  )
    throw new Error("Restart reused the cancelled execution identity");
  const stale = await refused(
    { kind: "stop_simulation", simulation: before.simulation },
    "stale_surface",
  );
  if (
    JSON.stringify((await capture()).simulation) !==
    JSON.stringify(restarted.simulation)
  )
    throw new Error("An old Stop cancelled the restarted operation");
  await page
    .getByRole("button", { name: "Stop simulation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .waitFor();
  await page.evaluate(releaseHeldSimulationResults);
  await page.evaluate(restoreSimulationWorker);
  const clicked = await capture();
  if (
    clicked.simulation !== null ||
    JSON.stringify(clicked.active) !== JSON.stringify(restarted.active) ||
    JSON.stringify(clicked.active.operations) !==
      JSON.stringify(before.active.operations)
  )
    throw new Error(
      "Clicked Stop changed the accepted run or failed to stop the current operation: " +
        JSON.stringify({
          simulation: clicked.simulation,
          differences: cameraStateDifferences(restarted.active, clicked.active),
        }),
    );
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Browser simulation stopped" })
    .waitFor();
  await page.screenshot({ path: `${evidence}/manual-simulation-stopped.png` });
  return {
    operationId: before.simulation.operationId,
    generations: [
      before.simulation.generation,
      restarted.simulation.generation,
    ],
    lateResultsIgnored: 2,
    acceptedWorkPreserved: true,
    stale,
  };
}

function installSimulationResultGate() {
  const fixture = window.chatParityAcceptance;
  fixture.nativeWorker = window.Worker;
  fixture.heldResults = [];
  fixture.holdingResults = false;
  class ResultGateWorker extends fixture.nativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", this.holdResult.bind(this));
    }
    // The engine worker answers each request in an envelope; the last reply
    // of a job is "job-completed".
    holdResult(event) {
      if (
        !fixture.holdingResults ||
        event.data?.reply?.kind !== "job-completed"
      )
        return;
      event.stopImmediatePropagation();
      fixture.heldResults.push({
        handler: this.onmessage,
        event,
        released: false,
      });
    }
  }
  window.Worker = ResultGateWorker;
}

function heldSimulationResult(count) {
  return window.chatParityAcceptance.heldResults.length >= count;
}

function releaseHeldSimulationResults() {
  for (const result of window.chatParityAcceptance.heldResults) {
    if (result.released) continue;
    result.released = true;
    result.handler(result.event);
  }
}

function holdSimulationResults() {
  window.chatParityAcceptance.holdingResults = true;
}

function restoreSimulationWorker() {
  window.chatParityAcceptance.holdingResults = false;
}

function cameraStateDifferences(before, after) {
  return Object.keys(before).filter(function changed(key) {
    return JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  });
}

async function verifyRecordingNavigation(
  page,
  capture,
  run,
  refused,
  evidence,
) {
  const workspace = page.locator(".physics-replay");
  await openRecordingExamples(workspace);
  await workspace.getByRole("button", { name: /^Oven → table → rack/ }).click();
  await workspace
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .click({ trial: true });
  const before = await capture();
  if (before.active.tasks.length !== 3 || before.active.selection !== null)
    throw new Error(
      "The new recording did not expose three transfers with cleared selection",
    );
  const matched = [];
  for (const task of before.active.tasks) {
    const button = workspace.getByRole("button", {
      name: new RegExp("^" + task.label + " ·"),
    });
    await button.click();
    const clicked = await capture();
    if (
      clicked.active.selection?.id !== task.id ||
      clicked.active.playback.playback !== "paused"
    )
      throw new Error(
        "Recorded transfer click did not select its exact identity and pause",
      );
    await run({
      kind: "set_view",
      view: {
        selection: { kind: "resource", id: "fr10-1" },
        cursorSeconds: 0,
        playback: "paused",
      },
    });
    await run({
      kind: "set_view",
      view: {
        selection: { kind: "task", id: task.id },
        cursorSeconds: clicked.active.playback.cursorSeconds,
        playback: "paused",
      },
    });
    if (
      JSON.stringify(clicked.active) !==
        JSON.stringify((await capture()).active) ||
      (await button.getAttribute("aria-pressed")) !== "true"
    )
      throw new Error("Chat and click recording navigation disagree");
    matched.push({ id: task.id, time: clicked.active.playback.cursorSeconds });
  }
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  const rack = workspace.getByRole("button", {
    name: "Rack slot",
    exact: true,
  });
  await rack.click();
  const selectedRack = await capture();
  if (selectedRack.active.selection?.id !== "rack-slot-1")
    throw new Error("Equipment click did not update attached selection");
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "resource", id: "source-table-1" },
      cursorSeconds: 12,
      playback: "paused",
    },
  });
  await run({
    kind: "set_view",
    view: {
      selection: { kind: "resource", id: "rack-slot-1" },
      cursorSeconds: selectedRack.active.playback.cursorSeconds,
      playback: "paused",
    },
  });
  if (
    (await rack.getAttribute("aria-pressed")) !== "true" ||
    JSON.stringify(selectedRack.active) !==
      JSON.stringify((await capture()).active)
  )
    throw new Error("Chat equipment selection did not reach the floor plan");
  await refused(
    {
      kind: "set_view",
      view: {
        selection: { kind: "task", id: "cold-tray:unrelated:transfer-1" },
        cursorSeconds: 0,
        playback: "paused",
      },
    },
    "target_not_found",
  );
  await refused(
    {
      kind: "set_view",
      view: {
        selection: { kind: "resource", id: "rack-slot-1" },
        cursorSeconds: 10000,
        playback: "paused",
      },
    },
    "target_not_found",
  );
  if ((await capture()).surfaceEpoch !== before.surfaceEpoch)
    throw new Error("Recording navigation replaced its source");
  await page.screenshot({ path: `${evidence}/recording-navigation.png` });
  await workspace
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  // Switching to an oven-only recording retires the exact task and rack identities.
  await openRecordingExamples(workspace);
  await workspace.getByRole("button", { name: /^Table to oven/ }).click();
  await workspace
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .click({ trial: true });
  const replacement = await capture();
  await refused(
    {
      kind: "set_view",
      target: {
        surfaceSessionId: before.surfaceSessionId,
        surfaceEpoch: before.surfaceEpoch,
      },
      view: {
        selection: { kind: "task", id: before.active.tasks[0].id },
        cursorSeconds: 0,
        playback: "paused",
      },
    },
    "stale_surface",
  );
  await refused(
    {
      kind: "set_view",
      view: {
        selection: { kind: "resource", id: "rack-slot-1" },
        cursorSeconds: 0,
        playback: "paused",
      },
    },
    "target_not_found",
  );
  if (
    JSON.stringify(replacement.active) !==
    JSON.stringify((await capture()).active)
  )
    throw new Error("Rejected navigation changed the replacement recording");
  return {
    transfers: matched,
    selectedResource: "rack-slot-1",
    unknownIdentityRejected: true,
    outOfRangeRejected: true,
    staleSourceRejected: true,
    replacementResourceRejected: true,
  };
}

async function openRecordingExamples(workspace) {
  await workspace.getByRole("tab", { name: "Examples", exact: true }).click();
}

async function verifyDoorInspection(page, capture, run, refused, evidence) {
  const workspace = page.locator(".physics-replay");
  const before = await capture();
  const original = await downloadRecording(page, workspace);
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  const door = workspace.locator(".spatial-door-inspection");
  await door.getByText("Inspect oven door", { exact: true }).click();
  const slider = door.getByRole("slider", {
    name: "Preview door angle (degrees)",
    exact: true,
  });
  const canvas = workspace.locator("canvas");
  const mask = workspace.locator(
    ".physics-header, .physics-controls, .physics-setup, .spatial-floor-plan, .spatial-inspection-panel, .spatial-view-controls",
  );
  const recorded = await canvas.screenshot({ mask: [mask] });
  const matched = [];
  for (const choice of [
    { key: "Home", degrees: 0 },
    { key: "End", degrees: 110 },
  ]) {
    await slider.press(choice.key);
    const clicked = await capture();
    if (
      clicked.active.view.doorInspection.kind !== "preview" ||
      clicked.active.view.doorInspection.degrees !== choice.degrees ||
      clicked.active.playback.playback !== "paused"
    )
      throw new Error("Door slider did not publish its exact paused preview");
    const clickImage = await canvas.screenshot({ mask: [mask] });
    await door
      .getByRole("button", {
        name: "Return to recorded door pose",
        exact: true,
      })
      .click();
    await waitForRecordedDoor(page);
    await run({
      kind: "control_workspace_view",
      action: { kind: "setDoorPreview", degrees: choice.degrees },
    });
    const chatImage = await canvas.screenshot({
      mask: [mask],
      path: `${evidence}/door-${choice.degrees}.png`,
    });
    if (
      recorded.equals(chatImage) ||
      !(await sameView(page, clickImage, chatImage))
    )
      throw new Error(
        "Door preview failed to change geometry or click/chat images differ",
      );
    await page.screenshot({
      path: `${evidence}/door-${choice.degrees}-view.png`,
    });
    matched.push(choice.degrees);
    await run({
      kind: "control_workspace_view",
      action: { kind: "setDoorPreview", degrees: null },
    });
    await waitForRecordedDoor(page);
  }
  await run({
    kind: "control_workspace_view",
    action: { kind: "setDoorPreview", degrees: 30 },
  });
  await run({ kind: "control_playback", action: { kind: "seek", seconds: 0 } });
  await waitForRecordedDoor(page);
  await run({ kind: "control_playback", action: { kind: "play" } });
  await run({
    kind: "control_workspace_view",
    action: { kind: "setDoorPreview", degrees: 45 },
  });
  const paused = await capture();
  if (paused.active.playback.playback !== "paused")
    throw new Error("Chat preview did not stop live playback");
  await run({ kind: "control_playback", action: { kind: "play" } });
  await run({ kind: "control_playback", action: { kind: "pause" } });
  await waitForRecordedDoor(page);
  await run({
    kind: "control_workspace_view",
    action: { kind: "setDoorPreview", degrees: 60 },
  });
  await waitForRecordedDoor(page);
  await run({
    kind: "control_workspace_view",
    action: { kind: "setDoorPreview", degrees: 20 },
  });
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  const previewExport = await downloadRecording(
    page,
    workspace,
    `${evidence}/door-preview-recording.json`,
  );
  if (!original.equals(previewExport))
    throw new Error("A door preview changed exported recording evidence");
  if ((await capture()).surfaceEpoch !== before.surfaceEpoch)
    throw new Error("Door inspection replaced the source recording");
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await canvas.evaluate(loseRecordingContext);
  await workspace.locator(".physics-floor-plan-only").waitFor();
  await waitForRecordedDoor(page);
  await workspace.locator(".spatial-door-inspection").waitFor();
  await run({
    kind: "control_workspace_view",
    action: { kind: "setDoorPreview", degrees: 30 },
  });
  if ((await capture()).active.view.doorInspection.degrees !== 30)
    throw new Error(
      "CPU floor-plan door preview did not reach the shared view state",
    );
  await workspace
    .locator(".spatial-door-inspection")
    .getByRole("slider", { name: "Preview door angle (degrees)", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/door-floor-plan.png` });
  // Replacing an inspected source also retires its inspector callbacks and pending commands.
  await workspace
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await openRecordingExamples(workspace);
  await workspace.getByRole("button", { name: /^Table to rack/ }).click();
  await workspace
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .click({ trial: true });
  const replacement = await capture();
  if (
    replacement.surfaceEpoch === before.surfaceEpoch ||
    replacement.active.view.doorInspection.kind !== "unavailable"
  )
    throw new Error("Replacing the oven recording retained its preview");
  await refused(
    {
      kind: "control_workspace_view",
      target: {
        surfaceSessionId: before.surfaceSessionId,
        surfaceEpoch: before.surfaceEpoch,
      },
      action: { kind: "setDoorPreview", degrees: 90 },
    },
    "stale_surface",
  );
  await refused(
    {
      kind: "control_workspace_view",
      action: { kind: "setDoorPreview", degrees: 90 },
    },
    "unsupported_command",
  );
  if (
    JSON.stringify(replacement.active) !==
    JSON.stringify((await capture()).active)
  )
    throw new Error("A refused door command changed the replacement recording");
  return {
    matchedDoorImages: matched,
    restoredAfter: [
      "restore",
      "seek",
      "play",
      "inspection close",
      "renderer loss",
      "source replacement",
    ],
    exportedEvidenceUnchanged: true,
    exportedBytes: original.length,
    cpuPreview: true,
    staleSourceRejected: true,
    rackRejected: true,
  };
}

async function waitForRecordedDoor(page) {
  await page.waitForFunction(async function recordedDoorRestored() {
    const context = await window.chatParityAcceptance.capture();
    return context.active.view.doorInspection.kind === "recorded";
  });
}

function loseRecordingContext(canvas) {
  const context = canvas.getContext("webgl2");
  const extension = context?.getExtension("WEBGL_lose_context");
  if (extension === null || extension === undefined)
    throw new Error("WebGL context loss is unavailable");
  extension.loseContext();
}

async function downloadRecording(page, workspace, path) {
  await workspace
    .getByRole("tab", { name: "Compare & files", exact: true })
    .click();
  const waiting = page.waitForEvent("download");
  await workspace
    .getByRole("button", { name: "Save recording only", exact: true })
    .click();
  const download = await waiting;
  if (path !== undefined) await download.saveAs(path);
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("The recording download has no data");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function captureSavedProduction(page, run, evidence) {
  await run({ kind: "show_production_panel", panel: "files" });
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const download = await waiting;
  await download.saveAs(`${evidence}/completed-production.json`);
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("Missing saved-run download");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return page.evaluate(installSavedRun, Buffer.concat(chunks).toString());
}

async function installSavedRun(file) {
  const { parseRunSnapshot } =
    await import("/@id/@purin-labs/bakery-model/bakery-run-snapshot");
  const { sha256Hex } = await import("/@id/@purin-labs/std");
  const body = {
    name: "Completed browser production",
    document: JSON.parse(file),
  };
  const snapshot = parseRunSnapshot(body);
  if (snapshot === null)
    throw new Error("Downloaded run failed boundary parsing");
  const summary = {
    id: await sha256Hex(snapshot.content),
    name: snapshot.name,
    kind: snapshot.kind,
    bytes: new TextEncoder().encode(snapshot.content).length,
    savedAt: new Date().toISOString(),
  };
  window.chatParityAcceptance.savedRuns = [{ body, summary }];
  return { ...summary, fingerprint: body.document.fingerprint };
}

async function verifySavedRunOpen(
  page,
  capture,
  run,
  refused,
  saved,
  evidence,
) {
  const listingSource = await capture();
  const first = await run({
    kind: "list_saved_runs",
    runKind: "production",
    cursor: null,
  });
  if (
    first.output.kind !== "saved_runs" ||
    first.output.page.snapshots.length !== 0 ||
    first.output.page.nextCursor === null
  )
    throw new Error("Filtered listing lost its continuation cursor");
  const second = await run({
    kind: "list_saved_runs",
    runKind: "production",
    cursor: first.output.page.nextCursor,
  });
  const observed = second.output.page.snapshots[0];
  if (observed?.id !== saved.id || second.output.page.nextCursor !== null)
    throw new Error("Listing did not expose the exact saved production copy");
  const afterListing = await capture();
  if (
    JSON.stringify(afterListing.active) !==
      JSON.stringify(listingSource.active) ||
    afterListing.surfaceEpoch !== listingSource.surfaceEpoch
  )
    throw new Error("Listing saved runs changed the workspace");
  const before = await capture();
  await run({ kind: "prepare_run_open", runKind: "production", id: saved.id });
  const chat = await capture();
  if (
    chat.active.planFingerprint !== before.active.planFingerprint ||
    chat.runOpenReview?.proposedFingerprint !== saved.fingerprint ||
    chat.runOpenReview?.proposedResults !== 5
  )
    throw new Error(
      "Preparing a saved copy changed the run or lost accepted results",
    );
  await page
    .getByRole("button", { name: "Keep current run", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Next saved runs", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Open ${saved.name}`, exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/saved-run-catalogue.png` });
  await page
    .getByRole("button", { name: `Open ${saved.name}`, exact: true })
    .click();
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .waitFor();
  if (
    !(await page
      .getByRole("heading", { name: "Review saved run", exact: true })
      .evaluate(isFocused))
  )
    throw new Error("Saved-run review did not receive keyboard focus");
  const clicked = await capture();
  if (
    JSON.stringify(clicked.runOpenReview) !== JSON.stringify(chat.runOpenReview)
  )
    throw new Error("Click and chat opened different saved-run reviews");
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/saved-run-review.png` });
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  const applied = await capture();
  if (
    applied.active.planFingerprint !== saved.fingerprint ||
    applied.runOpenReview !== null ||
    applied.active.pendingOperation !== null
  )
    throw new Error("Operator confirmation did not restore the accepted run");
  const reopened = await captureSavedProduction(page, run, evidence);
  if (reopened.id !== saved.id)
    throw new Error("Opening changed the exported run content");

  await page.evaluate(alterSavedContent, true);
  const altered = await refused(
    { kind: "prepare_run_open", runKind: "production", id: saved.id },
    "target_not_found",
  );
  await page.evaluate(alterSavedContent, false);
  await page.evaluate(holdSavedRead);
  const effectId = await page.evaluate(enqueueSavedOpen, saved.id);
  await page.waitForFunction(savedReadIsHeld);
  await run({
    kind: "edit_production",
    draftDigest: (await capture()).active.draft.digest,
    edit: {
      kind: "set_variant",
      variant: applied.active.draft.variant === "normal" ? "outage" : "normal",
    },
  });
  const edited = await capture();
  await page.evaluate(releaseSavedRead);
  await page.waitForFunction(savedOpenSettled, effectId);
  const rejected = await page.evaluate(readSavedOpenReceipt, effectId);
  const after = await capture();
  if (
    rejected.outcome.result.kind !== "rejected" ||
    rejected.outcome.result.code !== "stale_surface" ||
    after.runOpenReview !== null ||
    after.active.draft.digest !== edited.active.draft.digest ||
    after.active.planFingerprint !== applied.active.planFingerprint
  )
    throw new Error("A delayed saved copy overwrote a newer draft");
  return {
    id: observed.id,
    listing: { emptyFilteredPageContinued: true, workspaceUnchanged: true },
    acceptedResults: 5,
    exactExportPreserved: true,
    clickChatReviewEqual: true,
    operatorConfirmed: true,
    alteredContentRejected: altered,
    delayedReadRejected: true,
  };
}
function alterSavedContent(value) {
  window.chatParityAcceptance.changedSavedContent = value;
}
function holdSavedRead() {
  window.chatParityAcceptance.holdSavedRead = true;
}
function savedReadIsHeld() {
  return window.chatParityAcceptance.heldSavedRead !== null;
}
function releaseSavedRead() {
  window.chatParityAcceptance.holdSavedRead = false;
  window.chatParityAcceptance.heldSavedRead();
  window.chatParityAcceptance.heldSavedRead = null;
}
function enqueueSavedOpen(id) {
  return window.chatParityAcceptance.enqueue({
    kind: "prepare_run_open",
    runKind: "production",
    id,
  });
}
function savedOpenSettled(id) {
  return window.chatParityAcceptance.receipts.some(
    (item) => item.effectId === id,
  );
}
function readSavedOpenReceipt(id) {
  return window.chatParityAcceptance.receipts.find(
    (item) => item.effectId === id,
  );
}

function isFocused(element) {
  return document.activeElement === element;
}

async function serveParityStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css"; import "/src/workflow-demo.css";',
  });
}

// Two WebGL renders of one camera can differ by 1/255 in some colour values
// (shadow and anti-aliasing rounding). A person sees the same picture, so a
// view is the same when no value differs by more than 2/255.
async function sameView(page, first, second) {
  if (first.equals(second)) return true;
  return page.evaluate(comparePictures, [
    first.toString("base64"),
    second.toString("base64"),
  ]);
}

async function comparePictures([first, second]) {
  async function pixels(base64) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  }
  const [a, b] = await Promise.all([pixels(first), pixels(second)]);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++)
    if (Math.abs(a[index] - b[index]) > 2) return false;
  return true;
}
