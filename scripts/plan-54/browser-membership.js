async (page) => {
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

  class SharedProjectJourney {
    constructor(page, fixtures) {
      this.owner = page;
      this.fixtures = fixtures;
      this.contexts = [];
      this.checks = [];
      this.paginationCounts = {};
    }
    async open(name, target) {
      const session = await target.request.post(
        `http://127.0.0.1:8834/test/session?user=${name}`,
      );
      if (!session.ok()) throw new Error(`Session failed for ${name}`);
      const user = await session.json();
      await target.addInitScript({ content: FIXTURE_SOURCE });
      await target.goto(
        `http://127.0.0.1:3116/chat-preview.html?preferenceUser=${user.userId}`,
      );
      await target.getByRole("link", { name: "Ask", exact: true }).click();
      await target
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      if (name === "Foreign")
        await target
          .getByRole("button", { name: "Retry opening chat", exact: true })
          .waitFor();
      else
        await target.getByRole("tab", { name: "Chats", exact: true }).waitFor();
      return target;
    }
    async peer(name) {
      const context = await this.owner
        .context()
        .browser()
        .newContext({ viewport: { width: 1200, height: 850 } });
      this.contexts.push(context);
      return this.open(name, await context.newPage());
    }
    async read(target, suffix = "") {
      const response = await target.request.get(
        `http://127.0.0.1:8834/v1/control/organisations/${this.fixtures.organisationId}/chat${suffix}`,
      );
      if (!response.ok()) throw new Error(`Read failed: ${response.status()}`);
      return response.json();
    }
    static isCsrf(cookie) {
      return cookie.name === "satyr_control_csrf";
    }
    async mutate(target, suffix, method, body) {
      const cookies = await target.context().cookies("http://127.0.0.1:8834");
      const csrf = cookies.find(SharedProjectJourney.isCsrf);
      if (!csrf) throw new Error("CSRF cookie missing");
      return target.request.fetch(
        `http://127.0.0.1:8834/v1/control/organisations/${this.fixtures.organisationId}/chat${suffix}`,
        {
          method,
          headers: {
            origin: "http://127.0.0.1:3116",
            "x-satyr-csrf": csrf.value,
          },
          data: body,
        },
      );
    }
    static hasChat(id, conversation) {
      return id === conversation.id;
    }
    async assertPrivateIsolation(target) {
      const directory = await this.read(target);
      const encoded = JSON.stringify(directory);
      if (
        encoded.includes(this.fixtures.privateChat) ||
        encoded.includes("Private supplier negotiation")
      )
        throw new Error(
          "Private chat metadata escaped into another member's response",
        );
    }
    async select(target) {
      await target.getByRole("link", { name: /^Launch checklist/ }).click();
      await target
        .getByRole("status")
        .filter({ hasText: "Shared with project" })
        .waitFor();
    }
    async addMember(dialog, name, role) {
      await chooseOption(
        dialog.page(),
        dialog.getByRole("combobox", { name: "Person", exact: true }),
        { label: name },
      );
      await chooseOption(
        dialog.page(),
        dialog.getByRole("combobox", { name: "Access", exact: true }),
        { value: role },
      );
      const share = dialog.getByRole("button", {
        name: "Share project",
        exact: true,
      });
      await (
        (await share.count())
          ? share
          : dialog.getByRole("button", { name: "Add member", exact: true })
      ).click();
      await dialog.getByLabel(`Role for ${name}`, { exact: true }).waitFor();
    }
    static dialogFits(element) {
      return (
        element.getBoundingClientRect().width <= window.innerWidth &&
        element.scrollWidth <= element.clientWidth
      );
    }
    static ownsFocus(element) {
      return element === document.activeElement;
    }
    async run() {
      await this.owner.setViewportSize({ width: 1200, height: 850 });
      await this.open("Owner", this.owner);
      const trigger = this.owner.getByRole("button", {
        name: "Manage access to Launch team",
        exact: true,
      });
      await trigger.click();
      const dialog = this.owner.getByRole("dialog", {
        name: "Project access",
        exact: true,
      });
      await this.addMember(dialog, "Editor", "editor");
      await this.addMember(dialog, "Viewer", "viewer");
      await dialog
        .getByRole("button", { name: "Remove Owner", exact: true })
        .click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Assign another owner" })
        .waitFor();
      this.checks.push("real member management and final-owner protection");
      await this.owner.screenshot({
        path: "output/playwright/plan-54/authenticated-members.png",
        fullPage: true,
      });
      await this.owner.keyboard.press("Escape");
      if (!(await trigger.evaluate(SharedProjectJourney.ownsFocus)))
        throw new Error("Focus did not return to member trigger");
      await this.owner.setViewportSize({ width: 390, height: 844 });
      await trigger.click();
      if (!(await dialog.evaluate(SharedProjectJourney.dialogFits)))
        throw new Error("Member dialog overflowed narrow viewport");
      await this.owner.screenshot({
        path: "output/playwright/plan-54/authenticated-members-narrow.png",
        fullPage: true,
      });
      await this.owner.keyboard.press("Escape");
      await this.owner.setViewportSize({ width: 1200, height: 850 });
      this.checks.push("keyboard focus restoration and narrow member dialog");

      this.editor = await this.peer("Editor");
      this.viewer = await this.peer("Viewer");
      this.unrelated = await this.peer("Unrelated");
      this.foreign = await this.peer("Foreign");
      for (const target of [this.editor, this.viewer, this.unrelated]) {
        await this.assertPrivateIsolation(target);
        if ((await this.read(target)).conversations.length !== 0)
          throw new Error("Sharing a project published private chats");
      }
      const foreignRead = await this.foreign.request.get(
        `http://127.0.0.1:8834/v1/control/organisations/${this.fixtures.organisationId}/chat`,
      );
      if (foreignRead.status() !== 404)
        throw new Error("Foreign organisation could read the directory");
      this.checks.push(
        "project sharing keeps private metadata invisible across authenticated accounts",
      );

      await this.owner
        .getByRole("button", {
          name: "Actions for Private supplier negotiation",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("menuitem", { name: "Default project", exact: true })
        .click();
      await this.owner
        .getByRole("button", {
          name: "Actions for Private supplier negotiation",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("menuitem", { name: "Launch team", exact: true })
        .click();
      const privateMove = this.owner.getByRole("dialog", {
        name: "Chat visibility",
        exact: true,
      });
      if (
        !(await privateMove
          .getByRole("radio", { name: /Keep private/ })
          .isChecked())
      )
        throw new Error(
          "Moving into a shared project did not default to private",
        );
      await privateMove
        .getByRole("button", { name: "Move privately", exact: true })
        .click();
      await this.assertPrivateIsolation(this.editor);
      await this.assertPrivateIsolation(this.viewer);
      this.checks.push("private project moves keep history private by default");
      await this.verifyDeniedSharing();

      await this.owner
        .getByRole("button", {
          name: "Actions for Launch checklist",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("menuitem", { name: "Share with project", exact: true })
        .click();
      const visibility = this.owner.getByRole("dialog", {
        name: "Chat visibility",
        exact: true,
      });
      for (const name of ["Editor", "Viewer"])
        await visibility.getByText(name, { exact: true }).waitFor();
      await visibility
        .getByRole("button", { name: "Share with project", exact: true })
        .click();
      await this.owner.getByLabel("Shared chat", { exact: true }).waitFor();
      await this.editor.reload();
      await this.viewer.reload();
      for (const target of [this.editor, this.viewer]) {
        await target.getByRole("link", { name: "Ask", exact: true }).click();
        await target
          .getByRole("button", { name: "Expand to fullscreen", exact: true })
          .click();
        await this.select(target);
        await this.assertPrivateIsolation(target);
      }
      const composer = this.viewer.getByRole("textbox", {
        name: "Message your AI",
        exact: true,
      });
      if (!(await composer.isDisabled()))
        throw new Error("Viewer composer is writable");
      await this.viewer
        .getByRole("status")
        .filter({ hasText: "View only" })
        .waitFor();
      const denied = await this.mutate(this.viewer, "", "POST", {
        conversationId: this.fixtures.sharedCandidate,
        requestId: "viewer_forbidden",
        kind: "message",
        text: "A forbidden write",
        model: "moonshotai/kimi-k3",
        surfaceContext: null,
        browserContext: { kind: "unavailable" },
      });
      if (denied.status() !== 403)
        throw new Error(`Viewer write returned ${denied.status()}`);
      const sharedEditor = (await this.read(this.editor)).conversations.find(
        SharedProjectJourney.hasChat.bind(null, this.fixtures.sharedCandidate),
      );
      if (sharedEditor?.sharing.role !== "editor")
        throw new Error("Editor shared projection missing");
      if (
        await this.viewer
          .locator('[data-default-project="true"] .project-empty')
          .count()
      )
        throw new Error(
          "A populated shared directory displays an empty-chat message",
        );
      if ((await this.read(this.unrelated)).conversations.length !== 0)
        throw new Error("Unrelated user received shared history");
      await this.viewer.screenshot({
        path: "output/playwright/plan-54/authenticated-viewer.png",
        fullPage: true,
      });
      this.checks.push(
        "explicit audience review, common conversation, viewer UI and server enforcement",
      );

      await this.editor
        .getByRole("textbox", { name: "Message your AI", exact: true })
        .fill("Editor private draft");
      await this.waitDraft(this.editor, "Editor private draft");
      if (
        (
          await this.read(
            this.viewer,
            `?conversation=${this.fixtures.sharedCandidate}&observe=true`,
          )
        ).conversation.draft.text !== ""
      )
        throw new Error("Draft leaked to viewer");
      await this.viewer
        .getByRole("button", { name: "Archive Launch checklist", exact: true })
        .click();
      await this.viewer
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      await this.viewer
        .getByRole("link", { name: /^Launch checklist/ })
        .waitFor();
      await this.editor
        .getByRole("link", { name: /^Launch checklist/ })
        .waitFor();
      await this.owner
        .getByRole("button", { name: "Collapse Launch team", exact: true })
        .click();
      await this.editor
        .getByRole("link", { name: /^Launch checklist/ })
        .waitFor();
      await this.owner.reload();
      await this.owner.getByRole("link", { name: "Ask", exact: true }).click();
      await this.owner
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await this.owner
        .getByRole("button", { name: "Expand Launch team", exact: true })
        .waitFor();
      await this.owner
        .getByRole("button", { name: "Expand Launch team", exact: true })
        .click();
      this.checks.push(
        "private drafts, archive Undo, independent collapse and reload persistence",
      );

      await trigger.click();
      await dialog
        .getByRole("button", { name: "Remove Editor", exact: true })
        .click();
      await this.editor
        .getByRole("alert")
        .filter({
          hasText:
            "Project access changed. Unavailable shared content has been cleared.",
        })
        .first()
        .waitFor({ timeout: 15000 });
      if (
        await this.editor
          .getByRole("link", { name: /^Launch checklist/ })
          .count()
      )
        throw new Error("Revoked shared title remains cached");
      if (
        await this.editor
          .getByRole("textbox", { name: "Message your AI", exact: true })
          .inputValue()
      )
        throw new Error("Revoked draft remains rendered");
      await this.editor.screenshot({
        path: "output/playwright/plan-54/authenticated-revoked.png",
        fullPage: true,
      });
      await this.addMember(dialog, "Editor", "editor");
      await this.owner.keyboard.press("Escape");
      await this.editor.reload();
      await this.editor.getByRole("link", { name: "Ask", exact: true }).click();
      await this.editor
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await this.select(this.editor);
      if (
        (await this.editor
          .getByRole("textbox", { name: "Message your AI", exact: true })
          .inputValue()) !== "Editor private draft"
      )
        throw new Error("Personal draft did not restore with membership");
      this.checks.push(
        "live revocation purges shared UI and membership restoration preserves personal draft",
      );
      await this.verifyDelayedWithdrawalNavigation();
      await this.verifyDelayedWithdrawalRevocation();
      await this.verifySelectedChatPagination();
      return {
        checks: this.checks,
        projectId: this.fixtures.projectId,
        conversationId: this.fixtures.sharedCandidate,
        browserContexts: 5,
        selectedChatPaginationCounts: this.paginationCounts,
      };
    }
    async verifyDeniedSharing() {
      const trigger = this.owner.getByRole("button", {
        name: "Actions for History permissions unavailable",
        exact: true,
      });
      await trigger.click();
      await this.owner
        .getByRole("menuitem", { name: "Share with project", exact: true })
        .click();
      const dialog = this.owner.getByRole("dialog", {
        name: "Chat visibility",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Share with project", exact: true })
        .click();
      const alert = dialog.getByRole("alert");
      await alert.filter({ hasText: "could not be verified" }).waitFor();
      if ((await alert.innerText()).includes("Hidden P54B supplier"))
        throw new Error("Denied sharing exposed hidden metadata");
      await this.owner.screenshot({
        path: "output/playwright/plan-54/p54b-denied-sharing.png",
        fullPage: true,
      });
      await dialog
        .getByRole("button", { name: "Keep private", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      if (!(await trigger.evaluate(SharedProjectJourney.ownsFocus)))
        throw new Error("Denied sharing did not restore trigger focus");
      const response = await this.mutate(
        this.owner,
        `/conversations/${this.fixtures.deniedChat}/access`,
        "POST",
        {
          kind: "share_conversation",
          operationId: crypto.randomUUID(),
          expectedRevision: 1,
          projectId: this.fixtures.projectId,
          expectedProjectAccessRevision: 1,
        },
      );
      const failure = await response.json();
      if (
        failure.reason !== "evidence_unavailable" ||
        JSON.stringify(failure).includes("Hidden P54B supplier")
      )
        throw new Error(
          "Unavailable evidence did not produce safe typed feedback",
        );
      for (const peer of [this.editor, this.viewer, this.unrelated]) {
        const directory = await this.read(peer);
        if (JSON.stringify(directory).includes(this.fixtures.deniedChat))
          throw new Error("Denied sharing published private history");
      }
      this.checks.push(
        "P54B typed unavailable-evidence denial, hidden metadata, private continuation and focus restoration",
      );
    }
    async waitDraft(target, expected) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const data = await this.read(
          target,
          `?conversation=${this.fixtures.sharedCandidate}&observe=true`,
        );
        if (data.conversation?.draft.text === expected) return;
        await target.waitForTimeout(100);
      }
      throw new Error("Private draft did not persist");
    }
    async seedQueue() {
      const response = await this.owner.request.post(
        `http://127.0.0.1:8834/test/queue?conversation=${this.fixtures.sharedCandidate}`,
      );
      if (!response.ok()) throw new Error("Queue fixture could not be staged");
    }
    async holdWithdrawal(route) {
      if (
        route.request().method() !== "POST" ||
        route.request().postDataJSON()?.kind !== "withdraw"
      ) {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch();
        if (!response.ok())
          throw new Error(
            `Withdrawal failed: ${response.status()} ${await response.text()}`,
          );
        this.replyReady.resolve();
        await this.releaseReply.promise;
        await route.fulfill({ response });
        this.replyDelivered.resolve();
      } catch (error) {
        this.replyFailure = error;
        this.replyReady.resolve();
        this.replyDelivered.resolve();
      }
    }
    async delayWithdrawal(target) {
      this.replyFailure = null;
      this.replyReady = Promise.withResolvers();
      this.releaseReply = Promise.withResolvers();
      this.replyDelivered = Promise.withResolvers();
      await target.route(
        "**/v1/control/organisations/*/chat",
        this.holdWithdrawal.bind(this),
      );
      await target
        .getByRole("region", { name: "Queued messages", exact: true })
        .getByRole("button", { name: "Remove", exact: true })
        .first()
        .click();
      await this.replyReady.promise;
      if (this.replyFailure !== null) throw this.replyFailure;
    }
    async deliverWithdrawal(target) {
      this.releaseReply.resolve();
      await this.replyDelivered.promise;
      if (this.replyFailure !== null) throw this.replyFailure;
      await target.waitForTimeout(250);
      await target.unroute("**/v1/control/organisations/*/chat");
    }
    async assertQueueCleared(target, screenshot) {
      await target.screenshot({ path: screenshot, fullPage: true });
      if (
        await target
          .getByText("Shared queue must stay hidden after access changes", {
            exact: true,
          })
          .count()
      )
        throw new Error("A delayed withdrawal restored stale shared content");
    }
    async verifyDelayedWithdrawalNavigation() {
      await this.seedQueue();
      await this.select(this.owner);
      await this.delayWithdrawal(this.owner);
      await this.owner
        .getByRole("link", { name: /^Private supplier negotiation/ })
        .click();
      await this.owner
        .getByRole("status")
        .filter({
          hasText: "Shared with project",
        })
        .waitFor({ state: "hidden" });
      const composer = this.owner.getByRole("textbox", {
        name: "Message your AI",
        exact: true,
      });
      await composer.fill("Keep this newly selected private draft");
      await this.deliverWithdrawal(this.owner);
      await this.assertQueueCleared(
        this.owner,
        "output/playwright/plan-54/delayed-withdrawal-navigation.png",
      );
      if (
        (await composer.inputValue()) !==
        "Keep this newly selected private draft"
      )
        throw new Error("Delayed withdrawal changed the newly selected draft");
      this.checks.push(
        "delayed queue replies preserve the newly selected chat and draft",
      );
    }
    async verifyDelayedWithdrawalRevocation() {
      await this.seedQueue();
      await this.editor.goto(
        `http://127.0.0.1:3116/chat-preview.html?preferenceUser=${this.fixtures.users.find(SharedProjectJourney.namedEditor).userId}`,
      );
      await this.editor.getByRole("link", { name: "Ask", exact: true }).click();
      await this.editor
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await this.select(this.editor);
      await this.delayWithdrawal(this.editor);
      await this.owner
        .getByRole("button", {
          name: "Manage access to Launch team",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("dialog", { name: "Project access", exact: true })
        .getByRole("button", { name: "Remove Editor", exact: true })
        .click();
      await this.editor
        .getByRole("alert")
        .filter({
          hasText:
            "Project access changed. Unavailable shared content has been cleared.",
        })
        .first()
        .waitFor({ timeout: 15000 });
      await this.deliverWithdrawal(this.editor);
      await this.assertQueueCleared(
        this.editor,
        "output/playwright/plan-54/delayed-withdrawal-revocation.png",
      );
      if (
        await this.editor
          .getByRole("textbox", { name: "Message your AI", exact: true })
          .inputValue()
      )
        throw new Error("Delayed withdrawal restored a revoked draft");
      this.checks.push(
        "delayed queue replies cannot restore revoked shared content",
      );
    }
    static namedEditor(user) {
      return user.name === "Editor";
    }
    static namedOwner(user) {
      return user.name === "Owner";
    }
    async selectPrivateFromLocation() {
      const owner = this.fixtures.users.find(SharedProjectJourney.namedOwner);
      await this.owner.goto(
        `http://127.0.0.1:3116/chat-preview.html?preferenceUser=${owner.userId}&conversation=${this.fixtures.privateChat}`,
      );
      await this.owner.getByRole("link", { name: "Ask", exact: true }).click();
      await this.owner
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
    }
    async seedPagination(lifecycle) {
      const response = await this.owner.request.post(
        `http://127.0.0.1:8834/test/pagination?lifecycle=${lifecycle}`,
      );
      if (!response.ok()) throw new Error("Pagination fixture failed");
    }
    async assertSelectedOnce(tab) {
      const selected = this.owner.getByRole("link", {
        name: /^Private supplier negotiation/,
      });
      await selected.waitFor();
      await this.owner
        .getByRole("button", { name: "Load more chats", exact: true })
        .click();
      await this.owner
        .getByRole("button", { name: "Load more chats", exact: true })
        .waitFor({ state: "hidden" });
      await selected.first().scrollIntoViewIfNeeded();
      await this.owner.screenshot({
        path: `output/playwright/plan-54/selected-chat-pagination-${tab}.png`,
        fullPage: true,
      });
      const count = await selected.count();
      this.paginationCounts[tab] = count;
      if (count !== 1)
        throw new Error(
          `The selected chat appears ${count} times in the ${tab} directory`,
        );
    }
    async verifySelectedChatPagination() {
      await this.seedPagination("active");
      await this.selectPrivateFromLocation();
      await this.assertSelectedOnce("active");
      const data = await this.read(
        this.owner,
        `?conversation=${this.fixtures.privateChat}&observe=true`,
      );
      const archived = await this.mutate(
        this.owner,
        `/conversations/${this.fixtures.privateChat}`,
        "PATCH",
        { action: "archive", expectedRevision: data.conversation.revision },
      );
      if (!archived.ok())
        throw new Error("Selected chat could not be archived");
      await this.seedPagination("archived");
      await this.selectPrivateFromLocation();
      await this.owner
        .getByRole("tab", { name: "Archived", exact: true })
        .click();
      await this.assertSelectedOnce("archived");
      this.checks.push(
        "selected chats render once across active and archived pagination",
      );
    }
    async close() {
      for (const context of this.contexts) await context.close();
    }
  }
  const journey = new SharedProjectJourney(page, JOURNEY_FIXTURES);
  try {
    return await journey.run();
  } finally {
    await journey.close();
  }
};
