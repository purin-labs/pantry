// An owner adds, orders and removes a product's photos from the Portal's
// product page. The page's requests run through the real Platform routes and
// the real Commerce Worker with its R2 photo store; the shop's catalog shows
// each order to a buyer.
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
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

const STOREFRONT = "storefront_cafe";

type Photo = Readonly<{ bytes: Uint8Array; type: string }>;
type ProductLink = NonNullable<InventoryData["rows"][number]["product"]>;

/** PNG bytes that Commerce's type check accepts; the tail makes each distinct. */
function png(tail: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tail]);
}

it(
  "lets an owner add, order and remove a product's photos, and the shop shows that order",
  { timeout: 180_000 },
  productPhotos,
);

async function productPhotos(context: TestContext): Promise<void> {
  const owner = await commerceClient(`photos-owner-${crypto.randomUUID()}`);
  const operator = await commerceClient(`photos-op-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Product photos");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_photos_${crypto.randomUUID().replaceAll("-", "")}`;
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
      .bind(organisationId, "photos-op-person", "Operator"),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)",
      )
      .bind(
        organisationId,
        operator.identity.userId,
        "photos-op-person",
        Date.now(),
      ),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator },
  });
  const admin = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  // The catalog names photos by HTTPS address, as a buyer's browser reads them.
  const buyer = new CommerceStorefrontClient({
    baseUrl: "https://underclerk.test",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
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
  async function page(productId: string): Promise<ProductLink> {
    const data = await portal();
    for (const row of data.rows)
      if (row.kind === "product" && row.product.productId === productId)
        return row.product;
    const untracked = data.untrackedProducts.find(
      (item) => item.productId === productId,
    );
    if (untracked === undefined) throw new Error(`No product ${productId}`);
    return untracked;
  }
  function add(
    session: IssuedControlSession,
    productId: string,
    expectedPhotoRevision: number,
    photo: Photo,
    key = `portal-${crypto.randomUUID()}`,
  ): Promise<Response> {
    const form = new FormData();
    form.set("productId", productId);
    form.set("expectedPhotoRevision", String(expectedPhotoRevision));
    form.set("altText", "Fresh from the oven");
    form.set("photo", new File([photo.bytes], "photo", { type: photo.type }));
    const headers = commerceHeaders(session);
    headers.delete("content-type");
    headers.set("idempotency-key", key);
    return exports.default.fetch(`${base}/products/photos/add`, {
      method: "POST",
      headers,
      body: form,
    });
  }
  function arrange(
    productId: string,
    expectedPhotoRevision: number,
    mediaIds: readonly string[],
  ): Promise<Response> {
    const headers = commerceHeaders(owner.session);
    headers.set("idempotency-key", `portal-${crypto.randomUUID()}`);
    return exports.default.fetch(`${base}/products/photos/arrange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ productId, expectedPhotoRevision, mediaIds }),
    });
  }
  async function shopPhotos(variantId: string): Promise<string[]> {
    const session = await required(
      buyer.createSession(merchantId, STOREFRONT, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    const listing = (
      await required(buyer.readCatalog(merchantId, STOREFRONT, session.token))
    ).listings.find((item) => item.variantId === variantId);
    if (listing === undefined) throw new Error(`No listing ${variantId}`);
    return listing.media.map((item) => mediaIdOf(item.url));
  }
  async function shopShows(
    variantId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    await vi.waitFor(
      async () => expect(await shopPhotos(variantId)).toEqual(mediaIds),
      { timeout: 15_000, interval: 1_000 },
    );
  }
  const ids = (link: ProductLink) =>
    link.photos.items.map((photo) => photo.mediaId);

  const before = await portal();
  const stocked = before.rows.find((row) => row.kind === "product");
  const other = before.untrackedProducts[0];
  if (stocked?.kind !== "product" || other === undefined)
    throw new Error("Café fixture needs two products on sale");
  const link = stocked.product;
  expect(link.photos).toEqual({ revision: 0, items: [] });
  const first = { bytes: png(1), type: "image/png" };
  const second = { bytes: png(2), type: "image/png" };

  // 1. A photo reaches the page, and its retry and a second click add nothing.
  const addKey = `portal-${crypto.randomUUID()}`;
  const added = await add(owner.session, link.productId, 0, first, addKey);
  expect(added.status, await added.clone().text()).toBe(200);
  expect(
    (await add(owner.session, link.productId, 0, first, addKey)).status,
  ).toBe(200);
  const again = await add(owner.session, link.productId, 1, first);
  expect(again.status, await again.clone().text()).toBe(200);
  const afterFirst = await page(link.productId);
  expect(afterFirst.photos.items).toHaveLength(1);
  expect(afterFirst.photos.revision).toBe(1);
  const [photoA] = ids(afterFirst);
  if (photoA === undefined) throw new Error("No first photo");
  expect(afterFirst.image?.url).toBe(afterFirst.photos.items[0]?.url);

  // 2. A second photo follows the first, and a buyer reads its bytes.
  const addedB = await add(owner.session, link.productId, 1, second);
  expect(addedB.status, await addedB.clone().text()).toBe(200);
  const afterSecond = await page(link.productId);
  const [, photoB] = ids(afterSecond);
  if (photoB === undefined) throw new Error("No second photo");
  expect(ids(afterSecond)).toEqual([photoA, photoB]);
  expect(afterSecond.image?.url).toContain(photoA);
  await shopShows(link.variantId, [photoA, photoB]);
  const served = await env.UNDERCLERK.fetch(
    afterSecond.photos.items[1]?.url ?? "",
  );
  expect(served.status).toBe(200);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(second.bytes);

  // 3. A new order leads with the second photo on the page and in the shop.
  const reordered = await arrange(link.productId, 2, [photoB, photoA]);
  expect(reordered.status, await reordered.clone().text()).toBe(200);
  const afterOrder = await page(link.productId);
  expect(ids(afterOrder)).toEqual([photoB, photoA]);
  expect(afterOrder.image?.url).toContain(photoB);
  await shopShows(link.variantId, [photoB, photoA]);

  // 4. An order from an older view changes nothing.
  const stale = await arrange(link.productId, 2, [photoA, photoB]);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "stale_resource_revision",
  });
  expect(ids(await page(link.productId))).toEqual([photoB, photoA]);

  // 5. A removed photo leaves the shop, and Undo puts it back.
  const removed = await arrange(link.productId, 3, [photoB]);
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect(ids(await page(link.productId))).toEqual([photoB]);
  await shopShows(link.variantId, [photoB]);
  const undone = await arrange(link.productId, 4, [photoB, photoA]);
  expect(undone.status, await undone.clone().text()).toBe(200);
  expect(ids(await page(link.productId))).toEqual([photoB, photoA]);

  // 6. An operator, a drawing, a mislabelled file and an unknown photo change nothing.
  const refused = await add(operator.session, link.productId, 5, {
    bytes: png(3),
    type: "image/png",
  });
  expect(refused.status, await refused.clone().text()).toBe(404);
  const drawing = await add(owner.session, link.productId, 5, {
    bytes: new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    ),
    type: "image/svg+xml",
  });
  expect(drawing.status).toBe(422);
  const mislabelled = await add(owner.session, link.productId, 5, {
    bytes: png(4),
    type: "image/jpeg",
  });
  expect(mislabelled.status, await mislabelled.clone().text()).toBe(422);
  const unknown = await arrange(link.productId, 5, [photoB, "media_unknown"]);
  expect(unknown.status).toBe(422);
  const afterRefusals = await page(link.productId);
  expect(ids(afterRefusals)).toEqual([photoB, photoA]);
  expect(afterRefusals.photos.revision).toBe(5);

  // 7. The same photo on another product keeps one address.
  const shared = await add(owner.session, other.productId, 0, first);
  expect(shared.status, await shared.clone().text()).toBe(200);
  expect(ids(await page(other.productId))).toEqual([photoA]);
  const library = await required(admin.listMedia(merchantId));
  expect(library.media.map((item) => item.id).sort()).toEqual(
    [photoA, photoB].sort(),
  );

  Object.assign(context.task.meta, {
    productPhotosEvidence: {
      organisationId,
      merchantId,
      productId: link.productId,
      finalOrder: [photoB, photoA],
      shopOrder: await shopPhotos(link.variantId),
      refused: {
        operator: refused.status,
        drawing: drawing.status,
        mislabelled: mislabelled.status,
        unknown: unknown.status,
        stale: stale.status,
      },
    },
  });
}

function mediaIdOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

async function required<T>(
  result: Promise<CommerceClientResult<T>>,
): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}
