import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { MenuDraftDoc, type MenuDraftUpdate } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
  type MenuDraftServerMessage,
} from "@purin-labs/menu-draft-crdt/protocol";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  PUBLIC_ORIGIN,
  closeSocket,
  controlReadHeaders,
  openSocket,
} from "./hibernatable-socket-support";
import { applied } from "./menu-board-journey-support";

declare module "vitest" {
  interface TaskMeta {
    cafeMenuPublication?: Record<string, unknown>;
  }
}

const STOREFRONT = "storefront_cafe";

it(
  "publishes the café menu from the shared draft, refuses an item it cannot sell and a stale draft, and replaces the menu on the next publish",
  { timeout: 180_000 },
  cafeMenuPublicationJourney,
);

/**
 * The owner builds the café menu in the Portal's shared draft and publishes
 * it. A buyer then sees that menu in the café shop. An item that names no
 * product the café sells, and a draft revision that another editor moved
 * on, are refused before Commerce. A second publish replaces the menu, so
 * the buyer sees one menu with the new items.
 */
async function cafeMenuPublicationJourney({
  task,
}: TestContext): Promise<void> {
  const owner = await commerceClient(`menu-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Menu café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_menu_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const admin = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  const [first, second, third] = await sellableCafeProducts(admin, merchantId);
  // The Menus page offers the products that the café sells.
  const options = await menuOptions(organisationId, owner.session);
  expect(options.published).toBeNull();
  expect(options.products).toEqual(
    expect.arrayContaining(
      [first, second, third].map((product) =>
        expect.objectContaining({
          productId: product.productId,
          title: product.title,
        }),
      ),
    ),
  );

  // 1. The owner adds two café products and one item that names no product.
  const socket = await openSocket(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/menu-draft/socket`,
    owner.session,
  );
  const draft = MenuDraftDoc.createReplica();
  try {
    const sync = await nextMenuMessage(socket, "sync_response", () => {
      const vector = draft.stateVector();
      if (!vector.ok) throw new Error(vector.error.code);
      socket.send(
        encodeMenuDraftClientMessage({
          kind: "sync_request",
          stateVector: vector.value,
        }),
      );
    });
    if (sync.kind !== "sync_response") throw new Error("No sync");
    applied(draft.apply(sync.missingUpdate));
    const section = draft.read().sections[0]?.id ?? "";
    for (const [index, product] of [first, second].entries())
      await submit(
        socket,
        `add-${index}`,
        draft.addItem({
          id: `item_${index}`,
          productId: product.productId,
          displayName: product.title,
          description: "",
          placement: { sectionId: section, order: index },
        }),
      );
    await submit(
      socket,
      "add-placeholder",
      draft.addItem({
        id: "item_placeholder",
        productId: "product_placeholder",
        displayName: "New menu item",
        description: "Add a short description",
        placement: { sectionId: section, order: 2 },
      }),
    );

    // 2. A stale draft revision and an item the café cannot sell are refused.
    const revision = await draftRevision(organisationId, owner.session);
    const stale = await publish(organisationId, owner.session, revision - 1);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: "menu_draft_changed",
      documentRevision: revision,
    });
    const unsellable = await publish(organisationId, owner.session, revision);
    expect(unsellable.status).toBe(422);
    expect(unsellable.body).toMatchObject({
      error: "menu_items_not_sellable",
      items: ["New menu item"],
    });
    expect(await buyerMenus(merchantId)).toEqual([]);

    // 3. Without the placeholder, the menu publishes and a buyer sees it.
    await submit(
      socket,
      "remove-placeholder",
      draft.deleteItem("item_placeholder"),
    );
    const published = await publish(
      organisationId,
      owner.session,
      await draftRevision(organisationId, owner.session),
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({
      ok: true,
      menu: { revision: 1, entries: 2 },
    });
    await catalogSnapshotExpires();
    expect(await buyerMenus(merchantId)).toEqual([
      { revision: 1, offers: [first.offerId, second.offerId].sort() },
    ]);
    expect(
      (await menuOptions(organisationId, owner.session)).published,
    ).toEqual({ revision: 1, entries: 2 });

    // 4. The owner swaps the second item for a third and publishes again.
    await submit(socket, "remove-second", draft.deleteItem("item_1"));
    await submit(
      socket,
      "add-third",
      draft.addItem({
        id: "item_2",
        productId: third.productId,
        displayName: third.title,
        description: "",
        placement: { sectionId: section, order: 1 },
      }),
    );
    const replaced = await publish(
      organisationId,
      owner.session,
      await draftRevision(organisationId, owner.session),
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toMatchObject({ menu: { revision: 2, entries: 2 } });
    await catalogSnapshotExpires();
    expect(await buyerMenus(merchantId)).toEqual([
      { revision: 2, offers: [first.offerId, third.offerId].sort() },
    ]);
  } finally {
    draft.destroy();
    await closeSocket(socket);
  }

  task.meta.cafeMenuPublication = {
    refused: ["menu_draft_changed", "menu_items_not_sellable"],
    buyerMenusBeforePublish: 0,
    firstPublication: { revision: 1, entries: 2 },
    replacement: { revision: 2, entries: 2, buyerMenus: 1 },
  };
}

type SellableProduct = Readonly<{
  productId: string;
  title: string;
  offerId: string;
}>;

/** Three demo products that the café sells with a consumption plan. */
async function sellableCafeProducts(
  admin: CommerceAdminClient,
  merchantId: string,
): Promise<readonly [SellableProduct, SellableProduct, SellableProduct]> {
  const storefront = await required(
    admin.readStorefront(merchantId, STOREFRONT),
  );
  const stock = await required(admin.readStockSnapshot(merchantId));
  const found: SellableProduct[] = [];
  for (const product of stock.commerce.resources.products) {
    const variants = stock.commerce.resources.variants.filter(
      (variant) => variant.productId === product.id,
    );
    const offer = stock.commerce.resources.offers.find(
      (candidate) =>
        candidate.salesChannelId === storefront.salesChannelId &&
        candidate.lifecycle.state === "listed" &&
        variants.some((variant) => variant.id === candidate.variantId) &&
        stock.consumptionPlans.some(
          (plan) =>
            plan.variantId === candidate.variantId &&
            plan.lifecycle === "active" &&
            plan.mode.kind !== "untracked" &&
            (plan.mode.kind !== "direct" ||
              plan.mode.commitOn === "fulfillment_completed"),
        ),
    );
    if (offer !== undefined)
      found.push({
        productId: product.id,
        title: product.title,
        offerId: offer.id,
      });
  }
  const [first, second, third] = found;
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("The demo café sells fewer than three products");
  return [first, second, third];
}

/**
 * Commerce's Worker serves buyer catalogs from a snapshot for five
 * seconds, so a buyer sees a new menu after that.
 */
function catalogSnapshotExpires(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 6_000));
}

/** The menus that a buyer of the café shop sees, by revision and offers. */
async function buyerMenus(merchantId: string): Promise<unknown[]> {
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://commerce.test",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const session = await required(
    buyer.createSession(merchantId, STOREFRONT, {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const catalog = await required(
    buyer.readCatalog(merchantId, STOREFRONT, session.token),
  );
  return catalog.menus.map((menu) => ({
    revision: menu.revision,
    offers: menu.entries.map((entry) => entry.offerId).sort(),
  }));
}

async function menuOptions(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Readonly<{ products: unknown[]; published: unknown }>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/menu-publication`,
    { headers: controlReadHeaders(session) },
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  if (!isRecord(body) || !Array.isArray(body.products))
    throw new Error("No menu options");
  return { products: body.products, published: body.published };
}

async function publish(
  organisationId: string,
  session: IssuedControlSession,
  documentRevision: number,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/menu-publication`,
    {
      method: "POST",
      headers: {
        ...controlReadHeaders(session),
        origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-pantry-configuration-version": "1",
        "x-pantry-csrf": session.csrfToken,
      },
      body: JSON.stringify({ documentRevision }),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** The saved draft revision that the Portal shows the owner. */
async function draftRevision(
  organisationId: string,
  session: IssuedControlSession,
): Promise<number> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/menu-draft`,
    { headers: controlReadHeaders(session) },
  );
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isRecord(body.value) ||
    typeof body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(body)}`);
  return body.value.revision;
}

async function submit(
  socket: WebSocket,
  updateId: string,
  result:
    | Readonly<{ ok: true; value: MenuDraftUpdate }>
    | Readonly<{ ok: false; error: { code: string } }>,
): Promise<void> {
  if (!result.ok) throw new Error(result.error.code);
  const update = result.value;
  const accepted = await nextMenuMessage(socket, "update_accepted", () =>
    socket.send(
      encodeMenuDraftClientMessage({ kind: "submit_update", updateId, update }),
    ),
  );
  expect(accepted).toMatchObject({ kind: "update_accepted", updateId });
}

function nextMenuMessage(
  socket: WebSocket,
  kind: MenuDraftServerMessage["kind"],
  send: () => void,
): Promise<MenuDraftServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`No ${kind} message`));
    }, 10_000);
    const onMessage = (event: MessageEvent): void => {
      const parsed = parseMenuDraftServerMessage(event.data);
      if (!parsed.ok) return;
      if (parsed.value.kind === "failure") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        reject(new Error(`Menu room failure: ${parsed.value.code}`));
        return;
      }
      if (parsed.value.kind !== kind) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(parsed.value);
    };
    socket.addEventListener("message", onMessage);
    send();
  });
}

async function required<T>(
  result: Promise<
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>
  >,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  return resolved.value;
}
