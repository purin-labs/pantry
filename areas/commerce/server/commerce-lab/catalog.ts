export const COMMERCE_LAB_CATALOG_VERSION = "2026-08-09.1";

type CommerceLabMoney = {
  readonly amountMinor: number;
  readonly currency: "USD";
};

type CommerceLabVariant = {
  readonly variantId: string;
  readonly sku: string;
  readonly title: string;
  readonly optionValues: Readonly<Record<string, string>>;
  readonly price: CommerceLabMoney;
  readonly initialQuantity: number;
};

type CommerceLabProduct = {
  readonly productId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly variants: readonly CommerceLabVariant[];
};

type CommerceLabCustomer = {
  readonly customerId: string;
  readonly displayName: string;
  readonly email: string;
  readonly countryCode: "US" | "JP" | "GB";
  readonly postalRegion: string;
};

const PRODUCT_IMAGE_ROOT = "https://assets.example.invalid/builtin-commerce-lab";

export const COMMERCE_LAB_PRODUCTS = [
  {
    productId: "product_field_watch",
    slug: "field-watch",
    title: "Field Watch",
    description: "Synthetic automatic field watch for the Pantry commerce lab.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/field-watch.png`,
    variants: [
      {
        variantId: "variant_field_watch_black",
        sku: "LAB-WATCH-FIELD-BLK",
        title: "Black dial",
        optionValues: { dial: "Black" },
        price: { amountMinor: 42_500, currency: "USD" },
        initialQuantity: 12,
      },
      {
        variantId: "variant_field_watch_cream",
        sku: "LAB-WATCH-FIELD-CRM",
        title: "Cream dial",
        optionValues: { dial: "Cream" },
        price: { amountMinor: 42_500, currency: "USD" },
        initialQuantity: 8,
      },
    ],
  },
  {
    productId: "product_espresso_blend",
    slug: "espresso-blend",
    title: "Espresso Blend Coffee",
    description: "Synthetic espresso beans for café inventory testing.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/espresso-blend.png`,
    variants: [
      {
        variantId: "variant_espresso_blend_1kg",
        sku: "LAB-CAFE-BEAN-ESP-1KG",
        title: "1 kg bag",
        optionValues: { size: "1 kg" },
        price: { amountMinor: 3_200, currency: "USD" },
        initialQuantity: 6,
      },
      {
        variantId: "variant_espresso_blend_250g",
        sku: "LAB-CAFE-BEAN-ESP-250",
        title: "250 g bag",
        optionValues: { size: "250 g" },
        price: { amountMinor: 1_100, currency: "USD" },
        initialQuantity: 10,
      },
    ],
  },
  {
    productId: "product_house_blend",
    slug: "house-blend",
    title: "House Blend Coffee",
    description: "Synthetic 1 kg bag of café house-blend beans.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/house-blend.png`,
    variants: [
      {
        variantId: "variant_house_blend_1kg",
        sku: "LAB-CAFE-BEAN-HOUSE-1KG",
        title: "1 kg bag",
        optionValues: {},
        price: { amountMinor: 2_800, currency: "USD" },
        initialQuantity: 20,
      },
    ],
  },
  {
    productId: "product_oat_milk",
    slug: "oat-milk",
    title: "Barista Oat Milk",
    description: "Synthetic case of shelf-stable barista oat milk.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/oat-milk.png`,
    variants: [
      {
        variantId: "variant_oat_milk_case",
        sku: "LAB-CAFE-OAT-CASE",
        title: "12 × 1 L case",
        optionValues: { pack: "12" },
        price: { amountMinor: 3_600, currency: "USD" },
        initialQuantity: 16,
      },
    ],
  },
  {
    productId: "product_ceramic_cup",
    slug: "ceramic-cup",
    title: "Ceramic Café Cup",
    description: "Synthetic stackable ceramic cup for dine-in service.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/ceramic-cup.png`,
    variants: [
      {
        variantId: "variant_ceramic_cup_250ml",
        sku: "LAB-CAFE-CUP-250",
        title: "250 ml",
        optionValues: {},
        price: { amountMinor: 1_200, currency: "USD" },
        initialQuantity: 40,
      },
    ],
  },
  {
    productId: "product_takeaway_cup",
    slug: "takeaway-cup",
    title: "Compostable Takeaway Cup",
    description: "Synthetic compostable takeaway cup sleeves.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/takeaway-cup.png`,
    variants: [
      {
        variantId: "variant_takeaway_cup_8oz",
        sku: "LAB-CAFE-TAKEAWAY-8",
        title: "8 oz · 50 pack",
        optionValues: { size: "8 oz" },
        price: { amountMinor: 900, currency: "USD" },
        initialQuantity: 18,
      },
      {
        variantId: "variant_takeaway_cup_12oz",
        sku: "LAB-CAFE-TAKEAWAY-12",
        title: "12 oz · 50 pack",
        optionValues: { size: "12 oz" },
        price: { amountMinor: 1_100, currency: "USD" },
        initialQuantity: 15,
      },
    ],
  },
  {
    productId: "product_croissant",
    slug: "butter-croissant",
    title: "Butter Croissant",
    description: "Synthetic frozen butter croissant case for morning service.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/butter-croissant.png`,
    variants: [
      {
        variantId: "variant_croissant_case",
        sku: "LAB-CAFE-CROISSANT-48",
        title: "48 pack",
        optionValues: { pack: "48" },
        price: { amountMinor: 4_800, currency: "USD" },
        initialQuantity: 14,
      },
    ],
  },
  {
    productId: "product_bar_towel",
    slug: "bar-towel",
    title: "Cotton Bar Towel",
    description: "Synthetic washable bar towel for café service.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/bar-towel.png`,
    variants: [
      {
        variantId: "variant_bar_towel_pack",
        sku: "LAB-CAFE-TOWEL-12",
        title: "12 pack",
        optionValues: {},
        price: { amountMinor: 2_400, currency: "USD" },
        initialQuantity: 50,
      },
    ],
  },
  {
    productId: "product_milk_pitcher",
    slug: "milk-pitcher",
    title: "Stainless Milk Pitcher",
    description: "Synthetic stainless pitcher for milk steaming.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/milk-pitcher.png`,
    variants: [
      {
        variantId: "variant_milk_pitcher_600ml",
        sku: "LAB-CAFE-PITCHER-600",
        title: "600 ml",
        optionValues: { capacity: "600 ml" },
        price: { amountMinor: 2_200, currency: "USD" },
        initialQuantity: 9,
      },
    ],
  },
  {
    productId: "product_knock_box",
    slug: "espresso-knock-box",
    title: "Espresso Knock Box",
    description: "Synthetic countertop knock box for espresso service.",
    imageUrl: `${PRODUCT_IMAGE_ROOT}/espresso-knock-box.png`,
    variants: [
      {
        variantId: "variant_knock_box_standard",
        sku: "LAB-CAFE-KNOCK-STD",
        title: "Standard",
        optionValues: {},
        price: { amountMinor: 3_900, currency: "USD" },
        initialQuantity: 7,
      },
    ],
  },
] as const satisfies readonly CommerceLabProduct[];

export const COMMERCE_LAB_CUSTOMERS = [
  {
    customerId: "customer_lab_ada",
    displayName: "Ada Example",
    email: "ada@pantry-lab.example",
    countryCode: "US",
    postalRegion: "CA",
  },
  {
    customerId: "customer_lab_ren",
    displayName: "Ren Example",
    email: "ren@pantry-lab.example",
    countryCode: "JP",
    postalRegion: "Tokyo",
  },
  {
    customerId: "customer_lab_mina",
    displayName: "Mina Example",
    email: "mina@pantry-lab.example",
    countryCode: "GB",
    postalRegion: "London",
  },
] as const satisfies readonly CommerceLabCustomer[];

export function commerceLabVariantCount(): number {
  let count = 0;

  for (const product of COMMERCE_LAB_PRODUCTS) {
    count += product.variants.length;
  }

  return count;
}
