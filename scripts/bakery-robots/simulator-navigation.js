// Shared navigation and page fixtures for the bakery simulator browser
// journeys. browser-acceptance.mjs puts these functions in front of every
// journey, so a journey calls them as it calls its own helpers.
//
// Each function uses the control that a person sees and clicks. The Workflow
// panel opens the rehearsal, the production and the recipe authors from its
// catalog cards, and Details → Inputs opens the tray and scenario editor.
//
// Scenarios, Compare and the recording examples (Robot rehearsal) are items of
// the "More" menu of the simulator's top bar. "Back to examples" is a
// 1-pixel screen-reader alias (tabIndex -1) of a production opened from an
// example; a person leaves through "← Back" in the Workflow panel. For that
// alias, the journey takes the keyboard path of a screen-reader user: focus
// it and press Enter.

// The bakery scene loads after the page. Under SwiftShader its load blocks the
// page for about 50 seconds, and a click in that time fails. A person waits
// until "Loading bakery assets…" goes away; the journey does the same.
async function waitForBakeryScene(page) {
  await page
    .locator("#workflow-toggle-workflow")
    .waitFor({ state: "attached", timeout: 60000 });
  await page.waitForFunction(bakerySceneLoaded, null, {
    polling: 250,
    timeout: 240000,
  });
}

function bakerySceneLoaded() {
  return !document.body.textContent.includes("Loading bakery assets…");
}

// The production opens its own bakery scene, with the same block. The camera
// controls stay disabled until that scene is ready.
async function waitForProductionScene(page) {
  await page.waitForFunction(productionSceneLoaded, null, {
    polling: 250,
    timeout: 240000,
  });
}

function productionSceneLoaded() {
  const scene = document.querySelector(".production-scene");
  return (
    scene !== null && scene.getAttribute("data-scene-status") !== "loading"
  );
}

// The address of a checkout file on the dev server, from its path in the
// repository, for the code of a journey that runs in Node. Page code gets the
// same address from sourceUrl of /source-url.js (apps/portal/vite.config.ts).
function checkoutUrl(path) {
  const evidence = globalThis.bakeryEvidence;
  return `/@fs${evidence.slice(0, evidence.lastIndexOf("/output/"))}/${path}`;
}

// The Portal imports @purin-labs/production-simulation as /@fs/<checkout>/... and
// keeps state in some of its modules (the live floor plan's walk routes, the
// evidence views). A journey that reads or sets that state imports the same
// module instance through this path, not through /@id/.
function portalSimulationSource() {
  return checkoutUrl("packages/production-simulation/src");
}

async function openWorkflowCatalog(page) {
  await waitForBakeryScene(page);
  const toggle = page.locator("#workflow-toggle-workflow");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  const dock = page.locator("#workflow-dock-workflow");
  await dock.waitFor();
  // A loaded procedure opens the panel on its steps; Back shows the catalog.
  if (
    (await dock.locator('.production-menu-track[data-depth="1"]').count()) > 0
  )
    await dock.getByRole("button", { name: "← Back", exact: true }).click();
  return dock;
}

async function openWorkflowCard(page, name) {
  const dock = await openWorkflowCatalog(page);
  await dock.getByRole("button", { name }).click();
}

// Multi-tray robot rehearsal: the production with procedure "rehearsal".
async function openRobotRehearsal(page) {
  await openWorkflowCard(
    page,
    /^Multi-tray robot rehearsal \(Tray A → Tray B\)/,
  );
  await waitForProductionScene(page);
}

// Multi-batch production + Robot: the Financier production.
async function openMultiBatchProduction(page) {
  await openWorkflowCard(page, /^Multi-batch production \+ Robot \(Batch A/);
  await waitForProductionScene(page);
}

// Combined Café Shift: the bakery shift, café shift and two-cell route authors.
async function openRecipeAuthors(page) {
  await openWorkflowCard(page, /^Combined Café Shift · Financiers & Espresso/);
  await waitForProductionScene(page);
}

// The root of the production's Workflow panel: its catalog and the picker
// "Open recipe, oven route or saved production run".
async function showProductionCatalog(page) {
  await page
    .getByRole("navigation", { name: "Production workcell views" })
    .getByRole("button", { name: "Workflow", exact: true })
    .click();
}

// Edit trays (rehearsal) and Edit scenario (production) are the Inputs tab of
// the Details panel.
async function editInputs(page) {
  await page
    .getByRole("navigation", { name: "Production workcell views" })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await page
    .locator(".production-panel")
    .getByRole("tab", { name: "Inputs", exact: true })
    .click();
}

// The simulator's Inputs dock is the Inputs tab of its Details panel. The
// "Inputs" button of the top bar is a 1-pixel screen-reader alias.
async function openSimulatorInputs(page) {
  const dock = page.locator("#workflow-dock-inputs");
  if (await dock.isVisible()) return;
  const details = page.locator("#workflow-toggle-inspector");
  if ((await details.getAttribute("aria-expanded")) !== "true")
    await details.click();
  await page
    .locator("#workflow-dock-inspector")
    .getByRole("tab", { name: "Inputs", exact: true })
    .click();
  await dock.waitFor();
}

// The label of the More menu states the run's finish: "Finish ~07:42 · 0
// unfinished".
async function simulatorFinish(page) {
  await page.locator("#workflow-more").click();
  const menu = page.getByRole("menu", {
    name: "More simulator tools",
    exact: true,
  });
  const text = await menu.locator(".workflow-more-summary").innerText();
  await page.keyboard.press("Escape");
  // A click during the close animation does not open the menu again.
  await menu.waitFor({ state: "detached" });
  return text;
}

async function pressHiddenAlias(locator) {
  await locator.focus();
  await locator.press("Enter");
}

async function chooseMoreSimulatorTool(page, item) {
  await waitForBakeryScene(page);
  await page.locator("#workflow-more").click();
  await page
    .getByRole("menu", { name: "More simulator tools", exact: true })
    .getByRole("menuitem", { name: item, exact: true })
    .click();
}

// The recording viewer with its examples, Setup & files and Compare & files.
async function openRecordingViewer(page) {
  await chooseMoreSimulatorTool(page, "Robot rehearsal");
  await page
    .getByRole("heading", { name: "Robot rehearsal", exact: true })
    .waitFor();
}

async function openScenarios(page) {
  await chooseMoreSimulatorTool(page, "Scenarios");
}

async function openComparison(page) {
  await chooseMoreSimulatorTool(page, "Compare");
}

// From a production opened from an example, back to the recording examples.
async function backToExamples(page) {
  await pressHiddenAlias(
    page
      .getByRole("navigation", { name: "Production workcell views" })
      .getByRole("button", { name: "Back to examples", exact: true }),
  );
}

// The factory workspace's detail panels: Scenario, Logistics, Results,
// Inspector and Save.
async function openFactoryPanel(page, name) {
  const pill = page
    .getByRole("group", { name: "Detail panels", exact: true })
    .getByRole("button", { name, exact: true });
  if ((await pill.getAttribute("aria-expanded")) !== "true") await pill.click();
}

// The factory workspace's task graph shows in its Workflow and Split views.
// Each factory canvas pane reports its scene; a loading scene blocks the page.
function factoryScenesLoaded() {
  const panes = document.querySelectorAll(".factory-pane[data-scene]");
  for (const pane of panes)
    if (pane.getAttribute("data-scene") === "loading") return false;
  return true;
}

async function showFactoryWorkflow(page) {
  await page.waitForFunction(factoryScenesLoaded, null, {
    polling: 250,
    timeout: 240000,
  });
  const views = page.getByRole("group", { name: "Surface view", exact: true });
  const split = views.getByRole("button", { name: "Split", exact: true });
  if ((await split.count()) > 0) await split.click({ timeout: 120000 });
  else
    await views
      .getByRole("button", { name: "Workflow", exact: true })
      .click({ timeout: 120000 });
}

// Open a closed <details> section by its summary, as a person does.
async function openDisclosure(details, summary) {
  if (!(await details.evaluate((element) => element.open)))
    await details.getByText(summary, { exact: true }).click();
}

// The physics inspection controls sit in the Inspector panel's closed
// "Physics details" section.
async function openPhysicsDetails(page) {
  await openFactoryPanel(page, "Inspector");
  await openDisclosure(
    page.locator("details.factory-physics-details"),
    "Physics details",
  );
}

// The factory's recorded history (resources, scheduling, storage) is the
// History panel of its playback bar.
async function openFactoryHistory(page) {
  const history = page
    .locator(".factory-playback-actions")
    .getByRole("button", { name: "History", exact: true });
  if ((await history.getAttribute("aria-expanded")) !== "true")
    await history.click();
}

// The factory timeline renders its task rows only while it is open.
async function showFactoryTimeline(page) {
  const toggle = page.locator(".factory-playback .production-timeline-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

// The factory workspace keeps its save file in the Save detail panel.
async function downloadFactorySave(page) {
  await openFactoryPanel(page, "Save");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download save file", exact: true })
    .click();
  return download;
}

// A live run asks before it stops. The journey accepts that question.
async function backToRecipes(page) {
  const accept = (dialog) => dialog.accept();
  page.on("dialog", accept);
  try {
    await page
      .getByRole("button", { name: "Back to recipes", exact: true })
      .click();
  } finally {
    page.off("dialog", accept);
  }
}

// Physics diagnostics render only in the workflow preview with ?evidence.
async function openPhysicsEvidence(page) {
  const url = new URL(page.url());
  if (url.searchParams.has("evidence")) {
    await page.reload();
    return;
  }
  url.searchParams.set("evidence", "");
  await page.goto(url.href);
}

// Holds one worker's asset fetch so Stop or Apply lands at a known task
// boundary: the journey routes the fetches to handle(), waits for `blocked`
// and calls release().
class WorkerFetchGate {
  count = 0;
  releaseWait = null;
  reached = null;
  constructor(blockAt) {
    this.blockAt = blockAt;
    this.blocked = new Promise(this.captureReached.bind(this));
  }
  captureReached(resolve) {
    this.reached = resolve;
  }
  captureRelease(resolve) {
    this.releaseWait = resolve;
  }
  async handle(route) {
    this.count++;
    if (this.count === this.blockAt) {
      const wait = new Promise(this.captureRelease.bind(this));
      this.reached();
      await wait;
    }
    try {
      await route.continue();
    } catch {
      /* Stop terminates the fetching worker. */
    }
  }
  release() {
    this.releaseWait();
  }
}

// A saved run opens from the Files panel.
async function openRackRun(page, file) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(file);
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Saved rehearsal reopened paused" })
    .waitFor();
}

// The Files panel saves the run as <directory>/<name>.json.
async function saveRackRun(page, directory, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const download = await pending;
  await download.saveAs(`${directory}/${name}.json`);
}

// A journey that mounts the workflow simulator itself routes
// "**/src/dev/workflow-preview.tsx" here: the preview module then only loads
// the Portal's styles.
async function previewStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: `import "${checkoutUrl("surfaces/portal/ui/styles.css")}";`,
  });
}

// Page code: physics diagnostics show only after showPhysicsEvidence(), which
// the workflow preview calls for ?evidence. A journey that replaces the
// preview entry (previewStyles) calls this before it mounts the simulator,
// with portalSimulationSource().
async function showPortalPhysicsEvidence(simulationSource) {
  const { showPhysicsEvidence } = await import(
    `${simulationSource}/runs/physics-evidence.ts`
  );
  showPhysicsEvidence();
}

// Page code: mounts the Portal's workflow simulator route with `connection`
// ({ kind: "preview" }, { kind: "standalone" } or a "workspace"). A workspace
// saves through window.saveRecipeCopy, which installRecipeMutation sets.
async function mountWorkflowSimulator(connection) {
  const { sourceUrl } = await import("/source-url.js");
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: WorkflowSimulatorRoute } = await import(
    sourceUrl("areas/kitchen/ui/features/workflow-simulator/route.tsx")
  );
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkflowSimulatorRoute, {
        connection:
          connection.kind === "workspace"
            ? { ...connection, mutate: window.saveRecipeCopy }
            : connection,
      }),
    ),
  );
}

// Puts `save` in the page as window.saveRecipeCopy, the workspace's mutation.
async function installRecipeMutation(page, save = saveRecipeCopy) {
  await page.addScriptTag({
    content: `${save.toString()}\nwindow.saveRecipeCopy = ${save.name};`,
  });
}

// Page code: the oven workspace's save of a recipe copy, which may only post
// a run of the "oven-ui-acceptance" Organisation.
async function saveRecipeCopy(path, body) {
  if (path !== "/v1/control/organisations/oven-ui-acceptance/bakery/runs") {
    throw new Error("This journey must not mutate commerce.");
  }
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("The shared run save did not return a receipt.");
  }
  return response.json();
}

// The shared archive journeys (Plan 70 J3) send every control request to
// serve-archive-acceptance.mjs, not to the dev server's /v1 proxy.
const ARCHIVE_ORIGIN = "http://127.0.0.1:8840";
function isControlRequest(url) {
  return url.pathname.startsWith("/v1/");
}
async function forwardToArchive(route) {
  const url = new URL(route.request().url());
  await route.fulfill({
    response: await route.fetch({
      url: `${ARCHIVE_ORIGIN}${url.pathname}${url.search}`,
    }),
  });
}

// Page code: signs in one person of the archive fixture.
function signInToArchive(session) {
  document.cookie = `pantry_session=${session.token}; Path=/; SameSite=Lax`;
  document.cookie = `pantry_csrf=${session.csrfToken}; Path=/; SameSite=Lax`;
  window.archiveCsrf = session.csrfToken;
}

// Page code: the workspace's control write and read, with the CSRF token of
// the person whom signInToArchive signed in.
async function archiveMutation(path, body) {
  const { sourceUrl } = await import("/source-url.js");
  const { responseJson } = await import(
    sourceUrl("foundation/control/portal/control-client.ts")
  );
  return responseJson(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-pantry-csrf": window.archiveCsrf,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function archiveRead(path) {
  const { sourceUrl } = await import("/source-url.js");
  const { responseJson } = await import(
    sourceUrl("foundation/control/portal/control-client.ts")
  );
  return responseJson(await fetch(path, { credentials: "same-origin" }));
}
