// Uses the real counter-sale route over the local commerce preview transport.
async function verifyCounterSaleReview(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-transaction-review";
  const consoleMessages = [];
  page.on("console", consoleMessages.push.bind(consoleMessages));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/commerce-preview.html?page=counter&sale=complete`);
  const sale = page.locator(".counter-sale");
  await sale
    .getByRole("heading", { name: "Counter sale", exact: true })
    .waitFor();
  const text = await sale.innerText();
  if (!text.includes("12.34") || text.includes("1,234")) {
    throw new Error(
      "The SGD sale does not show the correct major-unit amount.",
    );
  }
  const bounds = await sale.boundingBox();
  if (bounds === null || bounds.x < 0 || bounds.x + bounds.width > 320) {
    throw new Error("The sale panel extends outside the viewport.");
  }
  for (const button of await sale.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (
      box !== null &&
      (box.x < bounds.x || box.x + box.width > bounds.x + bounds.width)
    ) {
      throw new Error("A sale action extends outside its panel.");
    }
  }
  await page.screenshot({
    path: `${artifacts}/sale-complete-after.png`,
    fullPage: true,
  });
  const refund = sale.getByRole("button", {
    name: "Refund full amount",
    exact: true,
  });
  await refund.focus();
  await page.keyboard.press("Enter");
  const review = page.getByRole("dialog", {
    name: "Refund this payment?",
    exact: true,
  });
  await review.waitFor();
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Keep payment'",
  );
  await review.getByText(/12\.34/).waitFor();
  await page.screenshot({ path: `${artifacts}/refund-review.png` });
  await page.keyboard.press("Escape");
  await review.waitFor({ state: "detached" });
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Refund full amount'",
  );
  for (const message of consoleMessages) {
    if (message.text().startsWith("[preview] checkout mutate")) {
      throw new Error("Cancelling refund review submitted a transaction.");
    }
  }
  await refund.click();
  await review
    .getByRole("button", { name: "Refund full amount", exact: true })
    .click();
  await page
    .getByText("Mutations are disabled in this preview.", { exact: true })
    .waitFor();
  let mutations = 0;
  for (const message of consoleMessages) {
    if (message.text().startsWith("[preview] checkout mutate")) mutations += 1;
  }
  if (mutations !== 1)
    throw new Error("Refund confirmation did not submit exactly one command.");

  await page.evaluate(
    "window.print = localStorage.setItem.bind(localStorage, 'preview-print', 'requested')",
  );
  await sale
    .getByRole("button", { name: "Print receipt", exact: true })
    .click();
  await page.emulateMedia({ media: "print" });
  if (
    !(await page.evaluate(
      "getComputedStyle(document.querySelector('nav')).visibility === 'hidden' && getComputedStyle(document.querySelector('[data-counter-receipt]')).visibility === 'visible'",
    ))
  ) {
    throw new Error(
      "Receipt print styles include Portal navigation or hide the receipt.",
    );
  }
  await page.screenshot({
    path: `${artifacts}/receipt-print.png`,
    fullPage: true,
  });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate("window.dispatchEvent(new Event('afterprint'))");

  await page.goto(
    `${origin}/commerce-preview.html?page=counter&scenario=retry`,
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("button", { name: "Take payment", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${artifacts}/sale-read-recovered.png`,
    fullPage: true,
  });
  const states = [];
  for (const state of [
    "awaiting_collection",
    "collecting",
    "submission_unknown",
    "declined",
    "captured_unplaced",
    "expired",
  ]) {
    await page.goto(
      `${origin}/commerce-preview.html?page=counter&sale=${state}`,
    );
    await sale.waitFor();
    await page.screenshot({
      path: `${artifacts}/sale-${state}.png`,
      fullPage: true,
    });
    states.push(state);
  }
  for (const refundState of ["pending", "completed", "failed"]) {
    await page.goto(
      `${origin}/commerce-preview.html?page=counter&sale=complete&refund=${refundState}`,
    );
    await sale.waitFor();
    if (refundState === "pending") {
      await sale
        .getByRole("button", { name: "Reconcile refund", exact: true })
        .click();
      await page
        .locator("[data-sonner-toast]")
        .filter({
          hasText:
            "The refund is processing. Reconcile this refund to check its outcome.",
        })
        .waitFor();
      if (
        await page
          .getByText("The full payment was refunded.", { exact: true })
          .count()
      ) {
        throw new Error("A pending refund was reported as completed.");
      }
    }
    await page.screenshot({
      path: `${artifacts}/refund-${refundState}.png`,
      fullPage: true,
    });
  }
  await page.goto(
    `${origin}/commerce-preview.html?page=counter&sale=complete&role=viewer&currency=JPY`,
  );
  await sale.waitFor();
  if (
    (await sale
      .getByRole("button", { name: "Refund full amount", exact: true })
      .count()) !== 0
  ) {
    throw new Error("A read-only sale offers a refund command.");
  }
  await page.screenshot({
    path: `${artifacts}/sale-viewer-jpy.png`,
    fullPage: true,
  });
  return {
    status: "passed",
    states,
    refundConfirmation: "cancel sends no command; confirm sends one",
    currency: "SGD 12.34 from 1234 minor units",
    print: "receipt only",
    readRecovery: true,
    viewer: true,
  };
}
