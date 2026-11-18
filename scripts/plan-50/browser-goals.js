async (page) => {
  class GoalJourney {
    constructor(fixtures) {
      this.fixtures = fixtures;
    }
    async open(target) {
      const response = await target.request.post(
        "http://127.0.0.1:8834/test/session?user=Owner",
      );
      if (!response.ok()) throw new Error("Session creation failed");
      const session = await response.json();
      await target.addInitScript({ content: FIXTURE_SOURCE });
      await target.goto(
        `http://127.0.0.1:3116/chat-preview.html?preferenceUser=${session.userId}`,
      );
      await target.getByRole("link", { name: "Ask", exact: true }).click();
      await target
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await target.getByRole("link", { name: /^Launch checklist/ }).click();
      await target.getByRole("button", { name: "Goal", exact: true }).click();
      await target.getByLabel("Token budget", { exact: true }).waitFor();
    }
    async save(target, budget) {
      await target
        .getByLabel("Objective", { exact: true })
        .fill("Review the launch checklist");
      await target
        .getByLabel("Token budget", { exact: true })
        .fill(String(budget));
      await target
        .getByRole("button", { name: "Save goal", exact: true })
        .click();
    }
    async status(target, text) {
      await target.getByText(text, { exact: true }).waitFor();
    }
    async send(target, message, answer) {
      await target
        .getByRole("button", { name: "Close chat goal", exact: true })
        .click();
      await target.getByLabel("Message your AI", { exact: true }).fill(message);
      await target
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await target
        .getByText(answer, { exact: true })
        .waitFor({ timeout: 30000 });
      await target.getByRole("button", { name: "Goal", exact: true }).click();
    }
    async read(target) {
      const response = await target.request.get(
        `http://127.0.0.1:8834/v1/control/organisations/${this.fixtures.organisationId}/chat/conversations/${this.fixtures.sharedCandidate}/goal`,
      );
      if (!response.ok())
        throw new Error(`Goal read failed: ${response.status()}`);
      return response.json();
    }
  }
  const journey = new GoalJourney(JOURNEY_FIXTURES);
  const peerContext = await page
    .context()
    .browser()
    .newContext({ viewport: { width: 1200, height: 900 } });
  try {
    const peer = await peerContext.newPage();
    await journey.open(page);
    await journey.open(peer);
    await peer
      .getByLabel("Objective", { exact: true })
      .fill("Peer draft objective");
    await peer.getByLabel("Token budget", { exact: true }).fill("50");
    await journey.save(page, 100);
    await journey.status(page, "active · 0 / 100 tokens");
    await journey.status(peer, "active · 0 / 100 tokens");
    if (
      (await peer.getByLabel("Objective", { exact: true }).inputValue()) !==
      "Peer draft objective"
    )
      throw new Error("Remote update replaced the unsaved objective");
    if (
      (await peer.getByLabel("Token budget", { exact: true }).inputValue()) !==
      "50"
    )
      throw new Error("Remote update replaced the unsaved budget");
    await peer.getByRole("button", { name: "Save goal", exact: true }).click();
    await peer
      .getByRole("alert")
      .filter({ hasText: "The goal changed" })
      .waitFor();
    await journey.status(peer, "active · 0 / 100 tokens");
    await peer.getByRole("button", { name: "Pause goal", exact: true }).click();
    await journey.status(peer, "paused · 0 / 100 tokens");
    await journey.status(page, "paused · 0 / 100 tokens");
    await journey.save(page, 200);
    await journey.status(page, "paused · 0 / 200 tokens");
    await journey.status(peer, "paused · 0 / 200 tokens");
    await peer.screenshot({
      path: "output/playwright/plan-50-goals/paused-peer.png",
    });
    await journey.send(
      page,
      "Review the checklist while paused",
      "The goal is paused. Work is saved. Explicitly resume the goal to continue.",
    );
    await journey.status(page, "paused · 0 / 200 tokens");
    await peer
      .getByRole("button", { name: "Resume goal", exact: true })
      .click();
    await journey.status(peer, "active · 0 / 200 tokens");
    await journey.status(page, "active · 0 / 200 tokens");
    await journey.send(
      page,
      "Review the launch checklist",
      "Checklist review 1 completed.",
    );
    await journey.status(page, "active · 25 / 200 tokens");
    await journey.status(peer, "active · 25 / 200 tokens");
    await journey.send(
      page,
      "Continue the launch review",
      "Checklist review 2 completed.",
    );
    await journey.status(page, "active · 50 / 200 tokens");
    await journey.status(peer, "active · 50 / 200 tokens");
    const first = await journey.read(page);
    const second = await journey.read(peer);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw new Error("Goal projections diverged");
    if (first.execution !== "idle" || first.goal.goal.tokensUsed !== 50)
      throw new Error("Model continuation did not settle");
    await page.screenshot({
      path: "output/playwright/plan-50-goals/resumed-owner.png",
    });
    const changedSession = await peer.request.post(
      "http://127.0.0.1:8834/test/session?user=Unrelated",
    );
    if (!changedSession.ok())
      throw new Error("Could not change peer authority");
    await peer
      .getByRole("dialog", { name: "Chat goal" })
      .waitFor({ state: "hidden" });
    const denied = await peer.request.get(
      `http://127.0.0.1:8834/v1/control/organisations/${journey.fixtures.organisationId}/chat/conversations/${journey.fixtures.sharedCandidate}/goal`,
    );
    if (denied.status() !== 404)
      throw new Error("Changed authority retained goal access");
    await peer.screenshot({
      path: "output/playwright/plan-50-goals/access-lost-peer.png",
    });
    return {
      automaticGoalObservation: true,
      unsavedDraftPreserved: true,
      changedAuthorityHidesGoal: true,
      clients: 2,
      identities: "two sessions for the same authorized owner",
      backend: "real Worker/D1/Case Actor",
      staleEditRejected: true,
      budgetIncreasePreservedPause: true,
      explicitResume: true,
      automaticContinuation: false,
      pausedDispatchBlocked: true,
      modelTurns: 2,
      recordedTokens: 50,
      finalGoal: first,
    };
  } catch (error) {
    await page.screenshot({
      path: "output/playwright/plan-50-goals/failure-owner.png",
    });
    for (const failedPeer of peerContext.pages()) {
      await failedPeer.screenshot({
        path: "output/playwright/plan-50-goals/failure-peer.png",
      });
    }
    throw new Error(
      `${error.message} Owner page: ${await page.locator("body").innerText()}`,
    );
  } finally {
    await peerContext.close();
  }
};
