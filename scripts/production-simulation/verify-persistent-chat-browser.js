async function verifyPersistentChatBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", persistentChatStyles);
  await page.goto(
    `${new URL(page.url()).origin}/workflow-preview.html?conversation=plan70-chat`,
  );
  await installPersistentChat(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openRecipeAuthors(page);
  await chooseOption(page, page.getByLabel("Logistics comparison"), {
    value: "stress-one-slot",
  });
  await page
    .getByRole("button", { name: "Prepare two-cell route", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await waitPersistentState(page, { status: "running", minimumTime: 150e6 });
  const pausedProposal = await sendPersistentControl(page, { kind: "pause" });
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await waitPersistentState(page, { status: "paused" });
  const paused = await page.evaluate(persistentChatCapture);
  const start = Math.ceil(paused.active.time / 1e6) + 30;
  const control = {
    kind: "withhold-resource",
    resource: "baker",
    interval: { start: start * 1e6, end: (start + 50) * 1e6 },
  };
  const proposed = await sendPersistentControl(page, control);
  const before = await page.evaluate(persistentChatCapture);
  if (
    before.active.target.controlRevision !==
    paused.active.target.controlRevision
  )
    throw new Error("Preparing a proposal changed the run.");
  await page.evaluate(persistentChatDeny, true);
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "authority could not be verified" })
    .waitFor();
  await page.evaluate(persistentChatDeny, false);
  await page.evaluate(persistentChatSwitch, "plan70-fork");
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  if (
    (await page.evaluate(persistentChatCapture)).active.target
      .controlRevision !== before.active.target.controlRevision
  )
    throw new Error("A fork reused another chat's review.");
  await page.evaluate(persistentChatSwitch, "plan70-chat");
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await waitPersistentState(page, {
    revision: before.active.target.controlRevision + 1,
  });
  const applied = await page.evaluate(persistentChatCapture);
  const duplicate = await page.evaluate(
    persistentChatRedeliver,
    proposed.effect,
  );
  if (duplicate.resultDigest !== proposed.receipt.resultDigest)
    throw new Error("Duplicate delivery changed the proposal receipt.");
  if (
    (await page.evaluate(persistentChatCapture)).active.target
      .controlRevision !== applied.active.target.controlRevision
  )
    throw new Error("Duplicate delivery applied a second control.");
  await page.screenshot({ path: "reviewed-availability.png", fullPage: true });
  const stale = await page.evaluate(persistentChatEnqueue, {
    control: { kind: "extend-horizon", horizon: 18000e6 },
    production: paused.active.target,
  });
  const refused = await waitPersistentReceipt(page, stale.effectId);
  if (refused.outcome.result.kind !== "rejected")
    throw new Error("A stale control revision was accepted.");
  await sendPersistentControl(page, {
    kind: "close-arrivals",
    source: applied.active.arrivals[0],
  });
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await waitPersistentState(page, {
    revision: applied.active.target.controlRevision + 1,
  });
  const save = downloadFactorySave(page);
  const path = `${globalThis.bakeryEvidence}/reviewed-run.json`;
  await (await save).saveAs(path);
  const original = await page.evaluate(persistentChatCapture);
  await page.reload();
  await installPersistentChat(page);
  await openRecipeAuthors(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles(path);
  const snapshot = await waitPersistentState(page, { snapshot: true });
  if (
    snapshot.supportedCommands.length !== 1 ||
    snapshot.supportedCommands[0] !== "inspect_surface" ||
    "target" in snapshot.active
  )
    throw new Error("Snapshot inspection exposed execution authority.");
  const inspectEffect = await page.evaluate(persistentChatEnqueue, {
    kind: "inspect_surface",
  });
  const inspectionReceipt = await waitPersistentReceipt(
    page,
    inspectEffect.effectId,
  );
  if (
    inspectionReceipt.outcome.result.kind !== "succeeded" ||
    inspectionReceipt.outcome.result.surface.context.active.kind !==
      "persistent-snapshot"
  )
    throw new Error("The saved snapshot could not be inspected through chat.");
  const snapshotControl = await page.evaluate(persistentChatEnqueue, {
    control: { kind: "resume" },
    production: original.active.target,
  });
  const snapshotRefusal = await waitPersistentReceipt(
    page,
    snapshotControl.effectId,
  );
  if (snapshotRefusal.outcome.result.kind !== "rejected")
    throw new Error("A saved snapshot accepted execution control.");
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await waitPersistentState(page, { status: "running" });
  await sendPersistentControl(page, { kind: "pause" });
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await waitPersistentState(page, { status: "paused" });
  const restored = await page.evaluate(persistentChatCapture);
  if (
    restored.active.target.runId !== original.active.target.runId ||
    restored.active.target.executionId === original.active.target.executionId ||
    restored.active.target.hostSession === original.active.target.hostSession
  )
    throw new Error("Fresh continuation did not isolate execution authority.");
  const oldExecution = await page.evaluate(persistentChatEnqueue, {
    control: { kind: "resume" },
    production: original.active.target,
  });
  const oldRefusal = await waitPersistentReceipt(page, oldExecution.effectId);
  if (oldRefusal.outcome.result.kind !== "rejected")
    throw new Error("A prior execution controlled the new host.");
  await sendPersistentControl(page, { kind: "resume" });
  await page
    .getByRole("button", {
      name: "Confirm chat production control",
      exact: true,
    })
    .click();
  await waitPersistentState(page, { status: "completed" });
  const final = await page.evaluate(persistentChatCapture);
  await page.screenshot({
    path: "chat-controlled-factory-complete.png",
    fullPage: true,
  });
  return {
    result: "passed",
    transport:
      "controlled HTTP over the production effect bridge and real retained MuJoCo worker",
    paused,
    applied,
    original,
    restored,
    final,
    availability: control,
    pauseReceipt: pausedProposal.receipt,
    availabilityReceipt: proposed.receipt,
    staleRevisionReceipt: refused,
    priorExecutionReceipt: oldRefusal,
    snapshotInspection: inspectionReceipt,
    snapshotControlRefusal: snapshotRefusal,
    currentAccessRechecked: true,
    forkReviewRejected: true,
    duplicateReceiptPreserved: true,
  };
}
async function persistentChatStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}

async function installPersistentChat(page) {
  for (const helper of [
    persistentChatFetch,
    persistentChatCapture,
    persistentChatEnqueue,
    persistentChatReceipt,
    persistentChatDeny,
    persistentChatSwitch,
    persistentChatRedeliver,
    persistentChatMutation,
    persistentChatReveal,
    persistentEffectUnsettled,
  ])
    await page.addScriptTag({ content: helper.toString() });
  await page.evaluate(mountPersistentChat);
}
async function mountPersistentChat() {
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: Route } =
    await import("/src/features/workflow-simulator/route.tsx");
  const { BakerySurfaceEffectBridge } =
    await import("/src/features/bakery-surface-effect-bridge.tsx");
  window.persistentChat = {
    effects: [],
    receipts: [],
    denied: false,
    originalFetch: window.fetch.bind(window),
  };
  window.fetch = persistentChatFetch;
  document.cookie = "satyr_control_csrf=plan70-chat; path=/";
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Route, {
          connection: {
            kind: "workspace",
            organisationId: "plan70-chat",
            canManage: true,
            mutate: persistentChatMutation,
          },
        }),
        React.createElement(BakerySurfaceEffectBridge, {
          organisationId: "plan70-chat",
          active: true,
          reveal: persistentChatReveal,
        }),
      ),
    ),
  );
}
async function persistentChatFetch(input, init) {
  const fixture = window.persistentChat;
  const url = new URL(
    typeof input === "string" ? input : input.url,
    location.origin,
  );
  if (url.pathname.endsWith("/chat/surface-effects"))
    return fixture.denied
      ? Response.json({ error: "denied" }, { status: 403 })
      : Response.json({ ok: true, effects: fixture.effects });
  if (url.pathname.endsWith("/receipt")) {
    const receipt = JSON.parse(init.body).receipt;
    fixture.receipts.push(receipt);
    fixture.effects = fixture.effects.filter(
      persistentEffectUnsettled.bind(null, receipt.effectId),
    );
    return Response.json({ ok: true });
  }
  return fixture.originalFetch(input, init);
}
async function persistentChatCapture() {
  const { bakerySurfaceForOrganisation } =
    await import("/src/features/bakery-surface-registry.ts");
  const surface = bakerySurfaceForOrganisation("plan70-chat");
  return surface === null ? null : (await surface.capture()).context;
}
async function persistentChatEnqueue(input) {
  const context = await persistentChatCapture();
  const { createBakerySurfaceEffect } =
    await import("/@id/@purin-labs/bakery-model/bakery-surface");
  const effect = await createBakerySurfaceEffect({
    effectId: `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`,
    dispatchId: crypto.randomUUID(),
    deadlineAt: Date.now() + 60000,
    command:
      input.kind === "inspect_surface"
        ? {
            schemaVersion: 1,
            kind: "inspect_surface",
            target: {
              surfaceSessionId: context.surfaceSessionId,
              surfaceEpoch: context.surfaceEpoch,
            },
          }
        : {
            schemaVersion: 1,
            kind: "prepare_production_control",
            target: {
              surfaceSessionId: context.surfaceSessionId,
              surfaceEpoch: context.surfaceEpoch,
            },
            production: input.production ?? context.active.target,
            control: input.control,
          },
  });
  window.persistentChat.effects.push({ effect });
  return effect;
}
function persistentChatReceipt(effectId) {
  for (const receipt of window.persistentChat.receipts)
    if (receipt.effectId === effectId) return receipt;
  return null;
}
async function sendPersistentControl(page, control) {
  const effect = await page.evaluate(persistentChatEnqueue, { control });
  const receipt = await waitPersistentReceipt(page, effect.effectId);
  if (
    receipt.outcome.kind !== "completed" ||
    receipt.outcome.result.kind !== "succeeded"
  )
    throw new Error(`Control proposal refused: ${JSON.stringify(receipt)}`);
  await page
    .getByRole("region", {
      name: "Reviewed chat production control",
      exact: true,
    })
    .waitFor();
  return { effect, receipt };
}
async function waitPersistentReceipt(page, id) {
  await page.waitForFunction(persistentChatReceipt, id);
  return page.evaluate(persistentChatReceipt, id);
}
async function waitPersistentState(page, expected) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const context = await page.evaluate(persistentChatCapture);
    if (expected.snapshot && context?.active.kind === "persistent-snapshot")
      return context;
    if (
      context?.active.kind === "persistent" &&
      (expected.status === undefined ||
        context.active.status === expected.status) &&
      (expected.minimumTime === undefined ||
        context.active.time >= expected.minimumTime) &&
      (expected.revision === undefined ||
        context.active.target.controlRevision === expected.revision)
    )
      return context;
    await page.waitForTimeout(100);
  }
  throw new Error(`Persistent state did not reach ${JSON.stringify(expected)}`);
}
function persistentChatDeny(denied) {
  window.persistentChat.denied = denied;
}
function persistentChatSwitch(conversation) {
  const url = new URL(location.href);
  url.searchParams.set("conversation", conversation);
  history.replaceState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
async function persistentChatRedeliver(effect) {
  const { deliverBakerySurfaceEffect } =
    await import("/src/features/bakery-surface-registry.ts");
  return deliverBakerySurfaceEffect("plan70-chat", effect);
}

async function persistentChatMutation() {
  throw new Error("Unexpected shared mutation.");
}
async function persistentChatReveal() {}
function persistentEffectUnsettled(id, pending) {
  return pending.effect.effectId !== id;
}
