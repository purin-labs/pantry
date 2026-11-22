async (page) => {
  // Permission prompts minimize into toasts (the Portal's Sonner stack).
  //
  // The owner asks a private Portal chat to add a section to the shared menu.
  // Menu editing is off for the workspace, so the run pauses on a capability
  // permission request and the chat opens its prompt. The owner minimizes it
  // into a toast, the page stays usable, and the toast grows back into the
  // modal. Allow then shrinks the modal into the toast by itself: the toast
  // shows the loading state, then the success. The run continues, and the
  // IFC exit check holds the edit, because the chat is private: the held
  // step opens its own prompt (Plan 27C), which takes the same path. After
  // the owner allows it and asks again, the menu has the new section.
  //
  // A second part on the component preview proves that two prompts stack as
  // two toasts, and that reduced motion fades without a morph.
  //
  // Setup: POST /test/setup-menu. The model provider is simulated: it answers
  // with the next tool call of a fixed script. Pantry and the Portal produce
  // every outcome that this journey asserts.
  const WORKER = "http://127.0.0.1:8881";
  const PORTAL = "http://127.0.0.1:3181";
  const MENU = "Turn on menu editing, then add a Coffee section.";
  const AGAIN = "Please add the Coffee section again.";
  const ANSWER = "I added a Coffee section to the menu.";
  const fixtures = JOURNEY_FIXTURES;
  const artifacts = JOURNEY_ARTIFACTS;
  const checks = [];
  const captures = [];
  const started = Date.now();
  function check(name, passed, detail) {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  }
  async function capture(name) {
    await page.screenshot({ path: `${artifacts}/${name}.png` });
    captures.push(`${name}.png`);
  }
  async function ask(text) {
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor({ timeout: 60_000 });
    const composer = page.getByPlaceholder(/^Ask anything/u);
    await composer.fill(text);
    await composer.press("Enter");
  }
  // What Pantry answered to each tool call of the simulated model.
  async function toolResults(turn) {
    const model = await (await page.request.get(`${WORKER}/test/model`)).json();
    return model.modelRequests
      .filter((entry) => entry.turn === turn && entry.results !== undefined)
      .flatMap((entry) => entry.results);
  }
  const openDialog = () =>
    page.locator("dialog.permission-request-dialog[open]");
  // The toasts in Sonner's stack; a morph's copy is not one.
  const toasts = () => page.locator("[data-sonner-toast] [data-prompt-toast]");

  // The page records what the person sees, frame by frame: each frame of a
  // morph surface, each change of a toast, and each open or close of a
  // prompt. The timeline is the repeatable artifact of the motion.
  async function installRecorder() {
    await page.evaluate(() => {
      if (window.__promptTimeline !== undefined) return;
      const timeline = [];
      window.__promptTimeline = timeline;
      const t0 = performance.now();
      const now = () => Math.round(performance.now() - t0);
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      const sample = (surface) => {
        if (!surface.isConnected) {
          timeline.push({ t: now(), kind: "morph-end" });
          return;
        }
        timeline.push({ t: now(), kind: "morph-frame", rect: box(surface) });
        requestAnimationFrame(() => sample(surface));
      };
      let toastState = "";
      let dialogState = "";
      const observe = () => {
        const surface = document.querySelector(".layout-morph-surface");
        if (surface !== null && surface.dataset.recorded === undefined) {
          surface.dataset.recorded = "";
          timeline.push({ t: now(), kind: "morph-start" });
          sample(surface);
        }
        const states = [
          ...document.querySelectorAll(
            "[data-sonner-toast] [data-prompt-toast]",
          ),
        ].map(
          (toast) =>
            `${toast.dataset.tone}|${toast.querySelector(".prompt-toast-title")?.textContent ?? ""}|${toast.dataset.hidden === undefined ? "shown" : "hidden"}`,
        );
        const toastNow = states.join(" ; ");
        if (toastNow !== toastState) {
          toastState = toastNow;
          timeline.push({ t: now(), kind: "toasts", toasts: states });
        }
        const dialogs = [
          ...document.querySelectorAll(
            "dialog.permission-request-dialog[open]",
          ),
        ].map(
          (dialog) =>
            dialog.querySelector(".permission-request-title")?.textContent ??
            "",
        );
        const dialogNow = dialogs.join(" ; ");
        if (dialogNow !== dialogState) {
          dialogState = dialogNow;
          timeline.push({ t: now(), kind: "dialogs", open: dialogs });
        }
      };
      new MutationObserver(observe).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeFilter: ["open", "data-tone", "data-hidden", "class"],
      });
      observe();
    });
  }
  const timelineMark = (label) =>
    page.evaluate((text) => {
      window.__promptTimeline.push({
        t: Math.round(performance.now()),
        kind: "step",
        label: text,
      });
    }, label);

  /** The morph frames between the last two marks of the timeline. */
  async function lastMorph() {
    return page.evaluate(() => {
      const timeline = window.__promptTimeline;
      let start = -1;
      for (let index = timeline.length - 1; index >= 0; index -= 1)
        if (timeline[index].kind === "morph-start") {
          start = index;
          break;
        }
      if (start < 0) return null;
      const frames = [];
      for (let index = start + 1; index < timeline.length; index += 1) {
        if (timeline[index].kind === "morph-end") break;
        if (timeline[index].kind === "morph-frame")
          frames.push(timeline[index]);
      }
      return frames;
    });
  }
  function near(a, b, tolerance = 4) {
    return (
      Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance
    );
  }
  async function rectOf(locator) {
    const r = await locator.boundingBox();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }
  async function waitMorphDone() {
    await page.waitForFunction(
      () => document.querySelector(".layout-morph") === null,
      null,
      { timeout: 5_000 },
    );
  }
  async function focusIn(selector) {
    return page.evaluate(
      (target) => document.activeElement?.closest(target) !== null,
      selector,
    );
  }

  /**
   * Minimize, the page stays usable, maximize: the same checks for every
   * prompt. Returns the toast's control.
   */
  async function minimizeAndMaximize(label, title) {
    const dialog = openDialog();
    const card = dialog.locator(".permission-request");
    const cardRect = await rectOf(card);
    await timelineMark(`${label}: minimize`);
    await dialog.getByRole("button", { name: "Minimize", exact: true }).click();
    await waitMorphDone();
    const toast = toasts().filter({ hasText: title });
    await toast.waitFor({ timeout: 5_000 });
    check(
      `${label}: the modal closed into the toast`,
      (await openDialog().count()) === 0,
    );
    check(
      `${label}: the toast waits for the decision`,
      (await toast.getAttribute("data-tone")) === "waiting",
      await toast.innerText(),
    );
    const toastRect = await rectOf(toast);
    const frames = await lastMorph();
    check(
      `${label}: one surface moved from the card to the toast`,
      frames !== null &&
        frames.length >= 8 &&
        near(frames[0].rect, cardRect, 6) &&
        near(frames[frames.length - 1].rect, toastRect, 6),
      {
        cardRect,
        toastRect,
        first: frames?.[0],
        last: frames?.at(-1),
        count: frames?.length,
      },
    );
    check(
      `${label}: the toast is at the bottom right`,
      toastRect.x + toastRect.width > 1440 - 40 &&
        toastRect.y + toastRect.height > 900 - 40,
      toastRect,
    );
    check(
      `${label}: focus moved to the toast`,
      await focusIn("[data-prompt-toast]"),
    );
    // The page is usable: no modal holds it, and the composer takes text.
    const composer = page.getByPlaceholder(/^Ask anything/u);
    await composer.fill("The page still works");
    check(
      `${label}: the page takes input while the prompt is a toast`,
      (await composer.inputValue()) === "The page still works",
    );
    await composer.fill("");
    await capture(`${label}-02-minimized`);
    await timelineMark(`${label}: maximize`);
    await toast.locator("button.prompt-toast-body").click();
    await waitMorphDone();
    await openDialog().waitFor({ timeout: 5_000 });
    const grown = await lastMorph();
    const reopened = await rectOf(openDialog().locator(".permission-request"));
    check(
      `${label}: the toast grew back into the modal`,
      grown !== null &&
        grown.length >= 8 &&
        near(grown[0].rect, toastRect, 6) &&
        near(grown[grown.length - 1].rect, reopened, 6),
      { toastRect, reopened, first: grown?.[0], last: grown?.at(-1) },
    );
    check(
      `${label}: the same prompt is back`,
      (await openDialog().locator(".permission-request-title").innerText()) ===
        title,
    );
    check(
      `${label}: no toast is left for the open prompt`,
      (await toast.count()) === 0,
    );
    check(`${label}: focus is in the modal`, await focusIn("dialog[open]"));
    await capture(`${label}-03-maximized`);
  }

  /**
   * Allow minimizes the modal by itself; the toast shows the loading state,
   * then `success`.
   */
  async function allowIntoToast(label, title, success, decisionUrl) {
    // The Worker answers in milliseconds; a held response keeps the loading
    // state long enough to see. The answer itself is the Worker's.
    let release = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(decisionUrl, async (route) => {
      await held;
      await route.continue();
    });
    await timelineMark(`${label}: allow`);
    await openDialog()
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    const toast = toasts().filter({ hasText: title });
    await toast
      .and(page.locator('[data-tone="loading"]'))
      .waitFor({ timeout: 5_000 });
    await waitMorphDone();
    check(
      `${label}: Allow minimized the modal`,
      (await openDialog().count()) === 0,
    );
    check(
      `${label}: the toast shows the loading state`,
      (await toast.innerText()).includes("Saving your decision"),
      await toast.innerText(),
    );
    check(
      `${label}: the toast is busy`,
      (await toast.getAttribute("aria-busy")) === "true",
    );
    await capture(`${label}-04-loading`);
    release();
    const done = toasts().filter({ hasText: success });
    await done.waitFor({ timeout: 30_000 });
    check(
      `${label}: the toast shows the success`,
      (await done.getAttribute("data-tone")) === "success",
      await done.innerText(),
    );
    check(
      `${label}: the toast sits in the polite live region`,
      await done.evaluate(
        (element) => element.closest('[aria-live="polite"]') !== null,
      ),
    );
    // The new tone's text fades in over the smooth spring (340 ms).
    await page.waitForTimeout(450);
    await capture(`${label}-05-success`);
    await page.unroute(decisionUrl);
  }

  async function run() {
    const session = await page.request.post(
      `${WORKER}/test/session?user=Owner`,
    );
    if (!session.ok()) throw new Error("Session failed for Owner");
    const owner = await session.json();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Menu editing stays off, so the agent's edit asks for it.
    await page.goto(
      `${PORTAL}/menu-chat-preview.html?organisation=${fixtures.organisationId}&preferenceUser=${owner.userId}&access=live`,
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor({ timeout: 60_000 });
    await installRecorder();

    // 1. The capability permission request of the paused run.
    await ask(MENU);
    await openDialog().waitFor({ timeout: 60_000 });
    const capabilityTitle = await openDialog()
      .locator(".permission-request-title")
      .innerText();
    check(
      "The chat opened the capability permission prompt",
      /^Sous Chef would like to /u.test(capabilityTitle),
      capabilityTitle,
    );
    await capture("capability-01-prompt");
    await minimizeAndMaximize("capability", capabilityTitle);
    await allowIntoToast(
      "capability",
      capabilityTitle,
      "Request allowed",
      /\/(?:conversations\/[^/]+\/permission|permission-requests\/[^/]+\/decision)$/u,
    );

    // 2. The run continues; the exit check holds the private chat's edit and
    //    opens the IFC prompt of the held step.
    const heldTitle = "Sous Chef wants to do one step";
    await page
      .locator("dialog.permission-request-dialog[open]")
      .filter({ hasText: heldTitle })
      .waitFor({ timeout: 60_000 });
    const held = await toolResults("menu-permission");
    check(
      "The exit check held the edit before the IFC decision",
      held.some((result) => result.includes("Purin Pantry stopped this step")),
      held,
    );
    await capture("ifc-01-prompt");
    await minimizeAndMaximize("ifc", heldTitle);
    await allowIntoToast(
      "ifc",
      heldTitle,
      "Request allowed",
      /\/held-outputs\/[^/]+\/decision$/u,
    );
    // A settled toast closes by itself, and its prompt closes with it.
    await toasts().first().waitFor({ state: "detached", timeout: 15_000 });
    check(
      "The settled toasts closed by themselves",
      (await toasts().count()) === 0,
    );
    check("No prompt reopened", (await openDialog().count()) === 0);

    // 3. The owner asks again; the allowed step runs once.
    await ask(AGAIN);
    await page.getByText(ANSWER, { exact: true }).waitFor({ timeout: 60_000 });
    const ran = await toolResults("menu-allowed");
    check(
      "The allowed edit ran, and Pantry did not hold it again",
      ran.length > 0 &&
        !ran.some((result) => result.includes("Purin Pantry stopped")),
      ran,
    );
    await capture("06-section-added");
    const timeline = await page.evaluate(() => window.__promptTimeline);

    // 4. Two prompts at once stack as two toasts; reduced motion fades.
    await page.goto(`${PORTAL}/permission-request-preview.html`);
    await installRecorder();
    for (const label of ["Open permission dialog", "Open compact dialog"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await openDialog().waitFor({ timeout: 5_000 });
      await openDialog()
        .getByRole("button", { name: "Minimize", exact: true })
        .click();
      await waitMorphDone();
      await page.waitForFunction(
        () => document.querySelector("dialog[open]") === null,
      );
    }
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-sonner-toast] [data-prompt-toast]")
          .length === 2,
    );
    check("Two prompts stack as two toasts", (await toasts().count()) === 2);
    await capture("stack-01-two-toasts");
    await page.emulateMedia({ reducedMotion: "reduce" });
    // In Sonner's folded stack the newest toast is in front.
    await page
      .locator(
        '[data-sonner-toast][data-front="true"] button.prompt-toast-body',
      )
      .click();
    await openDialog().waitFor({ timeout: 5_000 });
    await openDialog()
      .getByRole("button", { name: "Minimize", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("dialog[open]") === null &&
        document.querySelectorAll("[data-sonner-toast] [data-prompt-toast]")
          .length === 2,
    );
    const reduced = await page.evaluate(() => {
      const timeline = window.__promptTimeline;
      const mark = timeline.findLastIndex(
        (entry) => entry.kind === "dialogs" && entry.open.length === 1,
      );
      return timeline
        .slice(mark)
        .filter((entry) => entry.kind === "morph-start").length;
    });
    check("Reduced motion minimizes with no morph", reduced === 0, reduced);
    const previewTimeline = await page.evaluate(() => window.__promptTimeline);
    const model = await (await page.request.get(`${WORKER}/test/model`)).json();
    return {
      result: "passed",
      seconds: Math.round((Date.now() - started) / 1000),
      modelRequests: model.modelRequests.length,
      checks,
      captures,
      timeline: { chat: timeline, preview: previewTimeline },
    };
  }
  try {
    return await run();
  } catch (error) {
    await capture("failure").catch(() => undefined);
    const timeline = await page
      .evaluate(() => window.__promptTimeline ?? null)
      .catch(() => null);
    return {
      result: "failed",
      error: String(error),
      pageText: (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-3_000),
      checks,
      captures,
      timeline,
    };
  }
};
