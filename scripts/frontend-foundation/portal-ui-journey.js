// Run with playwright-cli run-code against the Portal Vite server.
// The dedicated previews provide data. Real components produce every outcome.
async function verifyPortalInterface(page) {
  const origin = new URL(page.url()).origin;
  const evidence = "output/playwright/ui-inventory";
  const checks = [];

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/commerce-preview.html?page=checkout&scenario=retry`,
  );
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await retry.waitFor();
  await retry.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("region", { name: "How customers buy", exact: true })
    .waitFor();
  if (await retry.count())
    throw new Error("Checkout recovery retained the failed state.");
  await page
    .getByRole("button", {
      name: "Cafe pickup and delivery Revision 4 Draft",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Edit settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Hide settings", exact: true })
    .waitFor();
  checks.push(
    "Checkout recovers by keyboard after a failed read, then opens its draft editor.",
  );
  await page.screenshot({ path: `${evidence}/checkout-after.png` });

  await page.goto(`${origin}/access-preview.html?scenario=populated`);
  const tokens = page.getByRole("spinbutton", { name: "Tokens", exact: true });
  await tokens.waitFor();
  const originalTokens = await tokens.inputValue();
  await tokens.fill("12345");
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  if ((await tokens.inputValue()) !== originalTokens) {
    throw new Error("Budget reset did not restore the current token limit.");
  }
  await page.locator("#ai-budgets").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/access-budget-after.png` });
  await page.setViewportSize({ width: 320, height: 800 });
  const share = page.getByRole("button", {
    name: "Share Shopify",
    exact: true,
  });
  await share.scrollIntoViewIfNeeded();
  const shareBounds = await share.boundingBox();
  if (
    shareBounds === null ||
    shareBounds.width < 100 ||
    shareBounds.height > 80
  ) {
    throw new Error("The narrow sharing action is compressed.");
  }
  await page.screenshot({ path: `${evidence}/access-narrow-after.png` });
  await tokens.scrollIntoViewIfNeeded();
  if (
    !(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
  ) {
    throw new Error("The budget form exceeds the narrow viewport.");
  }
  checks.push(
    "Budget reset preserves current limits; the narrow form and sharing action remain usable.",
  );

  await page.goto(`${origin}/commerce-preview.html?page=orders`);
  const table = page.getByRole("region", {
    name: "Customer orders table",
    exact: true,
  });
  await table.waitFor();
  await table.focus();
  for (let index = 0; index < 12; index += 1)
    await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    "document.querySelector('.crm-scroll').scrollLeft > 0",
  );
  if (
    (await page.evaluate("document.querySelector('.crm-scroll').scrollLeft")) <=
    0
  ) {
    throw new Error("The narrow order table cannot scroll by keyboard.");
  }
  await page
    .getByRole("button", { name: /Lifecycle/ })
    .first()
    .waitFor();
  await page.screenshot({ path: `${evidence}/orders-narrow-after.png` });
  checks.push("The narrow order table reveals trailing columns by keyboard.");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/agents-preview.html`);
  const createAgent = page.getByRole("button", {
    name: "Create agent",
    exact: true,
  });
  await createAgent.waitFor();
  await page.screenshot({ path: `${evidence}/agents-after.png` });
  await createAgent.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    "document.activeElement === document.querySelector('.agents-page-heading .agent-console-new')",
  );
  checks.push(
    "The agent dialog opens by keyboard, closes with Escape, and restores focus.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/brain-preview.html`);
  await page
    .getByRole("navigation", { name: "Knowledge views", exact: true })
    .waitFor();
  const counts = page.locator(".brain-count");
  const firstCount = await counts.nth(0).boundingBox();
  const secondCount = await counts.nth(1).boundingBox();
  if (
    firstCount === null ||
    secondCount === null ||
    Math.abs(firstCount.y - secondCount.y) > 1
  ) {
    throw new Error("Brain summaries do not share a row at narrow width.");
  }
  await page.screenshot({ path: `${evidence}/brain-narrow-after.png` });
  await page.getByRole("link", { name: "Knowledge", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Knowledge", exact: true }).waitFor();
  if (
    !(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
  ) {
    throw new Error("Brain exceeds the narrow viewport.");
  }
  checks.push(
    "Brain uses two summary columns at 320 pixels and retains keyboard view navigation with reduced motion.",
  );

  return { status: "passed", checks, screenshots: evidence };
}
