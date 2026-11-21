async (page) => {
  // The agent runs the Kitchen shift in a browser, against a local
  // Worker with its own D1 (Plan 81).
  //
  // The owner opens the Financier morning shift: 3 batches, 3 late. The owner
  // asks the chat to run the shift with two batches and to step and play it.
  // The agent runs it through the page's own Apply changes path: the page
  // shows 2 late and Batches 2, the clock moves and keeps moving, and the
  // chat shows the receipt of the run. Then the owner types a Workers value
  // without applying it and asks for a re-run. The page refuses the agent's
  // run as it must: the typed value and the run stay as they were, and the
  // chat shows the refusal.
  //
  // A model answer in prose is the answer: the shift runs one time. One message
  // can still take two model steps after an invalid action. The second step
  // must see the draft that the first step's run left, so an unchanged draft
  // is not refused. A draft that the owner changes while the agent works is
  // refused.
  //
  // Then the agent opens a financier production run from the shift and
  // applies a reviewed draft to a new run. With --robot-review, it first
  // simulates and accepts one robot step, and its apply opens the owner's
  // replacement review instead.
  //
  // Setup: POST /test/setup. The model provider is simulated; it only
  // answers with the next tool call of a fixed script.
  const WORKER = "http://127.0.0.1:8881";
  const PORTAL = "http://127.0.0.1:3181";
  const RUN =
    "Run the shift with two financier batches, then step to the next event and play it.";
  const RERUN = "Re-run the shift with the applied inputs.";
  const RUN_ANSWER =
    "I ran the shift with two financier batches, stepped to the next event and started playback.";
  const RUN_RECEIPT =
    "Ran the Kitchen shift from 06:00 with playback reset. Nothing was saved.";
  const UNAPPLIED = "The operator has unapplied input changes.";
  const IN_PROSE = "Run the shift and answer in your own words.";
  const PROSE_ANSWER = "The shift ran. The page shows 2 batches late.";
  const OBSERVED = "Re-run the shift from the draft that you can see.";
  const OBSERVED_ANSWER = "I re-ran the shift from the draft that I can see.";
  const WHILE_EDITED = "Run the shift while I change an input.";
  const QUEUE_FIRST = "Run the shift while I queue another request.";
  const QUEUE_FIRST_ANSWER = "I ran the shift. Your queued request is next.";
  const QUEUE_SECOND =
    "Then run the shift once more from the draft that you see.";
  const QUEUE_SECOND_ANSWER = "I ran the shift again from the newest draft.";
  const DRAFT_CHANGED = "The Kitchen draft changed.";
  const LAYOUT =
    "Select the cooling station, turn the cooling rack a quarter turn and compare the oven outage.";
  const OPEN = "Open the financier production run with the procedure inputs.";
  const OPEN_ANSWER =
    "I opened the financier production run with the procedure inputs.";
  const SIMULATE = "Simulate the next robot step and accept its result.";
  const SIMULATE_ANSWER =
    "I simulated the next robot step and accepted its result.";
  const APPLY =
    "Plan for an oven outage, preview it and apply it as a new run.";
  const APPLIED_ANSWER = "I applied the oven-outage preview as a new run.";
  const REVIEW_ANSWER =
    "The run holds an accepted result, so the replacement waits for your review in Edit scenario.";
  const LAYOUT_ANSWER =
    "I selected Cooling, turned the cooling rack a quarter turn and opened the oven-outage comparison.";
  const FLOOR_PLAN =
    "Switch the floor plan to Kinshicho, apply the Parisian Noix interior, open the toilet door, move the cooling rack to (100, -200) mm at 45 degrees and undo that angle.";
  const FLOOR_PLAN_ANSWER =
    "I switched to Kinshicho, applied the Parisian Noix interior, opened the toilet door, moved the cooling rack to (100, -200) mm, turned it to 45 degrees and undid the angle.";
  const FLOOR_PLAN_RESET = "Reset the floor plan to its initial layout.";
  const FLOOR_PLAN_RESET_ANSWER =
    "I reset the floor plan to its initial layout.";
  const MEMBER_FLOOR_PLAN = "As a member, switch the floor plan to Kinshicho.";
  const MEMBER_REFUSED_ANSWER =
    "Only an owner or administrator can control the Kitchen floor plan.";

  async function expectHolding(journey) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if ((await journey.model()).holding) return;
      await journey.owner.waitForTimeout(200);
    }
    throw new Error("The model did not reach the run");
  }

  function seconds(clock) {
    const [hours, minutes, rest] = clock.split(":").map(Number);
    return hours * 3600 + minutes * 60 + rest;
  }

  class KitchenRunJourney {
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
      await this.owner.screenshot({ path });
      this.captures.push(`${name}.png`);
    }
    clock() {
      return this.owner
        .getByRole("status", { name: "Simulated time" })
        .or(this.owner.locator('output[aria-label="Simulated time"]'))
        .first()
        .textContent();
    }
    playing() {
      return this.owner
        .locator(
          ".playback-toggle .playback-toggle-labels span[data-visible=true]",
        )
        .first()
        .textContent();
    }
    lateBadge(count) {
      return this.owner.getByRole("button", {
        name: `View delays: ${count} late`,
        exact: true,
      });
    }
    async expand(name) {
      const triggers = this.owner.getByRole("button", { name });
      for (let index = 0; index < (await triggers.count()); index += 1) {
        const trigger = triggers.nth(index);
        if ((await trigger.getAttribute("aria-expanded")) !== "true")
          await trigger.click();
      }
    }
    // The chat folds each step into an Activity group, and each step's
    // receipt into the step. The owner opens both.
    async chatText() {
      await this.expand(/^Activity · Kitchen/u);
      await this.expand(
        /^(Run Kitchen shift|Select in Kitchen|Rotate Kitchen equipment|Angle Kitchen equipment|Move Kitchen equipment|Open Kitchen door or window|Close Kitchen door or window|Switch Kitchen floor plan|Configure Kitchen interior|Reset Kitchen floor plan|Compare Kitchen shifts|Open Kitchen production|Accept Kitchen recording|Apply Kitchen production preview)/u,
      );
      return this.owner.locator("body").innerText();
    }
    async openInputs() {
      const field = this.owner.locator("#workflow-field-batchCount");
      if (await field.isVisible()) return;
      await this.owner
        .getByRole("button", { name: "Inputs", exact: true })
        .dispatchEvent("click");
      await field.waitFor({ timeout: 10_000 });
    }
    async openDock(name) {
      const toggle = this.owner
        .getByRole("button", { name, exact: true })
        .first();
      if ((await toggle.getAttribute("aria-expanded")) !== "true")
        await toggle.click();
    }
    // The cooling rack's outline on the Floor plan, as width over height.
    async rackShape() {
      await this.openDock("Floor plan");
      const outline = this.owner.locator('[data-footprint="cool"]').first();
      await outline.waitFor({ timeout: 10_000 });
      const box = await outline.boundingBox();
      return box === null ? null : box.width / box.height;
    }
    // An answer of the agent, or the refusal it relays from Kitchen.
    async answer(text, timeout) {
      const refusals = this.owner.getByText(/^Kitchen refused the run:/u);
      const before = await refusals.count();
      const answered = this.owner.getByText(text, { exact: true });
      await answered.or(refusals.nth(before)).first().waitFor({ timeout });
      // A finished answer and its streaming copy can both show for a moment.
      if (!(await answered.first().isVisible()))
        throw new Error(await refusals.nth(before).innerText());
    }
    // 9. With no result in the run, the agent's apply starts the reviewed
    // draft as a new run at once, as the Apply button does.
    async applyWithoutResults() {
      const page = this.owner;
      await this.ask(APPLY);
      await this.answer(APPLIED_ANSWER, 120_000);
      await page
        .getByText("Preview applied. New native requests are ready in Files.", {
          exact: true,
        })
        .waitFor({ timeout: 30_000 });
      this.check(
        "The draft runs as a new run with no review",
        !(await page
          .getByRole("region", {
            name: "Review production replacement",
            exact: true,
          })
          .isVisible()),
      );
      const afterApply = await this.chatText();
      this.check(
        "The chat shows the open and the apply with receipts",
        afterApply.includes("Open Kitchen production") &&
          afterApply.includes("Apply Kitchen production preview") &&
          afterApply.includes(
            "Applied the reviewed preview as a fresh production run.",
          ),
        afterApply.slice(-2_500),
      );
      await this.capture("10-preview-applied");
    }
    // 9. The agent simulates one robot step in browser MuJoCo and accepts
    // it. Over that accepted result, its apply opens the Apply button's
    // replacement review, and the run waits for the owner's confirmation.
    async reviewOverAcceptedResult() {
      const page = this.owner;
      await this.ask(SIMULATE);
      await this.answer(SIMULATE_ANSWER, 300_000);
      await this.ask(APPLY);
      await this.answer(REVIEW_ANSWER, 120_000);
      const review = page.getByRole("region", {
        name: "Review production replacement",
        exact: true,
      });
      this.check(
        "The owner sees the replacement review in context",
        (await review.isVisible()) &&
          (await review.innerText()).includes(
            "This replaces 1 accepted results",
          ),
        await review.innerText(),
      );
      const afterApply = await this.chatText();
      this.check(
        "The chat shows the open, the accepted result and the waiting apply",
        afterApply.includes("Open Kitchen production") &&
          afterApply.includes("Accept Kitchen recording") &&
          afterApply.includes(
            "waits for the operator's review in Edit scenario",
          ),
        afterApply.slice(-2_500),
      );
      await review.scrollIntoViewIfNeeded();
      await this.capture("10-replacement-review");
      await review
        .getByRole("button", {
          name: "Confirm production replacement",
          exact: true,
        })
        .click();
      await page
        .getByText(
          "Replacement applied. New native requests are ready in Files.",
          { exact: true },
        )
        .waitFor({ timeout: 30_000 });
      this.check(
        "The owner's confirmation replaces the run",
        !(await review.isVisible()),
      );
      await this.capture("11-replacement-confirmed");
    }
    // Send only to an idle chat; a message sent while a turn closes queues
    // as steering instead.
    async ask(text) {
      await this.owner
        .getByRole("button", { name: "Send message", exact: true })
        .waitFor({ timeout: 60_000 });
      const composer = this.owner.getByPlaceholder(/^Ask anything/u);
      await composer.fill(text);
      await composer.press("Enter");
    }
    // A message that waits in the queue while the agent works.
    async queue(text) {
      const composer = this.owner.getByPlaceholder(/^Ask anything/u);
      await composer.fill(text);
      await composer.press("Enter");
      await this.owner
        .getByRole("button", { name: `Steer now: ${text.slice(0, 60)}` })
        .waitFor({ timeout: 30_000 });
    }
    async model() {
      return this.owner.request
        .get(`${WORKER}/test/model`)
        .then((response) => response.json());
    }
    // 3. The agent runs from its observation and answers in prose. The chat
    // shows that answer, and the one message runs the shift one time.
    async answerInProse() {
      await this.ask(IN_PROSE);
      await this.owner
        .getByText(PROSE_ANSWER, { exact: true })
        .waitFor({ timeout: 120_000 });
      // A second step would start after the answer, so wait for an idle chat.
      await this.owner
        .getByRole("button", { name: "Send message", exact: true })
        .waitFor({ timeout: 60_000 });
      const requests = (await this.model()).modelRequests.filter(
        (request) => request.turn === "in-prose",
      );
      this.check(
        "A prose answer ends the message after one run",
        requests.filter(
          (request) => request.call === "bakery_surface_run_shift",
        ).length === 1,
        requests,
      );
      await this.capture("03-prose-answer-one-run");
    }
    // 4. One message, two model steps: the agent runs from its observation
    // and gives an invalid action, so the chat asks again. The draft did not
    // change, so the second step's run passes with no refusal and no draft
    // read.
    async runInTwoSteps() {
      const page = this.owner;
      await this.ask(OBSERVED);
      await this.answer(OBSERVED_ANSWER, 120_000);
      const calls = (await this.model()).modelRequests.filter(
        (request) => request.turn === "observed" && request.call !== undefined,
      );
      const runs = calls.filter(
        (request) => request.call === "bakery_surface_run_shift",
      );
      this.check(
        "Each step ran the shift from its observation, with no draft read",
        runs.length === 2 &&
          !calls.some(
            (request) => request.call === "bakery_surface_read_draft",
          ),
        calls,
      );
      this.check(
        "The second step saw the draft of the first step's run",
        runs[1].args.baseDraft.revision ===
          runs[0].args.baseDraft.revision + 1 &&
          runs[1].args.baseDraft.digest === runs[0].args.baseDraft.digest,
        runs,
      );
      const chat = await this.chatText();
      this.check(
        "The chat shows no refusal for an unchanged draft",
        !chat.includes(DRAFT_CHANGED),
        chat.slice(-2_000),
      );
      await this.openInputs();
      this.check(
        "The run stays at Batches 2, 2 late",
        (await page.locator("#workflow-field-batchCount").inputValue()) ===
          "2" && (await this.lateBadge(2).isVisible()),
      );
      await this.capture("04-two-steps-no-refusal");
    }
    // 4b. The owner queues a second message while the agent runs the shift.
    // That message captured the page before the run. When it starts, the
    // agent runs from the draft of the first run's receipt, so the page
    // accepts it.
    async runQueued() {
      const page = this.owner;
      await this.ask(QUEUE_FIRST);
      await expectHolding(this);
      await this.queue(QUEUE_SECOND);
      await page.request.post(`${WORKER}/test/model/release`);
      await this.answer(QUEUE_FIRST_ANSWER, 120_000);
      await this.answer(QUEUE_SECOND_ANSWER, 120_000);
      const runs = (await this.model()).modelRequests.filter(
        (request) =>
          request.call === "bakery_surface_run_shift" &&
          (request.turn === "queue-first" || request.turn === "queue-second"),
      );
      this.check(
        "The queued message ran from the draft of the first run",
        runs.length === 2 &&
          runs[1].args.baseDraft.revision ===
            runs[0].args.baseDraft.revision + 1,
        runs,
      );
      const chat = await this.chatText();
      this.check(
        "The chat shows no refusal for the queued message",
        !chat.includes(DRAFT_CHANGED),
        chat.slice(-2_000),
      );
      await this.capture("04b-queued-message-fresh-draft");
    }
    // 5. The owner changes an input after the message was sent and before the
    // run reaches the page. The observation is old, so the page refuses it.
    async runWhileEdited() {
      const page = this.owner;
      await this.ask(WHILE_EDITED);
      await expectHolding(this);
      await this.openInputs();
      await page.locator("#workflow-field-workerCount").fill("3");
      await page.request.post(`${WORKER}/test/model/release`);
      await page
        .getByText(`Kitchen refused the run: ${DRAFT_CHANGED}`, {
          exact: false,
        })
        .waitFor({ timeout: 120_000 });
      await this.openInputs();
      this.check(
        "The owner's change stays after the refusal",
        (await page.locator("#workflow-field-workerCount").inputValue()) ===
          "3",
        await page.locator("#workflow-field-workerCount").inputValue(),
      );
      this.check(
        "The refused run changed nothing: Batches 2, 2 late",
        (await page.locator("#workflow-field-batchCount").inputValue()) ===
          "2" && (await this.lateBadge(2).isVisible()),
      );
      await this.capture("05-edited-draft-refused");
    }
    async run() {
      const page = this.owner;
      const session = await page.request.post(
        `${WORKER}/test/session?user=Owner`,
      );
      if (!session.ok()) throw new Error("Session failed for Owner");
      const owner = await session.json();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(
        `${PORTAL}/kitchen-chat-preview.html?organisation=${this.fixtures.organisationId}&preferenceUser=${owner.userId}`,
      );

      // 1. The owner sees the Financier morning shift before the agent acts.
      await page
        .getByRole("button", { name: /Play shift/u })
        .first()
        .waitFor({ timeout: 60_000 });
      await this.lateBadge(3).waitFor({ timeout: 30_000 });
      this.check(
        "The shift starts at 06:00:00",
        (await this.clock()) === "06:00:00",
        await this.clock(),
      );
      await this.openInputs();
      this.check(
        "The shift starts with three batches",
        (await page.locator("#workflow-field-batchCount").inputValue()) === "3",
        await page.locator("#workflow-field-batchCount").inputValue(),
      );
      await this.capture("01-before");

      // 2. The agent runs the shift with two batches, steps it and plays it.
      await this.ask(RUN);
      await page
        .getByText(RUN_ANSWER, { exact: true })
        .waitFor({ timeout: 120_000 });
      await this.lateBadge(2).waitFor({ timeout: 10_000 });
      this.check(
        "The page shows the new run: 2 late",
        await this.lateBadge(2).isVisible(),
      );
      this.check("The old run is gone", !(await this.lateBadge(3).isVisible()));
      await this.openInputs();
      this.check(
        "Inputs show the applied batches",
        (await page.locator("#workflow-field-batchCount").inputValue()) === "2",
        await page.locator("#workflow-field-batchCount").inputValue(),
      );
      const first = await this.clock();
      await page.waitForTimeout(1_500);
      const second = await this.clock();
      this.check(
        "Playback moved past 06:00 and keeps moving",
        seconds(first) > seconds("06:00:00") &&
          seconds(second) > seconds(first),
        { first, second },
      );
      this.check(
        "The play control shows Pause",
        (await this.playing()) === "Pause",
        await this.playing(),
      );
      const afterRun = await this.chatText();
      this.check(
        "The chat shows the run and its receipt",
        afterRun.includes("Run Kitchen shift") &&
          afterRun.includes(RUN_RECEIPT),
        afterRun.slice(-2_000),
      );
      await this.capture("02-agent-ran-and-played");

      await page
        .getByRole("button", { name: "Pause", exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await this.answerInProse();
      await this.runInTwoSteps();
      await this.runQueued();
      await this.runWhileEdited();

      // 6. The owner's typed value is still not applied. The agent reads the
      // draft and re-runs: the page refuses, and the value and the run stay.
      await this.ask(RERUN);
      await page
        .getByText(`Kitchen refused the run: ${UNAPPLIED}`, {
          exact: false,
        })
        .waitFor({ timeout: 120_000 });
      await this.openInputs();
      this.check(
        "The owner's unapplied value stays",
        (await page.locator("#workflow-field-workerCount").inputValue()) ===
          "3",
        await page.locator("#workflow-field-workerCount").inputValue(),
      );
      this.check(
        "The run is unchanged: Batches 2, 2 late",
        (await page.locator("#workflow-field-batchCount").inputValue()) ===
          "2" && (await this.lateBadge(2).isVisible()),
      );
      const afterRefusal = await this.chatText();
      this.check(
        "The chat shows the refused run",
        afterRefusal.includes(UNAPPLIED),
        afterRefusal.slice(-2_000),
      );
      await this.capture("06-refused-rerun");

      // 7. The agent selects the cooling station, turns its rack and compares
      // the oven outage, as the Details chip, Rotate 90° and Compare shifts do.
      const before = await this.rackShape();
      await this.ask(LAYOUT);
      await page
        .getByText(LAYOUT_ANSWER, { exact: true })
        .waitFor({ timeout: 120_000 });
      const comparison = page.getByRole("region", {
        name: "Comparison",
        exact: true,
      });
      this.check(
        "Compare shifts shows the oven outage",
        (await comparison.isVisible()) &&
          (await comparison
            .getByRole("button", { name: "Compare oven outage" })
            .getAttribute("aria-pressed")) === "true",
      );
      this.check(
        "The outage run starts at 06:00, paused",
        (await this.clock()) === "06:00:00" &&
          (await this.playing()) === "Play shift",
        { clock: await this.clock(), control: await this.playing() },
      );
      const afterLayout = await this.chatText();
      this.check(
        "The chat shows the three actions with receipts",
        afterLayout.includes("Select in Kitchen") &&
          afterLayout.includes("Rotate Kitchen equipment") &&
          afterLayout.includes("Compare Kitchen shifts") &&
          afterLayout.includes("Rotated cool 90 degrees"),
        afterLayout.slice(-2_500),
      );
      await this.capture("07-outage-comparison");
      await this.openDock("Details");
      const details = page.getByRole("region", {
        name: "Selection inspector",
        exact: true,
      });
      this.check(
        "Details opens on Equipment with Cooling selected",
        (await details
          .getByRole("tab", { name: "Equipment", exact: true })
          .getAttribute("aria-selected")) === "true" &&
          (await details.innerText()).includes("Cooling"),
        await details.innerText(),
      );
      const after = await this.rackShape();
      this.check(
        "The Floor plan shows the rack turned a quarter turn",
        before !== null && after !== null && (before - 1) * (after - 1) < 0,
        { before, after },
      );
      await this.capture("08-rack-turned");

      // 7b. The owner controls the room floor plan, store interior palette,
      // corridor door, equipment coordinates, free angle and undo/reset, while
      // a non-admin member stays refused.
      await this.ask(FLOOR_PLAN);
      await this.answer(FLOOR_PLAN_ANSWER, 120_000);
      await this.capture("08b-floor-plan-2d-kinshicho");
      await page
        .getByRole("button", { name: "3D view", exact: true })
        .click();
      this.check(
        "The room switcher shows Kinshicho 6992842011",
        await page
          .getByRole("button", {
            name: "Floor plan room: Kinshicho 6992842011 (25.0 m²)",
            exact: true,
          })
          .isVisible(),
      );
      await page
        .getByRole("button", {
          name: "Store interior design & materials",
          exact: true,
        })
        .click();
      const noixOption = page.getByRole("menuitemradio", {
        name: /Parisian Pâtisserie · Noix/u,
      });
      await noixOption.waitFor({ timeout: 10_000 });
      const parisiansChecked = await noixOption.getAttribute("aria-checked");
      this.check(
        "Store interior menu shows Parisian Noix active",
        parisiansChecked === "true",
        parisiansChecked,
      );
      await page.keyboard.press("Escape");
      await noixOption.waitFor({ state: "hidden", timeout: 10_000 });
      const afterFloorPlan = await this.chatText();
      this.check(
        "The chat shows floor-plan, interior, door, move, angle and undo receipts",
        afterFloorPlan.includes("Switch Kitchen floor plan") &&
          afterFloorPlan.includes("Configure Kitchen interior") &&
          afterFloorPlan.includes("Open Kitchen door or window") &&
          afterFloorPlan.includes("Move Kitchen equipment") &&
          afterFloorPlan.includes("Angle Kitchen equipment") &&
          afterFloorPlan.includes("Reset Kitchen floor plan") &&
          afterFloorPlan.includes("Rotated cool to 45°") &&
          afterFloorPlan.includes("Applied undo on the Kitchen floor plan"),
        afterFloorPlan.slice(-3_000),
      );
      await this.capture("08c-floor-plan-3d-noix");

      await this.ask(FLOOR_PLAN_RESET);
      await this.answer(FLOOR_PLAN_RESET_ANSWER, 120_000);
      this.check(
        "Reset restores Asakusabashi t101940",
        await page
          .getByRole("button", {
            name: "Floor plan room: Asakusabashi t101940 (34.7 m²)",
            exact: true,
          })
          .isVisible(),
      );

      const memberContext = await page
        .context()
        .browser()
        .newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const memberPage = await memberContext.newPage();
        const memberSession = await memberPage.request.post(
          `${WORKER}/test/session?user=Member`,
        );
        if (!memberSession.ok()) throw new Error("Session failed for Member");
        const member = await memberSession.json();
        await memberPage.goto(
          `${PORTAL}/kitchen-chat-preview.html?organisation=${this.fixtures.organisationId}&preferenceUser=${member.userId}`,
        );
        await memberPage
          .getByRole("button", { name: /Play shift/u })
          .first()
          .waitFor({ timeout: 60_000 });
        const csrfHeaders = {
          origin: PORTAL,
          "content-type": "application/json",
          "x-satyr-csrf": member.csrfToken,
        };
        const directPortalChat = await memberPage.request.post(
          `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}/chat`,
          {
            headers: csrfHeaders,
            data: {
              kind: "message",
              conversationId: "conv_00000000-0000-4000-8000-000000000081",
              requestId: "request_member_portal_chat",
              model: "moonshotai/kimi-k3",
              text: MEMBER_FLOOR_PLAN,
              browserContext: { kind: "unavailable" },
            },
          },
        );
        this.check(
          "General Portal chat refuses a non-admin operator",
          directPortalChat.status() === 404 &&
            (await memberPage
              .getByRole("button", { name: "Send message", exact: true })
              .count()) === 0,
          { status: directPortalChat.status() },
        );
        const canvasPath = `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}/collaboration/workflow-canvas/${encodeURIComponent(this.fixtures.canvasDocumentId)}/chat`;
        const openedCanvas = await memberPage.request.post(canvasPath, {
          headers: csrfHeaders,
        });
        if (!openedCanvas.ok())
          throw new Error(
            `Canvas chat open failed: ${openedCanvas.status()} ${await openedCanvas.text()}`,
          );
        const { conversationId: canvasConversationId } =
          await openedCanvas.json();
        const canvasSent = await memberPage.request.post(
          `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}/chat?canvas=${encodeURIComponent(this.fixtures.canvasDocumentId)}`,
          {
            headers: csrfHeaders,
            data: {
              kind: "message",
              conversationId: canvasConversationId,
              requestId: "request_member_canvas_floor_plan",
              model: "moonshotai/kimi-k3",
              text: MEMBER_FLOOR_PLAN,
              browserContext: {
                kind: "available",
                binding: {
                  browserInstanceId: "browser_member_canvas",
                  conversationId: canvasConversationId,
                },
              },
            },
          },
        );
        if (!canvasSent.ok())
          throw new Error(
            `Canvas chat send failed: ${canvasSent.status()} ${await canvasSent.text()}`,
          );
        let canvasAnswered = false;
        const canvasDeadline = Date.now() + 60_000;
        while (Date.now() < canvasDeadline) {
          const poll = await memberPage.request.get(canvasPath);
          if (poll.ok()) {
            const payload = await poll.json();
            if (
              payload?.conversation?.work?.kind === "ready" &&
              JSON.stringify(payload.conversation).includes(
                MEMBER_REFUSED_ANSWER,
              )
            ) {
              canvasAnswered = true;
              break;
            }
          }
          await memberPage.waitForTimeout(250);
        }
        const effectsQuery = `browserInstanceId=browser_member_canvas&conversationId=${encodeURIComponent(canvasConversationId)}`;
        const memberEffectsResponse = await memberPage.request.get(
          `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}/chat/surface-effects?${effectsQuery}`,
        );
        const memberEffects = await memberEffectsResponse.json();
        const ownerEffects = await page.request
          .get(
            `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}/chat/surface-effects?${effectsQuery}`,
          )
          .then((res) => res.json());
        this.check(
          "A non-admin member stays refused and the room stays Asakusabashi",
          canvasAnswered &&
            memberEffectsResponse.status() === 404 &&
            memberEffects?.error === "organisation_role_insufficient" &&
            Array.isArray(ownerEffects.effects) &&
            ownerEffects.effects.length === 0 &&
            (await memberPage
              .getByRole("button", {
                name: "Floor plan room: Asakusabashi t101940 (34.7 m²)",
                exact: true,
              })
              .isVisible()),
          {
            canvasAnswered,
            memberStatus: memberEffectsResponse.status(),
            memberEffects,
            ownerEffects,
          },
        );
        const memberShot = `${this.artifacts}/08d-member-floor-plan-refused.png`;
        await memberPage.screenshot({ path: memberShot });
        this.captures.push("08d-member-floor-plan-refused.png");
      } finally {
        await memberContext.close();
      }

      // 8. The agent opens a financier production run from the shift, as the
      // recipe catalog does, then simulates one robot step in browser MuJoCo
      // and accepts its result.
      await this.ask(OPEN);
      await this.answer(OPEN_ANSWER, 120_000);
      const runInBrowser = page.getByRole("button", {
        name: "Run in browser",
        exact: true,
      });
      await runInBrowser.waitFor({ timeout: 60_000 });
      this.check(
        "The financier production run is open",
        await page
          .getByRole("navigation", { name: "Production workcell views" })
          .isVisible(),
      );
      await this.capture("09-production-open");
      if (JOURNEY_ROBOT_REVIEW) await this.reviewOverAcceptedResult();
      else await this.applyWithoutResults();

      const model = await this.model();
      const runs = model.modelRequests.filter(
        (request) => request.call === "bakery_surface_run_shift",
      );
      this.check("The agent asked for eight runs", runs.length === 8, runs);
      this.check(
        "The agent applied once and confirmed nothing",
        model.modelRequests.filter(
          (request) => request.call === "bakery_surface_apply_production",
        ).length === 1,
      );
      this.check(
        "The agent asked for one quarter turn",
        model.modelRequests.filter(
          (request) => request.call === "bakery_surface_rotate_equipment",
        ).length === 1,
      );
      this.check(
        "The agent ran all six floor-plan tools for the owner and zero for the member",
        model.modelRequests.filter(
          (request) => request.call === "bakery_surface_select_floor_plan",
        ).length === 1 &&
          model.modelRequests.filter(
            (request) => request.call === "bakery_surface_configure_interior",
          ).length === 1 &&
          model.modelRequests.filter(
            (request) => request.call === "bakery_surface_toggle_opening",
          ).length === 1 &&
          model.modelRequests.filter(
            (request) => request.call === "bakery_surface_move_equipment",
          ).length === 1 &&
          model.modelRequests.filter(
            (request) => request.call === "bakery_surface_set_equipment_angle",
          ).length === 1 &&
          model.modelRequests.filter(
            (request) => request.call === "bakery_surface_reset_floor_plan",
          ).length === 2 &&
          model.modelRequests.some(
            (request) =>
              request.turn === "member-floor-plan" &&
              request.answer === MEMBER_REFUSED_ANSWER &&
              request.surfaceToolsOffered === 0,
          ),
      );
      return {
        result: "passed",
        organisationId: this.fixtures.organisationId,
        clock: { first, second },
        rackShape: { before, after },
        robotReview: JOURNEY_ROBOT_REVIEW,
        modelRequests: model.modelRequests.length,
        checks: this.checks,
        captures: this.captures,
      };
    }
  }

  const journey = new KitchenRunJourney(
    page,
    JOURNEY_FIXTURES,
    JOURNEY_ARTIFACTS,
  );
  try {
    return await journey.run();
  } catch (error) {
    await journey.capture("failure").catch(() => undefined);
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    return {
      result: "failed",
      error: String(error),
      pageText: text.slice(-4_000),
      checks: journey.checks,
      captures: journey.captures,
    };
  }
};
