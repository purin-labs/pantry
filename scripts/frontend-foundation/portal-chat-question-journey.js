// Actual Chat question integration against local fixture transports.
async function reviewChatQuestions(page) {
  const origin = new URL(page.url()).origin;
  const base = `${origin}/chat-preview.html?scenario=question&question=free-text`;
  const artifacts = "output/playwright/ui-navigation-review";
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.evaluate(
    "sessionStorage.removeItem('chat-preview-question-attempt'); sessionStorage.removeItem('chat-preview-question-answer'); sessionStorage.removeItem('chat-preview-regenerate')",
  );
  await page.goto(
    `${base}&conversation=conv_00000000-0000-0000-0000-000000000001`,
  );
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const question = page.getByRole("form", {
    name: "What should the delivery team know?",
    exact: true,
  });
  const answer =
    "Use the north entrance between 07:00 and 08:00. Call the pastry lead on arrival.";
  await question
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill(answer);
  await question
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await question.getByRole("alert").waitFor();
  if (
    (await question
      .getByRole("textbox", { name: "Your answer", exact: true })
      .inputValue()) !== answer
  )
    throw new Error("Chat lost the answer after the failed delivery.");
  await page.waitForFunction(
    "document.activeElement?.getAttribute('role') === 'alert'",
  );
  await question.screenshot({ path: `${artifacts}/chat-question-failed.png` });
  await question
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await question
    .getByText("Continued below in the conversation.", { exact: true })
    .waitFor();
  await page
    .getByRole("article", { name: "You", exact: true })
    .filter({ hasText: answer })
    .waitFor();
  if (
    await question
      .getByRole("button", { name: "Send answer", exact: true })
      .count()
  )
    throw new Error("Answered Chat question still offers a submit action.");
  await question.screenshot({
    path: `${artifacts}/chat-question-continued.png`,
  });
  for (const state of ["viewer", "archived"]) {
    await page.evaluate(
      "sessionStorage.removeItem('chat-preview-question-attempt'); sessionStorage.removeItem('chat-preview-question-answer')",
    );
    const query =
      state === "viewer"
        ? "conversation=conv_00000000-0000-0000-0000-000000000001&chatRole=viewer"
        : "conversation=conv_00000000-0000-0000-0000-000000000003";
    await page.goto(`${base}&${query}`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    await question
      .getByText("This conversation is read-only.", { exact: true })
      .waitFor();
    if (await question.getByRole("button").count())
      throw new Error(`${state} question exposes actions.`);
    await question.screenshot({
      path: `${artifacts}/chat-question-${state}.png`,
    });
  }
  await page.goto(`${origin}/agent-components-preview.html`);
  const actions = page.getByRole("region", {
    name: "Response actions preview",
    exact: true,
  });
  await actions.waitFor();
  await page.evaluate(`
    navigator.clipboard.writeText = async function recordClipboard(text) {
      window.reviewCopiedText = text;
    };
  `);
  await actions
    .getByRole("button", { name: "Copy response", exact: true })
    .click();
  await actions
    .getByRole("button", { name: "Copied response", exact: true })
    .waitFor();
  if (
    !(await page.evaluate("window.reviewCopiedText")).includes(
      "24 plain financiers",
    )
  )
    throw new Error("Copy did not receive the response text.");
  await page.evaluate(`
    navigator.clipboard.writeText = async function refuseClipboard() {
      throw new Error('Clipboard denied by local review fixture');
    };
  `);
  await actions
    .getByRole("button", { name: "Copied response", exact: true })
    .click();
  await actions.getByRole("alert").waitFor();
  await actions
    .getByRole("button", { name: "Copy response", exact: true })
    .waitFor();
  await actions.screenshot({ path: `${artifacts}/clipboard-refused.png` });
  return {
    status: "passed",
    chatAnswerFailureAndRetry: "passed",
    answeredAndReadOnlyStates: "passed",
    clipboardSuccessAndRefusal: "passed",
    artifacts,
  };
}
