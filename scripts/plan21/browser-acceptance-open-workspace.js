async (page) => {
  const workspace = page.locator(
    'a.organisation-row[href="/portal/cafe-browser-lab"]',
  );
  await workspace.waitFor({ state: "visible", timeout: 10_000 });
  await workspace.click();
  await page
    .locator('nav[aria-label="Workspace pages"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  return {
    path: page
      .url()
      .replace(/^https?:\/\/[^/]+/u, "")
      .split("?")[0],
  };
};
