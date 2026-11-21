// Plan 76A step 6: staff make a manual collection and an automated one
// ("tag is gift, price under 3,000"). Catalog edits change the automated
// members under the edit's own receipt; a buyer reads both in order and in
// pages; an archived product leaves both. Set COLLECTION_ARTIFACT_DIR to keep
// the run's evidence; the file repeats byte for byte for the same commit.
import type {
  CreateCommerceCollectionV1,
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceProductChangesV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  CHANNEL,
  NOW,
  PRODUCT,
  STOREFRONT,
  StaffDesk,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  teaOffer,
  teaPlan,
  teaVariant,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const GIFTS = [
  ["product_gift_box", "Gift box", "variant_gift_box", "GIFT-BOX", 2_500],
  ["product_gift_tin", "Gift tin", "variant_gift_tin", "GIFT-TIN", 2_800],
  ["product_gift_hamper", "Gift hamper", "variant_gift_hamper", "GIFT-HAMPER", 5_000],
] as const;

it(
  "keeps manual and automated collections current and pages them for buyers",
  { timeout: 60_000 },
  collectionsFollowTheCatalog,
);

async function collectionsFollowTheCatalog(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new CollectionStaff(admin);
    await staff.createTea();
    for (const [productId, title, variantId, sku, price] of GIFTS)
      await staff.listGift(productId, title, variantId, sku, price);

    expect(
      await staff.create("collection_picks", "staff-picks", "manual", {
        kind: "manual",
        productIds: ["product_gift_hamper", "product_gift_box", PRODUCT],
      }),
    ).toMatchObject({ outcome: "applied", receipt: { commandKind: "create_collection" } });
    expect(
      await staff.create("collection_gifts", "gifts-under-3000", "price_ascending", {
        kind: "automated",
        rule: {
          match: "all",
          conditions: [
            { field: "tag", equals: "gift" },
            { field: "price", below: 3_000 },
          ],
        },
      }),
    ).toMatchObject({ outcome: "applied" });
    // A handle names one collection.
    expect(
      await staff.create("collection_again", "staff-picks", "title", {
        kind: "manual",
        productIds: [],
      }),
    ).toMatchObject(rejectedWith({ field: "collection.handle.taken" }));
    const shopper = await Shopper.start(buyer);
    expect(await shopper.handles()).toEqual(["gifts-under-3000", "staff-picks"]);
    expect(await shopper.titles("gifts-under-3000")).toEqual([]);

    // Staff tag the three gifts. Each tag edit is one receipt, and the
    // automated members change with it.
    for (const [productId] of GIFTS) {
      const revision = await staff.revisionOf();
      const edit = await staff.updateProduct(productId, { tags: ["gift"] });
      expect(edit).toMatchObject({
        outcome: "applied",
        receipt: { commandKind: "update_product", merchantRevision: revision + 1 },
      });
    }
    // Price ascending, and the hamper is above the limit.
    expect(await shopper.titles("gifts-under-3000")).toEqual(["Gift box", "Gift tin"]);
    // Pages of one product.
    const first = await shopper.page("gifts-under-3000", { limit: 1 });
    expect(first.products.map((product) => product.title)).toEqual(["Gift box"]);
    const second = await shopper.page("gifts-under-3000", {
      limit: 1,
      after: first.nextCursor ?? "",
    });
    expect(second.products.map((product) => product.title)).toEqual(["Gift tin"]);
    expect(second.nextCursor).toBeNull();
    // The manual collection keeps the staff order; a price filter applies.
    expect(await shopper.titles("staff-picks")).toEqual([
      "Gift hamper",
      "Gift box",
      "Loose leaf tea",
    ]);
    expect(
      (await shopper.page("staff-picks", { maximumPrice: 3_000 })).products.map(
        (product) => [product.title, product.price.amountMinor],
      ),
    ).toEqual([
      ["Gift box", 2_500],
      ["Loose leaf tea", 1_200],
    ]);

    // The tin's price rises above the limit; it leaves the automated list.
    expect(await staff.updateOffer("offer_gift_tin", 1, jpy(3_200))).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "update_offer" },
    });
    expect(await shopper.titles("gifts-under-3000")).toEqual(["Gift box"]);

    // The box is archived; it leaves both collections.
    await staff.updateProduct("product_gift_box", { status: "archived" });
    expect(await shopper.titles("gifts-under-3000")).toEqual([]);
    expect(await shopper.titles("staff-picks")).toEqual(["Gift hamper", "Loose leaf tea"]);
    const stored = await required(admin.listCollections(merchantId));
    expect(
      stored.map((collection) => [collection.handle, collection.productIds]),
    ).toEqual([
      ["gifts-under-3000", []],
      ["staff-picks", ["product_gift_hamper", "product_gift_box", PRODUCT]],
    ]);
    // The event feed shows each change once, under its own command.
    const kinds = (await required(admin.readEvents(merchantId, { limit: 200 }))).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("collection.") || kind === "product.updated");
    expect(kinds).toEqual([
      "collection.created",
      "collection.created",
      "product.updated",
      "product.updated",
      "product.updated",
      "product.updated",
    ]);

    Object.assign(evidence, { receipts: staff.receipts, collections: stored, kinds });
  } finally {
    writeEvidence("COLLECTION_ARTIFACT_DIR", "collections", evidence);
    backend.close();
  }
}

class Shopper {
  readonly #client: CommerceStorefrontClient;
  readonly #token: string;

  constructor(client: CommerceStorefrontClient, token: string) {
    this.#client = client;
    this.#token = token;
  }

  static async start(client: CommerceStorefrontClient): Promise<Shopper> {
    const session = await required(
      client.createSession(merchantId, STOREFRONT, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    return new Shopper(client, session.token);
  }

  async handles(): Promise<readonly string[]> {
    return (
      await required(this.#client.listCollections(merchantId, STOREFRONT, this.#token))
    ).collections.map((collection) => collection.handle);
  }

  page(
    handle: string,
    filter: Parameters<CommerceStorefrontClient["readCollection"]>[4] = {},
  ) {
    return required(
      this.#client.readCollection(merchantId, STOREFRONT, handle, this.#token, filter),
    );
  }

  async titles(handle: string): Promise<readonly string[]> {
    return (await this.page(handle)).products.map((product) => product.title);
  }
}

class CollectionStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "collection");
  }

  async revisionOf(): Promise<number> {
    return (await required(this.admin.readSnapshot(merchantId))).merchantRevision;
  }

  async listGift(
    productId: string,
    title: string,
    variantId: string,
    sku: string,
    price: number,
  ): Promise<void> {
    await this.apply(
      this.admin.placeChannelListing({
        ...(await this.base(`list_${productId}`)),
        salesChannelId: CHANNEL,
        catalog: {
          kind: "new_product",
          product: {
            id: productId,
            revision: 1,
            title,
            description: `${title} of Kyoto tea.`,
            handle: null,
            productType: "gift",
            vendor: "",
            tags: [],
            status: "active",
            occurredAt: NOW,
          },
          variant: { ...teaVariant(variantId, title, sku, []), productId },
          consumptionPlan: teaPlan(variantId),
        },
        offer: teaOffer(variantId, price),
      }),
    );
  }

  create(
    collectionId: string,
    handle: string,
    sortOrder: CreateCommerceCollectionV1["sortOrder"],
    selection: CreateCommerceCollectionV1["selection"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.createCollection({
        ...this.editBase(`create_${collectionId}`),
        collectionId,
        handle,
        title: handle.replaceAll("-", " "),
        description: "",
        salesChannelId: CHANNEL,
        sortOrder,
        status: "active",
        selection,
      }),
    );
  }

  async updateProduct(
    productId: string,
    changes: CommerceProductChangesV1,
  ): Promise<CommerceMutationResultV1> {
    const product = (await this.snapshot()).products.find((item) => item.id === productId);
    if (product === undefined) throw new Error(`${productId} is missing`);
    return this.edit(
      this.admin.updateProduct({
        ...this.editBase(`product_${productId}_${product.revision}`),
        productId,
        expectedProductRevision: product.revision,
        changes,
      }),
    );
  }

  updateOffer(
    offerId: string,
    expectedOfferRevision: number,
    price: ReturnType<typeof jpy>,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateOffer({
        ...this.editBase(`offer_${offerId}`),
        offerId,
        expectedOfferRevision,
        changes: { price },
      }),
    );
  }
}
