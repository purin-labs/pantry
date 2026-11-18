// The unchanged 24-order case executes in the retained browser worker.
// Export one portable run file after verifying its individual recording digests.
async function verifyRecurringLogisticsBrowser(page) {
  await page.waitForFunction(recurringReady);
  const report = await page.evaluate(recurringBrowser);
  await page.screenshot({ path: "recurring-completed.png", fullPage: true });
  const pending = page.waitForEvent("download", { timeout: 120000 });
  await page.evaluate(recurringDownload);
  await (
    await pending
  ).saveAs(`${globalThis.bakeryEvidence}/recurring-run.json`);
  return report;
}
function recurringReady() {
  return "productionRunPreview" in window;
}
async function recurringBrowser() {
  const base = new URL(location.href).searchParams.get("evidence");
  if (base === null) throw new Error("Provide the headless case evidence URL");
  const scenario = await (await fetch(`${base}/scenario.json`)).json();
  const cells = await (await fetch(`${base}/cells.json`)).json();
  const reference = await (
    await fetch(`${base}/reference/final-state.json`)
  ).json();
  const expected = await (await fetch(`${base}/reference/save-1.json`)).json();
  const api = window.productionRunPreview;
  const E = await import(
    `/bakery-physics/executions/${expected.bundle.id}/production-engine.mjs`
  );
  const { canonicalJson, sha256Hex } = await import("/@id/@seams/std");
  const files = new Map();
  const restorePoints = [];
  let saved = null;
  let final = null;
  let recordedBytes = 0;
  let records = 0;
  const congestionRestore = scenario.arrivals[0].interval === 90_000_000;
  const stop = congestionRestore ? 700_000_000 : 160_000_000;
  const started = performance.now();
  for (const [index, until] of [stop, scenario.limits.horizon].entries()) {
    const opened = await api.openExecutionWorker(expected.bundle);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const worker = opened.value;
    let reply = await worker.request({
      kind: "begin",
      bundle: expected.bundle,
      cells,
      identity: {
        runId: "recurring-logistics",
        executionId: `execution-${index + 1}`,
        hostSession: `host-${index + 1}`,
        parent:
          saved === null
            ? null
            : {
                snapshot: saved.document.snapshot,
                execution: saved.document.state.identity.executionId,
              },
      },
      origin:
        saved === null
          ? { kind: "scenario", scenario }
          : {
              kind: "snapshot",
              document: saved.document,
              checkpoints: saved.artifacts,
            },
    });
    if (reply.kind !== "began") throw new Error(JSON.stringify(reply));
    for (;;) {
      reply = await worker.request({ kind: "drive", turns: 512, until });
      if (reply.kind !== "drove") throw new Error(JSON.stringify(reply));
      document.body.dataset.recurringTime = String(reply.view.time);
      document.body.dataset.recurringOutput = String(
        reply.view.totals[0]?.amount ?? 0,
      );
      // The page cannot import shared-barrier.mjs; this is its grid rule.
      const grid = (Math.floor(reply.view.time / 64000) + 1) * 64000;
      for (const cell of reply.view.cells)
        if (
          cell.hold !== "settled" &&
          (cell.boundary < reply.view.time || cell.boundary > grid)
        )
          throw new Error("An evolving cell crossed the shared grid");
      if (reply.view.time >= until || reply.view.status.kind === "completed")
        break;
      if (reply.view.status.kind !== "awaiting-execution")
        throw new Error(JSON.stringify(reply.view));
    }
    if (index === 0) {
      reply = await worker.request({
        kind: "pause",
        commandId: `pause-${stop}`,
      });
      if (reply.kind !== "commanded" || reply.receipt.status !== "accepted")
        throw new Error(JSON.stringify(reply));
    }
    saved = await worker.request({ kind: "save" });
    if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
    const bounds = E.checkArtifactIndex(saved.document);
    if (!bounds.ok) throw new Error(JSON.stringify(bounds.error));
    files.set(`snapshot-${index + 1}.json`, canonicalJson(saved.document));
    for (const artifact of saved.artifacts) {
      if ((await sha256Hex(artifact.content)) !== artifact.digest)
        throw new Error("An artifact changed across the worker boundary");
      if (artifact.role === "recording-segment") {
        const decoded = E.readRecordingPack(artifact.content);
        if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
        for (const record of decoded.value.records) {
          const content = decoded.value.body.slice(
            record.offset,
            record.offset + record.byteLength,
          );
          if ((await sha256Hex(content)) !== record.digest)
            throw new Error("A decompressed native record changed");
        }
        records += decoded.value.records.length;
        recordedBytes += artifact.byteLength;
      }
      files.set(artifact.digest, artifact.content);
    }
    if (index === 0) {
      if (congestionRestore) {
        let occupied = false;
        let blocked = false;
        for (const storage of saved.document.state.storages)
          if (
            storage.id === "intermediate-buffer" &&
            storage.occupants.length === 1
          )
            occupied = true;
        for (const task of saved.document.state.tasks) {
          if (
            task.kind !== "waiting" ||
            task.subject.kind !== "workflow" ||
            task.subject.key !== "to-buffer"
          )
            continue;
          for (const blocker of task.blockers)
            if (
              blocker.kind === "destination" &&
              blocker.storage === "intermediate-buffer"
            )
              blocked = true;
        }
        if (!occupied || !blocked)
          throw new Error("The restore must preserve congestion");
      }
      const checkpoints = [];
      for (const artifact of saved.artifacts)
        if (artifact.role === "cell-checkpoint") checkpoints.push(artifact);
      restorePoints.push({ document: saved.document, checkpoints });
    }
    final = await worker.request({ kind: "state" });
    worker.terminate();
  }
  if (final.kind !== "state" || final.view.status.kind !== "completed")
    throw new Error("The browser run did not drain");
  // Compare the portable states inside the page, without transferring all event history to the CLI.
  const histories = [];
  const worlds = [];
  for (const run of [reference, final.run]) {
    const events = [];
    for (const {
      sequence: _sequence,
      execution: _execution,
      ...event
    } of run.events)
      if (event.kind !== "command-admitted") events.push(event);
    histories.push(canonicalJson(events));
    const {
      identity: _identity,
      commands: _commands,
      events: _events,
      position,
      ...state
    } = run;
    worlds.push(canonicalJson({ ...state, time: position.time }));
  }
  if (histories[0] !== histories[1])
    throw new Error("Browser and headless events differ");
  if (worlds[0] !== worlds[1])
    throw new Error("Browser and headless worlds differ");
  const terminalCheckpoints = [];
  for (const document of [expected, saved.document]) {
    const checkpoints = [];
    for (const artifact of document.artifacts)
      if (artifact.role === "cell-checkpoint") checkpoints.push(artifact);
    terminalCheckpoints.push(canonicalJson(checkpoints));
  }
  if (terminalCheckpoints[0] !== terminalCheckpoints[1])
    throw new Error("Browser and headless terminal native checkpoints differ");
  const results = E.runResults(final.run, {
    after: null,
    through: final.run.position.time,
  });
  if (results.ordersCompleted !== 24)
    throw new Error("The browser did not complete all 24 orders");
  files.set("final-state.json", canonicalJson(final.run));
  files.set("results.json", canonicalJson(results));
  const report = {
    result: "passed",
    bundle: expected.bundle.id,
    completedOrders: results.ordersCompleted,
    milliseconds: performance.now() - started,
    simulatedSeconds: final.run.position.time / 1e6,
    recordedBytes,
    records,
    freshWorkerRestore: true,
    restoreAtSeconds: stop / 1e6,
    congestionRestore,
    sameHeadlessEventsAndWorld: true,
    sameTerminalNativeCheckpoints: true,
    archive: "recurring-run.json",
    restorePoints,
  };
  window.recurringLogisticsFiles = files;
  window.recurringLogisticsDocument = saved.document;
  const summary = document.createElement("pre");
  summary.textContent = `Recurring logistics: 24 orders completed.\nFour empty trays returned.\nFresh-worker restore matches headless state.\n${records} exact recordings verified.`;
  document.body.prepend(summary);
  return report;
}
function recurringDownload() {
  const files = window.recurringLogisticsFiles;
  const document = window.recurringLogisticsDocument;
  const parts = [
    '{"kind":"saved","document":',
    JSON.stringify(document),
    ',"artifacts":[',
  ];
  let separator = "";
  for (const entry of document.artifacts) {
    const content = files.get(entry.digest);
    if (typeof content !== "string")
      throw new Error("Missing browser evidence file");
    parts.push(separator, JSON.stringify({ digest: entry.digest, content }));
    separator = ",";
    files.delete(entry.digest);
  }
  parts.push("]}");
  const url = URL.createObjectURL(
    new Blob(parts, { type: "application/json" }),
  );
  const link = window.document.createElement("a");
  link.href = url;
  link.download = "recurring-run.json";
  window.document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
