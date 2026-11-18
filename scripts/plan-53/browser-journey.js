async (page) => {
  class Journey {
    constructor(page) {
      this.page = page;
    }
    static cacheState() {
      const userId = new URL(location.href).searchParams.get("preferenceUser");
      return JSON.parse(
        localStorage.getItem(`satyr:preferences:${userId}:chat`) ?? "null",
      );
    }
    static storedChatKeys() {
      const keys = [];
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("satyr:preferences:") && key.endsWith(":chat"))
          keys.push(key);
      }
      return keys;
    }
    static isChatKey(key) {
      return key.startsWith("satyr:preferences:") && key.endsWith(":chat");
    }
    static width(element) {
      return Math.round(element.getBoundingClientRect().width);
    }
    static pointerCancel(element) {
      element.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
      );
    }
    static chatHasVisibleFocus() {
      const focused = document.activeElement;
      return (
        focused.closest("#workspace-chat") !== null &&
        focused.getClientRects().length > 0
      );
    }
    static isFocused(element) {
      return document.activeElement === element;
    }
    static failSaves() {
      window.plan53FailSaves = true;
    }
    static allowSaves() {
      window.plan53FailSaves = false;
    }
    static holdWrites() {
      window.plan53HoldWrites = true;
    }
    static releaseWrites() {
      window.plan53HoldWrites = false;
    }
    static retryTwice(element) {
      element.click();
      element.click();
    }
    static peakChatWrites() {
      return window.plan53PeakChatWrites;
    }
    static writePending() {
      return window.plan53WritePending;
    }
    static requests() {
      return window.plan53PreferenceRequests;
    }
    static theme() {
      return document.documentElement.dataset.portalTheme;
    }
    async login(name, target = this.page) {
      const response = await target.request.post(
        `http://127.0.0.1:8833/test/session?user=${name}`,
      );
      if (!response.ok()) throw new Error("Session fixture failed");
      return (await response.json()).userId;
    }
    async read(area = "chat", target = this.page) {
      const response = await target.request.get(
        `http://127.0.0.1:8833/v1/control/user/preferences/${area}`,
      );
      if (!response.ok()) throw new Error(`Read failed: ${response.status()}`);
      return response.json();
    }
    async edit(area, command, target = this.page) {
      const current = await this.read(area, target);
      const cookies = await target.context().cookies("http://127.0.0.1:8833");
      const csrf = cookies.find(Journey.isCsrf);
      const response = await target.request.patch(
        `http://127.0.0.1:8833/v1/control/user/preferences/${area}`,
        {
          headers: {
            origin: "http://127.0.0.1:3115",
            "x-satyr-csrf": csrf.value,
          },
          data: {
            expectedUserId: current.userId,
            expectedRevision: current.revision,
            command,
          },
        },
      );
      if (!response.ok()) throw new Error(`Edit failed: ${response.status()}`);
      return (await response.json()).document;
    }
    static isCsrf(cookie) {
      return cookie.name === "satyr_control_csrf";
    }
    async reset(target = this.page) {
      for (const area of ["appearance", "chat", "bakeryos"])
        await this.edit(area, { kind: "reset" }, target);
    }
    async open(userId, target = this.page) {
      await target.goto(
        `http://127.0.0.1:3115/chat-preview.html?preferenceUser=${userId}`,
      );
      await target.getByRole("link", { name: "Ask", exact: true }).click();
      await target
        .getByRole("heading", { name: "What would you like to do?" })
        .waitFor();
      await target.waitForTimeout(700);
    }
    async expectWidth(expected, target = this.page) {
      let width = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        width = await target.locator(".chat-underlay").evaluate(Journey.width);
        if (Math.abs(width - expected) <= 1) return width;
        await target.waitForTimeout(50);
      }
      throw new Error(`Expected panel width ${expected}, got ${width}`);
    }

    async waitWidth(expected, target = this.page) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const document = await this.read("chat", target);
        if (document.values.dockedPanelWidthPx === expected) return document;
        await target.waitForTimeout(100);
      }
      throw new Error(`Width ${expected} was not persisted`);
    }
    async waitSidebar(expected) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const document = await this.read();
        if (document.values.fullscreenSidebarWidthPx === expected)
          return document;
        await this.page.waitForTimeout(100);
      }
      throw new Error(`Sidebar ${expected} was not persisted`);
    }
    async dragTo(width, release = true) {
      const separator = this.page.getByRole("separator", {
        name: "Resize chat",
        exact: true,
      });
      await separator.hover();
      const box = await separator.boundingBox();
      const current = await this.page
        .locator(".chat-underlay")
        .evaluate(Journey.width);
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.mouse.down();
      await this.page.mouse.move(
        box.x + box.width / 2 - (width - current),
        box.y + box.height / 2,
        { steps: 8 },
      );
      if (release) await this.page.mouse.up();
      return separator;
    }
    async dragSidebarTo(width, release = true) {
      const separator = this.page.getByRole("separator", {
        name: "Resize threads sidebar",
        exact: true,
      });
      const edge = await separator.boundingBox();
      const sidebar = await this.page
        .locator(".chat-layout > .chat-thread-sidebar")
        .boundingBox();
      await this.page.mouse.move(
        edge.x + edge.width / 2,
        edge.y + edge.height / 2,
      );
      await this.page.mouse.down();
      await this.page.mouse.move(sidebar.x + width, edge.y + edge.height / 2, {
        steps: 4,
      });
      if (release) await this.page.mouse.up();
      return separator;
    }
    static conflictTwice() {
      window.plan53ConflictBudget = 2;
    }
    static releaseReads() {
      window.plan53ReleaseReads = true;
    }
    async waitValue(area, field, expected) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const document = await this.read(area);
        const value =
          field === "scene" ? document.values.scene : document.values[field];
        if (JSON.stringify(value) === JSON.stringify(expected)) return document;
        await this.page.waitForTimeout(100);
      }
      throw new Error(`Preference ${area}.${field} did not persist`);
    }
    async chooseAccount(name) {
      await this.page
        .getByRole("button", { name: "Account appearance", exact: true })
        .click();
      await this.page.getByRole("menuitemradio", { name, exact: true }).click();
    }
    async chooseBakery(name) {
      await this.page
        .getByRole("button", { name: "Kitchen appearance", exact: true })
        .click();
      await this.page.getByRole("menuitemradio", { name, exact: true }).click();
    }
    static isRejectedPreferenceSave(response) {
      return (
        response.url().endsWith("/v1/control/user/preferences/chat") &&
        response.request().method() === "PATCH" &&
        response.status() === 409
      );
    }
    async accountSwitchAcrossTabs() {
      const alice = await this.login("alice");
      const aliceBefore = await this.read();
      await this.open(alice);
      const otherTab = await this.page.context().newPage();
      await this.login("bob", otherTab);
      const bobBefore = await this.read("chat", otherTab);
      const feedback = this.page
        .locator('[data-sonner-toast][data-removed="false"]')
        .filter({ hasText: "Your preferences have not synced." });
      if (aliceBefore.revision !== bobBefore.revision)
        throw new Error("Use a fresh acceptance database for equal revisions");
      const rejected = this.page.waitForResponse(
        Journey.isRejectedPreferenceSave,
      );
      await this.dragTo(700);
      const rejection = await (await rejected).json();
      if (rejection.error !== "preferences_user_changed")
        throw new Error("Stale-tab save did not reject the account change");
      await feedback.waitFor();
      await this.expectWidth(700);
      const retryRejected = this.page.waitForResponse(
        Journey.isRejectedPreferenceSave,
      );
      await feedback
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await retryRejected;
      await feedback.waitFor();
      const bobAfter = await this.read("chat", otherTab);
      if (JSON.stringify(bobAfter) !== JSON.stringify(bobBefore))
        throw new Error("Stale tab changed the newly signed-in account");
      if (
        JSON.stringify(await this.page.evaluate(Journey.cacheState)) !==
        JSON.stringify(aliceBefore)
      )
        throw new Error("Rejected account change polluted the accepted cache");
      await this.page.screenshot({
        path: "output/playwright/plan-53/account-switch.png",
      });
      await this.login("alice", otherTab);
      const aliceUnchanged = await this.read("chat", otherTab);
      if (JSON.stringify(aliceUnchanged) !== JSON.stringify(aliceBefore))
        throw new Error("Rejected stale-tab edit changed its original account");
      await feedback
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      const recovered = await this.waitWidth(700);
      await this.open(alice);
      await this.expectWidth(700);
      await otherTab.close();
      return {
        sameCookieJar: true,
        equalStartingRevision: aliceBefore.revision,
        staleSaveAndRetryRejected: true,
        bothAccountsUnchanged: true,
        acceptedCacheUnchanged: true,
        sameUserNewSessionRetryAndReload: true,
        recoveredWidth: recovered.values.dockedPanelWidthPx,
      };
    }

    static async mountQueueControls(userId) {
      const { UserPreferenceOwner } = await import("/src/preferences/owner.ts");
      class Controls {
        constructor(userId) {
          this.owner = new UserPreferenceOwner(userId);
          document.getElementById("root").hidden = true;
          const section = document.createElement("section");
          section.style.padding = "32px";
          section.innerHTML = `<h1>Kitchen preference queue acceptance</h1>
            <p>Synthetic controls · real Portal preference owner · isolated Worker and D1</p>
            <button id="queue-all">All labels</button>
            <button id="queue-reset">Reset Kitchen preferences</button>
            <button id="queue-off">Labels off</button>
            <pre id="queue-values"></pre>`;
          document.body.append(section);
          document.getElementById("queue-all").onclick = this.labels.bind(
            this,
            "all",
          );
          document.getElementById("queue-off").onclick = this.labels.bind(
            this,
            "off",
          );
          document.getElementById("queue-reset").onclick =
            this.reset.bind(this);
          this.owner.subscribe(this.render.bind(this));
        }
        labels(labels) {
          this.owner.edit({
            area: "bakeryos",
            command: { kind: "set_scene_labels", labels },
          });
        }
        reset() {
          this.owner.edit({ area: "bakeryos", command: { kind: "reset" } });
        }
        render() {
          document.getElementById("queue-values").textContent = JSON.stringify(
            this.owner.document("bakeryos").values.scene,
          );
        }
        async start() {
          this.owner.start();
          await this.owner.load("bakeryos");
          this.render();
        }
      }
      await new Controls(userId).start();
    }

    static allowBakeryReads() {
      window.plan53FailBakeryReads = false;
    }
    async queuedResetJourney(alice, second) {
      await this.edit("bakeryos", { kind: "reset" });
      await this.page.goto(
        `http://127.0.0.1:3115/chat-preview.html?preferenceUser=${alice}`,
      );
      await this.page.evaluate(Journey.mountQueueControls, alice);
      await this.login("alice", second);
      await this.edit(
        "bakeryos",
        { kind: "set_minimap", visible: true },
        second,
      );
      await this.page.evaluate(Journey.holdWrites);
      await this.page
        .getByRole("button", { name: "All labels", exact: true })
        .click();
      await this.page.waitForFunction(Journey.writePending);
      await this.page
        .getByRole("button", {
          name: "Reset Kitchen preferences",
          exact: true,
        })
        .click();
      await this.page
        .getByRole("button", { name: "Labels off", exact: true })
        .click();
      const optimistic = JSON.parse(
        await this.page.locator("#queue-values").innerText(),
      );
      if (optimistic.labels !== "off" || optimistic.minimap !== false)
        throw new Error("Reset erased the newer local choice before saving");
      await this.page.evaluate(Journey.releaseWrites);
      const accepted = await this.waitValue("bakeryos", "scene", {
        labels: "off",
        minimap: false,
      });
      const requests = await this.page.evaluate(Journey.requests);
      if (!requests.some(Journey.isConflict))
        throw new Error(
          "Reset ordering did not exercise a real revision conflict",
        );
      const cached = await this.page.evaluate(
        Journey.cacheStateForArea,
        "bakeryos",
      );
      if (JSON.stringify(cached) !== JSON.stringify(accepted))
        throw new Error(
          "Accepted reset and newer choice did not reach the cache",
        );
      await this.page.screenshot({
        path: "output/playwright/plan-53/queued-reset.png",
      });
      await this.page.goto(
        `http://127.0.0.1:3115/workflow-preview.html?preferenceUser=${alice}&failBakeryPreferences=1`,
      );
      const feedback = this.page
        .locator('[data-sonner-toast][data-removed="false"]')
        .filter({ hasText: "Your preferences have not synced." });
      await feedback.waitFor();
      await this.page
        .getByRole("button", { name: "Labels: Off", exact: true })
        .waitFor();
      const dismiss = feedback.getByRole("button", {
        name: "Close toast",
        exact: true,
      });
      await dismiss.focus();
      await dismiss.press("Enter");
      await feedback.waitFor({ state: "hidden" });
      await this.page
        .getByRole("button", { name: "Labels: Off", exact: true })
        .click();
      await this.page
        .getByRole("menuitemradio", { name: "All details", exact: false })
        .click();
      const overview = this.page.getByRole("button", {
        name: "Floor plan overview",
        exact: true,
      });
      await overview.click();
      if ((await overview.getAttribute("aria-pressed")) !== "true")
        throw new Error("Failed read erased the newer minimap choice");
      const duringFailure = await this.read("bakeryos");
      if (duringFailure.revision !== accepted.revision)
        throw new Error("Failed initial reads wrote pending choices");
      if (
        JSON.stringify(
          await this.page.evaluate(Journey.cacheStateForArea, "bakeryos"),
        ) !== JSON.stringify(accepted)
      )
        throw new Error("Unsaved choices replaced the accepted scene cache");
      await this.page.screenshot({
        path: "output/playwright/plan-53/failed-read-controls.png",
      });
      await this.page.evaluate(Journey.allowBakeryReads);
      const retry = feedback.getByRole("button", {
        name: "Retry",
        exact: true,
      });
      await retry.focus();
      await retry.press("Enter");
      const recovered = await this.waitValue("bakeryos", "scene", {
        labels: "all",
        minimap: true,
      });
      const recoveryRequests = await this.page.evaluate(Journey.requests);
      await this.page.goto(
        `http://127.0.0.1:3115/workflow-preview.html?preferenceUser=${alice}`,
      );
      await this.page
        .getByRole("button", { name: "Labels: All details", exact: true })
        .waitFor();
      if ((await overview.getAttribute("aria-pressed")) !== "true")
        throw new Error("Recovered minimap choice did not restore");
      const restored = await this.read("bakeryos");
      if (restored.revision !== recovered.revision)
        throw new Error("Reload wrote restored scene preferences");
      await this.page.screenshot({
        path: "output/playwright/plan-53/read-recovery.png",
      });
      return {
        realConflictBeforeReset: true,
        queuedResetPreservesNewerChoice: accepted.values.scene,
        acceptedCacheRestored: true,
        initialReadFailureRetainsChoices: true,
        readRetrySavesBothChoices: recovered.values.scene,
        errorFeedbackLeavesPointerControlsUsable: true,
        keyboardDismissAndRetry: true,
        reloadWithoutWrite: true,
        requests,
        recoveryRequests,
      };
    }
    static cacheStateForArea(area) {
      const userId = new URL(location.href).searchParams.get("preferenceUser");
      return JSON.parse(
        localStorage.getItem(`satyr:preferences:${userId}:${area}`) ?? "null",
      );
    }
    async resizeLifecycleJourney(alice) {
      await this.edit("chat", { kind: "reset" });
      await this.open(alice);
      const separator = this.page.getByRole("separator", {
        name: "Resize chat",
        exact: true,
      });
      await separator.focus();
      await this.page.clock.install();
      await this.page.clock.pauseAt(Date.now() + 1000);
      await separator.press("ArrowLeft");
      await this.expectWidth(650);
      await this.dragTo(800);
      await this.waitWidth(800);
      await this.page.clock.runFor(300);
      await this.expectWidth(800);
      const pointerAfterKeyboard = await this.read();
      if (pointerAfterKeyboard.values.dockedPanelWidthPx !== 800)
        throw new Error(
          "Pending keyboard save overwrote the later pointer drag",
        );
      await this.page.clock.resume();

      await this.edit("chat", {
        kind: "set_fullscreen_chat_sidebar_width",
        widthPx: 500,
      });
      await this.open(alice);
      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      const sidebar = this.page.locator(".chat-layout > .chat-thread-sidebar");
      const edge = this.page.getByRole("separator", {
        name: "Resize threads sidebar",
        exact: true,
      });
      await this.page.setViewportSize({ width: 900, height: 1000 });
      await this.page.waitForTimeout(100);
      const constrainedWidth = await sidebar.evaluate(Journey.width);
      if (constrainedWidth >= 500)
        throw new Error("Sidebar viewport constraint was not exercised");
      const beforeClick = await this.read();
      await edge.click();
      const edgeBounds = await edge.boundingBox();
      const sidebarBounds = await sidebar.boundingBox();
      await this.page.mouse.move(
        edgeBounds.x + edgeBounds.width / 2,
        edgeBounds.y + edgeBounds.height / 2,
      );
      await this.page.mouse.down();
      await this.page.mouse.move(
        sidebarBounds.x + 300,
        edgeBounds.y + edgeBounds.height / 2,
        { steps: 4 },
      );
      await edge.evaluate(Journey.pointerCancel);
      await this.page.mouse.up();
      await this.page.setViewportSize({ width: 1600, height: 1000 });
      await this.page.waitForTimeout(100);
      const restoredWidth = await sidebar.evaluate(Journey.width);
      if (restoredWidth !== 500)
        throw new Error(
          `Resize-edge click or cancellation replaced the preferred width with ${restoredWidth}`,
        );
      if (Number(await edge.getAttribute("aria-valuenow")) !== 500)
        throw new Error(
          "Cancelled resize retained the drag's accessible value",
        );
      const afterClick = await this.read();
      if (afterClick.revision !== beforeClick.revision)
        throw new Error("Resize-edge click wrote a preference");
      await this.page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await this.dragTo(1300, false);
      await this.expectWidth(800);
      if (Number(await separator.getAttribute("aria-valuemax")) !== 800)
        throw new Error("Docked resize limit exceeds half the viewport");
      if ((await this.read()).revision !== afterClick.revision)
        throw new Error("Drag at the width limit saved before completion");
      await this.page.mouse.up();
      await separator.focus();
      await separator.press("Home");
      await this.expectWidth(340);
      await separator.press("End");
      await separator.press("Tab");
      await this.expectWidth(800);
      await this.waitWidth(800);
      const beforeFullscreen = await this.read();
      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      const fullscreenWidth = await this.expectWidth(1600);
      await this.page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await this.expectWidth(800);
      if ((await this.read()).revision !== beforeFullscreen.revision)
        throw new Error("Fullscreen changed the docked preference");

      await this.page.emulateMedia({ reducedMotion: "no-preference" });
      await this.dragTo(650, false);
      await this.page.setViewportSize({ width: 2000, height: 1000 });
      await this.expectWidth(800);
      await this.page.mouse.move(1250, 500);
      await this.page.mouse.up();
      await this.page.waitForTimeout(400);
      await this.expectWidth(800);
      if ((await this.read()).revision !== beforeFullscreen.revision)
        throw new Error("A drag continued with stale viewport geometry");

      await this.page.setViewportSize({ width: 1600, height: 1000 });
      await this.page.waitForTimeout(100);
      await this.dragTo(650, false);
      await this.page.setViewportSize({ width: 700, height: 1000 });
      const compactWidth = await this.expectWidth(676);
      await this.page.waitForFunction(Journey.chatHasVisibleFocus);
      await this.page.mouse.move(500, 500);
      await this.page.mouse.up();
      await this.page.keyboard.press("Tab");
      if (!(await this.page.evaluate(Journey.chatHasVisibleFocus)))
        throw new Error("Keyboard navigation left the compact chat");
      await this.page.screenshot({
        path: "output/playwright/plan-53/compact.png",
      });
      await this.page
        .getByRole("button", { name: "Chat context: Workspace", exact: true })
        .click();
      const closeContext = this.page.getByRole("button", {
        name: "Close chat context",
        exact: true,
      });
      await closeContext.focus();
      await this.page.setViewportSize({ width: 660, height: 1000 });
      await this.page.waitForTimeout(100);
      if (!(await closeContext.evaluate(Journey.isFocused)))
        throw new Error("Compact resizing stole focus from the chat popup");
      await closeContext.click();
      await this.page.setViewportSize({ width: 700, height: 1000 });
      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      const compactFullscreenWidth = await this.expectWidth(700);
      await this.page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await this.expectWidth(676);
      await this.page.waitForTimeout(400);
      if ((await this.read()).revision !== beforeFullscreen.revision)
        throw new Error("The compact drawer saved an interrupted drag");

      await this.page.setViewportSize({ width: 1600, height: 1000 });
      await this.expectWidth(800);
      await this.dragTo(700, false);
      await separator.press("ArrowRight");
      const keyboardHandoff = await this.waitWidth(650);
      await this.page.mouse.up();
      await this.page.waitForTimeout(400);
      await this.expectWidth(650);
      if ((await this.read()).revision !== keyboardHandoff.revision)
        throw new Error("Pointer release overwrote the docked keyboard choice");

      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      await this.dragSidebarTo(300, false);
      await edge.press("ArrowRight");
      const sidebarHandoff = await this.waitSidebar(320);
      await this.page.mouse.up();
      await this.page.waitForTimeout(400);
      if (
        (await sidebar.evaluate(Journey.width)) !== 320 ||
        (await this.read()).revision !== sidebarHandoff.revision
      )
        throw new Error(
          "Pointer release overwrote the sidebar keyboard choice",
        );

      await this.dragSidebarTo(250, false);
      await this.page.setViewportSize({ width: 700, height: 1000 });
      await this.page.waitForFunction(Journey.chatHasVisibleFocus);
      await this.page.mouse.up();
      await this.page.waitForTimeout(400);
      if (!(await this.page.evaluate(Journey.chatHasVisibleFocus)))
        throw new Error("Hidden sidebar resize handle lost chat focus");
      await this.page.setViewportSize({ width: 1600, height: 1000 });
      await this.page.waitForTimeout(400);
      if (
        (await sidebar.evaluate(Journey.width)) !== 320 ||
        (await this.read()).revision !== sidebarHandoff.revision
      )
        throw new Error("Sidebar breakpoint saved an interrupted drag");

      await this.page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await this.dragTo(700, false);
      await separator.press("Escape");
      await this.page.mouse.up();
      await this.page.getByRole("link", { name: "Ask", exact: true }).click();
      await this.expectWidth(650);
      if ((await this.read()).revision !== sidebarHandoff.revision)
        throw new Error("Closing the chat saved an interrupted drag");
      await this.page.emulateMedia({ reducedMotion: "reduce" });
      return {
        pointerAfterKeyboardWidth:
          pointerAfterKeyboard.values.dockedPanelWidthPx,
        constrainedSidebarWidth: constrainedWidth,
        preferredSidebarRestoredAfterClick: restoredWidth,
        resizeEdgeClickWithoutWrite: true,
        sidebarCancellationWithoutWrite: true,
        dockedMaximumWidth: 800,
        pointerAndKeyboardRespectHalfViewport: true,
        fullscreenWidth,
        viewportChangeCancelsDragWithoutWrite: true,
        compactWidth,
        compactFullscreenWidth,
        compactTransitionPreservesChatFocus: true,
        compactResizePreservesPopupFocus: true,
        pointerToKeyboardDockedWidth: keyboardHandoff.values.dockedPanelWidthPx,
        pointerToKeyboardSidebarWidth:
          sidebarHandoff.values.fullscreenSidebarWidthPx,
        sidebarBreakpointCancelsDragWithoutWrite: true,
        closingChatCancelsDragWithoutWrite: true,
        defaultMotionResizing: true,
      };
    }
    async bakeryJourney(alice, second) {
      const chatBefore = await this.read();
      await this.page.goto(
        `http://127.0.0.1:3115/workflow-preview.html?preferenceUser=${alice}`,
      );
      await this.page
        .getByRole("button", { name: "Labels: Auto", exact: true })
        .waitFor();
      await this.page
        .getByRole("button", { name: "Labels: Auto", exact: true })
        .click();
      await this.page
        .getByRole("menuitemradio", { name: "All details", exact: false })
        .click();
      await this.page
        .getByRole("button", { name: "Floor plan overview", exact: true })
        .click();
      const scene = await this.waitValue("bakeryos", "scene", {
        labels: "all",
        minimap: true,
      });
      await this.chooseBakery("Light");
      await this.waitValue("bakeryos", "appearance", {
        kind: "custom",
        value: { mode: "light", palette: "sage" },
      });
      await this.chooseAccount("Light");
      await this.waitValue("appearance", "mode", "light");
      await this.chooseAccount("Dark");
      await this.waitValue("appearance", "mode", "dark");
      if ((await this.page.evaluate(Journey.theme)) !== "light")
        throw new Error("Account theme replaced the surface override");
      await this.page.screenshot({
        path: "output/playwright/plan-53/bakery-custom.png",
      });
      await this.chooseBakery("Use account appearance");
      await this.waitValue("bakeryos", "appearance", { kind: "inherit" });
      if ((await this.page.evaluate(Journey.theme)) !== "dark")
        throw new Error("Surface did not resume inheritance");
      await this.chooseAccount("Use device appearance");
      const system = await this.waitValue("appearance", "mode", "system");
      await this.page.emulateMedia({ colorScheme: "light" });
      await this.page.waitForTimeout(100);
      if ((await this.page.evaluate(Journey.theme)) !== "light")
        throw new Error("Device appearance did not change rendering");
      await this.page.emulateMedia({ colorScheme: "dark" });
      await this.page.waitForTimeout(100);
      if ((await this.page.evaluate(Journey.theme)) !== "dark")
        throw new Error("Device dark appearance did not change rendering");
      if ((await this.read("appearance")).revision !== system.revision)
        throw new Error("Device appearance wrote a preference");
      if ((await this.read()).revision !== chatBefore.revision)
        throw new Error("Scene choices changed chat preferences");
      await this.login("alice", second);
      await second.goto(
        `http://127.0.0.1:3115/workflow-preview.html?preferenceUser=${alice}`,
      );
      await second
        .getByRole("button", { name: "Labels: All details", exact: true })
        .waitFor();
      if (
        (await second
          .getByRole("button", { name: "Floor plan overview", exact: true })
          .getAttribute("aria-pressed")) !== "true"
      )
        throw new Error("Second browser did not restore minimap");
      return {
        sceneRevision: scene.revision,
        surfaceOverrideAndReset: true,
        secondBrowserSceneRestoration: true,
        deviceAppearanceWithoutWrites: true,
      };
    }
    async run() {
      await this.page.addInitScript({ content: FIXTURE_SOURCE });
      await this.page.emulateMedia({ reducedMotion: "reduce" });
      await this.page.setViewportSize({ width: 2800, height: 1000 });
      const crossTabAccountSwitch = await this.accountSwitchAcrossTabs();
      const alice = await this.login("alice");
      await this.reset();
      await this.open(alice);
      await this.expectWidth(600);
      const initial = await this.read();
      await this.dragTo(1100, false);
      if ((await this.read()).revision !== initial.revision)
        throw new Error("Drag movement saved before completion");
      await this.page.mouse.up();
      const widened = await this.waitWidth(1100);
      await this.page.setViewportSize({ width: 1000, height: 1000 });
      await this.page.waitForTimeout(200);
      await this.expectWidth(500);
      const narrow = await this.read();
      if (
        narrow.revision !== widened.revision ||
        narrow.values.dockedPanelWidthPx !== 1100
      )
        throw new Error("Viewport changed the saved preference");
      await this.page.screenshot({
        path: "output/playwright/plan-53/narrow.png",
      });
      await this.page.setViewportSize({ width: 2800, height: 1000 });
      await this.page.waitForTimeout(200);
      await this.expectWidth(1100);
      const cancelled = await this.dragTo(900, false);
      await cancelled.evaluate(Journey.pointerCancel);
      await this.page.mouse.up();
      await this.page.waitForTimeout(150);
      await this.expectWidth(1100);
      if ((await this.read()).revision !== widened.revision)
        throw new Error("Cancellation saved a partial drag");
      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      const sidebar = this.page.getByRole("separator", {
        name: "Resize threads sidebar",
        exact: true,
      });
      await sidebar.focus();
      await sidebar.press("ArrowRight");
      await sidebar.press("ArrowRight");
      await sidebar.press("Tab");
      const resized = await this.waitSidebar(400);
      await this.page.screenshot({
        path: "output/playwright/plan-53/fullscreen.png",
      });
      await this.page.reload();
      await this.page.getByRole("link", { name: "Ask", exact: true }).click();
      await this.page.waitForTimeout(200);
      await this.expectWidth(1100);
      await this.page
        .getByRole("button", { name: "Expand to fullscreen", exact: true })
        .click();
      if (
        Number(
          await this.page
            .getByRole("separator", {
              name: "Resize threads sidebar",
              exact: true,
            })
            .getAttribute("aria-valuenow"),
        ) !== 400
      )
        throw new Error("Sidebar width did not restore");
      await this.page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await this.page
        .getByRole("button", { name: "Account appearance", exact: true })
        .click();
      await this.page
        .getByRole("menuitemradio", { name: "Dark", exact: true })
        .click();
      await this.page.waitForTimeout(300);
      if ((await this.read("appearance")).values.mode !== "dark")
        throw new Error("Theme did not persist");
      if ((await this.read()).revision !== resized.revision)
        throw new Error("Theme changed chat revision");
      await this.page.evaluate(Journey.failSaves);
      await this.dragTo(1200);
      await this.page
        .getByText("Your preferences have not synced.", { exact: false })
        .waitFor();
      await this.expectWidth(1200);
      if ((await this.read()).values.dockedPanelWidthPx !== 1100)
        throw new Error("Failed save changed backend");
      if (
        (await this.page.evaluate(Journey.cacheState)).values
          .dockedPanelWidthPx !== 1100
      )
        throw new Error("Optimistic choice was written as accepted cache");
      await this.page.evaluate(Journey.allowSaves);
      await this.page.evaluate(Journey.holdWrites);
      await this.page
        .getByRole("button", { name: "Retry", exact: true })
        .evaluate(Journey.retryTwice);
      await this.page.waitForFunction(Journey.writePending);
      await this.dragTo(1150);
      await this.dragTo(1170);
      await this.expectWidth(1170);
      if ((await this.read()).values.dockedPanelWidthPx !== 1200)
        throw new Error(
          "A newer edit started before the pending save finished",
        );
      const peakRetryWrites = await this.page.evaluate(Journey.peakChatWrites);
      if (peakRetryWrites !== 1)
        throw new Error("Repeated Retry started overlapping preference writes");
      await this.page.evaluate(Journey.releaseWrites);
      const retried = await this.waitWidth(1170);
      if (retried.revision !== resized.revision + 2)
        throw new Error("Intermediate edits were saved instead of coalesced");
      const retryRequests = await this.page.evaluate(Journey.requests);
      await this.page.reload();
      await this.page.getByRole("link", { name: "Ask", exact: true }).click();
      await this.expectWidth(1170);
      const browser = this.page.context().browser();
      const secondContext = await browser.newContext();
      const second = await secondContext.newPage();
      await this.login("alice", second);
      await this.edit(
        "chat",
        { kind: "set_fullscreen_chat_sidebar_width", widthPx: 420 },
        second,
      );
      await this.dragTo(1000);
      const merged = await this.waitWidth(1000);
      if (merged.values.fullscreenSidebarWidthPx !== 420)
        throw new Error(
          "Conflict retry erased the other session's sidebar choice",
        );
      const requests = await this.page.evaluate(Journey.requests);
      if (!requests.some(Journey.isConflict))
        throw new Error("Conflict retry was not exercised");
      await this.page.screenshot({
        path: "output/playwright/plan-53/wide.png",
      });
      const bob = await this.login("bob", second);
      await this.reset(second);
      await second.addInitScript({ content: FIXTURE_SOURCE });
      await second.emulateMedia({ reducedMotion: "reduce" });
      await second.setViewportSize({ width: 2800, height: 1000 });
      await this.open(bob, second);
      await this.expectWidth(600, second);
      const bobDocument = await this.read("chat", second);
      if (bobDocument.values.fullscreenSidebarWidthPx !== 360)
        throw new Error("Bob inherited Alice's preferences");
      await this.page.evaluate(Journey.holdWrites);
      await this.dragTo(970);
      await this.page.waitForFunction(Journey.writePending);
      if (
        (await this.page.evaluate(Journey.cacheState)).values
          .dockedPanelWidthPx !== 1000
      )
        throw new Error("Pending save reached the accepted cache");
      const switchedBob = await this.login("bob");
      await this.open(switchedBob);
      await this.expectWidth(600);
      const switchedAlice = await this.login("alice");
      await this.open(switchedAlice);
      await this.expectWidth(970);
      await this.page.evaluate(Journey.conflictTwice);
      const beforeConflict = await this.read();
      await this.dragTo(1050);
      await this.page
        .getByText("Your preferences have not synced.", { exact: false })
        .waitFor();
      await this.expectWidth(1050);
      if ((await this.read()).revision !== beforeConflict.revision + 2)
        throw new Error("Conflict retry was unbounded");
      await this.page
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await this.waitWidth(1050);
      await this.page.goto(
        `http://127.0.0.1:3115/chat-preview.html?preferenceUser=${alice}&delayPreferences=1`,
      );
      await this.page.getByRole("link", { name: "Ask", exact: true }).click();
      await this.page
        .getByRole("heading", { name: "What would you like to do?" })
        .waitFor();
      await this.page.waitForTimeout(700);
      await this.dragTo(950);
      await this.expectWidth(950);
      await this.page.evaluate(Journey.releaseReads);
      await this.waitWidth(950);
      await this.expectWidth(950);
      const keys = await this.page.evaluate(Journey.storedChatKeys);
      if (keys.length !== 2)
        throw new Error("Account caches are not separately scoped");
      const resizeLifecycle = await this.resizeLifecycleJourney(alice);
      const bakery = await this.bakeryJourney(alice, second);
      const queuedReset = await this.queuedResetJourney(alice, second);
      await secondContext.close();
      return {
        defaults: { docked: 600, sidebar: 360 },
        pointerCompletionOnly: true,
        pointerCancellation: true,
        narrowedWidth: 500,
        retainedPreference: 1100,
        restoredSidebar: 400,
        failedSaveAcceptedCacheRetained: true,
        repeatedRetrySerialized: true,
        peakRetryWrites,
        newerEditsCoalescedDuringSave: true,
        retryRevisionIncrease: retried.revision - resized.revision,
        latestPendingWidthRestored: 1170,
        retryRevision: retried.revision,
        conflictMerged: merged.values,
        conflictRevision: merged.revision,
        accountIsolation: true,
        accountSwitchAndReturn: true,
        accountSwitchDuringSave: true,
        crossTabAccountSwitch,
        lateReadRetainsLocalChoice: true,
        boundedConflictRetry: true,
        resizeLifecycle,
        bakery,
        queuedReset,
        requestOutcomes: [...retryRequests, ...requests],
      };
    }
    static isConflict(request) {
      return request.status === 409;
    }
  }
  try {
    return await new Journey(page).run();
  } catch (error) {
    await page.screenshot({ path: "output/playwright/plan-53/failure.png" });
    const visible = (await page.locator("body").innerText()).slice(-2000);
    throw new Error(`${error.message}\nVisible UI: ${visible}`);
  }
};
