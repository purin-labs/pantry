// Shared navigation for the bakery simulator browser journeys.
// browser-acceptance.mjs puts these functions in front of every journey, so a
// journey calls them as it calls its own helpers.
//
// Each function uses the control that a person sees and clicks. The Workflow
// panel opens the rehearsal, the production and the recipe authors from its
// catalog cards, and Details → Inputs opens the tray and scenario editor.
//
// Scenarios, Compare and the recording examples (Robot rehearsal) have no
// visible control: their only entry is the "More simulator tools" menu, whose
// trigger is a 1-pixel screen-reader alias (tabIndex -1) that a pointer click
// cannot hit. The same is true of "Back to examples". For those, the journey
// takes the keyboard path of a screen-reader user: focus the alias and press
// Enter, then choose the menu item.

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

// The Portal imports @seams/production-simulation as /@fs/<checkout>/... and
// keeps state in some of its modules (the live floor plan's walk routes, the
// evidence views). A journey that reads or sets that state imports the same
// module instance through this path, not through /@id/.
function checkoutRoot() {
  const evidence = globalThis.bakeryEvidence;
  return evidence.slice(0, evidence.lastIndexOf("/output/"));
}

function portalSimulationSource() {
  return `/@fs${checkoutRoot()}/packages/production-simulation/src`;
}

// Page code that reads checkout files uses window.satyrCheckout; it stays set
// across reloads.
async function exposeCheckout(page) {
  const script = `window.satyrCheckout = ${JSON.stringify(checkoutRoot())};`;
  await page.addInitScript(script);
  await page.evaluate(script);
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

async function pressHiddenAlias(locator) {
  await locator.focus();
  await locator.press("Enter");
}

async function chooseMoreSimulatorTool(page, item) {
  await waitForBakeryScene(page);
  await pressHiddenAlias(page.locator("#workflow-more"));
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
