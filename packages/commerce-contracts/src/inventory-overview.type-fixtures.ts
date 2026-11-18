import type { StockRow } from "./inventory-overview";
import type { Variant } from "@seams/type-utils";

declare const supply: Variant<StockRow, "supply">;
declare const product: Variant<StockRow, "product">;

// @ts-expect-error A supply cannot become a product without a product identity.
const missingProduct: StockRow = {
  ...supply,
  kind: "product",
  category: "finished_good",
};
// @ts-expect-error Product rows cannot carry ingredient categories.
const ingredientProduct: StockRow = { ...product, category: "ingredient" };
void missingProduct;
void ingredientProduct;
