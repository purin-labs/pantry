// Local side Case states, including retry and restricted access.
async function reviewSideCases(page) {
  const origin = new URL(page.url()).origin;
  const base = `${origin}/chat-preview.html?scenario=side-cases&conversation=conv_00000000-0000-0000-0000-000000000001`;
  const artifacts = "output/playwright/ui-chat-decisions";
  await page.evaluate(
    "sessionStorage.removeItem('chat-preview-regenerate'); sessionStorage.removeItem('chat-preview-request-id')",
  );
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto(`${base}&sideFault=once`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const card = page.getByRole("article", {
    name: "Restock butter",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Start in a subthread", exact: true })
    .click();
  await card.getByRole("alert").waitFor();
  await card.screenshot({ path: `${artifacts}/side-case-failure.png` });
  await card
    .getByRole("button", { name: "Start in a subthread", exact: true })
    .click();
  await card.getByRole("link", { name: "Open chat", exact: true }).waitFor();
  if (
    await card
      .getByRole("button", { name: "Start in a subthread", exact: true })
      .count()
  )
    throw new Error("A started side Case still offers Start.");
  await card.screenshot({ path: `${artifacts}/side-case-recovered.png` });
  await card.getByRole("link", { name: "Open chat", exact: true }).click();
  await page
    .getByRole("heading", { name: "Restock butter", exact: true })
    .waitFor();
  await page.waitForTimeout(1200);
  if (
    !(await page
      .getByRole("heading", { name: "Restock butter", exact: true })
      .isVisible())
  )
    throw new Error("The opened side Case lost its identity after refresh.");
  await page.screenshot({ path: `${artifacts}/side-case-opened.png` });

  await page.goto(`${base}&sideFault=once`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await card.waitFor();
  await page.evaluate(`
    window.reviewOriginalFetch = window.fetch;
    window.reviewMessageCount = 0;
    window.fetch = async function recordPreviewMessage(input, init) {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const command = JSON.parse(init.body);
        if (command.kind === 'message') window.reviewMessageCount += 1;
      }
      return window.reviewOriginalFetch(input, init);
    };
  `);
  await card.getByRole("button", { name: "Do it here", exact: true }).click();
  await card.getByRole("alert").waitFor();
  await card
    .getByRole("button", { name: "Finish here", exact: true })
    .waitFor();
  if (
    await card
      .getByRole("button", { name: "Start in a subthread", exact: true })
      .count()
  )
    throw new Error("Accepted work still offers a separate start.");
  await card.screenshot({
    path: `${artifacts}/side-here-dismissal-failed.png`,
  });
  await card.getByRole("button", { name: "Finish here", exact: true }).click();
  await card.getByText("In this chat", { exact: true }).waitFor();
  await card
    .getByRole("button", { name: "Finish here", exact: true })
    .waitFor({ state: "hidden" });
  if ((await page.evaluate("window.reviewMessageCount")) !== 1)
    throw new Error("Dismissal recovery repeated the accepted message.");
  await card.screenshot({ path: `${artifacts}/side-here-recovered.png` });
  await page.evaluate(
    "sessionStorage.removeItem('chat-preview-regenerate'); sessionStorage.removeItem('chat-preview-request-id')",
  );

  const states = [
    { name: "starting", query: "sideState=starting" },
    { name: "retry", query: "sideState=retry" },
    { name: "expired", query: "sideState=expired" },
    { name: "hidden", query: "sideState=hidden" },
    { name: "readonly", query: "sideState=readonly" },
    { name: "viewer", query: "chatRole=viewer" },
    { name: "viewer-retry", query: "sideState=retry&chatRole=viewer" },
  ];
  const reviewed = [];
  for (const state of states) {
    await page.goto(`${base}&${state.query}`);
    await page.getByRole("link", { name: "Ask", exact: true }).click();
    await card.waitFor();
    await page.waitForTimeout(500);
    if (state.name !== "retry" && (await card.getByRole("button").count()))
      throw new Error(`${state.name} incorrectly offers a side Case action.`);
    if (state.name === "viewer-retry")
      await card
        .getByText("A person who can edit this chat must retry the start.", {
          exact: true,
        })
        .waitFor();
    await card.screenshot({ path: `${artifacts}/side-case-${state.name}.png` });
    reviewed.push(state.name);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await card.waitFor();
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await card.screenshot({ path: `${artifacts}/side-case-dark.png` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 1000 });
  await card.screenshot({ path: `${artifacts}/side-case-reduced-motion.png` });
  return {
    status: "passed",
    failedStartRecovery: "passed",
    startedCaseNavigation: "passed",
    acceptedBriefNotRepeated: "passed",
    restrictedActions: "passed",
    states: reviewed,
    artifacts,
  };
}
