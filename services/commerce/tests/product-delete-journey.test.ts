// Staff delete products while buyers shop. A product with an order keeps its
// history; a never-sold product leaves no row behind, so its SKU can return.
// Set PRODUCT_DELETE_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte on every run of the same commit.
import type {
  CommerceAdminClient,
  CommerceMutationResultV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import type { ArchiveStore } from "../src/archive.ts";
import { clientInput } from "./command-input.ts";
import {
  Buyer,
  CHANNEL,
  LOCATION,
  NOW,
  PRODUCT,
  STOREFRONT,
  StaffDesk,
  catalogFor,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  teaOffer,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

it(
  "deletes only a product that nothing needs, and leaves no row behind",
  { timeout: 60_000 },
  deleteProductsWhileBuyersShop,
);

it(
  "keeps a product whose only order has moved to the archive",
  { timeout: 60_000 },
  keepProductWithArchivedOrder,
);

/** An in-memory R2: it only stores bytes. */
class MemoryArchive implements ArchiveStore {
  readonly objects = new Map<
    string,
    Readonly<{ body: Uint8Array; sha256: string }>
  >();

  async head(key: string) {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : { sha256: object.sha256, size: object.body.length };
  }

  async put(key: string, body: Uint8Array, sha256: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), sha256 });
  }

  async read(key: string, offset: number, length: number) {
    return this.objects.get(key)?.body.slice(offset, offset + length) ?? null;
  }
}

async function keepProductWithArchivedOrder(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
    archive: new MemoryArchive(),
  });
  try {
    const { admin, buyer } = backend;
    const staff = new Staff(admin);
    await staff.createTea();
    const order = await (
      await Buyer.start(buyer, "gwen")
    ).buyLines([catalogLine("variant_tea_small_sencha")]);
    await staff.collect(order);
    clock += 200 * 24 * 60 * 60 * 1_000;
    const run = await required(admin.runArchive(merchantId));
    expect(run.orders).toBe(1);
    expect((await staff.resources()).orders).toEqual([]);
    expect(await staff.deleteProduct(PRODUCT, 1)).toMatchObject(
      rejectedWith({ code: "product_delete_refused", reason: "sold" }),
    );
  } finally {
    backend.close();
  }
}

async function deleteProductsWhileBuyersShop(): Promise<void> {
  let clock = NOW;
  const backend = await startBackend({ now: () => clock });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new Staff(admin);
    await staff.createTea();

    // Cocoa shares the tea tin and has a tin of its own stock nowhere else.
    await staff.listProduct("cocoa", "inventory_tea_tin");
    await staff.createItem("inventory_mint_tin");
    await staff.listProduct("mint", "inventory_mint_tin");

    const amir = await required(
      buyer.createSession(merchantId, STOREFRONT, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    const amirCart = await required(
      buyer.createCart(merchantId, STOREFRONT, amir.token, {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: "amir_cart",
        lines: [
          catalogLine("variant_cocoa"),
          catalogLine("variant_tea_small_sencha"),
        ],
      }),
    );

    // A quote that can still be paid holds the product.
    const bea = await Buyer.start(buyer, "bea");
    const quote = await bea.quote([catalogLine("variant_cocoa")]);
    expect(await staff.deleteProduct("product_cocoa", 1)).toMatchObject(
      rejectedWith({ code: "product_delete_refused", reason: "open_checkout" }),
    );
    expect(await staff.deleteProduct("product_cocoa", 9)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );

    // Once the quote has lapsed, the product goes and the cart line with it.
    clock = new Date(Date.parse(NOW) + 660_000).toISOString();
    await backend.runDueWork();
    const deleted = await staff.deleteProduct("product_cocoa", 1, "cocoa");
    expect(deleted).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "delete_product" },
    });
    expect(await staff.deleteProduct("product_cocoa", 1, "cocoa")).toEqual({
      outcome: "replayed",
      receipt: deleted.outcome === "applied" ? deleted.receipt : undefined,
    });
    const resources = await staff.resources();
    expect(resources.products.map((item) => item.id)).not.toContain(
      "product_cocoa",
    );
    expect(resources.variants.map((item) => item.id)).not.toContain(
      "variant_cocoa",
    );
    expect(resources.offers.map((item) => item.id)).not.toContain(
      "offer_cocoa",
    );
    expect(tin(resources, "inventory_tea_tin").lifecycle).toBe("active");
    const cart = await required(
      buyer.readCart(merchantId, STOREFRONT, amirCart.cartId, amir.token),
    );
    expect(cart.lines.map((line) => line.variantId)).toEqual([
      "variant_tea_small_sencha",
    ]);
    expect(cart.revision).toBeGreaterThan(amirCart.revision);
    expect(listed(await catalogFor(buyer))).not.toContain("variant_cocoa");
    await expect(bea.tryPay(quote)).resolves.toBeDefined();

    // The SKU and the ids are free again: no row of the product stayed.
    await staff.listProduct("cocoa", "inventory_tea_tin");
    expect(listed(await catalogFor(buyer))).toContain("variant_cocoa");

    // A product alone on its stock retires the stock with it.
    expect(await staff.deleteProduct("product_mint", 1)).toMatchObject({
      outcome: "applied",
    });
    expect(tin(await staff.resources(), "inventory_mint_tin").lifecycle).toBe(
      "inactive",
    );

    // A sold product stays, also after staff archive it, and its order keeps
    // what the buyer agreed to.
    const dana = await Buyer.start(buyer, "dana");
    const order = await dana.buyLines([
      catalogLine("variant_tea_large_sencha"),
    ]);
    expect(await staff.deleteProduct(PRODUCT, 1)).toMatchObject(
      rejectedWith({ code: "product_delete_refused", reason: "sold" }),
    );
    expect(await staff.archive(PRODUCT, 1)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.deleteProduct(PRODUCT, 2)).toMatchObject(
      rejectedWith({ code: "product_delete_refused", reason: "sold" }),
    );
    const danaOrder = (await staff.resources()).orders.find(
      (item) => item.id === order,
    );
    expect(danaOrder?.lineItems[0]?.title).toBe("Large sencha");

    // A product on the published menu stays until it leaves the menu.
    const onMenu = await staff.menuProduct();
    expect(await staff.deleteProduct(onMenu.id, onMenu.revision)).toMatchObject(
      rejectedWith({ code: "product_delete_refused", reason: "on_menu" }),
    );

    evidence.receipts = staff.receipts;
    writeEvidence("PRODUCT_DELETE_ARTIFACT_DIR", "product-delete", evidence);
  } finally {
    backend.close();
  }
}

function tin(resources: Awaited<ReturnType<Staff["resources"]>>, id: string) {
  const item = resources.inventoryItems.find(
    (candidate) => candidate.id === id,
  );
  if (item === undefined) throw new Error(`The item ${id} is missing`);
  return item;
}

function listed(catalog: Awaited<ReturnType<typeof catalogFor>>) {
  return catalog.listings.map((listing) => listing.variantId);
}

class Staff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "product_delete");
  }

  resources() {
    return this.snapshot();
  }

  async createItem(id: string): Promise<void> {
    await this.apply(
      this.admin.createInventoryItem({
        ...(await this.base("item")),
        inventoryItemId: id,
        merchantCode: id.toUpperCase(),
        name: id,
        baseUnit: "each",
        category: "finished_good",
        tracking: { kind: "aggregate" },
      }),
    );
  }

  async listProduct(name: string, inventoryItemId: string): Promise<void> {
    const variantId = `variant_${name}`;
    await this.apply(
      this.admin.placeChannelListing({
        ...(await this.base(`listing_${name}`)),
        salesChannelId: CHANNEL,
        catalog: {
          kind: "new_product",
          product: {
            id: `product_${name}`,
            revision: 1,
            title: name,
            description: "",
            handle: null,
            productType: "",
            vendor: "",
            tags: [],
            status: "active",
            occurredAt: NOW,
          },
          variant: {
            id: variantId,
            revision: 1,
            productId: `product_${name}`,
            sku: `SKU-${name}`,
            title: name,
            options: [],
            media: [],
            barcode: null,
            status: "active",
            occurredAt: NOW,
          },
          consumptionPlan: {
            consumptionPlanId: `plan_${variantId}`,
            variantId,
            revision: 1,
            scope: { kind: "location", locationId: LOCATION },
            mode: {
              kind: "direct",
              components: [
                {
                  inventoryItemId,
                  quantity: { amount: 1, scale: 0, unit: "each" },
                },
              ],
              commitOn: "fulfillment_completed",
            },
            lifecycle: "active",
          },
        },
        offer: { ...teaOffer(variantId, 500), price: jpy(500) },
      }),
    );
  }

  async collect(orderId: string): Promise<void> {
    const target = async (name: string) => {
      const resources = await this.snapshot();
      const order = resources.orders.find((item) => item.id === orderId);
      const fulfillment = resources.fulfillments.find(
        (item) => item.orderId === orderId,
      );
      const payment = resources.payments.find(
        (item) => item.orderId === orderId,
      );
      if (
        order === undefined ||
        fulfillment === undefined ||
        payment === undefined
      )
        throw new Error(`${orderId} is incomplete`);
      return {
        base: {
          ...(await this.base(name)),
          requestedAt: NOW,
          orderId,
          orderRevision: order.revision,
          fulfillmentId: fulfillment.id,
          fulfillmentRevision: fulfillment.revision,
        },
        payment,
      };
    };
    const ready = await target("ready");
    await this.apply(this.admin.markPickupReady(clientInput(ready.base)));
    const complete = await target("complete");
    await this.apply(
      this.admin.completePickup({
        ...clientInput(complete.base),
        paymentId: complete.payment.id,
        paymentRevision: complete.payment.revision,
      }),
    );
  }

  deleteProduct(
    productId: string,
    expectedProductRevision: number,
    key = `delete_${this.step}`,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.deleteProduct({
        ...this.editBase(key),
        productId,
        expectedProductRevision,
      }),
    );
  }

  archive(
    productId: string,
    expectedProductRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateProduct({
        ...this.editBase(`archive_${productId}`),
        productId,
        expectedProductRevision,
        changes: { status: "archived" },
      }),
    );
  }

  async menuProduct() {
    const stock = await required(this.admin.readStockSnapshot(merchantId));
    const resources = stock.commerce.resources;
    const entry = stock.foodService.resources.menus[0]?.entries[0];
    const offer = resources.offers.find((item) => item.id === entry?.offerId);
    const variant = resources.variants.find(
      (item) => item.id === offer?.variantId,
    );
    const product = resources.products.find(
      (item) => item.id === variant?.productId,
    );
    if (product === undefined) throw new Error("The menu has no product");
    return product;
  }
}
