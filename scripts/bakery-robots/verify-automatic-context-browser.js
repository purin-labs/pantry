async function verifyAutomaticContext(page) {
  const base = globalThis.bakeryBase ?? "http://127.0.0.1:3103";
  await page.goto(`${base}/@vite/client`);
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.evaluate(mountAutomaticContext);
  await page
    .getByLabel("Departing page draft")
    .fill("Unsaved purchasing decision");
  await page.getByLabel("Chat draft").fill("Continue comparing this batch");
  const initial = await page.evaluate(readAutomaticContext);
  if (initial.mounted || initial.label !== "Workspace")
    throw new Error("Chat startup loaded Kitchen");
  await page.evaluate(openDepartureDialog);
  await page.evaluate(enqueueAutomaticPreparation);
  await page.waitForFunction(blockedPreparationSettled);
  if ((await page.evaluate(readAutomaticContext)).mounted)
    throw new Error("Automatic reveal hid an open departing-page dialog");
  await page.evaluate(closeDepartureDialog);
  await page.evaluate(enqueueAutomaticPreparation);
  await page.waitForFunction(automaticPreparationSettled);
  const revealed = await page.evaluate(readAutomaticContext);
  if (revealed.returnPosition !== "absolute")
    throw new Error(`Missing return layout: ${JSON.stringify(revealed)}`);
  if (
    revealed.departingDraft !== "Unsaved purchasing decision" ||
    revealed.chatDraft !== "Continue comparing this batch" ||
    revealed.label !== "Kitchen" ||
    revealed.prepared !== 1
  )
    throw new Error(
      `Reveal lost work or readiness: ${JSON.stringify(revealed)}`,
    );
  await page.getByRole("button", { name: "Return to current page" }).click();
  await page.getByLabel("Departing page draft").waitFor({ state: "visible" });
  if (
    (await page.getByLabel("Departing page draft").inputValue()) !==
    "Unsaved purchasing decision"
  )
    throw new Error("Return lost the departing draft");
  const retainedView = await page.evaluate(readRetainedBakeryView);
  await page.locator("body").press("h");
  if ((await page.evaluate(readRetainedBakeryView)) !== retainedView)
    throw new Error("Hidden Kitchen handled the current page's shortcut");
  await page.evaluate(enqueueAutomaticPreparation);
  await page.waitForFunction(twoPreparationsSettled);
  await page.evaluate(enqueueAutomaticInspection);
  await page.waitForFunction(automaticInspectionSettled);
  await page.evaluate(redeliverAutomaticInspection);
  await page.waitForFunction(duplicateInspectionSettled);
  const delivered = await page.evaluate(readAutomaticContext);
  if (delivered.executions !== 1)
    throw new Error("Duplicate delivery executed a command twice");
  await page.evaluate(deliverConcurrentInspection);
  await page.waitForFunction(concurrentInspectionSettled);
  if ((await page.evaluate(readAutomaticContext)).executions !== 2)
    throw new Error("Concurrent duplicate delivery executed a command twice");
  const other = await page.context().newPage();
  await other.goto(`${base}/workflow-preview.html`);
  const otherIdentity = await other.evaluate(
    duplicateBrowserIdentity,
    delivered.browserInstanceId,
  );
  await other.close();
  if (otherIdentity === delivered.browserInstanceId)
    throw new Error("A second tab acquired the initiating browser identity");
  await page.evaluate(enqueueUncertainInspection);
  await page.waitForFunction(uncertainInspectionSettled);
  await openComparison(page);
  await page.getByRole("button", { name: "Compare oven outage" }).click();
  await page.waitForFunction(staleContextShown);
  await page.evaluate(enqueueAutomaticPreparation);
  await page.waitForFunction(threePreparationsSettled);
  const final = await page.evaluate(readAutomaticContext);
  if (final.executions !== 2 || !final.indeterminate)
    throw new Error("Refresh ledger replayed uncertain work");
  await page.screenshot({
    path: "output/playwright/plan42g-automatic-context.png",
    fullPage: true,
  });
  return {
    result: "passed",
    startupMounts: 0,
    preservedDepartingDraft: final.departingDraft,
    preservedChatDraft: final.chatDraft,
    confirmedPreparations: final.prepared,
    executions: final.executions,
    duplicateDelivery: "reconciled",
    concurrentDelivery: "reconciled",
    modalPreservation: "fenced",
    hiddenShortcuts: "ignored",
    changedEpoch: "stale then recaptured",
    duplicateTab: "fenced",
    uncertainRefresh: "fenced",
    receipts: final.receipts,
  };
}

async function mountAutomaticContext() {
  const { sourceUrl } = await import("/source-url.js");
  history.replaceState(
    null,
    "",
    "/workflow-preview.html?conversation=chat_automatic_browser",
  );
  // The preview fixture imports react-dom/client; the demo that it mounts
  // imports react and react-router.
  const source = (
    await Promise.all(
      [
        "/src/dev/workflow-preview.tsx",
        sourceUrl("surfaces/portal/ui/workflow-demo.tsx"),
      ].map(async (path) => (await fetch(path)).text()),
    )
  ).join("\n");
  const reactUrl = source.match(/from "([^"\n]*\/react\.js[^"\n]*)"/u)?.[1];
  const domUrl = source.match(
    /from "([^"\n]*\/react-dom_client\.js[^"\n]*)"/u,
  )?.[1];
  const routerUrl = source.match(
    /from "([^"\n]*\/react-router\.js[^"\n]*)"/u,
  )?.[1];
  if (!reactUrl || !domUrl || !routerUrl)
    throw new Error("Missing Vite runtime imports");
  const { default: React } = await import(reactUrl);
  const { default: ReactDOM } = await import(domUrl);
  const { MemoryRouter } = await import(routerUrl);
  await import(sourceUrl("surfaces/portal/ui/styles.css"));
  const { default: Bakery } = await import(
    sourceUrl("areas/kitchen/ui/features/workflow-simulator/route.tsx")
  );
  const { BakeryWorkspaceReveal } = await import(
    sourceUrl("areas/kitchen/ui/features/bakery-workspace-reveal.tsx")
  );
  const { BakerySurfaceEffectBridge } = await import(
    sourceUrl("areas/kitchen/ui/features/bakery-surface-effect-bridge.tsx")
  );
  const bridgeSource = await (
    await fetch(
      sourceUrl("areas/kitchen/ui/features/bakery-surface-effect-bridge.tsx"),
    )
  ).text();
  const registryUrl = bridgeSource.match(
    /from "([^"\n]*bakery-surface-registry\.ts[^"\n]*)"/u,
  )?.[1];
  const browserUrl = bridgeSource.match(
    /from "([^"\n]*bakery-browser-context\.ts[^"\n]*)"/u,
  )?.[1];
  if (!registryUrl || !browserUrl)
    throw new Error("Missing shared browser imports");
  const registry = await import(registryUrl);
  const browser = await import(browserUrl);
  const registrySource = await (await fetch(registryUrl)).text();
  const protocolUrl = registrySource.match(
    /from "([^"\n]*bakery-surface\.ts[^"\n]*)"/u,
  )?.[1];
  if (!protocolUrl) throw new Error("Missing protocol import");
  const protocol = await import(protocolUrl);
  const { ChatContextChip } = await import(
    sourceUrl("surfaces/portal/ui/features/chat/context.tsx")
  );
  const organisationId = "automatic-browser";
  const fixture = {
    organisationId,
    registry,
    protocol,
    browser,
    effects: [],
    receipts: [],
    executions: 0,
    inspected: null,
    browserInstanceId: await browser.bakeryBrowserInstanceId(),
    contexts: [],
    render: null,
    async enqueuePreparation() {
      const effect = await this.protocol.createBakerySurfaceEffect({
        effectId: `prepare_${crypto.randomUUID()}`,
        dispatchId: crypto.randomUUID(),
        deadlineAt: Date.now() + 20000,
        command: {
          schemaVersion: 1,
          kind: "prepare_context",
          binding: {
            browserInstanceId: this.browserInstanceId,
            conversationId: "chat_automatic_browser",
          },
          requiredCommand: "inspect_surface",
        },
      });
      this.effects.push({ effect });
      this.contexts.push({
        kind: "preparing",
        area: "kitchen",
        effectId: effect.effectId,
      });
      this.render();
    },
    async enqueueInspection(uncertain) {
      const surface = this.registry.bakerySurfaceForOrganisation(
        this.organisationId,
      );
      const captured = await surface.capture();
      const effect = await this.protocol.createBakerySurfaceEffect({
        effectId: `inspect_${crypto.randomUUID()}`,
        dispatchId: crypto.randomUUID(),
        deadlineAt: Date.now() + 20000,
        command: {
          schemaVersion: 1,
          kind: "inspect_surface",
          target: {
            surfaceSessionId: captured.context.surfaceSessionId,
            surfaceEpoch: captured.context.surfaceEpoch,
          },
        },
      });
      if (this.inspected === null) {
        const execute = surface.execute.bind(surface);
        surface.execute = this.countExecution.bind(this, execute);
      }
      if (uncertain)
        sessionStorage.setItem(
          `pantry:bakery-effect:${effect.effectId}`,
          JSON.stringify({
            kind: "executing",
            commandDigest: effect.commandDigest,
            deadlineAt: effect.deadlineAt,
          }),
        );
      this.inspected = effect;
      this.effects.push({ effect });
      return effect;
    },
    async countExecution(execute, effect) {
      this.executions += 1;
      return execute(effect);
    },
    async transport(original, input, init) {
      const url = new URL(
        typeof input === "string" ? input : input.url,
        location.origin,
      );
      if (url.pathname.endsWith("/chat/surface-effects"))
        return Response.json({
          ok: true,
          effects: this.effects.filter(this.matchesDelivery.bind(this, url)),
        });
      if (url.pathname.endsWith("/receipt")) {
        const receipt = JSON.parse(init.body).receipt;
        let preparation = false;
        for (const pending of this.effects)
          if (
            pending.effect.effectId === receipt.effectId &&
            pending.effect.command.kind === "prepare_context"
          )
            preparation = true;
        this.receipts.push(receipt);
        this.effects = this.effects.filter(
          this.keepPending.bind(this, receipt.effectId),
        );
        if (receipt.outcome.kind === "prepared")
          this.contexts.push({
            kind: "ready",
            area: "kitchen",
            effectId: receipt.effectId,
            browserInstanceId: receipt.outcome.binding.browserInstanceId,
            surfaceSessionId: receipt.outcome.surface.context.surfaceSessionId,
            surfaceEpoch: receipt.outcome.surface.context.surfaceEpoch,
            digest: receipt.outcome.surface.digest,
            observedAt: receipt.outcome.surface.context.capturedAt,
          });
        if (preparation && receipt.outcome.kind === "delivery_failed")
          this.contexts.push({
            kind: "failed",
            area: "kitchen",
            effectId: receipt.effectId,
            message: receipt.outcome.message,
          });
        this.render();
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/bakery/runs"))
        return Response.json({ ok: true, snapshots: [], nextCursor: null });
      return original(input, init);
    },
    // As listPendingBakerySurfaceEffects does: a preparation goes to the
    // browser and conversation it names, and the later effects of the request
    // go to the browser that prepared Kitchen for that conversation.
    matchesDelivery(url, pending) {
      const command = pending.effect.command;
      const binding =
        command.kind === "prepare_context"
          ? command.binding
          : {
              browserInstanceId: this.browserInstanceId,
              conversationId: "chat_automatic_browser",
            };
      return (
        binding.browserInstanceId ===
          url.searchParams.get("browserInstanceId") &&
        binding.conversationId === url.searchParams.get("conversationId")
      );
    },
    keepPending(effectId, pending) {
      return pending.effect.effectId !== effectId;
    },
  };
  window.automaticContextAcceptance = fixture;
  // Chrome does not show a cookie with Path=/workflow-preview.html to this
  // page, whose document began at /@vite/client; the dev origin is a test one.
  document.cookie = "pantry_csrf=automatic-fixture; Path=/; SameSite=Strict";
  window.fetch = fixture.transport.bind(fixture, window.fetch.bind(window));
  document.getElementById("root").remove();
  const host = document.createElement("div");
  document.body.append(host);
  class Journey extends React.Component {
    componentDidMount() {
      fixture.render = this.forceUpdate.bind(this);
      this.unsubscribe = registry.subscribeBakerySurface(fixture.render);
    }
    componentWillUnmount() {
      this.unsubscribe();
    }
    render() {
      const timeline = fixture.contexts.map(this.contextEvent);
      // The fields that ChatContextChip reads; the chat parser gives an
      // unplaced chat placement null.
      const chat = {
        conversationId: "chat_automatic_browser",
        work: { kind: "running", requestId: "automatic_request" },
        timeline,
        placement: null,
        projectContext: null,
      };
      return React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 320px",
              height: "100vh",
            },
          },
          React.createElement(
            "main",
            { className: "portal-main", style: { minWidth: 0 } },
            React.createElement(
              "div",
              { className: "portal-main-inner" },
              React.createElement(
                BakeryWorkspaceReveal,
                {
                  organisationId,
                  chatOpen: true,
                  currentPageIsBakery: false,
                  bakery: React.createElement(Bakery, {
                    connection: {
                      kind: "workspace",
                      organisationId,
                      canManage: true,
                      mutate: this.forbidMutation,
                    },
                  }),
                },
                React.createElement(
                  "label",
                  null,
                  "Departing page draft",
                  React.createElement("input", {
                    "aria-label": "Departing page draft",
                  }),
                ),
                React.createElement(
                  "dialog",
                  { id: "departing-review" },
                  "Unsaved purchasing review",
                ),
              ),
            ),
          ),
          React.createElement(
            "aside",
            { style: { padding: 16 } },
            React.createElement(ChatContextChip, {
              organisationId,
              context: {
                organisation: "Test café",
                workspace: "Operations",
                area: "cafe",
                view: "Purchasing",
              },
              conversation: chat,
              projects: null,
            }),
            React.createElement(
              "label",
              null,
              "Chat draft",
              React.createElement("textarea", { "aria-label": "Chat draft" }),
            ),
          ),
        ),
        React.createElement(BakerySurfaceEffectBridge, {
          organisationId,
          active: true,
          reveal: registry.revealBakeryWorkspace.bind(null, organisationId),
        }),
      );
    }
    contextEvent(contextDetails, index) {
      return {
        kind: "context",
        requestId: "automatic_request",
        eventId: `context_${index}`,
        createdAt: index,
        contextDetails,
      };
    }
    async forbidMutation() {
      throw new Error("Revealing context must not save");
    }
  }
  ReactDOM.createRoot(host).render(React.createElement(Journey));
  const stylesheet = document.createElement("style");
  stylesheet.textContent = await (
    await fetch(
      `${sourceUrl("surfaces/portal/ui/styles.css")}?direct&t=${Date.now()}`,
    )
  ).text();
  document.head.append(stylesheet);
}

function readAutomaticContext() {
  const fixture = window.automaticContextAcceptance;
  const back = document.querySelector(".bakery-workspace-return");
  let prepared = 0;
  let indeterminate = false;
  for (const receipt of fixture.receipts) {
    if (receipt.outcome.kind === "prepared") prepared += 1;
    if (
      receipt.outcome.kind === "delivery_failed" &&
      receipt.outcome.code === "effect_indeterminate"
    )
      indeterminate = true;
  }
  return {
    mounted:
      fixture.registry.bakerySurfaceForOrganisation(fixture.organisationId) !==
      null,
    label: document.querySelector(".chat-context-chip span")?.textContent,
    departingDraft: document.querySelector(
      '[aria-label="Departing page draft"]',
    ).value,
    chatDraft: document.querySelector('[aria-label="Chat draft"]').value,
    executions: fixture.executions,
    browserInstanceId: fixture.browserInstanceId,
    returnPosition: back === null ? null : getComputedStyle(back).position,
    prepared,
    indeterminate,
    receipts: fixture.receipts,
  };
}
function enqueueAutomaticPreparation() {
  return window.automaticContextAcceptance.enqueuePreparation();
}
function openDepartureDialog() {
  document.getElementById("departing-review").showModal();
}
function closeDepartureDialog() {
  document.getElementById("departing-review").close();
}
function blockedPreparationSettled() {
  const fixture = window.automaticContextAcceptance;
  for (const receipt of fixture.receipts)
    if (
      receipt.outcome.kind === "delivery_failed" &&
      receipt.outcome.message.includes("dialog")
    )
      return true;
  return false;
}
async function readRetainedBakeryView() {
  const fixture = window.automaticContextAcceptance;
  const surface = fixture.registry.bakerySurfaceForOrganisation(
    fixture.organisationId,
  );
  const captured = await surface.capture();
  return captured.context.active.view.chrome;
}
async function deliverConcurrentInspection() {
  const fixture = window.automaticContextAcceptance;
  const effect = await fixture.enqueueInspection(false);
  const receipts = await Promise.all([
    fixture.registry.deliverBakerySurfaceEffect(fixture.organisationId, effect),
    fixture.registry.deliverBakerySurfaceEffect(fixture.organisationId, effect),
  ]);
  if (JSON.stringify(receipts[0]) !== JSON.stringify(receipts[1]))
    throw new Error("Concurrent deliveries received different outcomes");
}
function concurrentInspectionSettled() {
  const fixture = window.automaticContextAcceptance;
  for (const receipt of fixture.receipts)
    if (
      receipt.effectId === fixture.inspected.effectId &&
      receipt.outcome.kind === "completed"
    )
      return true;
  return false;
}
function enqueueAutomaticInspection() {
  return window.automaticContextAcceptance.enqueueInspection(false);
}
function enqueueUncertainInspection() {
  return window.automaticContextAcceptance.enqueueInspection(true);
}
function redeliverAutomaticInspection() {
  const fixture = window.automaticContextAcceptance;
  fixture.effects.push({ effect: fixture.inspected });
}
function automaticPreparationSettled() {
  let count = 0;
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (receipt.outcome.kind === "prepared") count += 1;
  return count === 1;
}
function twoPreparationsSettled() {
  let count = 0;
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (receipt.outcome.kind === "prepared") count += 1;
  return count === 2;
}
function threePreparationsSettled() {
  let count = 0;
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (receipt.outcome.kind === "prepared") count += 1;
  return count === 3;
}
function staleContextShown() {
  return (
    document.querySelector(".chat-context-chip span")?.textContent ===
    "Kitchen stale"
  );
}
function automaticInspectionSettled() {
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (receipt.outcome.kind === "completed") return true;
  return false;
}
function duplicateInspectionSettled() {
  let count = 0;
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (receipt.outcome.kind === "completed") count += 1;
  return count === 2;
}
function uncertainInspectionSettled() {
  for (const receipt of window.automaticContextAcceptance.receipts)
    if (
      receipt.outcome.kind === "delivery_failed" &&
      receipt.outcome.code === "effect_indeterminate"
    )
      return true;
  return false;
}
async function duplicateBrowserIdentity(id) {
  const { sourceUrl } = await import("/source-url.js");
  sessionStorage.setItem("pantry:bakery-browser-instance", id);
  const browser = await import(
    sourceUrl("areas/kitchen/ui/features/bakery-browser-context.ts")
  );
  return browser.bakeryBrowserInstanceId();
}
