async function verifyChatTraceJourney(page) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/chat-preview.html?scenario=trace-execution&conversation=conv_00000000-0000-0000-0000-000000000001`,
  );
  await page.setViewportSize({ width: 1512, height: 1100 });
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByText("Inspecting shipment tools", { exact: true }).waitFor();
  await page
    .getByLabel("Action approval", { exact: true })
    .getByText("JPY 8400", { exact: true })
    .waitFor();
  await page
    .getByLabel("Action receipt", { exact: true })
    .getByText("chat_receipt_preview_refund", { exact: true })
    .waitFor();
  if (
    await page
      .getByLabel("Action receipt", { exact: true })
      .locator('[data-status="running"]')
      .count()
  )
    throw new Error("An uncertain receipt was shown as active work.");
  await page
    .getByRole("button", { name: /^Agent activity Tools and agent runs$/ })
    .click();
  await page.getByRole("button", { name: /^Research assignment / }).click();
  await page.getByRole("button", { name: /^tool_search / }).click();
  await page.getByText('{"query":"shipment A101"}', { exact: true }).waitFor();
  await page.getByText(/fragile pastry gift/).waitFor({ timeout: 12_000 });
  const search = page.getByRole("button", {
    name: "tool_search Succeeded",
    exact: true,
  });
  if ((await search.getAttribute("aria-expanded")) !== "true")
    throw new Error("Out-of-order settlement closed inspected tool details.");
  await page
    .getByRole("button", { name: "run_code Failed", exact: true })
    .click();
  await page.getByText(/TypeError: Missing delivery window/).waitFor();
  await page
    .getByRole("button", {
      name: "Proposed commerce action Approved",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Approval wait Approved", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Governed effect Result unknown",
      exact: true,
    })
    .click();
  await page.getByText("receipt_preview_refund", { exact: true }).waitFor();
  await page
    .getByText(
      "The provider outcome is unknown. Reconcile the existing action before another attempt.",
      { exact: true },
    )
    .waitFor();
  await page
    .locator(".chat-execution-trace")
    .filter({ hasText: "Agent activity" })
    .screenshot({
      path: "output/playwright/trace-runtime/tool-input-output.png",
      animations: "disabled",
    });
  await page
    .getByRole("button", { name: "Used 2 sources", exact: true })
    .click();
  await page
    .getByRole("link", { name: /Shipping documentation.*opens in a new tab/ })
    .waitFor();
  if (await page.locator('a[href^="javascript:"]').count())
    throw new Error("An unsafe source URL became a link.");
  await page
    .getByText("Prepare the kitchen handoff after the report.", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "output/playwright/trace-runtime/connected-patterns.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Revoke activity access", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry activity", exact: true })
    .waitFor({ timeout: 12_000 });
  if (await page.getByText(/fragile pastry gift/).count())
    throw new Error("Access loss retained a previous tool result.");
  if (await page.getByText(/TypeError: Missing delivery window/).count())
    throw new Error("Access loss retained a previous failure output.");
  if (await page.getByText("receipt_preview_refund", { exact: true }).count())
    throw new Error("Access loss retained a commerce receipt.");
  await page
    .locator(".chat-execution-trace")
    .filter({ hasText: "Agent activity" })
    .screenshot({
      path: "output/playwright/trace-runtime/access-withdrawn.png",
      animations: "disabled",
    });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate("document.documentElement.scrollWidth > innerWidth"))
    throw new Error("Chat activity overflows the mobile viewport.");
  await page.screenshot({
    path: "output/playwright/trace-runtime/mobile.png",
    animations: "disabled",
  });
  return {
    result: "passed",
    commerceReceipt: "passed",
    toolInputs: "passed",
    toolResults: "passed",
    recordedAgentRuns: "passed",
    outOfOrderSettlement: "passed",
    progress: "passed",
    queuedInput: "passed",
    sources: "passed",
    accessLoss: "passed",
    mobile: "passed",
  };
}
