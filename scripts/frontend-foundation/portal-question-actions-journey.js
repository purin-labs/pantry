// Isolated question and response-action harness, plus real Chat question flow.
async function reviewQuestionsAndActions(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-navigation-review";
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto(`${origin}/agent-components-preview.html`);
  const question = page.getByRole("form", {
    name: "Who should receive the production sheet?",
    exact: true,
  });
  await question
    .getByRole("radio", { name: "Something else…", exact: true })
    .check();
  await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
  await question
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill(
      "Send the sheet to the pastry lead after the morning inventory count.",
    );
  await question
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Simulate failed delivery", exact: true })
    .click();
  await question.getByRole("alert").waitFor();
  await page.waitForFunction(
    "document.activeElement?.getAttribute('role') === 'alert'",
  );
  if (
    !(
      await question
        .getByRole("textbox", { name: "Your answer", exact: true })
        .inputValue()
    ).includes("pastry lead")
  )
    throw new Error("Failed answer lost the custom text.");
  await question.screenshot({
    path: `${artifacts}/question-custom-failed.png`,
  });
  await question
    .getByRole("textbox", { name: "Your answer", exact: true })
    .press("Control+Enter");
  await page
    .getByRole("button", { name: "Accept answer", exact: true })
    .click();
  await question
    .locator(".question-answer")
    .filter({
      hasText:
        "Send the sheet to the pastry lead after the morning inventory count.",
    })
    .waitFor();
  await page.waitForFunction("document.activeElement?.tagName === 'H3'");
  await question.screenshot({ path: `${artifacts}/question-accepted.png` });

  const actions = page.getByRole("region", {
    name: "Response actions preview",
    exact: true,
  });
  await actions
    .getByRole("button", { name: "Rate response", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: "Good response", exact: true })
    .click();
  await actions
    .getByRole("button", { name: "Accept action", exact: true })
    .click();
  await actions.getByText("Rating accepted: good.", { exact: true }).waitFor();
  await actions
    .getByRole("button", { name: "Rate response", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: "Bad response", exact: true })
    .click();
  await actions
    .getByRole("button", { name: "Fail action", exact: true })
    .click();
  await actions.getByRole("alert").waitFor();
  await actions
    .getByRole("button", { name: "Rate response", exact: true })
    .click();
  if (
    (await page
      .getByRole("menuitemcheckbox", { name: "Good response", exact: true })
      .getAttribute("aria-checked")) !== "true"
  )
    throw new Error("A failed rating replaced the accepted rating.");
  await page.screenshot({ path: `${artifacts}/rating-failure-preserved.png` });
  await page.keyboard.press("Escape");
  await actions
    .getByRole("button", { name: "Regenerate response", exact: true })
    .click();
  await actions.getByText("Pending: regenerate.", { exact: true }).waitFor();
  await actions.screenshot({ path: `${artifacts}/response-regenerating.png` });
  await actions
    .getByRole("button", { name: "Fail action", exact: true })
    .click();
  await actions.getByRole("alert").waitFor();
  await actions
    .getByRole("button", { name: "Regenerate response", exact: true })
    .click();
  await actions
    .getByRole("button", { name: "Accept action", exact: true })
    .click();
  await actions
    .getByText("Replacement response received.", { exact: true })
    .waitFor();
  await actions.screenshot({ path: `${artifacts}/response-regenerated.png` });

  for (const state of ["free-text", "paused", "closed"]) {
    const query =
      state === "free-text" ? "question=free-text" : `availability=${state}`;
    await page.goto(`${origin}/agent-components-preview.html?${query}`);
    const form = page.locator(".question-card");
    await form.waitFor();
    if (state === "free-text") {
      if (await form.getByRole("radio").count())
        throw new Error("Text-only question offers an unrelated radio choice.");
      await form
        .getByRole("textbox", { name: "Your answer", exact: true })
        .fill("Use the north entrance between 07:00 and 08:00.");
    }
    if (
      state === "paused" &&
      !(await form
        .getByRole("button", { name: "Send answer", exact: true })
        .isDisabled())
    )
      throw new Error("Paused question accepts an answer.");
    if (
      state === "closed" &&
      (await form
        .getByRole("button", { name: "Send answer", exact: true })
        .count())
    )
      throw new Error("Closed question still exposes a submit button.");
    await form.screenshot({ path: `${artifacts}/question-${state}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page
    .locator(".question-card")
    .screenshot({ path: `${artifacts}/question-closed-dark.png` });
  return {
    status: "passed",
    customAnswerRecovery: "passed",
    answerFocus: "passed",
    ratingFailurePreservesVote: "passed",
    regenerationRecovery: "passed",
    freeTextAndAvailability: "passed",
    artifacts,
  };
}
