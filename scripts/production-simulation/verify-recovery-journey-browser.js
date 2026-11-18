// A failed transfer, explicit recovery, and two destroyed browser workers.
// Run through scripts/bakery-robots/browser-acceptance.mjs against
// production-run-preview.html. The download retains saves and artifact bytes.
const recoveryEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan-70-recovery";

function recoveryCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function recoveryReady() {
  return "productionRunPreview" in window;
}

function recoveryAtPhase(expected) {
  return document.body.dataset.phase === expected;
}

function recoveryDataset() {
  return { ...document.body.dataset };
}

function recoveryFullShelfRefused() {
  return document.body.dataset.refusal === "recovery_destination_full";
}

function reuseRecoveryDefinition(definition) {
  window.productionRunPreview.session.definition = definition;
}

async function recoveryHistory(events) {
  const { canonicalJson } = await import("/@id/@seams/std");
  const history = [];
  for (const event of events) {
    if (event.kind === "command-admitted") continue;
    const { sequence, execution, command, ...transition } = event;
    history.push(transition);
  }
  return canonicalJson(history);
}

function recoveryControlFocused(button) {
  return button === document.activeElement;
}

async function recoveryWorld(run) {
  const { canonicalJson } = await import("/@id/@seams/std");
  const { identity, commands, events, position, ...world } = run;
  return canonicalJson({ ...world, time: position.time });
}

async function recoveryReference() {
  const api = window.productionRunPreview;
  const opened = await api.openExecutionWorker(null);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const worker = opened.value;
  try {
    const definition = api.weakClamp(await api.define(worker));
    const begin = {
      kind: "begin",
      bundle: worker.manifest.bundle,
      cells: [definition],
      identity: api.identity(0, null),
      origin: {
        kind: "scenario",
        scenario: await api.scenarioFor(definition, "recovery"),
      },
    };
    // Dispatch these together. The client must serialize asynchronous host
    // commands, so the read observes the completed drive after begin.
    const initial = await Promise.all([
      worker.request(begin),
      worker.request({ kind: "drive", turns: 8, until: 600_000_000 }),
      worker.request({ kind: "state" }),
    ]);
    if (
      initial[0].kind !== "began" ||
      initial[1].kind !== "drove" ||
      initial[2].kind !== "state" ||
      JSON.stringify(initial[1].view) !== JSON.stringify(initial[2].view)
    )
      throw new Error(
        "Overlapping begin, drive and read were not delivered in order.",
      );
    let recovered = 0;
    for (let calls = 0; calls < 5000; calls += 1) {
      const reply = await worker.request({
        kind: "drive",
        turns: 64,
        until: 600_000_000,
      });
      if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
      if (reply.view.status.kind === "completed") break;
      if (reply.view.status.kind !== "blocked") continue;
      const failed = reply.view.recoveries[0];
      if (failed?.kind !== "recovery-required")
        throw new Error("No failed transfer was projected.");
      recovered += 1;
      const command = await worker.request({
        kind: "recover",
        commandId: `reference-recovery-${recovered}`,
        task: failed.task,
        resource: "baker",
        storage: "reject-shelf",
        handling: 5_000_000,
        evidence: "assumed",
        reports: [{ product: "portioned-tray", destination: "rejected-trays" }],
      });
      if (command.kind !== "commanded" || command.receipt.status !== "accepted")
        throw new Error(JSON.stringify(command));
    }
    const final = await worker.request({ kind: "state" });
    if (
      final.kind !== "state" ||
      final.view.status.kind !== "completed" ||
      recovered !== 2
    )
      throw new Error("The reference did not complete two recoveries.");
    window.recoveryReferenceRun = {
      bundle: worker.manifest.bundle,
      definition,
      view: final.view,
      run: final.run,
    };
    // Requests after termination must fail, including requests already queued.
    const pending = worker.request({ kind: "state" });
    const queued = worker.request({ kind: "state" });
    worker.terminate();
    const closed = await Promise.allSettled([
      pending,
      queued,
      worker.request({ kind: "state" }),
    ]);
    for (const result of closed)
      if (
        result.status !== "rejected" ||
        result.reason.message !== "The execution worker was terminated"
      )
        throw new Error("A terminated worker accepted a request.");
    return window.recoveryReferenceRun;
  } finally {
    worker.terminate();
  }
}

function recoveryRememberSave() {
  const api = window.productionRunPreview;
  window.recoverySaves ??= [];
  window.recoverySaves.push(api.session.saved);
  const snapshot = api.session.saved.document;
  return {
    execution: api.session.execution,
    time: api.session.view.time,
    recovery: api.session.view.recoveries[0],
    snapshot: snapshot.snapshot,
    checkpoint: api.session.view.cells[0].checkpoint,
  };
}

async function recoveryCollectFinal() {
  const api = window.productionRunPreview;
  const worker = api.currentWorker();
  const reply = await worker.request({ kind: "state" });
  if (reply.kind !== "state") throw new Error(JSON.stringify(reply));
  const saved = await worker.request({ kind: "save" });
  if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
  for (const artifact of saved.artifacts)
    api.session.artifacts.set(artifact.digest, artifact);
  window.recoveryInterruptedRun = {
    view: reply.view,
    run: reply.run,
    document: saved.document,
  };
  return window.recoveryInterruptedRun;
}

function recoveryDownload() {
  const payload = {
    reference: window.recoveryReferenceRun,
    interrupted: window.recoveryInterruptedRun,
    saves: window.recoverySaves,
    artifacts: [...window.productionRunPreview.session.artifacts.values()],
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "recovery-session.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function verifyRecoveryJourneyBrowser(page) {
  await page.waitForFunction(recoveryReady);
  const reference = await page.evaluate(recoveryReference);
  await page.evaluate(reuseRecoveryDefinition, reference.definition);
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Scenario", exact: true }),
    { value: "recovery" },
  );
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page.waitForFunction(recoveryAtPhase, "ended", { timeout: 120000 });
  const blocked = await page.evaluate(recoveryDataset);
  recoveryCheck(
    blocked.status === "blocked" && blocked.recovery === "recovery-required",
    "The failed transfer was not offered for recovery.",
  );
  recoveryCheck(
    Number(blocked.time) === 30_000_000,
    "The failed world did not advance to the baker's return.",
  );
  // The trace shows task names, not ids; the row keeps its id as data.
  const failedOrder = blocked.recoveryTask.split("/")[0];
  const failedTrace = page
    .locator(`.operations-trace [data-task-id^=${JSON.stringify(failedOrder)}]`)
    .filter({ hasText: "Recovery required" });
  await failedTrace.getByRole("button", { name: /Recovery required/ }).click();
  await failedTrace
    .getByRole("button", { name: "Review recovery", exact: true })
    .click();
  recoveryCheck(
    await page
      .getByRole("button", { name: "Recover failed transfer", exact: true })
      .evaluate(recoveryControlFocused),
    "Trace did not reach the existing recovery control.",
  );
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Recovery destination" }),
    { value: "full-shelf" },
  );
  await page
    .getByRole("button", { name: "Recover failed transfer", exact: true })
    .click();
  await page.waitForFunction(recoveryFullShelfRefused);
  const refused = await page.evaluate(recoveryDataset);
  recoveryCheck(
    refused.checkpoint === blocked.checkpoint && refused.time === blocked.time,
    "Refused recovery changed physics.",
  );
  await page.screenshot({ path: `${recoveryEvidence}/recovery-refused.png` });
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Recovery destination" }),
    { value: "reject-shelf" },
  );
  await page.getByText("Simulation details", { exact: true }).click();
  await chooseOption(
    page,
    page.locator('.pantry-select-trigger[data-name="stop"]'),
    { value: "recovery-handling" },
  );
  await page
    .getByRole("button", { name: "Recover failed transfer", exact: true })
    .click();
  await page.waitForFunction(recoveryAtPhase, "saved", { timeout: 120000 });
  const handling = await page.evaluate(recoveryRememberSave);
  recoveryCheck(
    (await page
      .locator('.operations-trace [data-status="running"]')
      .count()) === 0,
    "A saved simulation still displays active work.",
  );
  recoveryCheck(
    handling.time === 31_000_000 && handling.recovery.phase === "handling",
    "The first save is outside human handling.",
  );
  await page.screenshot({ path: `${recoveryEvidence}/recovery-handling.png` });
  await page
    .getByRole("button", { name: "Destroy worker", exact: true })
    .click();
  await chooseOption(
    page,
    page.locator('.pantry-select-trigger[data-name="stop"]'),
    { value: "recovery-returning" },
  );
  await page
    .getByRole("button", { name: "Continue from save", exact: true })
    .click();
  await page.waitForFunction(recoveryAtPhase, "saved", { timeout: 120000 });
  const returning = await page.evaluate(recoveryRememberSave);
  recoveryCheck(
    returning.time === 38_000_000 && returning.recovery.phase === "returning",
    "The second save is outside the arm return.",
  );
  await page.screenshot({ path: `${recoveryEvidence}/recovery-returning.png` });
  await page
    .getByRole("button", { name: "Destroy worker", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue from save", exact: true })
    .click();
  await page.waitForFunction(recoveryAtPhase, "ended", { timeout: 120000 });
  const second = await page.evaluate(recoveryDataset);
  recoveryCheck(
    second.recovery === "recovery-required" &&
      second.recoveryTask !== blocked.recoveryTask,
    "The recovered cell did not admit the next order.",
  );
  await page
    .getByRole("button", { name: "Recover failed transfer", exact: true })
    .click();
  await page.waitForFunction(recoveryAtPhase, "ended", { timeout: 120000 });
  const interrupted = await page.evaluate(recoveryCollectFinal);
  await page
    .locator(".operations-trace")
    .getByText("Failed · resolved", { exact: true })
    .first()
    .waitFor();
  recoveryCheck(
    (await page
      .locator('.operations-trace [data-status="running"]')
      .count()) === 0,
    "Completed recovery still displays active work.",
  );
  const pendingDownload = page.waitForEvent("download");
  await page.evaluate(recoveryDownload);
  await (
    await pendingDownload
  ).saveAs(`${recoveryEvidence}/recovery-session.json`);

  recoveryCheck(
    interrupted.view.status.kind === "completed",
    "The recovered run did not drain.",
  );
  recoveryCheck(
    (await page.evaluate(recoveryHistory, interrupted.run.events)) ===
      (await page.evaluate(recoveryHistory, reference.run.events)),
    "Recovery histories differ.",
  );
  recoveryCheck(
    (await page.evaluate(recoveryWorld, interrupted.run)) ===
      (await page.evaluate(recoveryWorld, reference.run)),
    "Final factory states differ.",
  );
  recoveryCheck(
    interrupted.view.cells[0].checkpoint === reference.view.cells[0].checkpoint,
    "Final physical checkpoints differ.",
  );
  const failedOrders = interrupted.run.instances.filter(
    isFailedRecoveryOrder,
  ).length;
  const recoveredTransfers =
    interrupted.run.events.filter(isRecoveryComplete).length;
  const completedOrders = interrupted.run.events.filter(
    isRecoveryOrderComplete,
  ).length;
  const rejected = interrupted.run.events
    .filter(isRecoveryRejectedOutput)
    .reduce(addRecoveryQuantity, 0);
  recoveryCheck(
    failedOrders === 2 &&
      recoveredTransfers === 2 &&
      completedOrders === 0 &&
      rejected === 2,
    "Recovery changed the order or material outcome.",
  );
  await page.screenshot({ path: `${recoveryEvidence}/recovery-completed.png` });
  return {
    result: "passed",
    plan: "70 J2 browser recovery",
    bundle: reference.bundle,
    simulatedSeconds: interrupted.view.time / 1_000_000,
    finalCheckpoint: interrupted.view.cells[0].checkpoint,
    failedOrders,
    recoveredTransfers,
    completedOrders,
    rejectedTrays: rejected,
    legs: [handling, returning],
    agreement: { history: true, factoryState: true, checkpoint: true },
    refusals: {
      occupiedDestination: refused.refusal,
      leavesPhysicsUnchanged: true,
    },
    workerLifecycle: {
      overlappingCommandsSerialized: true,
      queuedAndFutureRequestsRejectedOnTermination: true,
    },
    artifact: "recovery-session.json",
  };
}

// The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
// combobox that opens a listbox popup. Choose by { value }, { label } or
// { index }. { values } sets the items of a multiple Select, then Escape
// closes its popup.
async function chooseOption(page, trigger, choice) {
  await trigger.click();
  const popup = page.locator(".pantry-select-popup[data-open]");
  await popup.waitFor();
  const items = popup.locator(".pantry-select-item");
  if ("values" in choice) {
    const wanted = choice.values.map(String);
    for (const item of await items.all()) {
      const chosen = wanted.includes(await item.getAttribute("data-value"));
      const selected = (await item.getAttribute("aria-selected")) === "true";
      if (chosen !== selected) await item.click();
    }
    await page.keyboard.press("Escape");
  } else if ("value" in choice) {
    await popup
      .locator(
        `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
      )
      .click();
  } else if ("label" in choice) {
    await popup
      .getByRole("option", { name: choice.label, exact: true })
      .click();
  } else {
    await items.nth(choice.index).click();
  }
  await popup.waitFor({ state: "hidden" });
}

function isFailedRecoveryOrder(instance) {
  return instance.kind === "failed";
}
function isRecoveryComplete(event) {
  return event.kind === "recovery-completed";
}
function isRecoveryOrderComplete(event) {
  return event.kind === "order-completed";
}
function isRecoveryRejectedOutput(event) {
  return event.kind === "quantity-reported" && event.role === "rejected-output";
}
function addRecoveryQuantity(total, event) {
  return total + event.quantity.amount;
}
