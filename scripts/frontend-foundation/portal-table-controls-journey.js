// Shared table interactions using the populated local preview dataset.
async function reviewTableControls(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-navigation-review";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/agent-components-preview.html`);
  const preview = page.getByRole("region", {
    name: "CRM table preview",
    exact: true,
  });
  const table = preview.getByRole("region", { name: "Products", exact: true });
  await table.getByRole("button", { name: "Stock", exact: true }).click();
  if (
    !(await table.locator("tbody tr").first().innerText()).includes(
      "Country sourdough",
    )
  )
    throw new Error("Numeric stock sort did not put zero stock first.");
  await table.getByRole("button", { name: "Pin Stock", exact: true }).click();
  await table
    .getByRole("button", { name: "Unpin Stock", exact: true })
    .waitFor();
  const resize = table.getByRole("separator", {
    name: "Resize Stock",
    exact: true,
  });
  const width = Number(await resize.getAttribute("aria-valuenow"));
  await resize.focus();
  await resize.press("ArrowRight");
  if (Number(await resize.getAttribute("aria-valuenow")) <= width)
    throw new Error("Keyboard resize did not increase column width.");
  await preview
    .getByRole("searchbox", { name: "Search records", exact: true })
    .fill("Financiers");
  await table
    .getByRole("checkbox", { name: "Select all visible rows", exact: true })
    .check();
  if ((await table.locator("tbody input:checked").count()) !== 2)
    throw new Error("Visible row selection included the wrong records.");
  await table
    .getByRole("button", { name: "Calculate Stock", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sum", exact: true }).click();
  if (
    !(
      await table
        .getByRole("button", { name: "Calculate Stock", exact: true })
        .innerText()
    ).includes("62")
  )
    throw new Error("Filtered stock total is wrong.");
  await table.screenshot({
    path: `${artifacts}/table-filtered-calculation.png`,
  });
  await preview
    .getByRole("searchbox", { name: "Search records", exact: true })
    .fill("");
  if (
    !(
      await table
        .getByRole("button", { name: "Calculate Stock", exact: true })
        .innerText()
    ).includes("146")
  )
    throw new Error("Stock total did not update after removing the filter.");
  if ((await table.locator("tbody input:checked").count()) !== 2)
    throw new Error("Removing a filter lost selected rows.");
  await table
    .getByRole("button", {
      name: "Actions for Chocolate financier",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "View product details", exact: true })
    .click();
  await preview
    .getByText(/Chocolate financier · FIN-002 · 14 in stock/)
    .waitFor();
  await page.setViewportSize({ width: 320, height: 1000 });
  await table.getByRole("button", { name: "Unpin Stock", exact: true }).click();
  await preview
    .getByRole("searchbox", { name: "Search records", exact: true })
    .fill("Milk bread");
  await table.getByText("1 record in view", { exact: true }).waitFor();
  await preview.screenshot({
    path: `${artifacts}/table-single-record-narrow.png`,
  });
  await preview
    .getByRole("searchbox", { name: "Search records", exact: true })
    .fill("unmatched-product");
  await table.getByText("No records found", { exact: true }).waitFor();
  if (
    !(await table
      .getByRole("checkbox", { name: "Select all visible rows", exact: true })
      .isDisabled())
  )
    throw new Error("Empty table permits row selection.");
  await preview.screenshot({ path: `${artifacts}/table-empty-narrow.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await preview.getByRole("button", { name: "Orders", exact: true }).click();
  await preview
    .getByRole("region", { name: "Orders", exact: true })
    .screenshot({ path: `${artifacts}/table-orders-dark.png` });
  return {
    status: "passed",
    numericSort: "passed",
    pinAndKeyboardResize: "passed",
    selectionAcrossFilter: "passed",
    calculationAcrossFilter: "passed",
    rowAction: "passed",
    emptyAndSingleRecord: "passed",
    artifacts,
  };
}
