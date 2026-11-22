async (page) => {
  // The agent edits the shared menu in a browser, against a local Worker with
  // its own D1 (Plan 81 slice 4).
  //
  // The owner opens the Menus page with the chat beside it and asks the chat
  // to add a section. This is a private chat, so the edit first asks the
  // owner (Plan 27C): the menu stays as it is, and the chat opens the
  // permission prompt in place. The owner allows it there and asks again. The
  // section then appears on the open page with no reload, through the room
  // that people edit. Nothing goes live: the journey never publishes.
  //
  // Setup: POST /test/setup-menu. The model provider is simulated; it only
  // answers with the next tool call of a fixed script.
  const WORKER = "http://127.0.0.1:8881";
  const PORTAL = "http://127.0.0.1:3181";
  const MENU = "Add a Coffee section to the menu.";
  const AGAIN = "Please add the Coffee section again.";
  const ASKED =
    "Purin Pantry asked you for approval in this chat. Ask me again after you allow it.";
  const ANSWER = "I added a Coffee section to the menu.";
  const fixtures = JOURNEY_FIXTURES;
  const artifacts = JOURNEY_ARTIFACTS;
  const checks = [];
  const captures = [];
  function check(name, passed, detail) {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  }
  async function capture(name) {
    await page.screenshot({ path: `${artifacts}/${name}.png` });
    captures.push(`${name}.png`);
  }
  async function csrf() {
    const cookies = await page.context().cookies(WORKER);
    return cookies.find((cookie) => cookie.name === "pantry_csrf")?.value;
  }
  // The Access page's change: the Access revision and the capability's.
  async function enableCapability(capabilityId) {
    const base = `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/access-control`;
    const view = (await (await page.request.get(base)).json()).accessControl;
    const capability = view.capabilities.find(
      (candidate) => candidate.definition.capabilityId === capabilityId,
    );
    const response = await page.request.post(
      `${base}/capabilities/${capabilityId}`,
      {
        headers: {
          origin: PORTAL,
          "content-type": "application/json",
          "x-pantry-csrf": await csrf(),
          "idempotency-key": crypto.randomUUID(),
        },
        data: {
          expectedRevision: view.revision,
          capabilityRevision: capability.revision,
          capabilityVersion: 1,
          mode: "enabled",
        },
      },
    );
    check("The owner turned on menu editing", response.ok(), response.status());
  }
  async function ask(text) {
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor({ timeout: 60_000 });
    const composer = page.getByPlaceholder(/^Ask anything/u);
    await composer.fill(text);
    await composer.press("Enter");
  }
  function sectionCount(count) {
    return page.getByText(`${count} sections · 0 items`, { exact: true });
  }
  async function run() {
    const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
    if (!session.ok()) throw new Error("Session failed for Owner");
    const owner = await session.json();
    await page.setViewportSize({ width: 1440, height: 900 });
    await enableCapability("commerce.menu_draft.edit");
    await page.goto(
      `${PORTAL}/menu-chat-preview.html?organisation=${fixtures.organisationId}&preferenceUser=${owner.userId}&tab=items`,
    );
    await sectionCount(1).waitFor({ timeout: 60_000 });
    await capture("10-menu-before");

    // 1. The private chat's edit asks, and the menu stays as it is.
    await ask(MENU);
    await page.getByText(ASKED, { exact: true }).waitFor({ timeout: 60_000 });
    check("The menu did not change before the approval", await sectionCount(1).isVisible());
    await capture("11-edit-asks");

    // 2. The chat opens the permission prompt; the owner allows that one step
    //    there, without the account menu.
    const prompt = page.getByRole("dialog", { name: "Sous Chef wants to do one step" });
    await prompt.waitFor({ timeout: 30_000 });
    check(
      "The prompt names the step",
      await prompt.getByText("Edit the shared menu draft", { exact: false }).first().isVisible(),
      await prompt.innerText(),
    );
    await capture("11b-prompt-in-chat");
    await prompt.getByRole("button", { name: "Allow", exact: true }).click();
    const allowed = page.getByRole("dialog", { name: "Request allowed" });
    await allowed.waitFor({ timeout: 15_000 });
    await capture("12-allowed");
    await allowed.getByRole("button", { name: "Close", exact: true }).last().click();
    await allowed.waitFor({ state: "hidden", timeout: 10_000 });

    // 3. The owner asks again. The open page shows the section with no reload.
    await ask(AGAIN);
    await page.getByText(ANSWER, { exact: true }).waitFor({ timeout: 60_000 });
    await sectionCount(2).waitFor({ timeout: 10_000 });
    check("The open page shows the agent's section", await page.getByRole("textbox", { name: /Coffee/u }).or(page.getByText("Coffee", { exact: true })).first().isVisible());
    check("The page did not reload", (await page.evaluate(() => performance.getEntriesByType("navigation").length)) === 1);
    await capture("13-section-live");

    // 4. The server's draft holds the section.
    const saved = await (
      await page.request.get(
        `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/collaboration/menu-draft`,
      )
    ).json();
    check(
      "The server's draft holds the agent's section",
      saved.value.draft.sections.some((section) => section.title === "Coffee"),
      saved.value.draft.sections,
    );
    // 5. The owner's approval card for a menu publication. The approval and
    //    the publication run in tests/e2e/pi-cafe-menu-publication.test.ts.
    await page.goto(`${PORTAL}/menu-card-preview.html`);
    await page.getByRole("heading", { name: "Publish café menu" }).waitFor({ timeout: 30_000 });
    const card = await page.locator(".commerce-action-status").innerText();
    check("The card names the new item", card.includes("Ginger milk tea (new)"), card);
    check("The card names the removed item", card.includes("Sesame cookie"), card);
    await page.locator(".commerce-action-status").scrollIntoViewIfNeeded();
    await capture("14-approval-card");
    const model = await (await page.request.get(`${WORKER}/test/model`)).json();
    return {
      result: "passed",
      modelRequests: model.modelRequests.length,
      checks,
      captures,
    };
  }
  try {
    return await run();
  } catch (error) {
    await capture("failure").catch(() => undefined);
    return {
      result: "failed",
      error: String(error),
      pageText: (await page.locator("body").innerText().catch(() => "")).slice(-3_000),
      checks,
      captures,
    };
  }
};
