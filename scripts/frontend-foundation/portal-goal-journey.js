// Goal fault and narrow-layout review against local Chat fixtures.
async function reviewGoalStates(page) {
  const origin = new URL(page.url()).origin;
  const conversation = "conv_00000000-0000-0000-0000-000000000001";
  const base = `${origin}/chat-preview.html?conversation=${conversation}`;
  const artifacts = "output/playwright/ui-purchasing-review";
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${base}&goal=active&goalFault=conflict`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "Edit goal", exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${artifacts}/goal-bar-after.png` });
  const controlsFit = await page.evaluate(
    "Array.from(document.querySelectorAll('.chat-goal-bar button')).every(e => e.getBoundingClientRect().width >= 44 && e.getBoundingClientRect().right <= innerWidth) && document.querySelector('.chat-goal-bar-text').getBoundingClientRect().width > 180",
  );
  if (!controlsFit)
    throw new Error("Narrow goal controls or label do not fit.");
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  const goal = page.getByRole("dialog", { name: "Edit goal", exact: true });
  const objective = "Preserve this local objective after a revision conflict.";
  await goal
    .getByRole("textbox", { name: "Objective", exact: true })
    .fill(objective);
  await goal
    .getByRole("spinbutton", { name: "Token budget", exact: true })
    .fill("1500000");
  await goal.getByRole("button", { name: "Save", exact: true }).click();
  await goal.getByRole("alert").waitFor();
  if (
    (await goal
      .getByRole("textbox", { name: "Objective", exact: true })
      .inputValue()) !== objective
  )
    throw new Error("Concurrent goal update erased the local objective.");
  if (
    (await goal
      .getByRole("spinbutton", { name: "Token budget", exact: true })
      .inputValue()) !== "1500000"
  )
    throw new Error("Concurrent goal update erased the local budget.");
  await page.screenshot({ path: `${artifacts}/goal-conflict-after.png` });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    "document.activeElement?.getAttribute('aria-label') === 'Edit goal'",
  );
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  if (
    (await goal
      .getByRole("textbox", { name: "Objective", exact: true })
      .inputValue()) !== "Updated by another operator."
  )
    throw new Error("Reopening did not show the latest goal.");

  // While a request runs, a failed background read is not a failure of that
  // request. The panel says nothing and reads again.
  const failures = () => page.evaluate("window.previewGoalReadFailures ?? 0");
  const assertFailuresGrowInSilence = async (moment) => {
    const before = await failures();
    await page.waitForFunction(
      `(window.previewGoalReadFailures ?? 0) > ${String(before)}`,
      null,
      { timeout: 20_000 },
    );
    if ((await page.locator(".chat-goal-error").count()) !== 0)
      throw new Error(`A background goal read showed a failure ${moment}.`);
  };
  const running = `${base}&goal=active&goalFault=read&scenario=running&streamHold=1`;
  await page.goto(running);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await assertFailuresGrowInSilence("while a request runs");
  await assertFailuresGrowInSilence("on its next read");
  await page.screenshot({ path: `${artifacts}/goal-read-background.png` });
  await page.evaluate("window.previewGoalReadFails = false");
  await page.getByRole("button", { name: "Edit goal", exact: true }).waitFor();
  await page.evaluate("window.previewGoalReadFails = true");
  await page.evaluate("window.previewStreamRelease = true");
  await assertFailuresGrowInSilence("after the goal was shown");
  await page.getByRole("button", { name: "Edit goal", exact: true }).waitFor();

  // A run that waits for a person is not a failure either, after a reload too.
  await page.goto(`${base}&goal=active&goalFault=read&scenario=permission`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await assertFailuresGrowInSilence("while a run waits for a person");
  await assertFailuresGrowInSilence("on its next read while it waits");
  await page.screenshot({ path: `${artifacts}/goal-read-permission-pause.png` });
  await page.goto(`${base}&goal=active&goalFault=read&scenario=approval-past-limit`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await assertFailuresGrowInSilence("after the time limit of an approval");
  await assertFailuresGrowInSilence("on its next read after that limit");
  await page.screenshot({ path: `${artifacts}/goal-read-approval-past-limit.png` });

  // A failure that stays after the request ended is shown.
  await page.goto(running);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.waitForFunction("(window.previewGoalReadFailures ?? 0) > 0");
  await page.evaluate("window.previewStreamRelease = true");
  await page.locator(".chat-goal-error").waitFor();

  // A failure with no request running is shown at once, and a person recovers.
  await page.goto(`${base}&goal=active&goalFault=read`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.locator(".chat-goal-error").waitFor();
  await page
    .getByRole("textbox", { name: "Message your AI", exact: true })
    .fill("/goal");
  await page
    .getByRole("textbox", { name: "Message your AI", exact: true })
    .press("Enter");
  const recovery = page.getByRole("dialog", { name: "Set goal", exact: true });
  await recovery
    .getByRole("button", { name: "Try again", exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/goal-read-failed.png` });
  await page.evaluate("window.previewGoalReadFails = false");
  await recovery
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await goal.getByRole("textbox", { name: "Objective", exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/goal-read-recovered.png` });

  const states = [
    { name: "active", query: "goal=active" },
    { name: "paused", query: "goal=paused" },
    { name: "budget", query: "goal=budget_limited" },
    { name: "complete", query: "goal=completed" },
    { name: "viewer", query: "goal=active&goalAccess=viewer" },
    { name: "busy", query: "goal=active&goalAccess=busy" },
    { name: "unavailable", query: "goal=paused&goalAccess=unavailable" },
    { name: "unknown", query: "goal=paused&goalAccess=unknown" },
  ];
  const reviewedStates = [];
  for (const state of states) {
    reviewedStates.push(state.name);
    await page.goto(`${base}&${state.query}`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    await page.getByRole("button", { name: "Edit goal", exact: true }).click();
    await goal
      .getByRole("textbox", { name: "Objective", exact: true })
      .waitFor();
    await page.waitForTimeout(300);
    if (
      ["viewer", "busy", "unavailable"].includes(state.name) &&
      !(await goal
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled())
    )
      throw new Error(`${state.name} permits a goal edit.`);
    if (
      ["budget", "unknown", "unavailable"].includes(state.name) &&
      !(await goal
        .getByRole("button", { name: "Resume", exact: true })
        .isDisabled())
    )
      throw new Error(`${state.name} permits goal resumption.`);
    await page.screenshot({
      path: `${artifacts}/goal-${state.name}-narrow.png`,
    });
    if (state.name === "active") {
      await goal
        .getByRole("button", { name: "Complete goal", exact: true })
        .click();
      await goal
        .getByRole("textbox", { name: "Completion evidence", exact: true })
        .fill(
          "Reviewed all delayed deliveries and linked the supplier responses.",
        );
      await page.screenshot({
        path: `${artifacts}/goal-completion-evidence.png`,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(
        "document.documentElement.dataset.portalTheme = 'dark'",
      );
      await page.screenshot({ path: `${artifacts}/goal-wide-dark.png` });
      await page.setViewportSize({ width: 320, height: 800 });
    }
  }

  await page.goto(base);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message your AI", exact: true })
    .fill("/goal");
  await page
    .getByRole("textbox", { name: "Message your AI", exact: true })
    .press("Enter");
  await recovery
    .getByRole("textbox", { name: "Objective", exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/goal-empty.png` });
  await page.keyboard.press("Escape");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "supplier-delivery-notes-for-the-autumn-menu-review.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Receive deliveries before 10:00."),
  });
  await page
    .getByRole("list", { name: "Attached files", exact: true })
    .waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${artifacts}/chat-attached-file.png` });
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "empty.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(""),
  });
  await page
    .getByRole("log", { name: "Messages entries", exact: true })
    .getByText(/^Attach up to .* non-empty files/)
    .waitFor();
  await page.screenshot({ path: `${artifacts}/chat-empty-file-refused.png` });
  const attachments = page.getByRole("list", {
    name: "Attached files",
    exact: true,
  });
  if ((await attachments.getByRole("listitem").count()) !== 1)
    throw new Error("Invalid attachment replaced the valid attachment.");
  await attachments.getByRole("button").click();
  await attachments.waitFor({ state: "hidden" });
  return {
    status: "passed",
    concurrentGoalEditPreserved: "passed",
    readRecovery: "passed",
    narrowControls: "passed",
    states: reviewedStates,
    emptyGoal: "reviewed",
    attachmentRejectionAndRemoval: "passed",
    artifacts,
  };
}
