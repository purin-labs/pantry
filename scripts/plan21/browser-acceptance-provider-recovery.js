async (page) => {
  await page
    .locator("h1#portal-page-title")
    .filter({ hasText: "Integrations" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const status = page.getByText("Reconnect required", { exact: true });
  const reconnect = page.getByRole("button", {
    name: "Reconnect",
    exact: true,
  });
  const account = page
    .locator(".account-row")
    .filter({ hasText: "Café acceptance Slack" });
  await status.first().waitFor({ state: "visible", timeout: 10_000 });
  await reconnect.first().waitFor({ state: "visible", timeout: 10_000 });
  await account.first().waitFor({ state: "visible", timeout: 10_000 });
  const statusCount = await status.count();
  const reconnectCount = await reconnect.count();
  const beforeText = (await account.textContent()) ?? "";
  const accountVisible = await account.isVisible();
  await reconnect.first().click();
  await page
    .locator("h1#portal-page-title")
    .filter({ hasText: "Integrations" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".account-row")).some((row) =>
        (row.textContent ?? "").includes("Healthy"),
      ),
    undefined,
    { timeout: 10_000 },
  );
  const recoveredAccount = page
    .locator(".account-row")
    .filter({ hasText: "Café acceptance Slack" });
  const recoveredText = ((await recoveredAccount.textContent()) ?? "").replace(
    /\s+/gu,
    " ",
  );
  return {
    statusCount,
    reconnectCount,
    accountVisible,
    rawReasonVisible: beforeText.includes("oauth_scope_revoked"),
    activeStatusCount: recoveredText.includes("Active") ? 1 : 0,
    recoveredVisible: recoveredText.length > 0,
    recoveredText,
    path: await page.evaluate(() => location.pathname + location.search),
  };
};
