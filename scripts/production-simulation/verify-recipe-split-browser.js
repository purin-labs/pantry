/**
 * Browser verification for the Split view across all nine recipe simulation
 * workspaces (Workflow canvas in the start slot next to the 3D Three.js
 * simulation in the end slot) plus the multi-cell floor-plan exclusion.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-recipe-split-browser.js \
 *   --url http://127.0.0.1:3148/factory-acceptance.html --output <directory> --timeout 600000
 */
async function verifyRecipeSplitBrowser(page) {
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture);
  await page.evaluate(() => localStorage.removeItem("pantry-recipe-split-percent"));

  async function openRecipe(cardPattern, formName, prepareName) {
    await page.goto(fixture);
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
    const back = page.getByRole("button", { name: "← Back", exact: true }).first();
    if (await back.isVisible()) await back.click();
    await page.getByRole("button", { name: cardPattern }).click();
    const form = page.getByRole("form", { name: formName, exact: true });
    await form.waitFor({ timeout: 30000 });
    await form.getByRole("button", { name: prepareName, exact: true }).click();
    return page.getByRole("region", { name: "Persistent production", exact: true });
  }

  function overlaps(a, b) {
    if (!a || !b || a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) {
      return false;
    }
    return (
      a.x < b.x + b.width - 1 &&
      a.x + a.width > b.x + 1 &&
      a.y < b.y + b.height - 1 &&
      a.y + a.height > b.y + 1
    );
  }

  async function measureSplitBoxes() {
    return page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return null;
        return el.getBoundingClientRect();
      };
      return {
        wf: rect(".factory-workflow-canvas"),
        main: rect(".factory-main-canvas"),
        sep: rect(".factory-split-divider"),
        canvas: rect(".factory-main-canvas canvas"),
        header: rect("header.factory-toolbar"),
        stages: rect(".recipe-workflow > ol"),
        status: rect(".pour-over-status, .siphon-status"),
        camera: rect(".pour-over-camera-bar, .siphon-camera-bar"),
        note: rect(".pour-over-note, .siphon-note"),
        footer: rect("footer.factory-bottom"),
      };
    });
  }

  function assertSplitGeometry(id, boxes, { requireStages = true } = {}) {
    if (!boxes.wf || Math.abs(boxes.wf.x) > 1) {
      throw new Error(`${id}: workflow pane is not in the start slot: ${JSON.stringify(boxes.wf)}`);
    }
    if (!boxes.main || Math.abs(boxes.wf.x + boxes.wf.width - boxes.main.x) > 2) {
      throw new Error(
        `${id}: workflow and 3D panes do not meet cleanly at the split seam: ${JSON.stringify({
          wf: boxes.wf,
          main: boxes.main,
        })}`,
      );
    }
    if (!boxes.canvas || boxes.canvas.width < 320 || boxes.canvas.height < 320) {
      throw new Error(`${id}: 3D canvas has collapsed dimensions: ${JSON.stringify(boxes.canvas)}`);
    }
    if (requireStages && (!boxes.stages || overlaps(boxes.header, boxes.stages))) {
      throw new Error(`${id}: toolbar overlaps the workflow stage track in Split mode.`);
    }
    if (overlaps(boxes.header, boxes.status)) {
      throw new Error(`${id}: toolbar overlaps the 3D station status card in Split mode.`);
    }
    if (overlaps(boxes.camera, boxes.footer)) {
      throw new Error(`${id}: 3D camera bar overlaps the playback footer in Split mode.`);
    }
    if (overlaps(boxes.note, boxes.footer)) {
      throw new Error(`${id}: 3D station note overlaps the playback footer in Split mode.`);
    }
    if (overlaps(boxes.note, boxes.camera)) {
      throw new Error(`${id}: 3D station note overlaps the camera bar in Split mode.`);
    }
  }

  async function verifyStepDrawerGeometry(id, workflowPane, nodeLocator) {
    await nodeLocator.click();
    const stepDrawer = workflowPane.getByRole("complementary", { name: "Step details" });
    await stepDrawer.waitFor({ timeout: 10000 });
    const drawerBoxes = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      return {
        wf: rect(".factory-workflow-canvas"),
        stages: rect(".recipe-workflow > ol"),
        drawer: rect(".recipe-graph-drawer"),
        dock: rect(".recipe-graph-chrome-row"),
      };
    });
    if (overlaps(drawerBoxes.drawer, drawerBoxes.stages)) {
      throw new Error(
        `${id}: Step details drawer overlaps stage bar in Split mode: ${JSON.stringify(drawerBoxes)}`,
      );
    }
    if (overlaps(drawerBoxes.drawer, drawerBoxes.dock)) {
      throw new Error(
        `${id}: Step details drawer overlaps bottom tools in Split mode: ${JSON.stringify(drawerBoxes)}`,
      );
    }
    if (
      !drawerBoxes.drawer ||
      !drawerBoxes.wf ||
      drawerBoxes.drawer.x + drawerBoxes.drawer.width > drawerBoxes.wf.x + drawerBoxes.wf.width + 1
    ) {
      throw new Error(`${id}: Step details drawer spilled outside the workflow split pane.`);
    }
    return stepDrawer;
  }

  const verifiedRecipes = [];

  // 1. Deep interactive journey on Caffe Latte · Linea Classic S & FAIRINO FR10.
  const workspace = await openRecipe(
    /^Caffe latte/,
    "Caffe latte recipe",
    "Prepare caffe latte",
  );
  const surfaceGroup = workspace.getByRole("group", { name: "Surface view" });
  const splitButton = surfaceGroup.getByRole("button", { name: "Split", exact: true });
  await splitButton.click();
  await page.waitForTimeout(220);

  if ((await workspace.getAttribute("data-surface")) !== "split") {
    throw new Error("latte: workspace did not enter data-surface=split.");
  }

  const workflowPane = workspace.locator(".factory-workflow-canvas");
  const mainPane = workspace.locator(".factory-main-canvas");
  const divider = workspace.getByRole("separator", { name: "Resize workflow pane" });
  const graph = workflowPane.locator('.recipe-graph[data-graph="ready"]');
  await graph.waitFor({ timeout: 30000 });
  await mainPane.locator("canvas").first().waitFor({ timeout: 30000 });

  assertSplitGeometry("latte", await measureSplitBoxes());

  // Run Caffe Latte to completion while both Split panes are live.
  await workspace.getByRole("button", { name: "Start production", exact: true }).click();
  await workspace.getByRole("button", { name: "Run again", exact: true }).waitFor({
    timeout: 120000,
  });

  const completedPhase = await mainPane
    .locator("[data-latte-phase]")
    .getAttribute("data-latte-phase");
  if (completedPhase !== "completed") {
    throw new Error(`latte: expected 3D phase completed, got ${completedPhase}`);
  }
  const doneNodes = await graph.locator('.recipe-graph-node[data-state="done"]').count();
  if (doneNodes < 5) {
    throw new Error(`latte: expected workflow graph nodes to complete in lockstep, got ${doneNodes}`);
  }
  await page.screenshot({ path: "latte-split-light.png" });

  // Verify dark theme tokens in Split mode.
  await page.evaluate(() => {
    document.documentElement.dataset.portalTheme = "dark";
  });
  await page.waitForTimeout(180);
  await page.screenshot({ path: "latte-split-dark.png" });
  await page.evaluate(() => {
    document.documentElement.dataset.portalTheme = "light";
  });
  await page.waitForTimeout(180);

  // Seek Stage 3 from the left Workflow pane -> verify 3D station seeks in lockstep.
  await workflowPane
    .locator('.recipe-workflow > ol > li[data-stage="whirlpool"] > button')
    .click();
  const soughtPhase = await mainPane
    .locator("[data-latte-phase]")
    .getAttribute("data-latte-phase");
  if (soughtPhase !== "steam-whirlpool") {
    throw new Error(`latte: stage seek from Workflow pane did not move 3D scene: ${soughtPhase}`);
  }
  const soughtSeconds = Number(
    await workspace.getByLabel("Simulation seconds", { exact: true }).textContent(),
  );
  if (Math.abs(soughtSeconds - 31) > 1) {
    throw new Error(`latte: expected clock near 31.00 s after seeking stage 3, got ${soughtSeconds}`);
  }

  // Fit inside the Split workflow pane so all 5 columns frame inside the start slot.
  await workflowPane.getByRole("button", { name: "Fit", exact: true }).click();
  await page.screenshot({ path: "latte-split-fit.png" });
  await workflowPane.getByRole("button", { name: "Zoom in", exact: true }).click();

  // Open Step details drawer inside Split mode and verify zero overlap.
  const latteStepDrawer = await verifyStepDrawerGeometry(
    "latte",
    workflowPane,
    graph.locator('[data-graph-node="espresso-shot"]').first(),
  );
  await page.screenshot({ path: "latte-split-step-drawer.png" });
  await latteStepDrawer.getByRole("button", { name: "Close step details" }).click();

  // Keyboard + pointer resize of the Split seam and localStorage persistence.
  if ((await divider.getAttribute("aria-valuenow")) !== "48") {
    throw new Error(
      `latte: expected initial split percent 48, got ${await divider.getAttribute("aria-valuenow")}`,
    );
  }
  await divider.focus();
  await divider.press("ArrowRight");
  if ((await divider.getAttribute("aria-valuenow")) !== "52") {
    throw new Error(`latte: keyboard resize failed: ${await divider.getAttribute("aria-valuenow")}`);
  }
  const sepBox = await divider.boundingBox();
  await page.mouse.move(sepBox.x + sepBox.width / 2, sepBox.y + sepBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sepBox.x - 120, sepBox.y + sepBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const storedAfterDrag = await page.evaluate(() =>
    Number(localStorage.getItem("pantry-recipe-split-percent")),
  );
  if (!Number.isFinite(storedAfterDrag) || storedAfterDrag >= 52 || storedAfterDrag < 30) {
    throw new Error(`latte: pointer drag did not persist split width: ${storedAfterDrag}`);
  }
  await divider.dblclick();
  if ((await divider.getAttribute("aria-valuenow")) !== "48") {
    throw new Error("latte: double-click did not reset split divider to 48%.");
  }

  // Narrow viewport auto-collapses Split to Factory.
  await page.setViewportSize({ width: 760, height: 900 });
  await splitButton.waitFor({ state: "hidden" });
  if ((await workspace.getAttribute("data-surface")) !== "factory") {
    throw new Error("latte: narrow viewport did not reset Split surface back to Factory.");
  }
  if (await workflowPane.isVisible()) {
    throw new Error("latte: workflow pane remained visible on narrow viewport after Split reset.");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await splitButton.waitFor({ state: "visible" });

  verifiedRecipes.push({
    id: "latte",
    completedPhase,
    doneNodes,
    soughtPhase,
    soughtSeconds,
  });

  // 2. Remaining seven dedicated recipe simulation workspaces in Split mode.
  const otherDedicatedRecipes = [
    {
      id: "siphon",
      card: /^Siphon coffee/,
      form: "Siphon coffee recipe",
      prepare: "Prepare siphon coffee",
    },
    {
      id: "black-sesame",
      card: /^Black sesame milk/,
      form: "Black sesame milk Cobot recipe",
      prepare: "Prepare Black Sesame Milk 3D station",
    },
    {
      id: "ginger-tea",
      card: /^Ginger tea and milk tea/,
      form: "Ginger tea 3D MuJoCo pan-staging recipe",
      prepare: "Prepare Ginger Tea 3D station",
    },
    {
      id: "financier-batter",
      card: /^Financier batter/,
      form: "Financier batter Cobot recipe",
      prepare: "Prepare Financier batter station",
    },
    {
      id: "financier-bake",
      card: /^Financier bake/,
      form: "Financier bake Cobot recipe",
      prepare: "Prepare Financier bake station",
    },
    {
      id: "financier-pack",
      card: /^Financier pack/,
      form: "Financier pack Cobot recipe",
      prepare: "Prepare Financier pack station",
    },
    {
      id: "cafe-shift",
      card: /^Café shift/,
      form: "Combined café shift recipe",
      prepare: "Prepare combined café shift",
    },
  ];

  for (const recipe of otherDedicatedRecipes) {
    const rw = await openRecipe(recipe.card, recipe.form, recipe.prepare);
    await rw
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name: "Split", exact: true })
      .click();
    await page.waitForTimeout(220);

    if ((await rw.getAttribute("data-surface")) !== "split") {
      throw new Error(`${recipe.id}: workspace did not enter data-surface=split.`);
    }

    const wfPane = rw.locator(".factory-workflow-canvas");
    const threePane = rw.locator(".factory-main-canvas");
    const wfGraph = wfPane.locator('.recipe-graph[data-graph="ready"]');
    await wfGraph.waitFor({ timeout: 30000 });
    await threePane.locator("canvas").first().waitFor({ timeout: 30000 });

    // Start production with both panes mounted and advance to Stage 3.
    await rw.getByRole("button", { name: "Start production", exact: true }).click();
    await wfPane
      .locator('.recipe-workflow li[data-state="current"]')
      .and(wfPane.locator(".recipe-workflow li:nth-child(3)"))
      .waitFor({ timeout: 120000 });

    const beforeClock = Number(
      await rw.getByLabel("Simulation seconds", { exact: true }).textContent(),
    );
    const secondStageButton = wfPane.locator(".recipe-workflow li:nth-child(2) > button");
    await secondStageButton.click();
    await wfPane
      .locator('.recipe-workflow li:nth-child(2)[data-state="current"]')
      .waitFor({ timeout: 5000 });

    const afterClock = Number(
      await rw.getByLabel("Simulation seconds", { exact: true }).textContent(),
    );
    if (!(afterClock < beforeClock)) {
      throw new Error(
        `${recipe.id}: stage seek in Split mode did not move clock back (${beforeClock} -> ${afterClock}).`,
      );
    }
    const phaseAfter = await threePane
      .locator("section")
      .first()
      .evaluate((node) => {
        const key = Object.keys(node.dataset).find((k) => k.endsWith("Phase"));
        return key === undefined ? null : node.dataset[key];
      });
    if (!phaseAfter) {
      throw new Error(`${recipe.id}: 3D station did not expose an active phase in Split mode.`);
    }

    assertSplitGeometry(recipe.id, await measureSplitBoxes());

    const drawer = await verifyStepDrawerGeometry(
      recipe.id,
      wfPane,
      wfGraph.locator(".recipe-graph-node").first(),
    );
    await drawer.getByRole("button", { name: "Close step details" }).click();
    await page.waitForTimeout(180);
    await page.screenshot({ path: `${recipe.id}-split.png` });

    verifiedRecipes.push({
      id: recipe.id,
      soughtPhase: phaseAfter,
      soughtSeconds: afterClock,
    });
  }

  // 3. Single-station OvenWorkspace (Pour-over) in Split mode.
  const pourWorkspace = await openRecipe(
    /^Pour-over/,
    "Pour-over recipe",
    "Prepare pour-over",
  );
  await pourWorkspace
    .getByRole("group", { name: "Surface view" })
    .getByRole("button", { name: "Split", exact: true })
    .click();
  await page.waitForTimeout(220);

  const pourWf = pourWorkspace.locator(".factory-workflow-canvas");
  const pourGraph = pourWf.locator('.recipe-graph[data-graph="ready"]');
  await pourGraph.waitFor({ timeout: 30000 });
  await pourWorkspace.locator(".factory-main-canvas canvas").first().waitFor({ timeout: 30000 });

  await pourWorkspace.getByRole("button", { name: "Start production", exact: true }).click();
  await pourWorkspace
    .getByLabel("Simulation seconds", { exact: true })
    .filter({ hasNotText: /^0\.000$/ })
    .waitFor({ timeout: 30000 });
  await pourWorkspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();

  assertSplitGeometry("pour-over", await measureSplitBoxes(), { requireStages: false });
  const pourDrawer = await verifyStepDrawerGeometry(
    "pour-over",
    pourWf,
    pourGraph.locator(".recipe-graph-node").first(),
  );
  await pourDrawer.getByRole("button", { name: "Close step details" }).click();
  await page.waitForTimeout(180);
  await page.screenshot({ path: "pour-over-split.png" });

  const pourClock = Number(
    await pourWorkspace.getByLabel("Simulation seconds", { exact: true }).textContent(),
  );
  verifiedRecipes.push({
    id: "pour-over",
    pausedSeconds: pourClock,
  });

  // 4. Multi-cell OvenWorkspace keeps floor-plan Split only (no duplicate Split in Surface view).
  await page.goto(fixture);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page.getByRole("button", { name: "Prepare two-cell route", exact: true }).click();
  const multiCellWorkspace = page.getByRole("region", {
    name: "Persistent production",
    exact: true,
  });
  await multiCellWorkspace.waitFor({ timeout: 30000 });
  const multiSurfaceSplitCount = await multiCellWorkspace
    .getByRole("group", { name: "Surface view" })
    .getByRole("button", { name: "Split", exact: true })
    .count();
  if (multiSurfaceSplitCount !== 0) {
    throw new Error(
      `Expected multi-cell OvenWorkspace Surface view to omit Split, found ${multiSurfaceSplitCount}.`,
    );
  }

  // 5. PortalFrame shell check (/kitchen-chat-preview.html with sidebar, top-right controls, and chat rail).
  const portalPreviewUrl = new URL(
    "/kitchen-chat-preview.html?organisation=org_split_check",
    fixture,
  ).href;
  await page.context().addCookies([
    { name: "pantry_csrf", value: "stub-csrf", url: portalPreviewUrl },
  ]);
  const defaultProjectId = "project_00000000-0000-4000-8000-000000000001";
  await page.route("**/v1/control/**", async (route) => {
    const reqUrl = route.request().url();
    const method = route.request().method();
    if (method === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ receipt: { digest: "stub", revision: 1 } }),
      });
      return;
    }
    if (reqUrl.includes("/chat")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model: {
            kind: "ready",
            selected: "gpt-5.4",
            agent: "Pi",
            name: "GPT-5.4",
            options: [],
          },
          configurationVersion: 1,
          unreadCount: 0,
          projectDirectory: {
            revision: 1,
            defaultProjectId,
            projects: [
              {
                id: defaultProjectId,
                name: "General",
                brief: "",
                references: [],
                access: { kind: "shared", role: "owner", accessRevision: 1 },
                revision: 1,
                contentRevision: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            placements: [{ projectId: defaultProjectId, position: 0, collapsed: false }],
          },
          pendingDeletions: [],
          derivedThreads: [],
          pinnedConversations: [],
          conversations: [],
          archivedConversations: [],
          conversation: null,
          emailReviews: [],
          slackDrafts: [],
          configurationDrafts: [],
          sideCases: [],
          sideCaseSource: null,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ current: null, proposals: [], items: [] }),
    });
  });

  await page.setViewportSize({ width: 1760, height: 1000 });
  await page.goto(portalPreviewUrl);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  const portalBack = page.getByRole("button", { name: "← Back", exact: true }).first();
  if (await portalBack.isVisible()) await portalBack.click();
  await page.getByRole("button", { name: /^Caffe latte/ }).click();
  const portalForm = page.getByRole("form", { name: "Caffe latte recipe", exact: true });
  await portalForm.waitFor({ timeout: 30000 });
  await portalForm.getByRole("button", { name: "Prepare caffe latte", exact: true }).click();

  const portalWorkspace = page.getByRole("region", {
    name: "Persistent production",
    exact: true,
  });
  await portalWorkspace.waitFor({ timeout: 30000 });
  const portalSplit = portalWorkspace
    .getByRole("group", { name: "Surface view" })
    .getByRole("button", { name: "Split", exact: true });
  await portalSplit.click();
  await page.waitForTimeout(220);

  await portalWorkspace
    .locator('.factory-workflow-canvas .recipe-graph[data-graph="ready"]')
    .waitFor({ timeout: 30000 });
  await portalWorkspace.locator(".factory-main-canvas canvas").first().waitFor({ timeout: 30000 });

  const portalBoxes = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const unionRect = (selector) => {
      const boxes = [...document.querySelectorAll(selector)]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0);
      if (boxes.length === 0) return null;
      const left = Math.min(...boxes.map((b) => b.left));
      const top = Math.min(...boxes.map((b) => b.top));
      const right = Math.max(...boxes.map((b) => b.right));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
    };
    return {
      ws: rect(".persistent-production"),
      wf: rect(".factory-workflow-canvas"),
      main: rect(".factory-main-canvas"),
      canvas: rect(".factory-main-canvas canvas"),
      toolbar: rect(".persistent-production > header.factory-toolbar"),
      portalHeader: unionRect(
        ".portal-workspace-header .portal-nav > :not(.portal-nav-lead), .portal-workspace-header .portal-nav-lead > *",
      ),
      status: rect(".pour-over-status"),
      dockFloat: rect(".factory-workflow-canvas .recipe-graph-dock > .recipe-graph-float"),
    };
  });
  if (!portalBoxes.ws || portalBoxes.ws.height < 900) {
    throw new Error(`PortalFrame workspace did not fill shell height: ${JSON.stringify(portalBoxes.ws)}`);
  }
  if (!portalBoxes.wf || Math.abs(portalBoxes.wf.x - portalBoxes.ws.x) > 2) {
    throw new Error(`PortalFrame workflow pane misaligned with workspace start: ${JSON.stringify(portalBoxes)}`);
  }
  if (overlaps(portalBoxes.portalHeader, portalBoxes.toolbar)) {
    throw new Error(
      `PortalFrame top-right controls overlap factory toolbar in Split mode: ${JSON.stringify(portalBoxes)}`,
    );
  }
  if (overlaps(portalBoxes.portalHeader, portalBoxes.status)) {
    throw new Error("PortalFrame top-right controls overlap 3D status card in Split mode.");
  }
  if (overlaps(portalBoxes.toolbar, portalBoxes.status)) {
    throw new Error(
      `Factory toolbar overlaps 3D status card in Split mode: ${JSON.stringify(portalBoxes)}`,
    );
  }
  if (
    !portalBoxes.dockFloat ||
    portalBoxes.dockFloat.left < portalBoxes.wf.left - 1 ||
    portalBoxes.dockFloat.right > portalBoxes.wf.right + 1
  ) {
    throw new Error(
      `Workflow tool dock overflows narrow Split pane: ${JSON.stringify(portalBoxes)}`,
    );
  }
  await page.screenshot({ path: "portal-shell-split.png" });

  // Shrink window to 1280px while sidebar + chat rail stay open -> workspace <= 840px -> Split collapses to Factory!
  await page.setViewportSize({ width: 1280, height: 960 });
  await portalSplit.waitFor({ state: "hidden", timeout: 10000 });
  if ((await portalWorkspace.getAttribute("data-surface")) !== "factory") {
    throw new Error("PortalFrame narrow workspace with open chat rail did not collapse Split to Factory.");
  }

  return {
    result: "passed",
    recipeCount: verifiedRecipes.length,
    storedAfterDrag,
    multiSurfaceSplitCount,
    portalShellHeight: Math.round(portalBoxes.ws.height),
    verifiedRecipes,
  };
}
