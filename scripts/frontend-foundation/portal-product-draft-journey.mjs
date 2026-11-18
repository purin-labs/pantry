import { ProductDescriptionDoc } from "@seams/product-description-crdt";
import {
  encodeDraftServerMessage,
  parseDraftClientMessage,
} from "@seams/product-description-crdt/protocol";
import { COLLABORATION_PING, COLLABORATION_PONG } from "@seams/collaboration";

const CURRENT_DESCRIPTION =
  "A small almond cake with browned butter and a crisp golden edge. Baked fresh each morning.";

class ProductDraftFixture {
  constructor() {
    const result = ProductDescriptionDoc.create(CURRENT_DESCRIPTION);
    if (!result.ok)
      throw new Error("The product draft fixture could not be created.");
    this.doc = result.value;
    this.sockets = [];
    this.access = "edit";
    this.failSnapshotOnce = true;
  }

  connect(socket) {
    this.sockets.push(socket);
    socket.onMessage(this.receive.bind(this, socket));
  }

  receive(socket, frame) {
    if (frame === COLLABORATION_PING) {
      socket.send(COLLABORATION_PONG);
      return;
    }
    const result = parseDraftClientMessage(frame);
    if (!result.ok)
      throw new Error("The editor sent an invalid draft message.");
    const message = result.value;
    switch (message.kind) {
      case "sync_request": {
        const vector = this.doc.stateVector();
        const update = this.doc.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok)
          throw new Error("The product draft could not sync.");
        socket.send(
          encodeDraftServerMessage({
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            initializedFromProductRevision: 4,
            currentProductRevision: 4,
            access: this.access,
            sessionId: "product_review",
          }),
        );
        return;
      }
      case "submit_update": {
        const applied = this.doc.apply(message.update);
        if (!applied.ok)
          throw new Error("The product editor produced an invalid update.");
        socket.send(
          encodeDraftServerMessage({
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

  read(route) {
    if (route.request().method() !== "GET") {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "preview_write_disabled" }),
      });
    }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/shared-thread")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, threadUrl: null }),
      });
    }
    if (this.failSnapshotOnce) {
      this.failSnapshotOnce = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "temporarily_unavailable" }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        canonicalProductId: "product_financier",
        product: {
          productId: "product_financier",
          title: "Brown butter financier",
          description: CURRENT_DESCRIPTION,
          revision: 4,
        },
        draft: {
          kind: "active",
          description: this.doc.read(),
          initializedFromProductRevision: 4,
        },
      }),
    });
  }

  revoke() {
    for (const socket of this.sockets) {
      socket.send(
        encodeDraftServerMessage({ kind: "failure", code: "access_revoked" }),
      );
    }
  }
}

export async function runProductDraftJourney(page, options) {
  const fixture = new ProductDraftFixture();
  await page.routeWebSocket(
    "**/products/product_financier/description-draft/socket",
    fixture.connect.bind(fixture),
  );
  await page.route(
    "**/products/product_financier/description-draft**",
    fixture.read.bind(fixture),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${options.portalUrl}/commerce-preview.html?page=products&resource=product_financier`,
  );
  await page
    .getByRole("button", { name: "Edit description draft", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Shared description",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Review draft", exact: true })
    .waitFor({ state: "visible" });
  await draft.fill("Brown butter financier for the autumn gift box.");
  await page
    .locator('.description-draft-sync-status[data-state="synced"]')
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Review draft", exact: true })
      .isEnabled()
  ) {
    throw new Error(
      "The editor offered review without the current product snapshot.",
    );
  }
  await page.screenshot({
    path: `${options.artifactDir}/product-snapshot-failure.png`,
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.getByText("Reviewed draft", { exact: true }).waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/product-draft-review-wide.png`,
    fullPage: true,
  });
  await draft.fill("Brown butter financier for the winter gift box.");
  await page
    .locator('.description-draft-sync-status[data-state="synced"]')
    .waitFor();
  await page
    .getByText(
      "The shared draft changed after this review. Send the frozen version, or review again.",
      { exact: true },
    )
    .waitFor();
  const copies = page.locator(".description-draft-review-copy");
  if (!(await copies.last().innerText()).includes("autumn gift box"))
    throw new Error("An edit silently changed the frozen review.");
  if (!(await copies.first().innerText()).includes(CURRENT_DESCRIPTION))
    throw new Error("An edit changed the current product.");
  await page.setViewportSize({ width: 320, height: 800 });
  const editorBounds = await page
    .locator(".description-draft-editor-column")
    .boundingBox();
  const fieldBounds = await draft.boundingBox();
  if (
    editorBounds === null ||
    fieldBounds === null ||
    fieldBounds.x + fieldBounds.width > editorBounds.x + editorBounds.width + 1
  ) {
    throw new Error(
      "The product description field extends outside its narrow column.",
    );
  }
  await page
    .getByRole("heading", { name: "Review the shared draft", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${options.artifactDir}/product-draft-frozen-review-narrow.png`,
  });
  await page
    .getByRole("button", { name: "Review current text again", exact: true })
    .click();
  if (!(await copies.last().innerText()).includes("winter gift box"))
    throw new Error("A new review did not use the current draft.");
  await page
    .getByRole("button", { name: "Send for approval", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Approval submission failed." })
    .waitFor();
  if (
    (await draft.inputValue()) !==
    "Brown butter financier for the winter gift box."
  ) {
    throw new Error("A failed proposal lost the shared draft.");
  }
  await page.screenshot({
    path: `${options.artifactDir}/product-draft-proposal-failed.png`,
  });
  fixture.revoke();
  await page.waitForFunction(
    "document.querySelector('[name=product-description-draft]')?.readOnly === true",
  );
  await draft.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${options.artifactDir}/product-draft-access-loss.png`,
  });
  fixture.access = "read";
  await page.goto(
    `${options.portalUrl}/commerce-preview.html?page=products&resource=product_financier`,
  );
  await page
    .getByRole("button", { name: "Edit description draft", exact: true })
    .click();
  await page
    .getByText(
      "You can view this draft. To change it, ask an owner or admin to give you an editing role.",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/product-draft-viewer.png`,
  });
  return {
    status: "passed",
    frozenReview: true,
    snapshotReadRecovery: true,
    currentProductUnchanged: true,
    proposalFailurePreservesDraft: true,
    accessRevoked: true,
    viewer: true,
  };
}
