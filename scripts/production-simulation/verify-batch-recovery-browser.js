async function verifyBatchRecoveryBrowser(page) {
  await page.waitForFunction(batchRecoveryReady);
  return page.evaluate(batchRecoveryBrowser);
}
function batchRecoveryReady() {
  return "productionRunPreview" in window;
}
async function batchRecoveryBrowser() {
  const evidence = new URL(location.href).searchParams.get("evidence");
  if (evidence === null) throw new Error("Provide the headless evidence URL");
  const { canonicalJson } = await import("/@id/@seams/std");
  const api = window.productionRunPreview;
  const results = [];
  for (const [name, expectedFile] of [
    ["load", "recovered-loads"],
    ["retrieval", "recovered-retrievals"],
  ]) {
    const response = await fetch(`${evidence}/failed-${name}.json`);
    const expectedResponse = await fetch(`${evidence}/${expectedFile}.json`);
    if (!response.ok || !expectedResponse.ok)
      throw new Error("Missing recovery evidence");
    const input = await response.json();
    const expected = (await expectedResponse.json()).recovered;
    let saved = input.saved;
    let opened = await api.openExecutionWorker(null);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const bundle = opened.value.manifest.bundle;
    if (bundle.id !== saved.document.state.identity.bundle)
      throw new Error("Recovery bundle differs");
    let worker = opened.value;
    let began = await worker.request({
      kind: "begin",
      bundle,
      cells: [input.cell],
      identity: {
        runId: saved.document.state.identity.runId,
        executionId: `browser-${name}-0`,
        hostSession: `browser-${name}-0`,
        parent: {
          snapshot: saved.document.snapshot,
          execution: saved.document.state.identity.executionId,
        },
      },
      origin: {
        kind: "snapshot",
        document: saved.document,
        checkpoints: saved.artifacts,
      },
    });
    if (began.kind !== "began") throw new Error(JSON.stringify(began));
    let run = (await worker.request({ kind: "state" })).run;
    const saves = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      let failed = null;
      for (const task of run.tasks)
        if (task.kind === "recovery-required") failed = task;
      if (failed === null) throw new Error("Expected a failed cycle member");
      const reply = await worker.request({
        kind: "recover",
        commandId: `reject-cycle-member-${cycle}`,
        task: failed.id,
        resource: "baker",
        storage: "outbound-shelf",
        handling: 5_000_000,
        evidence: "assumed",
        reports: [{ product: "portioned-tray", destination: "rejected-trays" }],
      });
      if (reply.receipt?.status !== "accepted")
        throw new Error(JSON.stringify(reply));
      const start = run.position.time;
      for (const [phase, until] of [
        ["handling", start + 2_000_000],
        ["returning", start + 7_000_000],
        ["settled", input.scenario.limits.horizon],
      ]) {
        let done = false;
        for (let call = 0; call < 2000; call++) {
          const progress = await worker.request({
            kind: "drive",
            turns: 128,
            until,
          });
          if (progress.kind !== "drove")
            throw new Error(JSON.stringify(progress));
          if (
            progress.view.time >= until ||
            ["blocked", "completed"].includes(progress.view.status.kind)
          ) {
            done = true;
            break;
          }
        }
        if (!done) throw new Error("Recovery exceeded its host-call bound");
        run = (await worker.request({ kind: "state" })).run;
        if (phase === "settled") continue;
        let recovering = null;
        for (const task of run.tasks)
          if (task.id === failed.id) recovering = task;
        if (recovering?.recovery?.phase !== phase)
          throw new Error("Recovery phase differs");
        const paused = await worker.request({
          kind: "pause",
          commandId: `pause-recovery-${cycle}-${phase}`,
        });
        if (paused.receipt?.status !== "accepted")
          throw new Error(JSON.stringify(paused));
        saved = await worker.request({ kind: "save" });
        if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
        saves.push(saved);
        worker.terminate();
        opened = await api.openExecutionWorker(bundle);
        if (!opened.ok) throw new Error(JSON.stringify(opened.error));
        worker = opened.value;
        began = await worker.request({
          kind: "begin",
          bundle,
          cells: [input.cell],
          identity: {
            runId: saved.document.state.identity.runId,
            executionId: `browser-${name}-${cycle}-${phase}`,
            hostSession: `browser-${name}-${cycle}-${phase}`,
            parent: {
              snapshot: saved.document.snapshot,
              execution: saved.document.state.identity.executionId,
            },
          },
          origin: {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
        });
        if (began.kind !== "began") throw new Error(JSON.stringify(began));
      }
    }
    const histories = [];
    const worlds = [];
    for (const state of [expected, run]) {
      const history = [];
      for (const { sequence, execution, ...event } of state.events)
        if (event.kind !== "command-admitted") history.push(event);
      histories.push(canonicalJson(history));
      const { identity, events, commands, position, ...world } = state;
      worlds.push(canonicalJson({ ...world, time: position.time }));
    }
    if (histories[0] !== histories[1] || worlds[0] !== worlds[1])
      throw new Error(`Browser ${name} recovery differs from headless`);
    worker.terminate();
    results.push({
      name,
      bundle: bundle.id,
      saves,
      run,
      sameHistoryAndWorld: true,
    });
  }
  return { result: "passed", restores: 8, results };
}
