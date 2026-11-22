async function verifyTwoCellWorkspaceBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", twoCellStyles);
  await openPhysicsEvidence(page);
  await page.addScriptTag({
    content: [rememberTwoCellReply.toString(), TWO_CELL_WORKER_OBSERVER].join(
      "\n",
    ),
  });
  await page.evaluate(installTwoCellObserver);
  await page.evaluate(mountTwoCellWorkspace, portalSimulationSource());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openRecipeAuthors(page);
  const choices = (
    await selectItems(page, page.getByLabel("Logistics comparison"))
  ).length;
  if (choices !== 6)
    throw new Error("The workspace must expose the six accepted cases.");
  await chooseOption(page, page.getByLabel("Logistics comparison"), {
    value: "stress-one-slot",
  });
  await page
    .getByRole("button", { name: "Prepare two-cell route", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await waitForRunState(page, twoCellCongested);
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page.waitForFunction(twoCellPaused);
  await page.waitForFunction(twoCellScenesReady, null, { timeout: 60000 });
  const paused = await page.evaluate(twoCellState);
  await page.screenshot({ path: "two-cell-congestion.png", fullPage: true });
  for (const task of [
    "orders#0/source-transfer",
    "orders#0/receiving-transfer",
  ]) {
    await showFactoryWorkflow(page);
    await showFactoryTimeline(page);
    await page.locator(`[data-graph-task="${task}"]`).click();
    const selected = await page
      .locator(`[data-timeline-task="${task}"] button[aria-pressed="true"]`)
      .count();
    if (selected < 1) throw new Error("Graph and timeline selections differ.");
    await openPhysicsDetails(page);
    await page
      .getByRole("button", { name: "Inspect selected physics", exact: true })
      .click();
    const inspection = page.getByRole("region", {
      name: "Accepted physics inspection",
      exact: true,
    });
    await inspection.waitFor({ timeout: 120000 });
    const actual = await inspection.getAttribute("data-physics-task");
    if (actual !== task)
      throw new Error("The selected operation uses another cell.");
    await page
      .getByRole("button", { name: "Close physics inspection", exact: true })
      .click();
  }
  for (const cell of ["source-cell", "receiving-cell"]) {
    await openPhysicsDetails(page);
    await chooseOption(
      page,
      page.getByLabel("Cell to inspect", { exact: true }),
      { value: cell },
    );
    await page
      .getByLabel("Cell recording seconds", { exact: true })
      .fill("300");
    await page
      .getByRole("button", { name: "Inspect cell recording", exact: true })
      .click();
    const inspection = page.getByRole("region", {
      name: "Accepted physics inspection",
      exact: true,
    });
    await inspection.waitFor({ timeout: 120000 });
    if (!(await inspection.textContent()).includes(cell))
      throw new Error("Wrong inspected cell.");
    if (Number(await inspection.getAttribute("data-time")) > 300000000)
      throw new Error("Inspection crossed its requested time.");
    if ((await inspection.getAttribute("data-purpose")) !== "idle")
      throw new Error("Expected an idle recording between operations.");
    await inspection
      .getByLabel("Recorded physics sample", { exact: true })
      .fill("1");
    await inspection.getByText("Recorded contacts", { exact: true }).click();
    await inspection
      .locator(
        '[aria-label="Exact contact evidence"][data-coverage="recorded"]',
      )
      .waitFor();
    await page
      .getByRole("button", { name: "Close physics inspection", exact: true })
      .click();
  }
  const inspected = await page.evaluate(twoCellState);
  if (JSON.stringify(paused) !== JSON.stringify(inspected))
    throw new Error("Inspection changed committed logistics.");
  await page.addScriptTag({ content: rememberTwoCellBlob.toString() });
  await page.evaluate(captureTwoCellDownload);
  const download = downloadFactorySave(page);
  await (
    await download
  ).saveAs(`${globalThis.bakeryEvidence}/congested-run.json`);
  await backToRecipes(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .evaluate(reopenTwoCellFile);
  // The Portal checks every artifact of the saved archive before it offers
  // the run; that took 31 s here under SwiftShader.
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click({ timeout: 120000 });
  await page.waitForFunction(twoCellRestoreReceived, null, { timeout: 120000 });
  const restored = await page.evaluate(checkTwoCellRestore);
  // The restored overload run takes 140 s on a Mac under SwiftShader and more
  // than 720 s on a slow CI runner; the wait ends only if the run stops.
  await waitForRunState(page, runCompleted);
  const completed = await page.evaluate(twoCellState);
  const returned = await page
    .locator('[data-storage="tray-store"]')
    .textContent();
  for (const carrier of ["tray-a", "tray-b", "tray-c", "tray-d"])
    if (!returned.includes(carrier))
      throw new Error(`Missing returned tray ${carrier}.`);
  // The completed quantities are the Results panel's reported output.
  await openFactoryPanel(page, "Results");
  const quantities = await page
    .getByRole("table", { name: "Reported output", exact: true })
    .textContent();
  if (!quantities.includes("24 each"))
    throw new Error("The route did not complete all 24 orders.");
  await page.screenshot({ path: "two-cell-completed.png", fullPage: true });
  const connection = await page.context().newCDPSession(page);
  await connection.send("HeapProfiler.collectGarbage");
  const heap = await connection.send("Runtime.getHeapUsage");
  await connection.detach();
  const workers = await factoryWorkerMemory(page);
  await page
    .getByRole("button", { name: "Keep completed result", exact: true })
    .click();
  await backToRecipes(page);
  const comparison = page.getByRole("region", {
    name: "Factory comparisons",
    exact: true,
  });
  await comparison.waitFor();
  const keptResults = await comparison
    .locator("[data-comparison-result]")
    .count();
  if (
    keptResults !== 1 ||
    !(await comparison.textContent()).includes("6240.000")
  )
    throw new Error("Closing the run lost its completed comparison result.");
  // The checks above are the proof. The screenshot is evidence only, so the
  // scroll does not wait for a layout that a slow runner still paints.
  await comparison.evaluate((section) =>
    section.scrollIntoView({ block: "center" }),
  );
  await page.screenshot({
    path: "retained-factory-comparison.png",
    fullPage: true,
  });
  return {
    result: "passed",
    choices,
    keptResults,
    paused,
    restored,
    completed,
    returned,
    quantities,
    heap,
    workers,
    memoryScope:
      "Main page and execution worker after collection, with both cells and all logistics views. Peak and process memory remain unmeasured.",
  };
}

async function factoryWorkerMemory(page) {
  const browser = page.context().browser();
  if (browser === null) throw new Error("A browser connection is required.");
  const connection = await browser.newBrowserCDPSession();
  const results = [];
  try {
    const targets = await connection.send("Target.getTargets");
    for (const target of targets.targetInfos) {
      if (
        target.type !== "worker" ||
        !target.url.includes("production-engine.mjs")
      )
        continue;
      const attached = await connection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      });
      const worker = new FactoryWorkerProbe(connection, attached.sessionId);
      try {
        await worker.send("HeapProfiler.collectGarbage", {});
        const heap = await worker.send("Runtime.getHeapUsage", {});
        const prototype = await worker.send("Runtime.evaluate", {
          expression: "WebAssembly.Memory.prototype",
          objectGroup: "factory-memory",
        });
        const memories = await worker.send("Runtime.queryObjects", {
          prototypeObjectId: prototype.result.objectId,
          objectGroup: "factory-memory",
        });
        const sizes = await worker.send("Runtime.callFunctionOn", {
          objectId: memories.objects.objectId,
          functionDeclaration: factoryWasmSizes.toString(),
          returnByValue: true,
        });
        if (sizes.exceptionDetails !== undefined)
          throw new Error("The worker's Wasm memory could not be measured.");
        results.push({ url: target.url, heap, wasmBytes: sizes.result.value });
        await worker.send("Runtime.releaseObjectGroup", {
          objectGroup: "factory-memory",
        });
      } finally {
        await connection.send("Target.detachFromTarget", {
          sessionId: attached.sessionId,
        });
      }
    }
    if (results.length !== 1)
      throw new Error(
        `Expected one retained execution worker, found ${results.length}.`,
      );
    return results;
  } finally {
    await connection.detach();
  }
}

function factoryWasmSizes() {
  const bytes = [];
  for (const memory of this) bytes.push(memory.buffer.byteLength);
  return bytes;
}

class FactoryWorkerProbe {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.sequence = 0;
  }
  send(method, params) {
    return new Promise(this.exchange.bind(this, method, params));
  }
  exchange(method, params, resolve, reject) {
    const pending = {
      id: ++this.sequence,
      resolve,
      reject,
      listener: null,
      timer: null,
    };
    pending.listener = this.receive.bind(this, pending);
    pending.timer = setTimeout(
      this.fail.bind(
        this,
        pending,
        new Error(`Worker measurement timed out: ${method}`),
      ),
      10000,
    );
    this.connection.on("Target.receivedMessageFromTarget", pending.listener);
    void this.connection
      .send("Target.sendMessageToTarget", {
        sessionId: this.sessionId,
        message: JSON.stringify({ id: pending.id, method, params }),
      })
      .catch(this.fail.bind(this, pending));
  }
  receive(pending, event) {
    if (event.sessionId !== this.sessionId) return;
    const reply = JSON.parse(event.message);
    if (reply.id !== pending.id) return;
    this.clear(pending);
    if (reply.error !== undefined)
      pending.reject(new Error(JSON.stringify(reply.error)));
    else pending.resolve(reply.result);
  }
  clear(pending) {
    clearTimeout(pending.timer);
    this.connection.off("Target.receivedMessageFromTarget", pending.listener);
  }
  fail(pending, error) {
    this.clear(pending);
    pending.reject(error);
  }
}

async function twoCellStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}

// The stubbed preview module would turn on the evidence views; the mount
// does it on the Portal's own module instance.
async function mountTwoCellWorkspace(simulationSource) {
  const { sourceUrl } = await import("/source-url.js");
  if (document.documentElement.dataset.factoryFixture === "compiled") return;
  const { showPhysicsEvidence } = await import(
    `${simulationSource}/runs/physics-evidence.ts`
  );
  showPhysicsEvidence();
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: Route } = await import(
    sourceUrl("areas/kitchen/ui/features/workflow-simulator/route.tsx")
  );
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(Route, { connection: { kind: "preview" } }),
    ),
  );
}

function twoCellCongested() {
  const time = Number(
    document.querySelector('[aria-label="Simulation seconds"]')?.textContent,
  );
  const buffer = document.querySelector('[data-storage="intermediate-buffer"]');
  return time >= 700 && buffer?.textContent.includes("tray-");
}
function twoCellPaused() {
  return (
    document
      .querySelector('[aria-label="Persistent production"]')
      ?.getAttribute("data-lifecycle") === "settled" &&
    document.querySelector('[aria-label="Execution status"]')?.textContent ===
      "paused"
  );
}
// Each canvas pane reports its scene, and the cell picker names each cell.
function twoCellScenesReady() {
  const scene = document.querySelector(
    '[aria-label="Shared recorded factory"]',
  );
  const panes = scene?.querySelectorAll(".factory-pane[data-scene]") ?? [];
  const cells = scene?.querySelectorAll(
    '[aria-label="Select factory cell"] button:not([title])',
  );
  return (
    panes.length > 0 &&
    Array.from(panes).every((pane) => pane.dataset.scene === "ready") &&
    cells?.length === 2
  );
}

function twoCellState() {
  const cells = [];
  for (const row of document.querySelectorAll(
    '[aria-label="Committed production state"] table:first-of-type tbody tr',
  ))
    cells.push(row.textContent);
  const stores = [];
  for (const row of document.querySelectorAll("[data-storage]"))
    stores.push(row.textContent);
  return {
    time: document.querySelector('[aria-label="Simulation seconds"]')
      ?.textContent,
    status: document.querySelector('[aria-label="Execution status"]')
      ?.textContent,
    cells,
    stores,
  };
}
function captureTwoCellDownload() {
  window.twoCellCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = rememberTwoCellBlob;
}
function rememberTwoCellBlob(blob) {
  if (blob instanceof Blob && blob.type === "application/json")
    window.twoCellSavedFile = new File([blob], "congested-run.json", {
      type: "application/json",
    });
  return window.twoCellCreateObjectURL(blob);
}
function reopenTwoCellFile(input) {
  URL.createObjectURL = window.twoCellCreateObjectURL;
  if (!(window.twoCellSavedFile instanceof File))
    throw new Error("The download produced no archive.");
  const transfer = new DataTransfer();
  transfer.items.add(window.twoCellSavedFile);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function rememberTwoCellReply(event) {
  const reply = event.data?.reply;
  if (reply?.kind === "commanded" && reply.view.status.kind === "paused")
    window.twoCellPausedView = reply.view;
  if (reply?.kind === "began" && window.twoCellPausedView)
    window.twoCellRestoredView = reply.view;
}
const TWO_CELL_WORKER_OBSERVER = `class ObservedTwoCellWorker extends Worker {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", rememberTwoCellReply);
  }
}`;
function installTwoCellObserver() {
  window.Worker = ObservedTwoCellWorker;
}
async function checkTwoCellRestore() {
  const { canonicalJson } =
    window.factoryAcceptance ?? (await import("/@id/@purin-labs/std"));
  const before = window.twoCellPausedView;
  const after = window.twoCellRestoredView;
  if (!before || !after) throw new Error("Missing restored worker reply.");
  for (const field of [
    "time",
    "logistics",
    "resourceHistory",
    "storageHistory",
    "schedulingHistory",
    "totals",
  ])
    if (canonicalJson(before[field]) !== canonicalJson(after[field]))
      throw new Error(`Restore changed ${field}.`);
  if (before.cells.length !== after.cells.length)
    throw new Error("Restore changed the cell count.");
  for (let index = 0; index < before.cells.length; index++) {
    const saved = before.cells[index];
    const restored = after.cells[index];
    for (const field of [
      "id",
      "carrier",
      "boundary",
      "checkpoint",
      "steps",
      "hold",
    ])
      if (saved[field] !== restored[field])
        throw new Error(`Restore changed cell ${saved.id} ${field}.`);
    if (saved.attempt === null) {
      if (restored.attempt !== null)
        throw new Error("Restore invented an attempt.");
    } else {
      if (
        restored.attempt === null ||
        restored.attempt.id !== saved.attempt.id ||
        restored.attempt.steps !== saved.attempt.steps
      )
        throw new Error("Restore changed the native attempt.");
      const lifecycle =
        saved.attempt.lifecycle === "running"
          ? "dispatched"
          : saved.attempt.lifecycle;
      if (restored.attempt.lifecycle !== lifecycle)
        throw new Error("Restore did not dispatch the saved continuation.");
    }
  }
  return { time: after.time, cells: after.cells };
}

function twoCellRestoreReceived() {
  return window.twoCellRestoredView !== undefined;
}
