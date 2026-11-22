async (page) => {
  // The Memory loop in a browser, against a local Worker with its own D1.
  //
  // A supplier writes. The agent drafts a reply. The owner corrects it through
  // the reply review route. The agent proposes a memory from that correction.
  // The owner reviews it on the Brain page and accepts it. The supplier writes
  // again and the next reply uses the accepted revision. A second
  // administrator, who holds no grant on that mailbox, sees the same records:
  // Plan 27C makes agent mailboxes, Memory, Cases and Projects internal, so
  // every member of the Organisation reads them.
  //
  // Setup: POST /test/setup. Gmail and the model provider are simulated.
  const WORKER = "http://127.0.0.1:8842";
  const PORTAL = "http://127.0.0.1:3142";
  const LEARNED_FACT =
    "Next-day orders close at noon. Changes after noon are refused.";
  const CORRECTED_REPLY =
    "We cannot change tomorrow's order: orders for the next day close at noon.";
  const SUPPLIER = "Flour supplier <supplier@example.test>";
  const PROPOSED_FACT =
    "Next-day orders close at 2 pm. Changes after 2 pm are refused.";

  // The Portal Select (foundation/ui/select.tsx) is a button with role
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

  class BrainJourney {
    constructor(owner, fixtures, artifacts) {
      this.owner = owner;
      this.fixtures = fixtures;
      this.artifacts = artifacts;
      this.contexts = [];
      this.checks = [];
      this.captures = [];
    }
    check(name, passed, detail) {
      this.checks.push({ name, passed: Boolean(passed), detail });
      if (!passed)
        throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
    }
    url(path) {
      return `${WORKER}/v1/control/organisations/${this.fixtures.organisationId}${path}`;
    }
    async signIn(name, target) {
      const session = await target.request.post(
        `${WORKER}/test/session?user=${name}`,
      );
      if (!session.ok()) throw new Error(`Session failed for ${name}`);
      return target;
    }
    async peer(name) {
      const context = await this.owner
        .context()
        .browser()
        .newContext({ viewport: { width: 1200, height: 850 } });
      this.contexts.push(context);
      return this.signIn(name, await context.newPage());
    }
    async send(target, path, body) {
      const cookies = await target.context().cookies(WORKER);
      const csrf = cookies.find(
        (cookie) => cookie.name === "pantry_csrf",
      );
      if (!csrf) throw new Error("CSRF cookie missing");
      return target.request.fetch(this.url(path), {
        method: "POST",
        headers: {
          origin: PORTAL,
          "x-pantry-csrf": csrf.value,
          "idempotency-key": `brain-${Date.now()}-${Math.random()}`,
        },
        data: body,
      });
    }
    async memories(target) {
      const response = await target.request.get(this.url("/memories"));
      return { status: response.status(), body: await response.json() };
    }
    async read(target, path) {
      const response = await target.request.get(this.url(path));
      return { status: response.status(), body: await response.json() };
    }
    // Every page of one Case's execution, joined as the Portal joins them.
    async execution(target, caseId) {
      const nodes = [];
      const edges = [];
      const limitations = new Set();
      let pages = 0;
      let cursor = null;
      do {
        const read = await this.read(
          target,
          `/cases/${caseId}/execution${cursor === null ? "" : `?after=${cursor}`}`,
        );
        if (read.status !== 200)
          return { status: read.status, body: read.body, pages };
        nodes.push(...read.body.page.nodes);
        edges.push(...read.body.page.edges);
        for (const limitation of read.body.page.limitations)
          limitations.add(limitation);
        cursor = read.body.page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      return {
        status: 200,
        pages,
        nodes,
        edges,
        limitations: [...limitations].sort(),
      };
    }
    async state(query = "") {
      const response = await this.owner.request.get(
        `${WORKER}/test/mail/state${query}`,
      );
      if (!response.ok())
        throw new Error(`State returned ${response.status()}`);
      return response.json();
    }
    async until(read, accept, what) {
      const deadline = Date.now() + 60000;
      let last = null;
      while (Date.now() < deadline) {
        last = await read();
        if (accept(last)) return last;
        await this.owner.waitForTimeout(250);
      }
      throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)}`);
    }
    async arrive(notificationId, historyId, delay, message) {
      const response = await this.owner.request.post(
        `${WORKER}/test/mail/arrive`,
        { data: { notificationId, historyId, delay, messages: [message] } },
      );
      const outcome = await response.json();
      this.check(
        `mail admitted: ${message.id}`,
        outcome.admitted === 1,
        outcome,
      );
    }
    proposalOf(state, messageId) {
      return state.connector.proposals.find(
        (proposal) =>
          proposal.triggeringMessageId === messageId &&
          !proposal.proposalId.startsWith("proposal_ack_"),
      );
    }
    async capture(target, name) {
      const path = `${this.artifacts}/${name}.png`;
      await target.screenshot({ path, fullPage: true });
      this.captures.push(`${name}.png`);
    }
    async openBrain(target) {
      await target.goto(
        `${PORTAL}/brain-preview.html?organisation=${this.fixtures.organisationId}`,
      );
      await target
        .getByRole("heading", { name: "At a glance", exact: true })
        .waitFor();
      return target;
    }
    // A view of the Knowledge page. Each tab is a link, so its address opens
    // it. Activity is a page of its own (Agents), with no tab.
    tab(target, name) {
      return target
        .getByRole("navigation", { name: "Knowledge views" })
        .getByRole("link", { name, exact: true });
    }
    // The row of one memory. An eval can carry the same words in its title,
    // so the row is found by its kind too.
    row(target, statement) {
      return target
        .locator('a[id^="brain-row-memory-"]')
        .filter({ hasText: statement });
    }
    details(target) {
      return target.getByRole("region", { name: "Memory details" });
    }
    evalDetails(target) {
      return target.getByRole("region", { name: "Eval details" });
    }
    // Opens the first eval of the Evals view. The view lists the evals as
    // rows, and a row opens its record in place of the list.
    // The row is opened from the keyboard, as a person with no pointer does.
    async openEval(target) {
      await this.tab(target, "Tests").click();
      const row = target
        .getByRole("list", { name: "Evals", exact: true })
        .getByRole("link")
        .first();
      await row.focus();
      await target.keyboard.press("Enter");
      await this.evalDetails(target).getByRole("heading").first().waitFor();
      return this.evalDetails(target);
    }
    // The kinds of the Knowledge rail, each with its count.
    async rail(target) {
      return target
        .getByRole("navigation", { name: "Kinds of knowledge" })
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("aria-label")),
        );
    }
    // Opens one memory beside the Knowledge list.
    async openMemory(target, statement) {
      await this.tab(target, "Knowledge").click();
      await this.row(target, statement).first().click();
      await this.details(target)
        .getByRole("heading", { name: statement, exact: true })
        .waitFor();
      return this.details(target);
    }
    // The Knowledge entry of the Portal navigation, as a screen reader names it.
    async brainEntry(target) {
      return (
        await target
          .getByRole("navigation", { name: "Workspace pages", exact: true })
          .getByRole("link", { name: /^Knowledge/u })
          .first()
          .innerText()
      ).replace(/\s+/gu, " ");
    }
    async summary(target) {
      const response = await target.request.get(this.url("/brain/summary"));
      return { status: response.status(), body: await response.text() };
    }
    async close() {
      for (const context of this.contexts) await context.close();
    }

    async run() {
      await this.signIn("Owner", this.owner);

      // 1. The supplier writes, and the agent drafts a reply for review.
      await this.arrive("brain-first", 1000, 30001, {
        id: "order_change_one",
        threadId: "order_thread_one",
        from: SUPPLIER,
      });
      const drafted = await this.until(
        () => this.state(),
        (state) =>
          state.connector.replyTurnsOwed.length === 0 &&
          this.proposalOf(state, "order_change_one") !== undefined,
        "the first reply draft",
      );
      const first = this.proposalOf(drafted, "order_change_one");
      const firstPrompt = drafted.provider.modelRequests.find(
        (request) => request.turn === "reply",
      ).prompt;
      this.check(
        "the first reply was drafted with no memory in its prompt",
        !firstPrompt.includes("Accepted organizational memory") &&
          !firstPrompt.includes(LEARNED_FACT),
        { prompt: firstPrompt },
      );

      // 2. The owner corrects the draft through the reply review route.
      const review = await this.owner.request.get(
        this.url(`/email-replies/${first.proposalId}`),
      );
      const snapshot = await review.json();
      this.check("the owner reviews the draft", review.status() === 200, {
        status: review.status(),
      });
      const edited = await this.send(
        this.owner,
        `/email-replies/${first.proposalId}/edit`,
        {
          version: snapshot.proposal.version,
          snapshotDigest: snapshot.proposal.snapshot_digest,
          challenge: snapshot.challenge,
          body: CORRECTED_REPLY,
        },
      );
      const editResult = await edited.json();
      this.check(
        "the correction is saved as version 2",
        edited.status() === 200 && editResult.version === 2,
        editResult,
      );

      // 3. The agent proposes a memory from the correction. The owner finds
      // it on the Brain page, waiting for review.
      const proposed = await this.until(
        () => this.memories(this.owner),
        (listed) => listed.status === 200 && listed.body.memories.length === 1,
        "the agent's candidate",
      );
      const candidate = proposed.body.memories[0];
      const candidateRevision = candidate.revisions[0];
      this.check(
        "the candidate is the agent's, from the exact correction",
        candidateRevision.kind === "candidate" &&
          candidateRevision.proposedBy.kind === "agent" &&
          candidateRevision.statement === LEARNED_FACT &&
          candidateRevision.evidence[0].kind === "proposal_correction" &&
          candidateRevision.evidence[0].proposalId === first.proposalId &&
          candidateRevision.evidence[0].version === 2,
        candidateRevision,
      );
      // The same learning turn proposes an eval. The page is opened when
      // both wait, so the count of the navigation is the count of both.
      await this.until(
        () => this.read(this.owner, "/evals"),
        (evals) => evals.status === 200 && evals.body.evals.length === 1,
        "the proposed eval",
      );
      await this.openBrain(this.owner);
      await this.owner
        .getByText(LEARNED_FACT, { exact: true })
        .first()
        .waitFor();
      const waiting = this.owner.locator(
        'section[aria-labelledby="brain-review"]',
      );
      await this.capture(this.owner, "owner-candidate-waiting");
      const shown = {
        statements: await waiting
          .getByText(LEARNED_FACT, { exact: true })
          .count(),
        needsReview: await waiting
          .getByText("Needs review", { exact: true })
          .count(),
        rows: await this.row(waiting, LEARNED_FACT).count(),
      };
      // The Overview lists both that wait: the memory and its eval.
      this.check(
        "the Brain page lists the candidate as waiting for review",
        shown.statements >= 1 && shown.needsReview === 2 && shown.rows === 1,
        shown,
      );
      // The agent proposed an eval with the memory, so two items wait.
      const ownerSummary = await this.summary(this.owner);
      await this.owner
        .getByRole("link", { name: "Knowledge, 2 to review", exact: true })
        .waitFor();
      this.check(
        "the navigation counts what waits for the owner",
        ownerSummary.status === 200 &&
          ownerSummary.body ===
            '{"ok":true,"summary":{"memoriesToReview":1,"evalsToReview":1}}',
        { ownerSummary, entry: await this.brainEntry(this.owner) },
      );
      const ownerStatus = {
        line: await this.owner.locator("#brain-status-line").innerText(),
        latest: await this.owner.locator(".brain-status-latest").innerText(),
      };
      this.check(
        "the Overview says how many items wait, and names the latest event",
        ownerStatus.line === "2 items wait for your decision." &&
          ownerStatus.latest.startsWith("Latest") &&
          ownerStatus.latest.includes("proposed"),
        ownerStatus,
      );

      // 4. A second administrator holds no grant on that mailbox. Plan 27C
      // makes an agent mailbox and Memory internal, so this administrator
      // reads the same candidate, count and Overview as the owner.
      const other = await this.peer("Other");
      const shared = await this.memories(other);
      this.check(
        "the other administrator reads the same candidate",
        shared.status === 200 &&
          shared.body.memories.length === 1 &&
          shared.body.memories[0].memoryId === candidate.memoryId,
        shared,
      );
      await this.openBrain(other);
      await this.row(other, LEARNED_FACT).first().waitFor();
      const otherSummary = await this.summary(other);
      await other
        .getByRole("link", { name: "Knowledge, 2 to review", exact: true })
        .waitFor();
      this.check(
        "the other administrator's navigation counts the same items",
        otherSummary.status === 200 && otherSummary.body === ownerSummary.body,
        otherSummary,
      );
      const otherStatus = await other.locator("#brain-status-line").innerText();
      this.check(
        "the other administrator's Overview says the same",
        otherStatus === ownerStatus.line,
        otherStatus,
      );
      await this.capture(other, "other-administrator-shared");
      // The Knowledge view lists four kinds. Both administrators read the
      // memory, the eval and the same agents, which the Agents page owns.
      await this.tab(this.owner, "Knowledge").click();
      await this.row(this.owner, LEARNED_FACT).first().waitFor();
      await this.tab(other, "Knowledge").click();
      await this.row(other, LEARNED_FACT).first().waitFor();
      const ownerRail = await this.rail(this.owner);
      const otherRail = await this.rail(other);
      this.check(
        "the Knowledge rail counts each kind that a person may read",
        ownerRail.length === 4 &&
          ownerRail[0] === "Memory, 1 record" &&
          ownerRail[1] === "Evals, 1 record" &&
          JSON.stringify(otherRail) === JSON.stringify(ownerRail),
        { ownerRail, otherRail },
      );
      await this.capture(this.owner, "owner-knowledge");
      await this.capture(other, "other-admin-knowledge");
      await this.tab(this.owner, "Overview").click();

      // 5. The owner opens it from the Overview and accepts it. The row
      // opens the memory beside the Knowledge list, and the address names
      // it, so the same link opens the same memory.
      await this.row(waiting, LEARNED_FACT).first().click();
      const memoryDetails = this.details(this.owner);
      await memoryDetails
        .getByRole("heading", { name: LEARNED_FACT, exact: true })
        .waitFor();
      const opened = new URL(this.owner.url()).searchParams;
      const focused = await this.owner.evaluate(
        () => document.activeElement?.id ?? null,
      );
      this.check(
        "a row opens the memory beside the list, and the address names it",
        opened.get("view") === "knowledge" &&
          opened.get("memory") === candidate.memoryId &&
          focused === "brain-memory-detail-title",
        { ...Object.fromEntries(opened), focused },
      );
      await this.owner.reload();
      await memoryDetails
        .getByRole("button", { name: "Accept", exact: true })
        .waitFor();
      await this.capture(this.owner, "owner-memory-detail");
      await memoryDetails
        .getByRole("button", { name: "Accept", exact: true })
        .click();
      await this.owner
        .getByText("Accepted. The agent uses this memory where it applies.", {
          exact: true,
        })
        .waitFor();
      await this.capture(this.owner, "owner-accepted");
      const accepted = await this.memories(this.owner);
      const acceptedRevision = accepted.body.memories[0].revisions[0];
      this.check(
        "the stored revision is accepted",
        acceptedRevision.kind === "accepted" && acceptedRevision.revision === 1,
        acceptedRevision,
      );
      await memoryDetails.getByText("In use", { exact: true }).waitFor();
      await this.owner
        .getByRole("link", { name: "Knowledge, 1 to review", exact: true })
        .waitFor();
      this.check(
        "the navigation count follows the decision",
        (await this.summary(this.owner)).body ===
          '{"ok":true,"summary":{"memoriesToReview":0,"evalsToReview":1}}',
        await this.brainEntry(this.owner),
      );
      await this.capture(this.owner, "owner-memory-in-use");
      const otherAccepted = await this.memories(other);
      this.check(
        "the other administrator reads the accepted revision",
        otherAccepted.status === 200 &&
          otherAccepted.body.memories[0]?.revisions[0]?.kind === "accepted",
        otherAccepted,
      );

      // 6. The supplier writes again. The reply to that message uses the
      // accepted revision.
      await this.arrive("brain-second", 1002, 120000, {
        id: "order_change_two",
        threadId: "order_thread_two",
        from: SUPPLIER,
      });
      const replied = await this.until(
        () => this.state("?thread=order_thread_two&message=order_change_two"),
        (state) =>
          state.connector.replyTurnsOwed.length === 0 &&
          this.proposalOf(state, "order_change_two") !== undefined,
        "the second reply draft",
      );
      const record = replied.turnMemory.ok ? replied.turnMemory.value[0] : null;
      this.check(
        "the fresh turn recorded the exact accepted revision",
        record !== null &&
          record.outcome.kind === "admitted" &&
          record.outcome.revisions.length === 1 &&
          record.outcome.revisions[0].memoryId === candidate.memoryId &&
          record.outcome.revisions[0].revision === 1 &&
          record.shown.kind === "admitted",
        replied.turnMemory,
      );
      const freshPrompt = replied.provider.modelRequests
        .filter((request) => request.turn === "reply")
        .find((request) => request.prompt.includes("order_thread_two")).prompt;
      this.check(
        "the model was shown the accepted statement with its request",
        // Each line cites its memory, so a reply can name what it used.
        freshPrompt.startsWith(
          "Accepted organizational memory (reviewed facts and preferences):\n" +
            `- [memory:${candidate.memoryId}] ${LEARNED_FACT}`,
        ),
        { prompt: freshPrompt },
      );
      const second = this.proposalOf(replied, "order_change_two");
      const draft = replied.provider.drafts.find(
        (held) => held.threadId === "order_thread_two",
      );
      this.check(
        "the fresh reply is a draft to the verified supplier that follows the memory",
        second.state === "awaiting_approval" &&
          draft !== undefined &&
          draft.to === "supplier@example.test" &&
          draft.body.includes("closed at noon"),
        { proposal: second, draft },
      );

      // 7. With the memory, the agent proposed an eval: one message that
      // tests the fact. The owner finds it on the Evals view and accepts it.
      await this.openBrain(this.owner);
      const proposedEvals = await this.read(this.owner, "/evals");
      const proposedEval = proposedEvals.body.evals[0];
      // Its row in the Knowledge list opens the Evals view at that eval.
      await this.tab(this.owner, "Knowledge").click();
      await this.owner
        .getByRole("list", { name: "Evals", exact: true })
        .getByRole("link")
        .first()
        .click();
      await this.owner
        .getByRole("button", { name: "Accept these scenarios", exact: true })
        .waitFor();
      const evalAddress = new URL(this.owner.url()).searchParams;
      const evalFocus = await this.owner.evaluate(
        () => document.activeElement?.id ?? null,
      );
      this.check(
        "an eval row opens the Evals view at that eval, with the keyboard on its title",
        evalAddress.get("view") === "evals" &&
          evalAddress.get("eval") === proposedEval.evalId &&
          evalFocus === "brain-eval-detail-title",
        { address: Object.fromEntries(evalAddress), evalFocus },
      );
      await this.capture(this.owner, "owner-eval-to-review");
      const scenario = proposedEval.revisions[0].scenarios[0];
      this.check(
        "the agent proposed one eval from the correction, with its test message",
        proposedEvals.body.evals.length === 1 &&
          proposedEval.revisions[0].kind === "candidate" &&
          proposedEval.revisions[0].proposedBy.kind === "agent" &&
          proposedEval.revisions[0].evidence[0].proposalId ===
            first.proposalId &&
          scenario.message.subject === "Change to tomorrow's order" &&
          scenario.criteria[0].expected === "approval_required",
        proposedEval,
      );
      await this.owner
        .getByRole("button", { name: "Accept these scenarios", exact: true })
        .click();
      await this.owner
        .getByText(
          "Accepted. Runs now use these scenarios and expected results.",
          { exact: true },
        )
        .waitFor();

      // 8. The owner proposes a replacement for the memory in use.
      await (
        await this.openMemory(this.owner, LEARNED_FACT)
      )
        .getByRole("button", { name: "Propose a replacement", exact: true })
        .click();
      await this.owner.getByLabel("What to remember").fill(PROPOSED_FACT);
      await this.owner
        .getByRole("button", { name: "Save for review", exact: true })
        .click();
      await this.details(this.owner)
        .getByText("Replacement to review", { exact: true })
        .waitFor();

      // 9. The owner runs the eval with the memory in use and with the
      // proposed memory, on two models. Each scenario runs once under each
      // on Pantry's model. The organisation has no OpenAI key, so that model
      // runs nothing.
      // The Evals view lists the eval as a row. The row opens the record.
      const evalRecord = await this.openEval(this.owner);
      await chooseOption(
        this.owner,
        evalRecord.getByLabel("Compare with a proposed memory"),
        { value: candidate.memoryId },
      );
      await evalRecord.getByLabel("Your OpenAI key", { exact: true }).check();
      await this.owner
        .getByRole("button", { name: "Run", exact: true })
        .click();
      const finished = await this.until(
        () => this.read(this.owner, `/evals/${proposedEval.evalId}/runs`),
        (runs) =>
          runs.status === 200 &&
          runs.body.runs.length === 1 &&
          runs.body.runs[0].settledAt !== undefined,
        "the eval run",
      );
      const run = finished.body.runs[0];
      const ranOn = (route) => run.tasks.filter((task) => task.route === route);
      const carried = (configuration) =>
        ranOn("pantry_platform").find(
          (task) => task.configuration === configuration,
        ).outcome.observation.memory;
      this.check(
        "the run compared the memory in use with the proposed memory",
        run.state === "completed" &&
          run.tasks.length === 4 &&
          ranOn("pantry_platform").length === 2 &&
          ranOn("pantry_platform").every(
            (task) =>
              task.outcome.kind === "assessed" &&
              task.outcome.verdict === "passed",
          ) &&
          carried("current")[0].revision === 1 &&
          carried("candidate")[0].revision === 2,
        run,
      );
      this.check(
        "the model with no credential ran nothing, and Pantry moved no scenario to another model",
        ranOn("organisation_openai_api_key").length === 2 &&
          ranOn("organisation_openai_api_key").every(
            (task) =>
              task.outcome.kind === "unavailable" && task.execution === null,
          ),
        ranOn("organisation_openai_api_key"),
      );
      await this.owner.getByText("Finished", { exact: true }).waitFor();
      await this.owner
        .getByText("Purin AI. Proposed memory: passed all 1 scenarios.", {
          exact: true,
        })
        .waitFor();
      // One table compares the two configurations: a row for each scenario,
      // a column for each configuration under its model.
      const table = this.owner.getByRole("table", {
        name: "The same request, with and without the proposed memory",
        exact: true,
      });
      await table.waitFor();
      const compared = await table.evaluate((element) => ({
        tables: element.parentElement.querySelectorAll("table").length,
        columns: [...element.querySelectorAll("thead th")].map(
          (cell) => cell.textContent,
        ),
        rows: [...element.querySelectorAll("tbody tr")].map((row) =>
          [...row.children].map(
            (cell) =>
              cell.querySelector('[class*="status-chip"]')?.textContent ??
              cell.textContent,
          ),
        ),
      }));
      // A cell opens the run result beside the table: what the agent did,
      // each expected result, and a link to the execution.
      const passed = `Passed · ${scenario.criteria.length} of ${scenario.criteria.length}`;
      const firstCell = table.locator("tbody td").first();
      await firstCell
        .getByRole("button", { name: passed, exact: true })
        .click();
      const drawer = this.owner.getByRole("dialog", {
        name: "Run result",
        exact: true,
      });
      const did = await drawer.innerText();
      const drawerLinks = await drawer
        .getByRole("link", { name: "Open its execution", exact: true })
        .count();
      await this.owner.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      this.check(
        "one table compares the memory in use with the proposed memory, and the model with no credential reads as could not run",
        compared.tables === 1 &&
          JSON.stringify(compared.columns) ===
            JSON.stringify([
              "Scenario",
              "Purin AI",
              "Your OpenAI key",
              "Memory in use",
              "Proposed memory",
              "Memory in use",
              "Proposed memory",
            ]) &&
          JSON.stringify(compared.rows) ===
            JSON.stringify([
              [
                scenario.title,
                passed,
                passed,
                "Could not run",
                "Could not run",
              ],
            ]),
        compared,
      );
      this.check(
        "a cell opens the run result, with what the agent did, each expected result and its execution",
        did.includes("What the agent did") &&
          did.includes("Met") &&
          !did.includes("Not met") &&
          drawerLinks === 1,
        { did, drawerLinks },
      );
      // The Portal's frame scrolls inside itself, so a capture holds what
      // is in view. The table is brought into view first.
      await table.scrollIntoViewIfNeeded();
      await this.capture(this.owner, "owner-eval-compared");
      const afterRun = await this.memories(this.owner);
      this.check(
        "the proposed memory is still a proposal after the run",
        afterRun.body.memories[0].revisions[0].kind === "accepted" &&
          afterRun.body.memories[0].revisions[1].kind === "candidate",
        afterRun.body.memories[0].revisions,
      );
      const evalMail = await this.state();
      this.check(
        "the eval drafted and sent nothing",
        evalMail.provider.drafts.length === replied.provider.drafts.length &&
          evalMail.provider.modelRequests.filter(
            (request) => request.turn === "eval",
          ).length === 6,
        {
          drafts: evalMail.provider.drafts.length,
          requests: evalMail.provider.modelRequests.map(
            (request) => request.turn,
          ),
        },
      );

      // 10. The owner accepts the proposed memory from the result.
      await this.owner
        .getByRole("button", {
          name: "Accept the proposed memory",
          exact: true,
        })
        .click();
      await this.owner
        .getByText(
          "Accepted. The agent now uses the proposed memory where it applies.",
          { exact: true },
        )
        .waitFor();
      const replacedMemory = (await this.memories(this.owner)).body.memories[0];
      this.check(
        "the replaced revision names the accepted one",
        replacedMemory.revisions[0].kind === "superseded" &&
          replacedMemory.revisions[0].supersession.replacementRevision === 2 &&
          replacedMemory.revisions[1].kind === "accepted" &&
          replacedMemory.revisions[1].statement === PROPOSED_FACT,
        replacedMemory.revisions,
      );
      // The run names its Case, and the Activity view opens it. The canvas
      // draws each record that the read returns to this person.
      const runCard = evalRecord.locator(".brain-run").first();
      await runCard
        .getByRole("link", { name: "Open its execution", exact: true })
        .click();
      await this.owner
        .getByRole("heading", { name: "Execution of one Case", exact: true })
        .waitFor();
      const runAddress = new URL(this.owner.url()).searchParams;
      const runRecords = await this.execution(this.owner, run.caseId);
      const runGraph = this.owner.getByRole("group", {
        name: /^Execution graph/u,
      });
      await runGraph.locator(".brain-canvas-node").first().waitFor();
      const runDrawn = await runGraph.locator(".brain-canvas-node").count();
      await this.capture(this.owner, "owner-eval-run-records");
      this.check(
        "a run opens its Case in the Activity view",
        runAddress.get("view") === "activity" &&
          runAddress.get("case") === run.caseId &&
          runRecords.status === 200 &&
          runRecords.nodes.length > 0 &&
          runDrawn === runRecords.nodes.length,
        {
          address: Object.fromEntries(runAddress),
          status: runRecords.status,
          records: (runRecords.nodes ?? []).map(
            (node) => `${node.kind}:${node.access}`,
          ),
          runDrawn,
        },
      );

      // Activity is a page of its own; Back returns to the eval on the
      // Knowledge page. The memory changed while the owner was on the Evals
      // view. Its row says so until the owner opens the record.
      await this.owner.goBack();
      await this.tab(this.owner, "Knowledge").click();
      const changed = this.row(this.owner, PROPOSED_FACT).first();
      await changed.waitFor();
      const marksBefore = await changed
        .getByText("New", { exact: true })
        .count();
      await this.openMemory(this.owner, PROPOSED_FACT);
      await this.capture(this.owner, "owner-memory-replaced");
      await this.owner
        .getByRole("link", { name: "Close this memory", exact: true })
        .click();
      await changed.waitFor();
      const marksAfter = await changed
        .getByText("New", { exact: true })
        .count();
      // The state filter is part of the address: one in use is not listed
      // under "Needs review".
      await this.owner
        .getByRole("group", { name: "Show", exact: true })
        .getByRole("link", { name: "Needs review", exact: true })
        .click();
      await this.owner.getByText("Nothing here matches.").first().waitFor();
      const filtered = {
        state: new URL(this.owner.url()).searchParams.get("state"),
        rows: await this.row(this.owner, PROPOSED_FACT).count(),
      };
      this.check(
        "a row is marked new until its record is opened, and the filter limits the list",
        marksBefore === 1 &&
          marksAfter === 0 &&
          filtered.state === "review" &&
          filtered.rows === 0,
        { marksBefore, marksAfter, filtered },
      );

      // The Learning view counts the loop from the same records: one
      // correction, two versions of the memory, one eval run, three
      // decisions, and what is in use. The second administrator reads the
      // same records, so their flow and their log are the same.
      const flowCards = async (target) => {
        await this.tab(target, "Learning").click();
        const flow = target.getByRole("group", {
          name: /^The learning loop/u,
        });
        await flow.getByText("Memories in use", { exact: true }).waitFor();
        return {
          cards: await flow
            .locator(".brain-flow-card")
            .evaluateAll((cards) =>
              Object.fromEntries(
                cards.map((card) => [
                  card.querySelector(".brain-flow-card-title").textContent,
                  card.querySelector(".brain-flow-card-detail").textContent,
                ]),
              ),
            ),
          log: await target.locator(".brain-log-row").count(),
        };
      };
      const learned = await flowCards(this.owner);
      await this.capture(this.owner, "owner-learning");
      // The second administrator's page last loaded in step 4; it opens again.
      await this.openBrain(other);
      const otherLearned = await flowCards(other);
      await this.capture(other, "other-admin-learning");
      this.check(
        "the learning flow counts the loop, and every member reads the same flow",
        learned.cards["Corrections of email replies"] === "1 record" &&
          learned.cards["Memories proposed"] === "2 versions" &&
          learned.cards["Eval runs"] === "1 run" &&
          learned.cards["Decisions"] === "3 decisions" &&
          learned.cards["Memories in use"] === "1 memory" &&
          learned.cards["Evals in use"] === "1 eval" &&
          learned.log >= 6 &&
          JSON.stringify(otherLearned) === JSON.stringify(learned),
        { learned, otherLearned },
      );
      // A line of the log opens its record.
      await this.owner.locator(".brain-log-row").first().click();
      const fromLog = new URL(this.owner.url()).searchParams;
      this.check(
        "a line of the learning log opens its record",
        fromLog.get("view") === "knowledge" || fromLog.get("view") === "evals",
        Object.fromEntries(fromLog),
      );

      // The owner edits the scenarios of the eval. The form offers the
      // verified contacts of the mailbox as the sender. A wrong time zone is
      // refused in words. The saved scenarios are a new version to review:
      // the reviewed version stays the one that runs. The owner declines it.
      const evalForEdit = await this.openEval(this.owner);
      await evalForEdit
        .getByRole("button", { name: "Edit scenarios", exact: true })
        .click();
      const form = this.owner.getByRole("form", {
        name: "Scenarios of this eval",
        exact: true,
      });
      await form.waitFor();
      // The form takes the keyboard when it opens. Read it before the sender
      // popup takes and returns the keyboard.
      const formFocus = await this.owner.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? null,
      );
      const senderChoices = await this.until(
        async () =>
          (
            await selectItems(
              this.owner,
              form.getByLabel("The message is from").first(),
            )
          ).map((item) => item.label),
        (options) => options.includes("supplier@example.test"),
        "the verified contacts of the mailbox",
      );
      const contacts = await this.read(
        this.owner,
        `/evals/${proposedEval.evalId}/contacts`,
      );
      await form
        .getByRole("button", { name: "Add a scenario", exact: true })
        .click();
      const added = form.getByRole("group", {
        name: "Scenario 2",
        exact: true,
      });
      await added.getByLabel("Title").fill("A question with no order change");
      await added.getByLabel("Subject").fill("Opening hours next week");
      await added
        .getByLabel("Message", { exact: true })
        .fill("Are you open on Monday next week?");
      await chooseOption(
        this.owner,
        added.getByLabel("Expected result 1", { exact: true }),
        { label: "Replies at once" },
      );
      await added.getByLabel("Time zone").fill("Sydney");
      await form
        .getByRole("button", { name: "Save for review", exact: true })
        .click();
      const zoneRefusal = await form
        .getByText("needs a valid time zone, date and time.")
        .innerText();
      const unsaved = await this.read(this.owner, "/evals");
      await added.getByLabel("Time zone").fill("Australia/Sydney");
      await form
        .getByRole("button", { name: "Save for review", exact: true })
        .click();
      await this.owner
        .getByText(
          "Saved for review. Runs keep the reviewed scenarios until someone accepts the change.",
          { exact: true },
        )
        .waitFor();
      await evalForEdit.getByText("Proposed change", { exact: true }).waitFor();
      await evalForEdit
        .getByText("Proposed change", { exact: true })
        .scrollIntoViewIfNeeded();
      await this.capture(this.owner, "owner-eval-edited");
      const revised = (await this.read(this.owner, "/evals")).body.evals[0];
      const revision = revised.revisions.at(-1);
      this.check(
        "the scenario form offers the verified contacts of the mailbox as the sender",
        contacts.status === 200 &&
          contacts.body.contacts.length >= 1 &&
          contacts.body.contacts.every((contact) =>
            senderChoices.includes(contact.address),
          ) &&
          formFocus === "Scenarios of this eval",
        { senderChoices, contacts: contacts.body, formFocus },
      );
      this.check(
        "a scenario with a wrong time zone is refused in words, and nothing is saved",
        zoneRefusal.includes("A question with no order change") &&
          unsaved.body.evals[0].headRevision === 1,
        { zoneRefusal, headRevision: unsaved.body.evals[0].headRevision },
      );
      this.check(
        "the edited scenarios are a new version to review, and the reviewed version still runs",
        revised.headRevision === 2 &&
          revised.revisions[0].kind === "accepted" &&
          revision.kind === "candidate" &&
          revision.proposedBy.kind === "operator" &&
          revision.scenarios.length === 2 &&
          revision.scenarios[1].title === "A question with no order change" &&
          revision.scenarios[1].message.timezone === "Australia/Sydney" &&
          revision.scenarios[1].sender.verificationId ===
            revision.scenarios[0].sender.verificationId &&
          revision.scenarios[1].criteria[0].expected === "reply_now",
        revised,
      );
      await evalForEdit
        .getByRole("button", { name: "Decline", exact: true })
        .click();
      await this.owner
        .getByText("Declined. Nothing changed for runs.", { exact: true })
        .waitFor();
      // The record closes from the keyboard, and the keyboard returns to the
      // row that opened it.
      await evalForEdit
        .getByRole("link", { name: "Close this eval", exact: true })
        .focus();
      await this.owner.keyboard.press("Enter");
      await this.owner
        .getByRole("list", { name: "Evals", exact: true })
        .waitFor();
      const afterClose = {
        eval: new URL(this.owner.url()).searchParams.get("eval"),
        focus: await this.owner.evaluate(
          () => document.activeElement?.id ?? null,
        ),
      };
      this.check(
        "the eval record closes from the keyboard, and the keyboard returns to its row",
        afterClose.eval === null &&
          afterClose.focus === `brain-row-evals-${proposedEval.evalId}`,
        afterClose,
      );

      // 11. The other administrator reads the same eval and its runs.
      await this.openBrain(other);
      await this.tab(other, "Tests").click();
      await other
        .locator(`[id="brain-row-evals-${proposedEval.evalId}"]`)
        .waitFor();
      await this.capture(other, "other-admin-evals");
      const ownerRuns = await this.read(
        this.owner,
        `/evals/${proposedEval.evalId}/runs`,
      );
      const otherRuns = await this.read(
        other,
        `/evals/${proposedEval.evalId}/runs`,
      );
      this.check(
        "the other administrator reads the same runs of the eval",
        ownerRuns.status === 200 &&
          otherRuns.status === 200 &&
          JSON.stringify(otherRuns.body) === JSON.stringify(ownerRuns.body),
        { ownerRuns, otherRuns },
      );

      // 12. The owner opens the execution of the Case the memory came from,
      // from the memory itself. The view shows what Pantry recorded for the
      // corrected reply. The owner may review that mailbox, so the records
      // are in the open.
      await this.openBrain(this.owner);
      const replaced = await this.openMemory(this.owner, PROPOSED_FACT);
      await replaced
        .getByRole("link", { name: "Open the Case", exact: true })
        .click();
      await this.owner
        .getByRole("heading", { name: "Execution of one Case", exact: true })
        .waitFor();
      const graph = this.owner.getByRole("group", {
        name: /^Execution graph/u,
      });
      await graph
        .getByRole("button", { name: /Proposed email reply/u })
        .first()
        .waitFor();
      await this.capture(this.owner, "owner-execution-graph");
      const sourceCaseId = candidate.revisions[0].sourceCaseId;
      const projected = await this.execution(this.owner, sourceCaseId);
      if (projected.status !== 200)
        throw new Error(`execution read: ${JSON.stringify(projected)}`);
      const page = projected;
      const kinds = page.nodes.map((node) => `${node.kind}:${node.access}`);
      const mailReplies = page.nodes.filter(
        (node) =>
          node.kind === "proposal" && node.proposalKind === "mail_reply",
      );
      this.check(
        "the Case's execution is in the open for the mailbox reviewer",
        projected.pages >= 2 &&
          kinds.every((kind) => kind.endsWith(":open")) &&
          kinds.filter((kind) => kind === "assignment:open").length >= 2 &&
          mailReplies.length >= 1 &&
          page.limitations.includes("mail_proposal_origin_unrecorded"),
        { pages: projected.pages, kinds, limitations: page.limitations },
      );
      this.check(
        "no edge leads into the email reply proposal, and the read says why",
        mailReplies.every(
          (reply) => !page.edges.some((edge) => edge.to === reply.nodeId),
        ),
        page.edges,
      );
      // The canvas places the records of that same projection. The layout
      // code takes the projection alone, so it is checked here with the one
      // that the Worker returned: each record has one place, each recorded
      // link leads to the right, no two records share a place, and each
      // assignment has its own lane.
      const placed = await this.owner.evaluate(
        async (execution) => {
          const { layoutExecution } =
            await import("/src/features/brain/execution-layout.ts");
          const layout = layoutExecution(execution);
          const at = new Map(
            layout.nodes.map((entry) => [entry.node.nodeId, entry]),
          );
          return {
            placed: layout.nodes.length,
            leftward: execution.edges.filter(
              (edge) => at.get(edge.to).x <= at.get(edge.from).x,
            ).length,
            overlaps: layout.nodes.filter((one, index) =>
              layout.nodes.some(
                (other, later) =>
                  later > index &&
                  Math.abs(one.x - other.x) < 232 &&
                  Math.abs(one.y - other.y) < 68,
              ),
            ).length,
            assignmentLanes: new Set(
              layout.nodes
                .filter((entry) => entry.node.kind === "assignment")
                .map((entry) => entry.lane),
            ).size,
            lanes: layout.lanes.length,
            stages: layout.headings.map((heading) => heading.stage),
          };
        },
        {
          caseId: sourceCaseId,
          nodes: page.nodes,
          edges: page.edges,
          limitations: page.limitations,
        },
      );
      const assignments = kinds.filter(
        (kind) => kind === "assignment:open",
      ).length;
      const drawn = await graph.locator(".brain-canvas-node").count();
      this.check(
        "the canvas places each record once, each link leads to the right, and each assignment has a lane",
        placed.placed === page.nodes.length &&
          drawn === page.nodes.length &&
          placed.leftward === 0 &&
          placed.overlaps === 0 &&
          placed.assignmentLanes === assignments &&
          placed.stages[0] === "request",
        { ...placed, drawn, assignments },
      );

      // 13. The list layout works from the keyboard. The owner selects the
      // first request and reads the request that the Case recorded.
      await this.owner
        .getByRole("button", { name: "List", exact: true })
        .click();
      const records = this.owner.getByRole("list", {
        name: "Execution records",
      });
      const firstRequest = records
        .getByRole("button", { name: /Request from a connected channel/u })
        .first();
      await firstRequest.focus();
      await this.owner.keyboard.press("Enter");
      const details = this.owner.getByRole("complementary", {
        name: "Record details",
      });
      await details
        .getByRole("heading", {
          name: "Request from a connected channel",
          exact: true,
        })
        .waitFor();
      await details.getByText("Request", { exact: true }).first().waitFor();
      this.check(
        "the selected record is marked, and its details name no source",
        (await firstRequest.getAttribute("aria-pressed")) === "true" &&
          (await details
            .getByText("None. No record names what this one came from.", {
              exact: true,
            })
            .count()) === 1,
        null,
      );
      // The address names the view, the Case and the record, so the same
      // link opens all three again.
      const selected = new URL(this.owner.url()).searchParams;
      await this.owner.reload();
      await details
        .getByRole("heading", {
          name: "Request from a connected channel",
          exact: true,
        })
        .waitFor();
      this.check(
        "the address opens the same Case and the same record again",
        selected.get("view") === "activity" &&
          selected.get("case") === sourceCaseId &&
          (selected.get("record") ?? "").length > 0,
        Object.fromEntries(selected),
      );
      await this.owner
        .getByRole("button", { name: "List", exact: true })
        .click();
      await this.capture(this.owner, "owner-execution-list");
      const listedCases = await this.read(this.owner, "/case-executions");
      this.check(
        "the owner's list holds the Case",
        listedCases.status === 200 &&
          listedCases.body.cases.some((entry) => entry.caseId === sourceCaseId),
        listedCases,
      );

      // 14. The other administrator is not a member of the Case's Project.
      // A Project groups work and hides none of it (Plan 27C), so their list
      // holds the Case and they read the same execution. A Case that does
      // not exist still answers as a missing one.
      await other.goto(
        `${PORTAL}/brain-preview.html?organisation=${this.fixtures.organisationId}&view=activity`,
      );
      await other.locator(".brain-activity").first().waitFor();
      const otherCases = await this.read(other, "/case-executions");
      await this.capture(other, "other-admin-activity");
      const ownerCase = await this.read(
        this.owner,
        `/cases/${sourceCaseId}/execution`,
      );
      const otherCase = await this.read(
        other,
        `/cases/${sourceCaseId}/execution`,
      );
      const missingCase = await this.read(
        other,
        "/cases/case_that_does_not_exist/execution",
      );
      this.check(
        "the other administrator reads the Case and its execution",
        otherCases.status === 200 &&
          otherCases.body.cases.some((entry) => entry.caseId === sourceCaseId) &&
          ownerCase.status === 200 &&
          otherCase.status === 200 &&
          JSON.stringify(otherCase.body) === JSON.stringify(ownerCase.body) &&
          missingCase.status === 404,
        { otherCases, otherCase, missingCase },
      );

      // The Context view leads to the pages that own the inspection of Case
      // context. It reads nothing: no request goes to a control route when
      // it opens.
      await this.openBrain(this.owner);
      const contextReads = [];
      const noteRead = (request) => {
        if (request.url().includes("/v1/control/"))
          contextReads.push(request.url());
      };
      this.owner.on("request", noteRead);
      await this.tab(this.owner, "Context").click();
      const contextList = this.owner.getByRole("list", {
        name: "Pages that show Case context",
        exact: true,
      });
      await contextList.waitFor();
      const contextPages = await contextList
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => [
            link.querySelector(".brain-row-title").textContent,
            link.getAttribute("href"),
          ]),
        );
      await this.owner.waitForTimeout(500);
      this.owner.off("request", noteRead);
      await this.capture(this.owner, "owner-context");
      this.check(
        "the Context view links to the pages that show Case context, and reads nothing",
        new URL(this.owner.url()).searchParams.get("view") === "context" &&
          JSON.stringify(contextPages) ===
            JSON.stringify([
              ["Related Cases", "/portal/preview/cafe/access/data-flow"],
              [
                "Context discovery",
                "/portal/preview/cafe/integrations?integration=typesafe",
              ],
              ["On screen", "/portal/preview/cafe/access/data-flow#on-screen"],
            ]) &&
          contextReads.length === 0,
        { contextPages, contextReads },
      );

      // Each view at phone width, in the dark theme, on the records of this
      // run. No content is cut off at the side, the page has no sideways
      // scroll, and each control has a name.
      const phone = await this.owner.context().newPage();
      await phone.setViewportSize({ width: 375, height: 812 });
      // The Portal follows the theme of the system.
      await phone.emulateMedia({ colorScheme: "dark" });
      const phoneViews = [];
      for (const [name, query, ready] of [
        ["overview", "", "#brain-status-line"],
        ["learning", "&view=learning", ".brain-flow-list"],
        ["knowledge", "&view=knowledge", ".brain-rows"],
        [
          "memory",
          `&view=knowledge&memory=${candidate.memoryId}`,
          "#brain-memory-detail-title",
        ],
        ["evals", "&view=evals", ".brain-rows"],
        ["eval", `&view=evals&eval=${proposedEval.evalId}`, ".brain-run-table"],
        [
          "activity",
          `&view=activity&case=${sourceCaseId}`,
          ".brain-execution-list",
        ],
        ["context", "&view=context", ".brain-rows"],
      ]) {
        await phone.goto(
          `${PORTAL}/brain-preview.html?organisation=${this.fixtures.organisationId}&theme=dark${query}`,
        );
        await phone.locator(ready).first().waitFor();
        const audit = await phone.evaluate(() => {
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const nameOf = (element) => {
            const label = element.getAttribute("aria-label");
            if (label) return label;
            const by = element.getAttribute("aria-labelledby");
            if (by)
              return by
                .split(" ")
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ")
                .trim();
            if (element.id) {
              const forIt = document.querySelector(
                `label[for="${CSS.escape(element.id)}"]`,
              );
              if (forIt) return forIt.textContent.trim();
            }
            const wrap = element.closest("label");
            if (wrap) return wrap.textContent.trim();
            return (element.textContent ?? "").trim();
          };
          const page = document.querySelector(".brain-page");
          // A Portal Select keeps its form value in a hidden input that no
          // one reaches (aria-hidden and out of the tab order). Its trigger
          // button is the control.
          const controls = [
            ...page.querySelectorAll(
              'a[href], button, input:not([aria-hidden="true"][tabindex="-1"]), select, textarea, summary, [tabindex="0"]',
            ),
          ].filter(visible);
          const width = document.documentElement.clientWidth;
          // The colour behind the page: the first surface above it that
          // is not transparent. A canvas gives the colour as red, green and
          // blue, in whatever form the style sheet wrote it.
          const paint = document.createElement("canvas").getContext("2d");
          let surface = page;
          let shade = [255, 255, 255];
          while (surface !== null) {
            paint.clearRect(0, 0, 1, 1);
            paint.fillStyle = getComputedStyle(surface).backgroundColor;
            paint.fillRect(0, 0, 1, 1);
            const [red, green, blue, alpha] = paint.getImageData(
              0,
              0,
              1,
              1,
            ).data;
            if (alpha > 0) {
              shade = [red, green, blue];
              break;
            }
            surface = surface.parentElement;
          }
          return {
            sideways: document.documentElement.scrollWidth - width,
            // The rings of the Overview are a backdrop that its box clips.
            cut: [...page.querySelectorAll("*")]
              .filter(
                (element) =>
                  visible(element) &&
                  element.getBoundingClientRect().right > width + 1 &&
                  !element.closest(".brain-status-rings"),
              )
              .map((element) => String(element.className).slice(0, 60))
              .slice(0, 5),
            controls: controls.length,
            unnamed: controls
              .filter((element) => nameOf(element) === "")
              .map((element) => element.outerHTML.slice(0, 120)),
            dark:
              document.documentElement.dataset.portalTheme === "dark" &&
              shade.reduce((sum, part) => sum + part, 0) / 3 < 80,
            shade,
          };
        });
        phoneViews.push({ name, ...audit });
        await this.capture(phone, `phone-dark-${name}`);
      }
      await phone.close();
      this.check(
        "at phone width in the dark theme, no view cuts content off and each control has a name",
        phoneViews.every(
          (view) =>
            view.sideways === 0 &&
            view.cut.length === 0 &&
            view.unnamed.length === 0 &&
            view.controls > 0 &&
            view.dark,
        ),
        phoneViews,
      );

      // 15. The fixture holds one mail Case. The sample Cases of the preview
      // page show the other shapes on the same canvas: work side by side,
      // withheld records and a long Case. They use no Worker.
      const sample = await this.owner.context().newPage();
      const sampleGraph = sample.getByRole("group", {
        name: /^Execution graph/u,
      });
      await sample.goto(
        `${PORTAL}/brain-preview.html?view=activity&case=case_preview_reorder_flour`,
      );
      await sampleGraph
        .getByRole("button", { name: /Request from the Portal/u })
        .waitFor();
      const sideBySide = await sample.evaluate(() => {
        const tops = [...document.querySelectorAll(".brain-canvas-node")]
          .filter((node) => node.textContent.startsWith("Research assignment"))
          .map((node) => Number.parseFloat(node.style.top));
        const lefts = [...document.querySelectorAll(".brain-canvas-node")]
          .filter((node) => node.textContent.startsWith("Research assignment"))
          .map((node) => Number.parseFloat(node.style.left));
        return {
          tops,
          sameColumn: new Set(lefts).size === 1,
          stages: [...document.querySelectorAll(".brain-canvas-heading")].map(
            (heading) => heading.textContent,
          ),
        };
      });
      const turn = sampleGraph.getByRole("button", { name: /^Turn/u }).first();
      await turn.focus();
      await sample.keyboard.press("Enter");
      await sample
        .getByRole("complementary", { name: "Record details" })
        .getByRole("heading", { name: "Turn", exact: true })
        .waitFor();
      this.check(
        "work side by side is in two lanes, and the keyboard selects a record",
        sideBySide.tops.length === 2 &&
          sideBySide.tops[0] !== sideBySide.tops[1] &&
          sideBySide.sameColumn &&
          sideBySide.stages[0] === "Request" &&
          (await turn.getAttribute("aria-pressed")) === "true" &&
          new URL(sample.url()).searchParams.get("record") !== null,
        sideBySide,
      );
      await this.capture(sample, "sample-parallel-graph");

      await sample.goto(
        `${PORTAL}/brain-preview.html?view=activity&case=case_slack_preview_thread`,
      );
      await sampleGraph
        .getByRole("button", { name: /Withheld/u })
        .first()
        .waitFor();
      const withheld = await sampleGraph
        .locator(".brain-canvas-node")
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            [...node.children].map((part) => part.textContent),
          ),
        );
      this.check(
        "a withheld record keeps its place and shows its kind only",
        withheld.length === 7 &&
          withheld.every(
            (parts) =>
              parts[0] === "Withheld" && !parts.join(" ").includes("·"),
          ),
        withheld,
      );
      await this.capture(sample, "sample-withheld-graph");

      await sample.goto(
        `${PORTAL}/brain-preview.html?view=activity&case=case_preview_long_inventory`,
      );
      await sample.getByText("More records are on their way.").waitFor();
      const whileReading = await sampleGraph
        .locator(".brain-canvas-node")
        .count();
      await sample
        .getByText("200 records, 199 recorded links.", { exact: true })
        .waitFor();
      const folds = sampleGraph.getByRole("button", {
        name: "41 more tool operations",
        exact: true,
      });
      const folded = {
        records: await sampleGraph.locator(".brain-canvas-node").count(),
        folds: await folds.count(),
      };
      await this.capture(sample, "sample-long-graph");
      await folds.first().click();
      await sampleGraph
        .getByRole("button", { name: "Show fewer", exact: true })
        .waitFor();
      const unfolded = await sampleGraph.locator(".brain-canvas-node").count();
      const zoomBefore = await sample.locator(".brain-canvas-zoom").innerText();
      await sample
        .getByRole("button", { name: "Fit to view", exact: true })
        .click();
      await sample.waitForFunction(
        (before) =>
          document.querySelector(".brain-canvas-zoom")?.textContent !== before,
        zoomBefore,
      );
      const zoomAfter = await sample.locator(".brain-canvas-zoom").innerText();
      this.check(
        "a Case of 200 records shows while its pages arrive, folds long stacks and fits the view",
        whileReading > 0 &&
          whileReading < 200 &&
          folded.records === 36 &&
          folded.folds === 4 &&
          unfolded === 36 + 41 &&
          zoomBefore !== zoomAfter,
        { whileReading, folded, unfolded, zoomBefore, zoomAfter },
      );

      // The sample eval has four scenarios and a run on two models. One
      // table holds them: a row for each scenario and a column for each
      // configuration under its model. The model that ran nothing states
      // its reason one time, above the table, and its cells hold no note.
      await sample.goto(
        `${PORTAL}/brain-preview.html?view=evals&eval=eval_preview_cutoff`,
      );
      const sampleTable = sample.getByRole("table", {
        name: "The same request, with and without the proposed memory",
        exact: true,
      });
      await sampleTable.waitFor();
      const several = await sampleTable.evaluate((element) => ({
        rows: [...element.querySelectorAll("tbody tr")].map((row) =>
          [...row.querySelectorAll("td")].map(
            (cell) =>
              cell.querySelector('[class*="status-chip"]')?.textContent ?? "",
          ),
        ),
        notes: element.querySelectorAll("tbody td .brain-task > p.brain-muted")
          .length,
        summary: [
          ...element.parentElement.querySelectorAll(".brain-run-summary li"),
        ].map((line) => line.textContent),
      }));
      await sampleTable.scrollIntoViewIfNeeded();
      await this.capture(sample, "sample-eval-compared");
      const noRun = ["Could not run", "Could not run"];
      this.check(
        "one table holds four scenarios on two models, and a model that ran nothing states its reason one time",
        JSON.stringify(several.rows) ===
          // Each chip states its verdict and how many attempts passed.
          JSON.stringify([
            ["Passed · 2 of 2", "Passed · 2 of 2", ...noRun],
            ["Failed · 0 of 1", "Passed · 1 of 1", ...noRun],
            ["Passed · 1 of 1", "Passed · 1 of 1", ...noRun],
            ["Passed · 2 of 2", "Passed · 2 of 2", ...noRun],
          ]) &&
          several.notes === 0 &&
          several.summary.filter((line) => line.startsWith("Your OpenAI key."))
            .length === 1,
        several,
      );

      // Teach a fact. The Knowledge view says how a person teaches the
      // agent, and it leads to the chat. A memory that was taught in a chat
      // names its scope and what it is based on. A person who cannot decide
      // a memory is not offered the entry.
      await sample.goto(`${PORTAL}/brain-preview.html?view=knowledge`);
      const teachToggle = sample.getByRole("button", {
        name: "Teach a fact",
        exact: true,
      });
      await teachToggle.click();
      const teachPanel = sample.getByRole("region", {
        name: "Teach a fact in the chat",
        exact: true,
      });
      await teachPanel.waitFor();
      const taughtRow = sample
        .locator('a[id^="brain-row-memory-"]')
        .filter({ hasText: "The shop closes at 18:00 on Sundays." });
      const taught = {
        expanded: await teachToggle.getAttribute("aria-expanded"),
        chat: await teachPanel
          .getByRole("link", { name: "Open the chat", exact: true })
          .getAttribute("href"),
        scope: await taughtRow.locator(".brain-row-meta").innerText(),
      };
      await this.capture(sample, "sample-teach");
      await taughtRow.click();
      const taughtRecord = await sample
        .getByRole("region", { name: "Memory details" })
        .innerText();
      await sample.goto(
        `${PORTAL}/brain-preview.html?view=knowledge&scenario=viewer`,
      );
      await sample.locator(".brain-rows").first().waitFor();
      const offeredToViewer = await sample
        .getByRole("button", { name: "Teach a fact", exact: true })
        .count();
      this.check(
        "the Knowledge view says how to teach a fact, and a taught memory names its scope and its source",
        taught.expanded === "true" &&
          taught.chat === "/portal/preview/cafe/chat" &&
          taught.scope.startsWith("Chats in the Portal") &&
          taughtRecord.includes("Chats in the Portal") &&
          taughtRecord.includes("An instruction a person gave") &&
          taughtRecord.includes("Email replies do not use it.") &&
          offeredToViewer === 0,
        { taught, offeredToViewer, taughtRecord: taughtRecord.slice(0, 600) },
      );
      await sample.close();

      return {
        result: "passed",
        organisationId: this.fixtures.organisationId,
        execution: {
          caseId: sourceCaseId,
          records: kinds,
          links: page.edges.length,
          limitations: page.limitations,
        },
        eval: { evalId: proposedEval.evalId, revision: 1 },
        evalRun: {
          runId: run.runId,
          caseId: run.caseId,
          state: run.state,
          tasks: run.tasks.map((task) => ({
            taskId: task.taskId,
            route: task.route,
            verdict: task.outcome.verdict ?? task.outcome.kind,
            execution: task.execution,
            memory: task.outcome.observation?.memory ?? null,
          })),
        },
        memory: { memoryId: candidate.memoryId, revision: 1 },
        correctedProposal: first.proposalId,
        freshProposal: second.proposalId,
        freshTurnRecord: record,
        modelRequests: replied.provider.modelRequests.map((request) => ({
          turn: request.turn,
          toolResults: request.toolResults,
        })),
        checks: this.checks,
        captures: this.captures,
      };
    }
  }

  const journey = new BrainJourney(page, JOURNEY_FIXTURES, JOURNEY_ARTIFACTS);
  try {
    return await journey.run();
  } catch (error) {
    // The owner's page at the failure shows what the step waited for.
    const failureCapture = await journey
      .capture(journey.owner, "failure-owner")
      .then(
        () => "failure-owner.png",
        (captureError) => String(captureError),
      );
    return {
      result: "failed",
      error: String(error),
      failureCapture,
      failureUrl: journey.owner.url(),
      checks: journey.checks,
      captures: journey.captures,
    };
  } finally {
    await journey.close();
  }
};
