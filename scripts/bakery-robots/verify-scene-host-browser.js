async function verifySceneHost(page) {
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.evaluate(async function observeSceneHost() {
    // The Portal loads this module on demand, and the resource timing buffer
    // keeps only the first 250 of Vite's module requests, so the journey
    // imports it by the path that the Portal uses: the same module instance.
    const { sourceUrl } = await import("/source-url.js");
    const { PhysicsSceneHost } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/spatial/physics-scene-host.ts",
      )
    );
    window.sceneHosts = new Set();
    const load = PhysicsSceneHost.prototype.load;
    PhysicsSceneHost.prototype.load = function observeLoad(element, source) {
      window.observedSceneHost = this;
      window.sceneHosts.add(this);
      return load.call(this, element, source);
    };
    window.visualGate = {
      hold: true,
      pending: [],
      started: 0,
      failNext: false,
    };
    // The visual bytes are fetched one time and then cached, so the gate
    // holds each scene's asset load, the step where its visuals arrive.
    const { PhysicsScene } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/spatial/physics-scene.ts",
      )
    );
    const loadAssets = PhysicsScene.prototype.load;
    PhysicsScene.prototype.load = async function holdVisual() {
      const gate = window.visualGate;
      if (gate.failNext) {
        gate.failNext = false;
        window.failedAssetScene = this;
        throw new Error("Synthetic visual asset failure");
      }
      if (gate.hold) {
        gate.started++;
        await new Promise(function waitForRelease(resolve) {
          gate.pending.push(resolve);
        });
      }
      return loadAssets.call(this);
    };
  });
  await openRecordingViewer(page);
  // The recording viewer: an example's first load, context loss and two
  // overlapping replacements keep one presentation and one pane.
  await page.getByRole("button", { name: /^Table to rack/ }).click();
  await page.waitForFunction(function visualIsHeld() {
    return window.visualGate.started === 1;
  });
  await page.evaluate(function releaseInitialLoad() {
    window.visualGate.hold = false;
    for (const resolve of window.visualGate.pending.splice(0)) resolve();
  });
  await page.waitForFunction(function sceneReady() {
    return window.observedSceneHost.life.kind === "ready";
  });
  await page.evaluate(function loseContext() {
    window.observedSceneHost.webgl.host.canvas.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
  });
  await page.waitForFunction(function fallbackReady() {
    return window.observedSceneHost.life.kind === "fallback";
  });
  await page.screenshot({
    path: "output/playwright/refactor-6/viewer-context-loss.png",
  });
  await page.evaluate(function beginReplacement() {
    const host = window.observedSceneHost;
    window.visualGate.hold = true;
    window.staleSceneLoad = host.load(host.element, host.source);
  });
  await page.waitForFunction(function replacementHeld() {
    return window.visualGate.started === 2;
  });
  await page.evaluate(async function replaceAgain() {
    const host = window.observedSceneHost;
    window.visualGate.hold = false;
    await host.load(host.element, host.source);
    window.winningScene = host.webgl;
    for (const resolve of window.visualGate.pending.splice(0)) resolve();
    await window.staleSceneLoad;
    if (host.webgl !== window.winningScene || host.life.kind !== "ready")
      throw new Error("Late load displaced the accepted presentation");
  });
  if ((await page.locator(".physics-replay .spatial-workspace").count()) !== 1)
    throw new Error("Scene replacement duplicated the persistent pane");
  await page.screenshot({
    path: "output/playwright/refactor-6/viewer-replacement.png",
  });
  await page.evaluate(function rememberRehearsalScene() {
    window.leavingRehearsalHost = window.observedSceneHost;
    window.leavingRehearsalScene = window.observedSceneHost.webgl;
  });
  await page
    .getByRole("button", { name: "Back to production", exact: true })
    .click();
  await page.waitForFunction(function rehearsalReleased() {
    return (
      window.leavingRehearsalHost.webgl === null &&
      window.leavingRehearsalScene.disposed
    );
  });
  await openRecordingViewer(page);
  await page.waitForFunction(function rehearsalReentered() {
    return window.observedSceneHost.life.kind === "ready";
  });
  await page.evaluate(async function mountOtherOwners() {
    const { sourceUrl } = await import("/source-url.js");
    const source = window.observedSceneHost.source;
    const { default: React } = await import("/@id/react");
    const { default: ReactDOM } = await import("/@id/react-dom/client");
    const { MemoryRouter } = await import("/@id/react-router");
    const { ProductionNativeScene } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/production-native-scene.tsx",
      )
    );
    const { RecordingCandidatePreview } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/recording-candidate-preview.tsx",
      )
    );
    const { compileWorkcellInput } =
      await import("/@id/@purin-labs/production-simulation/recipes/bakery/workcell-input");
    const { reserveWorkcell, settleWorkcell } =
      await import("/@id/@purin-labs/production-simulation/recipes/bakery/workcell-attempt");
    const { productionMaterialBinding } =
      await import("/@id/@purin-labs/production-simulation/recipes/bakery/production-material");
    const { parsePhysicsReplay } =
      await import("/@id/@purin-labs/bakery-model/bakery-physics");
    const originalContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function unavailableContext(
      kind,
      ...args
    ) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(kind)) return null;
      return originalContext.call(this, kind, ...args);
    };
    window.restoreOwnerWebGL = function restore() {
      HTMLCanvasElement.prototype.getContext = originalContext;
    };
    document.getElementById("root").remove();
    const host = document.createElement("main");
    host.id = "scene-owners";
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    function ignore() {}
    function captureProduction(component) {
      window.productionOwner = component;
    }
    function capturePreview(component) {
      window.previewOwner = component;
    }
    window.renderOwnerFixtures = function renderOwners() {
      const parsed = parsePhysicsReplay(JSON.stringify(source));
      if (parsed.kind !== "accepted") throw new Error(parsed.message);
      const recording = parsed.recording;
      const compiled = compileWorkcellInput(
        recording.request,
        "0",
        "cold-cell-1",
      );
      if (compiled.kind !== "ready")
        throw new Error(compiled.message ?? "Invalid owner fixture");
      const reserved = reserveWorkcell({ kind: "empty" }, compiled.input);
      const settled = settleWorkcell(reserved.attempt, recording);
      if (settled.kind !== "accepted")
        throw new Error(settled.message ?? "Cannot accept owner fixture");
      const task = {
        id: "batch:A:native:1",
        kind: "native",
        attended: false,
        batch: "A",
        station: "cool",
        start: 0,
        end: 30,
        outcome: "completed",
        recording,
        operation: {
          id: "operation-1",
          batchId: "A",
          tray: 1,
          workerId: "human-1",
          dependsOn: [],
          earliestStartSeconds: 0,
          material: productionMaterialBinding("A", 1),
          start: { kind: "reset" },
          attempt: settled.attempt,
          handoff: null,
        },
      };
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(ProductionNativeScene, {
            cameraView: { camera: "perspective", cameraResetRevision: 0 },
            task,
            time: 1,
            inspect: ignore,
            ref: captureProduction,
          }),
          React.createElement(RecordingCandidatePreview, {
            recording,
            ref: capturePreview,
          }),
        ),
      );
    };
    window.renderOwnerFixtures();
  });
  await page.getByText("Robot 3D unavailable.", { exact: false }).waitFor();
  await page.getByText("3D preview unavailable.", { exact: false }).waitFor();
  await page.evaluate(function replaceUnavailableOwners() {
    window.restoreOwnerWebGL();
    window.visualGate.hold = true;
    window.ownerHeldStart = window.visualGate.started;
    window.renderOwnerFixtures();
  });
  await page.waitForFunction(function bothOwnersHeld() {
    return window.visualGate.started >= window.ownerHeldStart + 2;
  });
  await page.evaluate(function replaceLoadingOwners() {
    window.visualGate.hold = false;
    window.renderOwnerFixtures();
    for (const resolve of window.visualGate.pending.splice(0)) resolve();
  });
  await page.waitForFunction(function ownersReady() {
    return (
      window.productionOwner.sceneHost.life.kind === "ready" &&
      window.previewOwner.sceneHost.life.kind === "ready" &&
      [...window.sceneHosts].some(function candidateReady(host) {
        return (
          host.element?.closest(".recording-candidate-preview") &&
          host.life.kind === "ready"
        );
      })
    );
  });
  await page.locator(".recording-candidate-preview canvas").waitFor();
  if ((await page.locator("#scene-owners .spatial-workspace").count()) !== 2)
    throw new Error("Nested owners duplicated their pane after replacement");
  await page.evaluate(function loseEveryOwnerContext() {
    const owners = [...window.sceneHosts].filter(function mountedOwner(host) {
      return host.element?.closest("#scene-owners");
    });
    if (owners.length !== 2) throw new Error("Expected two live owner hosts");
    for (const host of owners) {
      const scene = host.webgl;
      scene.host.canvas.dispatchEvent(
        new Event("webglcontextlost", { cancelable: true }),
      );
      if (
        host.life.kind !== "unavailable" ||
        !scene.disposed ||
        host.webgl !== null
      )
        throw new Error("Context loss did not release an owner's renderer");
    }
  });
  await page.getByText("Robot 3D unavailable.", { exact: false }).waitFor();
  await page.getByText("3D preview unavailable.", { exact: false }).waitFor();
  await page.evaluate(function reloadOwners() {
    window.renderOwnerFixtures();
  });
  await page.waitForFunction(function allOwnersReady() {
    const owners = [...window.sceneHosts].filter(function mountedOwner(host) {
      return host.element?.closest("#scene-owners");
    });
    return (
      owners.length === 2 &&
      owners.every(function ready(host) {
        return host.life.kind === "ready";
      })
    );
  });
  await page.evaluate(function holdOwnerLoad() {
    const host = window.previewOwner.sceneHost;
    window.previewSource = host.source;
    window.visualGate.hold = true;
    window.clearHeldStart = window.visualGate.started;
    window.clearedLoad = host.load(host.element, host.source);
  });
  await page.waitForFunction(function heldOwnerLoad() {
    return window.visualGate.started > window.clearHeldStart;
  });
  await page.evaluate(async function clearAndRelease() {
    const host = window.previewOwner.sceneHost;
    const scene = host.webgl;
    host.clear();
    window.visualGate.hold = false;
    for (const release of window.visualGate.pending.splice(0)) release();
    await window.clearedLoad;
    if (
      host.life.kind !== "empty" ||
      host.webgl !== null ||
      host.source !== null ||
      !scene.disposed
    )
      throw new Error(
        "A cleared load revived its renderer or retained its source",
      );
    await host.load(host.element, window.previewSource);
    if (host.life.kind !== "ready")
      throw new Error("Cleared host could not reenter");
  });
  await page.evaluate(function holdBeforeContextLoss() {
    const host = window.previewOwner.sceneHost;
    window.visualGate.hold = true;
    window.contextHeldStart = window.visualGate.started;
    window.lostContextLoad = host.load(host.element, window.previewSource);
  });
  await page.waitForFunction(function contextLoadHeld() {
    return window.visualGate.started > window.contextHeldStart;
  });
  await page.evaluate(async function contextLossRejectsLateLoad() {
    const host = window.previewOwner.sceneHost;
    const scene = host.webgl;
    scene.host.canvas.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
    window.visualGate.hold = false;
    for (const release of window.visualGate.pending.splice(0)) release();
    await window.lostContextLoad;
    if (
      host.life.kind !== "unavailable" ||
      host.webgl !== null ||
      !scene.disposed
    )
      throw new Error("Late assets revived a scene after context loss");
    await host.load(host.element, window.previewSource);
  });
  await page.evaluate(async function failedAssetLoadReleasesScene() {
    const host = window.previewOwner.sceneHost;
    window.visualGate.failNext = true;
    await host.load(host.element, window.previewSource);
    if (
      host.life.kind !== "unavailable" ||
      host.webgl !== null ||
      !window.failedAssetScene.disposed
    )
      throw new Error("Failed visual loading retained its renderer");
    await host.load(host.element, window.previewSource);
    if (host.life.kind !== "ready")
      throw new Error("Host could not recover after failed visual loading");
  });
  await page.screenshot({
    path: "output/playwright/refactor-6/scene-owners.png",
  });
  return {
    result: "passed",
    contextLossFallsBackToFloorPlan: true,
    lateLoadRejected: true,
    singlePane: true,
    leaveAndReenterReleasesScene: true,
    allOwnerContextLossReleasesRenderers: true,
    clearDuringLoadRejectsLateCompletion: true,
    failedAssetLoadReleasesScene: true,
    contextLossDuringLoadRejectsLateCompletion: true,
    allOwnersRecoverFromUnavailableAndLoadingReplacement: true,
  };
}
