// Plan 76A step 1: staff edit the catalog while buyers shop at the café.
// Set CATALOG_EDITING_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte on every run of the same commit.
import type {
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceVariantV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  CHANNEL,
  PRODUCT,
  StaffDesk,
  catalogFor,
  catalogLine,
  jpy,
  latteEntry,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  teaListings,
  teaOffer,
  teaPlan,
  teaVariant,
  usd,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

it(
  "keeps buyers and orders consistent while staff edit products, variants and offers",
  { timeout: 60_000 },
  editCatalogWhileBuyersShop,
);

async function editCatalogWhileBuyersShop(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new Staff(admin);

    // A tea with two options (size and leaf) and four variants, all on sale.
    await staff.createTea();
    const listed = await catalogFor(buyer);
    expect(teaListings(listed).map((listing) => listing.variantId)).toEqual([
      "variant_tea_large_hojicha",
      "variant_tea_large_sencha",
      "variant_tea_small_hojicha",
      "variant_tea_small_sencha",
    ]);

    // Before any edit: Dana buys a large sencha.
    const dana = await Buyer.start(buyer, "dana");
    const danaOrder = await dana.buyLines([
      catalogLine("variant_tea_large_sencha"),
    ]);

    // Quotes taken before the edits.
    const amir = await Buyer.start(buyer, "amir");
    await amir.fillCart([catalogLine("variant_tea_large_hojicha")]);
    const bea = await Buyer.start(buyer, "bea");
    const beaQuote = await bea.quote([catalogLine("variant_tea_small_sencha")]);
    const cho = await Buyer.start(buyer, "cho");
    const choQuote = await cho.quote([
      catalogLine("variant_tea_small_hojicha"),
    ]);

    // Staff edit the catalog.
    const rename = await staff.updateProduct(1, {
      title: "Kyoto loose leaf tea",
      handle: "kyoto-loose-leaf-tea",
      productType: "Tea",
      vendor: "Pantry Tea",
      tags: ["tea", "gift"],
    });
    expect(rename).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "update_product", resource: { revision: 2 } },
    });
    expect(
      await staff.updateProduct(1, { title: "Stale rename" }),
    ).toMatchObject(rejectedWith({ code: "stale_resource_revision" }));
    // The same command under the same key replays its receipt.
    const repeat = await staff.updateProduct(
      2,
      { tags: ["tea", "gift", "kyoto"] },
      "tags",
    );
    expect(repeat).toMatchObject({ outcome: "applied" });
    expect(
      await staff.updateProduct(2, { tags: ["tea", "gift", "kyoto"] }, "tags"),
    ).toEqual({
      outcome: "replayed",
      receipt: repeat.outcome === "applied" ? repeat.receipt : undefined,
    });
    expect(
      await staff.updateOffer("offer_tea_small_sencha", 1, {
        price: jpy(1_400),
        compareAtPrice: jpy(1_600),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await staff.updateOffer("offer_tea_large_sencha", 1, {
        price: jpy(2_100),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await staff.updateOffer("offer_tea_large_sencha", 2, { price: usd(21) }),
    ).toMatchObject(
      rejectedWith({
        code: "resource_relationship_invalid",
        field: "offer.currency",
      }),
    );
    await staff.addVariant(
      "variant_tea_gift_sencha",
      "Gift tin",
      "TEA-GIFT-SENCHA",
      [
        { name: "Size", value: "Gift" },
        { name: "Leaf", value: "Sencha" },
      ],
    );
    expect(
      await staff.updateVariant("variant_tea_small_hojicha", 1, {
        sku: "TEA-L-SENCHA",
      }),
    ).toMatchObject(
      rejectedWith({ code: "resource_already_exists", kind: "sku" }),
    );
    expect(
      await staff.updateVariant("variant_tea_large_hojicha", 1, {
        status: "archived",
      }),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "update_variant" },
    });
    // Cho's variant is renamed between Cho's quote and Cho's payment.
    expect(
      await staff.updateVariant("variant_tea_small_hojicha", 1, {
        title: "Small roasted hojicha",
      }),
    ).toMatchObject({ outcome: "applied" });

    // Buyers see the edited catalog: new title, handle and compare-at price;
    // the fifth variant is on sale and the archived one is gone.
    const edited = teaListings(await catalogFor(buyer));
    expect(edited.map((listing) => listing.variantId)).toEqual([
      "variant_tea_gift_sencha",
      "variant_tea_large_sencha",
      "variant_tea_small_hojicha",
      "variant_tea_small_sencha",
    ]);
    expect(
      edited.find(
        (listing) => listing.variantId === "variant_tea_small_sencha",
      ),
    ).toMatchObject({
      title: "Kyoto loose leaf tea",
      handle: "kyoto-loose-leaf-tea",
      price: jpy(1_400),
      compareAtPrice: jpy(1_600),
      options: [
        { name: "Size", value: "Small" },
        { name: "Leaf", value: "Sencha" },
      ],
    });
    expect(
      edited.find(
        (listing) => listing.variantId === "variant_tea_small_hojicha",
      ),
    ).toMatchObject({
      variantTitle: "Small roasted hojicha",
      variantRevision: 2,
    });

    // Amir's cart holds the archived variant: checkout names that line.
    const amirRefusal = await amir.tryCheckout();
    expect(amirRefusal).toMatchObject({
      code: "resource_relationship_invalid",
    });
    await amir.fillCart([catalogLine("variant_tea_gift_sencha")]);
    const amirOrder = await amir.buyCart();

    // Bea's quote predates her offer's price change: payment is refused until
    // she refreshes, and then she pays the new price.
    expect(await bea.tryPay(beaQuote)).toMatchObject({
      code: "checkout_refresh_required",
    });
    const beaOrder = await bea.refreshAndPay(beaQuote, [
      catalogLine("variant_tea_small_sencha"),
    ]);

    // Cho's offer did not change, so the quote stands, and the order keeps the
    // title of the quote although the variant was renamed in between.
    const choOrder = await cho.pay(choQuote);

    // A menu entry stays on sale after its offer's price changes.
    expect(latteEntry(await catalogFor(buyer))?.availability).toBe("available");
    const menuOffer = await staff.offer("offer_sesame_latte_cafe");
    expect(
      await staff.updateOffer(menuOffer.id, menuOffer.revision, {
        price: jpy(menuOffer.price.amountMinor + 50),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(latteEntry(await catalogFor(buyer))).toMatchObject({
      availability: "available",
      price: jpy(menuOffer.price.amountMinor + 50),
    });
    const eli = await Buyer.start(buyer, "eli");
    const eliOrder = await eli.buyLines([
      {
        kind: "menu",
        menuId: "menu_cafe_main",
        menuEntryId: "menu_entry_sesame_latte",
        modifierOptionIds: [],
        quantity: 1,
      },
    ]);

    // Archiving the product removes every variant from the storefront.
    expect(
      await staff.updateProduct(3, { status: "archived" }, "archive"),
    ).toMatchObject({ outcome: "applied" });
    expect(teaListings(await catalogFor(buyer))).toEqual([]);
    const fay = await Buyer.start(buyer, "fay");
    expect(
      await fay.tryCart([catalogLine("variant_tea_gift_sencha")]),
    ).toMatchObject({ code: "resource_relationship_invalid" });

    // Orders keep what each buyer agreed to.
    const orders = await staff.orderLines();
    const lines = {
      dana: orders.get(danaOrder),
      amir: orders.get(amirOrder),
      bea: orders.get(beaOrder),
      cho: orders.get(choOrder),
      eli: orders.get(eliOrder),
    };
    expect(lines).toEqual({
      dana: [
        { title: "Large sencha", sku: "TEA-L-SENCHA", unitPrice: jpy(1_800) },
      ],
      amir: [
        { title: "Gift tin", sku: "TEA-GIFT-SENCHA", unitPrice: jpy(2_400) },
      ],
      bea: [
        { title: "Small sencha", sku: "TEA-S-SENCHA", unitPrice: jpy(1_400) },
      ],
      cho: [
        { title: "Small hojicha", sku: "TEA-S-HOJICHA", unitPrice: jpy(1_200) },
      ],
      eli: [
        {
          title: expect.any(String),
          sku: expect.any(String),
          unitPrice: jpy(menuOffer.price.amountMinor + 50),
        },
      ],
    });

    // The product sales report still attributes every tea sale to the tea,
    // although the variants changed revision.
    const report = await required(
      admin.readProductSales(merchantId, {
        start: "2026-08-14T00:00:00.000Z",
        end: "2026-08-15T00:00:00.000Z",
      }),
    );
    expect(report).toMatchObject({ kind: "reported" });
    const teaGroup =
      report.kind === "reported"
        ? report.groups.find((group) => group.productId === PRODUCT)
        : undefined;
    expect(teaGroup?.merchandiseMinor).toBe(1_800 + 2_400 + 1_400 + 1_200);

    Object.assign(evidence, {
      receipts: staff.receipts,
      refusals: {
        staleRename: "stale_resource_revision",
        otherCurrency: "offer.currency",
        takenSku: "sku",
        archivedVariantInCart: amirRefusal,
        quoteBeforePriceChange: "checkout_refresh_required",
        archivedProductInCart: "resource_relationship_invalid",
      },
      catalogAfterEdits: edited,
      contractParseInputs: { catalog: listed, checkout: beaQuote },
      orderLines: lines,
      teaSalesMinor: teaGroup?.merchandiseMinor,
    });
  } finally {
    writeEvidence("CATALOG_EDITING_ARTIFACT_DIR", "catalog-editing", evidence);
    backend.close();
  }
}

class Staff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "catalog_editing");
  }

  async addVariant(
    id: string,
    title: string,
    sku: string,
    options: CommerceVariantV1["options"],
  ): Promise<void> {
    const product = (await this.snapshot()).products.find(
      (candidate) => candidate.id === PRODUCT,
    );
    if (product === undefined) throw new Error("The tea product is missing");
    await this.apply(
      this.admin.placeChannelListing({
        ...(await this.base("gift_listing")),
        salesChannelId: CHANNEL,
        catalog: {
          kind: "new_variant",
          productId: PRODUCT,
          productRevision: product.revision,
          variant: teaVariant(id, title, sku, options),
          consumptionPlan: teaPlan(id),
        },
        offer: teaOffer(id, 2_400),
      }),
    );
  }

  updateProduct(
    expectedProductRevision: number,
    changes: Parameters<CommerceAdminClient["updateProduct"]>[0]["changes"],
    key = `product_${this.step}`,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateProduct({
        ...this.editBase(key),
        productId: PRODUCT,
        expectedProductRevision,
        changes,
      }),
    );
  }

  updateVariant(
    variantId: string,
    expectedVariantRevision: number,
    changes: Parameters<CommerceAdminClient["updateVariant"]>[0]["changes"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateVariant({
        ...this.editBase(`variant_${this.step}`),
        variantId,
        expectedVariantRevision,
        changes,
      }),
    );
  }

  updateOffer(
    offerId: string,
    expectedOfferRevision: number,
    changes: Parameters<CommerceAdminClient["updateOffer"]>[0]["changes"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateOffer({
        ...this.editBase(`offer_${this.step}`),
        offerId,
        expectedOfferRevision,
        changes,
      }),
    );
  }

  async offer(offerId: string) {
    const offer = (await this.snapshot()).offers.find(
      (candidate) => candidate.id === offerId,
    );
    if (offer === undefined) throw new Error(`${offerId} is missing`);
    return offer;
  }

  async orderLines(): Promise<
    Map<
      string,
      readonly Readonly<{ title: string; sku: string; unitPrice: unknown }>[]
    >
  > {
    const orders = (await this.snapshot()).orders;
    return new Map(
      orders.map((order) => [
        order.id,
        order.lineItems.map((line) => ({
          title: line.title,
          sku: line.sku,
          unitPrice: line.unitPrice,
        })),
      ]),
    );
  }
}
