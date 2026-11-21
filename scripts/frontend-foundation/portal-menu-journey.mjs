import { MenuDraftDoc } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftServerMessage,
  parseMenuDraftClientMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { COLLABORATION_PING, COLLABORATION_PONG } from "@purin-labs/collaboration";
import { chooseOption } from "../lib/browser-journey.mjs";

// Bundle like portal-account-setup-journey.mjs, then run in the browser CLI.
// The room answers protocol messages; the real editor creates every edit.
class MenuFixture {
  constructor() {
    const created = MenuDraftDoc.create("Autumn café menu");
    if (!created.ok) throw new Error("Could not create the menu fixture.");
    this.doc = created.value;
    this.revision = 1;
    this.holdUpdates = false;
    this.pendingUpdates = [];
    this.doc.addSection({
      id: "pastries",
      title: "Fresh from the oven",
      order: 0,
    });
    this.doc.addSection({ id: "drinks", title: "Coffee and tea", order: 1 });
    this.doc.addItem({
      id: "financier",
      productId: "product_financier",
      displayName: "Brown butter financier",
      description:
        "Almond cake with a crisp golden edge. Baked fresh each morning.",
      placement: { sectionId: "pastries", order: 0 },
    });
    this.doc.addItem({
      id: "latte",
      productId: "product_latte",
      displayName: "Matcha latte · 宇治抹茶",
      description: "Uji matcha whisked with milk. Oat milk is available.",
      placement: { sectionId: "drinks", order: 0 },
    });
  }

  connect(socket) {
    socket.onMessage(this.receive.bind(this, socket));
  }

  receive(socket, frame) {
    if (frame === COLLABORATION_PING) {
      socket.send(COLLABORATION_PONG);
      return;
    }
    const parsed = parseMenuDraftClientMessage(frame);
    if (!parsed.ok) throw new Error("The editor sent an invalid menu message.");
    const message = parsed.value;
    switch (message.kind) {
      case "sync_request": {
        const vector = this.doc.stateVector();
        const update = this.doc.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok)
          throw new Error("The menu could not sync.");
        socket.send(
          encodeMenuDraftServerMessage({
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            access: "edit",
            sessionId: "menu_review",
            documentRevision: this.revision,
          }),
        );
        return;
      }
      case "submit_update": {
        if (this.holdUpdates) {
          this.pendingUpdates.push({ socket, frame });
          return;
        }
        const result = this.doc.apply(message.update);
        if (!result.ok)
          throw new Error("The editor produced an invalid update.");
        this.revision += 1;
        socket.send(
          encodeMenuDraftServerMessage({
            kind: "update_accepted",
            updateId: message.updateId,
          }),
        );
        return;
      }
      case "presence_update":
      case "pointer_update":
        return;
    }
  }

  resumeUpdates() {
    this.holdUpdates = false;
    for (const pending of this.pendingUpdates) {
      this.receive(pending.socket, pending.frame);
    }
    this.pendingUpdates = [];
  }

  review(route) {
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: {
          reviewId: "review_menu",
          documentId: "cafe-menu",
          documentRevision: this.revision,
          reviewedAt: Date.now(),
          draft: this.doc.read(),
        },
      }),
    });
  }
}

export async function runMenuJourney(page, options) {
  const fixture = new MenuFixture();
  await page.context().addCookies([
    {
      name: "pantry_csrf",
      value: "csrf_menu_preview",
      url: options.portalUrl,
      sameSite: "Lax",
    },
  ]);
  await page.routeWebSocket(
    "**/collaboration/menu-draft/socket",
    fixture.connect.bind(fixture),
  );
  await page.route(
    "**/collaboration/menu-draft/review",
    fixture.review.bind(fixture),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${options.portalUrl}/portal/cafe-browser-lab/main/menus`);
  const title = page.getByRole("textbox", { name: "Menu title", exact: true });
  await page.locator('input[value="Brown butter financier"]').waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/menus-wide-initial.png`,
  });
  await title.fill("Saturday café menu");
  await chooseOption(
    page,
    page.getByRole("combobox", {
      name: "Section for Brown butter financier",
      exact: true,
    }),
    { value: "drinks" },
  );
  await page
    .getByRole("button", { name: "Save snapshot", exact: true })
    .click();
  await page.getByText("Saturday café menu", { exact: true }).waitFor();
  if (fixture.doc.read().title !== "Saturday café menu")
    throw new Error("The room did not receive the editor's title change.");
  for (const item of fixture.doc.read().items) {
    if (item.id === "financier" && item.placement.sectionId !== "drinks") {
      throw new Error("The section control did not move the menu item.");
    }
  }
  await page.screenshot({
    path: `${options.artifactDir}/menus-wide-after.png`,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${options.artifactDir}/menus-narrow.png` });
  if (await page.evaluate("document.documentElement.scrollWidth > innerWidth"))
    throw new Error("The menu overflows the narrow viewport.");
  fixture.holdUpdates = true;
  await title.fill("Sunday café menu — awaiting sync");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page
    .getByRole("heading", { name: "Leave this menu draft?", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/menu-unsynced-leave.png`,
  });
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  if ((await title.inputValue()) !== "Sunday café menu — awaiting sync") {
    throw new Error("Cancelling navigation lost the unsynced menu title.");
  }
  fixture.resumeUpdates();
  await page
    .locator('.description-draft-sync-status[data-state="synced"]')
    .waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.waitForURL("**/portal/cafe-browser-lab/main");
  await page.screenshot({
    path: `${options.artifactDir}/menu-left-after-sync.png`,
  });
  return {
    status: "passed",
    title: fixture.doc.read().title,
    revision: fixture.revision,
    snapshot: "review_menu",
    unsyncedNavigation:
      "Draft preserved on cancellation; navigation succeeded after acknowledgement.",
  };
}
