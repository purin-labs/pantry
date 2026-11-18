// Run through browser-acceptance.mjs. This journey uses the real room controls,
// scene, collision solver and persisted preferences. No service fake supplies outcomes.
function captureStoreUpdate(frame) {
  const probe = window.storeLayoutProbe;
  probe.scene = this;
  return probe.update.call(this, frame);
}

async function installStoreProbe() {
  const urls = {};
  for (const entry of performance.getEntriesByType("resource")) {
    for (const name of [
      "scene",
      "floor-plan-workspace",
      "store-interior-design",
      "bakery-room",
      "bakery-appliance-layout",
      "shift-layout",
    ]) {
      if (
        entry.name.includes(`/workflow-simulator/${name}.ts`) ||
        entry.name.includes(`/floor/${name}.ts`)
      )
        urls[name] = entry.name;
    }
  }
  const { BakeryScene } = await import(urls.scene);
  const { floorPlanWorkspace } = await import(urls["floor-plan-workspace"]);
  const interior = await import(urls["store-interior-design"]);
  const { BAKERY_FLOOR_PLANS } = await import(urls["bakery-room"]);
  const layout = await import(urls["bakery-appliance-layout"]);
  const shiftLayout = await import(urls["shift-layout"]);
  window.storeLayoutProbe = {
    workspace: floorPlanWorkspace,
    interior,
    plans: BAKERY_FLOOR_PLANS,
    layout,
    shiftLayout,
    update: BakeryScene.prototype.update,
    scene: null,
    disposedTextures: new Map(),
  };
  BakeryScene.prototype.update = captureStoreUpdate;
  return interior.getStoreInteriorDesign();
}

function retainStoreModuleTimings() {
  performance.setResourceTimingBufferSize(5000);
}

function invalidStorePreference() {
  localStorage.setItem(
    "satyr:bakery-interior-design:v1",
    JSON.stringify({
      preset: "missing-preset",
      floorMaterial: "missing-floor",
      wallMaterial: "missing-wall",
      fixtureFinish: "aged-brass",
      lightingStyle: "brass-pendants",
      wallHeightMode: "full",
      showFurnishings: true,
    }),
  );
}

function readAppliance(id) {
  const { workspace, scene } = window.storeLayoutProbe;
  const plan = workspace.getActivePlan();
  const pose = workspace.getPose(plan, id);
  const model = scene.stationModels.get(id);
  const hood = scene.customFloorShell.root.getObjectByName(
    "canopy-exhaust-hood",
  );
  return {
    pose,
    model:
      model === undefined
        ? null
        : { x: model.position.x, z: model.position.z, rotY: model.rotation.y },
    hood: { x: hood.position.x, z: hood.position.z, rotY: hood.rotation.y },
  };
}

function readOpening(id) {
  const { scene, workspace } = window.storeLayoutProbe;
  const shell = scene.customFloorShell;
  const element = document.querySelector(
    `.workflow-scene [data-opening="${id}"]`,
  );
  const leaves = [];
  let progress = null;
  for (const visual of shell.openings) {
    const opening = visual.opening;
    const key =
      opening.kind === "door"
        ? `door:${opening.door.id}`
        : `window:${opening.window.id}`;
    if (key !== id) continue;
    progress = workspace.progress(opening);
    const width =
      visual.kind === "door"
        ? opening.door.width
        : visual.pivot.children[0].position.x * 2;
    visual.pivot.updateWorldMatrix(true, false);
    const endpoint = visual.pivot.localToWorld(
      visual.pivot.position.clone().set(width, 0, 0),
    );
    const leaf =
      visual.kind === "door"
        ? element.querySelector(".spatial-room-door-leaf")
        : element.querySelectorAll(".spatial-room-window-sash")[visual.panel];
    leaves.push({
      x: endpoint.x,
      z: endpoint.z,
      svgX: Number(leaf.getAttribute("x2")),
      svgZ: Number(leaf.getAttribute("y2")),
    });
  }
  return { progress, focused: document.activeElement === element, leaves };
}

function openingClientPoint(id) {
  const { scene } = window.storeLayoutProbe;
  for (const visual of scene.customFloorShell.openings) {
    if (visual.kind !== "door" || `door:${visual.opening.door.id}` !== id)
      continue;
    visual.pivot.updateWorldMatrix(true, false);
    const point = visual.pivot.localToWorld(
      visual.pivot.position.clone().set(visual.opening.door.width / 2, 0, 0),
    );
    point.project(scene.camera);
    const bounds = scene.renderer.domElement.getBoundingClientRect();
    return {
      x: bounds.left + ((point.x + 1) * bounds.width) / 2,
      y: bounds.top + ((1 - point.y) * bounds.height) / 2,
    };
  }
  throw new Error("The door has no 3D pointer target.");
}

function invalidDisposalCount(count) {
  return count !== 1;
}

function observeTextureDisposal(event) {
  const disposed = window.storeLayoutProbe.disposedTextures;
  disposed.set(event.target.uuid, (disposed.get(event.target.uuid) ?? 0) + 1);
}

function watchShellTextures() {
  const { scene } = window.storeLayoutProbe;
  const textures = new Set();
  for (const object of scene.customFloorShell.root.getObjectsByProperty(
    "isObject3D",
    true,
  )) {
    if (object.material === undefined) continue;
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture === true) textures.add(value);
      }
    }
  }
  const ids = [];
  for (const texture of textures) {
    ids.push(texture.uuid);
    texture.addEventListener("dispose", observeTextureDisposal);
  }
  return { ids, memory: scene.renderer.info.memory.textures };
}

function disposalCounts(ids) {
  const counts = [];
  for (const id of ids)
    counts.push(window.storeLayoutProbe.disposedTextures.get(id) ?? 0);
  return counts;
}

function seedCrowdedRoom() {
  const { workspace } = window.storeLayoutProbe;
  workspace.resetPlacements("kinshicho-61146");
  workspace.setPoses("kinshicho-61146", [
    { id: "stage", x: -0.2, z: -2.2, rotY: 0 },
    { id: "portion", x: -0.2, z: -1.1, rotY: 0 },
    { id: "bake", x: 1, z: -1.1, rotY: 0 },
    { id: "pack", x: -1.4, z: -1.1, rotY: 0 },
    { id: "robot-cell", x: -1.3, z: 0.2, rotY: 0 },
    { id: "decor-bench", x: 0, z: 0.2, rotY: 0 },
    { id: "decor-vitrine", x: 1.3, z: 0.2, rotY: 0 },
    { id: "cool", x: -1.4, z: -2.2, rotY: 0 },
    { id: "decor-planter", x: 0.75, z: -2.2, rotY: 0 },
  ]);
}

function nearStoreValue(value, expected) {
  return Math.abs(value - expected) < 0.00001;
}

function assertOpeningMatches(sample) {
  if (sample.leaves.length === 0)
    throw new Error("The opening has no visible leaves.");
  for (const leaf of sample.leaves) {
    if (
      !nearStoreValue(leaf.x, leaf.svgX) ||
      !nearStoreValue(leaf.z, leaf.svgZ)
    ) {
      throw new Error(
        `The SVG leaf and 3D leaf disagree: ${JSON.stringify(leaf)}`,
      );
    }
  }
}

async function selectStoreRoom(page, label) {
  await page.getByRole("button", { name: /^Floor plan room:/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(label) }).click();
}

async function selectStoreTheme(page, label) {
  await page
    .getByRole("button", {
      name: "Store interior design & materials",
      exact: true,
    })
    .click();
  await page.getByRole("menuitemradio", { name: new RegExp(label) }).click();
}

function storeSceneReady() {
  return (
    document.querySelector('button[aria-label="Top view"]')?.disabled === false
  );
}

async function verifyStoreLayoutBrowser(page) {
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(retainStoreModuleTimings);
  await page.evaluate(invalidStorePreference);
  await page.reload();
  await page.getByRole("button", { name: "Top view", exact: true }).waitFor();
  await page.waitForFunction(storeSceneReady);
  await page.evaluate(
    `void (window.captureStoreUpdate = (${captureStoreUpdate.toString()}))`,
  );
  await page.evaluate(
    `void (window.observeTextureDisposal = (${observeTextureDisposal.toString()}))`,
  );
  const recovered = await page.evaluate(installStoreProbe);
  if (
    recovered.wallMaterial !== "limewash-hinoki" ||
    recovered.preset !== "kuramae-artisan"
  ) {
    throw new Error(
      "Invalid persisted preferences did not recover to the default theme.",
    );
  }
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  await page.waitForFunction("window.storeLayoutProbe.scene !== null");
  if (
    !(await page.locator(".workflow-scene .spatial-floor-plan").isVisible())
  ) {
    await page.getByRole("button", { name: "Floor plan", exact: true }).click();
  }
  const map = page.locator(".workflow-scene .spatial-floor-map");
  await map.locator('button[data-resource="bake"]').waitFor();
  const evidence =
    globalThis.bakeryEvidence ?? "output/playwright/store-layout";
  const doorId = "door:door-east-side";
  const door = map.locator(`[data-opening="${doorId}"]`);
  await door.focus();
  await door.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${doorId}").progress > 0 && (${readOpening.toString()})("${doorId}").progress < 1`,
    null,
    { polling: "raf" },
  );
  await door.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${doorId}").progress === 0`,
    null,
    { polling: "raf" },
  );
  const reversed = await page.evaluate(readOpening, doorId);
  if (!reversed.focused)
    throw new Error("Door animation discarded keyboard focus.");
  assertOpeningMatches(reversed);
  await door.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${doorId}").progress === 1`,
    null,
    { polling: "raf" },
  );
  const openDoor = await page.evaluate(readOpening, doorId);
  assertOpeningMatches(openDoor);
  const windowId = "window:window-south-storefront";
  const window = map.locator(`[data-opening="${windowId}"]`);
  await window.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${windowId}").progress === 1`,
    null,
    { polling: "raf" },
  );
  const openWindow = await page.evaluate(readOpening, windowId);
  assertOpeningMatches(openWindow);
  await page.screenshot({ path: `${evidence}/openings.png` });

  await page.getByRole("button", { name: "Top view", exact: true }).click();
  const doorPoint = await page.evaluate(openingClientPoint, doorId);
  await page.mouse.click(doorPoint.x, doorPoint.y);
  await page.waitForFunction(
    `(${readOpening.toString()})("${doorId}").progress === 0`,
    null,
    { polling: "raf" },
  );
  const closedFrom3D = await page.evaluate(readOpening, doorId);
  assertOpeningMatches(closedFrom3D);
  await door.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${doorId}").progress === 1`,
    null,
    { polling: "raf" },
  );

  const oven = map.locator('button[data-resource="bake"]');
  const before = await page.evaluate(readAppliance, "bake");
  await oven.click();
  await oven.press("r");
  const rotated = await page.evaluate(readAppliance, "bake");
  if (
    !nearStoreValue(Math.abs(rotated.pose.rotY - before.pose.rotY), Math.PI / 2)
  ) {
    throw new Error("Rotate did not turn the oven exactly once.");
  }
  for (const part of [rotated.model, rotated.hood]) {
    if (
      part === null ||
      !nearStoreValue(part.x, rotated.pose.x) ||
      !nearStoreValue(part.z, rotated.pose.z) ||
      !nearStoreValue(part.rotY, rotated.pose.rotY)
    ) {
      throw new Error(
        "The oven and exhaust hood do not share the accepted pose.",
      );
    }
  }
  await page.screenshot({ path: `${evidence}/rotated-oven.png` });

  const marker = await oven.boundingBox();
  if (marker === null) throw new Error("The oven has no drag target.");
  await page.mouse.move(
    marker.x + marker.width / 2,
    marker.y + marker.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    marker.x + marker.width / 2 + 160,
    marker.y + marker.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  const moved = await page.evaluate(readAppliance, "bake");
  if (nearStoreValue(moved.pose.x, rotated.pose.x))
    throw new Error("The oven drag did not move the appliance.");
  if (
    moved.pose.x > 2.555 - 0.425 ||
    !nearStoreValue(moved.hood.x, moved.pose.x) ||
    !nearStoreValue(moved.hood.z, moved.pose.z)
  ) {
    throw new Error("The drag crossed the wall or left the hood behind.");
  }
  await page.screenshot({ path: `${evidence}/dragged-oven.png` });

  const initialTextures = await page.evaluate(watchShellTextures);
  await selectStoreTheme(page, "Kyoto Machiya");
  const disposed = await page.evaluate(disposalCounts, initialTextures.ids);
  if (disposed.length === 0 || disposed.some(invalidDisposalCount)) {
    throw new Error(`Shell textures must be released once: ${disposed}`);
  }
  const kyoto = await page.evaluate(watchShellTextures);
  await selectStoreTheme(page, "Kuramae");
  const kuramae = await page.evaluate(watchShellTextures);
  await selectStoreTheme(page, "Kyoto Machiya");
  const kyotoAgain = await page.evaluate(watchShellTextures);
  await selectStoreTheme(page, "Kuramae");
  const kuramaeAgain = await page.evaluate(watchShellTextures);
  if (
    kyoto.memory !== kyotoAgain.memory ||
    kuramae.memory !== kuramaeAgain.memory
  ) {
    throw new Error(
      `Texture allocation grows across repeated theme changes: ${JSON.stringify({ initialTextures, kyoto, kuramae, kyotoAgain })}`,
    );
  }

  await selectStoreRoom(page, "Kinshicho");
  const closedCorridorRoute = await page.evaluate(() =>
    window.storeLayoutProbe.layout.buildLiveRoomRoute(
      "kinshicho-61146",
      [-1.4, -1.9],
      [-1.4, -3.1],
      [],
    ),
  );
  if (closedCorridorRoute[closedCorridorRoute.length - 1][1] <= -2.65) {
    throw new Error(
      `Worker route crossed a closed corridor door: ${JSON.stringify(closedCorridorRoute)}`,
    );
  }
  const corridorDoor = map.locator(
    '[data-opening="door:door-corridor-access"]',
  );
  await corridorDoor.focus();
  await corridorDoor.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("door:door-corridor-access").progress === 1`,
    null,
    { polling: "raf" },
  );
  const openCorridorRoute = await page.evaluate(() =>
    window.storeLayoutProbe.layout.buildLiveRoomRoute(
      "kinshicho-61146",
      [-1.4, -1.9],
      [-1.4, -3.1],
      [],
    ),
  );
  if (openCorridorRoute[openCorridorRoute.length - 1][1] > -3.05) {
    throw new Error(
      `Worker route did not pass through the opened corridor door: ${JSON.stringify(openCorridorRoute)}`,
    );
  }
  await corridorDoor.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("door:door-corridor-access").progress === 0`,
    null,
    { polling: "raf" },
  );
  await page.evaluate(seedCrowdedRoom);
  await page.evaluate(() => {
    const { scene } = window.storeLayoutProbe;
    scene.update(scene.frame);
  });
  await page
    .getByText(
      "Blocked: Cooling obstructs the swing arc of Rear corridor door.",
      { exact: true },
    )
    .waitFor({ state: "attached" });
  await corridorDoor.focus();
  await corridorDoor.press("Enter");
  await page.waitForFunction(
    `(() => { const o = (${readOpening.toString()})("door:door-corridor-access"); return !window.storeLayoutProbe.workspace.isAnimating() && o.progress > 0 && o.progress < 1; })()`,
    null,
    { polling: "raf" },
  );
  const clampedCorridorDoor = await page.evaluate(
    readOpening,
    "door:door-corridor-access",
  );
  await page.evaluate(() => {
    window.storeLayoutProbe.workspace.setPoses("kinshicho-61146", [
      { id: "cool", x: -0.6, z: 0.2, rotY: 0 },
    ]);
  });
  await page.waitForFunction(
    `(() => { const o = (${readOpening.toString()})("door:door-corridor-access"); return !window.storeLayoutProbe.workspace.isAnimating() && o.progress === 1; })()`,
    null,
    { polling: "raf" },
  );
  const unclampedCorridorDoor = await page.evaluate(
    readOpening,
    "door:door-corridor-access",
  );
  await page.evaluate(() => {
    window.storeLayoutProbe.workspace.setPoses("kinshicho-61146", [
      { id: "cool", x: -1.4, z: -2.2, rotY: 0 },
    ]);
  });
  await page.waitForFunction(
    `(() => { const o = (${readOpening.toString()})("door:door-corridor-access"); return !window.storeLayoutProbe.workspace.isAnimating() && o.progress > 0 && o.progress < 1; })()`,
    null,
    { polling: "raf" },
  );
  const reclampedCorridorDoor = await page.evaluate(
    readOpening,
    "door:door-corridor-access",
  );
  if (
    unclampedCorridorDoor.progress !== 1 ||
    !nearStoreValue(
      reclampedCorridorDoor.progress,
      clampedCorridorDoor.progress,
    )
  ) {
    throw new Error(
      `Moving equipment did not reconcile open door progress: ${JSON.stringify({ clampedCorridorDoor, unclampedCorridorDoor, reclampedCorridorDoor })}`,
    );
  }
  const staging = map.locator('button[data-resource="stage"]');
  await staging.click();
  const blockedBefore = await page.evaluate(readAppliance, "stage");
  await staging.press("r");
  const blockedAfter = await page.evaluate(readAppliance, "stage");
  if (
    JSON.stringify(blockedBefore.pose) !== JSON.stringify(blockedAfter.pose)
  ) {
    throw new Error("A blocked rotation changed the appliance pose.");
  }
  await page
    .getByText(
      "There is not enough room. The appliance position stays unchanged.",
      { exact: true },
    )
    .waitFor({ state: "attached" });
  await page.screenshot({ path: `${evidence}/blocked-rotation.png` });
  await selectStoreRoom(page, "Machiya Sun Reve");
  const machiyaWarehouseDoorId = "door:door-warehouse";
  const machiyaWarehouseDoorEl = map.locator(
    `[data-opening="${machiyaWarehouseDoorId}"]`,
  );
  await machiyaWarehouseDoorEl.focus();
  await machiyaWarehouseDoorEl.press("Enter");
  await page.waitForFunction(
    `(${readOpening.toString()})("${machiyaWarehouseDoorId}").progress === 1`,
    null,
    { polling: "raf" },
  );
  const machiyaWarehouseDoor = await page.evaluate(
    readOpening,
    machiyaWarehouseDoorId,
  );
  assertOpeningMatches(machiyaWarehouseDoor);
  const machiyaCheck = await page.evaluate(() => {
    const { workspace, layout, plans } = window.storeLayoutProbe;
    const spec = plans["machiya-sun-reve"];
    const activePlan = workspace.getActivePlan();
    const blockedCount = document.querySelectorAll(
      '.spatial-floor-map [data-state="blocked"]',
    ).length;
    const uncheckedCount = document.querySelectorAll(
      '.spatial-floor-map [data-state="unchecked"]',
    ).length;
    const voidDrag = layout.moveApplianceWithCollisions(
      "machiya-sun-reve",
      "cool",
      1.65,
      0.08,
      ["stage", "portion", "bake", "cool", "pack", "robot-cell"],
    );
    const coolAfterVoidAttempt = workspace.getPose("machiya-sun-reve", "cool");
    workspace.resetPlacements("machiya-sun-reve");
    const walkLegs = layout.getLiveStationWalkLegs("machiya-sun-reve");
    return {
      activePlan,
      areaSqm: spec.areaSqm,
      voidCount: spec.voids?.length ?? 0,
      blockedCount,
      uncheckedCount,
      voidDragKind: voidDrag.kind,
      coolClampedX: coolAfterVoidAttempt.x,
      walkLegs: walkLegs.map((leg) => ({
        from: leg.from,
        to: leg.to,
        distanceMeters: leg.distanceMeters,
        walkSeconds: leg.walkSeconds,
      })),
    };
  });
  const coolToPackLeg = machiyaCheck.walkLegs.find(
    (leg) => leg.from === "cool" && leg.to === "pack",
  );
  if (
    machiyaCheck.activePlan !== "machiya-sun-reve" ||
    machiyaCheck.areaSqm !== 25.74 ||
    machiyaCheck.voidCount !== 2 ||
    machiyaCheck.blockedCount !== 0 ||
    machiyaCheck.uncheckedCount !== 0 ||
    machiyaCheck.coolClampedX > 0.9 ||
    !coolToPackLeg ||
    coolToPackLeg.distanceMeters < 2.8
  ) {
    throw new Error(
      `Machiya Sun Reve layout, void collision or walk routing failed: ${JSON.stringify(machiyaCheck)}`,
    );
  }
  await page.screenshot({ path: `${evidence}/machiya-sun-reve.png` });
  await selectStoreRoom(page, "Hongo 8257562");
  for (const hongoDoorId of ["door:door-front-entry", "door:door-foyer-subleaf"]) {
    const hongoDoorEl = map.locator(`[data-opening="${hongoDoorId}"]`);
    await hongoDoorEl.focus();
    await hongoDoorEl.press("Enter");
    await page.waitForFunction(
      `(${readOpening.toString()})("${hongoDoorId}").progress === 1`,
      null,
      { polling: "raf" },
    );
    assertOpeningMatches(await page.evaluate(readOpening, hongoDoorId));
  }
  const hongoCheck = await page.evaluate(() => {
    const { workspace, layout, plans } = window.storeLayoutProbe;
    const spec = plans["hongo-8257562"];
    const activePlan = workspace.getActivePlan();
    const blockedCount = document.querySelectorAll(
      '.spatial-floor-map [data-state="blocked"]',
    ).length;
    const uncheckedCount = document.querySelectorAll(
      '.spatial-floor-map [data-state="unchecked"]',
    ).length;
    const svgStairCount = document.querySelectorAll(
      ".spatial-floor-map [data-stair]",
    ).length;
    const stairDrag = layout.moveApplianceWithCollisions(
      "hongo-8257562",
      "pack",
      -1.25,
      -1.95,
      ["stage", "portion", "bake", "cool", "pack", "robot-cell"],
    );
    const packAfterStairAttempt = workspace.getPose("hongo-8257562", "pack");
    workspace.resetPlacements("hongo-8257562");
    const customerPts = layout.getStorefrontCustomerPoints("hongo-8257562");
    const walkLegs = layout.getLiveStationWalkLegs("hongo-8257562");
    return {
      activePlan,
      areaSqm: spec.areaSqm,
      voidCount: spec.voids?.length ?? 0,
      stairCount: spec.stairs?.length ?? 0,
      svgStairCount,
      blockedCount,
      uncheckedCount,
      stairDragKind: stairDrag.kind,
      packClampedZ: packAfterStairAttempt.z,
      doorThresholdZ: customerPts.doorThreshold[1],
      walkLegs: walkLegs.map((leg) => ({
        from: leg.from,
        to: leg.to,
        distanceMeters: leg.distanceMeters,
        walkSeconds: leg.walkSeconds,
      })),
    };
  });
  if (
    hongoCheck.activePlan !== "hongo-8257562" ||
    hongoCheck.areaSqm !== 30.1 ||
    hongoCheck.voidCount !== 1 ||
    hongoCheck.stairCount !== 1 ||
    hongoCheck.svgStairCount !== 1 ||
    hongoCheck.blockedCount !== 0 ||
    hongoCheck.uncheckedCount !== 0 ||
    hongoCheck.packClampedZ < -1.15 ||
    hongoCheck.doorThresholdZ < -1.35 ||
    hongoCheck.walkLegs.length !== 4 ||
    hongoCheck.walkLegs.some((leg) => leg.distanceMeters <= 0)
  ) {
    throw new Error(
      `Hongo 8257562 layout, stair collision or walk routing failed: ${JSON.stringify(hongoCheck)}`,
    );
  }
  await page.screenshot({ path: `${evidence}/hongo-8257562.png` });
  await page.getByRole("button", { name: /^Floor plan room:/ }).click();
  await page.screenshot({ path: `${evidence}/hongo-room-menu.png` });
  await page.getByRole("menuitemradio", { name: /Asakusabashi/ }).click();
  assertOpeningMatches(await page.evaluate(readOpening, doorId));
  const retained = await page.evaluate(readAppliance, "bake");
  if (JSON.stringify(retained.pose) !== JSON.stringify(moved.pose)) {
    throw new Error("Room selection discarded the accepted placement.");
  }
  const storageAndSurfaceCheck = await page.evaluate(() => {
    const { workspace, shiftLayout } = window.storeLayoutProbe;
    const savedRaw = localStorage.getItem("satyr:floor-plan-workspace:v1");
    if (!savedRaw)
      throw new Error("Workspace state was not saved to localStorage.");
    const parsed = JSON.parse(savedRaw);
    localStorage.setItem("satyr:floor-plan-workspace:v1", "{corrupt-json");
    workspace.reloadFromStorage();
    localStorage.setItem("satyr:floor-plan-workspace:v1", savedRaw);
    workspace.reloadFromStorage();
    const surfaceLayout = shiftLayout.shiftFloorPlanLayout();
    return {
      savedActivePlan: parsed.activePlan,
      savedRoomCount: Object.keys(parsed.placements ?? {}).length,
      savedOpeningCount: Object.keys(parsed.openings ?? {}).length,
      surfaceFloorPlan: surfaceLayout.floorPlan,
      bakeSurfaceItem:
        surfaceLayout.equipment.find((e) => e.id === "bake") ?? null,
      eastDoorSurfaceItem:
        surfaceLayout.openings?.find((o) => o.id === "door:door-east-side") ??
        null,
    };
  });
  if (
    storageAndSurfaceCheck.savedActivePlan !== "asakusabashi-t101940" ||
    storageAndSurfaceCheck.savedRoomCount < 2 ||
    storageAndSurfaceCheck.savedOpeningCount < 2 ||
    typeof storageAndSurfaceCheck.bakeSurfaceItem?.xMm !== "number" ||
    typeof storageAndSurfaceCheck.bakeSurfaceItem?.zMm !== "number" ||
    storageAndSurfaceCheck.eastDoorSurfaceItem?.open !== true
  ) {
    throw new Error(
      `Workspace persistence or surface layout check failed: ${JSON.stringify(storageAndSurfaceCheck)}`,
    );
  }
  const customerVisit = await page.evaluate(() => {
    const { scene, layout } = window.storeLayoutProbe;
    const closedDoorPts = layout.getStorefrontCustomerPoints(
      "asakusabashi-t101940",
    );
    scene.update({ ...scene.frame, time: 435 });
    const arriving = {
      visible: scene.customers[0].root.visible,
      carrying: scene.customers[0].carriedItemGroup.visible,
      x: Number(scene.customers[0].root.position.x.toFixed(3)),
      z: Number(scene.customers[0].root.position.z.toFixed(3)),
      orderId: scene.activeCustomerStates[0]?.orderId ?? null,
    };
    scene.update({ ...scene.frame, time: 735 });
    const departing = {
      visible: scene.customers[0].root.visible,
      carrying: scene.customers[0].carriedItemGroup.visible,
      x: Number(scene.customers[0].root.position.x.toFixed(3)),
      z: Number(scene.customers[0].root.position.z.toFixed(3)),
      orderId: scene.activeCustomerStates[0]?.orderId ?? null,
      floorPlanDecorCount: document.querySelectorAll(
        '.spatial-floor-map [data-resource^="decor-"]',
      ).length,
      floorPlanFixtureCount: document.querySelectorAll(
        ".spatial-floor-map [data-fixture]",
      ).length,
      floorPlanUtilityLineCount: document.querySelectorAll(
        ".spatial-floor-map [data-utility-hookup]",
      ).length,
      floorPlanActorIds: Array.from(
        document.querySelectorAll(".spatial-floor-map [data-actor]"),
      ).map((el) => el.getAttribute("data-actor")),
    };
    return {
      closedThresholdZ: closedDoorPts.doorThreshold[1],
      arriving,
      departing,
    };
  });
  if (
    !customerVisit.arriving.visible ||
    customerVisit.arriving.carrying ||
    customerVisit.arriving.orderId !== "ORD-101" ||
    !customerVisit.departing.visible ||
    !customerVisit.departing.carrying ||
    customerVisit.departing.orderId !== "ORD-101" ||
    customerVisit.departing.floorPlanDecorCount < 3 ||
    customerVisit.departing.floorPlanFixtureCount < 1 ||
    customerVisit.departing.floorPlanUtilityLineCount < 1 ||
    !customerVisit.departing.floorPlanActorIds.includes("ORD-101")
  ) {
    throw new Error(
      `Customer arrival and 2D floor-plan overlay failed: ${JSON.stringify(customerVisit)}`,
    );
  }
  const lightingAndShadowCheck = await page.evaluate(() => {
    const { scene } = window.storeLayoutProbe;
    const keySun = scene.scene.getObjectByName("key-sun-light");
    const skyFill = scene.scene.getObjectByName("sky-rim-fill-light");
    const shellRoot = scene.customFloorShell.root;
    const overheadLights = [0, 1, 2, 3]
      .map((i) => shellRoot.getObjectByName(`overhead-point-light:${i}`))
      .filter(Boolean);
    const hoodTaskLight = shellRoot.getObjectByName("hood-task-light");
    const vitrineLight = shellRoot.getObjectByName("vitrine-display-light");
    const storefrontDaylight = shellRoot.getObjectByName(
      "storefront-daylight-fill",
    );
    const bakeShadowPad = scene.scene.getObjectByName(
      "station-contact-shadow:bake",
    );
    const workerShadowPad =
      scene.workers[0]?.root.getObjectByName("contact-shadow-pad") ?? null;
    const vitrineShadowPad =
      shellRoot
        .getObjectByName("decor:decor-vitrine")
        ?.getObjectByName("contact-shadow-pad") ?? null;
    const mainZoneMesh = shellRoot.getObjectByName("zone:main-floor");
    const floorClearcoat = mainZoneMesh?.material?.clearcoat ?? 0;
    const floorHasPbrMaps = Boolean(
      mainZoneMesh?.material?.normalMap?.isTexture &&
      mainZoneMesh?.material?.roughnessMap?.isTexture,
    );
    const storefrontThreshold =
      shellRoot.getObjectByName("storefront-threshold") ?? null;
    const sidewalkApron =
      storefrontThreshold?.getObjectByName("storefront-sidewalk-apron") ?? null;
    const streetCurb =
      storefrontThreshold?.getObjectByName("storefront-street-curb") ?? null;
    const welcomeMat =
      storefrontThreshold?.getObjectByName("storefront-welcome-mat") ?? null;
    const menuBoard =
      storefrontThreshold?.getObjectByName("storefront-menu-board") ?? null;
    const bakeModel = scene.stationModels.get("bake");
    const stageModel = scene.stationModels.get("stage");
    const coolModel = scene.stationModels.get("cool");
    const ovenChamberLight =
      bakeModel?.getObjectByName("oven-chamber-light") ?? null;
    const ovenDoorSteam = bakeModel?.getObjectByName("oven-door-steam") ?? null;
    const stageHobLight =
      stageModel?.getObjectByName("stage-hob-light") ?? null;
    const stageButterSteam =
      stageModel?.getObjectByName("stage-butter-steam") ?? null;
    const coolRackSteam = coolModel?.getObjectByName("cool-rack-steam") ?? null;
    const firstStage = scene.frame.run.intervals.find(
      (iv) => iv.kind === "process" && iv.operation === "stage",
    );
    const stageStart = firstStage.start === 0 ? 0 : firstStage.arrival;
    const brownButterTime = stageStart + (firstStage.end - stageStart) * 0.57;
    scene.update({ ...scene.frame, time: brownButterTime });
    const hobActiveIntensity = stageHobLight?.intensity ?? 0;
    const butterSteamVisible = Boolean(stageButterSteam?.visible);
    const firstBake = scene.frame.run.intervals.find(
      (iv) => iv.kind === "process" && iv.operation === "bake",
    );
    scene.update({ ...scene.frame, time: firstBake.start + 60 });
    const ovenActiveIntensity = ovenChamberLight?.intensity ?? 0;
    const ovenSteamVisible = Boolean(ovenDoorSteam?.visible);
    return {
      shadowMapEnabled: scene.renderer.shadowMap.enabled,
      shadowMapType: scene.renderer.shadowMap.type,
      sunShadowWidth: keySun?.shadow?.mapSize?.x ?? 0,
      sunShadowHeight: keySun?.shadow?.mapSize?.y ?? 0,
      hasSkyFill: Boolean(skyFill?.isDirectionalLight),
      overheadLightCount: overheadLights.length,
      hasHoodTaskLight: Boolean(hoodTaskLight?.isPointLight),
      hasVitrineLight: Boolean(vitrineLight?.isPointLight),
      hasStorefrontDaylight: Boolean(storefrontDaylight?.isPointLight),
      bakeShadowPadPos: bakeShadowPad
        ? {
            x: bakeShadowPad.position.x,
            z: bakeShadowPad.position.z,
            rotY: bakeShadowPad.rotation.y,
          }
        : null,
      hasWorkerShadowPad: Boolean(workerShadowPad),
      hasVitrineShadowPad: Boolean(vitrineShadowPad),
      floorClearcoat,
      floorHasPbrMaps,
      hasStorefrontThreshold: Boolean(storefrontThreshold),
      hasSidewalkApron: Boolean(
        sidewalkApron?.material?.normalMap?.isTexture &&
        sidewalkApron?.material?.roughnessMap?.isTexture,
      ),
      hasStreetCurb: Boolean(streetCurb),
      hasWelcomeMat: Boolean(welcomeMat),
      hasMenuBoard: Boolean(menuBoard),
      hasCoolRackSteam: Boolean(coolRackSteam),
      hobActiveIntensity,
      butterSteamVisible,
      ovenActiveIntensity,
      ovenSteamVisible,
    };
  });
  if (
    !lightingAndShadowCheck.shadowMapEnabled ||
    lightingAndShadowCheck.shadowMapType !== 2 ||
    lightingAndShadowCheck.sunShadowWidth !== 2048 ||
    lightingAndShadowCheck.sunShadowHeight !== 2048 ||
    !lightingAndShadowCheck.hasSkyFill ||
    lightingAndShadowCheck.overheadLightCount !== 4 ||
    !lightingAndShadowCheck.hasHoodTaskLight ||
    !lightingAndShadowCheck.hasVitrineLight ||
    !lightingAndShadowCheck.hasStorefrontDaylight ||
    lightingAndShadowCheck.bakeShadowPadPos === null ||
    !nearStoreValue(
      lightingAndShadowCheck.bakeShadowPadPos.x,
      retained.pose.x,
    ) ||
    !nearStoreValue(
      lightingAndShadowCheck.bakeShadowPadPos.z,
      retained.pose.z,
    ) ||
    !lightingAndShadowCheck.hasWorkerShadowPad ||
    !lightingAndShadowCheck.hasVitrineShadowPad ||
    lightingAndShadowCheck.floorClearcoat <= 0 ||
    !lightingAndShadowCheck.floorHasPbrMaps ||
    !lightingAndShadowCheck.hasStorefrontThreshold ||
    !lightingAndShadowCheck.hasSidewalkApron ||
    !lightingAndShadowCheck.hasStreetCurb ||
    !lightingAndShadowCheck.hasWelcomeMat ||
    !lightingAndShadowCheck.hasMenuBoard ||
    !lightingAndShadowCheck.hasCoolRackSteam ||
    lightingAndShadowCheck.hobActiveIntensity <= 0 ||
    !lightingAndShadowCheck.butterSteamVisible ||
    lightingAndShadowCheck.ovenActiveIntensity <= 0 ||
    !lightingAndShadowCheck.ovenSteamVisible
  ) {
    throw new Error(
      `Lighting and shadow realism check failed: ${JSON.stringify(lightingAndShadowCheck)}`,
    );
  }
  await page.screenshot({ path: `${evidence}/restored-room.png` });
  return {
    result: "passed",
    recovered,
    reversed,
    openDoor,
    closedFrom3D,
    openWindow,
    before,
    rotated,
    moved,
    blockedBefore,
    blockedAfter,
    clampedCorridorDoor,
    unclampedCorridorDoor,
    reclampedCorridorDoor,
    storageAndSurfaceCheck,
    machiyaCheck,
    hongoCheck,
    doorWalkRoutes: {
      closedCorridorRoute,
      openCorridorRoute,
    },
    customerVisit,
    lightingAndShadowCheck,
    textures: {
      initial: initialTextures.memory,
      kyoto: kyoto.memory,
      kuramae: kuramae.memory,
      kyotoAgain: kyotoAgain.memory,
      kuramaeAgain: kuramaeAgain.memory,
    },
    retained,
  };
}
