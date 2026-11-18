// Plan 77 step 3: pausing the food service plugin stops the café's menu at
// checkout, not only its kitchen routes. While it is paused a buyer sees no
// menu, a new menu line is refused, a latte quoted before the pause cannot
// be refreshed, and tea from the catalog still sells;
// after a resume the latte is on the menu again and sells. Set
// FOOD_SERVICE_PAUSE_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type { RecipeRevision } from "@seams/commerce-contracts";
import type { CommerceAdminClient } from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogFor,
  catalogLine,
  latteEntry,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const LATTE = {
  kind: "menu" as const,
  menuId: "menu_cafe_main",
  menuEntryId: "menu_entry_sesame_latte",
  modifierOptionIds: [],
  quantity: 1,
};

it(
  "preserves pinned recipes through edits and stops menu sales while the plugin is paused",
  { timeout: 60_000 },
  foodServicePause,
);

async function foodServicePause(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new PauseDesk(admin);
    await staff.createTea();
    expect(latteEntry(await catalogFor(buyer))?.availability).toBe("available");

    // Kai quotes a latte before the pause.
    const kai = await Buyer.start(buyer, "pause_kai");
    const kaiQuote = await kai.quote([LATTE]);

    const snapshot = await required(admin.readStockSnapshot(merchantId));
    const recipe =
      snapshot.foodService.resources.recipeRevisions.find(isLatteRecipe);
    if (recipe === undefined) throw new Error("Latte recipe missing");
    expect(
      await required(
        admin.createRecipeRevision({
          merchantId,
          expectedMerchantRevision: snapshot.commerce.merchantRevision,
          idempotencyKey: "latte-revision",
          recipeRevision: {
            recipeId: recipe.recipeId,
            name: "Revised sesame latte",
            inputs: recipe.inputs,
            output: recipe.output,
          },
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(latteEntry(await catalogFor(buyer))?.availability).toBe("available");

    const revision = await staff.revision();
    expect(await staff.pause(revision)).toMatchObject({ outcome: "applied" });
    // Kai's quote cannot be refreshed while the menu is paused.
    const refreshed = await kai.refresh(kaiQuote, [LATTE]).then(
      () => "refreshed",
      (error: unknown) => String(error),
    );
    expect(refreshed).toContain('"field":"checkout.menu"');
    // No menu shows, a menu line is refused, and tea still sells.
    const paused = await catalogFor(buyer);
    expect(paused.menus).toEqual([]);
    const refused = await (
      await Buyer.start(buyer, "pause_latte")
    ).tryQuote([LATTE]);
    expect(refused).toMatchObject({
      kind: "refused",
      error: { code: "resource_relationship_invalid" },
    });
    const tea = await (
      await Buyer.start(buyer, "pause_tea")
    ).buyLines([catalogLine(SMALL_SENCHA)]);
    expect(tea).toMatch(/^order_/u);

    // After a resume the latte is on the menu again and sells.
    expect(await staff.resume(revision + 1)).toMatchObject({
      outcome: "applied",
    });
    expect(latteEntry(await catalogFor(buyer))?.availability).toBe("available");
    const latte = await (
      await Buyer.start(buyer, "resumed_latte")
    ).buyLines([LATTE]);
    expect(latte).toMatch(/^order_/u);

    Object.assign(evidence, {
      receipts: staff.receipts,
      refused,
      refreshed,
      pausedMenus: paused.menus,
    });
  } finally {
    writeEvidence(
      "FOOD_SERVICE_PAUSE_ARTIFACT_DIR",
      "food-service-pause",
      evidence,
    );
    backend.close();
  }
}

class PauseDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "food_service_pause");
  }

  async revision(): Promise<number> {
    const plugin = (
      await required(this.admin.listPlugins(merchantId))
    ).plugins.find((item) => item.pluginId === "food_service");
    if (plugin === undefined) throw new Error("Food service is missing");
    return plugin.revision;
  }

  pause(expectedRevision: number) {
    return this.edit(
      this.admin.pausePlugin({
        ...this.editBase("pause_food_service"),
        pluginId: "food_service",
        expectedRevision,
      }),
    );
  }

  resume(expectedRevision: number) {
    return this.edit(
      this.admin.resumePlugin({
        ...this.editBase("resume_food_service"),
        pluginId: "food_service",
        expectedRevision,
      }),
    );
  }
}

function isLatteRecipe(recipe: RecipeRevision): boolean {
  return recipe.recipeId === "recipe_sesame_latte";
}
