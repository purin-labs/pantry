async (page) => {
  // A side Case in a browser, against a local Worker with its own D1 (Plan 74).
  //
  // The owner asks a chat a question. While the agent answers, it proposes
  // separate work; the chat shows a card and nothing starts. The owner starts
  // it from the card. The new chat shows under the source chat in the
  // sidebar, runs with the brief as its first message and no turn of the
  // source chat, and links back to the source chat. The card then says that
  // the side Case started.
  //
  // Setup: POST /test/setup. The model provider is simulated.
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const QUESTION = "How many croissant orders came in today?";
  const ANSWER = "Today has 14 croissant orders. I proposed a side Case.";
  const TITLE = "Fix the almond croissant price";
  const SIDE_ANSWER = "I will check the almond croissant price record.";

  class SideCaseJourney {
    constructor(owner, fixtures, artifacts) {
      this.owner = owner;
      this.fixtures = fixtures;
      this.artifacts = artifacts;
      this.checks = [];
      this.captures = [];
    }
    check(name, passed, detail) {
      this.checks.push({ name, passed: Boolean(passed), detail });
      if (!passed)
        throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
    }
    async capture(name) {
      const path = `${this.artifacts}/${name}.png`;
      await this.owner.screenshot({ path, fullPage: true });
      this.captures.push(`${name}.png`);
    }
    async sidebarRows() {
      return this.owner
        .locator(".chat-organizer-list .chat-organizer-row")
        .evaluateAll((rows) =>
          rows.map((row) => ({
            text: row.textContent ?? "",
            sideCase: row.getAttribute("data-side-case") === "true",
            left: row.getBoundingClientRect().left,
          })),
        );
    }
    async run() {
      const page = this.owner;
      const session = await page.request.post(
        `${WORKER}/test/session?user=Owner`,
      );
      if (!session.ok()) throw new Error("Session failed for Owner");
      const owner = await session.json();
      await page.setViewportSize({ width: 1280, height: 860 });
      // A named user keeps the preview from writing its own CSRF cookie.
      await page.goto(
        `${PORTAL}/chat-preview.html?organisation=${this.fixtures.organisationId}&preferenceUser=${owner.userId}`,
      );
      await page.getByRole("link", { name: "Ask", exact: true }).click();
      await page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await page.getByRole("tab", { name: "Chats", exact: true }).waitFor();

      // 1. The agent proposes a side Case while it answers. Nothing starts.
      const composer = page.getByPlaceholder(/^Ask anything/u);
      await composer.fill(QUESTION);
      await composer.press("Enter");
      await page
        .getByText(ANSWER, { exact: true })
        .waitFor({ timeout: 90_000 });
      const card = page.getByRole("article", { name: TITLE, exact: true });
      await card.waitFor({ timeout: 30_000 });
      this.check(
        "The card waits for a person",
        (await card.getByRole("status").first().textContent())?.includes(
          "Proposed",
        ) &&
          (await card
            .getByRole("button", { name: "Start in a subthread", exact: true })
            .isVisible()) &&
          (await card
            .getByRole("button", { name: "Do it here", exact: true })
            .isVisible()),
      );
      const before = await page.request
        .get(`${WORKER}/test/model`)
        .then((response) => response.json());
      this.check(
        "No side Case turn runs before Start",
        !before.modelRequests.some((request) => request.turn === "side_case"),
        before.modelRequests,
      );
      await this.capture("01-card-proposed");

      // 2. The owner starts it. The card links to the new chat.
      await card
        .getByRole("button", { name: "Start in a subthread", exact: true })
        .click();
      const open = card.getByRole("link", { name: "Open chat", exact: true });
      await open.waitFor({ timeout: 30_000 });
      this.check(
        "The card says that the side Case started",
        (await card.getByRole("status").first().textContent())?.includes(
          "Started",
        ),
      );

      // 3. The sidebar shows the new chat one level in, under its source.
      await page
        .locator('.chat-organizer-row[data-side-case="true"]', {
          hasText: TITLE,
        })
        .waitFor({ timeout: 30_000 });
      const rows = await this.sidebarRows();
      const source = rows.findIndex(
        (row) => row.text.includes(QUESTION) && !row.sideCase,
      );
      const nested = rows.findIndex(
        (row) => row.text.includes(TITLE) && row.sideCase,
      );
      this.check(
        "The side Case shows under its source chat",
        source >= 0 &&
          nested === source + 1 &&
          rows[nested].left > rows[source].left,
        rows,
      );
      await this.capture("02-started-and-nested");

      // 4. The side Case runs with the brief and links back to its source.
      await open.click();
      await page
        .getByText(SIDE_ANSWER, { exact: true })
        .waitFor({ timeout: 90_000 });
      const back = page.getByRole("link", { name: /^Proposed in /u });
      await back.waitFor();
      this.check(
        "The side Case links to its source chat",
        (await back.textContent())?.includes(QUESTION),
        await back.textContent(),
      );
      const after = await page.request
        .get(`${WORKER}/test/model`)
        .then((response) => response.json());
      const sideTurns = after.modelRequests.filter(
        (request) => request.turn === "side_case",
      );
      this.check(
        "The side Case holds no turn of its source chat",
        sideTurns.length === 1 &&
          JSON.stringify(sideTurns[0].historyRoles) ===
            JSON.stringify(["system", "user"]),
        sideTurns,
      );
      await this.capture("03-side-case-chat");

      // 5. Back in the source chat, the card says Started.
      await back.click();
      const again = page.getByRole("article", { name: TITLE, exact: true });
      await again
        .getByRole("link", { name: "Open chat", exact: true })
        .waitFor();
      await this.capture("04-back-in-source");

      return {
        result: "passed",
        organisationId: this.fixtures.organisationId,
        modelTurns: after.modelRequests.length,
        checks: this.checks,
        captures: this.captures,
      };
    }
  }

  const journey = new SideCaseJourney(
    page,
    JOURNEY_FIXTURES,
    JOURNEY_ARTIFACTS,
  );
  try {
    return await journey.run();
  } catch (error) {
    await journey.capture("failure").catch(() => undefined);
    return {
      result: "failed",
      error: String(error),
      checks: journey.checks,
      captures: journey.captures,
    };
  }
};
