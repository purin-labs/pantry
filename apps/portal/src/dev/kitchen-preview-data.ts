// Example answers for the Kitchen preview pages (kitchen-preview.tsx). One
// pâtisserie: its supplies, recipes, products, cost plan, stock, production
// requests and bakes. Every value is sample data.

const OBSERVED_AT = "2026-11-23T03:00:00.000Z";
const DAY = 86_400_000;
const NOW = Date.parse(OBSERVED_AT);

type Unit = "each" | "gram" | "kilogram" | "milliliter" | "liter";
type Supply = Readonly<{
  id: string;
  name: string;
  category: "ingredient" | "packaging" | "operating_supply";
  unit: Unit;
  pack: Readonly<{ quantity: number; unit: Unit; priceMinor: number }> | null;
  onHand: number;
}>;

const SUPPLIES: readonly Supply[] = [
  {
    id: "item_butter",
    name: "Fermented butter sheet",
    category: "ingredient",
    unit: "gram",
    pack: { quantity: 2, unit: "kilogram", priceMinor: 5_400 },
    onHand: 3_200,
  },
  {
    id: "item_almond",
    name: "Almond flour",
    category: "ingredient",
    unit: "gram",
    pack: { quantity: 1, unit: "kilogram", priceMinor: 2_800 },
    onHand: 600,
  },
  {
    id: "item_sugar",
    name: "Icing sugar",
    category: "ingredient",
    unit: "gram",
    pack: { quantity: 1, unit: "kilogram", priceMinor: 420 },
    onHand: 4_000,
  },
  {
    id: "item_whites",
    name: "Egg whites",
    category: "ingredient",
    unit: "gram",
    pack: { quantity: 1, unit: "kilogram", priceMinor: 1_100 },
    onHand: 0,
  },
  {
    id: "item_flour",
    name: "Cake flour",
    category: "ingredient",
    unit: "gram",
    pack: { quantity: 1, unit: "kilogram", priceMinor: 380 },
    onHand: 5_500,
  },
  {
    id: "item_box",
    name: "Gift box, 6 pieces",
    category: "packaging",
    unit: "each",
    pack: { quantity: 50, unit: "each", priceMinor: 4_500 },
    onHand: 40,
  },
  {
    id: "item_gloves",
    name: "Nitrile gloves",
    category: "operating_supply",
    unit: "each",
    pack: null,
    onHand: 200,
  },
];

type Product = Readonly<{
  id: string;
  title: string;
  priceMinor: number;
  recipeId: string;
  dailyUnits: number;
  /** Grams of each supply in one batch. */
  inputs: readonly (readonly [string, number])[];
  batchYield: number;
}>;

const PRODUCTS: readonly Product[] = [
  {
    id: "product_financier",
    title: "Brown butter financier",
    priceMinor: 420,
    recipeId: "recipe_financier",
    dailyUnits: 36,
    inputs: [
      ["item_butter", 300],
      ["item_almond", 200],
      ["item_sugar", 300],
      ["item_whites", 280],
      ["item_flour", 80],
    ],
    batchYield: 24,
  },
  {
    id: "product_canele",
    title: "Canelé",
    priceMinor: 380,
    recipeId: "recipe_canele",
    dailyUnits: 18,
    inputs: [
      ["item_butter", 50],
      ["item_sugar", 250],
      ["item_flour", 120],
    ],
    batchYield: 18,
  },
  {
    id: "product_sable",
    title: "Sablé breton",
    priceMinor: 320,
    recipeId: "recipe_sable",
    dailyUnits: 30,
    inputs: [
      ["item_butter", 250],
      ["item_sugar", 150],
      ["item_flour", 300],
    ],
    batchYield: 30,
  },
];

function provenance(kind: string, id: string, revision: number) {
  return {
    organisationId: "organisation_preview",
    integrationAccountId: "integration_preview",
    source: "commerce",
    resourceType: kind,
    resourceId: id,
    revision,
    occurredAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
  };
}

function recipe(product: Product) {
  return {
    provenance: provenance("recipe_revision", product.recipeId, 3),
    recipeId: product.recipeId,
    revision: 3,
    name: product.title,
    inputs: product.inputs.map(([inventoryItemId, grams]) => ({
      inventoryItemId,
      quantity: { amount: grams, scale: 0, unit: "gram" },
    })),
    output: {
      kind: "stocked",
      inventoryItemId: `${product.id}_stock`,
      yieldQuantity: { amount: product.batchYield, scale: 0, unit: "each" },
    },
    lifecycle: { state: "active", activeAt: OBSERVED_AT },
  };
}

const RECIPES = [
  ...PRODUCTS.map(recipe),
  {
    provenance: provenance("recipe_revision", "recipe_ginger_tea", 1),
    recipeId: "recipe_ginger_tea",
    revision: 1,
    name: "Ginger tea",
    inputs: [
      {
        inventoryItemId: "item_sugar",
        quantity: { amount: 12, scale: 0, unit: "gram" },
      },
    ],
    output: { kind: "immediate" },
    lifecycle: { state: "draft" },
  },
];

export function recipeCollection(): unknown {
  return {
    ok: true,
    merchantRevision: 174,
    recipes: RECIPES,
    items: [
      ...SUPPLIES.map((supply) => ({
        id: supply.id,
        name: supply.name,
        baseUnit: supply.unit,
        lifecycle: "active",
      })),
      ...PRODUCTS.map((product) => ({
        id: `${product.id}_stock`,
        name: product.title,
        baseUnit: "each",
        lifecycle: "active",
      })),
    ],
  };
}

export function costsOverview(): unknown {
  return {
    ok: true,
    merchantRevision: 174,
    currency: "JPY",
    canEditPrices: true,
    defaultIncludedTaxBps: 800,
    includedTaxSource: "checkout_profile",
    recipes: RECIPES,
    items: SUPPLIES.map((supply) => ({
      id: supply.id,
      merchantCode: supply.id.replace("item_", "").toUpperCase(),
      name: supply.name,
      category: supply.category,
      baseUnit: supply.unit,
      lifecycle: "active",
      costTerms:
        supply.pack === null
          ? null
          : {
              entryId: `cost_${supply.id}`,
              entryRevision: 1,
              currency: "JPY",
              packQuantity: supply.pack.quantity,
              packUnit: supply.pack.unit,
              packPriceMinor: supply.pack.priceMinor,
              supplierId: "supplier_tsukiji",
              bulkTier: null,
              notes: null,
            },
      onHandQuantity: supply.onHand,
    })),
    products: PRODUCTS.map((product) => ({
      productId: product.id,
      productTitle: product.title,
      productType: "Baked goods",
      variantId: `${product.id}_variant`,
      variantTitle: "Single",
      offerId: `${product.id}_offer`,
      offerRevision: 1,
      priceMinor: product.priceMinor,
      currency: "JPY",
      fulfillmentKind: "stocked",
      recipeId: product.recipeId,
      finishedGoodItemId: `${product.id}_stock`,
      directPackagingInputs: [],
      defaultDailyUnits: product.dailyUnits,
      imageUrl: null,
    })),
    measuredWaste: {
      windowDays: 30,
      stockedUnitsProduced: 2_400,
      stockedUnitsWasted: 96,
      measuredShelfWastePct: 4,
      plannedBatchUnits: 2_400,
      actualBatchUnits: 2_352,
      measuredBatchRejectPct: 2,
      supplyLossMovementsCount: 3,
    },
    costPlan: {
      revision: 4,
      dailyLaborMinor: 48_000,
      dailyRentMinor: 12_000,
      products: PRODUCTS.map((product) => ({
        productId: product.id,
        weekUnits: [
          product.dailyUnits,
          product.dailyUnits,
          product.dailyUnits,
          product.dailyUnits,
          product.dailyUnits + 6,
          product.dailyUnits + 12,
          product.dailyUnits + 12,
        ],
        spoilBps: 400,
      })),
    },
    lots: [],
  };
}

type StockSpec = Readonly<{
  supply: Supply;
  available: number | null;
  reorderPoint: number;
  target: number;
  status: "uncounted" | "out" | "low" | "healthy";
  expiresInDays: number | null;
}>;

function stockRow(spec: StockSpec) {
  const unit = spec.supply.unit === "gram" ? " g" : "";
  const amount = (value: number | null) =>
    value === null ? null : `${value.toLocaleString("en-US")}${unit}`;
  return {
    id: `stock_${spec.supply.id}`,
    inventoryItemId: spec.supply.id,
    positionId: `position_${spec.supply.id}`,
    recipeCount: 0,
    locationId: "location_kitchen",
    name: spec.supply.name,
    location: "Main kitchen",
    onHand: amount(spec.available),
    allocated: amount(spec.available === null ? null : 0),
    available: amount(spec.available),
    reorderPoint: amount(spec.reorderPoint),
    target: amount(spec.target),
    status: spec.status,
    lots:
      spec.expiresInDays === null
        ? []
        : [
            {
              id: `lot_${spec.supply.id}`,
              code: `L-${spec.supply.id.slice(5, 9).toUpperCase()}-1120`,
              remaining: amount(spec.available) ?? "0",
              expiresAt: new Date(NOW + spec.expiresInDays * DAY).toISOString(),
              status: "available",
            },
          ],
    movements: [
      {
        id: `movement_${spec.supply.id}`,
        direction: "increase",
        quantity: amount(spec.target) ?? "0",
        reason: "purchase_receipt",
        occurredAt: new Date(NOW - 3 * DAY).toISOString(),
      },
    ],
    reservations: [],
    kind: "supply",
    category: spec.supply.category,
    product: null,
  };
}

function supply(id: string): Supply {
  const found = SUPPLIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No sample supply ${id}`);
  return found;
}

export function inventory(): unknown {
  const specs: readonly StockSpec[] = [
    {
      supply: supply("item_butter"),
      available: 3_200,
      reorderPoint: 2_000,
      target: 6_000,
      status: "healthy",
      expiresInDays: 5,
    },
    {
      supply: supply("item_almond"),
      available: 600,
      reorderPoint: 1_000,
      target: 3_000,
      status: "low",
      expiresInDays: 60,
    },
    {
      supply: supply("item_sugar"),
      available: 4_000,
      reorderPoint: 1_000,
      target: 5_000,
      status: "healthy",
      expiresInDays: null,
    },
    {
      supply: supply("item_whites"),
      available: 0,
      reorderPoint: 1_000,
      target: 3_000,
      status: "out",
      expiresInDays: null,
    },
    {
      supply: supply("item_flour"),
      available: 5_500,
      reorderPoint: 2_000,
      target: 8_000,
      status: "healthy",
      expiresInDays: 90,
    },
    {
      supply: supply("item_box"),
      available: 40,
      reorderPoint: 50,
      target: 200,
      status: "low",
      expiresInDays: null,
    },
    {
      supply: supply("item_gloves"),
      available: null,
      reorderPoint: 100,
      target: 400,
      status: "uncounted",
      expiresInDays: null,
    },
  ];
  return {
    ok: true,
    rows: specs.map(stockRow),
    untrackedProducts: [],
    archivedProducts: [],
  };
}

type RequestSpec = Readonly<{
  product: Product;
  quantity: number;
  status: "requested" | "accepted" | "scheduled";
  batches: number;
}>;

function productionRequest(spec: RequestSpec) {
  return {
    id: `production_request_${spec.product.id.slice(8)}`,
    revision: 1,
    itemId: `${spec.product.id}_stock`,
    name: spec.product.title,
    locationId: "location_kitchen",
    recipeId: spec.product.recipeId,
    recipeRevision: 3,
    quantity: { amount: spec.quantity, scale: 0, unit: "each" },
    neededBy: new Date(NOW + DAY).toISOString(),
    status: spec.status,
    batches:
      spec.batches === 0
        ? []
        : [
            {
              id: `batch_${spec.product.id.slice(8)}_1`,
              actualYield: {
                amount: spec.product.batchYield,
                scale: 0,
                unit: "each",
              },
            },
          ],
  };
}

export function productionDemand(): unknown {
  const product = (id: string) => {
    const found = PRODUCTS.find((item) => item.id === id);
    if (found === undefined) throw new Error(`No sample product ${id}`);
    return found;
  };
  return {
    ok: true,
    demand: {
      kind: "ready",
      listRevision: 9,
      merchantRevision: 174,
      requests: [
        productionRequest({
          product: product("product_financier"),
          quantity: 36,
          status: "requested",
          batches: 0,
        }),
        productionRequest({
          product: product("product_canele"),
          quantity: 18,
          status: "accepted",
          batches: 0,
        }),
        productionRequest({
          product: product("product_sable"),
          quantity: 30,
          status: "scheduled",
          batches: 1,
        }),
      ],
      invalidRequests: [],
      nextCursor: null,
    },
  };
}

function bakeId(index: number): string {
  return `bake_${String(index).padStart(24, "0")}`;
}

export function bakeBoard(): unknown {
  const level = (
    product: Product,
    levelPieces: number,
    counterPieces: number | null,
  ) => ({
    inventoryItemId: `${product.id}_stock`,
    productName: product.title,
    levelPieces,
    piecesPerGroup: 6,
    workflowId: product.recipeId.replace("recipe_", "").replace("_", "-"),
    kitchenLocation: "Main kitchen",
    revision: 2,
    setBy: "user_owner",
    setAt: NOW - 2 * DAY,
    counterPieces,
    recipe: { title: product.title, revision: 3 },
  });
  const proposal = (
    index: number,
    product: Product,
    state: "open" | "approved" | "rejected" | "ended",
    hoursAgo: number,
  ) => ({
    proposalId: bakeId(index),
    inventoryItemId: `${product.id}_stock`,
    productName: product.title,
    state,
    origin: "stock",
    caseId: `case_bake_${index}`,
    workflowId: product.recipeId.replace("recipe_", ""),
    workflowRevision: 3,
    workflowDigest: "a".repeat(64),
    quantityPieces: 12,
    mouldGroups: 2,
    piecesPerGroup: 6,
    kitchenLocation: "Main kitchen",
    oven: { deviceId: "device_oven", name: "Deck oven" },
    stockLocationId: "location_kitchen",
    stockAvailable: 4,
    stockLevel: 12,
    proposedBy: "pantry",
    proposedAt: NOW - hoursAgo * 3_600_000,
    openedAt: NOW - hoursAgo * 3_600_000,
    announcedAt: NOW - hoursAgo * 3_600_000,
    decision:
      state === "open"
        ? null
        : {
            by: "user_owner",
            role: "owner",
            via: "slack",
            at: NOW - (hoursAgo - 1) * 3_600_000,
            reason: state === "rejected" ? "Oven is in use." : null,
          },
    endedAt: state === "ended" ? NOW - (hoursAgo - 2) * 3_600_000 : null,
    endReason: null,
  });
  const [financier, canele, sable] = PRODUCTS;
  if (financier === undefined || canele === undefined || sable === undefined)
    throw new Error("The sample products are missing.");
  return {
    ok: true,
    levels: [
      level(financier, 12, 4),
      level(canele, 8, 9),
      level(sable, 10, null),
    ],
    proposals: [
      proposal(1, financier, "open", 1),
      proposal(2, canele, "ended", 6),
      proposal(3, sable, "rejected", 26),
    ],
    runs: [],
    products: PRODUCTS.map((product) => ({
      inventoryItemId: `${product.id}_stock`,
      name: product.title,
      counterPieces: 4,
    })),
    workflows: PRODUCTS.map((product) => ({
      workflowId: product.recipeId.replace("recipe_", ""),
      title: product.title,
      revision: 3,
    })),
    kitchenLocations: ["Main kitchen"],
    authority: [
      {
        kitchenLocation: "Main kitchen",
        mode: "shadow",
        revision: null,
        setBy: null,
        setAt: null,
      },
    ],
    access: { mayEditLevels: true, mayDecide: true },
  };
}
