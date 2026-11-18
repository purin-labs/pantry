// Plan 76 phase 7: storefront search. Staff describe the tea in Japanese; a
// buyer finds it in English and Japanese, in any width and case, and with
// katakana for hiragana. Every term must match, a limit bounds the answer,
// and a search without a valid session is refused.
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  PRODUCT,
  STOREFRONT,
  StaffDesk,
  merchantId,
  required,
  startBackend,
} from "./journey-support.ts";

it("finds listings by every term, in any width, case or kana", async () => {
  const backend = await startBackend();
  try {
    await new StaffDesk(backend.admin, "search").createTea();
    const snapshot = await required(backend.admin.readSnapshot(merchantId));
    const product = snapshot.resources.products.find(
      (item) => item.id === PRODUCT,
    );
    if (product === undefined) throw new Error("No tea product");
    const described = await required(
      backend.admin.updateProductDescription({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        productId: product.id,
        expectedProductRevision: product.revision,
        description: "京都の煎茶とほうじ茶。せんちゃ、ほうじちゃ。",
        idempotencyKey: "search_describe_tea",
      }),
    );
    expect(described.outcome).toBe("applied");

    const buyer = await Buyer.start(backend.buyer, "search_buyer");
    const search = async (query: string, limit?: number) =>
      (
        await required(
          backend.buyer.searchCatalog(
            merchantId,
            STOREFRONT,
            buyer.token,
            query,
            limit,
          ),
        )
      ).listings.map((listing) => listing.variantTitle);

    expect(await search("sencha")).toEqual(["Large sencha", "Small sencha"]);
    expect(await search("LARGE  ＳＥＮＣＨＡ")).toEqual(["Large sencha"]);
    // Only the described tea has せんちゃ in hiragana.
    expect(await search("センチャ")).toEqual([
      "Large hojicha",
      "Large sencha",
      "Small hojicha",
      "Small sencha",
    ]);
    expect((await search("煎茶 small")).length).toBe(2);
    expect(await search("durian")).toEqual([]);
    expect(await search("sencha", 1)).toHaveLength(1);

    const badLimit = await backend.fetch(
      `${BASE_URL}/v1/public/merchants/${merchantId}/storefronts/${STOREFRONT}/catalog/search?q=tea&limit=many`,
      { headers: { authorization: `Bearer ${buyer.token}` } },
    );
    expect(badLimit.status).toBe(400);
    const forged = await backend.fetch(
      `${BASE_URL}/v1/public/merchants/${merchantId}/storefronts/${STOREFRONT}/catalog/search?q=tea`,
      { headers: { authorization: "Bearer ucbs.forged.token" } },
    );
    expect(forged.status).toBe(401);
  } finally {
    backend.close();
  }
});
