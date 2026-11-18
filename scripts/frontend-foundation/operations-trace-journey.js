// Run with scripts/bakery-robots/browser-acceptance.mjs against operations-trace-preview.html.
// Commerce uses sample records. Robot layout checks execute the local simulation worker.
function robotFrameFits() {
  const frame = document.querySelector(".ops-simulation");
  const root = frame?.contentDocument?.getElementById("root");
  return (
    root !== undefined &&
    root !== null &&
    frame.clientHeight >= Math.ceil(root.getBoundingClientRect().height)
  );
}
function positionRobotForScroll() {
  const frame = document.querySelector(".ops-simulation");
  window.scrollTo({
    top: window.scrollY + frame.getBoundingClientRect().top - 100,
    behavior: "instant",
  });
  return window.scrollY;
}
function outerPageScrolledUp(before) {
  return window.scrollY < before - 50;
}
async function verifyOperationsTrace(page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const activity = page.getByLabel("Commerce activity", { exact: true });
  await page
    .getByRole("button", { name: "Approve example", exact: true })
    .click();
  await activity
    .getByText("Approved · ready to apply", { exact: true })
    .waitFor();
  if (await activity.locator('[data-status="running"]').count())
    throw new Error("Approval was shown as active execution.");
  await page
    .getByRole("button", { name: "Apply example", exact: true })
    .click();
  await activity
    .getByText("Apply the approved change", { exact: true })
    .waitFor();
  await activity.getByText("Outcome unknown", { exact: true }).waitFor();
  if (await activity.locator('[data-status="running"]').count())
    throw new Error("Unknown outcome continued to shimmer.");
  if (
    await page
      .getByRole("button", { name: "Apply example", exact: true })
      .count()
  )
    throw new Error("Unknown outcome offered another execution.");
  await page.screenshot({ path: "operations-unknown.png", fullPage: true });
  await page
    .getByRole("button", { name: "Simulate receipt recovery", exact: true })
    .click();
  await activity
    .getByText("Change accepted by the commerce system", { exact: true })
    .waitFor();
  await activity.getByText("receipt_preview_1048", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Proposed change recorded", exact: true })
    .press("Enter");
  await activity
    .getByText("Full refund · ¥8,400", { exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Proposed change recorded", exact: true })
    .press("Enter");
  await page.screenshot({ path: "operations-receipt.png", fullPage: true });
  await page
    .getByRole("button", { name: "Reset examples", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Decline example", exact: true })
    .click();
  await activity.getByText("Change declined", { exact: true }).waitFor();
  if (await activity.getByText("Provider receipt", { exact: true }).count())
    throw new Error("A declined proposal displayed a provider receipt.");
  await page.setViewportSize({ width: 390, height: 844 });
  const robot = page.frameLocator('iframe[title="Local robot simulation"]');
  await robot.getByRole("button", { name: "Start run", exact: true }).click();
  await robot.getByText(/^6 of 6 steps complete/u).waitFor({ timeout: 120000 });
  const secondTray = robot.getByRole("region", {
    name: "Tray orders · 2",
    exact: true,
  });
  await secondTray
    .getByRole("button", { name: "Transfer Completed", exact: true })
    .click();
  await secondTray.getByRole("button", { name: "Load", exact: true }).click();
  if (
    (await secondTray
      .getByRole("button", { name: "Load Completed", exact: true })
      .getAttribute("aria-expanded")) !== "true"
  )
    throw new Error("The prerequisite link did not open its recorded task.");
  await robot
    .getByRole("region", { name: "Tray orders · 2", exact: true })
    .getByRole("button", { name: "Unload Completed", exact: true })
    .click();
  await robot
    .locator('[data-task-id="tray-orders#1/unload"]')
    .getByRole("button", { name: "Inspect task", exact: true })
    .waitFor();
  await page.waitForFunction(robotFrameFits);
  if (await page.evaluate("document.documentElement.scrollWidth > innerWidth"))
    throw new Error("Operations activity overflows the mobile viewport.");
  await page.screenshot({ path: "operations-mobile.png", fullPage: true });
  const beforeScroll = await page.evaluate(positionRobotForScroll);
  const frameBounds = await page.locator(".ops-simulation").boundingBox();
  if (frameBounds === null) throw new Error("Robot preview is not visible.");
  await page.mouse.move(
    frameBounds.x + frameBounds.width / 2,
    frameBounds.y + 100,
  );
  await page.mouse.wheel(0, -350);
  await page.waitForFunction(outerPageScrolledUp, beforeScroll);
  await page.screenshot({ path: "operations-scroll.png" });
  return {
    result: "passed",
    commerce: "sample records through production component",
    approvalSeparateFromExecution: true,
    unknownOutcome: true,
    receiptRecovery: true,
    declinedProposal: true,
    keyboard: true,
    mobile: true,
    robotNominalRun: true,
    expandedRobotPanelFits: true,
    scrollOverRobotPanel: true,
    prerequisiteNavigation: true,
  };
}
