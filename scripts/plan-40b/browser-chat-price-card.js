async (page) => {
  // A price that the chat agent proposes shows as a card in the chat, with
  // one Approve and apply button (the owner, 2026-11-07: "the approval
  // prompts should either be in the LLM chat, 1 click to confirm"). The chat
  // preview (?scenario=commerce-action) answers the action's read, approval
  // and apply as the Worker does; pi-menu-board-price.test.ts proves those
  // routes and the before-and-after record.
  //
  // Part 2 checks the step-up sign-in in a small window (&stepup=1).
  //
  // Run: start `vite --port 3191` in apps/portal, then
  //   playwright_cli.sh -s=price-card open http://127.0.0.1:3191/chat-preview.html?scenario=commerce-action&conversation=conv_00000000-0000-0000-0000-000000000001
  //   playwright_cli.sh -s=price-card run-code --filename=scripts/plan-40b/browser-chat-price-card.js
  const PREVIEW = "http://127.0.0.1:3191/chat-preview.html?scenario=commerce-action&conversation=conv_00000000-0000-0000-0000-000000000001";
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const calls = () => page.evaluate(() => [...(window.satyrCommercePreviewCalls ?? [])]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PREVIEW);
  await page.locator("a[href$='/chat']").first().click();
  const card = page.getByRole("region", { name: "Change a menu price" });
  await card.waitFor({ timeout: 20_000 });
  const text = await card.innerText();
  check("the card shows the item, the price before and after", text.includes("Black sesame financier") && text.includes("¥300") && text.includes("¥280"), text);
  const button = card.getByRole("button", { name: "Approve and apply", exact: true });
  check("one button approves and applies", (await button.count()) === 1);
  const answer = await card.locator("xpath=ancestor::article[1]").innerText();
  check("the answer shows no link to another page", !answer.includes("commerceAction=") && !answer.includes("Approve the price change"), answer.slice(0, 400));
  check("the card offers Reject", (await card.getByRole("button", { name: "Reject", exact: true }).count()) === 1);
  await page.screenshot({ path: "output/playwright/plan-40b-price-card/01-proposed.png" });

  await button.click();
  await card.locator(".action-state-confirmed").waitFor({ timeout: 15_000 });
  const steps = await calls();
  check("one click approved and then applied the change", steps.includes("POST approval") && steps.includes("POST execute") &&
    steps.indexOf("POST approval") < steps.indexOf("POST execute"), steps);
  check("no decision button stays after the change is live", (await card.getByRole("button").count()) === 0);
  await page.screenshot({ path: "output/playwright/plan-40b-price-card/02-applied.png" });

  // 2. The step-up sign-in opens in a small window, and the chat page
  // stays. Google is out of reach here, so the window opens the return page
  // at once, as Google sends it there after the sign-in.
  await page.goto(`${PREVIEW}&stepup=1`);
  await page.locator("a[href$='/chat']").first().click();
  const again = page.getByRole("region", { name: "Change a menu price" });
  await again.waitFor({ timeout: 20_000 });
  const before = page.url();
  const opened = [];
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = (url, name, features) => {
      window.satyrOpened = [...(window.satyrOpened ?? []), String(url)];
      const nonce = new URL(String(url), window.location.origin).searchParams.get("action") ?? "";
      return open(`/approval-signed-in.html?action=${encodeURIComponent(nonce)}`, name, features);
    };
  });
  const popupEvent = page.waitForEvent("popup");
  await again.getByRole("button", { name: "Approve and apply", exact: true }).click();
  const popup = await popupEvent;
  await again.locator(".action-state-confirmed").waitFor({ timeout: 15_000 });
  opened.push(...await page.evaluate(() => window.satyrOpened ?? []));
  const stepUpCalls = await calls();
  check("the sign-in opened in a window, with the approval's purpose", opened.length === 1 && opened[0].includes("/v1/control/auth/google/start?purpose=approval"), opened);
  check("the chat page did not move", page.url() === before, page.url());
  check("the approval ran again after the sign-in, then the change applied", stepUpCalls.filter((step) => step === "POST approval").length >= 2 &&
    stepUpCalls.lastIndexOf("POST execute") > stepUpCalls.lastIndexOf("POST approval"), stepUpCalls);
  await popup.waitForEvent("close", { timeout: 5_000 }).catch(() => undefined);
  check("the sign-in window closed itself", popup.isClosed());
  await page.screenshot({ path: "output/playwright/plan-40b-price-card/03-after-popup.png" });
  return { result: "passed", checks, steps, stepUpCalls };
}
