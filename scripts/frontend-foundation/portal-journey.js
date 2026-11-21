async function portalJourney(page) {
  const currentUrl = page.url();
  const originEnd = currentUrl.indexOf("/", currentUrl.indexOf("://") + 3);
  const origin = originEnd === -1 ? currentUrl : currentUrl.slice(0, originEnd);
  await page.goto(`${origin}/portal?p21_auth=1&p21_provider=1`);
  await page.evaluate(() => {
    document.cookie =
      "pantry_csrf=csrf_frontend_foundation; path=/; SameSite=Lax";
  });
  const workspace = page.locator(
    'a.organisation-row-link[href="/portal/cafe-browser-lab"]',
  );
  await workspace.waitFor({ state: "visible", timeout: 10_000 });
  await workspace.click();
  await page.locator('a[href="/portal/cafe-browser-lab/main"]').first().click();
  const operations = page
    .locator(
      'nav[aria-label="Workspace pages"]:visible a[href="/portal/cafe-browser-lab/main/operations"]',
    )
    .first();
  await operations.waitFor({ state: "visible", timeout: 10_000 });
  await operations.click();
  await page.getByRole("heading", { name: "Operations" }).waitFor();
  const review = page.getByRole("button", { name: "Review change" }).first();
  await review.click();
  const approve = page.getByRole("button", { name: "Approve and apply" });
  await approve.waitFor({ state: "visible", timeout: 10_000 });
  await approve.click();
  await page
    .locator(".commerce-action-status .action-state")
    .filter({ hasText: /Approved|Confirmed|Applied/u })
    .waitFor();
  const approved = await page
    .getByText("Approved", { exact: true })
    .first()
    .isVisible();
  const providerReceiptClaimed = (
    (await page.locator(".commerce-action-status").textContent()) ?? ""
  ).includes("Provider receipt");
  const operationsPath = await page.evaluate(() => location.pathname);
  const integrations = page
    .locator(
      'nav[aria-label="Workspace pages"]:visible a[href="/portal/cafe-browser-lab/main/integrations"]',
    )
    .first();
  await integrations.click();
  await page.getByRole("heading", { name: "Connected", exact: true }).waitFor();
  const integrationsOverview =
    (await page.getByRole("heading", { name: "Add an app" }).isVisible()) &&
    (await page.locator(".integration-detail").count()) === 0;
  const search = page.getByRole("searchbox", { name: "Search apps" });
  await search.fill("files");
  const driveSearch =
    (await page.getByRole("link", { name: /Google Drive/u }).isVisible()) &&
    (await page.getByRole("link", { name: /Slack/u }).count()) === 0;
  await search.fill("");
  const drive = page.getByRole("link", { name: /Google Drive/u }).first();
  await drive.click();
  const detailDialog = page.getByRole("dialog", { name: "Google Drive" });
  await detailDialog.waitFor();
  const driveDetail = await detailDialog
    .getByRole("heading", { name: "Google Drive", exact: true })
    .isVisible();
  await detailDialog.getByRole("button", { name: /Close/ }).click();
  await detailDialog.waitFor({ state: "hidden" });
  const backRestored = await drive.evaluate(
    (element) => element === document.activeElement,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page
    .getByRole("heading", { name: "Apps and connectors" })
    .scrollIntoViewIfNeeded();
  const integrationsMobileFits = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  return {
    path: operationsPath,
    approved,
    providerReceiptClaimed,
    noHorizontalOverflow: await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    integrationsOverview,
    driveSearch,
    driveDetail,
    backRestored,
    integrationsMobileFits,
  };
}
