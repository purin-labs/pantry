// A buyer opens the shop after staff save descriptions as written. Product
// descriptions are free text: a drafted one can end with a space or a new
// line, and a product can have none. The buyer catalog must still parse, and
// it shows each description as staff saved it.
import { expect, it } from "vitest";

import {
  Buyer,
  PRODUCT,
  STOREFRONT,
  StaffDesk,
  merchantId,
  required,
  startBackend,
} from "./journey-support.ts";

it("opens the catalog when a description ends with white space or is empty", async () => {
  const backend = await startBackend();
  try {
    await new StaffDesk(backend.admin, "written").createTea();
    const describe = async (description: string, idempotencyKey: string) => {
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
          description,
          idempotencyKey,
        }),
      );
      expect(described.outcome).toBe("applied");
    };
    const buyer = await Buyer.start(backend.buyer, "written_buyer");
    const descriptions = async () =>
      new Set(
        (
          await required(
            backend.buyer.readCatalog(merchantId, STOREFRONT, buyer.token),
          )
        ).listings
          .filter((listing) => listing.productId === PRODUCT)
          .map((listing) => listing.description),
      );

    await describe("Kyoto sencha, picked in May. ", "written_trailing_space");
    expect(await descriptions()).toEqual(
      new Set(["Kyoto sencha, picked in May. "]),
    );
    await describe("Kyoto sencha.\n", "written_new_line");
    expect(await descriptions()).toEqual(new Set(["Kyoto sencha.\n"]));
    await describe("", "written_empty");
    expect(await descriptions()).toEqual(new Set([""]));
  } finally {
    backend.close();
  }
});
