async (page) => {
  // Projects that hold work from every source, seen by an owner, an editor, a
  // viewer, an administrator outside the Project and another organisation.
  // Setup: /test/setup?base=members.
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

  class ProjectCasesJourney {
    constructor(page, fixtures) {
      this.owner = page;
      this.fixtures = fixtures;
      this.base = fixtures.defaultProjectId;
      this.launch = fixtures.projectId;
      this.contexts = [];
      this.checks = [];
      this.overtakeFailure = null;
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
    url(path) {
      return `http://127.0.0.1:8834/v1/control/organisations/${this.fixtures.organisationId}${path}`;
    }
    get(target, path) {
      return target.request.get(this.url(path));
    }
    static isCsrf(cookie) {
      return cookie.name === "satyr_control_csrf";
    }
    async send(target, path, method, body, headers = {}) {
      const cookies = await target.context().cookies("http://127.0.0.1:8834");
      const csrf = cookies.find(ProjectCasesJourney.isCsrf);
      if (!csrf) throw new Error("CSRF cookie missing");
      return target.request.fetch(this.url(path), {
        method,
        headers: {
          origin: "http://127.0.0.1:3116",
          "x-satyr-csrf": csrf.value,
          ...headers,
        },
        data: body,
      });
    }
    async seedSource(origin) {
      const response = await this.owner.request.post(
        `http://127.0.0.1:8834/test/source-case?origin=${origin}`,
      );
      if (!response.ok()) throw new Error(`Source fixture failed: ${origin}`);
      return response.json();
    }
    async listed(target, projectId) {
      const response = await this.get(target, `/projects/${projectId}/cases`);
      if (!response.ok())
        throw new Error(`Project listing returned ${response.status()}`);
      return (await response.json()).cases;
    }
    // The request a member's page sends to file a Case in another Project.
    moveRequest(target, source, projectId, expectedRevision) {
      return this.send(target, `/cases/${source.caseId}/project`, "POST", {
        kind: "move_case",
        operationId: crypto.randomUUID(),
        expectedRevision,
        projectId,
      });
    }
    async assertRefused(target, path, body, code, who) {
      const response = await this.send(target, path, "POST", body);
      const result = await response.json();
      if (response.status() !== 409 || result.code !== code)
        throw new Error(
          `${who}: expected ${code}, received ${response.status()} ${JSON.stringify(result)}`,
        );
    }
    overview(target) {
      return target.locator(".project-overview");
    }
    async openProject(target, projectId) {
      await target
        .locator(`[data-project="${projectId}"] .project-title`)
        .click();
      await this.overview(target).waitFor();
    }
    static trimmed(text) {
      return text.trim();
    }
    // The work from other sources that a member's open Project view shows.
    async sources(target) {
      const labels = await this.overview(target)
        .locator(".project-overview-cases .project-case-source")
        .allInnerTexts();
      return labels.map(ProjectCasesJourney.trimmed).sort().join(", ");
    }
    // Waits past one page observation (five seconds) for a view to settle.
    async until(read, expected, failure) {
      let seen = null;
      for (let attempt = 0; attempt < 150; attempt++) {
        seen = await read();
        if (seen === expected) return;
        await this.owner.waitForTimeout(100);
      }
      throw new Error(`${failure} (showing: ${JSON.stringify(seen)})`);
    }
    shows(target, expected, failure) {
      return this.until(this.sources.bind(this, target), expected, failure);
    }
    async moveBySelect(target, label, destination) {
      await chooseOption(
        target,
        this.overview(target).getByRole("combobox", {
          name: `Move ${label} to another project`,
          exact: true,
        }),
        { label: destination },
      );
    }
    async groupLabel(target) {
      // The group of a member with no chats in it has no size.
      const group = target.locator('[data-default-project="true"]');
      await group.waitFor({ state: "attached" });
      return group.getAttribute("data-chat-group-label");
    }
    capture(target, name) {
      return target.screenshot({
        path: `output/playwright/refactor-9/${name}.png`,
        fullPage: true,
      });
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
    static isChat(entry) {
      return entry.conversationId !== null;
    }
    static named(name, user) {
      return user.name === name;
    }
    static hasCase(caseId, entry) {
      return entry.caseId === caseId;
    }
    async run() {
      await this.owner.setViewportSize({ width: 1200, height: 850 });
      this.slack = await this.seedSource("slack");
      this.email = await this.seedSource("email");
      this.whatsapp = await this.seedSource("whatsapp");
      for (const source of [this.slack, this.email, this.whatsapp])
        if (source.projectId !== this.base || source.revision !== 1)
          throw new Error("A source's new work was not filed in the default");
      await this.open("Owner", this.owner);
      await this.verifyDefaultMarker();
      await this.verifyHeldMove();
      await this.verifyMixedListing();
      await this.verifyPrivateCounts();
      await this.verifyMoves();
      await this.verifyRefusedMoves();
      await this.verifyStaleMove();
      await this.verifyDefaultReplacement();
      await this.verifyDeletionRules();
      await this.verifyProjectRevocation();
      await this.verifyOrganisationRevocation();
      return {
        checks: this.checks,
        defaultProjectId: this.base,
        sharedProjectId: this.launch,
        sourceCases: [
          this.slack.caseId,
          this.email.caseId,
          this.whatsapp.caseId,
          this.later.caseId,
        ],
        browserContexts: 5,
      };
    }
    async verifyDefaultMarker() {
      const group = this.owner.locator(`[data-project="${this.base}"]`);
      await group.waitFor();
      if (
        (await group.getAttribute("data-default-project")) !== "true" ||
        (await group.getAttribute("data-chat-group-label")) !== "Base" ||
        (await group.locator(".project-default").count()) !== 1
      )
        throw new Error("The sidebar does not mark the default Project");
      if (await this.owner.getByText("Ungrouped", { exact: true }).count())
        throw new Error("The sidebar still shows an ungrouped section");
      if (
        await this.owner
          .getByRole("button", { name: "Delete Base", exact: true })
          .count()
      )
        throw new Error("The default Project offers deletion");
      this.checks.push(
        "new source work is filed in the default Project, which the sidebar marks and does not offer to delete",
      );
    }
    // Queued messages keep the Project context they were accepted with, so
    // the chat that holds them does not change Project.
    async verifyHeldMove() {
      const queue = await this.owner.request.post(
        `http://127.0.0.1:8834/test/queue?conversation=${this.fixtures.sharedCandidate}`,
      );
      if (!queue.ok()) throw new Error("Queue fixture could not be staged");
      await this.owner
        .getByRole("button", {
          name: "Actions for Launch checklist",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("menuitem", { name: "Base", exact: true })
        .click();
      const visibility = this.owner.getByRole("dialog", {
        name: "Chat visibility",
        exact: true,
      });
      await visibility
        .getByRole("button", { name: "Move privately", exact: true })
        .click();
      await visibility
        .getByRole("alert")
        .filter({ hasText: "failed response or queued messages" })
        .waitFor();
      await this.capture(this.owner, "move-held-by-queued-messages");
      await this.owner.keyboard.press("Escape");
      await visibility.waitFor({ state: "hidden" });
      const directory = await (await this.get(this.owner, "/chat")).json();
      const held = directory.conversations.find(
        ProjectCasesJourney.hasConversation.bind(
          null,
          this.fixtures.sharedCandidate,
        ),
      );
      if (held?.placement.projectId !== this.launch)
        throw new Error("A chat with queued messages changed Project");
      this.checks.push(
        "a chat with queued messages stays in its Project, and the member is told why",
      );
    }
    static hasConversation(conversationId, conversation) {
      return conversation.id === conversationId;
    }
    async verifyMixedListing() {
      await this.owner
        .getByRole("button", {
          name: "Actions for Private supplier negotiation",
          exact: true,
        })
        .click();
      await this.owner
        .getByRole("menuitem", { name: "Base", exact: true })
        .click();
      const visibility = this.owner.getByRole("dialog", {
        name: "Chat visibility",
        exact: true,
      });
      await visibility
        .getByRole("button", { name: "Move privately", exact: true })
        .click();
      await visibility.waitFor({ state: "hidden" });
      await this.openProject(this.owner, this.base);
      await this.shows(
        this.owner,
        "Email thread, Slack thread, WhatsApp conversation",
        "The default Project does not list its source work",
      );
      await this.overview(this.owner)
        .getByRole("region", { name: "Project chats", exact: true })
        .getByRole("link", { name: /Private supplier negotiation/ })
        .waitFor();
      const listed = await this.listed(this.owner, this.base);
      const chats = listed.filter(ProjectCasesJourney.isChat);
      if (
        listed.length !== 4 ||
        chats.length !== 1 ||
        chats[0].conversationId !== this.fixtures.privateChat
      )
        throw new Error("The owner's listing is not three sources and a chat");
      await this.capture(this.owner, "owner-default-project");
      this.checks.push(
        "a Project lists its chats and its Slack, email and WhatsApp work together",
      );
    }
    async verifyPrivateCounts() {
      this.editor = await this.peer("Editor");
      this.viewer = await this.peer("Viewer");
      this.unrelated = await this.peer("Unrelated");
      this.foreign = await this.peer("Foreign");
      for (const target of [this.editor, this.viewer]) {
        const response = await this.get(target, `/projects/${this.base}/cases`);
        const body = await response.text();
        if (
          JSON.parse(body).cases.length !== 3 ||
          body.includes(this.fixtures.privateChat) ||
          body.includes("Private supplier negotiation")
        )
          throw new Error("Another member's private chat entered a listing");
        await this.openProject(target, this.base);
        await this.shows(
          target,
          "Email thread, Slack thread, WhatsApp conversation",
          "A member of the default Project does not see its source work",
        );
        if (
          await target
            .getByText("Private supplier negotiation", { exact: true })
            .count()
        )
          throw new Error("Another member's private chat title is on screen");
      }
      await this.capture(this.editor, "editor-default-project");
      if (
        (await this.groupLabel(this.unrelated)) !== "Default project" ||
        (await this.unrelated.locator(".project-title").count()) !== 0
      )
        throw new Error("A non-member is shown the default Project's details");
      for (const target of [this.unrelated, this.foreign]) {
        const response = await this.get(target, `/projects/${this.base}/cases`);
        if (response.status() !== 404)
          throw new Error(`A non-member listing returned ${response.status()}`);
      }
      this.checks.push(
        "another member's private chat is absent from a listing and from its length; a non-member and another organisation read nothing",
      );
    }
    async verifyMoves() {
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
      await this.owner.keyboard.press("Escape");
      await this.moveBySelect(this.owner, "Slack thread", "Launch team");
      await this.shows(
        this.owner,
        "Email thread, WhatsApp conversation",
        "A moved entry stayed in the Project it left",
      );
      await this.openProject(this.owner, this.launch);
      await this.shows(
        this.owner,
        "Slack thread",
        "A moved entry did not arrive in its new Project",
      );
      // The editor's page has not been reloaded since the Project was shared.
      await this.shows(
        this.editor,
        "Email thread, WhatsApp conversation",
        "An open list kept work that another member moved away",
      );
      await this.moveBySelect(this.editor, "Email thread", "Launch team");
      await this.shows(
        this.editor,
        "WhatsApp conversation",
        "The editor's move did not leave the default Project",
      );
      await this.shows(
        this.owner,
        "Email thread, Slack thread",
        "An open list did not gain work that another member moved in",
      );
      const placement = (
        await (
          await this.get(this.owner, `/cases/${this.email.caseId}/project`)
        ).json()
      ).placement;
      if (placement.projectId !== this.launch || placement.revision !== 2)
        throw new Error("The editor's move was not recorded on the Case");
      await this.capture(this.owner, "owner-shared-project");
      this.checks.push(
        "an owner and an editor move source work into a shared Project; other members' open lists follow without a reload",
      );
    }
    async verifyRefusedMoves() {
      await this.shows(
        this.viewer,
        "WhatsApp conversation",
        "The viewer's open list did not follow the moves",
      );
      if (await this.overview(this.viewer).getByRole("combobox").count())
        throw new Error("A viewer is offered a Project they cannot edit");
      await this.capture(this.viewer, "viewer-default-project");
      for (const [who, target] of [
        ["Viewer", this.viewer],
        ["Unrelated", this.unrelated],
      ]) {
        const refused = await this.moveRequest(
          target,
          this.whatsapp,
          this.launch,
          1,
        );
        const result = await refused.json();
        if (
          refused.status() !== 409 ||
          result.code !== "case_destination_unavailable"
        )
          throw new Error(
            `${who} moved work into a Project they cannot edit: ${refused.status()} ${JSON.stringify(result)}`,
          );
      }
      const outside = await this.get(
        this.unrelated,
        `/projects/${this.launch}/cases`,
      );
      if (outside.status() !== 404)
        throw new Error(`A non-member listing returned ${outside.status()}`);
      const foreign = await this.moveRequest(
        this.foreign,
        this.whatsapp,
        this.launch,
        1,
      );
      if (foreign.status() !== 404)
        throw new Error(`Another organisation's move: ${foreign.status()}`);
      const placement = (
        await (
          await this.get(this.owner, `/cases/${this.whatsapp.caseId}/project`)
        ).json()
      ).placement;
      if (placement.projectId !== this.base || placement.revision !== 1)
        throw new Error("A refused move changed where the Case is filed");
      this.checks.push(
        "a viewer, an administrator outside the Project and another organisation cannot move work into it, and the viewer is offered no destination",
      );
    }
    // The editor files the Case elsewhere after the owner's page has chosen a
    // destination and before the owner's request reaches the server.
    async overtake(route) {
      try {
        const first = await this.moveRequest(
          this.editor,
          this.whatsapp,
          this.launch,
          1,
        );
        if (!first.ok())
          throw new Error(`The overtaking move returned ${first.status()}`);
        await route.continue();
      } catch (error) {
        this.overtakeFailure = error;
        await route.abort();
      }
    }
    async verifyStaleMove() {
      await this.openProject(this.owner, this.base);
      await this.shows(
        this.owner,
        "WhatsApp conversation",
        "The owner's default Project view is not current",
      );
      await this.owner.route("**/cases/*/project", this.overtake.bind(this));
      await this.moveBySelect(
        this.owner,
        "WhatsApp conversation",
        "Launch team",
      );
      await this.overview(this.owner)
        .getByRole("alert")
        .filter({ hasText: "This work changed in another window" })
        .waitFor();
      await this.owner.unroute("**/cases/*/project");
      if (this.overtakeFailure !== null) throw this.overtakeFailure;
      await this.shows(
        this.owner,
        "",
        "A refused move left its stale entry on screen",
      );
      await this.capture(this.owner, "stale-move-refused");
      await this.openProject(this.owner, this.launch);
      await this.shows(
        this.owner,
        "Email thread, Slack thread, WhatsApp conversation",
        "The overtaking move is missing from the shared Project",
      );
      await this.moveBySelect(this.owner, "WhatsApp conversation", "Base");
      await this.shows(
        this.owner,
        "Email thread, Slack thread",
        "Work did not return to the default Project",
      );
      const placement = (
        await (
          await this.get(this.owner, `/cases/${this.whatsapp.caseId}/project`)
        ).json()
      ).placement;
      if (placement.projectId !== this.base || placement.revision !== 3)
        throw new Error("The Case did not record both accepted moves");
      this.checks.push(
        "a move decided on a stale list is refused, the entry leaves the screen, and work can return to the default Project",
      );
    }
    async verifyDefaultReplacement() {
      await this.openProject(this.editor, this.launch);
      await this.shows(
        this.editor,
        "Email thread, Slack thread",
        "The editor does not see the shared Project's work",
      );
      if (
        await this.editor
          .getByRole("button", { name: "Make default", exact: true })
          .count()
      )
        throw new Error("An editor is offered the default Project choice");
      const catalogue = await (await this.get(this.editor, "/projects")).json();
      await this.assertRefused(
        this.editor,
        "/projects",
        {
          kind: "set_default_project",
          operationId: crypto.randomUUID(),
          projectId: this.launch,
          expectedDefaultRevision: catalogue.defaultProject.revision,
        },
        "default_project_ineligible",
        "An editor choosing the default",
      );
      await this.owner
        .getByRole("button", { name: "Make default", exact: true })
        .click();
      await this.owner
        .locator(`[data-project="${this.launch}"][data-default-project="true"]`)
        .waitFor();
      if (
        await this.owner
          .locator(`[data-project="${this.base}"][data-default-project="true"]`)
          .count()
      )
        throw new Error("Two Projects are marked as the default");
      this.later = await this.seedSource("slack");
      if (this.later.projectId !== this.launch)
        throw new Error("Later source work was not filed in the new default");
      await this.shows(
        this.owner,
        "Email thread, Slack thread, Slack thread",
        "Later source work did not appear in the new default Project",
      );
      const earlier = await this.listed(this.owner, this.base);
      if (
        !earlier.some(
          ProjectCasesJourney.hasCase.bind(null, this.whatsapp.caseId),
        )
      )
        throw new Error("Replacing the default moved work already filed");
      await this.capture(this.owner, "owner-new-default");
      this.checks.push(
        "only an owner makes a shared Project the default; later source work is filed there and earlier work stays where it was",
      );
    }
    async verifyDeletionRules() {
      if (
        await this.owner
          .getByRole("button", { name: "Delete Launch team", exact: true })
          .count()
      )
        throw new Error("The new default Project offers deletion");
      const projects = (await (await this.get(this.owner, "/projects")).json())
        .projects;
      const launch = projects.find(
        ProjectCasesJourney.hasProject.bind(null, this.launch),
      );
      await this.assertRefused(
        this.owner,
        "/projects",
        {
          kind: "delete_project",
          operationId: crypto.randomUUID(),
          projectId: this.launch,
          expectedProjectRevision: launch.revision,
          expectedAccessRevision: launch.access.accessRevision,
        },
        "project_is_default",
        "Deleting the default Project",
      );
      await this.owner
        .getByRole("button", { name: "Delete Base", exact: true })
        .click();
      const dialog = this.owner.getByRole("dialog", {
        name: "Delete project",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Delete permanently", exact: true })
        .click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Move the Slack, email and other work" })
        .waitFor();
      await this.capture(this.owner, "delete-blocked-by-source-work");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      this.checks.push(
        "the default Project cannot be deleted, and a Project that holds source work is not deleted until that work moves",
      );
    }
    static hasProject(projectId, project) {
      return project.id === projectId;
    }
    async verifyProjectRevocation() {
      await this.shows(
        this.editor,
        "Email thread, Slack thread, Slack thread",
        "The editor's open list is not current before revocation",
      );
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
      await this.owner.keyboard.press("Escape");
      await this.overview(this.editor).waitFor({
        state: "detached",
        timeout: 15000,
      });
      if (
        (await this.editor.getByText("Slack thread", { exact: true }).count()) +
          (await this.editor
            .locator(`[data-project="${this.launch}"] .project-title`)
            .count()) !==
        0
      )
        throw new Error("A revoked Project remains on the member's page");
      const listing = await this.get(
        this.editor,
        `/projects/${this.launch}/cases`,
      );
      if (listing.status() !== 404)
        throw new Error(`A revoked listing returned ${listing.status()}`);
      if ((await this.groupLabel(this.editor)) !== "Default project")
        throw new Error("A revoked member is shown the default's details");
      await this.capture(this.editor, "editor-revoked");
      this.checks.push(
        "removing a member clears the Project and its work from their open page and refuses their reads",
      );
    }
    async verifyOrganisationRevocation() {
      const viewer = this.fixtures.users.find(
        ProjectCasesJourney.named.bind(null, "Viewer"),
      );
      await this.shows(
        this.viewer,
        "WhatsApp conversation",
        "The viewer's open list is not current before revocation",
      );
      const revoked = await this.send(
        this.owner,
        `/members/${viewer.userId}`,
        "DELETE",
        {},
        {
          "idempotency-key": `journey-${crypto.randomUUID()}`,
          "x-satyr-configuration-version": "1",
        },
      );
      if (!revoked.ok())
        throw new Error(
          `Member revocation returned ${revoked.status()} ${await revoked.text()}`,
        );
      for (const projectId of [this.base, this.launch]) {
        const listing = await this.get(
          this.viewer,
          `/projects/${projectId}/cases`,
        );
        if (listing.ok())
          throw new Error("A former member still lists a Project's work");
        const access = await this.get(
          this.owner,
          `/projects/${projectId}/access`,
        );
        if (
          !access.ok() ||
          JSON.stringify((await access.json()).members).includes(viewer.userId)
        )
          throw new Error("A former member kept a shared Project membership");
      }
      await this.overview(this.viewer).waitFor({
        state: "detached",
        timeout: 15000,
      });
      if (
        await this.viewer
          .getByText("WhatsApp conversation", { exact: true })
          .count()
      )
        throw new Error("A former member's page still shows Project work");
      await this.capture(this.viewer, "viewer-left-organisation");
      this.checks.push(
        "a member who leaves the organisation loses their shared Project memberships, their reads and what their open page showed",
      );
    }
    async close() {
      for (const context of this.contexts) await context.close();
    }
  }
  const journey = new ProjectCasesJourney(page, JOURNEY_FIXTURES);
  try {
    return await journey.run();
  } finally {
    await journey.close();
  }
};
