async function verifyBakeryPlayback(page) {
  const origin = await page.evaluate("location.origin");
  await page.goto(`${origin}/workflow-preview.html`);
  await page.getByRole("button", { name: "Play shift", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const shiftTime = await page
    .getByRole("status", { name: "Simulated time" })
    .textContent();
  if (shiftTime === "06:00:00")
    throw new Error("Shift playback did not advance");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  if (
    (await page
      .getByRole("status", { name: "Simulated time" })
      .textContent()) !== "06:00:00"
  )
    throw new Error("Restart did not reset the shift");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  const nextEventTime = await page
    .getByRole("status", { name: "Simulated time" })
    .textContent();
  if (nextEventTime === "06:00:00")
    throw new Error("Next event did not advance");
  await page.screenshot({
    path: "output/playwright/plan-42e-shift-playback.png",
  });

  await openMultiBatchProduction(page);
  const production = page.getByRole("region", {
    name: "Multi-batch production",
    exact: true,
  });
  const cursor = production.getByRole("slider", { name: "Production time" });
  await production
    .getByRole("button", { name: "Play production", exact: true })
    .click();
  await page.waitForTimeout(400);
  await production.getByRole("button", { name: "Pause", exact: true }).focus();
  await production
    .getByRole("button", { name: "Pause", exact: true })
    .press("Space");
  const productionTime = Number(await cursor.inputValue());
  if (productionTime <= 0)
    throw new Error("Production playback did not advance");
  await page.waitForTimeout(250);
  if (Number(await cursor.inputValue()) !== productionTime)
    throw new Error("Production continued after pause");
  await cursor.focus();
  await cursor.press("End");
  const endTime = Number(await cursor.inputValue());
  if (endTime <= productionTime)
    throw new Error("Production seek did not advance");
  await production
    .getByRole("button", { name: "Play production", exact: true })
    .click();
  await page.waitForTimeout(200);
  await production.getByRole("button", { name: "Pause", exact: true }).focus();
  await production
    .getByRole("button", { name: "Pause", exact: true })
    .press("Space");
  const restartedTime = Number(await cursor.inputValue());
  if (restartedTime >= endTime)
    throw new Error("Play at the end did not restart production");
  await page.screenshot({
    path: "output/playwright/plan-42e-production-playback.png",
  });
  await production
    .getByRole("button", { name: "Play production", exact: true })
    .click();
  await production
    .getByRole("button", { name: "Back to examples", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to production", exact: true })
    .click();
  await page.getByRole("button", { name: "Play shift", exact: true }).waitFor();
  const returnedTime = await page
    .getByRole("status", { name: "Simulated time" })
    .textContent();
  await page.waitForTimeout(300);
  if (
    (await page
      .getByRole("status", { name: "Simulated time" })
      .textContent()) !== returnedTime
  )
    throw new Error("Production timer advanced the replacement shift");
  await openRecordingViewer(page);
  await page.getByRole("button", { name: /Table to rack/ }).click();
  await page.getByRole("button", { name: "Speed 1×", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "2×", exact: true }).click();
  await page.getByRole("button", { name: "Speed 2×", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const recordingCursor = page.getByRole("slider", {
    name: "Recording position",
  });
  const recordingTime = Number(await recordingCursor.inputValue());
  if (recordingTime <= 0) throw new Error("Recording playback did not advance");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  if (Number(await recordingCursor.inputValue()) <= recordingTime)
    throw new Error("Recording next event did not advance");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  if (Number(await recordingCursor.inputValue()) !== 0)
    throw new Error("Recording restart did not reset the cursor");
  await page.screenshot({
    path: "output/playwright/plan-42e-recording-playback.png",
  });
  // Multi-tray rehearsal plays on the production workspace's clock.
  await page
    .locator(".physics-replay")
    .getByRole("tab", { name: "Examples", exact: true })
    .click();
  await page.getByRole("button", { name: /^Multi-tray rehearsal/ }).click();
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Rehearsal prepared with two recorded trays." })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Play production", exact: true })
    .click();
  await page.waitForTimeout(300);
  // The two-tray run lasts under two seconds at 120×; a pointer click can
  // arrive after it ends, so pause with a direct click event.
  await page
    .getByRole("button", { name: "Pause", exact: true })
    .dispatchEvent("click");
  const trayCursor = page.getByRole("slider", { name: "Production time" });
  const trayTime = Number(await trayCursor.inputValue());
  if (trayTime <= 0) throw new Error("Multi-tray playback did not advance");
  await page.waitForTimeout(250);
  if (Number(await trayCursor.inputValue()) !== trayTime)
    throw new Error("Multi-tray playback continued after pause");
  await trayCursor.fill("0");
  if (Number(await trayCursor.inputValue()) !== 0)
    throw new Error("Multi-tray scrub did not reset the cursor");
  await page.screenshot({
    path: "output/playwright/plan-42e-tray-playback.png",
  });
  return {
    shiftTime,
    nextEventTime,
    productionTime,
    endTime,
    restartedTime,
    returnedTime,
    recordingTime,
    trayTime,
  };
}
