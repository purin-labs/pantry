async function traceJourney(page) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/trace-preview.html`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1512, height: 1250 });
  await page
    .getByRole("heading", { name: "Trace", exact: true, level: 1 })
    .waitFor();
  const darkToggle = page.getByRole("button", { name: "Use light theme" });
  if (await darkToggle.count()) await darkToggle.click();
  await page.evaluate("document.fonts.ready");
  const chatActivity = page.locator("#chat-activity");
  await chatActivity
    .getByRole("button", {
      name: "Prepare the production sheet Working",
      exact: true,
    })
    .click();
  await chatActivity
    .getByText("Waiting for the export tool to return.", { exact: true })
    .waitFor();
  const activeTitles = chatActivity.locator(
    '[data-status="running"] > .pantry-trace-title',
  );
  if ((await activeTitles.count()) !== 2)
    throw new Error("The running summary and step are not both active.");
  await page.evaluate(
    'window.shimmerProbe = document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title").getAnimations()[0]',
  );
  await page.evaluate(
    "window.shimmerProbe.pause(); window.shimmerProbe.currentTime = 0",
  );
  const shimmerStart = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).backgroundPosition',
  );
  await page.evaluate("window.shimmerProbe.currentTime = 227.5");
  const shimmerMiddle = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).backgroundPosition',
  );
  if (shimmerStart === shimmerMiddle)
    throw new Error("The active title shimmer did not move.");
  await chatActivity.screenshot({
    path: "output/playwright/trace/merged-chat-activity.png",
    animations: "disabled",
  });
  await chooseOption(
    page,
    chatActivity.getByRole("combobox", { name: "Scenario", exact: true }),
    { value: "completed" },
  );
  await chatActivity
    .getByText("Export receipt received.", { exact: true })
    .waitFor();
  const completedAnimation = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity .pantry-trace-title")).animationName',
  );
  const completedBackground = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity .pantry-trace-title")).backgroundImage',
  );
  if (completedAnimation !== "none" || completedBackground !== "none")
    throw new Error("Completed activity retained the working shimmer.");
  await page.evaluate("delete window.shimmerProbe");
  await chooseOption(
    page,
    chatActivity.getByRole("combobox", { name: "Scenario", exact: true }),
    { value: "failed" },
  );
  await chatActivity
    .getByText("The export failed. The accepted order snapshot is preserved.", {
      exact: true,
    })
    .waitFor();
  if ((await activeTitles.count()) !== 0)
    throw new Error("Failed activity still appears active.");
  await chatActivity
    .getByRole("button", { name: "Reset activity", exact: true })
    .click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    'getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).animationName === "none" && getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).webkitTextFillColor !== "rgba(0, 0, 0, 0)"',
  );
  const reducedFill = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).webkitTextFillColor',
  );
  const reducedAnimation = await page.evaluate(
    'getComputedStyle(document.querySelector("#chat-activity [data-status=running] > .pantry-trace-title")).animationName',
  );
  if (reducedAnimation !== "none" || reducedFill === "rgba(0, 0, 0, 0)")
    throw new Error(
      "Reduced motion did not preserve a static, readable title.",
    );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({
    path: "output/playwright/trace/desktop.png",
    fullPage: true,
    animations: "disabled",
  });

  // Seek the reference presentation, pause output halfway through its reveal,
  // resize the paused scene, then resume into the final interactive grid.
  const referenceFrame = page.getByRole("slider", { name: "Reference frame" });
  await referenceFrame.fill("0");
  await page
    .locator(".trace-reference-stage")
    .screenshot({ path: "output/playwright/trace/reference-frame-000.png" });
  await referenceFrame.fill("275");
  const firstLine = await page.evaluate(
    'getComputedStyle(document.querySelector(".trace-preview-terminal-line")).opacity',
  );
  const lastLine = await page.evaluate(
    'getComputedStyle(document.querySelector(".trace-preview-terminal-line:last-child")).opacity',
  );
  if (Number(firstLine) < 0.9 || Number(lastLine) !== 0)
    throw new Error("Terminal output did not arrive progressively.");
  await page
    .locator(".trace-reference-stage")
    .screenshot({ path: "output/playwright/trace/reference-frame-275.png" });
  await referenceFrame.fill("289");
  await page
    .locator(".trace-reference-stage")
    .screenshot({ path: "output/playwright/trace/reference-frame-289.png" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  if ((await referenceFrame.inputValue()) !== "289")
    throw new Error("Resize reset the paused reference frame.");
  await referenceFrame.fill("390");
  await page
    .locator(".trace-reference-stage")
    .screenshot({ path: "output/playwright/trace/reference-frame-390.png" });
  await referenceFrame.fill("450");
  await page
    .locator(".trace-reference-stage")
    .screenshot({ path: "output/playwright/trace/reference-frame-450.png" });
  await page
    .getByRole("button", { name: "Replay reference", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pause reference", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Replay reference", exact: true })
    .waitFor({ timeout: 5000 });
  if (
    !(await page
      .getByRole("button", { name: "Show all examples" })
      .isDisabled())
  )
    throw new Error(
      "Reference replay did not release its interactive examples.",
    );
  await page.setViewportSize({ width: 1512, height: 1250 });

  // Reverse a collapse before it ends, then check both levels of retained state.
  const subagent = page.getByRole("region", { name: "Subagent", exact: true });
  const parent = subagent.getByRole("button", {
    name: "Ran the research agent",
    exact: true,
  });
  const child = subagent.getByRole("button", {
    name: "Ran grep -rn cacheKey scripts",
    exact: true,
  });
  await chooseOption(page, page.getByRole("combobox", { name: "Motion" }), {
    value: "slow",
  });
  await parent.click();
  await parent.click();
  await child.waitFor({ state: "visible" });
  if ((await child.getAttribute("aria-expanded")) !== "true")
    throw new Error("Parent toggle reset the nested step.");
  await child.focus();
  await page.keyboard.press("Space");
  if ((await child.getAttribute("aria-expanded")) !== "false")
    throw new Error("Space did not close the nested step.");
  await parent.click();
  await parent.click();
  await child.waitFor({ state: "visible" });
  if ((await child.getAttribute("aria-expanded")) !== "false")
    throw new Error("Parent toggle lost the reader's closed state.");
  await child.focus();
  await page.keyboard.press("Enter");
  if ((await child.getAttribute("aria-expanded")) !== "true")
    throw new Error("Enter did not open the nested step.");
  await chooseOption(page, page.getByRole("combobox", { name: "Motion" }), {
    value: "normal",
  });

  // The reader closes streamed reasoning. New text and completion must respect it.
  const live = page.getByRole("region", { name: "Live turn", exact: true });
  await live.getByRole("button", { name: "Thinking", exact: true }).click();
  const next = live.getByRole("button", { name: "Next event" });
  await next.click();
  await next.click();
  if (
    (await live
      .getByRole("button", { name: "Thinking", exact: true })
      .getAttribute("aria-expanded")) !== "false"
  )
    throw new Error(
      "Stream update reopened reasoning against the reader's choice.",
    );
  await chooseOption(page, page.getByRole("combobox", { name: "Motion" }), {
    value: "slow",
  });
  await next.click();
  // Inspect the new tool halfway through its entrance. The previous reasoning
  // row must remain fully visible while this row fades and moves into place.
  await page.evaluate(
    'window.traceEntranceAnimations = document.querySelector(".trace-preview-turn .pantry-trace-collapsible:nth-child(2) .pantry-trace-line").getAnimations()',
  );
  const entranceCount = await page.evaluate(
    "window.traceEntranceAnimations.length",
  );
  if (entranceCount !== 2)
    throw new Error("The incoming tool appeared without its short entrance.");
  await page.evaluate(
    "window.traceEntranceAnimations[0].pause(); window.traceEntranceAnimations[1].pause()",
  );
  await page.evaluate(
    'window.traceChevronEntrance = document.querySelector(".trace-preview-turn .pantry-trace-collapsible:nth-child(2) [data-trace-chevron]").getAnimations()[0]',
  );
  await page.evaluate(
    "window.traceChevronEntrance.pause(); window.traceChevronEntrance.currentTime = 120",
  );
  await page.evaluate(
    "window.traceEntranceAnimations[0].currentTime = 120; window.traceEntranceAnimations[1].currentTime = 120",
  );
  const incomingOpacity = await page.evaluate(
    'Number(getComputedStyle(document.querySelector(".trace-preview-turn .pantry-trace-collapsible:nth-child(2) .pantry-trace-line")).opacity)',
  );
  const previousOpacity = await page.evaluate(
    'Number(getComputedStyle(document.querySelector(".trace-preview-turn .pantry-trace-line")).opacity)',
  );
  if (!(incomingOpacity > 0 && incomingOpacity < 0.9) || previousOpacity !== 1)
    throw new Error(
      "Incoming activity did not fade independently of existing rows.",
    );
  await live.screenshot({ path: "output/playwright/trace/incoming-tool.png" });
  await page.evaluate(
    "window.traceEntranceAnimations[0].finish(); window.traceEntranceAnimations[1].finish(); window.traceChevronEntrance.finish(); delete window.traceEntranceAnimations; delete window.traceChevronEntrance",
  );
  await chooseOption(page, page.getByRole("combobox", { name: "Motion" }), {
    value: "normal",
  });
  const thought = live.getByRole("button", {
    name: "Thought for 5s",
    exact: true,
  });
  if ((await thought.getAttribute("aria-expanded")) !== "false")
    throw new Error("Completion reset the reader's choice.");
  await thought.click();
  await live.getByText(/I should check what the last commit changed/).waitFor();
  await next.click();
  await live
    .getByText("Running pnpm install --frozen-lockfile", { exact: true })
    .waitFor();
  await next.click();
  await live
    .getByRole("button", {
      name: "Failed to run pnpm install --frozen-lockfile",
      exact: true,
    })
    .waitFor();
  await live.getByText(/ERR_PNPM_OUTDATED_LOCKFILE/).waitFor();
  await next.click();
  await live.getByText("Replay complete", { exact: true }).waitFor();
  await live.getByRole("button", { name: "Used 2 sources" }).click();
  const source = live.getByRole("link", {
    name: "pnpm install | pnpm.io (opens in a new tab)",
  });
  await source.waitFor();
  if (
    (await source.getAttribute("href")) !== "https://pnpm.io/cli/install" ||
    (await source.getAttribute("rel")) !== "noreferrer"
  )
    throw new Error("Source lost its destination or new-tab protection.");
  await live.screenshot({ path: "output/playwright/trace/complete-turn.png" });

  // Automatic playback can stop and restart, with no duplicate event timers.
  await live.getByRole("button", { name: "Replay", exact: true }).click();
  await live.getByRole("button", { name: "Pause", exact: true }).click();
  if (!(await next.isEnabled()))
    throw new Error("Pause did not enable manual events.");
  await live.getByRole("button", { name: "Replay", exact: true }).click();
  await live
    .getByText("Replay complete", { exact: true })
    .waitFor({ timeout: 12_000 });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await live.getByRole("button", { name: "Reset", exact: true }).click();
  const shimmer = await page.evaluate(
    'getComputedStyle(document.querySelector("[data-status=running] .pantry-trace-title")).animationName',
  );
  if (shimmer !== "none")
    throw new Error("Reduced motion still animates the active title.");
  const spinner = await page.evaluate(
    'getComputedStyle(document.querySelector("[data-spinning]")).animationName',
  );
  if (spinner !== "none")
    throw new Error("Reduced motion still rotates the active icon.");
  await live.getByRole("button", { name: "Thinking", exact: true }).click();
  const transition = await page.evaluate(
    'getComputedStyle(document.querySelector("[aria-label=\\"Live turn\\"] .pantry-trace-collapsible-content")).transitionProperty',
  );
  if (transition !== "none")
    throw new Error("Reduced motion still animates panel height.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate("window.scrollTo(0, 0)");
  const overflow = await page.evaluate(
    "document.documentElement.scrollWidth > window.innerWidth",
  );
  if (overflow) throw new Error("Trace overflows the mobile viewport.");
  await page.screenshot({
    path: "output/playwright/trace/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await page.screenshot({
    path: "output/playwright/trace/mobile-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1512, height: 1250 });
  await page.screenshot({
    path: "output/playwright/trace/desktop-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use light theme" }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Exercise the same component through Portal's accepted-step adapter.
  await page.goto(`${origin}/agent-components-preview.html`);
  const summary = page.getByRole("button", {
    name: /Preparing the production sheet.*3 steps/,
  });
  await summary.click();
  const exportStep = page.getByRole("button", {
    name: "Prepare the production sheet Working",
    exact: true,
  });
  await exportStep.click();
  await page
    .getByText("Waiting for the export tool to return.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Receive export receipt", exact: true })
    .click();
  await page.getByText("Export receipt received.", { exact: true }).waitFor();
  const completedStep = page.getByRole("button", {
    name: "Prepare the production sheet Completed",
    exact: true,
  });
  if ((await completedStep.getAttribute("aria-expanded")) !== "true")
    throw new Error("Receipt update closed the inspected tool detail.");
  await page
    .locator(".reasoning-steps")
    .screenshot({ path: "output/playwright/trace/portal-activity.png" });
  await page.goto(`${origin}/trace-preview.html`);
  return {
    mergedShimmer: "passed",
    incomingRows: "passed",
    referenceReplay: "passed",
    terminalStream: "passed",
    nestedState: "passed",
    keyboard: "passed",
    streamOverride: "passed",
    failureDetails: "passed",
    sources: "passed",
    replay: "passed",
    reducedMotion: "passed",
    mobile: "passed",
    portalReceipt: "passed",
  };

  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
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
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }
}
