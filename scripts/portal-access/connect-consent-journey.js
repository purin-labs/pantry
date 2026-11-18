async function connectConsentJourney(page) {
  const origin = new URL(page.url()).origin;
  // A provider with no card of its own explains the sign-in on a consent sheet.
  const consent = page.locator("dialog.connect-consent");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${origin}/integrations-preview.html?mode=route&integration=square&provider=square&scenario=empty`,
  );
  const connect = page.getByRole("button", {
    name: "Connect Square in a popup",
    exact: true,
  });
  await connect.waitFor();
  const windowsBefore = page.context().pages().length;
  await connect.click();
  await consent.waitFor();
  const points = await consent.locator("li strong").allTextContents();
  const windowsAtConsent = page.context().pages().length;
  await page.keyboard.press("Escape");
  await consent.waitFor({ state: "hidden" });
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Connect Square'",
  );
  const detailStillOpen = await page
    .getByRole("dialog", { name: "Square", exact: true })
    .isVisible();
  const focusReturned = await page.evaluate(
    "document.activeElement?.textContent === 'Connect Square'",
  );
  const windowsAfterCancel = page.context().pages().length;

  await connect.click();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(450);
  const bounds = await consent.boundingBox();
  const mobileFits = bounds !== null && bounds.x >= 0 && bounds.width <= 320;
  await page.screenshot({
    path: "output/playwright/portal-access/consent-mobile.png",
  });

  // Dropbox says the same on its card, so its button opens the provider.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${origin}/integrations-preview.html?mode=route&integration=dropbox&provider=dropbox&scenario=empty`,
  );
  const dropbox = page.getByRole("dialog", { name: "Dropbox", exact: true });
  await dropbox
    .getByText("You choose what to share", { exact: true })
    .waitFor();
  const [provider] = await Promise.all([
    page.waitForEvent("popup"),
    dropbox
      .getByRole("button", { name: "Continue with Dropbox", exact: true })
      .click(),
  ]);
  await provider.waitForURL(/popup=dropbox/u);
  const providerUrl = provider.url();
  const consentClosed = await consent.isHidden();
  await Promise.all([
    provider.waitForEvent("close"),
    provider.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  await page.waitForURL(
    "**/portal/nuki/cafe/access?setup=files&provider=dropbox",
  );
  const filesSetupDirected = true;

  // Gmail explains its access on the add-mailbox sheet, which opens by itself
  // while no mailbox exists. Its action opens the provider directly, so the
  // test checks that disclosure instead of a second sheet.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${origin}/integrations-preview.html?mode=route&integration=gmail&provider=gmail&scenario=empty`,
  );
  const email = page.getByRole("dialog", {
    name: "Add a mailbox",
    exact: true,
  });
  await email.getByText("Use a support address", { exact: true }).waitFor();
  const inlineDisclosure = await email
    .getByText("You stay in control", { exact: true })
    .isVisible();
  const [google] = await Promise.all([
    page.waitForEvent("popup"),
    email
      .getByRole("button", { name: "Continue with Google", exact: true })
      .click(),
  ]);
  await google.waitForURL(/popup=gmail/u);
  await Promise.all([
    google.waitForEvent("close"),
    google.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  await page.getByText("Gmail connected.", { exact: true }).waitFor();
  return {
    points,
    windowsBefore,
    windowsAtConsent,
    detailStillOpen,
    focusReturned,
    windowsAfterCancel,
    providerUrl,
    consentClosed,
    mobileFits,
    inlineDisclosure,
    gmailCompleted: true,
    filesSetupDirected,
  };
}
