async function verifyLiveApplianceMoveBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx*", liveMoveStyles);
  if (typeof page.routeWebSocket === "function") {
    await page.routeWebSocket(/.*/, filterViteFullReload);
  }
  await page.goto(
    `${new URL(page.url()).origin}/workflow-preview.html?conversation=plan81-move`,
  );
  await installLiveMoveHarness(page, 320);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 1. Option 1: Relocate Packing Table far across the shop BEFORE preparing the shift,
  // then prepare a bounded Bakery Shift (Financiers + Ginger Milk Tea) so Option 1
  // snapshots obstacle-avoiding floor-plan walk routes from t = 0.
  const initialLayoutSetup = await page.evaluate(setupInitialCustomFloorPlan);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page.getByLabel("Financier trays").fill("1");
  await page.getByLabel("Milk tea batches").fill("1");
  const routingDefault = await selectValue(
    page.getByLabel("Station walk routing"),
  );
  if (routingDefault !== "auto") {
    throw new Error(
      `Expected Station walk routing default 'auto', got ${routingDefault}`,
    );
  }
  await page
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();

  // Wait for the retained MuJoCo Wasm worker to advance past t = 2 s while running
  // with controlRevision === 0 (proving Option 1 baked the custom floor-plan routes
  // directly into the compiled scenario without needing a control command).
  const started = await waitPersistentState(page, {
    status: "running",
    minimumTime: 2000,
  });
  if (started.active.target.controlRevision !== 0) {
    throw new Error(
      `Expected controlRevision 0 after Option 1 start, got ${started.active.target.controlRevision}`,
    );
  }
  await page.screenshot({
    path: "01-option1-custom-initial-layout.png",
    animations: "disabled",
  });

  // 2. Option 2 (Live 3D move mid-run while advancing):
  // Move Oven and Hob on floorPlanWorkspace while the two-cell MuJoCo simulation is running.
  const midRunMove = await page.evaluate(moveStationsMidRun);
  const afterLiveMove = await waitPersistentState(page, {
    status: "running",
    revision: 1,
  });

  // 3. Agent Parity & Role-Check Authorization (Plan 81):
  // Pause via chat control, then propose move-equipment & rotate-equipment via BakerySurfaceEffectBridge.
  await sendPersistentControl(page, { kind: "pause" });
  await page.evaluate(setPersistentDrivePace, 0);
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  const paused = await waitPersistentState(page, { status: "paused" });

  const ovenPoseBeforeProposal = await page.evaluate(
    readAppliancePose,
    "station-oven",
  );
  const moveProposal = await sendPersistentControl(page, {
    kind: "move-equipment",
    applianceId: "station-oven",
    xMm: -1800,
    zMm: -900,
  });
  const ovenPoseWhilePending = await page.evaluate(
    readAppliancePose,
    "station-oven",
  );
  if (
    ovenPoseWhilePending.x !== ovenPoseBeforeProposal.x ||
    ovenPoseWhilePending.z !== ovenPoseBeforeProposal.z
  ) {
    throw new Error(
      "Preparing a chat move-equipment proposal moved the station before confirmation.",
    );
  }

  // Verify denied user (HTTP 403 on surface-effects) is refused on confirmation.
  await page.evaluate(persistentChatDeny, true);
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "authority could not be verified" })
    .waitFor();
  const afterDeniedConfirm = await page.evaluate(persistentChatCapture);
  if (
    afterDeniedConfirm.active.target.controlRevision !==
    paused.active.target.controlRevision
  ) {
    throw new Error("Denied confirmation mutated controlRevision.");
  }

  // Restore authority and confirm chat move-equipment.
  await page.evaluate(persistentChatDeny, false);
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  const afterChatMove = await waitPersistentState(page, {
    revision: paused.active.target.controlRevision + 1,
  });
  const ovenPoseAfterConfirm = await page.evaluate(
    readAppliancePose,
    "station-oven",
  );
  if (
    Math.hypot(
      ovenPoseAfterConfirm.x - ovenPoseBeforeProposal.x,
      ovenPoseAfterConfirm.z - ovenPoseBeforeProposal.z,
    ) < 0.25
  ) {
    throw new Error(
      `Confirmed chat move-equipment did not relocate station-oven: ${JSON.stringify(
        { ovenPoseBeforeProposal, ovenPoseAfterConfirm },
      )}`,
    );
  }

  // Propose and confirm chat rotate-equipment on station-packing.
  const packingBeforeRotate = await page.evaluate(
    readAppliancePose,
    "station-packing",
  );
  const rotateProposal = await sendPersistentControl(page, {
    kind: "rotate-equipment",
    applianceId: "station-packing",
  });
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  const afterChatRotate = await waitPersistentState(page, {
    revision: afterChatMove.active.target.controlRevision + 1,
  });
  const packingAfterRotate = await page.evaluate(
    readAppliancePose,
    "station-packing",
  );
  if (Math.abs(packingAfterRotate.rotY - packingBeforeRotate.rotY) < 0.5) {
    throw new Error(
      "Confirmed chat rotate-equipment did not rotate station-packing.",
    );
  }

  // Verify stale controlRevision refusal for move-equipment.
  const staleEffect = await page.evaluate(persistentChatEnqueue, {
    control: {
      kind: "move-equipment",
      applianceId: "station-oven",
      xMm: 0,
      zMm: 0,
    },
    production: paused.active.target,
  });
  const staleReceipt = await waitPersistentReceipt(page, staleEffect.effectId);
  if (staleReceipt.outcome.result.kind !== "rejected") {
    throw new Error("Stale move-equipment revision was accepted.");
  }

  await page.screenshot({
    path: "02-chat-move-and-rotate-confirmed.png",
    animations: "disabled",
  });

  // 4. Save the paused run, reload the browser, import the save (validating all
  // worker & state invariants across update-worker-travel commands), inspect the
  // snapshot via chat, continue in a fresh Wasm worker, record operator inspections,
  // and run the entire shift to completion!
  const savePath = `${globalThis.bakeryEvidence}/saved-live-appliance-move-run.json`;
  await downloadCurrentSave(page, savePath);
  const savedTarget = afterChatRotate.active.target;

  await page.reload();
  await installLiveMoveHarness(page, 0);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByLabel("Open recipe, oven route or saved production run")
    .setInputFiles(savePath);

  const snapshot = await waitPersistentState(page, { snapshot: true });
  if (
    snapshot.supportedCommands.length !== 1 ||
    snapshot.supportedCommands[0] !== "inspect_surface"
  ) {
    throw new Error("Snapshot inspection exposed execution authority.");
  }
  const inspectEffect = await page.evaluate(persistentChatEnqueue, {
    kind: "inspect_surface",
  });
  const inspectionReceipt = await waitPersistentReceipt(
    page,
    inspectEffect.effectId,
  );
  if (
    inspectionReceipt.outcome.result.kind !== "succeeded" ||
    inspectionReceipt.outcome.result.surface.context.active.kind !==
      "persistent-snapshot"
  ) {
    throw new Error("The saved snapshot could not be inspected through chat.");
  }
  const snapshotMoveRefusalEffect = await page.evaluate(persistentChatEnqueue, {
    control: {
      kind: "move-equipment",
      applianceId: "station-oven",
      xMm: 500,
      zMm: 500,
    },
    production: savedTarget,
  });
  const snapshotMoveRefusal = await waitPersistentReceipt(
    page,
    snapshotMoveRefusalEffect.effectId,
  );
  if (snapshotMoveRefusal.outcome.result.kind !== "rejected") {
    throw new Error("A saved snapshot accepted move-equipment control.");
  }

  // Continue saved run: openResumable validates state & worker invariants and
  // continueRun resumes in a fresh execution worker.
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();

  const { completed, inspectionsRecorded } =
    await driveRestoredShiftToCompletion(page, savedTarget);

  const finalSavePath = `${globalThis.bakeryEvidence}/completed-live-appliance-move-run.json`;
  await downloadCurrentSave(page, finalSavePath);

  await page.screenshot({
    path: "03-restored-run-completed.png",
    animations: "disabled",
  });

  return {
    result: "passed",
    hasWebGL: true,
    initialLayoutSetup,
    midRunMove,
    revisions: {
      started: started.active.target.controlRevision,
      afterLiveMove: afterLiveMove.active.target.controlRevision,
      paused: paused.active.target.controlRevision,
      afterChatMove: afterChatMove.active.target.controlRevision,
      afterChatRotate: afterChatRotate.active.target.controlRevision,
      completed: completed.active.target.controlRevision,
    },
    timesUs: {
      started: started.active.time,
      afterLiveMove: afterLiveMove.active.time,
      pausedBeforeSave: afterChatRotate.active.time,
      completed: completed.active.time,
    },
    inspectionsRecorded,
    ovenPoseBeforeProposal,
    ovenPoseAfterConfirm,
    packingBeforeRotate,
    packingAfterRotate,
    moveProposalReceiptDigest: moveProposal.receipt.resultDigest,
    rotateProposalReceiptDigest: rotateProposal.receipt.resultDigest,
    staleRevisionRejected: staleReceipt.outcome.result.code,
    snapshotMoveRejected: snapshotMoveRefusal.outcome.result.code,
    deniedAuthorityBlocked: true,
    freshExecutionIsolated: true,
    savedArtifacts: [savePath, finalSavePath],
  };
}

async function downloadCurrentSave(page, targetPath) {
  const saveTab = page
    .getByRole("group", { name: "Detail panels", exact: true })
    .getByRole("button", { name: "Save", exact: true });
  if ((await saveTab.getAttribute("aria-expanded")) !== "true") {
    await saveTab.click();
  }
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download save file", exact: true })
    .click();
  await (await downloadPromise).saveAs(targetPath);
}

async function driveRestoredShiftToCompletion(page, savedTarget) {
  let verifiedIsolation = false;
  let inspectionsRecorded = 0;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const context = await page.evaluate(persistentChatCapture);
    if (context?.active.kind === "persistent") {
      if (!verifiedIsolation) {
        if (
          context.active.target.runId !== savedTarget.runId ||
          context.active.target.executionId === savedTarget.executionId ||
          context.active.target.hostSession === savedTarget.hostSession
        ) {
          throw new Error(
            "Fresh continuation did not isolate execution authority.",
          );
        }
        verifiedIsolation = true;
      }
      if (context.active.status === "completed") {
        return { completed: context, inspectionsRecorded };
      }
      if (context.active.status === "awaiting-inspection") {
        const logisticsTab = page
          .getByRole("group", { name: "Detail panels", exact: true })
          .getByRole("button", { name: "Logistics", exact: true });
        if ((await logisticsTab.getAttribute("aria-expanded")) !== "true") {
          await logisticsTab.click();
        }
        await page
          .getByLabel("Inspection observation", { exact: true })
          .fill(
            `Accepted inspection #${inspectionsRecorded + 1} after live equipment relocation.`,
          );
        await page
          .locator('li[data-inspection-state="pending"]')
          .first()
          .getByRole("button", { name: "Accept", exact: true })
          .click();
        inspectionsRecorded += 1;
        await page.waitForTimeout(150);
        continue;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    "Restored shift did not reach completed status within timeout.",
  );
}

function filterViteFullReload(ws) {
  const server = ws.connectToServer();
  server.onMessage((message) => {
    if (typeof message === "string" && message.includes('"full-reload"')) {
      return;
    }
    ws.send(message);
  });
}

async function liveMoveStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}

async function installLiveMoveHarness(page, paceDriveMs) {
  for (const helper of [
    persistentChatFetch,
    persistentChatCapture,
    persistentChatEnqueue,
    persistentChatReceipt,
    persistentChatDeny,
    persistentChatMutation,
    persistentChatReveal,
    persistentEffectUnsettled,
    setPersistentDrivePace,
    setupInitialCustomFloorPlan,
    moveStationsMidRun,
    readAppliancePose,
  ]) {
    await page.addScriptTag({ content: helper.toString() });
  }
  await page.evaluate(mountLiveMoveApp, paceDriveMs);
}

async function mountLiveMoveApp(paceDriveMs) {
  const { sourceUrl } = await import("/source-url.js");
  if (!window.__pacedWorkerPostMessage) {
    const origPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function pacedPostMessage(message, ...rest) {
      const delay = window.persistentChat?.paceDriveMs ?? 0;
      if (
        delay > 0 &&
        message &&
        typeof message === "object" &&
        message.request &&
        message.request.kind === "drive"
      ) {
        const singleTurnMessage = {
          ...message,
          request: { ...message.request, turns: 1 },
        };
        setTimeout(
          () => origPostMessage.call(this, singleTurnMessage, ...rest),
          delay,
        );
        return;
      }
      return origPostMessage.call(this, message, ...rest);
    };
    window.__pacedWorkerPostMessage = true;
  }
  const [
    { default: React },
    { default: ReactDOM },
    { MemoryRouter },
    { default: Route },
    { BakerySurfaceEffectBridge },
    bakerySurfaceModule,
    bakeryRegistryModule,
    floorPlanModule,
    layoutModule,
    morningShiftModule,
  ] = await Promise.all([
    import("/@id/react"),
    import("/@id/react-dom/client"),
    import("/@id/react-router"),
    import(sourceUrl("areas/kitchen/ui/features/workflow-simulator/route.tsx")),
    import(
      sourceUrl("areas/kitchen/ui/features/bakery-surface-effect-bridge.tsx")
    ),
    import("/@id/@purin-labs/bakery-model/bakery-surface"),
    import(sourceUrl("areas/kitchen/ui/features/bakery-surface-registry.ts")),
    import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/floor-plan-workspace.ts",
      )
    ),
    import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/bakery-appliance-layout.ts",
      )
    ),
    import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/morning-shift-appliances.ts",
      )
    ),
  ]);
  window.persistentChat = {
    effects: [],
    receipts: [],
    denied: false,
    paceDriveMs: paceDriveMs ?? 0,
    originalFetch: window.fetch.bind(window),
    modules: {
      bakerySurfaceModule,
      bakeryRegistryModule,
      floorPlanModule,
      layoutModule,
      morningShiftModule,
    },
  };
  window.fetch = persistentChatFetch;
  document.cookie = "pantry_csrf=plan81-move; path=/";
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Route, {
          connection: {
            kind: "workspace",
            organisationId: "plan81-move",
            canManage: true,
            mutate: persistentChatMutation,
          },
        }),
        React.createElement(BakerySurfaceEffectBridge, {
          organisationId: "plan81-move",
          active: true,
          reveal: persistentChatReveal,
        }),
      ),
    ),
  );
}

function setPersistentDrivePace(ms) {
  if (window.persistentChat) window.persistentChat.paceDriveMs = ms;
}

async function setupInitialCustomFloorPlan() {
  const { floorPlanWorkspace } = window.persistentChat.modules.floorPlanModule;
  const { moveApplianceWithCollisions } =
    window.persistentChat.modules.layoutModule;
  const { MORNING_SHIFT_STATIONS } =
    window.persistentChat.modules.morningShiftModule;
  const planId = floorPlanWorkspace.getActivePlan();
  floorPlanWorkspace.resetPlacements(planId);
  const peers = MORNING_SHIFT_STATIONS.map((s) => s.id);
  const before = floorPlanWorkspace.getPose(planId, "station-packing");
  moveApplianceWithCollisions(planId, "station-packing", -3.4, 2.1, peers);
  const after = floorPlanWorkspace.getPose(planId, "station-packing");
  return {
    planId,
    hasCustomPlacements: floorPlanWorkspace.hasCustomPlacements(planId),
    packingBefore: before,
    packingAfter: after,
  };
}

async function moveStationsMidRun() {
  const { floorPlanWorkspace } = window.persistentChat.modules.floorPlanModule;
  const { moveApplianceWithCollisions } =
    window.persistentChat.modules.layoutModule;
  const { MORNING_SHIFT_STATIONS } =
    window.persistentChat.modules.morningShiftModule;
  const planId = floorPlanWorkspace.getActivePlan();
  const peers = MORNING_SHIFT_STATIONS.map((s) => s.id);
  const ovenBefore = floorPlanWorkspace.getPose(planId, "station-oven");
  moveApplianceWithCollisions(planId, "station-oven", 3.1, 1.9, peers);
  moveApplianceWithCollisions(planId, "station-hob", 1.2, 2.0, peers);
  const ovenAfter = floorPlanWorkspace.getPose(planId, "station-oven");
  return { planId, ovenBefore, ovenAfter };
}

async function readAppliancePose(id) {
  const { floorPlanWorkspace } = window.persistentChat.modules.floorPlanModule;
  return floorPlanWorkspace.getPose(floorPlanWorkspace.getActivePlan(), id);
}

async function persistentChatFetch(input, init) {
  const fixture = window.persistentChat;
  const url = new URL(
    typeof input === "string" ? input : input.url,
    location.origin,
  );
  if (url.pathname.endsWith("/chat/surface-effects"))
    return fixture.denied
      ? Response.json({ error: "denied" }, { status: 403 })
      : Response.json({ ok: true, effects: fixture.effects });
  if (url.pathname.endsWith("/receipt")) {
    const receipt = JSON.parse(init.body).receipt;
    fixture.receipts.push(receipt);
    fixture.effects = fixture.effects.filter(
      persistentEffectUnsettled.bind(null, receipt.effectId),
    );
    return Response.json({ ok: true });
  }
  if (url.pathname.endsWith("/bakery/runs")) {
    return Response.json({ ok: true, runs: [] });
  }
  if (url.pathname.endsWith("/commerce/published-resources")) {
    return Response.json({ ok: true, resources: [] });
  }
  return fixture.originalFetch(input, init);
}

async function persistentChatCapture() {
  const { bakerySurfaceForOrganisation } =
    window.persistentChat.modules.bakeryRegistryModule;
  const surface = bakerySurfaceForOrganisation("plan81-move");
  return surface === null ? null : (await surface.capture()).context;
}

async function persistentChatEnqueue(input) {
  const context = await persistentChatCapture();
  const { createBakerySurfaceEffect } =
    window.persistentChat.modules.bakerySurfaceModule;
  const effect = await createBakerySurfaceEffect({
    effectId: `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`,
    dispatchId: crypto.randomUUID(),
    deadlineAt: Date.now() + 60000,
    command:
      input.kind === "inspect_surface"
        ? {
            schemaVersion: 1,
            kind: "inspect_surface",
            target: {
              surfaceSessionId: context.surfaceSessionId,
              surfaceEpoch: context.surfaceEpoch,
            },
          }
        : {
            schemaVersion: 1,
            kind: "prepare_production_control",
            target: {
              surfaceSessionId: context.surfaceSessionId,
              surfaceEpoch: context.surfaceEpoch,
            },
            production: input.production ?? context.active.target,
            control: input.control,
          },
  });
  window.persistentChat.effects.push({ effect });
  return effect;
}

function persistentChatReceipt(effectId) {
  for (const receipt of window.persistentChat.receipts)
    if (receipt.effectId === effectId) return receipt;
  return null;
}

async function sendPersistentControl(page, control) {
  const effect = await page.evaluate(persistentChatEnqueue, { control });
  const receipt = await waitPersistentReceipt(page, effect.effectId);
  if (
    receipt.outcome.kind !== "completed" ||
    receipt.outcome.result.kind !== "succeeded"
  )
    throw new Error(`Control proposal refused: ${JSON.stringify(receipt)}`);
  await page
    .getByRole("region", {
      name: "Reviewed chat production control",
      exact: true,
    })
    .waitFor();
  return { effect, receipt };
}

async function waitPersistentReceipt(page, id) {
  await page.waitForFunction(persistentChatReceipt, id);
  return page.evaluate(persistentChatReceipt, id);
}

async function waitPersistentState(page, expected) {
  const deadline = Date.now() + 60000;
  let lastSummary = null;
  while (Date.now() < deadline) {
    const context = await page.evaluate(persistentChatCapture);
    lastSummary =
      context === null
        ? null
        : {
            kind: context.active.kind,
            status: context.active.status,
            time: context.active.time,
            revision: context.active.target?.controlRevision,
          };
    if (expected.snapshot && context?.active.kind === "persistent-snapshot")
      return context;
    if (
      context?.active.kind === "persistent" &&
      (expected.status === undefined ||
        context.active.status === expected.status) &&
      (expected.minimumTime === undefined ||
        context.active.time >= expected.minimumTime) &&
      (expected.revision === undefined ||
        context.active.target.controlRevision === expected.revision)
    )
      return context;
    await page.waitForTimeout(60);
  }
  throw new Error(
    `Persistent state did not reach ${JSON.stringify(expected)}; last=${JSON.stringify(lastSummary)}`,
  );
}

function persistentChatDeny(denied) {
  window.persistentChat.denied = denied;
}
async function persistentChatMutation() {
  throw new Error("Unexpected shared mutation.");
}
async function persistentChatReveal() {}
function persistentEffectUnsettled(id, pending) {
  return pending.effect.effectId !== id;
}
