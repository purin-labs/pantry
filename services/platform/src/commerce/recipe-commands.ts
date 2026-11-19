import {
  parseRecipeWrite,
  type RecipeCollection,
  type RecipeItem,
} from "@purin-labs/control-api";
import type {
  CommerceAdminClient,
  CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import type { RecipeRevision } from "@purin-labs/contracts";
import { canonicalJson } from "@purin-labs/std";

/**
 * The recipe library (Kitchen › Recipes). A person's page and the Portal
 * chat agent (Plan 81) read it here and save through the same Commerce
 * command and input checks. A save makes a new revision: earlier production
 * keeps the revision that it used.
 */
type RecipeContext = Readonly<{
  client: CommerceAdminClient;
  merchantId: string;
}>;

/** What a save asks for. A null recipe revision means a new recipe. */
export type RecipeDraft = Readonly<{
  recipeId: string;
  expectedRecipeRevision: number | null;
  name: string;
  inputs: RecipeRevision["inputs"];
  output: RecipeRevision["output"];
}>;

export type RecipeSaveResult =
  | Readonly<{ ok: true; recipeId: string; revision: number }>
  | Readonly<{
      ok: false;
      code: "underclerk_unavailable" | "recipe_changed" | "recipe_busy";
    }>
  | Readonly<{ ok: false; code: "recipe_invalid"; detail: string }>
  | Readonly<{
      ok: false;
      code: "recipe_refused";
      detail: string;
      field: string | null;
    }>;

/** One try, and a repeat for each sale that moves the merchant's revision. */
const SAVE_ATTEMPT_LIMIT = 4;

export function recipeCollectionOf(
  snapshot: CommerceStockSnapshot,
): RecipeCollection {
  return {
    ok: true,
    merchantRevision: snapshot.commerce.merchantRevision,
    recipes: [...snapshot.foodService.resources.recipeRevisions],
    items: snapshot.commerce.resources.inventoryItems.map(recipeItem),
  };
}

/**
 * Saves from a call that may repeat after a lost process: `idempotencyKey`
 * stays the same, and the merchant's revision may not. The recipe's revision
 * refuses a stale edit. A recipe that already holds this draft at the next
 * revision is this call's own earlier save, so it runs nothing.
 */
export async function saveRecipeDraft(
  context: RecipeContext,
  draft: RecipeDraft,
  idempotencyKey: string,
): Promise<RecipeSaveResult> {
  const recipe = {
    recipeId: draft.recipeId,
    name: draft.name,
    inputs: draft.inputs,
    output: draft.output,
  };
  for (let attempt = 0; attempt < SAVE_ATTEMPT_LIMIT; attempt += 1) {
    const snapshot = await context.client.readStockSnapshot(context.merchantId);
    if (!snapshot.ok) return { ok: false, code: "underclerk_unavailable" };
    const current = snapshot.value.foodService.resources.recipeRevisions.find(
      (candidate) => candidate.recipeId === draft.recipeId,
    );
    const next = (draft.expectedRecipeRevision ?? 0) + 1;
    if ((current?.revision ?? 0) !== next - 1)
      return current?.revision === next && sameRecipe(current, draft)
        ? { ok: true, recipeId: draft.recipeId, revision: next }
        : { ok: false, code: "recipe_changed" };
    const merchantRevision = snapshot.value.commerce.merchantRevision;
    const requestedAt = new Date().toISOString();
    let action;
    try {
      action = parseRecipeWrite(
        draft.expectedRecipeRevision === null
          ? { kind: "create", merchantRevision, requestedAt, recipe }
          : {
              kind: "edit",
              merchantRevision,
              requestedAt,
              expectedRecipeRevision: draft.expectedRecipeRevision,
              recipe,
            },
      );
    } catch (error) {
      return {
        ok: false,
        code: "recipe_invalid",
        detail:
          error instanceof Error ? error.message : "The recipe is invalid.",
      };
    }
    const result = await context.client.createRecipeRevision({
      merchantId: context.merchantId,
      expectedMerchantRevision: action.merchantRevision,
      idempotencyKey: `${idempotencyKey}_${attempt}`,
      recipeRevision: action.recipe,
    });
    if (!result.ok) return { ok: false, code: "underclerk_unavailable" };
    if (result.value.outcome !== "rejected")
      return { ok: true, recipeId: draft.recipeId, revision: next };
    if (result.value.error.code !== "stale_merchant_revision")
      return {
        ok: false,
        code: "recipe_refused",
        detail: result.value.error.code,
        field: "field" in result.value.error ? result.value.error.field : null,
      };
  }
  return { ok: false, code: "recipe_busy" };
}

function sameRecipe(current: RecipeRevision, draft: RecipeDraft): boolean {
  return (
    current.name === draft.name &&
    canonicalJson(current.inputs) === canonicalJson(draft.inputs) &&
    canonicalJson(current.output) === canonicalJson(draft.output)
  );
}

function recipeItem(
  item: CommerceStockSnapshot["commerce"]["resources"]["inventoryItems"][number],
): RecipeItem {
  return {
    id: item.id,
    name: item.name,
    baseUnit: item.baseUnit,
    lifecycle: item.lifecycle,
  };
}
