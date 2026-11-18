// Run with portal-mail-reply-room.mjs installed, after mount-browser-fixture.js.
async function verifyMailWork(page) {
  // A tall window shows a whole case with the action bar at its end.
  async function captureConversation(path) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: size.width, height: 2600 });
    await page.screenshot({ path, fullPage: true });
    await page.setViewportSize(size);
  }
  async function chooseMenuItem(name) {
    await page
      .getByRole("button", { name: "Inbox options", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  // The form value of a Portal Select. Base UI keeps it in a hidden input that
  // it renders after the Select's parts.
  function selectValue(trigger) {
    return trigger.evaluate(function hiddenSelectValue(button) {
      for (let node = button; node !== null; node = node.parentElement) {
        for (
          let next = node.nextElementSibling;
          next !== null;
          next = next.nextElementSibling
        ) {
          if (
            next instanceof HTMLInputElement &&
            next.getAttribute("aria-hidden") === "true"
          )
            return next.value;
        }
      }
      throw new Error("A Portal Select has no hidden input.");
    });
  }

  // The items of a Portal Select, read from its open popup, which Escape then
  // closes.
  async function selectItems(page, trigger) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = await popup
      .locator('.pantry-select-item')
      .evaluateAll(function readSelectItems(nodes) {
        return nodes.map(function readSelectItem(node) {
          return {
            value: node.getAttribute("data-value"),
            label: node.textContent.replace(/\s+/g, " ").trim(),
            disabled: node.hasAttribute("data-disabled"),
            selected: node.getAttribute("aria-selected") === "true",
          };
        });
      });
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    return items;
  }

  // The conversation's work reads again from its own menu.
  async function refreshConversation() {
    await page
      .getByRole("button", { name: "Conversation options", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Refresh conversation", exact: true })
      .click();
  }
  async function refresh() {
    await status.click();
    await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
  }
  const inbox = page.getByRole("region", { name: "Mail inbox", exact: true });
  const views = page.getByRole("group", { name: "Other views", exact: true });
  const status = page.getByRole("button", { name: /^Mailbox: / });
  const needs = page.getByRole("list", {
    name: "Waiting for you",
    exact: true,
  });
  const other = page.getByRole("list", { name: "Other mail", exact: true });
  const messages = page.getByRole("list", {
    name: "Email messages",
    exact: true,
  });
  const row = needs.getByRole("button", { name: /Packaging delivery delayed/ });
  await row.waitFor();
  // A thread that waits shows once: above, not again in Other mail. The
  // page's only mail waits, so Other mail is empty.
  await inbox
    .getByRole("region", { name: /^Other mail/ })
    .getByText("No other mail.", { exact: true })
    .waitFor();
  if ((await other.count()) !== 0)
    throw new Error("A waiting thread shows twice");
  await inbox
    .getByText(/^1 decision needs you\. It has waited \d+ days\.$/)
    .waitFor();
  // One list in sections: no tabs, no chips, and search is always there.
  if (
    (await inbox.getByRole("heading", { level: 2 }).allInnerTexts())
      .map((text) => text.replace(/\s*\d+$/u, ""))
      .join("|") !== "Waiting for you|Other mail" ||
    (await messages.count()) !== 0 ||
    (await inbox.getByText("Draft reply waits").count()) !== 0 ||
    (await page.getByRole("combobox", { name: "Mailbox" }).count()) !== 0 ||
    (await page.getByRole("searchbox", { name: "Search mail" }).count()) !== 1
  )
    throw new Error("The Inbox does not show one list in sections");
  // The queue names the sender and the subject. The row says how long the
  // mail waited and what kind of decision it is.
  const rowText = await row.innerText();
  if (
    !rowText.includes("Mika · Packaging supplier") ||
    !rowText.includes("Packaging delivery delayed — Friday arrival") ||
    !rowText.includes("Reply") ||
    !/\d+ days/.test(rowText) ||
    (await row.locator("time").count()) !== 1
  )
    throw new Error("A waiting row lacks its sender, subject, wait or kind");
  const agent = page.getByRole("group", {
    name: "Mailbox agent",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Mailbox: Purchasing · CafeOS. Agent on" })
    .waitFor();
  if ((await agent.count()) !== 0)
    throw new Error("A working agent shows more than its status");
  await page.screenshot({
    path: "output/playwright/mail-polish-inbox-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 320)
    throw new Error("The Inbox overflows at 320px");
  await page.screenshot({
    path: "output/playwright/mail-polish-inbox-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // All mail is a view of the mailbox, from the options menu.
  await chooseMenuItem("All mail");
  const allMailHeading = page.getByRole("heading", {
    name: "All mail",
    exact: true,
  });
  await allMailHeading.waitFor();
  if (
    (await page.evaluate("document.activeElement.textContent")) !== "All mail"
  )
    throw new Error("All mail did not take focus at its heading");
  const mailRow = messages.getByRole("button", {
    name: /Packaging delivery delayed/,
  });
  await mailRow.waitFor();
  await mailRow.getByText("Reply waits", { exact: true }).waitFor();
  // A screen reader still gets the word, from text that takes no space.
  const unread = await mailRow
    .getByText("Unread:", { exact: true })
    .boundingBox();
  if (
    /Unclassified|No current classification/.test(await mailRow.innerText()) ||
    (await mailRow.getByText("Unread", { exact: true }).count()) !== 0 ||
    unread === null ||
    unread.width > 1
  )
    throw new Error("A mail row prints an Unread or Unclassified tag");
  if (
    Number(
      await mailRow.locator(".mail-inbox-subject").evaluate(function weight(e) {
        return getComputedStyle(e).fontWeight;
      }),
    ) < 600
  )
    throw new Error("Unread mail does not show in heavier text");
  if (
    (await page
      .getByRole("group", { name: "Inbox views", exact: true })
      .count()) !== 0
  )
    throw new Error("Category views show without a rule");
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: "output/playwright/mail-polish-all-mail-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close this view", exact: true })
    .click();
  await row.waitFor();
  await page.evaluate("window.mailAgentFixture = 'paused'");
  await refresh();
  await agent
    .getByText("Paused: 5 Cases are open and the limit is 5.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Mailbox: Purchasing · CafeOS. Agent paused",
    })
    .waitFor();
  await agent
    .getByRole("button", { name: "Resume processing", exact: true })
    .click();
  await agent.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Mailbox: Purchasing · CafeOS. Agent on" })
    .waitFor();
  if (
    !(await page.evaluate(
      "document.activeElement.getAttribute('aria-label')?.startsWith('Mailbox: ')",
    ))
  )
    throw new Error("Resuming did not move focus to the mailbox status");
  if (
    JSON.stringify(await page.evaluate("window.mailAgentCommands")) !==
    '["resume"]'
  )
    throw new Error("Resume did not use the mailbox resume route once");
  await page.evaluate("window.mailAgentFixture = 'off'");
  await refresh();
  await agent.getByText("Agent off", { exact: true }).waitFor();
  // The mailbox's settings are a page of the Inbox, in the browser's
  // history: its back link and the browser's Back both return to the list.
  // An agent that is off is one short line; its settings are in the menu.
  if ((await agent.getByRole("link").count()) !== 0)
    throw new Error("The agent off line shows a settings link");
  await status.click();
  await page
    .getByRole("menuitem", { name: "Mailbox settings", exact: true })
    .click();
  const settings = page.getByRole("region", { name: "Mailbox settings" });
  await settings.getByRole("heading", { name: "mailbox-a" }).waitFor();
  if (
    new URL(page.url()).searchParams.get("settings") !== "mailbox-a" ||
    (await page.getByRole("region", { name: "Mail inbox" }).count()) !== 0
  )
    throw new Error("Mailbox settings did not open as a page of the Inbox");
  await settings.getByRole("link", { name: "Inbox", exact: true }).click();
  await agent.getByText("Agent off", { exact: true }).waitFor();
  await page.goBack();
  await settings.waitFor();
  await page.goBack();
  await agent.getByText("Agent off", { exact: true }).waitFor();
  if ((await settings.count()) !== 0)
    throw new Error("Back did not leave the mailbox settings page");
  // The Inbox turns the mailbox on in a sheet, without leaving the page.
  await agent.getByRole("button", { name: "Turn on", exact: true }).click();
  const sheet = page.getByRole("dialog", {
    name: "purchasing@cafeos.example",
    exact: true,
  });
  await sheet
    .getByText("Approved for email content.", { exact: true })
    .waitFor();
  await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Mailbox: Purchasing · CafeOS. Agent on" })
    .waitFor();
  if (
    !(await page.evaluate(
      "document.activeElement.getAttribute('aria-label')?.startsWith('Mailbox: ')",
    )) ||
    !(await page.evaluate("window.mailAgentCommands")).includes("policy")
  )
    throw new Error("The Inbox sheet did not turn the mailbox on");
  // Refresh asks Gmail for new mail while the agent is on, for a push that is
  // late or that never comes, and says when the agent reads it.
  // The check and the rules read show in the header's fixed busy slot, so
  // that the list does not move. A wide screen keeps the email column.
  await page.setViewportSize({ width: 1440, height: 900 });
  const listTop = () =>
    page
      .getByRole("search")
      .evaluate((node) => Math.round(node.getBoundingClientRect().top));
  const topBefore = await listTop();
  const checksBefore = (await page.evaluate("window.mailChecks")) ?? 0;
  await refresh();
  await page.getByText(/^Reads new mail at /).waitFor();
  if ((await page.evaluate("window.mailChecks")) !== checksBefore + 1)
    throw new Error("Refresh did not check the mailbox once");
  if (
    (await listTop()) !== topBefore ||
    (await page.locator(".mail-busy[title^='Reads new mail at ']").count()) !==
      1
  )
    throw new Error("Refresh moved the list or showed no busy mark");
  await page.setViewportSize({ width: 1280, height: 900 });
  // Spam is listed only: no agent reads it, and a row opens the thread in the
  // mailbox's own Gmail, where the person can mark it as not spam.
  const spamReadsBefore = (await page.evaluate("window.mailSpamReads")) ?? 0;
  await chooseMenuItem("Spam");
  const spamRow = page.getByRole("link", {
    name: /^Unread: Ana Ruiz Order for 40 gift boxes .*, opens in Gmail$/,
  });
  await spamRow.waitFor();
  await page
    .getByText("1 message in Spam on this page", { exact: true })
    .waitFor();
  if (
    (await spamRow.getAttribute("href")) !==
      "https://mail.google.com/mail/?authuser=purchasing%40cafeos.example#spam/18f2a9c0d1e2f3a4" ||
    (await spamRow.getAttribute("target")) !== "_blank" ||
    (await spamRow.getAttribute("rel")) !== "noreferrer"
  )
    throw new Error(
      "A Spam row does not open its thread in this mailbox's Gmail",
    );
  if (
    (await page.getByRole("heading", { name: "Spam", exact: true }).count()) !==
      1 ||
    (await page.getByText("Reply waits", { exact: true }).count()) !== 0
  )
    throw new Error("Spam is not the view shown, or it shows agent work");
  await page.screenshot({
    path: "output/playwright/mail-spam-desktop.png",
    fullPage: true,
  });
  await refresh();
  await spamRow.waitFor();
  if ((await page.evaluate("window.mailSpamReads")) !== spamReadsBefore + 2)
    throw new Error("Spam was not read once when opened and once on Refresh");
  // Done, All mail and Spam are views below the sections.
  await page
    .getByRole("button", { name: "Close this view", exact: true })
    .click();
  await views.getByRole("button", { name: "All mail", exact: true }).waitFor();
  await views.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByText("No reply drafts were decided yet.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await row.waitFor();
  await page.evaluate("window.mailAgentFixture = 'off'");
  await refresh();
  await agent.getByText("Agent off", { exact: true }).waitFor();
  await page.evaluate("window.mailAgentFixture = 'unreadable'");
  await refresh();
  await agent.waitFor({ state: "detached" });
  await row.waitFor();
  if (
    (await page.getByRole("alert").count()) !== 0 ||
    (await page
      .getByRole("button", { name: "Mailbox: Purchasing · CafeOS" })
      .count()) !== 1
  )
    throw new Error("An unreadable agent state showed an error or a state");
  // While the agent state is unknown, Refresh still asks Gmail for new mail.
  const checksUnknown = await page.evaluate("window.mailChecks");
  await page.evaluate("window.mailAgentFixture = undefined");
  await refresh();
  await page
    .getByRole("button", { name: "Mailbox: Purchasing · CafeOS. Agent on" })
    .waitFor();
  if ((await page.evaluate("window.mailChecks")) !== checksUnknown + 1)
    throw new Error(
      "Refresh skipped the check while the agent state was unknown",
    );
  // A row opens its case in a drawer beside the list.
  await row.click();
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const draft = conversation.getByRole("region", {
    name: "Suggested reply",
    exact: true,
  });
  await draft.waitFor();
  // The subject heads the case and takes focus. The list stays usable.
  if (
    (await page.evaluate("document.activeElement.textContent")) !==
      "Packaging delivery delayed — Friday arrival" ||
    !(await row.isVisible()) ||
    (await row.getAttribute("aria-current")) !== "true" ||
    !(await page.evaluate(
      "location.search === '?proposal=proposal_supplier_reply'",
    ))
  )
    throw new Error("The case did not open beside the list, in the address");
  await draft.getByText("To mika@packaging.example", { exact: true }).waitFor();
  await draft.getByText("You edited this draft.", { exact: true }).waitFor();
  if (
    (await conversation.getByText(/Please confirm Friday arrival/).count()) !==
      1 ||
    (await draft.getByText(/Please confirm Friday arrival/).count()) !== 1 ||
    (await conversation.getByRole("article").count()) !== 1 ||
    (await conversation.getByText(/^From this mailbox/).count()) !== 0
  )
    throw new Error("The Gmail draft shows as a message of the thread");
  const acknowledgement = conversation.locator("p.mail-inbox-own").filter({
    hasText: "Automatic acknowledgement sent",
  });
  const acknowledgementText = conversation.getByText(
    /^Thanks for your email\. We've received your message/,
  );
  await acknowledgement.waitFor();
  if (
    (await acknowledgement.locator("time").count()) !== 1 ||
    (await acknowledgementText.isVisible())
  )
    throw new Error("The acknowledgement is not one line with its time");
  await page.screenshot({
    path: "output/playwright/mail-polish-conversation-desktop.png",
  });
  const bar = conversation.getByRole("group", {
    name: "Draft reply actions",
    exact: true,
  });
  if (
    JSON.stringify(await bar.getByRole("button").allInnerTexts()) !==
    '["Approve and send","Edit","Reject"]'
  )
    throw new Error("The action bar does not hold exactly three actions");
  // A short window leaves little room. The bar holds to the reply box's lower
  // edge, at the foot of the pane.
  await page.setViewportSize({ width: 1280, height: 520 });
  const held = await bar.boundingBox();
  if (
    held === null ||
    Math.abs(held.y + held.height - 520) > 36 ||
    (await bar.evaluate(function position(element) {
      return getComputedStyle(element.parentElement).position;
    })) !== "sticky"
  )
    throw new Error("The action bar does not hold to the pane's lower edge");
  await page.setViewportSize({ width: 1280, height: 900 });
  // On a wide window the console's tools share the drawer's top row: one
  // row, and no control covers another.
  const close = conversation.getByRole("button", {
    name: "Close conversation",
    exact: true,
  });
  const closeBox = await close.boundingBox();
  const searchBox = await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .boundingBox();
  if (
    closeBox === null ||
    searchBox === null ||
    Math.abs(
      closeBox.y + closeBox.height / 2 - (searchBox.y + searchBox.height / 2),
    ) > 4 ||
    closeBox.x + closeBox.width > searchBox.x
  )
    throw new Error("The drawer's tools and the console's tools overlap");
  // The conversation's details, sources, correction and activity show flat.
  if ((await conversation.locator("details").count()) !== 0)
    throw new Error("The conversation still has a fold");
  const checked = conversation.getByRole("region", {
    name: "Conversation details",
    exact: true,
  });
  const details = conversation;
  const correct = details.getByRole("button", {
    name: "Correct purchasing link",
    exact: true,
  });
  for (const text of ["Waiting for approval", "Open in Gmail"]) {
    const shown = checked.getByText(text, { exact: true });
    if ((await shown.count()) !== 1 || !(await shown.isVisible()))
      throw new Error(`The conversation details do not show "${text}"`);
  }
  for (const text of [
    "Packaging orders need two working days of notice.",
    "Correct purchasing link",
    "Activity and receipts",
    "Assignments",
    "Failed",
  ]) {
    const inside = conversation.getByText(text, { exact: true });
    if ((await inside.count()) !== 1 || !(await inside.isVisible()))
      throw new Error(`The conversation does not show "${text}"`);
  }
  for (const text of [
    "Details",
    "Back to inbox",
    "Draft reply · not sent",
    "Review email",
  ])
    if ((await page.getByText(text, { exact: true }).count()) !== 0)
      throw new Error(`The conversation still shows "${text}"`);
  await details.getByText("Failed", { exact: true }).waitFor();
  await details
    .getByText("Packaging orders need two working days of notice.", {
      exact: true,
    })
    .waitFor();
  await details
    .getByTitle("Gmail receipt gmail_confirmed_prior_reply", { exact: true })
    .waitFor();
  await checked
    .getByText("Re: Packaging delivery delayed — Friday arrival", {
      exact: true,
    })
    .waitFor();
  await captureConversation(
    "output/playwright/mail-polish-details-desktop.png",
  );
  // The sender of the conversation can be linked to a supplier, so that a
  // correction of a reply to new mail from the sender teaches Memory.
  const senderSupplier = checked.getByRole("region", {
    name: "Supplier",
    exact: true,
  });
  const senderSupplierState = senderSupplier.locator(
    ".mail-sender-supplier-state",
  );
  await senderSupplier
    .getByText("Not linked to a supplier.", { exact: true })
    .waitFor();
  if (
    JSON.stringify(await page.evaluate("window.mailSenderLinkReads")) !==
      '["orders@packaging.example"]' ||
    (await page.evaluate("window.mailSupplierReads")) !== undefined
  )
    throw new Error(
      "The link was not read once for the sender, or suppliers were read early",
    );
  await senderSupplier
    .getByRole("button", { name: "Link sender to a supplier", exact: true })
    .click();
  const senderSupplierChoice = senderSupplier.getByRole("combobox", {
    name: "Supplier",
    exact: true,
  });
  await senderSupplierChoice.waitFor();
  if (
    !(await senderSupplierChoice.evaluate(function focused(element) {
      return document.activeElement === element;
    })) ||
    JSON.stringify(
      (await selectItems(page, senderSupplierChoice)).map(
        function label(item) {
          return item.label;
        },
      ),
    ) !== '["Hokkaido Flour Mill","Packaging supplier"]'
  )
    throw new Error("The supplier choice did not list the suppliers in focus");
  await senderSupplier
    .getByText("New mail from orders@packaging.example uses the link.", {
      exact: true,
    })
    .waitFor();
  await chooseOption(page, senderSupplierChoice, {
    value: "supplier_packaging",
  });
  await senderSupplier
    .getByRole("button", { name: "Link sender", exact: true })
    .click();
  await senderSupplier
    .getByText("New mail from this address uses the link.", { exact: true })
    .waitFor();
  const senderSupplierLink = senderSupplier.getByRole("link", {
    name: "Packaging supplier",
    exact: true,
  });
  if (
    (await senderSupplierState.innerText()) !==
      "Linked to Packaging supplier." ||
    (await senderSupplierLink.getAttribute("href")) !==
      "/suppliers/supplier_packaging" ||
    (await page.evaluate("document.activeElement.className")) !==
      "mail-sender-supplier-state" ||
    (await senderSupplierChoice.count()) !== 0
  )
    throw new Error("A saved link did not show its supplier in focus");
  const senderLinkCommand = (
    await page.evaluate("window.mailSenderLinkCommands")
  )[0];
  if (
    JSON.stringify(senderLinkCommand) !==
    '{"address":"orders@packaging.example","supplierId":"supplier_packaging","expectedRevision":0}'
  )
    throw new Error("The link did not name the sender, supplier and revision");
  if (
    Number(
      await senderSupplierLink.evaluate(function weight(element) {
        return getComputedStyle(element).fontWeight;
      }),
    ) > 500
  )
    throw new Error("The linked supplier shows in heavy text");
  await captureConversation(
    "output/playwright/mail-sender-supplier-desktop.png",
  );
  // A change that another session made first is refused, and the choice
  // stays open with the person's selection.
  await senderSupplier
    .getByRole("button", { name: "Change supplier", exact: true })
    .click();
  await senderSupplierChoice.waitFor();
  if ((await selectValue(senderSupplierChoice)) !== "supplier_packaging")
    throw new Error("The choice did not start at the linked supplier");
  await page.evaluate(
    "window.mailSenderLink = { ...window.mailSenderLink, revision: 2 }",
  );
  await chooseOption(page, senderSupplierChoice, { value: "supplier_flour" });
  await senderSupplier
    .getByRole("button", { name: "Link sender", exact: true })
    .click();
  await senderSupplier
    .getByRole("alert")
    .getByText(
      "The supplier link changed in another session. Refresh and try again.",
      { exact: true },
    )
    .waitFor();
  if (
    (await selectValue(senderSupplierChoice)) !== "supplier_flour" ||
    (await senderSupplierState.innerText()) !== "Linked to Packaging supplier."
  )
    throw new Error("A refused change lost the choice or changed the link");
  await senderSupplier
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 800 });
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 320)
    throw new Error("The supplier link overflows at 320px");
  await page.setViewportSize({ width: 1280, height: 900 });
  // With no supplier, the choice says so and links to the Suppliers page.
  await page.evaluate("window.mailNoSuppliers = true");
  await senderSupplier
    .getByRole("button", { name: "Change supplier", exact: true })
    .click();
  await senderSupplier.getByText(/^No suppliers exist yet\./).waitFor();
  if (
    (await senderSupplier
      .getByRole("link", { name: "Add a supplier", exact: true })
      .getAttribute("href")) !== "/suppliers" ||
    (await senderSupplierChoice.count()) !== 0
  )
    throw new Error("No supplier did not link to the Suppliers page");
  await page.evaluate("window.mailNoSuppliers = false");
  // Without purchasing there is no supplier directory: the row says so.
  await senderSupplier
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.evaluate("window.mailPurchasingOff = true");
  await senderSupplier
    .getByRole("button", { name: "Change supplier", exact: true })
    .click();
  await senderSupplier
    .getByText(/^Suppliers come from purchasing, which is not set up yet\./)
    .waitFor();
  if (
    (await senderSupplier
      .getByRole("link", { name: "Set up purchasing", exact: true })
      .getAttribute("href")) !== "/suppliers" ||
    (await senderSupplier.getByRole("alert").count()) !== 0
  )
    throw new Error("A workspace without purchasing showed an error");
  await page.evaluate("window.mailPurchasingOff = false");
  await senderSupplier
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await senderSupplier
    .getByRole("button", { name: "Change supplier", exact: true })
    .waitFor();
  await bar.getByRole("button", { name: "Edit", exact: true }).focus();
  await page.keyboard.press("Enter");
  const editor = draft.getByRole("textbox", {
    name: "Reply message",
    exact: true,
  });
  if (
    !(await editor.evaluate(function focused(element) {
      return document.activeElement === element;
    }))
  )
    throw new Error("Reply editor did not receive keyboard focus");
  if (
    JSON.stringify(await bar.getByRole("button").allInnerTexts()) !==
    '["Save draft","Close"]'
  )
    throw new Error("An unsaved edit retained approval");
  // Escape in the editor does not close the drawer.
  await page.keyboard.press("Escape");
  if ((await editor.count()) !== 1)
    throw new Error("Escape in the editor closed the case");
  await editor.fill("Unsaved private reply");
  await draft
    .locator('.mail-reply-draft-status [data-state="synced"]')
    .waitFor();
  await bar.getByRole("button", { name: "Close", exact: true }).click();
  if (
    (await page.evaluate("document.activeElement.textContent")) !== "Edit" ||
    (await editor.count()) !== 0 ||
    (await draft.getByText(/Please confirm Friday arrival/).count()) !== 1
  )
    throw new Error("Close did not restore the Gmail preview and Edit focus");
  await bar.getByRole("button", { name: "Edit", exact: true }).click();
  await draft
    .locator('.mail-reply-draft-status [data-state="synced"]')
    .waitFor();
  if ((await editor.inputValue()) !== "Unsaved private reply")
    throw new Error("Closing the editor lost the shared draft.");
  await editor.fill("Unsaved private reply");
  await draft
    .locator('.mail-reply-draft-status [data-state="synced"]')
    .waitFor();
  await refreshConversation();
  await draft.getByText(/Please confirm Friday arrival/).waitFor();
  if ((await editor.count()) !== 0)
    throw new Error("Refresh retained an unsaved body");
  await bar.getByRole("button", { name: "Edit", exact: true }).click();
  await editor.fill("Saved Inbox reply: please confirm the revised arrival.");
  await draft
    .locator('.mail-reply-draft-status [data-state="synced"]')
    .waitFor();
  await bar.getByRole("button", { name: "Save draft", exact: true }).click();
  await draft
    .getByText("Saved Inbox reply: please confirm the revised arrival.", {
      exact: true,
    })
    .waitFor();
  if (
    (await page.evaluate("document.activeElement.textContent")) !==
    "Suggested reply"
  )
    throw new Error("A saved draft did not receive focus");
  if (
    (await conversation.getByText(/Saved Inbox reply/).count()) !== 1 ||
    (await conversation.getByText(/Please confirm Friday arrival/).count()) !==
      0
  )
    throw new Error("A saved draft shows beside its old or new Gmail message");
  // A saved edit is not a decision: the draft still waits in the list.
  if (!(await row.isVisible()))
    throw new Error("A saved edit removed the draft from the list");
  const saved = (await page.evaluate("window.mailReviewCommands"))[0];
  if (saved.action !== "draft-save" || Object.keys(saved.body).length !== 0)
    throw new Error("Save did not use the shared-draft endpoint");
  // A correction that cannot open leaves the draft and its actions in place.
  await page.evaluate("window.mailCorrectionUnavailable = true");
  await correct.click();
  await details
    .getByRole("alert")
    .getByText(/^Purchasing correction is unavailable\./)
    .waitFor();
  if (
    (await draft.getByText(/Saved Inbox reply/).count()) !== 1 ||
    JSON.stringify(await bar.getByRole("button").allInnerTexts()) !==
      '["Approve and send","Edit","Reject"]'
  )
    throw new Error("A failed correction replaced the draft or its actions");
  await captureConversation(
    "output/playwright/mail-correction-unavailable-desktop.png",
  );
  await details
    .getByRole("button", { name: "Close correction", exact: true })
    .click();
  await page.evaluate("window.mailCorrectionUnavailable = false");
  await correct.click();
  const supplier = details.getByRole("combobox", {
    name: "Supplier record",
    exact: true,
  });
  await supplier.waitFor();
  if (
    !(await supplier.evaluate(function focused(element) {
      return document.activeElement === element;
    }))
  )
    throw new Error("Supplier selection did not receive focus");
  // Focus scrolled to the correction. The actions stay in view beside it.
  const beside = await bar.boundingBox();
  const focused = await supplier.boundingBox();
  if (
    (await draft.getByText(/Saved Inbox reply/).count()) !== 1 ||
    JSON.stringify(await bar.getByRole("button").allInnerTexts()) !==
      '["Approve and send","Edit","Reject"]' ||
    beside === null ||
    focused === null ||
    beside.y < 0 ||
    beside.y + beside.height > 900 ||
    focused.y + focused.height > beside.y
  )
    throw new Error("Purchasing correction replaced the draft or its actions");
  await details
    .getByRole("textbox", { name: "Purchase request reference", exact: true })
    .fill("PR-A");
  await details
    .getByRole("button", { name: "Preview purchasing link", exact: true })
    .click();
  await details
    .getByRole("heading", { name: "Current purchasing evidence", exact: true })
    .waitFor();
  const supplierLink = details
    .locator(".mail-relationship-correction")
    .getByRole("link", {
      name: "Packaging supplier",
      exact: true,
    });
  if (
    (await supplierLink.getAttribute("href")) !==
    "/suppliers/supplier_packaging"
  )
    throw new Error("Correction does not link to the canonical supplier");
  await details
    .getByRole("textbox", { name: "Replacement reply", exact: true })
    .fill("Unsaved purchasing correction");
  await details
    .getByRole("button", { name: "Cancel correction", exact: true })
    .click();
  if (
    (await page.evaluate("document.activeElement.textContent")).trim() !==
    "Correct purchasing link"
  )
    throw new Error("Cancelling correction did not restore trigger focus");
  if (
    (await details
      .getByRole("textbox", { name: "Replacement reply", exact: true })
      .count()) !== 0 ||
    (await details
      .getByRole("heading", {
        name: "Current purchasing evidence",
        exact: true,
      })
      .count()) !== 0
  )
    throw new Error(
      "Cancelling correction retained purchasing evidence or text",
    );
  await correct.click();
  await details
    .getByRole("textbox", { name: "Purchase request reference", exact: true })
    .fill("PR-A");
  await details
    .getByRole("button", { name: "Preview purchasing link", exact: true })
    .click();
  await details
    .getByRole("heading", { name: "Current purchasing evidence", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 320, height: 800 });
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 320)
    throw new Error("Purchasing correction overflows at 320px");
  await details
    .getByRole("textbox", { name: "Replacement reply", exact: true })
    .fill(
      "Corrected Inbox reply: PR-A requires 20 units; please confirm arrival.",
    );
  await captureConversation("output/playwright/mail-correction-mobile.png");
  await details
    .getByRole("button", { name: "Save corrected draft", exact: true })
    .click();
  await draft
    .getByText(
      "Corrected Inbox reply: PR-A requires 20 units; please confirm arrival.",
      { exact: true },
    )
    .waitFor();
  // A phone shows the case alone, with the bar in reach.
  const phoneBar = await bar.boundingBox();
  const phoneDrawer = await conversation.boundingBox();
  if (
    (await page.evaluate("document.documentElement.scrollWidth")) !== 320 ||
    phoneDrawer === null ||
    phoneDrawer.x !== 0 ||
    phoneDrawer.width !== 320 ||
    phoneBar === null ||
    phoneBar.x < 0 ||
    phoneBar.x + phoneBar.width > 320 ||
    phoneBar.y + phoneBar.height > 800 ||
    JSON.stringify(await bar.getByRole("button").allInnerTexts()) !==
      '["Approve and send","Edit","Reject"]'
  )
    throw new Error("The case does not fill the phone with the bar in reach");
  await page.screenshot({ path: "output/playwright/mail-review-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await captureConversation("output/playwright/mail-review-desktop.png");
  await page.evaluate("window.mailReviewStale = true");
  const reads = await page.evaluate("window.mailDraftReads");
  await bar
    .getByRole("button", { name: "Approve and send", exact: true })
    .click();
  await conversation
    .getByRole("alert")
    .getByText(
      "This draft changed. Review its latest version before saving or sending.",
      { exact: true },
    )
    .waitFor();
  await draft.getByText(/^Corrected Inbox reply/).waitFor();
  if ((await page.evaluate("window.mailDraftReads")) <= reads)
    throw new Error("A failed approval kept the draft that it had read");
  await page.evaluate("window.mailReviewStale = false");
  const threadReads = await page.evaluate("window.mailThreadReads");
  await bar
    .getByRole("button", { name: "Approve and send", exact: true })
    .click();
  // Gmail did not confirm the send: that is not a decision, so the case
  // stays open with its one way forward.
  const unconfirmed = conversation.getByRole("region", {
    name: "Send not confirmed",
    exact: true,
  });
  const checkSend = unconfirmed.getByRole("button", {
    name: "Check send state in Gmail",
    exact: true,
  });
  await checkSend.waitFor();
  if (
    (await bar.count()) !== 0 ||
    (await draft.count()) !== 0 ||
    (await conversation.getByRole("alert").count()) !== 0 ||
    (await page.getByText(/^Reply sent to /).count()) !== 0
  )
    throw new Error("An unresolved send retained an approval or a receipt");
  if (
    (await page.evaluate("document.activeElement.textContent")) !==
    "Send not confirmed"
  )
    throw new Error("An unresolved send did not receive focus");
  if ((await page.evaluate("window.mailThreadReads")) <= threadReads)
    throw new Error("A decision did not read the thread again");
  await inbox
    .getByText("No decisions wait for you.", { exact: true })
    .waitFor();
  await inbox
    .locator(".mail-case-empty")
    .getByText("Nothing waits for you.", { exact: true })
    .waitFor();
  // Close returns focus to the list. The draft left it, so the page's
  // heading takes focus.
  await close.click();
  if (
    (await conversation.count()) !== 0 ||
    (await page.evaluate("document.activeElement.textContent")) !== "Inbox" ||
    (await page.evaluate("location.search")) !== ""
  )
    throw new Error("Closing the case did not return to the list");
  await chooseMenuItem("All mail");
  await mailRow.waitFor();
  if ((await page.getByText("Reply waits", { exact: true }).count()) !== 0)
    throw new Error("An approved draft kept its row mark");
  const commands = await page.evaluate("window.mailReviewCommands");
  const approved = commands.filter(function isApproval(command) {
    return command.action === "approve";
  });
  if (
    approved.length !== 2 ||
    approved[1].body.version !== 4 ||
    approved[1].body.snapshotDigest !== "d".repeat(64) ||
    approved[1].body.challenge !== "review-fixture-challenge" ||
    Object.keys(approved[1].body).sort().join(",") !==
      "challenge,snapshotDigest,version"
  )
    throw new Error("Inbox approval did not use the exact reviewed version");
  // The conversation opens again from All mail.
  await mailRow.click();
  await checkSend.waitFor();
  await checkSend.click();
  await unconfirmed
    .getByText("Gmail does not show this reply as sent yet.", { exact: true })
    .waitFor();
  await page.evaluate("window.mailReviewFound = true");
  await checkSend.click();
  await conversation.getByText("Reply sent.", { exact: true }).waitFor();
  if (
    (await page.evaluate("document.activeElement.textContent")) !==
    "Reply sent."
  )
    throw new Error("A sent reply did not receive focus");
  // The sent reply is mail of the mailbox now: a message on the right.
  const sent = conversation
    .getByRole("article")
    .filter({ hasText: "From this mailbox" });
  await sent.waitFor();
  const customerBox = await conversation
    .getByRole("article")
    .first()
    .boundingBox();
  const sentBox = await sent.boundingBox();
  if (
    (await sent.locator("time").count()) !== 1 ||
    !(await sent.innerText()).includes("Corrected Inbox reply") ||
    (await conversation.getByRole("article").count()) !== 2 ||
    customerBox === null ||
    sentBox === null ||
    customerBox.x >= sentBox.x
  )
    throw new Error("Sent mail of the mailbox is not a message on the right");
  await details
    .getByTitle("Gmail receipt gmail_reviewed_receipt", { exact: true })
    .waitFor();
  if ((await unconfirmed.count()) !== 0)
    throw new Error("Reconciled delivery retained an unresolved action");
  await page.evaluate("window.mailReplyState = 'awaiting_approval'");
  await refreshConversation();
  await draft.waitFor();
  await correct.click();
  await details
    .getByRole("textbox", { name: "Purchase request reference", exact: true })
    .fill("PR-A");
  await details
    .getByRole("button", { name: "Preview purchasing link", exact: true })
    .click();
  await details
    .getByRole("textbox", { name: "Replacement reply", exact: true })
    .fill("Unconfirmed corrected reply.");
  await page.evaluate("window.mailCorrectionUnconfirmed = true");
  await details
    .getByRole("button", { name: "Save corrected draft", exact: true })
    .click();
  await details.getByRole("alert").waitFor();
  if (
    (await details
      .getByRole("textbox", { name: "Replacement reply", exact: true })
      .count()) !== 0
  )
    throw new Error("Failed correction retained unsaved content");
  if ((await draft.count()) !== 1 || (await bar.count()) !== 1)
    throw new Error("A failed correction save replaced the draft");
  await details
    .getByRole("button", { name: "Reject proposal", exact: true })
    .click();
  await conversation.getByText("Draft rejected.", { exact: true }).waitFor();
  await details.getByText("Rejected", { exact: true }).waitFor();
  if ((await draft.count()) !== 0 || (await bar.count()) !== 0)
    throw new Error("A rejected draft kept its card or its actions");
  await page.evaluate(
    "window.mailCorrectionUnconfirmed = false; window.mailReplyState = 'awaiting_approval'",
  );
  await refreshConversation();
  // A rejection from All mail keeps the case open, and a toast confirms it
  // without an undo: a rejection cannot be taken back.
  await bar.getByRole("button", { name: "Reject", exact: true }).click();
  await conversation.getByText("Draft rejected.", { exact: true }).waitFor();
  await details.getByText("Rejected", { exact: true }).waitFor();
  const toast = page.locator("[data-sonner-toast]", {
    hasText: "Draft for Mika · Packaging supplier rejected.",
  });
  await toast.waitFor();
  if ((await toast.getByRole("button", { name: "Undo" }).count()) !== 0)
    throw new Error("A rejection offered an undo that the backend lacks");
  const rejected = (await page.evaluate("window.mailReviewCommands")).at(-1);
  if (rejected.action !== "reject" || JSON.stringify(rejected.body) !== "{}")
    throw new Error("Reject did not use the reject route");
  await page.evaluate("window.mailReplyState = 'awaiting_approval'");
  await refreshConversation();
  await draft.waitFor();
  await page.evaluate("window.mailWorkDenied = true");
  await refreshConversation();
  await conversation.getByRole("alert").waitFor();
  if (
    (await conversation
      .getByTitle("Gmail receipt gmail_confirmed_prior_reply", { exact: true })
      .count()) !== 0 ||
    (await conversation.getByText(/mika@packaging\.example/).count()) !== 0
  )
    throw new Error("Revoked work retained metadata or draft content");
  await page.evaluate(
    "window.mailWorkDenied = false; window.mailWorkBlock = true",
  );
  await conversation
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await conversation
    .getByText("Fetching the current draft from Gmail…", { exact: true })
    .waitFor();
  // Escape closes the case while a preview is still on its way.
  await close.focus();
  await page.keyboard.press("Escape");
  await page.evaluate("window.releaseMailWork()");
  if ((await page.locator(".mail-conversation").count()) !== 0)
    throw new Error("Closing the case retained its conversation");
  if ((await page.getByText(/mika@packaging\.example/).count()) !== 0)
    throw new Error("A delayed preview repopulated a closed conversation");
  await page.evaluate(function renderViewer() {
    window.mailWorkBlock = false;
    window.mailInboxRender({ canManage: false, key: "viewer" });
  });
  await row.waitFor();
  await inbox
    .getByText("1 reply draft waits for approval.", { exact: true })
    .waitFor();
  await row.click();
  await draft.getByText("To mika@packaging.example", { exact: true }).waitFor();
  if (
    (await bar.count()) !== 0 ||
    (await conversation
      .getByRole("button", { name: "Approve and send", exact: true })
      .count()) !== 0 ||
    (await conversation
      .getByRole("button", { name: "Reject", exact: true })
      .count()) !== 0
  )
    throw new Error("Viewer review exposed administrator actions");
  if (
    (await conversation
      .getByRole("button", { name: "Edit", exact: true })
      .count()) !== 0 ||
    (await correct.count()) !== 0
  )
    throw new Error("Viewer review exposed editing or purchasing correction");
  // A viewer reads the supplier link and cannot change it.
  const viewerSupplier = conversation.locator(".mail-sender-supplier");
  await viewerSupplier
    .locator(".mail-sender-supplier-state")
    .getByText("Packaging supplier", { exact: true })
    .waitFor({ state: "attached" });
  if (
    (await viewerSupplier
      .getByRole("button", { includeHidden: true })
      .count()) !== 0
  )
    throw new Error("Viewer review exposed the supplier link change");
  // JEV opens from the case's menu and returns focus to the case.
  await conversation
    .getByRole("button", { name: "Conversation options", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Open JEV/ }).click();
  await page.getByRole("heading", { name: "JEV", exact: true }).waitFor();
  if ((await page.evaluate("document.activeElement.textContent")) !== "JEV")
    throw new Error("Opening JEV did not focus the panel");
  await page
    .getByRole("heading", { name: "Inbox rules", exact: true })
    .waitFor();
  if (
    (await page
      .getByRole("button", { name: "Publish rules", exact: true })
      .count()) !== 0 ||
    (await page
      .getByRole("button", { name: "Add category", exact: true })
      .count()) !== 0
  )
    throw new Error("Viewer rules exposed administrator authoring");
  await page.getByRole("button", { name: "Close JEV", exact: true }).click();
  await draft.waitFor();
  console.log(
    "MAIL_REVIEW_BROWSER: one list in sections with what waits first and other mail below, each thread once, search always shown, sender and subject from the queue, no chips; the mailbox and agent as one status control; All mail and Spam from the options menu and the views below the sections, Done for decided drafts, Spam listed read only with rows that open the thread in the mailbox's Gmail; agent on, paused with resume, off with settings link and the turn-on sheet, and unreadable; a row opens its case in a drawer beside the list, in the address, with the draft card and exactly Approve and send, Edit and Reject in a bar that holds to the drawer's lower edge; the Gmail draft is not a message; mail of the mailbox and the acknowledgement are one line each; one closed disclosure of what the agent checked holds the Memory, the Case state, refresh, purchasing correction, activity and receipts; purchasing correction, also when unavailable, leaves the draft and its actions; keyboard body editor with cancel, refresh discard and exact-version save; canonical purchasing correction with replacement reply; exact-snapshot approval and rejection with a toast and no undo; a stale approval reads the draft again; an unresolved send only reconciles; receipt refresh; 320px case alone with the bar in reach; refresh revocation purges content; delayed preview discarded on Escape; the sender links to a supplier with a changed-link refusal, an empty-supplier link to Suppliers and a read-only viewer; JEV from the case menu",
  );
  return {
    artifact: "MAIL_REVIEW_BROWSER",
    passed: true,
    agentStateVerified: true,
    sectionsVerified: true,
    spamFolderVerified: true,
    draftNotAMessageVerified: true,
    actionBarVerified: true,
    disclosureVerified: true,
    viewerActionsHidden: true,
    bodyEditorVerified: true,
    purchasingCorrectionVerified: true,
    failedCorrectionCleanupVerified: true,
    senderSupplierLinkVerified: true,
    drawerBesideListVerified: true,
  };
}
