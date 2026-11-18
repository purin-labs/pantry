// Run through browser-acceptance.mjs. Verifies GTAOPass ambient occlusion,
// lowered fill lighting, exterior ground shadow plane across floor plans and
// dark/light themes, and PhysicsScene shadows across perspective/orthographic
// cameras on real WebGL2.
async function verifySceneLightingBrowser(page) {
  page.setDefaultTimeout(25000);
  const consoleErrors = [];
  page.on("console", function onConsole(msg) {
    if (msg.type() === "error" && !msg.text().includes("favicon.ico")) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", function onPageError(err) {
    consoleErrors.push(String(err));
  });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(function retainTimings() {
    performance.setResourceTimingBufferSize(5000);
  });
  await page.reload();
  await page.getByRole("button", { name: "Top view", exact: true }).waitFor();
  await page.waitForFunction(function storeSceneReady() {
    return (
      document.querySelector('button[aria-label="Top view"]')?.disabled ===
      false
    );
  });

  await page.evaluate(async function installProbes() {
    const entries = performance.getEntriesByType("resource");
    const sceneEntry = entries.find(function findScene(e) {
      return (
        new URL(e.name).pathname === "/src/features/workflow-simulator/scene.ts"
      );
    });
    const { BakeryScene } = await import(
      sceneEntry ? sceneEntry.name : "/src/features/workflow-simulator/scene.ts"
    );
    const origUpdate = BakeryScene.prototype.update;
    BakeryScene.prototype.update = function captureUpdate(frame) {
      window.__bakeryScene = this;
      return origUpdate.call(this, frame);
    };
  });

  const topViewToggle = page.getByRole("button", {
    name: "Top view",
    exact: true,
  });
  await topViewToggle.click();
  await topViewToggle.click();
  await page.waitForFunction(function hasBakeryScene() {
    return Boolean(
      window.__bakeryScene && window.__bakeryScene.customFloorShell,
    );
  });
  await page.waitForTimeout(350);

  const bakeryStats = await page.evaluate(function inspectBakeryScene() {
    const s = window.__bakeryScene;
    s.render();
    const gl = s.renderer.getContext();
    const glError = gl.getError();
    const sun = s.scene.getObjectByName("key-sun-light");
    const hemi = s.scene.getObjectByName("hemisphere-fill-light");
    const sky = s.scene.getObjectByName("sky-rim-fill-light");
    const extPlane = s.scene.getObjectByName("exterior-shadow-plane");
    const daylight = s.scene.getObjectByName("storefront-daylight-fill");
    const pendant = s.scene.getObjectByName("overhead-point-light:0");
    const hoodLight = s.scene.getObjectByName("hood-task-light");

    let shadowCasters = 0;
    let shadowReceivers = 0;
    let pbrMaterialCount = 0;
    let linearPbrMapsValid = true;
    s.scene.traverse(function countMeshes(node) {
      if (node.isMesh) {
        if (node.castShadow) shadowCasters += 1;
        if (node.receiveShadow) shadowReceivers += 1;
        if (
          node.material &&
          node.material.normalMap &&
          node.material.roughnessMap
        ) {
          pbrMaterialCount += 1;
          if (
            node.material.normalMap.colorSpace !== "" ||
            node.material.roughnessMap.colorSpace !== "" ||
            node.material.bumpMap !== null
          ) {
            linearPbrMapsValid = false;
          }
        }
      }
    });

    const vitrine = s.customFloorShell.root.getObjectByName(
      "decor:decor-vitrine",
    );
    const financier0 = s.customFloorShell.root.getObjectByName(
      "vitrine-financier:0",
    );
    const sinkRack = s.customFloorShell.root.getObjectByName("sink_mould_rack");
    const mouldVerts =
      sinkRack && sinkRack.children[0]
        ? sinkRack.children[0].geometry.attributes.position.count
        : 0;
    const financierVerts = financier0
      ? financier0.geometry.attributes.position.count
      : 0;
    const vitrineBaseVerts =
      vitrine && vitrine.children[0]
        ? vitrine.children[0].geometry.attributes.position.count
        : 0;

    // Verify theme reactivity on the exterior shadow plane and hemisphere fill.
    s.lighting.setDarkTheme(true);
    const darkPlaneOpacity = extPlane ? extPlane.material.opacity : null;
    const darkHemiIntensity = hemi ? hemi.intensity : null;
    s.lighting.setDarkTheme(false);
    const lightPlaneOpacity = extPlane ? extPlane.material.opacity : null;

    return {
      glError,
      isPerspectiveCamera: Boolean(s.camera.isPerspectiveCamera),
      cameraFov: s.camera.fov,
      shadowMapEnabled: s.renderer.shadowMap.enabled,
      toneMapping: s.renderer.toneMapping,
      environmentPresent: Boolean(s.scene.environment),
      environmentIntensity: s.scene.environmentIntensity,
      hemiIntensity: hemi ? hemi.intensity : null,
      darkHemiIntensity,
      skyIntensity: sky ? sky.intensity : null,
      sunIntensity: sun ? sun.intensity : null,
      sunProjMatrix00: sun
        ? sun.shadow.camera.projectionMatrix.elements[0]
        : null,
      daylightIntensity: daylight ? daylight.intensity : null,
      pendantIntensity: pendant ? pendant.intensity : null,
      hoodIntensity: hoodLight ? hoodLight.intensity : null,
      exteriorPlanePresent: Boolean(extPlane && extPlane.receiveShadow),
      exteriorPlaneY: extPlane ? extPlane.position.y : null,
      darkPlaneOpacity,
      lightPlaneOpacity,
      shadowCasters,
      shadowReceivers,
      pbrMaterialCount,
      linearPbrMapsValid,
      mouldVerts,
      financierVerts,
      vitrineBaseVerts,
    };
  });

  if (bakeryStats.glError !== 0) {
    throw new Error("WebGL error in BakeryScene: " + bakeryStats.glError);
  }
  if (
    bakeryStats.pbrMaterialCount < 6 ||
    !bakeryStats.linearPbrMapsValid ||
    bakeryStats.mouldVerts <= 24 ||
    bakeryStats.financierVerts <= 24 ||
    bakeryStats.vitrineBaseVerts <= 24
  ) {
    throw new Error(
      "Expected PBR normal/roughness maps and RoundedBoxGeometry bevels: " +
        JSON.stringify(bakeryStats),
    );
  }
  if (
    !bakeryStats.isPerspectiveCamera ||
    Math.abs(bakeryStats.cameraFov - 25) > 1e-3 ||
    !bakeryStats.environmentPresent ||
    !bakeryStats.shadowMapEnabled ||
    !bakeryStats.exteriorPlanePresent ||
    bakeryStats.hemiIntensity > 0.6 ||
    bakeryStats.daylightIntensity > 0.35 ||
    bakeryStats.pendantIntensity > 0.3 ||
    Math.abs(bakeryStats.darkPlaneOpacity - 0.38) > 1e-3 ||
    Math.abs(bakeryStats.lightPlaneOpacity - 0.25) > 1e-3
  ) {
    throw new Error(
      "Unexpected BakeryScene lighting state: " + JSON.stringify(bakeryStats),
    );
  }
  if (Math.abs(bakeryStats.sunProjMatrix00 - 1 / 8.2) > 1e-4) {
    throw new Error(
      "Sun shadow projection matrix was not updated: " +
        bakeryStats.sunProjMatrix00,
    );
  }

  await page.locator(".workflow-scene").screenshot({
    path: "bakery-scene-gtao-shadows.png",
  });

  // Verify rigged GLB workers, customer visitors, and botanical planters in BakeryScene.
  const livingRigStats = await page.evaluate(
    function inspectRiggedWorkersAndPlants() {
      const s = window.__bakeryScene;
      const savedPos = s.camera.position.clone();
      const savedTarget = s.controls.target.clone();
      const savedTime = s.frame.time;

      function inspectCharacter(fig) {
        let bones = 0;
        let visibleSkinned = 0;
        fig.root.traverse(function walk(n) {
          if (n.isBone) bones += 1;
          if (n.isSkinnedMesh && n.visible) visibleSkinned += 1;
        });
        return {
          hasArmature: Boolean(fig.root.getObjectByName("human_armature")),
          bones,
          visibleSkinned,
          toqueVisible: Boolean(
            fig.root.getObjectByName("chef_toque")?.visible,
          ),
          apronVisible: Boolean(
            fig.root.getObjectByName("chef_apron")?.visible,
          ),
          scarfVisible: Boolean(
            fig.root.getObjectByName("customer_scarf")?.visible,
          ),
          visitorHairVisible: Boolean(
            fig.root.getObjectByName("mesh_hair_visitor")?.visible,
          ),
          hasChefVessel: Boolean(
            fig.carriedItemGroup.getObjectByName("prop_chef_vessel"),
          ),
          hasBallotin: Boolean(
            fig.carriedItemGroup.getObjectByName("prop_visitor_ballotin"),
          ),
        };
      }

      const baker0 = inspectCharacter(s.workers[0]);
      const visitor0 = inspectCharacter(s.customers[0]);

      // Check bone animation across two timestamps
      s.update({ ...s.frame, time: 120 });
      const wristA = s.workers[0].root
        .getObjectByName("right_wrist")
        .matrixWorld.elements.slice(12, 15);
      s.update({ ...s.frame, time: 185 });
      const wristB = s.workers[0].root
        .getObjectByName("right_wrist")
        .matrixWorld.elements.slice(12, 15);
      const wristMotionM = Math.hypot(
        wristB[0] - wristA[0],
        wristB[1] - wristA[1],
        wristB[2] - wristA[2],
      );

      const oliveGroup = s.scene.getObjectByName("decor:decor-planter");
      let oliveBones = 0;
      let oliveSkinned = 0;
      let oliveLeafVerts = 0;
      if (oliveGroup) {
        oliveGroup.traverse(function walkOlive(n) {
          if (n.isBone) oliveBones += 1;
          if (n.isSkinnedMesh) oliveSkinned += 1;
          if (n.isMesh && n.name.startsWith("olive_leaves_")) {
            oliveLeafVerts += n.geometry.attributes.position.count;
          }
        });
      }
      const olivePot = oliveGroup?.getObjectByName("olive_pot") ?? null;
      const oliveSaucer = oliveGroup?.getObjectByName("olive_saucer") ?? null;
      const potHasPorcelainGlaze = Boolean(
        olivePot &&
        olivePot.material &&
        typeof olivePot.material.clearcoat === "number" &&
        olivePot.material.clearcoat > 0.5 &&
        oliveSaucer &&
        oliveSaucer.material &&
        oliveSaucer.material.metalness > 0.7,
      );

      const leftShrub = s.scene.getObjectByName("storefront-planter-left");
      const rightShrub = s.scene.getObjectByName("storefront-planter-right");
      let shrubSkinned = 0;
      for (const sh of [leftShrub, rightShrub]) {
        if (!sh) continue;
        sh.traverse(function walkShrub(n) {
          if (n.isSkinnedMesh) shrubSkinned += 1;
        });
      }

      const glError = s.renderer.getContext().getError();

      // Frame close-up on Baker 0 & Olive Tree Planter for visual inspection
      const wPos = s.workers[0].root.position;
      s.camera.position.set(wPos.x + 2.35, 1.85, wPos.z + 2.55);
      s.controls.target.set(wPos.x - 0.15, 0.88, wPos.z + 0.15);
      s.controls.update();
      s.render();

      return {
        glError,
        baker0,
        visitor0,
        wristMotionM: Number(wristMotionM.toFixed(4)),
        oliveBones,
        oliveSkinned,
        oliveLeafVerts,
        potHasPorcelainGlaze,
        shrubSkinned,
        savedPos: savedPos.toArray(),
        savedTarget: savedTarget.toArray(),
        savedTime,
      };
    },
  );

  await page.locator(".workflow-scene").screenshot({
    path: "bakery-rigged-workers-and-olive-tree.png",
  });

  // Frame close-up on storefront customer carrying ballotin box + rigged sidewalk planters
  await page.evaluate(function frameVisitorAndStorefront() {
    const s = window.__bakeryScene;
    s.update({ ...s.frame, time: 735 });
    const cPos = s.customers[0].root.position;
    s.camera.position.set(cPos.x + 1.45, 1.58, cPos.z + 2.55);
    s.controls.target.set(cPos.x + 0.05, 0.78, cPos.z - 0.05);
    s.controls.update();
    s.render();
  });
  await page.locator(".workflow-scene").screenshot({
    path: "bakery-rigged-visitor-and-storefront.png",
  });

  await page.evaluate(function restoreBakeryCamera(saved) {
    const s = window.__bakeryScene;
    s.update({ ...s.frame, time: saved.savedTime });
    s.camera.position.fromArray(saved.savedPos);
    s.controls.target.fromArray(saved.savedTarget);
    s.controls.update();
    s.render();
  }, livingRigStats);

  if (
    livingRigStats.glError !== 0 ||
    !livingRigStats.baker0.hasArmature ||
    livingRigStats.baker0.bones !== 16 ||
    livingRigStats.baker0.visibleSkinned < 14 ||
    !livingRigStats.baker0.toqueVisible ||
    !livingRigStats.baker0.apronVisible ||
    livingRigStats.baker0.scarfVisible ||
    !livingRigStats.baker0.hasChefVessel ||
    !livingRigStats.visitor0.hasArmature ||
    livingRigStats.visitor0.toqueVisible ||
    livingRigStats.visitor0.apronVisible ||
    !livingRigStats.visitor0.scarfVisible ||
    !livingRigStats.visitor0.visitorHairVisible ||
    !livingRigStats.visitor0.hasBallotin ||
    livingRigStats.wristMotionM < 0.005 ||
    livingRigStats.oliveBones !== 6 ||
    livingRigStats.oliveSkinned !== 4 ||
    livingRigStats.oliveLeafVerts < 1200 ||
    !livingRigStats.potHasPorcelainGlaze ||
    livingRigStats.shrubSkinned !== 6
  ) {
    throw new Error(
      "Rigged workers or botanical planters check failed: " +
        JSON.stringify(livingRigStats),
    );
  }

  // Switch floor plan to Reference grid and verify exterior shadow plane Y updates cleanly.
  await page.getByRole("button", { name: /^Floor plan room:/ }).click();
  await page.getByRole("menuitemradio", { name: /Reference/ }).click();
  const refPlaneY = await page.evaluate(function readRefPlaneY() {
    const s = window.__bakeryScene;
    s.render();
    return s.scene.getObjectByName("exterior-shadow-plane")?.position.y ?? null;
  });
  if (Math.abs(refPlaneY - -0.102) > 1e-4) {
    throw new Error(
      "Reference floor plan exterior plane Y mismatch: " + refPlaneY,
    );
  }
  await page.getByRole("button", { name: /^Floor plan room:/ }).click();
  await page.getByRole("menuitemradio", { name: /Kinshicho/ }).click();

  // Navigate to Robot rehearsal (PhysicsScene) and verify shadows + camera-mode GTAO switching.
  await openRecordingViewer(page);

  await page.evaluate(async function installHostProbe() {
    const hostEntry = performance
      .getEntriesByType("resource")
      .find(function findHost(e) {
        return (
          new URL(e.name).pathname ===
          "/src/features/workflow-simulator/spatial/physics-scene-host.ts"
        );
      });
    const { PhysicsSceneHost } = await import(
      hostEntry
        ? hostEntry.name
        : "/src/features/workflow-simulator/spatial/physics-scene-host.ts"
    );
    if (!PhysicsSceneHost.prototype.__lightingWrapped) {
      const origHostLoad = PhysicsSceneHost.prototype.load;
      PhysicsSceneHost.prototype.load = function captureHost(element, source) {
        window.__physicsHost = this;
        return origHostLoad.call(this, element, source);
      };
      PhysicsSceneHost.prototype.__lightingWrapped = true;
    }
  });

  await page.getByRole("button", { name: /^Table to rack/ }).click();
  await page.waitForFunction(function physicsReady() {
    const h = window.__physicsHost;
    return Boolean(h && h.life && h.life.kind === "ready" && h.webgl);
  });
  await page.waitForTimeout(350);

  const physicsStats = await page.evaluate(function inspectPhysicsScene() {
    const ps = window.__physicsHost.webgl;
    ps.focusCell();
    ps.render();
    const gl = ps.host.renderer.getContext();
    const glError = gl.getError();
    const extPlane = ps.scene.getObjectByName("exterior-shadow-plane");
    const sun = ps.scene.getObjectByName("key-sun-light");

    function countVisibleGlbMeshes(root) {
      if (!root || !root.visible) return 0;
      let count = 0;
      root.traverse(function walk(node) {
        if (
          node.isMesh &&
          node.visible &&
          node.userData.isCollisionShape !== true
        ) {
          count += 1;
        }
      });
      return count;
    }

    function countVisibleCollisionShapes(root) {
      let count = 0;
      root.traverse(function walk(node) {
        if (
          node.isMesh &&
          node.userData.isCollisionShape === true &&
          node.visible
        ) {
          count += 1;
        }
      });
      return count;
    }

    let modelCasters = 0;
    ps.model.root.traverse(function countModel(node) {
      if (node.isMesh && node.castShadow) modelCasters += 1;
    });
    let bakeryCasters = 0;
    ps.bakery.root.traverse(function countBakery(node) {
      if (node.isMesh && node.castShadow) bakeryCasters += 1;
    });

    const pedestalVisual = ps.model.root.getObjectByName("pedestal_visual");
    const tableVisual = ps.model.root.getObjectByName("source_table_visual");
    const rackVisual = ps.model.root.getObjectByName("rack_visual");

    const normalCollisionCount = countVisibleCollisionShapes(ps.model.root);
    const outlinedMapped = ps.showContactShapes(
      new Set(["rack_rail_left", "mbco_tray_bottom"]),
    );
    const outlinedCollisionCount = countVisibleCollisionShapes(ps.model.root);
    ps.showContactShapes(new Set());
    const clearedCollisionCount = countVisibleCollisionShapes(ps.model.root);

    return {
      glError,
      shadowMapEnabled: ps.host.renderer.shadowMap.enabled,
      exteriorPlanePresent: Boolean(extPlane && extPlane.receiveShadow),
      sunPresent: Boolean(sun && sun.castShadow),
      modelCasters,
      bakeryCasters,
      normalCollisionCount,
      outlinedMapped,
      outlinedCollisionCount,
      clearedCollisionCount,
      glbCounts: {
        robot: countVisibleGlbMeshes(ps.model.robot),
        tool: countVisibleGlbMeshes(ps.model.tool),
        jaw: countVisibleGlbMeshes(ps.model.jaw),
        tray: countVisibleGlbMeshes(ps.model.tray),
        pedestal: countVisibleGlbMeshes(pedestalVisual),
        sourceTable: countVisibleGlbMeshes(tableVisual),
        rack: countVisibleGlbMeshes(rackVisual),
      },
      resourceBindings: {
        pedestal: pedestalVisual
          ? ps.model.resourceForObject(pedestalVisual)
          : null,
        sourceTable: tableVisual
          ? ps.model.resourceForObject(tableVisual)
          : null,
        rack: rackVisual ? ps.model.resourceForObject(rackVisual) : null,
        tool: ps.model.resourceForObject(ps.model.tool),
        tray: ps.model.resourceForObject(ps.model.tray),
      },
    };
  });

  if (
    physicsStats.glError !== 0 ||
    !physicsStats.shadowMapEnabled ||
    !physicsStats.exteriorPlanePresent ||
    physicsStats.modelCasters === 0 ||
    physicsStats.bakeryCasters === 0 ||
    physicsStats.normalCollisionCount !== 0 ||
    physicsStats.outlinedMapped !== 2 ||
    physicsStats.outlinedCollisionCount !== 2 ||
    physicsStats.clearedCollisionCount !== 0 ||
    Object.values(physicsStats.glbCounts).some(function missing(v) {
      return v <= 0;
    }) ||
    physicsStats.resourceBindings.pedestal !== "fr10-1" ||
    physicsStats.resourceBindings.sourceTable !== "source-table-1" ||
    physicsStats.resourceBindings.rack !== "rack-slot-1" ||
    physicsStats.resourceBindings.tool !== "clamp-1" ||
    physicsStats.resourceBindings.tray !== "cold-tray-1"
  ) {
    throw new Error(
      "PhysicsScene GLB or collision-visibility state invalid: " +
        JSON.stringify(physicsStats),
    );
  }

  await page.locator(".physics-replay .spatial-scene-viewport").screenshot({
    path: "physics-cell-glb-normal.png",
  });
  await page.locator(".physics-replay .spatial-workspace").screenshot({
    path: "physics-scene-gtao-shadows.png",
  });

  // Load oven-loading.json and verify oven + oven_stand GLBs and fit-check collision toggling.
  const setupBtn = page.getByRole("button", {
    name: "Setup & files",
    exact: true,
  });
  const compareFilesTab = page.getByRole("tab", {
    name: "Compare & files",
    exact: true,
  });
  if (!(await compareFilesTab.isVisible())) await setupBtn.click();
  await compareFilesTab.click();
  await page
    .getByLabel("Recording file (.json)")
    .setInputFiles(
      "assets/bakery-mujoco/fr10-workcell/recordings/oven-loading.json",
    );
  await setupBtn.click();
  await page.waitForFunction(function ovenPhysicsReady() {
    const h = window.__physicsHost;
    return Boolean(
      h &&
      h.life &&
      h.life.kind === "ready" &&
      h.webgl &&
      h.webgl.model.root.getObjectByName("oven_stand_visual"),
    );
  });
  await page.waitForTimeout(300);

  const rehearsal = page.locator(".physics-replay");
  if (!(await rehearsal.locator(".spatial-floor-plan").isVisible())) {
    await rehearsal
      .getByRole("button", { name: "Floor plan", exact: true })
      .click();
  }
  const ovenBeforeFit = await page.evaluate(function inspectOvenNormal() {
    const ps = window.__physicsHost.webgl;
    ps.focusCell();
    ps.render();
    let visibleCollisions = 0;
    ps.model.root.traverse(function walk(n) {
      if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
        visibleCollisions += 1;
      }
    });
    const stand = ps.model.root.getObjectByName("oven_stand_visual");
    let standMeshes = 0;
    if (stand) {
      stand.traverse(function walkStand(n) {
        if (n.isMesh && n.visible) standMeshes += 1;
      });
    }
    let ovenMeshes = 0;
    ps.model.oven.traverse(function walkOven(n) {
      if (n.isMesh && n.visible && n.userData.isCollisionShape !== true) {
        ovenMeshes += 1;
      }
    });
    return {
      visibleCollisions,
      standMeshes,
      ovenMeshes,
      standResource: stand ? ps.model.resourceForObject(stand) : null,
    };
  });
  if (
    ovenBeforeFit.visibleCollisions !== 0 ||
    ovenBeforeFit.standMeshes <= 0 ||
    ovenBeforeFit.ovenMeshes <= 0 ||
    ovenBeforeFit.standResource !== "maruzen-shelf-3"
  ) {
    throw new Error(
      "Oven workcell GLB state invalid before fit check: " +
        JSON.stringify(ovenBeforeFit),
    );
  }
  await rehearsal.locator(".spatial-scene-viewport").screenshot({
    path: "physics-oven-glb-normal.png",
  });

  const inspector = rehearsal.locator(".spatial-selection-inspector");
  await inspector.getByText("Inspect oven door", { exact: true }).click();
  await inspector.getByText(/^Full 0–110° opening:/).waitFor();
  const ovenDuringFit = await page.evaluate(function inspectOvenDuringFit() {
    const ps = window.__physicsHost.webgl;
    ps.focusCell();
    ps.render();
    let visibleCollisions = 0;
    ps.model.root.traverse(function walk(n) {
      if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
        visibleCollisions += 1;
      }
    });
    return {
      visibleCollisions,
      glError: ps.host.renderer.getContext().getError(),
    };
  });
  if (ovenDuringFit.visibleCollisions <= 0 || ovenDuringFit.glError !== 0) {
    throw new Error(
      "Collision shapes must show during oven door fit check: " +
        JSON.stringify(ovenDuringFit),
    );
  }
  await rehearsal.locator(".spatial-scene-viewport").screenshot({
    path: "physics-oven-fit-check.png",
  });

  await inspector.getByText("Inspect oven door", { exact: true }).click();
  await page.waitForFunction(function doorInspectionClosed() {
    const details = document.querySelector(
      ".physics-replay details.spatial-door-inspection",
    );
    const ps = window.__physicsHost?.webgl;
    return (
      details !== null &&
      !details.open &&
      ps !== undefined &&
      !ps.model.isShowingCollisionShapes
    );
  });
  const ovenAfterFit = await page.evaluate(function inspectOvenAfterFit() {
    const ps = window.__physicsHost.webgl;
    ps.render();
    let visibleCollisions = 0;
    ps.model.root.traverse(function walk(n) {
      if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
        visibleCollisions += 1;
      }
    });
    return visibleCollisions;
  });
  if (ovenAfterFit !== 0) {
    throw new Error(
      "Collision shapes must hide after closing fit check, got " + ovenAfterFit,
    );
  }

  // Selecting a fit conflict in the floor-plan inspector also shows collision shapes,
  // and selecting a normal single resource hides them again.
  await inspector
    .getByRole("button", { name: /^Blocked:/ })
    .first()
    .click();
  const conflictCollisions = await page.evaluate(function inspectConflictFit() {
    const ps = window.__physicsHost.webgl;
    ps.render();
    let count = 0;
    ps.model.root.traverse(function walk(n) {
      if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
        count += 1;
      }
    });
    return count;
  });
  if (conflictCollisions <= 0) {
    throw new Error(
      "Collision shapes must show while inspecting a floor-plan fit conflict.",
    );
  }
  await rehearsal
    .locator('.spatial-floor-map button[data-resource="source-table-1"]')
    .click({ force: true });
  await page.waitForFunction(function conflictCleared() {
    const ps = window.__physicsHost?.webgl;
    return Boolean(ps && !ps.model.isShowingCollisionShapes);
  });

  // Switch PhysicsScene between Perspective and Orthographic Top view and verify zero WebGL errors.
  const physicsTopBtn = page
    .getByRole("button", { name: "Top view", exact: true })
    .first();
  await physicsTopBtn.click();
  await page.waitForTimeout(200);
  await physicsTopBtn.click();
  await page.waitForTimeout(200);
  const orthoSwitchGlError = await page.evaluate(function checkSwitchGl() {
    const ps = window.__physicsHost.webgl;
    ps.render();
    return ps.host.renderer.getContext().getError();
  });
  if (orthoSwitchGlError !== 0) {
    throw new Error(
      "WebGL error after PhysicsScene ortho/perspective switch: " +
        orthoSwitchGlError,
    );
  }

  // Verify all remaining workcell variants (UR5e tooling + rack_ur5e + shifted pedestal +
  // obstruction_rack_low, FR10 pan-staging receiving pan, FR10 combined rack + obstruction_oven_pan,
  // and showRackLayout visual/collision translation lockstep).
  const variantMatrix = await page.evaluate(async function verifyAllVariants() {
    const entries = performance.getEntriesByType("resource");
    const findMod = function findModule(suffix) {
      const hit = entries.find(function match(e) {
        return new URL(e.name).pathname.endsWith(suffix);
      });
      return hit
        ? hit.name
        : `/src/features/workflow-simulator/spatial/${suffix}`;
    };
    const [{ PhysicsModel }, { loadWorkcellVisuals }] = await Promise.all([
      import(findMod("physics-model.ts")),
      import(findMod("physics-workcell-visuals.ts")),
    ]);

    const cases = [
      {
        name: "ur5e-combined-blocked-rack",
        robot: "universal-robots-ur5e",
        task: "table-to-rack",
        asset:
          "bakery-mujoco/fr10-workcell/native/universal-robots-ur5e/combined-blocked-rack-nominal.json",
        expectNodes: [
          "cell_gripper",
          "cell_upper_jaw",
          "pedestal_visual",
          "source_table_visual",
          "rack_ur5e",
          "oven_stand_visual",
          "obstruction_rack_low",
          "tray_mbco",
          "tray_cold_contents",
        ],
      },
      {
        name: "fr10-pan-staging",
        robot: "fairino-fr10",
        task: "table-to-rack",
        asset:
          "bakery-mujoco/fr10-workcell/native/fairino-fr10/pan-staging-nominal.json",
        expectNodes: [
          "standard_gripper",
          "standard_upper_jaw",
          "pedestal_visual",
          "source_table_visual",
          "rack_full",
          "tray_mbco",
          "tray_receiving_pan",
        ],
        forbidNodes: ["tray_cold_contents"],
      },
      {
        name: "fr10-combined-blocked-oven",
        robot: "fairino-fr10",
        task: "table-to-oven",
        asset:
          "bakery-mujoco/fr10-workcell/native/fairino-fr10/combined-blocked.json",
        expectNodes: [
          "standard_gripper",
          "standard_upper_jaw",
          "rack_combined",
          "oven_stand_visual",
          "obstruction_oven_pan",
        ],
      },
    ];

    const assetEntry = entries.find(function findAsset(e) {
      return e.name.includes("/assets/bakery-mujoco/");
    });
    if (!assetEntry) {
      throw new Error(
        "Missing /assets/bakery-mujoco/ entry in resource timings",
      );
    }
    const assetsPrefix = assetEntry.name.slice(
      0,
      assetEntry.name.indexOf("/assets/bakery-mujoco/") + "/assets/".length,
    );

    const summary = [];
    for (const c of cases) {
      const resp = await fetch(`${assetsPrefix}${c.asset}`);
      if (!resp.ok) {
        throw new Error(`Unable to fetch ${c.asset}: ${resp.status}`);
      }
      const setup = await resp.json();
      const motion = {
        kind: "persistent-physics-motion",
        request: {
          bakeryTaskId: c.task,
          robot: c.robot,
          timestep: 0.002,
          layout: { kind: "fixed" },
        },
        robotBase: setup.robotBase,
        fixture: setup.fixture,
        geometry: setup.geometry,
        samples: [
          {
            step: 0,
            joints: [0, -1.2, 1.4, -1.5, -1.57, 0],
            tool: [0.6, 0, 0.85, 1, 0, 0, 0],
            jaw: [0.6, 0, 0.88, 1, 0, 0, 0],
            tray: [1.05, -0.35, 0.801, 0.70710678, 0, 0, -0.70710678],
          },
        ],
        endStep: 0,
      };
      const model = new PhysicsModel(motion);
      try {
        const ctrl = new AbortController();
        const bundle = await loadWorkcellVisuals(
          { ur5eTooling: model.usesUr5eTooling() },
          ctrl.signal,
        );
        model.attachWorkcellVisuals(bundle);

        for (const nodeName of c.expectNodes) {
          if (!model.root.getObjectByName(nodeName)) {
            throw new Error(
              `${c.name}: missing expected visual node ${nodeName}`,
            );
          }
        }
        for (const forbid of c.forbidNodes ?? []) {
          if (model.root.getObjectByName(forbid)) {
            throw new Error(`${c.name}: unexpected node ${forbid}`);
          }
        }

        // Verify rack_visual moves in exact lockstep with rack_rail_left under showRackLayout.
        const rackVis = model.root.getObjectByName("rack_visual");
        const railLeft = model.root.getObjectByName("rack_rail_left");
        if (rackVis && railLeft) {
          const beforeVisX = rackVis.position.x;
          const beforeRailX = railLeft.position.x;
          model.showRackLayout(
            { kind: "fixed" },
            { kind: "rack-offset", xMm: 185, yMm: -90 },
          );
          const dxVis = rackVis.position.x - beforeVisX;
          const dxRail = railLeft.position.x - beforeRailX;
          if (
            Math.abs(dxVis - 0.185) > 1e-6 ||
            Math.abs(dxVis - dxRail) > 1e-6
          ) {
            throw new Error(
              `${c.name}: rack_visual delta ${dxVis} != rack_rail_left delta ${dxRail}`,
            );
          }
        }

        let hiddenCheckOk = true;
        model.root.traverse(function checkHidden(n) {
          if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
            hiddenCheckOk = false;
          }
        });
        model.setFitCheckActive(true);
        let fitShownCount = 0;
        model.root.traverse(function checkShown(n) {
          if (n.isMesh && n.userData.isCollisionShape === true && n.visible) {
            fitShownCount += 1;
          }
        });
        if (!hiddenCheckOk || fitShownCount !== setup.geometry.length) {
          throw new Error(
            `${c.name}: collision visibility mismatch (hiddenOk=${hiddenCheckOk}, shown=${fitShownCount}, expected=${setup.geometry.length})`,
          );
        }
        summary.push({
          name: c.name,
          ur5eTooling: model.usesUr5eTooling(),
          collisionCount: fitShownCount,
        });
      } finally {
        model.dispose();
      }
    }
    return summary;
  });

  if (consoleErrors.length > 0) {
    throw new Error("Browser console errors: " + consoleErrors.join(" | "));
  }

  return {
    result: "passed",
    hasWebGL: true,
    bakeryStats,
    livingRigStats,
    refPlaneY,
    physicsStats,
    ovenBeforeFit,
    ovenDuringFit,
    ovenAfterFit,
    variantMatrix,
  };
}
