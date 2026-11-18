import { env, exports } from "cloudflare:workers";
import { expect, it, vi, type TestContext } from "vitest";
import { parseInventory, type InventoryData } from "@seams/contracts";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CommerceClientResult,
} from "@seams/commerce-client";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  commerceClient,
  commerceWorkspace,
  commerceHeaders,
  connectCommerceFixture,
} from "./commerce-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

const STOREFRONT = "storefront_cafe";

type ProductPrice = Readonly<{
  variantId: string;
  amountMinor: number;
  currency: string;
}>;

it(
  "lists on the Portal Products page what a buyer sees, also after an operator archives products",
  { timeout: 120000 },
  productsMatchStorefront,
);

async function productsMatchStorefront(context: TestContext): Promise<void> {
  const owner = await commerceClient(`products-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Products match shop");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_products_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const clientOptions = {
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  };
  const admin = new CommerceAdminClient(clientOptions);
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://underclerk.test",
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

  async function portal(): Promise<InventoryData> {
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/commerce/inventory`,
      { headers: commerceHeaders(owner.session) },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return parseInventory(await response.json());
  }
  async function shop(): Promise<ProductPrice[]> {
    const session = await required(
      buyer.createSession(merchantId, STOREFRONT, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    const catalog = await required(
      buyer.readCatalog(merchantId, STOREFRONT, session.token),
    );
    return catalog.listings
      .map((listing) => ({
        variantId: listing.variantId,
        amountMinor: listing.price.amountMinor,
        currency: listing.price.currency,
      }))
      .sort(byVariant);
  }

  const before = await portal();
  expect(portalProducts(before)).toEqual(await shop());
  const tracked = before.rows.find((row) => row.kind === "product");
  const madeToOrder = before.untrackedProducts.find((row) => row.madeToOrder);
  if (tracked?.kind !== "product" || madeToOrder === undefined)
    throw new Error("Café fixture needs stocked and made-to-order products");

  expect(tracked.product.description.length).toBeGreaterThan(0);

  // A retired product: a buyer no longer sees it, so the operator must not.
  const stock = await required(admin.readStockSnapshot(merchantId));
  const archived = [tracked.product, madeToOrder];
  for (const { productId } of archived) {
    const product = stock.commerce.resources.products.find(
      (candidate) => candidate.id === productId,
    );
    if (product === undefined) throw new Error("Fixture product missing");
    await required(
      admin.updateProduct({
        merchantId,
        idempotencyKey: `archive-${productId}`,
        productId,
        expectedProductRevision: product.revision,
        changes: { status: "archived" },
      }),
    );
  }

  // Guest catalogs come from a short-lived snapshot.
  await vi.waitFor(
    async () => {
      expect((await shop()).map(variantOf)).not.toContain(
        madeToOrder.variantId,
      );
    },
    { timeout: 15000, interval: 1000 },
  );
  const after = await portal();
  const offered = await shop();
  expect(portalProducts(after)).toEqual(offered);
  expect(offered.map(variantOf)).not.toContain(tracked.product.variantId);
  // The stock of the archived product leaves the page, with no false alarm.
  expect(
    after.rows.filter((row) => row.inventoryItemId === tracked.inventoryItemId),
  ).toEqual([]);
  Object.assign(context.task.meta, {
    productsMatchStorefrontEvidence: {
      organisationId,
      merchantId,
      productsBefore: before.rows.length + before.untrackedProducts.length,
      archived: archived.map((product) => product.productId),
      shopAfter: offered,
    },
  });
}

function portalProducts(data: InventoryData): ProductPrice[] {
  const products = new Map<string, ProductPrice>();
  for (const row of data.rows) {
    if (row.kind === "product")
      products.set(row.product.variantId, price(row.product));
  }
  for (const product of data.untrackedProducts)
    products.set(product.variantId, price(product));
  return [...products.values()].sort(byVariant);
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

function variantOf(product: ProductPrice): string {
  return product.variantId;
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
