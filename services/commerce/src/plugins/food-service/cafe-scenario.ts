// The café demo of a pâtisserie (Plan 76 phase 5): ingredients, stations,
// modifier groups, recipes, stock policies and the pickup storefront, from
// an empty merchant or from the earlier canonical café states.
import {
  type ProvisionCommerceDemoV1,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceLocationV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationResultV1,
  type CommerceQuantityV1,
} from "@purin-labs/commerce-client";
import type { InventoryConsumptionPlan } from "@purin-labs/commerce-contracts";
import { hasCommerceResources } from "../../demo-fixtures.ts";
import type { Variant } from "@purin-labs/type-utils";

import {
  findResource,
  type ProvisioningAuthorityOptions,
} from "../../commerce-authority/provisioning.ts";

const CAFE_SCENARIO_TIMESTAMP = "2026-08-14T09:30:00.000Z";
const CAFE_SCENARIO_LOT_EXPIRY = "2036-08-21T00:00:00.000Z";

type CafeScenarioIngredient = Readonly<{
  inventoryItemId: string;
  merchantCode: string;
  name: string;
  unit: "gram" | "milliliter";
  amount: number;
  scale: 0 | 1;
}>;

type CafeScenarioStartingRevision = 0 | 6 | 45 | 47;

const CAFE_SCENARIO_INGREDIENTS: readonly CafeScenarioIngredient[] = [
  {
    inventoryItemId: "inventory_flour",
    merchantCode: "FLOUR",
    name: "Flour",
    unit: "gram",
    amount: 4_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_butter",
    merchantCode: "BUTTER",
    name: "Butter",
    unit: "gram",
    amount: 2_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_sugar",
    merchantCode: "SUGAR",
    name: "Sugar",
    unit: "gram",
    amount: 1_500,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_whole_milk",
    merchantCode: "WHOLE-MILK",
    name: "Whole milk",
    unit: "milliliter",
    amount: 5_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_black_sesame",
    merchantCode: "BLACK-SESAME",
    name: "Black sesame",
    unit: "gram",
    amount: 4_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_glutinous_rice_flour",
    merchantCode: "GLUTINOUS-RICE-FLOUR",
    name: "Glutinous rice flour",
    unit: "gram",
    amount: 2_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_water",
    merchantCode: "WATER",
    name: "Water",
    unit: "milliliter",
    amount: 10_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_salt",
    merchantCode: "SALT",
    name: "Fine salt",
    unit: "gram",
    amount: 5_000,
    scale: 1,
  },
  {
    inventoryItemId: "inventory_almond_flour",
    merchantCode: "ALMOND-FLOUR",
    name: "Almond flour",
    unit: "gram",
    amount: 2_000,
    scale: 0,
  },
];

type CafeExpansionIngredient = CafeScenarioIngredient;

const CAFE_EXPANSION_INGREDIENTS: readonly CafeExpansionIngredient[] = [
  {
    inventoryItemId: "inventory_ginger",
    merchantCode: "GINGER",
    name: "Fresh ginger",
    unit: "gram",
    amount: 2_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_assam_tea",
    merchantCode: "ASSAM-TEA",
    name: "Assam black tea",
    unit: "gram",
    amount: 1_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_taro_powder",
    merchantCode: "TARO-POWDER",
    name: "Taro powder",
    unit: "gram",
    amount: 2_000,
    scale: 0,
  },
  {
    inventoryItemId: "inventory_matcha_powder",
    merchantCode: "MATCHA-POWDER",
    name: "Ceremonial matcha",
    unit: "gram",
    amount: 1_000,
    scale: 0,
  },
];

type CafeExpansionCatalogBase = Readonly<{
  flavor: "ginger" | "taro" | "matcha";
  slug: string;
  title: string;
  description: string;
  sku: string;
  priceMinor: number;
  recipeId: string;
  consumptionPlanId: string;
}>;

type CafeExpansionCatalog =
  | (CafeExpansionCatalogBase &
      Readonly<{ kind: "cookie"; inventoryItemId: string }>)
  | (CafeExpansionCatalogBase &
      Readonly<{ kind: "drink" | "financier"; inventoryItemId?: never }>);

const CAFE_EXPANSION_CATALOG: readonly CafeExpansionCatalog[] = [
  {
    flavor: "ginger",
    kind: "drink",
    slug: "ginger_milk_tea",
    title: "Ginger Milk Tea",
    description: "Assam tea, fresh ginger, and gently warmed whole milk.",
    sku: "GINGER-MILK-TEA",
    priceMinor: 650,
    recipeId: "recipe_ginger_milk_tea",
    consumptionPlanId: "consumption_plan_ginger_milk_tea",
  },
  {
    flavor: "ginger",
    kind: "cookie",
    slug: "ginger_cookie",
    title: "Ginger Cookie",
    description: "A crisp butter cookie with warm fresh-ginger spice.",
    sku: "GINGER-COOKIE",
    priceMinor: 450,
    recipeId: "recipe_ginger_cookie_stocked",
    consumptionPlanId: "consumption_plan_ginger_cookie",
    inventoryItemId: "inventory_ginger_cookie",
  },
  {
    flavor: "ginger",
    kind: "financier",
    slug: "ginger_financier",
    title: "Ginger Financier",
    description: "Brown butter and almond financier with a ginger finish.",
    sku: "GINGER-FINANCIER",
    priceMinor: 500,
    recipeId: "recipe_ginger_financier",
    consumptionPlanId: "consumption_plan_ginger_financier",
  },
  {
    flavor: "taro",
    kind: "drink",
    slug: "taro_milk_tea",
    title: "Taro Milk Tea",
    description: "Assam tea, nutty taro, and creamy whole milk.",
    sku: "TARO-MILK-TEA",
    priceMinor: 700,
    recipeId: "recipe_taro_milk_tea",
    consumptionPlanId: "consumption_plan_taro_milk_tea",
  },
  {
    flavor: "taro",
    kind: "cookie",
    slug: "taro_cookie",
    title: "Taro Cookie",
    description: "A tender butter cookie with toasted taro powder.",
    sku: "TARO-COOKIE",
    priceMinor: 450,
    recipeId: "recipe_taro_cookie_stocked",
    consumptionPlanId: "consumption_plan_taro_cookie",
    inventoryItemId: "inventory_taro_cookie",
  },
  {
    flavor: "taro",
    kind: "financier",
    slug: "taro_financier",
    title: "Taro Financier",
    description: "A tender almond financier with a soft taro finish.",
    sku: "TARO-FINANCIER",
    priceMinor: 500,
    recipeId: "recipe_taro_financier",
    consumptionPlanId: "consumption_plan_taro_financier",
  },
  {
    flavor: "matcha",
    kind: "drink",
    slug: "matcha_tea",
    title: "Matcha Tea",
    description:
      "Bright ceremonial matcha whisked with water and light sweetness.",
    sku: "MATCHA-TEA",
    priceMinor: 650,
    recipeId: "recipe_matcha_tea",
    consumptionPlanId: "consumption_plan_matcha_tea",
  },
  {
    flavor: "matcha",
    kind: "cookie",
    slug: "matcha_cookie",
    title: "Matcha Cookie",
    description: "A crisp butter cookie layered with vivid matcha.",
    sku: "MATCHA-COOKIE",
    priceMinor: 450,
    recipeId: "recipe_matcha_cookie_stocked",
    consumptionPlanId: "consumption_plan_matcha_cookie",
    inventoryItemId: "inventory_matcha_cookie",
  },
  {
    flavor: "matcha",
    kind: "financier",
    slug: "matcha_financier",
    title: "Matcha Financier",
    description:
      "Brown butter and almond financier with clean matcha bitterness.",
    sku: "MATCHA-FINANCIER",
    priceMinor: 500,
    recipeId: "recipe_matcha_financier",
    consumptionPlanId: "consumption_plan_matcha_financier",
  },
];

type CafeExpansionRecipe = Readonly<{
  recipeId: string;
  name: string;
  inputs: readonly Readonly<{
    inventoryItemId: string;
    quantity: Readonly<{
      amount: number;
      scale: 0 | 1;
      unit: "gram" | "milliliter";
    }>;
  }>[];
  output:
    | Readonly<{ kind: "immediate" }>
    | Readonly<{
        kind: "stocked";
        inventoryItemId: string;
        yieldQuantity: Readonly<{ amount: number; scale: 0; unit: "each" }>;
      }>;
}>;

const CAFE_EXPANSION_RECIPES: readonly CafeExpansionRecipe[] = [
  {
    recipeId: "recipe_ginger_milk_tea",
    name: "Ginger milk tea",
    inputs: [
      {
        inventoryItemId: "inventory_ginger",
        quantity: { amount: 8, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_assam_tea",
        quantity: { amount: 4, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 12, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_water",
        quantity: { amount: 200, scale: 0, unit: "milliliter" },
      },
      {
        inventoryItemId: "inventory_whole_milk",
        quantity: { amount: 210, scale: 0, unit: "milliliter" },
      },
    ],
    output: { kind: "immediate" },
  },
  {
    recipeId: "recipe_ginger_cookie_stocked",
    name: "Ginger cookie batch",
    inputs: [
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 900, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 480, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 360, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_ginger",
        quantity: { amount: 90, scale: 0, unit: "gram" },
      },
    ],
    output: {
      kind: "stocked",
      inventoryItemId: "inventory_ginger_cookie",
      yieldQuantity: { amount: 24, scale: 0, unit: "each" },
    },
  },
  {
    recipeId: "recipe_ginger_financier",
    name: "Ginger financier",
    inputs: [
      {
        inventoryItemId: "inventory_almond_flour",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 10, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 20, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_ginger",
        quantity: { amount: 3, scale: 0, unit: "gram" },
      },
    ],
    output: { kind: "immediate" },
  },
  {
    recipeId: "recipe_taro_milk_tea",
    name: "Taro milk tea",
    inputs: [
      {
        inventoryItemId: "inventory_taro_powder",
        quantity: { amount: 30, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_assam_tea",
        quantity: { amount: 4, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 12, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_water",
        quantity: { amount: 80, scale: 0, unit: "milliliter" },
      },
      {
        inventoryItemId: "inventory_whole_milk",
        quantity: { amount: 210, scale: 0, unit: "milliliter" },
      },
    ],
    output: { kind: "immediate" },
  },
  {
    recipeId: "recipe_taro_cookie_stocked",
    name: "Taro cookie batch",
    inputs: [
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 900, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 480, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 360, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_taro_powder",
        quantity: { amount: 180, scale: 0, unit: "gram" },
      },
    ],
    output: {
      kind: "stocked",
      inventoryItemId: "inventory_taro_cookie",
      yieldQuantity: { amount: 24, scale: 0, unit: "each" },
    },
  },
  {
    recipeId: "recipe_taro_financier",
    name: "Taro financier",
    inputs: [
      {
        inventoryItemId: "inventory_almond_flour",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 10, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 20, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_taro_powder",
        quantity: { amount: 6, scale: 0, unit: "gram" },
      },
    ],
    output: { kind: "immediate" },
  },
  {
    recipeId: "recipe_matcha_tea",
    name: "Matcha tea",
    inputs: [
      {
        inventoryItemId: "inventory_matcha_powder",
        quantity: { amount: 4, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 8, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_water",
        quantity: { amount: 180, scale: 0, unit: "milliliter" },
      },
    ],
    output: { kind: "immediate" },
  },
  {
    recipeId: "recipe_matcha_cookie_stocked",
    name: "Matcha cookie batch",
    inputs: [
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 900, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 480, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 360, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_matcha_powder",
        quantity: { amount: 90, scale: 0, unit: "gram" },
      },
    ],
    output: {
      kind: "stocked",
      inventoryItemId: "inventory_matcha_cookie",
      yieldQuantity: { amount: 24, scale: 0, unit: "each" },
    },
  },
  {
    recipeId: "recipe_matcha_financier",
    name: "Matcha financier",
    inputs: [
      {
        inventoryItemId: "inventory_almond_flour",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_flour",
        quantity: { amount: 10, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_butter",
        quantity: { amount: 25, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_sugar",
        quantity: { amount: 20, scale: 0, unit: "gram" },
      },
      {
        inventoryItemId: "inventory_matcha_powder",
        quantity: { amount: 4, scale: 0, unit: "gram" },
      },
    ],
    output: { kind: "immediate" },
  },
];

export class CafeScenarioProvisioning {
  readonly #options: ProvisioningAuthorityOptions;

  constructor(options: ProvisioningAuthorityOptions) {
    this.#options = options;
  }

  provision(command: ProvisionCommerceDemoV1): CommerceMerchantSnapshotV1 {
    const current = this.#options.readSnapshot(command.merchantId);
    if (current === undefined)
      throw new Error("Cafe merchant provisioning did not persist");
    const foodService = this.#options.readFoodServiceResources(
      command.merchantId,
    );
    if (hasCafeScenarioSetup(current, foodService)) return current;
    const startingRevision = cafeScenarioStartingRevision(
      current,
      foodService,
      this.#options.listInventoryLots(command.merchantId),
      this.#options.listInventoryMovements(command.merchantId),
    );
    if (startingRevision === undefined) {
      throw new Error("Demo merchant already contains a different profile");
    }
    this.#seedCafeScenario(command, startingRevision);
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const seededFoodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (
      snapshot === undefined ||
      seededFoodService === undefined ||
      !hasCafeScenarioSetup(snapshot, seededFoodService.resources)
    ) {
      throw new Error("Cafe scenario verification failed");
    }
    return snapshot;
  }
  #seedCafeScenario(
    command: ProvisionCommerceDemoV1,
    startingRevision: CafeScenarioStartingRevision,
  ): void {
    let revision: number = startingRevision;
    if (startingRevision === 45 || startingRevision === 47) {
      this.#seedCafeExpansion(command, revision);
      return;
    }
    if (startingRevision === 0) {
      revision = requireDemoMutationRevision(
        this.#options.createLocation({
          ...cafeScenarioCommandBase(command, 0, "open_store"),
          schemaVersion: "underclerk.create-location.v1",
          location: cafeScenarioLocation(),
        }),
        "cafe location",
      );
      revision = requireDemoMutationRevision(
        this.#options.createInventoryItem({
          ...cafeScenarioCommandBase(
            command,
            revision,
            "create_sesame_cookie_item",
          ),
          schemaVersion: "underclerk.create-inventory-item.v1",
          inventoryItemId: "inventory_sesame_cookie",
          merchantCode: "SESAME-COOKIE",
          name: "Sesame cookie",
          baseUnit: "each",
          category: "finished_good",
          tracking: { kind: "lot_tracked", expiry: "required" },
        }),
        "sesame cookie item",
      );
      revision = requireDemoMutationRevision(
        this.#options.openInventoryPosition({
          ...cafeScenarioCommandBase(
            command,
            revision,
            "open_sesame_cookie_position",
          ),
          schemaVersion: "underclerk.open-inventory-position.v1",
          inventoryPositionId: "position_sesame_cookie_cafe",
          inventoryItemId: "inventory_sesame_cookie",
          inventoryItemRevision: 1,
          locationId: "location_cafe",
          locationRevision: 1,
        }),
        "sesame cookie position",
      );
      revision = requireDemoMutationRevision(
        this.#options.createInventoryItem({
          ...cafeScenarioCommandBase(command, revision, "create_oat_milk_item"),
          schemaVersion: "underclerk.create-inventory-item.v1",
          inventoryItemId: "inventory_oat_milk",
          merchantCode: "OAT-MILK",
          name: "Oat milk",
          baseUnit: "milliliter",
          category: "ingredient",
          tracking: { kind: "lot_tracked", expiry: "required" },
        }),
        "oat-milk item",
      );
      revision = requireDemoMutationRevision(
        this.#options.openInventoryPosition({
          ...cafeScenarioCommandBase(
            command,
            revision,
            "open_oat_milk_position",
          ),
          schemaVersion: "underclerk.open-inventory-position.v1",
          inventoryPositionId: "position_oat_milk_cafe",
          inventoryItemId: "inventory_oat_milk",
          inventoryItemRevision: 1,
          locationId: "location_cafe",
          locationRevision: 1,
        }),
        "oat-milk position",
      );
      revision = requireDemoMutationRevision(
        this.#options.receiveInventory({
          ...cafeScenarioCommandBase(command, revision, "receive_oat_milk"),
          schemaVersion: "underclerk.receive-inventory.v3",
          purchase: { kind: "unlinked" },
          receiptId: "receipt_oat_milk",
          receiptLineId: "receipt_line_oat_milk_accepted",
          inventoryItemId: "inventory_oat_milk",
          inventoryItemRevision: 1,
          inventoryPositionId: "position_oat_milk_cafe",
          inventoryPositionRevision: 1,
          locationId: "location_cafe",
          receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
          lot: {
            kind: "tracked",
            lotId: "lot_receipt_line_oat_milk_accepted",
            lotCode: "OAT-20260814-A",
            expiry: { kind: "expires", expiresAt: CAFE_SCENARIO_LOT_EXPIRY },
          },
          receivedAt: CAFE_SCENARIO_TIMESTAMP,
        }),
        "oat-milk receipt",
      );
    }
    if (startingRevision === 6) {
      revision = requireDemoMutationRevision(
        this.#options.createInventoryItem({
          ...cafeScenarioCommandBase(
            command,
            revision,
            "create_sesame_cookie_item",
          ),
          schemaVersion: "underclerk.create-inventory-item.v1",
          inventoryItemId: "inventory_sesame_cookie",
          merchantCode: "SESAME-COOKIE",
          name: "Sesame cookie",
          baseUnit: "each",
          category: "finished_good",
          tracking: { kind: "lot_tracked", expiry: "required" },
        }),
        "sesame cookie item",
      );
      revision = requireDemoMutationRevision(
        this.#options.openInventoryPosition({
          ...cafeScenarioCommandBase(
            command,
            revision,
            "open_sesame_cookie_position",
          ),
          schemaVersion: "underclerk.open-inventory-position.v1",
          inventoryPositionId: "position_sesame_cookie_cafe",
          inventoryItemId: "inventory_sesame_cookie",
          inventoryItemRevision: 1,
          locationId: "location_cafe",
          locationRevision: 1,
        }),
        "sesame cookie position",
      );
    }
    for (const ingredient of CAFE_SCENARIO_INGREDIENTS) {
      revision = this.#seedCafeIngredient(command, revision, ingredient);
    }
    revision = this.#seedCafeStation(
      command,
      revision,
      "station_bakery",
      "Patisserie production",
    );
    revision = this.#seedCafeStation(
      command,
      revision,
      "station_bar",
      "Cafe bar",
    );
    revision = requireDemoMutationRevision(
      this.#options.createRecipeRevision({
        ...cafeScenarioCommandBase(command, revision, "create_cookie_recipe"),
        schemaVersion: "underclerk.create-recipe-revision.v1",
        recipeRevision: {
          recipeId: "recipe_sesame_cookie_stocked",
          name: "Sesame cookie batch",
          inputs: [
            {
              inventoryItemId: "inventory_flour",
              quantity: { amount: 900, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_butter",
              quantity: { amount: 480, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_sugar",
              quantity: { amount: 360, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_black_sesame",
              quantity: { amount: 180, scale: 0, unit: "gram" },
            },
          ],
          output: {
            kind: "stocked",
            inventoryItemId: "inventory_sesame_cookie",
            yieldQuantity: { amount: 24, scale: 0, unit: "each" },
          },
        },
      }),
      "sesame cookie recipe",
    );
    revision = requireDemoMutationRevision(
      this.#options.createModifierGroupRevision({
        ...cafeScenarioCommandBase(command, revision, "create_milk_modifier"),
        schemaVersion: "underclerk.create-modifier-group-revision.v1",
        modifierGroupRevision: {
          modifierGroupId: "modifier_group_milk",
          name: "Milk",
          minimumSelections: 0,
          maximumSelections: 1,
          options: [
            {
              modifierOptionId: "modifier_option_oat_milk",
              name: "Oat milk",
              priceDelta: { amountMinor: 100, currency: "JPY" },
              requirementAdjustments: [
                {
                  kind: "reduce",
                  inventoryItemId: "inventory_whole_milk",
                  quantity: { amount: 210, scale: 0, unit: "milliliter" },
                },
                {
                  kind: "add",
                  inventoryItemId: "inventory_oat_milk",
                  quantity: { amount: 210, scale: 0, unit: "milliliter" },
                },
              ],
            },
          ],
        },
      }),
      "milk modifier",
    );
    revision = requireDemoMutationRevision(
      this.#options.createRecipeRevision({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "create_sesame_latte_recipe",
        ),
        schemaVersion: "underclerk.create-recipe-revision.v1",
        recipeRevision: {
          recipeId: "recipe_sesame_latte",
          name: "Sesame latte",
          inputs: [
            {
              inventoryItemId: "inventory_black_sesame",
              quantity: { amount: 22, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_sugar",
              quantity: { amount: 12, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_glutinous_rice_flour",
              quantity: { amount: 2, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_water",
              quantity: { amount: 40, scale: 0, unit: "milliliter" },
            },
            {
              inventoryItemId: "inventory_salt",
              quantity: { amount: 2, scale: 1, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_whole_milk",
              quantity: { amount: 210, scale: 0, unit: "milliliter" },
            },
          ],
          output: { kind: "immediate" },
        },
      }),
      "sesame latte recipe",
    );
    revision = requireDemoMutationRevision(
      this.#options.createRecipeRevision({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "create_sesame_financier_recipe",
        ),
        schemaVersion: "underclerk.create-recipe-revision.v1",
        recipeRevision: {
          recipeId: "recipe_sesame_financier",
          name: "Sesame financier",
          inputs: [
            {
              inventoryItemId: "inventory_almond_flour",
              quantity: { amount: 25, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_flour",
              quantity: { amount: 10, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_butter",
              quantity: { amount: 25, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_sugar",
              quantity: { amount: 20, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_black_sesame",
              quantity: { amount: 6, scale: 0, unit: "gram" },
            },
          ],
          output: { kind: "immediate" },
        },
      }),
      "sesame financier recipe",
    );
    revision = requireDemoMutationRevision(
      this.#options.configureStockPolicy({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "configure_oat_milk_stock_policy",
        ),
        schemaVersion: "underclerk.configure-stock-policy.v1",
        stockPolicy: {
          stockPolicyId: "stock_policy_oat_milk_cafe",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_cafe",
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: 7_800, scale: 0, unit: "milliliter" },
            targetQuantity: { amount: 16_000, scale: 0, unit: "milliliter" },
          },
        },
      }),
      "oat-milk stock policy",
    );
    revision = requireDemoMutationRevision(
      this.#options.configurePickupStorefront({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "configure_sesame_cookie_storefront",
        ),
        schemaVersion: "underclerk.configure-pickup-storefront.v1",
        location: cafeScenarioLocation(),
        salesChannel: cafeScenarioSalesChannel(),
        product: {
          id: "product_sesame_cookie",
          revision: 1,
          title: "Sesame Cookie",
          description: "A crisp black-sesame cookie baked in small batches.",
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        variant: {
          id: "variant_sesame_cookie",
          revision: 1,
          productId: "product_sesame_cookie",
          sku: "SESAME-COOKIE",
          title: "Sesame Cookie",
          options: [],
          media: [],
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        offer: {
          id: "offer_sesame_cookie_cafe",
          revision: 1,
          variantId: "variant_sesame_cookie",
          salesChannelId: "sales_channel_cafe",
          price: { amountMinor: 450, currency: "JPY" },
          availability: { state: "available" },
          lifecycle: { state: "listed", listedAt: CAFE_SCENARIO_TIMESTAMP },
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        storefront: {
          storefrontId: "storefront_cafe",
          revision: 1,
          name: "Cafe / Patisserie",
          salesChannelId: "sales_channel_cafe",
          fulfillment: {
            kind: "pickup",
            locationId: "location_cafe",
            readyLeadTimeSeconds: 900,
          },
          checkout: {
            quoteTtlSeconds: 600,
            tax: { kind: "percentage", basisPoints: 1_000 },
          },
          lifecycle: { state: "active", activeAt: CAFE_SCENARIO_TIMESTAMP },
        },
        consumptionPlan: {
          consumptionPlanId: "consumption_plan_sesame_cookie",
          variantId: "variant_sesame_cookie",
          revision: 1,
          scope: { kind: "location", locationId: "location_cafe" },
          mode: {
            kind: "direct",
            components: [
              {
                inventoryItemId: "inventory_sesame_cookie",
                quantity: { amount: 1, scale: 0, unit: "each" },
              },
            ],
            commitOn: "fulfillment_completed",
          },
          lifecycle: "active",
        },
      }),
      "sesame cookie storefront",
    );
    revision = requireDemoMutationRevision(
      this.#options.prepareCatalogListing({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "prepare_sesame_latte_catalog",
        ),
        schemaVersion: "underclerk.prepare-catalog-listing.v1",
        salesChannel: cafeScenarioSalesChannel(),
        product: {
          id: "product_sesame_latte",
          revision: 1,
          title: "Sesame Latte",
          description:
            "Black sesame, milk, and a lightly sweet rice-flour concentrate.",
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        variant: {
          id: "variant_sesame_latte",
          revision: 1,
          productId: "product_sesame_latte",
          sku: "SESAME-LATTE",
          title: "Sesame Latte",
          options: [],
          media: [],
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        offer: {
          id: "offer_sesame_latte_cafe",
          revision: 1,
          variantId: "variant_sesame_latte",
          salesChannelId: "sales_channel_cafe",
          price: { amountMinor: 700, currency: "JPY" },
          availability: { state: "available" },
          lifecycle: { state: "prepared", preparedAt: CAFE_SCENARIO_TIMESTAMP },
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        consumptionPlan: {
          consumptionPlanId: "consumption_plan_sesame_latte",
          variantId: "variant_sesame_latte",
          revision: 1,
          scope: { kind: "location", locationId: "location_cafe" },
          mode: {
            kind: "prepared",
            recipeId: "recipe_sesame_latte",
            recipeRevision: 1,
          },
          lifecycle: "active",
        },
      }),
      "sesame latte catalog",
    );
    revision = requireDemoMutationRevision(
      this.#options.publishCatalogListing({
        schemaVersion: "underclerk.publish-catalog-listing.v1",
        merchantId: command.merchantId,
        idempotencyKey: cafeScenarioKey("publish_sesame_latte_catalog"),
        requestedAt: CAFE_SCENARIO_TIMESTAMP,
        productId: "product_sesame_latte",
        productRevision: 1,
        variantId: "variant_sesame_latte",
        variantRevision: 1,
        offerId: "offer_sesame_latte_cafe",
        offerRevision: 1,
        salesChannelId: "sales_channel_cafe",
        salesChannelRevision: 1,
      }),
      "sesame latte publication",
    );
    revision = requireDemoMutationRevision(
      this.#options.prepareCatalogListing({
        ...cafeScenarioCommandBase(
          command,
          revision,
          "prepare_sesame_financier_catalog",
        ),
        schemaVersion: "underclerk.prepare-catalog-listing.v1",
        salesChannel: cafeScenarioSalesChannel(),
        product: {
          id: "product_sesame_financier",
          revision: 1,
          title: "Sesame Financier",
          description: "A tender almond financier finished with black sesame.",
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        variant: {
          id: "variant_sesame_financier",
          revision: 1,
          productId: "product_sesame_financier",
          sku: "SESAME-FINANCIER",
          title: "Sesame Financier",
          options: [],
          media: [],
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        offer: {
          id: "offer_sesame_financier_cafe",
          revision: 1,
          variantId: "variant_sesame_financier",
          salesChannelId: "sales_channel_cafe",
          price: { amountMinor: 500, currency: "JPY" },
          availability: { state: "available" },
          lifecycle: { state: "prepared", preparedAt: CAFE_SCENARIO_TIMESTAMP },
          occurredAt: CAFE_SCENARIO_TIMESTAMP,
        },
        consumptionPlan: {
          consumptionPlanId: "consumption_plan_sesame_financier",
          variantId: "variant_sesame_financier",
          revision: 1,
          scope: { kind: "location", locationId: "location_cafe" },
          mode: {
            kind: "prepared",
            recipeId: "recipe_sesame_financier",
            recipeRevision: 1,
          },
          lifecycle: "active",
        },
      }),
      "sesame financier catalog",
    );
    revision = requireDemoMutationRevision(
      this.#options.publishCatalogListing({
        schemaVersion: "underclerk.publish-catalog-listing.v1",
        merchantId: command.merchantId,
        idempotencyKey: cafeScenarioKey("publish_sesame_financier_catalog"),
        requestedAt: CAFE_SCENARIO_TIMESTAMP,
        productId: "product_sesame_financier",
        productRevision: 1,
        variantId: "variant_sesame_financier",
        variantRevision: 1,
        offerId: "offer_sesame_financier_cafe",
        offerRevision: 1,
        salesChannelId: "sales_channel_cafe",
        salesChannelRevision: 1,
      }),
      "sesame financier publication",
    );
    revision = this.#seedCafeExpansion(command, revision);
  }
  #seedCafeExpansion(
    command: ProvisionCommerceDemoV1,
    expectedMerchantRevision: number,
  ): number {
    let revision = expectedMerchantRevision;
    for (const ingredient of CAFE_EXPANSION_INGREDIENTS) {
      revision = this.#seedCafeIngredient(command, revision, ingredient);
    }
    for (const product of CAFE_EXPANSION_CATALOG) {
      if (product.kind !== "cookie") continue;
      revision = this.#seedCafeFinishedCookie(command, revision, product);
    }
    for (const recipe of CAFE_EXPANSION_RECIPES) {
      revision = requireDemoMutationRevision(
        this.#options.createRecipeRevision({
          ...cafeScenarioCommandBase(
            command,
            revision,
            `create_${recipe.recipeId}`,
          ),
          schemaVersion: "underclerk.create-recipe-revision.v1",
          recipeRevision: recipe,
        }),
        `${recipe.name} recipe`,
      );
    }
    for (const product of CAFE_EXPANSION_CATALOG) {
      revision = this.#seedCafeExpansionCatalog(command, revision, product);
    }
    return revision;
  }
  #seedCafeFinishedCookie(
    command: ProvisionCommerceDemoV1,
    expectedMerchantRevision: number,
    product: Variant<CafeExpansionCatalog, "cookie">,
  ): number {
    const itemRevision = requireDemoMutationRevision(
      this.#options.createInventoryItem({
        ...cafeScenarioCommandBase(
          command,
          expectedMerchantRevision,
          `create_${product.inventoryItemId}`,
        ),
        schemaVersion: "underclerk.create-inventory-item.v1",
        inventoryItemId: product.inventoryItemId,
        merchantCode: product.sku,
        name: product.title,
        baseUnit: "each",
        category: "finished_good",
        tracking: { kind: "lot_tracked", expiry: "required" },
      }),
      `${product.title} item`,
    );
    const positionId = `position_${product.inventoryItemId.replace(/^inventory_/, "")}_cafe`;
    const positionRevision = requireDemoMutationRevision(
      this.#options.openInventoryPosition({
        ...cafeScenarioCommandBase(
          command,
          itemRevision,
          `open_${product.inventoryItemId}_position`,
        ),
        schemaVersion: "underclerk.open-inventory-position.v1",
        inventoryPositionId: positionId,
        inventoryItemId: product.inventoryItemId,
        inventoryItemRevision: 1,
        locationId: "location_cafe",
        locationRevision: 1,
      }),
      `${product.title} position`,
    );
    return requireDemoMutationRevision(
      this.#options.receiveInventory({
        ...cafeScenarioCommandBase(
          command,
          positionRevision,
          `receive_${product.inventoryItemId}`,
        ),
        schemaVersion: "underclerk.receive-inventory.v3",
        purchase: { kind: "unlinked" },
        receiptId: `receipt_${product.inventoryItemId}`,
        receiptLineId: `receipt_line_${product.inventoryItemId}`,
        inventoryItemId: product.inventoryItemId,
        inventoryItemRevision: 1,
        inventoryPositionId: positionId,
        inventoryPositionRevision: 1,
        locationId: "location_cafe",
        receivedQuantity: { amount: 24, scale: 0, unit: "each" },
        lot: {
          kind: "tracked",
          lotId: `lot_${product.inventoryItemId}`,
          lotCode: `${product.sku}-20260814-A`,
          expiry: { kind: "expires", expiresAt: CAFE_SCENARIO_LOT_EXPIRY },
        },
        receivedAt: CAFE_SCENARIO_TIMESTAMP,
      }),
      `${product.title} receipt`,
    );
  }
  #seedCafeExpansionCatalog(
    command: ProvisionCommerceDemoV1,
    expectedMerchantRevision: number,
    product: CafeExpansionCatalog,
  ): number {
    const productId = `product_${product.slug}`;
    const variantId = `variant_${product.slug}`;
    const offerId = `offer_${product.slug}_cafe`;
    const consumptionPlan = cafeExpansionConsumptionPlan(product, variantId);
    const prepared = this.#options.prepareCatalogListing({
      ...cafeScenarioCommandBase(
        command,
        expectedMerchantRevision,
        `prepare_${product.slug}_catalog`,
      ),
      schemaVersion: "underclerk.prepare-catalog-listing.v1",
      salesChannel: cafeScenarioSalesChannel(),
      product: {
        id: productId,
        revision: 1,
        title: product.title,
        description: product.description,
        occurredAt: CAFE_SCENARIO_TIMESTAMP,
      },
      variant: {
        id: variantId,
        revision: 1,
        productId,
        sku: product.sku,
        title: product.title,
        options: [],
        media: [],
        occurredAt: CAFE_SCENARIO_TIMESTAMP,
      },
      offer: {
        id: offerId,
        revision: 1,
        variantId,
        salesChannelId: "sales_channel_cafe",
        price: { amountMinor: product.priceMinor, currency: "JPY" },
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: CAFE_SCENARIO_TIMESTAMP },
        occurredAt: CAFE_SCENARIO_TIMESTAMP,
      },
      consumptionPlan,
    });
    requireDemoMutationRevision(prepared, `${product.title} catalog`);
    return requireDemoMutationRevision(
      this.#options.publishCatalogListing({
        schemaVersion: "underclerk.publish-catalog-listing.v1",
        merchantId: command.merchantId,
        idempotencyKey: cafeScenarioKey(`publish_${product.slug}_catalog`),
        requestedAt: CAFE_SCENARIO_TIMESTAMP,
        productId,
        productRevision: 1,
        variantId,
        variantRevision: 1,
        offerId,
        offerRevision: 1,
        salesChannelId: "sales_channel_cafe",
        salesChannelRevision: 1,
      }),
      `${product.title} publication`,
    );
  }
  #seedCafeIngredient(
    command: ProvisionCommerceDemoV1,
    expectedMerchantRevision: number,
    ingredient: CafeScenarioIngredient,
  ): number {
    const itemRevision = requireDemoMutationRevision(
      this.#options.createInventoryItem({
        ...cafeScenarioCommandBase(
          command,
          expectedMerchantRevision,
          `create_${ingredient.inventoryItemId}`,
        ),
        schemaVersion: "underclerk.create-inventory-item.v1",
        inventoryItemId: ingredient.inventoryItemId,
        merchantCode: ingredient.merchantCode,
        name: ingredient.name,
        baseUnit: ingredient.unit,
        category: "ingredient",
        tracking: { kind: "lot_tracked", expiry: "required" },
      }),
      `${ingredient.name} item`,
    );
    const positionId = `position_${ingredient.inventoryItemId}_cafe`;
    const positionRevision = requireDemoMutationRevision(
      this.#options.openInventoryPosition({
        ...cafeScenarioCommandBase(
          command,
          itemRevision,
          `open_${ingredient.inventoryItemId}_position`,
        ),
        schemaVersion: "underclerk.open-inventory-position.v1",
        inventoryPositionId: positionId,
        inventoryItemId: ingredient.inventoryItemId,
        inventoryItemRevision: 1,
        locationId: "location_cafe",
        locationRevision: 1,
      }),
      `${ingredient.name} position`,
    );
    return requireDemoMutationRevision(
      this.#options.receiveInventory({
        ...cafeScenarioCommandBase(
          command,
          positionRevision,
          `receive_${ingredient.inventoryItemId}`,
        ),
        schemaVersion: "underclerk.receive-inventory.v3",
        purchase: { kind: "unlinked" },
        receiptId: `receipt_${ingredient.inventoryItemId}`,
        receiptLineId: `receipt_line_${ingredient.inventoryItemId}`,
        inventoryItemId: ingredient.inventoryItemId,
        inventoryItemRevision: 1,
        inventoryPositionId: positionId,
        inventoryPositionRevision: 1,
        locationId: "location_cafe",
        receivedQuantity: {
          amount: ingredient.amount,
          scale: ingredient.scale,
          unit: ingredient.unit,
        },
        lot: {
          kind: "tracked",
          lotId: `lot_${ingredient.inventoryItemId}`,
          lotCode: `${ingredient.merchantCode}-20260814-A`,
          expiry: { kind: "expires", expiresAt: CAFE_SCENARIO_LOT_EXPIRY },
        },
        receivedAt: CAFE_SCENARIO_TIMESTAMP,
      }),
      `${ingredient.name} receipt`,
    );
  }
  #seedCafeStation(
    command: ProvisionCommerceDemoV1,
    expectedMerchantRevision: number,
    stationId: string,
    name: string,
  ): number {
    return requireDemoMutationRevision(
      this.#options.createPreparationStation({
        ...cafeScenarioCommandBase(
          command,
          expectedMerchantRevision,
          `create_${stationId}`,
        ),
        schemaVersion: "underclerk.create-preparation-station.v1",
        station: { stationId, locationId: "location_cafe", name },
      }),
      name,
    );
  }
}

function requireDemoMutationRevision(
  result: CommerceMutationResultV1,
  resource: string,
): number {
  if (result.outcome === "rejected") {
    throw new Error(`Demo ${resource} seed rejected: ${result.error.code}`);
  }
  return result.receipt.merchantRevision;
}

function hasCafeScenarioSetup(
  snapshot: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceResourcesV1,
): boolean {
  return (
    snapshot.merchantRevision >= 93 &&
    snapshot.resources.inventoryItems.length >= 18 &&
    snapshot.resources.inventoryPositions.length >= 18 &&
    snapshot.resources.locations.some(
      resourceHasId.bind(undefined, "location_cafe"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_sesame_cookie"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_oat_milk"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_black_sesame"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_glutinous_rice_flour"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_water"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_salt"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_almond_flour"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_ginger"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_assam_tea"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_taro_powder"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_matcha_powder"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_ginger_cookie"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_taro_cookie"),
    ) &&
    snapshot.resources.inventoryItems.some(
      resourceHasId.bind(undefined, "inventory_matcha_cookie"),
    ) &&
    snapshot.resources.inventoryPositions.some(
      resourceHasId.bind(undefined, "position_sesame_cookie_cafe"),
    ) &&
    snapshot.resources.inventoryPositions.some(
      resourceHasId.bind(undefined, "position_oat_milk_cafe"),
    ) &&
    snapshot.resources.inventoryPositions.some(
      resourceHasId.bind(undefined, "position_ginger_cookie_cafe"),
    ) &&
    snapshot.resources.inventoryPositions.some(
      resourceHasId.bind(undefined, "position_taro_cookie_cafe"),
    ) &&
    snapshot.resources.inventoryPositions.some(
      resourceHasId.bind(undefined, "position_matcha_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_latte_cafe"),
    ) &&
    snapshot.resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_financier_cafe"),
    ) &&
    CAFE_EXPANSION_CATALOG.every((product) =>
      snapshot.resources.offers.some(
        resourceHasId.bind(undefined, `offer_${product.slug}_cafe`),
      ),
    ) &&
    foodService.recipeRevisions.some(
      recipeHasId.bind(undefined, "recipe_sesame_cookie_stocked"),
    ) &&
    foodService.recipeRevisions.some(
      recipeHasId.bind(undefined, "recipe_sesame_latte"),
    ) &&
    foodService.recipeRevisions.some(
      recipeHasId.bind(undefined, "recipe_sesame_financier"),
    ) &&
    CAFE_EXPANSION_RECIPES.every((recipe) =>
      foodService.recipeRevisions.some(
        recipeHasId.bind(undefined, recipe.recipeId),
      ),
    ) &&
    foodService.preparationStations.some(
      stationHasId.bind(undefined, "station_bakery"),
    ) &&
    foodService.preparationStations.some(
      stationHasId.bind(undefined, "station_bar"),
    ) &&
    foodService.modifierGroupRevisions.some(
      modifierGroupHasId.bind(undefined, "modifier_group_milk"),
    ) &&
    foodService.stockPolicies.some(
      stockPolicyHasId.bind(undefined, "stock_policy_oat_milk_cafe"),
    )
  );
}

function cafeScenarioStartingRevision(
  snapshot: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceResourcesV1,
  lots: readonly CommerceInventoryLotV1[],
  movements: readonly CommerceInventoryMovementV1[],
): CafeScenarioStartingRevision | undefined {
  if (
    snapshot.merchantRevision === 0 &&
    !hasCommerceResources(snapshot.resources) &&
    !hasFoodServiceResources(foodService) &&
    lots.length === 0 &&
    movements.length === 0
  ) {
    return 0;
  }
  if (isExactCafePhase1Baseline(snapshot, foodService, lots, movements))
    return 6;
  if (isExactSesameCafeBaseline(snapshot, foodService, lots, movements)) {
    if (snapshot.merchantRevision === 45) return 45;
    if (snapshot.merchantRevision === 47) return 47;
  }
  return undefined;
}

function isExactSesameCafeBaseline(
  snapshot: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceResourcesV1,
  lots: readonly CommerceInventoryLotV1[],
  movements: readonly CommerceInventoryMovementV1[],
): boolean {
  const resources = snapshot.resources;
  const expectedInventoryIds =
    snapshot.merchantRevision === 45
      ? [
          "inventory_sesame_cookie",
          "inventory_oat_milk",
          "inventory_flour",
          "inventory_butter",
          "inventory_sugar",
          "inventory_whole_milk",
          "inventory_black_sesame",
          "inventory_glutinous_rice_flour",
          "inventory_water",
          "inventory_salt",
          "inventory_almond_flour",
        ]
      : [
          "inventory_cookie",
          "inventory_sesame_cookie",
          "inventory_oat_milk",
          "inventory_flour",
          "inventory_butter",
          "inventory_sugar",
          "inventory_whole_milk",
          "inventory_black_sesame",
          "inventory_glutinous_rice_flour",
          "inventory_water",
          "inventory_salt",
          "inventory_almond_flour",
        ];
  return (
    (snapshot.merchantRevision === 45 || snapshot.merchantRevision === 47) &&
    resourceIdsMatch(resources.inventoryItems, expectedInventoryIds) &&
    resources.inventoryPositions.length === expectedInventoryIds.length &&
    resources.products.length === 3 &&
    resources.variants.length === 3 &&
    resources.offers.length === 3 &&
    resources.orders.length === 0 &&
    resources.payments.length === 0 &&
    resources.fulfillments.length === 0 &&
    resources.shipments.length === 0 &&
    lots.length === 10 &&
    movements.length === 10 &&
    foodService.menus.length === 0 &&
    foodService.recipeRevisions.length === 3 &&
    foodService.preparationStations.length === 2 &&
    foodService.modifierGroupRevisions.length === 1 &&
    foodService.stockPolicies.length === 1 &&
    resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_cookie_cafe"),
    ) &&
    resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_latte_cafe"),
    ) &&
    resources.offers.some(
      resourceHasId.bind(undefined, "offer_sesame_financier_cafe"),
    )
  );
}

function isExactCafePhase1Baseline(
  snapshot: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceResourcesV1,
  lots: readonly CommerceInventoryLotV1[],
  movements: readonly CommerceInventoryMovementV1[],
): boolean {
  const resources = snapshot.resources;
  if (
    snapshot.merchantRevision !== 6 ||
    hasFoodServiceResources(foodService) ||
    !resourceIdsMatch(resources.locations, ["location_cafe"]) ||
    !resourceIdsMatch(resources.inventoryItems, [
      "inventory_cookie",
      "inventory_oat_milk",
    ]) ||
    !resourceIdsMatch(resources.inventoryPositions, [
      "position_cookie_cafe",
      "position_oat_milk_cafe",
    ]) ||
    resources.salesChannels.length !== 0 ||
    resources.products.length !== 0 ||
    resources.variants.length !== 0 ||
    resources.offers.length !== 0 ||
    resources.orders.length !== 0 ||
    resources.payments.length !== 0 ||
    resources.fulfillments.length !== 0 ||
    resources.shipments.length !== 0 ||
    lots.length !== 1 ||
    movements.length !== 1
  ) {
    return false;
  }
  const location = findResource(resources.locations, "location_cafe");
  const cookie = findResource(resources.inventoryItems, "inventory_cookie");
  const oatMilk = findResource(resources.inventoryItems, "inventory_oat_milk");
  const cookiePosition = findResource(
    resources.inventoryPositions,
    "position_cookie_cafe",
  );
  const oatMilkPosition = findResource(
    resources.inventoryPositions,
    "position_oat_milk_cafe",
  );
  const lot = lots[0];
  const movement = movements[0];
  if (
    location === undefined ||
    cookie === undefined ||
    oatMilk === undefined ||
    cookiePosition === undefined ||
    oatMilkPosition === undefined ||
    lot === undefined ||
    movement === undefined
  ) {
    return false;
  }
  return (
    location.revision === 1 &&
    location.name === "Cafe / Patisserie" &&
    location.kind === "store" &&
    location.lifecycle.state === "active" &&
    cookie.revision === 1 &&
    cookie.merchantCode === "COOKIE" &&
    cookie.baseUnit === "each" &&
    cookie.category === "finished_good" &&
    cookie.tracking.kind === "lot_tracked" &&
    cookie.tracking.expiry === "required" &&
    cookie.lifecycle === "active" &&
    oatMilk.revision === 1 &&
    oatMilk.merchantCode === "OAT-MILK" &&
    oatMilk.baseUnit === "milliliter" &&
    oatMilk.category === "ingredient" &&
    oatMilk.tracking.kind === "lot_tracked" &&
    oatMilk.tracking.expiry === "required" &&
    oatMilk.lifecycle === "active" &&
    positionMatches(cookiePosition, "inventory_cookie", 1, 0, "each") &&
    positionMatches(
      oatMilkPosition,
      "inventory_oat_milk",
      2,
      8_000,
      "milliliter",
    ) &&
    receiptMovementMatches(movement) &&
    cafePhase1LotMatches(lot, movement.id)
  );
}

function resourceIdsMatch(
  resources: readonly Readonly<{ id: string }>[],
  expectedIds: readonly string[],
): boolean {
  if (resources.length !== expectedIds.length) return false;
  for (const expectedId of expectedIds) {
    if (findResource(resources, expectedId) === undefined) return false;
  }
  return true;
}

function positionMatches(
  position: CommerceInventoryPositionV1,
  inventoryItemId: string,
  revision: number,
  onHand: number,
  unit: CommerceQuantityV1["unit"],
): boolean {
  return (
    position.revision === revision &&
    position.inventoryItemId === inventoryItemId &&
    position.locationId === "location_cafe" &&
    position.balance.kind === "accounted" &&
    quantityMatches(position.balance.onHand, onHand, unit) &&
    quantityMatches(position.balance.allocated, 0, unit) &&
    quantityMatches(position.balance.available, onHand, unit)
  );
}

function receiptMovementMatches(
  movement: CommerceInventoryMovementV1,
): boolean {
  return (
    movement.inventoryItemId === "inventory_oat_milk" &&
    movement.locationId === "location_cafe" &&
    movement.change.kind === "increase" &&
    movement.change.reason.kind === "receipt" &&
    movement.change.reason.receiptId === "receipt_oat_milk" &&
    movement.change.reason.receiptLineId === "receipt_line_oat_milk_accepted" &&
    quantityMatches(movement.change.quantity, 8_000, "milliliter")
  );
}

function cafePhase1LotMatches(
  lot: CommerceInventoryLotV1,
  sourceMovementId: string,
): boolean {
  return (
    lot.id === "lot_receipt_line_oat_milk_accepted" &&
    lot.lotCode === "OAT-20260814-A" &&
    lot.inventoryItemId === "inventory_oat_milk" &&
    lot.locationId === "location_cafe" &&
    lot.revision === 1 &&
    lot.sourceMovementId === sourceMovementId &&
    quantityMatches(lot.receivedQuantity, 8_000, "milliliter") &&
    quantityMatches(lot.remainingQuantity, 8_000, "milliliter") &&
    lot.expiry.kind === "expires" &&
    lot.expiry.expiresAt === CAFE_SCENARIO_LOT_EXPIRY &&
    lot.lifecycle.state === "available"
  );
}

function quantityMatches(
  quantity: CommerceQuantityV1,
  amount: number,
  unit: CommerceQuantityV1["unit"],
): boolean {
  return (
    quantity.amount === amount && quantity.scale === 0 && quantity.unit === unit
  );
}

function hasFoodServiceResources(
  resources: CommerceFoodServiceResourcesV1,
): boolean {
  return (
    resources.menus.length > 0 ||
    resources.modifierGroupRevisions.length > 0 ||
    resources.recipeRevisions.length > 0 ||
    resources.preparationStations.length > 0 ||
    resources.preparationTickets.length > 0 ||
    resources.productionBatches.length > 0 ||
    resources.stockPolicies.length > 0
  );
}

function resourceHasId(
  resourceId: string,
  resource: Readonly<{ id: string }>,
): boolean {
  return resource.id === resourceId;
}

function recipeHasId(
  recipeId: string,
  recipe: CommerceFoodServiceResourcesV1["recipeRevisions"][number],
): boolean {
  return recipe.recipeId === recipeId;
}

function stationHasId(
  stationId: string,
  station: CommerceFoodServiceResourcesV1["preparationStations"][number],
): boolean {
  return station.stationId === stationId;
}

function modifierGroupHasId(
  modifierGroupId: string,
  group: CommerceFoodServiceResourcesV1["modifierGroupRevisions"][number],
): boolean {
  return group.modifierGroupId === modifierGroupId;
}

function stockPolicyHasId(
  stockPolicyId: string,
  policy: CommerceFoodServiceResourcesV1["stockPolicies"][number],
): boolean {
  return policy.stockPolicyId === stockPolicyId;
}

function cafeExpansionConsumptionPlan(
  product: CafeExpansionCatalog,
  variantId: string,
): InventoryConsumptionPlan {
  if (product.kind === "cookie") {
    return {
      consumptionPlanId: product.consumptionPlanId,
      variantId,
      revision: 1,
      scope: { kind: "location", locationId: "location_cafe" },
      mode: {
        kind: "direct",
        components: [
          {
            inventoryItemId: product.inventoryItemId,
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
        ],
        commitOn: "fulfillment_completed",
      },
      lifecycle: "active",
    };
  }
  return {
    consumptionPlanId: product.consumptionPlanId,
    variantId,
    revision: 1,
    scope: { kind: "location", locationId: "location_cafe" },
    mode: { kind: "prepared", recipeId: product.recipeId, recipeRevision: 1 },
    lifecycle: "active",
  };
}

function cafeScenarioCommandBase(
  command: ProvisionCommerceDemoV1,
  expectedMerchantRevision: number,
  operation: string,
) {
  const idempotencyKey = cafeScenarioKey(operation);
  return {
    merchantId: command.merchantId,
    expectedMerchantRevision,
    idempotencyKey,
    requestedAt: CAFE_SCENARIO_TIMESTAMP,
  };
}

function cafeScenarioKey(operation: string): string {
  return `scenario_cafe_patisserie_v2:${operation}:1`;
}

function cafeScenarioLocation(): CommerceLocationV1 {
  return {
    id: "location_cafe",
    revision: 1,
    name: "Cafe / Patisserie",
    kind: "store",
    lifecycle: { state: "active", activeAt: CAFE_SCENARIO_TIMESTAMP },
    occurredAt: CAFE_SCENARIO_TIMESTAMP,
  };
}

function cafeScenarioSalesChannel(): CommerceResourcesV1["salesChannels"][number] {
  return {
    id: "sales_channel_cafe",
    revision: 1,
    name: "Cafe storefront",
    kind: "online",
    lifecycle: { state: "active", activeAt: CAFE_SCENARIO_TIMESTAMP },
    occurredAt: CAFE_SCENARIO_TIMESTAMP,
  };
}
