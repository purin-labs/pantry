async function verifyChatFinalization(page) {
  const origin = await page.evaluate("location.origin");
  const failedUrl = `${origin}/chat-preview.html?scenario=failed-stream&conversation=conv_00000000-0000-0000-0000-000000000001`;
  await page.goto(failedUrl);
  await page.evaluate(() => {
    window.chatAcceptanceReads = { status: 0, full: 0, changed: 0 };
    const fetch = window.fetch;
    window.fetch = function countChatReads(input, init) {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.origin,
      );
      if (
        url.pathname.endsWith("/chat") &&
        (!init?.method || init.method === "GET")
      ) {
        if (url.searchParams.get("view") === "state")
          window.chatAcceptanceReads.status += 1;
        else if (url.searchParams.get("observe") === "true")
          window.chatAcceptanceReads.changed += 1;
        else window.chatAcceptanceReads.full += 1;
      }
      return fetch(input, init);
    };
  });
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop response", exact: true })
    .waitFor();
  await page.getByRole("status").filter({ hasText: "Responding…" }).waitFor();
  const documentStartedAt = await page.evaluate("performance.timeOrigin");
  const startedAt = Date.now();
  await page.screenshot({
    path: "output/playwright/chat-finalization-active.png",
  });
  await page
    .getByRole("button", { name: "Retry response", exact: true })
    .waitFor({ timeout: 10_000 });
  if (
    await page
      .getByRole("button", { name: "Stop response", exact: true })
      .count()
  )
    throw new Error("Failed turn still shows Stop");
  if (
    await page
      .getByRole("article", { name: "Assistant response in progress" })
      .count()
  )
    throw new Error("Failed turn still shows a generating answer");
  if (await page.locator(".response-indicator").count())
    throw new Error("Failed turn still shows an active response indicator");
  if (
    !(await page
      .getByRole("alert")
      .getByText("The selected AI could not finish this response.", {
        exact: true,
      })
      .isVisible())
  )
    throw new Error("Canonical failure is missing");
  if (
    (await page
      .getByText("The selected AI could not finish this response.", {
        exact: true,
      })
      .count()) !== 1
  )
    throw new Error("The current failure is repeated in the conversation");
  if ((await page.evaluate("performance.timeOrigin")) !== documentStartedAt)
    throw new Error("Failure required a page reload");
  const failureVisibleAfterMs = Date.now() - startedAt;
  const reads = await page.evaluate(() => window.chatAcceptanceReads);
  await page.screenshot({
    path: "output/playwright/chat-finalization-failed.png",
  });

  await page.goto(failedUrl);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop response", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page
    .getByRole("link", { name: "Review the spring menu", exact: true })
    .click();
  // Cross the old request's reconciliation deadline after switching chats.
  await page.waitForTimeout(6_000);
  if (
    (await page
      .getByRole("button", { name: "Retry response", exact: true })
      .count()) ||
    (await page
      .getByRole("button", { name: "Stop response", exact: true })
      .count()) ||
    !(await page
      .getByRole("textbox", { name: "Message your AI", exact: true })
      .isEnabled())
  )
    throw new Error("Previous turn contaminated the selected chat");
  if (await page.locator(".response-indicator").count())
    throw new Error("Previous turn's indicator leaked into the selected chat");
  await page.screenshot({
    path: "output/playwright/chat-finalization-switched.png",
  });

  await page.goto(
    `${origin}/chat-preview.html?scenario=running&conversation=conv_00000000-0000-0000-0000-000000000001`,
  );
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop response", exact: true })
    .waitFor();
  await page.getByRole("status").filter({ hasText: "Working…" }).waitFor();
  await page.screenshot({
    path: "output/playwright/chat-indicator-working.png",
    animations: "disabled",
  });
  await page.getByRole("status").filter({ hasText: "Responding…" }).waitFor();
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .waitFor({ timeout: 10_000 });
  if (
    !(await page
      .getByText("Ready for your review.", { exact: true })
      .isVisible()) ||
    (await page
      .getByRole("article", { name: "Assistant response in progress" })
      .count()) ||
    (await page
      .getByRole("button", { name: "Retry response", exact: true })
      .count())
  )
    throw new Error("Successful completion did not settle cleanly");
  if (await page.locator(".response-indicator").count())
    throw new Error("Completed response still shows an active indicator");
  await page.screenshot({
    path: "output/playwright/chat-finalization-complete.png",
  });
  return {
    failureVisibleAfterMs,
    reads,
    reloadRequired: false,
    staleRequestFenced: true,
    successfulCompletion: true,
  };
}
