// The pâtisserie menu, recipes and supplier pack cost baseline of the demo shop
// at shop.seams.tokyo: 8 financiers, 1 hotcake financier, 5 savoury pies, 3
// fruit pastries and 7 made-to-order drinks.
import {
  CommerceAdminClient,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type PlaceCommerceChannelListingV1,
  type PrepareCommerceCatalogListingV1,
  type ReceiveCommerceInventoryV3,
} from "./admin-client.ts";
import { CommerceStorefrontClient } from "./storefront-client.ts";
import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  SUPPLY_COST_TERMS_LIST_ID,
} from "./entity-plane/index.ts";
import type { CommerceCommandInput } from "./command-input.ts";
import type {
  CreateRecipeRevisionCommand,
  PublishMenuCommand,
} from "./food-service.ts";
import type { CommerceResourcesV1 } from "./commerce-resources.ts";
import type { CommerceMutationResultV1 } from "./mutations.ts";

const MENU_ID = "menu_cafe_main";
const STOREFRONT_ID = "storefront_cafe";
const DAY_MILLISECONDS = 86_400_000;
const QUANTITY_SCALE = 6;

export type PatisserieSection =
  | "financiers"
  | "hotcake"
  | "pies"
  | "pastries"
  | "drinks";

export type PatisserieSupplyCostTier = Readonly<{
  min7dQuantity: number;
  packQuantity: number;
  packPriceMinor: number;
}>;

export type PatisserieSupplyCostTerms = Readonly<{
  currency: "JPY";
  packQuantity: number;
  packUnit: "gram" | "milliliter" | "each";
  packPriceMinor: number;
  bulkTier: PatisserieSupplyCostTier | null;
  notes: string | null;
}>;

export type PatisserieSupplyItem = Readonly<{
  inventoryItemId: string;
  merchantCode: string;
  name: string;
  category: "ingredient" | "packaging";
  unit: "gram" | "milliliter" | "each";
  dailyReceipt: number;
  costTerms: PatisserieSupplyCostTerms;
}>;

export type PatisserieRecipeInput = Readonly<{
  ingredient: PatisserieSupplyItem;
  amount: number;
}>;

export type PatisserieSupply =
  | Readonly<{
      kind: "stocked";
      openingStock: number;
      batchYield: number;
      inputs: readonly PatisserieRecipeInput[];
    }>
  | Readonly<{
      kind: "prepared";
      inputs: readonly PatisserieRecipeInput[];
    }>;

export type PatisserieItem = Readonly<{
  slug: string;
  section: PatisserieSection;
  title: string;
  description: string;
  priceMinor: number;
  supply: PatisserieSupply;
}>;

const SECTIONS: readonly Readonly<{
  id: PatisserieSection;
  name: string;
}>[] = [
  { id: "financiers", name: "Financiers" },
  { id: "hotcake", name: "Hotcake financier" },
  { id: "pies", name: "Pies" },
  { id: "pastries", name: "Pastries" },
  { id: "drinks", name: "Drinks" },
];

const ESPRESSO_BEANS: PatisserieSupplyItem = {
  inventoryItemId: "inventory_espresso_beans",
  merchantCode: "ESPRESSO-BEANS",
  name: "Espresso blend beans",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 3_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 4_200,
    bulkTier: {
      min7dQuantity: 5_000,
      packQuantity: 5_000,
      packPriceMinor: 18_500,
    },
    notes: "Roasted espresso blend",
  },
};

const FILTER_BEANS: PatisserieSupplyItem = {
  inventoryItemId: "inventory_filter_coffee_beans",
  merchantCode: "FILTER-COFFEE-BEANS",
  name: "Single-origin filter beans",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 2_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 5_400,
    bulkTier: {
      min7dQuantity: 4_000,
      packQuantity: 4_000,
      packPriceMinor: 19_200,
    },
    notes: "Light-roast pour-over lot",
  },
};

const WHOLE_MILK: PatisserieSupplyItem = {
  inventoryItemId: "inventory_whole_milk",
  merchantCode: "WHOLE-MILK",
  name: "Whole milk",
  category: "ingredient",
  unit: "milliliter",
  dailyReceipt: 30_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "milliliter",
    packPriceMinor: 310,
    bulkTier: {
      min7dQuantity: 36_000,
      packQuantity: 12_000,
      packPriceMinor: 3_240,
    },
    notes: "Hokkaido 3.7% dairy case",
  },
};

const WATER: PatisserieSupplyItem = {
  inventoryItemId: "inventory_water",
  merchantCode: "WATER",
  name: "Water",
  category: "ingredient",
  unit: "milliliter",
  dailyReceipt: 50_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 10_000,
    packUnit: "milliliter",
    packPriceMinor: 60,
    bulkTier: null,
    notes: "Remineralised brew water",
  },
};

const SUGAR: PatisserieSupplyItem = {
  inventoryItemId: "inventory_sugar",
  merchantCode: "SUGAR",
  name: "Sugar",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 5_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 380,
    bulkTier: {
      min7dQuantity: 20_000,
      packQuantity: 20_000,
      packPriceMinor: 5_800,
    },
    notes: "Hokkaido beet caster sugar",
  },
};

const MATCHA: PatisserieSupplyItem = {
  inventoryItemId: "inventory_matcha_powder",
  merchantCode: "MATCHA-POWDER",
  name: "Ceremonial matcha",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 500,
  costTerms: {
    currency: "JPY",
    packQuantity: 100,
    packUnit: "gram",
    packPriceMinor: 2_800,
    bulkTier: {
      min7dQuantity: 500,
      packQuantity: 500,
      packPriceMinor: 12_200,
    },
    notes: "Uji first-harvest tin",
  },
};

const HOUJICHA: PatisserieSupplyItem = {
  inventoryItemId: "inventory_houjicha_powder",
  merchantCode: "HOUJICHA-POWDER",
  name: "Houjicha powder",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 500,
  costTerms: {
    currency: "JPY",
    packQuantity: 200,
    packUnit: "gram",
    packPriceMinor: 1_900,
    bulkTier: {
      min7dQuantity: 1_000,
      packQuantity: 1_000,
      packPriceMinor: 8_200,
    },
    notes: "Stone-milled roasted green tea",
  },
};

const BLACK_SESAME: PatisserieSupplyItem = {
  inventoryItemId: "inventory_black_sesame",
  merchantCode: "BLACK-SESAME",
  name: "Black sesame",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 1_500,
  costTerms: {
    currency: "JPY",
    packQuantity: 500,
    packUnit: "gram",
    packPriceMinor: 1_350,
    bulkTier: {
      min7dQuantity: 2_500,
      packQuantity: 2_500,
      packPriceMinor: 5_750,
    },
    notes: "Kagoshima roasted black sesame",
  },
};

const GINGER: PatisserieSupplyItem = {
  inventoryItemId: "inventory_ginger",
  merchantCode: "GINGER",
  name: "Fresh ginger",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 1_500,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 1_600,
    bulkTier: {
      min7dQuantity: 5_000,
      packQuantity: 5_000,
      packPriceMinor: 6_800,
    },
    notes: "Kochi fresh ginger root",
  },
};

const CULTURED_BUTTER: PatisserieSupplyItem = {
  inventoryItemId: "inventory_cultured_butter",
  merchantCode: "CULTURED-BUTTER",
  name: "Cultured unsalted butter",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 8_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 450,
    packUnit: "gram",
    packPriceMinor: 1_080,
    bulkTier: {
      min7dQuantity: 9_000,
      packQuantity: 10_000,
      packPriceMinor: 20_800,
    },
    notes: "Cultured patisserie butter",
  },
};

const EGG_WHITE: PatisserieSupplyItem = {
  inventoryItemId: "inventory_egg_white",
  merchantCode: "EGG-WHITE",
  name: "Pasteurised egg whites",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 6_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 780,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 6_900,
    },
    notes: "Chilled bakery carton",
  },
};

const WHOLE_EGG: PatisserieSupplyItem = {
  inventoryItemId: "inventory_whole_egg",
  merchantCode: "WHOLE-EGG",
  name: "Farm whole eggs",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 4_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 640,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 5_600,
    },
    notes: "Liquid whole egg & glaze",
  },
};

const ALMOND_FLOUR: PatisserieSupplyItem = {
  inventoryItemId: "inventory_almond_flour",
  merchantCode: "ALMOND-FLOUR",
  name: "Valencia almond flour",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 5_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 2_400,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 20_500,
    },
    notes: "Extra-fine blanched almond powder",
  },
};

const HAZELNUT_FLOUR: PatisserieSupplyItem = {
  inventoryItemId: "inventory_hazelnut_flour",
  merchantCode: "HAZELNUT-FLOUR",
  name: "Roasted hazelnut flour & nibs",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 2_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 3_100,
    bulkTier: {
      min7dQuantity: 5_000,
      packQuantity: 5_000,
      packPriceMinor: 13_800,
    },
    notes: "Piedmont roasted hazelnut meal",
  },
};

const PASTRY_FLOUR: PatisserieSupplyItem = {
  inventoryItemId: "inventory_pastry_flour",
  merchantCode: "PASTRY-FLOUR",
  name: "French T55 pastry flour",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 10_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 2_500,
    packUnit: "gram",
    packPriceMinor: 950,
    bulkTier: {
      min7dQuantity: 25_000,
      packQuantity: 25_000,
      packPriceMinor: 7_800,
    },
    notes: "Stone-milled T55 flour sack",
  },
};

const HONEY_MAPLE: PatisserieSupplyItem = {
  inventoryItemId: "inventory_honey_maple",
  merchantCode: "HONEY-MAPLE",
  name: "Acacia honey & amber maple",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 2_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "gram",
    packPriceMinor: 2_600,
    bulkTier: {
      min7dQuantity: 4_000,
      packQuantity: 4_000,
      packPriceMinor: 9_200,
    },
    notes: "Quebec amber maple & acacia honey",
  },
};

const CANDIED_CITRUS: PatisserieSupplyItem = {
  inventoryItemId: "inventory_candied_citrus",
  merchantCode: "CANDIED-CITRUS",
  name: "Candied yuzu & orange peel",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 1_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 500,
    packUnit: "gram",
    packPriceMinor: 1_750,
    bulkTier: null,
    notes: "Diced candied citrus peel",
  },
};

const ORCHARD_FRUIT: PatisserieSupplyItem = {
  inventoryItemId: "inventory_orchard_fruit",
  merchantCode: "ORCHARD-FRUIT",
  name: "Seasonal orchard fruit",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 6_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 2_000,
    packUnit: "gram",
    packPriceMinor: 1_680,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 7_200,
    },
    notes: "Aomori apple, pear & nectarine",
  },
};

const CHUCK_BEEF: PatisserieSupplyItem = {
  inventoryItemId: "inventory_chuck_beef",
  merchantCode: "CHUCK-BEEF",
  name: "Domestic chuck & shin beef",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 8_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 2_000,
    packUnit: "gram",
    packPriceMinor: 5_600,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 24_800,
    },
    notes: "Diced braising beef",
  },
};

const CHICKEN_THIGH: PatisserieSupplyItem = {
  inventoryItemId: "inventory_chicken_thigh",
  merchantCode: "CHICKEN-THIGH",
  name: "Free-range chicken thigh",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 5_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 2_000,
    packUnit: "gram",
    packPriceMinor: 2_760,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 12_200,
    },
    notes: "Trimmed chicken thigh",
  },
};

const MIREPOIX_STOCK: PatisserieSupplyItem = {
  inventoryItemId: "inventory_mirepoix_stock",
  merchantCode: "MIREPOIX-STOCK",
  name: "Mirepoix, herbs, wine & stock",
  category: "ingredient",
  unit: "gram",
  dailyReceipt: 8_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 2_000,
    packUnit: "gram",
    packPriceMinor: 1_320,
    bulkTier: {
      min7dQuantity: 10_000,
      packQuantity: 10_000,
      packPriceMinor: 5_600,
    },
    notes: "Aromatics, red wine & veal jus",
  },
};

const HEAVY_CREAM: PatisserieSupplyItem = {
  inventoryItemId: "inventory_heavy_cream",
  merchantCode: "HEAVY-CREAM",
  name: "42% heavy cream",
  category: "ingredient",
  unit: "milliliter",
  dailyReceipt: 4_000,
  costTerms: {
    currency: "JPY",
    packQuantity: 1_000,
    packUnit: "milliliter",
    packPriceMinor: 920,
    bulkTier: {
      min7dQuantity: 12_000,
      packQuantity: 12_000,
      packPriceMinor: 9_840,
    },
    notes: "Chilled dairy cream",
  },
};

const FINANCIER_BAG: PatisserieSupplyItem = {
  inventoryItemId: "inventory_financier_bag",
  merchantCode: "FINANCIER-BAG",
  name: "Glassine financier bag & seal",
  category: "packaging",
  unit: "each",
  dailyReceipt: 400,
  costTerms: {
    currency: "JPY",
    packQuantity: 500,
    packUnit: "each",
    packPriceMinor: 6_000,
    bulkTier: {
      min7dQuantity: 1_000,
      packQuantity: 2_000,
      packPriceMinor: 19_000,
    },
    notes: "Individual financier sleeve & sticker",
  },
};

const HOTCAKE_BOX: PatisserieSupplyItem = {
  inventoryItemId: "inventory_hotcake_box",
  merchantCode: "HOTCAKE-BOX",
  name: "Rigid hotcake gift box",
  category: "packaging",
  unit: "each",
  dailyReceipt: 100,
  costTerms: {
    currency: "JPY",
    packQuantity: 100,
    packUnit: "each",
    packPriceMinor: 4_800,
    bulkTier: {
      min7dQuantity: 200,
      packQuantity: 300,
      packPriceMinor: 12_000,
    },
    notes: "Stamped hotcake financier box",
  },
};

const PIE_BOX: PatisserieSupplyItem = {
  inventoryItemId: "inventory_pie_box",
  merchantCode: "PIE-BOX",
  name: "Vented kraft pie box & liner",
  category: "packaging",
  unit: "each",
  dailyReceipt: 150,
  costTerms: {
    currency: "JPY",
    packQuantity: 100,
    packUnit: "each",
    packPriceMinor: 4_200,
    bulkTier: {
      min7dQuantity: 300,
      packQuantity: 500,
      packPriceMinor: 17_500,
    },
    notes: "12 cm vented pie box",
  },
};

const PASTRY_BOX: PatisserieSupplyItem = {
  inventoryItemId: "inventory_pastry_box",
  merchantCode: "PASTRY-BOX",
  name: "Windowed pastry box & board",
  category: "packaging",
  unit: "each",
  dailyReceipt: 150,
  costTerms: {
    currency: "JPY",
    packQuantity: 100,
    packUnit: "each",
    packPriceMinor: 3_000,
    bulkTier: {
      min7dQuantity: 200,
      packQuantity: 400,
      packPriceMinor: 9_600,
    },
    notes: "Fruit pastry gold board & box",
  },
};

const CUP_SLEEVE: PatisserieSupplyItem = {
  inventoryItemId: "inventory_cup_sleeve",
  merchantCode: "CUP-SLEEVE",
  name: "Double-wall cup, lid & sleeve",
  category: "packaging",
  unit: "each",
  dailyReceipt: 300,
  costTerms: {
    currency: "JPY",
    packQuantity: 500,
    packUnit: "each",
    packPriceMinor: 11_000,
    bulkTier: {
      min7dQuantity: 1_000,
      packQuantity: 2_000,
      packPriceMinor: 36_000,
    },
    notes: "8 oz / 12 oz bar cup & lid set",
  },
};

function recipeInputs(
  entries: readonly (readonly [PatisserieSupplyItem, number])[],
): readonly PatisserieRecipeInput[] {
  return entries.map(([ingredient, amount]) => ({ ingredient, amount }));
}

function financier(
  slug: string,
  title: string,
  flavour: string,
  priceMinor: number,
  inputs: readonly (readonly [PatisserieSupplyItem, number])[],
): PatisserieItem {
  return {
    slug: `financier_${slug}`,
    section: "financiers",
    title,
    description: `Brown butter and almond financier with ${flavour}.`,
    priceMinor,
    supply: {
      kind: "stocked",
      openingStock: 24,
      batchYield: 24,
      inputs: recipeInputs([...inputs, [FINANCIER_BAG, 24]]),
    },
  };
}

function pie(
  slug: string,
  title: string,
  filling: string,
  priceMinor: number,
  inputs: readonly (readonly [PatisserieSupplyItem, number])[],
): PatisserieItem {
  return {
    slug: `pie_${slug}`,
    section: "pies",
    title,
    description: `A 12 cm pie of about 450 g: puff pastry lid, shortcrust base, ${filling}.`,
    priceMinor,
    supply: {
      kind: "stocked",
      openingStock: 12,
      batchYield: 12,
      inputs: recipeInputs([...inputs, [PIE_BOX, 12]]),
    },
  };
}

function pastry(
  slug: string,
  title: string,
  fruit: string,
  priceMinor: number,
  inputs: readonly (readonly [PatisserieSupplyItem, number])[],
): PatisserieItem {
  return {
    slug: `pastry_${slug}`,
    section: "pastries",
    title,
    description: `Puff pastry with ${fruit}.`,
    priceMinor,
    supply: {
      kind: "stocked",
      openingStock: 12,
      batchYield: 12,
      inputs: recipeInputs([...inputs, [PASTRY_BOX, 12]]),
    },
  };
}

function drink(
  slug: string,
  title: string,
  description: string,
  priceMinor: number,
  inputs: readonly (readonly [PatisserieSupplyItem, number])[],
): PatisserieItem {
  return {
    slug: `drink_${slug}`,
    section: "drinks",
    title,
    description,
    priceMinor,
    supply: {
      kind: "prepared",
      inputs: recipeInputs([...inputs, [CUP_SLEEVE, 1]]),
    },
  };
}

export const PATISSERIE_ITEMS: readonly PatisserieItem[] = [
  financier(
    "black_sesame",
    "Black sesame financier",
    "toasted black sesame",
    330,
    [
      [CULTURED_BUTTER, 500],
      [EGG_WHITE, 560],
      [SUGAR, 450],
      [ALMOND_FLOUR, 220],
      [PASTRY_FLOUR, 140],
      [HONEY_MAPLE, 60],
      [BLACK_SESAME, 110],
    ],
  ),
  financier("hazelnut", "Hazelnut financier", "roasted hazelnut", 350, [
    [CULTURED_BUTTER, 500],
    [EGG_WHITE, 560],
    [SUGAR, 450],
    [ALMOND_FLOUR, 120],
    [HAZELNUT_FLOUR, 160],
    [PASTRY_FLOUR, 140],
    [HONEY_MAPLE, 60],
  ]),
  financier("maple", "Maple financier", "a maple glaze", 320, [
    [CULTURED_BUTTER, 500],
    [EGG_WHITE, 560],
    [SUGAR, 380],
    [ALMOND_FLOUR, 240],
    [PASTRY_FLOUR, 140],
    [HONEY_MAPLE, 180],
  ]),
  financier("matcha", "Matcha financier", "matcha", 350, [
    [CULTURED_BUTTER, 500],
    [EGG_WHITE, 560],
    [SUGAR, 460],
    [ALMOND_FLOUR, 230],
    [PASTRY_FLOUR, 130],
    [HONEY_MAPLE, 60],
    [MATCHA, 36],
  ]),
  financier(
    "ginger_citrus",
    "Ginger citrus financier",
    "fresh ginger and candied citrus peel",
    330,
    [
      [CULTURED_BUTTER, 500],
      [EGG_WHITE, 560],
      [SUGAR, 440],
      [ALMOND_FLOUR, 230],
      [PASTRY_FLOUR, 140],
      [GINGER, 80],
      [CANDIED_CITRUS, 90],
    ],
  ),
  financier(
    "apple_cinnamon",
    "Apple cinnamon financier",
    "apple and cinnamon",
    350,
    [
      [CULTURED_BUTTER, 500],
      [EGG_WHITE, 560],
      [SUGAR, 430],
      [ALMOND_FLOUR, 220],
      [PASTRY_FLOUR, 140],
      [ORCHARD_FRUIT, 360],
      [HONEY_MAPLE, 60],
    ],
  ),
  financier("coffee", "Coffee financier", "espresso", 330, [
    [CULTURED_BUTTER, 500],
    [EGG_WHITE, 560],
    [SUGAR, 450],
    [ALMOND_FLOUR, 230],
    [PASTRY_FLOUR, 140],
    [ESPRESSO_BEANS, 65],
    [HONEY_MAPLE, 50],
  ]),
  financier("houjicha", "Houjicha financier", "roasted houjicha tea", 330, [
    [CULTURED_BUTTER, 500],
    [EGG_WHITE, 560],
    [SUGAR, 450],
    [ALMOND_FLOUR, 230],
    [PASTRY_FLOUR, 130],
    [HOUJICHA, 48],
    [HONEY_MAPLE, 60],
  ]),
  {
    slug: "hotcake_financier",
    section: "hotcake",
    title: "Hotcake financier",
    description:
      "Our financier, baked the size of a hotcake. Brown butter and almond, crisp at the edge and soft in the middle.",
    priceMinor: 1_200,
    supply: {
      kind: "stocked",
      openingStock: 6,
      batchYield: 6,
      inputs: recipeInputs([
        [CULTURED_BUTTER, 540],
        [EGG_WHITE, 600],
        [WHOLE_EGG, 120],
        [SUGAR, 460],
        [ALMOND_FLOUR, 280],
        [PASTRY_FLOUR, 180],
        [HONEY_MAPLE, 120],
        [HOTCAKE_BOX, 6],
      ]),
    },
  },
  pie(
    "steak_pepper",
    "Steak and pepper pie",
    "beef, cracked black pepper and gravy",
    1_600,
    [
      [CHUCK_BEEF, 1_850],
      [PASTRY_FLOUR, 1_380],
      [CULTURED_BUTTER, 880],
      [MIREPOIX_STOCK, 960],
      [WHOLE_EGG, 180],
    ],
  ),
  pie(
    "beef_carotte",
    "Beef and carotte pie",
    "beef, carrot and thyme",
    1_500,
    [
      [CHUCK_BEEF, 1_650],
      [PASTRY_FLOUR, 1_380],
      [CULTURED_BUTTER, 880],
      [MIREPOIX_STOCK, 1_250],
      [WHOLE_EGG, 180],
    ],
  ),
  pie(
    "beef_bourguignon",
    "Beef bourguignon pie",
    "beef, red wine, mushroom and pearl onion",
    1_600,
    [
      [CHUCK_BEEF, 1_750],
      [PASTRY_FLOUR, 1_380],
      [CULTURED_BUTTER, 880],
      [MIREPOIX_STOCK, 1_350],
      [WHOLE_EGG, 180],
    ],
  ),
  pie(
    "curry_chicken",
    "Curry chicken pie",
    "chicken, curry and potato",
    1_400,
    [
      [CHICKEN_THIGH, 1_750],
      [PASTRY_FLOUR, 1_380],
      [CULTURED_BUTTER, 880],
      [MIREPOIX_STOCK, 1_150],
      [HEAVY_CREAM, 180],
      [WHOLE_EGG, 180],
    ],
  ),
  pie(
    "chicken_vegetables",
    "Chicken and vegetables pie",
    "chicken, leek, carrot and cream",
    1_400,
    [
      [CHICKEN_THIGH, 1_650],
      [PASTRY_FLOUR, 1_380],
      [CULTURED_BUTTER, 880],
      [MIREPOIX_STOCK, 1_100],
      [HEAVY_CREAM, 360],
      [WHOLE_EGG, 180],
    ],
  ),
  pastry("apple", "Apple pastry", "apple and vanilla", 680, [
    [PASTRY_FLOUR, 780],
    [CULTURED_BUTTER, 620],
    [ORCHARD_FRUIT, 1_400],
    [SUGAR, 240],
    [WHOLE_EGG, 120],
    [HONEY_MAPLE, 80],
  ]),
  pastry("pear", "Pear pastry", "pear and almond cream", 750, [
    [PASTRY_FLOUR, 780],
    [CULTURED_BUTTER, 680],
    [ORCHARD_FRUIT, 1_350],
    [ALMOND_FLOUR, 220],
    [SUGAR, 260],
    [WHOLE_EGG, 120],
  ]),
  pastry(
    "nectarine",
    "Nectarine pastry",
    "nectarine and apricot glaze",
    780,
    [
      [PASTRY_FLOUR, 780],
      [CULTURED_BUTTER, 640],
      [ORCHARD_FRUIT, 1_450],
      [ALMOND_FLOUR, 180],
      [SUGAR, 240],
      [HONEY_MAPLE, 110],
      [WHOLE_EGG, 140],
    ],
  ),
  drink(
    "pour_over",
    "Pour-over coffee",
    "Single-origin coffee, brewed by hand through a paper filter.",
    680,
    [
      [FILTER_BEANS, 27],
      [WATER, 350],
    ],
  ),
  drink("espresso", "Espresso", "A double shot of our espresso blend.", 450, [
    [ESPRESSO_BEANS, 18],
    [WATER, 36],
  ]),
  drink(
    "caffe_latte",
    "Caffè latte",
    "A double espresso with steamed whole milk.",
    600,
    [
      [ESPRESSO_BEANS, 18],
      [WATER, 36],
      [WHOLE_MILK, 200],
    ],
  ),
  drink(
    "matcha_latte",
    "Matcha latte",
    "Ceremonial matcha, whisked and topped with steamed milk.",
    680,
    [
      [MATCHA, 4],
      [WATER, 60],
      [WHOLE_MILK, 200],
    ],
  ),
  drink(
    "houjicha_latte",
    "Houjicha latte",
    "Roasted green tea with steamed milk.",
    650,
    [
      [HOUJICHA, 5],
      [WATER, 60],
      [WHOLE_MILK, 200],
    ],
  ),
  drink(
    "black_sesame_latte",
    "Black sesame latte",
    "Toasted black sesame, ground and warmed with milk.",
    680,
    [
      [BLACK_SESAME, 22],
      [SUGAR, 12],
      [WATER, 40],
      [WHOLE_MILK, 210],
    ],
  ),
  drink(
    "ginger_latte",
    "Ginger latte",
    "Fresh ginger, simmered and stirred into steamed milk.",
    620,
    [
      [GINGER, 10],
      [SUGAR, 12],
      [WATER, 40],
      [WHOLE_MILK, 210],
    ],
  ),
];

export const PATISSERIE_SUPPLIES: readonly PatisserieSupplyItem[] = [
  ...new Map(
    PATISSERIE_ITEMS.flatMap((item) =>
      item.supply.inputs.map(
        (input) => [input.ingredient.inventoryItemId, input.ingredient] as const,
      ),
    ),
  ).values(),
];

export const patisserieVariantId = (item: PatisserieItem): string =>
  `variant_patisserie_${item.slug}`;
const productId = (item: PatisserieItem) => `product_patisserie_${item.slug}`;
const offerId = (item: PatisserieItem) => `offer_patisserie_${item.slug}_cafe`;
const inventoryItemId = (item: PatisserieItem) =>
  `inventory_patisserie_${item.slug}`;
const positionId = (item: PatisserieItem) =>
  `position_patisserie_${item.slug}_cafe`;
const consumptionPlanId = (item: PatisserieItem) =>
  `consumption_plan_patisserie_${item.slug}`;
export const patisserieRecipeId = (item: PatisserieItem): string =>
  `recipe_patisserie_${item.slug}`;
const sku = (item: PatisserieItem) =>
  item.slug.toUpperCase().replaceAll("_", "-");

type Snapshot = Readonly<{
  merchantRevision: number;
  inventoryItems: ReadonlyMap<string, number>;
  inventoryPositions: readonly Readonly<{
    id: string;
    revision: number;
    inventoryItemId: string;
    locationId: string;
  }>[];
  lotIds: ReadonlySet<string>;
  offers: ReadonlyMap<string, number>;
  salesChannels: CommerceResourcesV1["salesChannels"];
}>;

type CafeMenu = Readonly<{
  revision: number;
  salesChannelId: string;
  locationId: string;
  recipeIds: ReadonlySet<string>;
  menu: PublishMenuCommand["menu"];
}>;

export type PatisserieEntityPlaneContext = Readonly<{
  client: CommerceEntityPlaneClient;
  organisationId: string;
  principalId?: string;
}>;

export type PatisserieMenuSetupResult = Readonly<{
  ok: true;
  merchantId: string;
  merchantRevision: number;
  menuRevision: number;
  items: number;
  recipes: number;
  supplyCostsSeeded: number;
}>;

export async function configurePatisserieMenu(
  client: CommerceAdminClient,
  merchantId: string,
  now: Date,
  stockDays: number,
  options?: Readonly<{ entityPlane?: PatisserieEntityPlaneContext }>,
): Promise<PatisserieMenuSetupResult> {
  const cafe = await readCafeMenu(client, merchantId);
  let snapshot = await readSnapshot(client, merchantId);
  let revision = snapshot.merchantRevision;
  const requestedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + stockDays * DAY_MILLISECONDS,
  ).toISOString();
  const run = `patisserie_menu_v1:${now.toISOString().slice(0, 10)}`;
  const batch = { run, requestedAt, expiresAt };

  for (const supply of PATISSERIE_SUPPLIES) {
    revision = await stockSupplyItem(
      client,
      merchantId,
      revision,
      snapshot,
      cafe.locationId,
      supply,
      batch,
    );
  }

  for (const item of PATISSERIE_ITEMS) {
    if (item.supply.kind === "prepared") {
      if (!cafe.recipeIds.has(patisserieRecipeId(item))) {
        revision = await apply(
          client.createRecipeRevision(
            preparedRecipe(merchantId, revision, item, item.supply.inputs),
          ),
          `${item.slug} recipe`,
          revision,
        );
      }
    } else {
      if (!snapshot.inventoryItems.has(inventoryItemId(item))) {
        revision = await apply(
          client.createInventoryItem(inventoryItem(merchantId, revision, item)),
          `${item.slug} inventory item`,
          revision,
        );
      }
      if (!cafe.recipeIds.has(patisserieRecipeId(item))) {
        revision = await apply(
          client.createRecipeRevision(
            stockedRecipe(
              merchantId,
              revision,
              item,
              item.supply.batchYield,
              item.supply.inputs,
            ),
          ),
          `${item.slug} stocked recipe`,
          revision,
        );
      }
    }
    if (
      item.supply.kind === "stocked" &&
      !snapshot.inventoryPositions.some(
        (position) => position.id === positionId(item),
      )
    ) {
      revision = await apply(
        client.openInventoryPosition(
          inventoryPosition(merchantId, revision, item, cafe.locationId),
        ),
        `${item.slug} inventory position`,
        revision,
      );
      revision = await apply(
        client.receiveInventory(
          openingStock(
            merchantId,
            revision,
            item,
            item.supply.openingStock,
            cafe.locationId,
            batch,
          ),
        ),
        `${item.slug} opening stock`,
        revision,
      );
    }
    if (snapshot.offers.has(offerId(item))) continue;
    if (item.supply.kind === "stocked") {
      revision = await apply(
        client.placeChannelListing(
          channelListing(merchantId, revision, item, cafe, requestedAt),
        ),
        `${item.slug} listing`,
        revision,
      );
      continue;
    }
    const salesChannel = snapshot.salesChannels.find(
      (channel) => channel.id === cafe.salesChannelId,
    );
    if (salesChannel === undefined) {
      throw new Error(`The merchant has no ${cafe.salesChannelId}`);
    }
    revision = await apply(
      client.prepareCatalogListing(
        preparedListing(merchantId, revision, item, cafe, salesChannel, {
          occurredAt: requestedAt,
        }),
      ),
      `${item.slug} prepared listing`,
      revision,
    );
    revision = await apply(
      client.publishCatalogListing({
        merchantId,
        idempotencyKey: `patisserie_menu_v1:publish_listing:${item.slug}`,
        productId: productId(item),
        productRevision: 1,
        variantId: patisserieVariantId(item),
        variantRevision: 1,
        offerId: offerId(item),
        offerRevision: 1,
        salesChannelId: salesChannel.id,
        salesChannelRevision: salesChannel.revision,
      }),
      `${item.slug} listing`,
      revision,
    );
  }

  snapshot = await readSnapshot(client, merchantId);
  const published = await client.publishMenu(
    patisserieMenu(merchantId, revision, cafe, snapshot.offers, run),
  );
  revision = await apply(Promise.resolve(published), "café menu", revision);

  let supplyCostsSeeded = 0;
  if (options?.entityPlane !== undefined) {
    const seeded = await seedPatisserieSupplyCosts({
      client: options.entityPlane.client,
      organisationId: options.entityPlane.organisationId,
      merchantId,
      principalId:
        options.entityPlane.principalId ?? "patisserie_setup_operator",
      now,
    });
    revision = seeded.merchantRevision;
    supplyCostsSeeded = seeded.seeded;
  }

  snapshot = await readSnapshot(client, merchantId);
  const after = await readCafeMenu(client, merchantId);
  if (
    snapshot.merchantRevision !== revision ||
    after.menu.entries.length !== PATISSERIE_ITEMS.length
  ) {
    throw new Error("The pâtisserie menu did not read back as published");
  }
  return {
    ok: true,
    merchantId,
    merchantRevision: revision,
    menuRevision: after.revision,
    items: PATISSERIE_ITEMS.length,
    recipes: after.recipeIds.size,
    supplyCostsSeeded,
  };
}

export async function seedPatisserieSupplyCosts(
  input: Readonly<{
    client: CommerceEntityPlaneClient;
    organisationId: string;
    merchantId: string;
    principalId: string;
    now: Date;
  }>,
): Promise<Readonly<{ merchantRevision: number; seeded: number }>> {
  const published = await input.client.publishPurchasingPreset({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!published.ok) {
    throw new Error(
      `purchasing preset failed: ${published.error.kind}: ${published.error.message}`,
    );
  }
  const metadata = await input.client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated") {
    throw new Error("supply cost metadata unavailable");
  }
  const list = metadata.value.lists.find(
    (candidate) => String(candidate.listId) === SUPPLY_COST_TERMS_LIST_ID,
  );
  if (list === undefined) {
    throw new Error("supply_cost_terms list is not published");
  }
  const query = parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: list.listId,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 500, cursor: null },
  });
  const existingPage = await input.client.query(input.merchantId, query);
  if (!existingPage.ok) {
    throw new Error(
      `supply cost query failed: ${existingPage.error.kind}: ${existingPage.error.message}`,
    );
  }
  const existingItemIds = new Set(
    existingPage.value.listEntries.map((entry) =>
      String(entry.entityRef.entityId),
    ),
  );
  let merchantRevision = Number(metadata.value.merchantRevision);
  const expiresAt = new Date(input.now.getTime() + 5 * 60_000).toISOString();
  let seeded = 0;

  for (const supply of PATISSERIE_SUPPLIES) {
    if (existingItemIds.has(supply.inventoryItemId)) continue;
    const commandId = `patisserie_cost_v1:${supply.inventoryItemId}`;
    const entryId = `supply_cost:${supply.inventoryItemId}`;
    const entityRef = {
      origin: "system",
      typeId: "inventory_item",
      entityId: supply.inventoryItemId,
    };
    const request = parseEntityPlaneCommand({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision: parseCommerceSnapshotRevision(merchantRevision),
      commandId,
      authority: {
        kind: "commerce_list_entry_create",
        context: {
          organisationId: input.organisationId,
          merchantId: input.merchantId,
          principalId: input.principalId,
          sensitivityCeiling: "restricted",
          expiresAt,
          causation: { kind: "command", commandId },
        },
        scope: { kind: "commerce_list", listId: SUPPLY_COST_TERMS_LIST_ID },
        target: {
          entry: { entryId, listId: SUPPLY_COST_TERMS_LIST_ID, revision: 1 },
          listRevision: Number(list.publishedRevision),
          entityTypeId: { origin: "system", typeId: "inventory_item" },
          entityRef,
        },
      },
      command: {
        kind: "add_commerce_list_entry",
        command: {
          entryId,
          listId: SUPPLY_COST_TERMS_LIST_ID,
          expectedListRevision: Number(list.publishedRevision),
          entityRef,
          attributeValues: supplyCostAttributeValues(supply.costTerms),
          revision: 1,
        },
      },
    });
    const result = await input.client.command(request);
    if (!result.ok) {
      throw new Error(
        `supply cost command failed: ${result.error.kind}: ${result.error.message}`,
      );
    }
    if (result.value.status === "rejected") {
      throw new Error(
        `supply cost command rejected for ${supply.inventoryItemId}: ${result.value.error.code}`,
      );
    }
    merchantRevision = Number(result.value.receipt.merchantRevision);
    seeded += 1;
  }
  return { merchantRevision, seeded };
}

/**
 * Makes the café storefront's listed prices include its tax. Admin reads do
 * not show a storefront, so its revision comes from a new buyer session.
 */
export async function includeStorefrontTax(
  client: CommerceAdminClient,
  buyer: CommerceStorefrontClient,
  merchantId: string,
  basisPoints: number,
): Promise<Readonly<{ storefrontRevision: number; basisPoints: number }>> {
  const session = await buyer.createSession(merchantId, STOREFRONT_ID, {
    schemaVersion: "underclerk.create-buyer-session.v1",
    buyer: { kind: "guest" },
  });
  if (!session.ok) throw clientFailure("buyer session", session);
  const revision = session.value.storefrontRevision;
  const result = await client.updateStorefrontTax({
    merchantId,
    idempotencyKey: `patisserie_menu_v1:included_tax:${basisPoints}:${revision}`,
    storefrontId: STOREFRONT_ID,
    expectedStorefrontRevision: revision,
    tax: { kind: "percentage", basisPoints, inclusion: "included" },
  });
  if (!result.ok) throw clientFailure("storefront tax", result);
  if (result.value.outcome === "rejected") {
    throw new Error(
      `storefront tax was rejected: ${JSON.stringify(result.value.error)}`,
    );
  }
  return { storefrontRevision: revision + 1, basisPoints };
}

function supplyCostAttributeValues(
  terms: PatisserieSupplyCostTerms,
): readonly Readonly<Record<string, unknown>>[] {
  const scope = {
    kind: "system",
    entityTypeId: "inventory_item",
    schemaRevision: 1,
  };
  const values: Readonly<Record<string, unknown>>[] = [
    supplyCostAttribute(scope, "currency", {
      kind: "short_text",
      value: terms.currency,
    }),
    supplyCostAttribute(scope, "pack_quantity", {
      kind: "decimal",
      value: scaledDecimal(terms.packQuantity),
    }),
    supplyCostAttribute(scope, "pack_unit", {
      kind: "short_text",
      value: terms.packUnit,
    }),
    supplyCostAttribute(scope, "pack_price_minor", {
      kind: "integer",
      value: BigInt(terms.packPriceMinor),
    }),
  ];
  if (terms.bulkTier !== null) {
    values.push(
      supplyCostAttribute(scope, "bulk_min_7d_quantity", {
        kind: "decimal",
        value: scaledDecimal(terms.bulkTier.min7dQuantity),
      }),
      supplyCostAttribute(scope, "bulk_pack_quantity", {
        kind: "decimal",
        value: scaledDecimal(terms.bulkTier.packQuantity),
      }),
      supplyCostAttribute(scope, "bulk_pack_price_minor", {
        kind: "integer",
        value: BigInt(terms.bulkTier.packPriceMinor),
      }),
    );
  }
  if (terms.notes !== null) {
    values.push(
      supplyCostAttribute(scope, "notes", {
        kind: "long_text",
        value: terms.notes,
      }),
    );
  }
  return values;
}

function supplyCostAttribute(
  scope: Readonly<Record<string, unknown>>,
  attributeId: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    attributeId,
    scope,
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  };
}

function scaledDecimal(
  quantity: number,
): Readonly<{ unscaled: number; scale: number }> {
  return {
    unscaled: Math.round(quantity * 10 ** QUANTITY_SCALE),
    scale: QUANTITY_SCALE,
  };
}

async function readSnapshot(
  client: CommerceAdminClient,
  merchantId: string,
): Promise<Snapshot> {
  const result = await client.readStockSnapshot(merchantId);
  if (!result.ok) throw clientFailure("snapshot read", result);
  const resources = result.value.commerce.resources;
  return {
    merchantRevision: result.value.commerce.merchantRevision,
    inventoryItems: new Map(
      resources.inventoryItems.map((item) => [item.id, item.revision]),
    ),
    inventoryPositions: resources.inventoryPositions,
    lotIds: new Set(result.value.lots.map((lot) => lot.id)),
    offers: new Map(
      resources.offers.map((offer) => [offer.id, offer.revision]),
    ),
    salesChannels: resources.salesChannels,
  };
}

async function stockSupplyItem(
  client: CommerceAdminClient,
  merchantId: string,
  startRevision: number,
  snapshot: Snapshot,
  locationId: string,
  supply: PatisserieSupplyItem,
  batch: Readonly<{ run: string; requestedAt: string; expiresAt: string }>,
): Promise<number> {
  let revision = startRevision;
  const code = supply.merchantCode.toLowerCase().replaceAll("-", "_");
  let itemRevision = snapshot.inventoryItems.get(supply.inventoryItemId);
  if (itemRevision === undefined) {
    revision = await apply(
      client.createInventoryItem({
        merchantId,
        expectedMerchantRevision: revision,
        idempotencyKey: `patisserie_menu_v1:ingredient:${code}`,
        inventoryItemId: supply.inventoryItemId,
        merchantCode: supply.merchantCode,
        name: supply.name,
        baseUnit: supply.unit,
        category: supply.category,
        tracking: {
          kind: "lot_tracked",
          expiry: supply.category === "packaging" ? "optional" : "required",
        },
      }),
      `${code} supply item`,
      revision,
    );
    itemRevision = 1;
  }
  let position = snapshot.inventoryPositions.find(
    (candidate) =>
      candidate.inventoryItemId === supply.inventoryItemId &&
      candidate.locationId === locationId,
  );
  if (position === undefined) {
    const id = `position_patisserie_${code}_cafe`;
    revision = await apply(
      client.openInventoryPosition({
        merchantId,
        expectedMerchantRevision: revision,
        idempotencyKey: `patisserie_menu_v1:ingredient_position:${code}`,
        inventoryPositionId: id,
        inventoryItemId: supply.inventoryItemId,
        inventoryItemRevision: itemRevision,
        locationId,
        locationRevision: 1,
      }),
      `${code} position`,
      revision,
    );
    position = {
      id,
      revision: 1,
      inventoryItemId: supply.inventoryItemId,
      locationId,
    };
  }
  const day = batch.requestedAt.slice(0, 10);
  const lotId = `lot_patisserie_${code}_${day.replaceAll("-", "")}`;
  if (snapshot.lotIds.has(lotId)) return revision;
  return apply(
    client.receiveInventory({
      purchase: { kind: "unlinked" },
      merchantId,
      expectedMerchantRevision: revision,
      idempotencyKey: `${batch.run}:ingredient_stock:${code}`,
      receiptId: `receipt_patisserie_ingredients_${day.replaceAll("-", "")}`,
      receiptLineId: `receipt_line_patisserie_${code}_${day.replaceAll("-", "")}`,
      inventoryItemId: supply.inventoryItemId,
      inventoryItemRevision: itemRevision,
      inventoryPositionId: position.id,
      inventoryPositionRevision: position.revision,
      locationId,
      receivedQuantity: {
        amount: supply.dailyReceipt,
        scale: 0,
        unit: supply.unit,
      },
      lot: {
        kind: "tracked",
        lotId,
        lotCode: `${supply.merchantCode}-${day.replaceAll("-", "")}`,
        expiry:
          supply.category === "packaging"
            ? { kind: "not_tracked" }
            : { kind: "expires", expiresAt: batch.expiresAt },
      },
      receivedAt: batch.requestedAt,
    }),
    `${code} stock`,
    revision,
  );
}

function preparedRecipe(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  inputs: readonly PatisserieRecipeInput[],
): CommerceCommandInput<CreateRecipeRevisionCommand> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:recipe:${item.slug}`,
    recipeRevision: {
      recipeId: patisserieRecipeId(item),
      name: item.title,
      inputs: inputs.map((input) => ({
        inventoryItemId: input.ingredient.inventoryItemId,
        quantity: {
          amount: input.amount,
          scale: 0,
          unit: input.ingredient.unit,
        },
      })),
      output: { kind: "immediate" },
    },
  };
}

function stockedRecipe(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  batchYield: number,
  inputs: readonly PatisserieRecipeInput[],
): CommerceCommandInput<CreateRecipeRevisionCommand> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:recipe:${item.slug}`,
    recipeRevision: {
      recipeId: patisserieRecipeId(item),
      name: item.title,
      inputs: inputs.map((input) => ({
        inventoryItemId: input.ingredient.inventoryItemId,
        quantity: {
          amount: input.amount,
          scale: 0,
          unit: input.ingredient.unit,
        },
      })),
      output: {
        kind: "stocked",
        inventoryItemId: inventoryItemId(item),
        yieldQuantity: { amount: batchYield, scale: 0, unit: "each" },
      },
    },
  };
}

async function readCafeMenu(
  client: CommerceAdminClient,
  merchantId: string,
): Promise<CafeMenu> {
  const result = await client.readFoodServiceSnapshot(merchantId);
  if (!result.ok) throw clientFailure("food-service read", result);
  const menu = result.value.resources.menus.find(
    (candidate) => candidate.menuId === MENU_ID,
  );
  if (menu === undefined) {
    throw new Error(`The merchant has no published ${MENU_ID}`);
  }
  if (menu.scope.kind !== "location") {
    throw new Error(`${MENU_ID} must be scoped to one location`);
  }
  return {
    revision: menu.revision,
    salesChannelId: menu.salesChannelId,
    locationId: menu.scope.locationId,
    recipeIds: new Set(
      result.value.resources.recipeRevisions.map((recipe) => recipe.recipeId),
    ),
    menu: {
      menuId: menu.menuId,
      name: menu.name,
      salesChannelId: menu.salesChannelId,
      scope: menu.scope,
      validity: menu.validity,
      sections: [],
      entries: menu.entries.map((entry) => ({
        menuEntryId: entry.menuEntryId,
        sectionId: entry.sectionId,
        offerId: entry.offerId,
        offerRevision: entry.offerRevision,
        consumptionPlanId: entry.consumptionPlanId,
        consumptionPlanRevision: entry.consumptionPlanRevision,
        modifierGroupRevisions: entry.modifierGroupRevisions,
      })),
    },
  };
}

function inventoryItem(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
): CommerceCommandInput<CreateCommerceInventoryItemV1> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:inventory_item:${item.slug}`,
    inventoryItemId: inventoryItemId(item),
    merchantCode: sku(item),
    name: item.title,
    baseUnit: "each",
    category: "finished_good",
    tracking: { kind: "lot_tracked", expiry: "required" },
  };
}

function inventoryPosition(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  locationId: string,
): CommerceCommandInput<OpenCommerceInventoryPositionV1> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:inventory_position:${item.slug}`,
    inventoryPositionId: positionId(item),
    inventoryItemId: inventoryItemId(item),
    inventoryItemRevision: 1,
    locationId,
    locationRevision: 1,
  };
}

function openingStock(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  quantity: number,
  locationId: string,
  batch: Readonly<{ run: string; requestedAt: string; expiresAt: string }>,
): CommerceCommandInput<ReceiveCommerceInventoryV3> {
  return {
    purchase: { kind: "unlinked" },
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `${batch.run}:opening_stock:${item.slug}`,
    receiptId: "receipt_patisserie_opening_stock",
    receiptLineId: `receipt_line_patisserie_${item.slug}`,
    inventoryItemId: inventoryItemId(item),
    inventoryItemRevision: 1,
    inventoryPositionId: positionId(item),
    inventoryPositionRevision: 1,
    locationId,
    receivedQuantity: { amount: quantity, scale: 0, unit: "each" },
    lot: {
      kind: "tracked",
      lotId: `lot_patisserie_${item.slug}_opening`,
      lotCode: `${sku(item)}-OPENING`,
      expiry: { kind: "expires", expiresAt: batch.expiresAt },
    },
    receivedAt: batch.requestedAt,
  };
}

function preparedListing(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  cafe: CafeMenu,
  salesChannel: CommerceResourcesV1["salesChannels"][number],
  time: Readonly<{ occurredAt: string }>,
): CommerceCommandInput<PrepareCommerceCatalogListingV1> {
  const variantId = patisserieVariantId(item);
  const { occurredAt } = time;
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:prepared_listing:${item.slug}`,
    salesChannel,
    product: {
      id: productId(item),
      revision: 1,
      title: item.title,
      description: item.description,
      handle: null,
      productType: item.section,
      vendor: "",
      tags: [item.section],
      status: "active",
      occurredAt,
    },
    variant: {
      id: variantId,
      revision: 1,
      productId: productId(item),
      sku: sku(item),
      title: item.title,
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt,
    },
    offer: {
      id: offerId(item),
      revision: 1,
      variantId,
      salesChannelId: cafe.salesChannelId,
      price: { amountMinor: item.priceMinor, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: occurredAt },
      occurredAt,
    },
    consumptionPlan: {
      consumptionPlanId: consumptionPlanId(item),
      variantId,
      revision: 1,
      scope: { kind: "location", locationId: cafe.locationId },
      mode: {
        kind: "prepared",
        recipeId: patisserieRecipeId(item),
        recipeRevision: 1,
      },
      lifecycle: "active",
    },
  };
}

function channelListing(
  merchantId: string,
  expectedMerchantRevision: number,
  item: PatisserieItem,
  cafe: CafeMenu,
  occurredAt: string,
): CommerceCommandInput<PlaceCommerceChannelListingV1> {
  const variantId = patisserieVariantId(item);
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `patisserie_menu_v1:channel_listing:${item.slug}`,
    salesChannelId: cafe.salesChannelId,
    catalog: {
      kind: "new_product",
      product: {
        id: productId(item),
        revision: 1,
        title: item.title,
        description: item.description,
        handle: null,
        productType: item.section,
        vendor: "",
        tags: [item.section],
        status: "active",
        occurredAt,
      },
      variant: {
        id: variantId,
        revision: 1,
        productId: productId(item),
        sku: sku(item),
        title: item.title,
        options: [],
        media: [],
        barcode: null,
        status: "active",
        occurredAt,
      },
      consumptionPlan: {
        consumptionPlanId: consumptionPlanId(item),
        variantId,
        revision: 1,
        scope: { kind: "location", locationId: cafe.locationId },
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: inventoryItemId(item),
              quantity: { amount: 1, scale: 0, unit: "each" },
            },
          ],
          commitOn: "fulfillment_completed",
        },
        lifecycle: "active",
      },
    },
    offer: {
      id: offerId(item),
      revision: 1,
      variantId,
      salesChannelId: cafe.salesChannelId,
      price: { amountMinor: item.priceMinor, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: occurredAt },
      occurredAt,
    },
  };
}

function patisserieMenu(
  merchantId: string,
  expectedMerchantRevision: number,
  cafe: CafeMenu,
  offers: ReadonlyMap<string, number>,
  run: string,
): CommerceCommandInput<PublishMenuCommand> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: `${run}:menu:${cafe.revision}`,
    expectedMenuRevision: cafe.revision,
    menu: {
      ...cafe.menu,
      sections: SECTIONS.map((section, position) => ({
        sectionId: `section_${section.id}`,
        name: section.name,
        position,
      })),
      entries: PATISSERIE_ITEMS.map((item) => ({
        menuEntryId: `menu_entry_patisserie_${item.slug}`,
        sectionId: `section_${item.section}`,
        offerId: offerId(item),
        offerRevision: offers.get(offerId(item)) ?? 1,
        consumptionPlanId: consumptionPlanId(item),
        consumptionPlanRevision: 1,
        modifierGroupRevisions: [],
      })),
    },
  };
}

async function apply(
  pending: Promise<
    Readonly<
      | { ok: true; value: CommerceMutationResultV1 }
      | { ok: false; error: Readonly<{ kind: string; message: string }> }
    >
  >,
  operation: string,
  expectedRevision: number,
): Promise<number> {
  const result = await pending;
  if (!result.ok) throw clientFailure(operation, result);
  if (result.value.outcome === "rejected") {
    throw new Error(
      `${operation} was rejected: ${JSON.stringify(result.value.error)}`,
    );
  }
  if (result.value.receipt.merchantRevision !== expectedRevision + 1) {
    throw new Error(`${operation} produced an unexpected merchant revision`);
  }
  return expectedRevision + 1;
}

function clientFailure(
  operation: string,
  result: Readonly<{
    ok: false;
    error: Readonly<{ kind: string; message: string }>;
  }>,
): Error {
  return new Error(
    `${operation} failed: ${result.error.kind}: ${result.error.message}`,
  );
}
