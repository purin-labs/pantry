// An owner edits, archives, restores and deletes products from the Portal's
// Products page. The page's requests run through the real Platform routes and
// the real Commerce Worker; the shop shows each outcome to a buyer.
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi, type TestContext } from "vitest";
import {
  parseInventory,
  type InventoryData,
} from "@purin-labs/commerce-contracts";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CommerceClientResult,
} from "@purin-labs/commerce-client";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { placeCafeOrder, publishCafeMenu } from "./cafe-order-support";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";

const STOREFRONT = "storefront_cafe";

type ProductLink = NonNullable<InventoryData["rows"][number]["product"]>;

/** One product as a list shows it: its variant and its price. */
type ProductPrice = Readonly<{
  variantId: string;
  amountMinor: number;
  currency: string;
}>;

it(
  "lets an owner edit, archive, restore and delete a product, and keeps a sold product",
  { timeout: 180_000 },
  productsPageActions,
);

async function productsPageActions(context: TestContext): Promise<void> {
  const owner = await commerceClient(`products-owner-${crypto.randomUUID()}`);
  const operator = await commerceClient(`products-op-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Products actions");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_actions_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, "products-op-person", "Operator"),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)",
      )
      .bind(
        organisationId,
        operator.identity.userId,
        "products-op-person",
        Date.now(),
      ),
  ]);
  const clientOptions = {
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  };
  const admin = new CommerceAdminClient(clientOptions);
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://commerce.test",
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

  const base = `https://localhost/v1/control/organisations/${organisationId}/commerce`;
  async function portal(): Promise<InventoryData> {
    const response = await exports.default.fetch(`${base}/inventory`, {
      headers: commerceHeaders(owner.session),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return parseInventory(await response.json());
  }
  function act(
    session: IssuedControlSession,
    action: "edit" | "status" | "delete",
    body: Record<string, unknown>,
    key = `portal-${crypto.randomUUID()}`,
  ): Promise<Response> {
    const headers = commerceHeaders(session);
    headers.set("idempotency-key", key);
    return exports.default.fetch(`${base}/products/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
  async function shop() {
    const session = await required(
      buyer.createSession(merchantId, STOREFRONT, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    return (
      await required(buyer.readCatalog(merchantId, STOREFRONT, session.token))
    ).listings;
  }

  const before = await portal();
  const stocked = before.rows.find(
    (row) => row.kind === "product" && !row.name.startsWith("Taro"),
  );
  const madeToOrder = before.untrackedProducts.find(
    (row) => row.madeToOrder && !row.name.startsWith("Taro"),
  );
  const retired = before.rows.find(
    (row) =>
      row.kind === "product" && row !== stocked && !row.name.startsWith("Taro"),
  );
  if (
    stocked?.kind !== "product" ||
    retired?.kind !== "product" ||
    madeToOrder === undefined
  )
    throw new Error("Café fixture needs stocked and made-to-order products");
  const link = stocked.product;
  const newPrice = link.price.amountMinor + 100;

  // 1. An edit reaches the page and the shop, and its retry changes nothing.
  const editBody = {
    productId: link.productId,
    expectedProductRevision: link.productRevision,
    title: "Spring ginger",
    description: "Baked each morning.",
    variant:
      link.variantTitle === link.productTitle
        ? {
            variantId: link.variantId,
            expectedRevision: link.variantRevision,
            title: "Spring ginger",
          }
        : null,
    offer: {
      offerId: link.offerId,
      expectedRevision: link.offerRevision,
      amountMinor: newPrice,
      currency: link.price.currency,
    },
  };
  const editKey = `portal-${crypto.randomUUID()}`;
  const edited = await act(owner.session, "edit", editBody, editKey);
  expect(edited.status, await edited.clone().text()).toBe(200);
  const retried = await act(owner.session, "edit", editBody, editKey);
  expect(retried.status).toBe(200);
  const afterEdit = await portal();
  const editedRow = afterEdit.rows.find(
    (row) => row.kind === "product" && row.product.productId === link.productId,
  );
  expect(editedRow).toMatchObject({
    name: "Spring ginger",
    product: {
      description: "Baked each morning.",
      price: { amountMinor: newPrice },
      productRevision: link.productRevision + 1,
    },
  });
  await vi.waitFor(
    async () => {
      expect(
        (await shop()).find((item) => item.variantId === link.variantId),
      ).toMatchObject({
        title: "Spring ginger",
        price: { amountMinor: newPrice },
      });
    },
    { timeout: 15_000, interval: 1_000 },
  );

  // 2. An edit of an older view and an operator's click change nothing.
  const stale = await act(owner.session, "edit", editBody);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "stale_resource_revision",
  });
  const refused = await act(operator.session, "delete", {
    productId: link.productId,
    expectedProductRevision: link.productRevision + 1,
  });
  expect(refused.status, await refused.clone().text()).toBe(404);
  const operatorRead = await exports.default.fetch(`${base}/inventory`, {
    headers: commerceHeaders(operator.session),
  });
  expect(operatorRead.status, await operatorRead.clone().text()).toBe(200);
  expect((await portal()).rows.map((row) => row.name)).toContain(
    "Spring ginger",
  );

  // 3. The page lists what a buyer sees. An archived product leaves the
  //    page and the shop, and its stock leaves the page with no false alarm.
  //    A restored product returns.
  expect(portalProducts(await portal())).toEqual(shopProducts(await shop()));
  for (const product of [madeToOrder, retired.product]) {
    const archived = await act(owner.session, "status", {
      productId: product.productId,
      expectedProductRevision: product.productRevision,
      status: "archived",
    });
    expect(archived.status, await archived.clone().text()).toBe(200);
  }
  const afterArchive = await portal();
  expect(
    afterArchive.untrackedProducts.map((item) => item.productId),
  ).not.toContain(madeToOrder.productId);
  expect(afterArchive.archivedProducts).toContainEqual(
    expect.objectContaining({
      productId: madeToOrder.productId,
      revision: madeToOrder.productRevision + 1,
    }),
  );
  expect(
    afterArchive.rows.filter(
      (row) => row.inventoryItemId === retired.inventoryItemId,
    ),
  ).toEqual([]);
  await vi.waitFor(
    async () => {
      expect((await shop()).map((item) => item.variantId)).not.toContain(
        madeToOrder.variantId,
      );
    },
    { timeout: 15_000, interval: 1_000 },
  );
  const offered = shopProducts(await shop());
  expect(offered.map((item) => item.variantId)).not.toContain(
    retired.product.variantId,
  );
  expect(portalProducts(afterArchive)).toEqual(offered);
  const restored = await act(owner.session, "status", {
    productId: madeToOrder.productId,
    expectedProductRevision: madeToOrder.productRevision + 1,
    status: "active",
  });
  expect(restored.status, await restored.clone().text()).toBe(200);
  await vi.waitFor(
    async () => {
      expect((await shop()).map((item) => item.variantId)).toContain(
        madeToOrder.variantId,
      );
    },
    { timeout: 15_000, interval: 1_000 },
  );

  // 4. A sold product and a product on the menu stay, and the page knows why.
  await publishCafeMenu(merchantId);
  await placeCafeOrder(merchantId, ["item_cookie"]);
  const afterOrder = await portal();
  const taro = (name: string): ProductLink => {
    for (const row of afterOrder.rows)
      if (row.name === name && row.product !== null) return row.product;
    for (const product of afterOrder.untrackedProducts)
      if (product.name === name) return product;
    throw new Error(`No product ${name}`);
  };
  const cookie = taro("Taro Cookie");
  const milkTea = taro("Taro Milk Tea");
  expect(cookie.deleteBlock).toBe("sold");
  expect(milkTea.deleteBlock).toBe("on_menu");
  for (const [product, reason] of [
    [cookie, "sold"],
    [milkTea, "on_menu"],
  ] as const) {
    const response = await act(owner.session, "delete", {
      productId: product.productId,
      expectedProductRevision: product.productRevision,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "product_delete_refused",
      reason,
    });
  }

  // 5. A never-sold product goes, with no row and no false stock alarm.
  const deleteKey = `portal-${crypto.randomUUID()}`;
  const deleteBody = {
    productId: link.productId,
    expectedProductRevision: link.productRevision + 1,
  };
  const deleted = await act(owner.session, "delete", deleteBody, deleteKey);
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  const deletedAgain = await act(
    owner.session,
    "delete",
    deleteBody,
    deleteKey,
  );
  expect(deletedAgain.status).toBe(200);
  const after = await portal();
  expect(
    after.rows.filter((row) => row.inventoryItemId === stocked.inventoryItemId),
  ).toEqual([]);
  expect(after.archivedProducts.map((item) => item.productId)).not.toContain(
    link.productId,
  );
  const snapshot = await required(admin.readStockSnapshot(merchantId));
  const resources = snapshot.commerce.resources;
  expect(resources.products.map((item) => item.id)).not.toContain(
    link.productId,
  );
  expect(
    resources.inventoryItems.find((item) => item.id === stocked.inventoryItemId)
      ?.lifecycle,
  ).toBe("inactive");
  await vi.waitFor(
    async () => {
      expect((await shop()).map((item) => item.variantId)).not.toContain(
        link.variantId,
      );
    },
    { timeout: 15_000, interval: 1_000 },
  );
  const graph = await exports.default.fetch(
    `${base}/graph?kind=commerce_entity_detail&typeId=product&entityId=${encodeURIComponent(link.productId)}`,
    { headers: commerceHeaders(owner.session) },
  );
  Object.assign(context.task.meta, {
    productsPageActionsEvidence: {
      organisationId,
      merchantId,
      productDeleted: link.productId,
      soldRefused: cookie.productId,
      menuRefused: milkTea.productId,
      graphStatusAfterDelete: graph.status,
      shopCount: (await shop()).length,
    },
  });
}

function portalProducts(data: InventoryData): ProductPrice[] {
  const products = new Map<string, ProductPrice>();
  for (const row of data.rows)
    if (row.kind === "product")
      products.set(row.product.variantId, price(row.product));
  for (const product of data.untrackedProducts)
    products.set(product.variantId, price(product));
  return [...products.values()].sort(byVariant);
}

function shopProducts(
  listings: readonly Parameters<typeof price>[0][],
): ProductPrice[] {
  return listings.map(price).sort(byVariant);
}

function price(
  product: Readonly<{
    variantId: string;
    price: Readonly<{ amountMinor: number; currency: string }>;
  }>,
): ProductPrice {
  return {
    variantId: product.variantId,
    amountMinor: product.price.amountMinor,
    currency: product.price.currency,
  };
}

function byVariant(left: ProductPrice, right: ProductPrice): number {
  return left.variantId.localeCompare(right.variantId);
}

async function required<T>(
  result: Promise<CommerceClientResult<T>>,
): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}
