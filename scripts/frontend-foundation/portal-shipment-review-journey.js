// Run after the Plan 21 browser fixture. Its tracking writes always fail.
async function reviewShipments(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-chat-decisions";
  await page
    .context()
    .addCookies([
      {
        name: "satyr_control_csrf",
        value: "isolated-shipment-review",
        url: origin,
      },
    ]);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(
    `${origin}/portal/cafe-browser-lab/main/operations?p21_tracking=1`,
  );
  const section = page.locator(".commerce-exception-workbench");
  await section.getByRole("checkbox").first().waitFor();
  if (
    !(await section
      .getByRole("button", { name: "Review 0 shipments", exact: true })
      .isDisabled())
  )
    throw new Error("An empty selection permits review.");
  for (const input of await section.getByRole("checkbox").all())
    await input.check();
  await section
    .getByRole("button", { name: "Review 3 shipments", exact: true })
    .click();
  await section.getByRole("alert").waitFor();
  const errorInView = await page.evaluate(
    "document.activeElement?.getAttribute('role') === 'alert' && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().bottom <= innerHeight",
  );
  if (!errorInView)
    throw new Error("Shipment failure remains outside the viewport.");
  if ((await section.locator("input:checked").count()) !== 3)
    throw new Error("The failed read lost shipment selection.");
  await page.screenshot({ path: `${artifacts}/shipping-read-failed.png` });
  await section
    .getByRole("button", { name: "Try review again", exact: true })
    .click();
  await section
    .getByText("2 shipments ready to fix", { exact: true })
    .waitFor();
  await section
    .getByText(
      "This shipment changed while you were reviewing it, so it was left out.",
      { exact: true },
    )
    .waitFor();
  await section.screenshot({ path: `${artifacts}/shipping-mixed-review.png` });
  await section.getByRole("button", { name: "Back", exact: true }).click();
  if ((await section.locator("input:checked").count()) !== 3)
    throw new Error("Back lost the reviewed selection.");
  await section
    .getByRole("button", { name: "Review 3 shipments", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Create 2 approvals", exact: true })
    .click();
  await section
    .getByText("0 approvals created. 2 shipments still need attention.", {
      exact: true,
    })
    .waitFor();
  const outcomeVisible = await page.evaluate(
    "document.activeElement?.classList.contains('notice') && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().bottom <= innerHeight",
  );
  if (!outcomeVisible)
    throw new Error("Shipment result did not receive focus in view.");
  await page.screenshot({ path: `${artifacts}/shipping-approval-failure.png` });
  await section
    .getByRole("button", { name: "Review failed shipments", exact: true })
    .click();
  if ((await section.locator("input:checked").count()) !== 2)
    throw new Error("Recovery did not retain only the failed shipments.");
  if (await section.getByRole("checkbox", { name: /Order 1042/ }).isChecked())
    throw new Error("The changed shipment was included in failure recovery.");
  await section
    .locator(".commerce-exception-item")
    .first()
    .screenshot({ path: `${artifacts}/shipping-exception-item.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await section.screenshot({ path: `${artifacts}/shipping-dark.png` });
  return {
    status: "passed",
    failedReadPreservesSelection: "passed",
    changedShipmentExcluded: "passed",
    backPreservesSelection: "passed",
    failedApprovalRecovery: "passed",
    visibleErrorAndOutcome: "passed",
    artifacts,
  };
}
