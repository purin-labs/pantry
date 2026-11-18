async function accessJourney(page) {
  const currentUrl = page.url();
  const originEnd = currentUrl.indexOf("/", currentUrl.indexOf("://") + 3);
  const origin = originEnd === -1 ? currentUrl : currentUrl.slice(0, originEnd);
  const preview = (scenario, view) =>
    `${origin}/access-preview.html?scenario=${scenario}&view=${view}`;
  const status = page.locator(".access35-live-status");
  const system = (name) =>
    page.locator(".access35-system").filter({ hasText: name });
  const summary = async (name) =>
    (await system(name).locator(".access35-system-summary").textContent()) ??
    "";
  // Each system row opens its access in a side drawer.
  const drawer = page.locator("dialog.access35-system-drawer");
  const openSystem = async (name) => {
    await system(name).getByRole("button").click();
    await drawer.getByRole("heading", { name }).waitFor();
  };
  const closeSystem = async () => {
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
  };
  const visibleSystems = () =>
    page.locator(".access35-system-name strong").allTextContents();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(preview("populated", "access"));
  await page.getByRole("heading", { name: "Connected systems" }).waitFor();
  const systems = await visibleSystems();
  const tabsRemoved =
    (await page.getByRole("link", { name: "Who has access" }).count()) === 0;
  const closedSummary = await summary("Shopify");
  const closedNotice =
    (await page.locator(".access35-attention").textContent()) ?? "";

  // Share the closed system from its notice; the dialog offers its actions only.
  await page.getByRole("button", { name: "Share Shopify" }).click();
  const share = page.getByRole("dialog", { name: /^Share Shopify/u });
  await share.waitFor();
  const offered = (
    await selectItems(page, share.getByLabel("2. What they can do"))
  ).map((item) => item.label);
  await chooseOption(page, share.getByLabel("1. Who gets access"), {
    label: "#cafe-ops · Nuki Cafe Slack",
  });
  await chooseOption(page, share.getByLabel("2. What they can do"), {
    label: "Cancel a Shopify order",
  });
  // The Selects show their prompt as a placeholder, not as a first item, so
  // index 0 is the first account and the first resource.
  await chooseOption(page, share.getByLabel("3. Connected account"), {
    index: 0,
  });
  await chooseOption(page, share.getByLabel("4. Resource"), { index: 0 });
  await share.getByRole("button", { name: "Grant access" }).click();
  await status.filter({ hasText: "Access granted." }).waitFor();
  const sharedSummary = await summary("Shopify");
  const noticeAfterShare = await page.locator(".access35-attention").count();
  await openSystem("Shopify · nuki-cafe.myshopify.com");
  const recipient = drawer.locator(".access35-recipient-list > li");
  const sharedRecipient = (await recipient.first().textContent()) ?? "";
  await closeSystem();

  // One filter replaces the five old ones.
  await chooseOption(page, page.getByLabel("Show systems"), {
    value: "can_change",
  });
  const canChange = await visibleSystems();
  await chooseOption(page, page.getByLabel("Show systems"), { value: "all" });
  await page
    .getByLabel("Find a system, person, channel, or action")
    .fill("supplier contracts");
  const searched = await visibleSystems();
  await page.getByLabel("Find a system, person, channel, or action").fill("");

  // Revoke the new permission from the drawer; the confirm dialog stacks
  // above it, focus stays in the drawer, and the system keeps the record.
  await openSystem("Shopify · nuki-cafe.myshopify.com");
  await drawer.getByRole("button", { name: "Remove…" }).click();
  const revoke = page.getByRole("dialog", { name: "Remove access" });
  await revoke
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await status.filter({ hasText: "Access revoked." }).waitFor();
  await revoke.waitFor({ state: "hidden" });
  await drawer.locator(".access35-revoked").waitFor();
  const focusAfterRevoke = await page
    .waitForFunction(
      () =>
        document
          .querySelector("dialog.access35-system-drawer")
          ?.contains(document.activeElement) === true,
      null,
      { timeout: 2000 },
    )
    .then(
      () => true,
      () => false,
    );
  const revokedRecord =
    (await drawer.locator(".access35-revoked").textContent()) ?? "";
  await closeSystem();
  const revokedSummary = await summary("Shopify");
  const noticeAfterRevoke = await page.locator(".access35-attention").count();

  // The data-flow question is answered in a drawer.
  await page.getByRole("button", { name: "Check access" }).click();
  const check = page.getByRole("form", { name: "Check access" });
  // Index 0 is the first source: the prompt is a placeholder, not an item.
  await chooseOption(page, check.getByLabel("Data from"), { index: 0 });
  await chooseOption(page, check.getByLabel("Used by"), {
    label: "Pta · Owner",
  });
  await chooseOption(page, check.getByLabel("Sent to"), {
    label: "#cafe-ops · Nuki Cafe Slack",
  });
  await check.getByRole("button", { name: "Check", exact: true }).click();
  const decision = page.locator(".access35-check-result h2");
  await decision.waitFor();
  const decisionTitle = (await decision.textContent()) ?? "";
  await page
    .locator("dialog.access35-check-drawer")
    .getByRole("button", { name: "Close", exact: true })
    .click();

  // The action list opens narrowed to one system and leads back.
  await openSystem("Stripe · Nuki Cafe");
  await drawer.getByRole("link", { name: "Edit actions" }).click();
  await page.getByRole("heading", { name: "What can be done" }).waitFor();
  const actionSearch = await page
    .getByRole("searchbox", { name: "Find an action" })
    .inputValue();
  const actionCount =
    (await page.locator(".access35-result-count").textContent()) ?? "";
  await page.getByRole("link", { name: "Access", exact: true }).click();
  await page.getByRole("heading", { name: "Connected systems" }).waitFor();
  const returned = new URL(page.url()).searchParams.get("view");

  // A viewer reads the same list with no way to change it.
  await page.goto(preview("viewer", "access"));
  await page.getByRole("heading", { name: "Connected systems" }).waitFor();
  let viewerControls = await page
    .getByRole("button", { name: "Share a system" })
    .count();
  let viewerRecipients = 0;
  for (const name of await visibleSystems()) {
    await openSystem(name);
    viewerControls +=
      (await drawer.getByRole("button", { name: "Remove…" }).count()) +
      (await drawer
        .getByRole("button", { name: /^(Share|Add a person)/u })
        .count());
    viewerRecipients += await drawer
      .locator(".access35-recipient-name")
      .count();
    await closeSystem();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(preview("populated", "access"));
  await page.getByRole("heading", { name: "Connected systems" }).waitFor();
  await openSystem("Stripe · Nuki Cafe");
  const mobileFits = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  return {
    systems,
    tabsRemoved,
    closedSummary,
    closedNotice,
    offered,
    sharedSummary,
    noticeAfterShare,
    sharedRecipient,
    canChange,
    searched,
    revokedSummary,
    revokedRecord,
    focusAfterRevoke,
    noticeAfterRevoke,
    decisionTitle,
    actionSearch,
    actionCount,
    returned,
    viewerControls,
    viewerRecipients,
    mobileFits,
  };

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
}
