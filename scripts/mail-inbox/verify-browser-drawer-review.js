// Run after mount-browser-fixture.js in the same Playwright CLI session.
// Three reply drafts wait. The person decides one in the two panes, follows the
// next draft, opens one from the page's address, and decides the rest as each
// next one opens. Screenshots go to output/playwright/mail-drawer-review-*.png;
// the result is the run's record.
async function verifyMailDrawerReview(page) {
  const inbox = page.getByRole("region", { name: "Mail inbox", exact: true });
  const needs = page.getByRole("list", {
    name: "Waiting for you",
    exact: true,
  });
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const caseTitle = conversation.locator("#mail-case-title");
  const bar = conversation.getByRole("group", {
    name: "Draft reply actions",
    exact: true,
  });
  async function rowNames() {
    return needs.locator(".mail-case-row-name").allInnerTexts();
  }
  async function expectTitle(title, why) {
    await caseTitle.getByText(title, { exact: true }).waitFor();
    await bar.waitFor();
    if (
      (await page.evaluate("document.activeElement.id")) !== "mail-case-title"
    )
      throw new Error(`${why}: the case title did not take focus`);
  }
  // The keyboard presses the button: the last toast may still cover it, and
  // a pointer over a toast keeps that toast open.
  async function decide(action) {
    await bar.getByRole("button", { name: action, exact: true }).focus();
    await page.keyboard.press("Enter");
  }
  function toast(text) {
    return page.locator("[data-sonner-toast]", { hasText: text });
  }
  await page.evaluate(function threeDrafts() {
    window.mailFixtureDrafts = "three";
    window.mailInboxRender({ key: "three-drafts" });
  });
  await needs.getByRole("button").nth(2).waitFor();
  // The person who waited longest comes first. The summary says how long.
  if (
    JSON.stringify(await rowNames()) !==
    '["Mika · Packaging supplier","Peita Lin","Ken · Café Mori"]'
  )
    throw new Error("The list is not ordered by the longest wait");
  await inbox
    .getByText(/^3 decisions need you\. The oldest has waited \d+ days\.$/)
    .waitFor();
  // A row opens its case in the drawer. The list stays in view and usable.
  const peitaRow = needs.getByRole("button", { name: /Peita Lin/ });
  await peitaRow.click();
  await expectTitle(
    "When will the 60 ginger financiers arrive?",
    "Opening a row",
  );
  const listBox = await needs.boundingBox();
  const drawerBox = await conversation.boundingBox();
  if (
    listBox === null ||
    drawerBox === null ||
    listBox.x + listBox.width > drawerBox.x ||
    drawerBox.x + drawerBox.width < 1270 ||
    (await peitaRow.getAttribute("aria-current")) !== "true" ||
    (await page.evaluate("location.search")) !==
      "?proposal=proposal_peita_reply"
  )
    throw new Error("The case did not open in a pane beside the list");
  // Plan 83: the list is a narrow pane, the conversation takes the rest, and
  // the reply box with its actions stands at the foot of the pane.
  const replyBar = await bar.boundingBox();
  if (
    listBox.width > 360 ||
    drawerBox.width < 600 ||
    replyBar === null ||
    replyBar.y + replyBar.height > 900 ||
    replyBar.y + replyBar.height < 840
  )
    throw new Error("The two panes or the reply box are not in place");
  await page.screenshot({
    path: "output/playwright/mail-drawer-review-drawer.png",
  });
  await page.evaluate(function dark() {
    document.documentElement.dataset.portalTheme = "dark";
  });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "output/playwright/mail-two-panes-dark.png",
  });
  await page.evaluate(function light() {
    document.documentElement.dataset.portalTheme = "light";
  });
  // A phone shows the conversation alone, with the actions in reach.
  await page.setViewportSize({ width: 390, height: 844 });
  await conversation.waitFor();
  await page.waitForTimeout(400);
  const phonePane = await conversation.boundingBox();
  const phoneBar = await bar.boundingBox();
  const phoneWidth = await page.evaluate(
    "document.documentElement.scrollWidth",
  );
  if (
    (await needs.isVisible()) ||
    phoneWidth !== 390 ||
    phonePane === null ||
    phonePane.x !== 0 ||
    phonePane.width !== 390 ||
    phoneBar === null ||
    phoneBar.y + phoneBar.height > 844
  )
    throw new Error(
      `A phone does not show the conversation alone: ${JSON.stringify({
        list: await needs.isVisible(),
        phoneWidth,
        phonePane,
        phoneBar,
      })}`,
    );
  await page.screenshot({
    path: "output/playwright/mail-two-panes-phone.png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Next and previous step through the list.
  await conversation
    .getByRole("button", { name: "Next conversation", exact: true })
    .click();
  await expectTitle("40 more croissants on Tuesday", "Next");
  await conversation
    .getByRole("button", { name: "Previous conversation", exact: true })
    .click();
  await expectTitle("When will the 60 ginger financiers arrive?", "Previous");
  // Escape in the case's menu closes the menu, not the case.
  await conversation
    .getByRole("button", { name: "Conversation options", exact: true })
    .click();
  const caseMenu = page.getByRole("menu", {
    name: "Conversation options",
    exact: true,
  });
  await caseMenu.waitFor();
  await page.keyboard.press("Escape");
  await caseMenu.waitFor({ state: "detached" });
  if ((await conversation.count()) !== 1)
    throw new Error("Escape in the case's menu closed the case");
  // Approve and send: a toast confirms it without an undo, since a sent
  // email cannot be taken back, and the next draft in the list opens.
  await decide("Approve and send");
  await toast("Reply sent to Peita Lin.").waitFor();
  await expectTitle("40 more croissants on Tuesday", "After an approval");
  if (
    (await toast("Reply sent to Peita Lin.")
      .getByRole("button", { name: "Undo" })
      .count()) !== 0
  )
    throw new Error("A sent reply offered an undo");
  if (
    JSON.stringify(await rowNames()) !==
      '["Mika · Packaging supplier","Ken · Café Mori"]' ||
    (await page.evaluate("location.search")) !== "?proposal=proposal_mori_reply"
  )
    throw new Error("The approved draft stayed in the list or the address");
  await inbox.getByText(/^2 decisions need you\./).waitFor();
  const approval = (await page.evaluate("window.mailReviewCommands")).find(
    function isApproval(command) {
      return (
        command.action === "approve" &&
        command.proposalId === "proposal_peita_reply"
      );
    },
  );
  if (
    approval === undefined ||
    JSON.stringify(approval.body) !==
      JSON.stringify({
        version: 1,
        snapshotDigest: "e".repeat(64),
        challenge: "review-fixture-challenge",
      })
  )
    throw new Error("The approval did not name the exact reviewed version");
  // Escape closes the drawer, and focus returns to the row.
  await page.keyboard.press("Escape");
  await conversation.waitFor({ state: "detached" });
  if (
    (await page.evaluate("document.activeElement.dataset.threadId")) !==
      "thread-6" ||
    (await page.evaluate("location.search")) !== ""
  )
    throw new Error("Escape did not return to the row that was open");
  // The next conversation opens after each decision, so the person works down
  // the list without a separate review mode.
  await needs.getByRole("button", { name: /Ken · Café Mori/ }).click();
  await expectTitle("40 more croissants on Tuesday", "Opening Ken's draft");
  await decide("Reject");
  await toast("Draft for Ken · Café Mori rejected.").waitFor();
  await expectTitle(
    "Packaging delivery delayed — Friday arrival",
    "After a rejection",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 375)
    throw new Error("The conversation overflows a phone");
  await page.screenshot({
    path: "output/playwright/mail-drawer-review-step-mobile.png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await decide("Reject");
  await toast("Draft for Mika · Packaging supplier rejected.").waitFor();
  await inbox
    .locator(".mail-case-empty")
    .getByText("Nothing waits for you.", { exact: true })
    .waitFor();
  if ((await conversation.count()) !== 0)
    throw new Error("The last decision left a conversation open");
  // Done lists each decided draft with what became of it.
  await page
    .getByRole("group", { name: "Other views", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const handled = await page
    .getByRole("list", { name: "Email replies that are done", exact: true })
    .locator(".mail-case-row-line")
    .allInnerTexts();
  if (
    JSON.stringify([...handled].sort()) !==
    JSON.stringify([
      "Ken · Café Mori · Rejected",
      "Mika · Packaging supplier · Rejected",
      "Peita Lin · Sent",
    ])
  )
    throw new Error(`Done does not list the decisions: ${handled}`);
  await page.screenshot({
    path: "output/playwright/mail-drawer-review-handled.png",
    fullPage: true,
  });
  // The page's address opens the draft that it names, also on a new page.
  await page.evaluate(function openFromAddress() {
    window.mailExtraStates = {
      ...window.mailExtraStates,
      proposal_mori_reply: "awaiting_approval",
    };
    window.history.replaceState(null, "", "?proposal=proposal_mori_reply");
    window.mailInboxRender({ key: "from-address" });
  });
  await expectTitle(
    "40 more croissants on Tuesday",
    "Opening from the address",
  );
  if (
    (await needs
      .getByRole("button", { name: /Ken · Café Mori/ })
      .getAttribute("aria-current")) !== "true"
  )
    throw new Error("The address opened a draft that the list does not mark");
  const commands = (await page.evaluate("window.mailReviewCommands")).map(
    function decision(command) {
      return `${command.action}:${command.proposalId ?? "proposal_supplier_reply"}`;
    },
  );
  if (
    JSON.stringify(commands) !==
    '["approve:proposal_peita_reply","reject:proposal_mori_reply","reject:proposal_supplier_reply"]'
  )
    throw new Error(`The review sent other decisions: ${commands}`);
  console.log(
    "MAIL_DRAWER_REVIEW_BROWSER: three drafts by longest wait; a row opens its conversation in a pane beside the usable list and in the address; next and previous; approve and send with a toast and no undo opens the next draft; Escape returns to the row; the address opens a draft; each decision opens the next one; Handled lists each decided draft; 375px without overflow",
  );
  return {
    artifact: "MAIL_DRAWER_REVIEW_BROWSER",
    passed: true,
    decisions: commands,
    handled: [...handled].sort(),
    screenshots: [
      "output/playwright/mail-drawer-review-drawer.png",
      "output/playwright/mail-two-panes-dark.png",
      "output/playwright/mail-two-panes-phone.png",
      "output/playwright/mail-drawer-review-step-mobile.png",
      "output/playwright/mail-drawer-review-handled.png",
    ],
  };
}
