import { parseRecipeWrite } from "@purin-labs/kitchen-control-api";
import type { RecipeRevision } from "@purin-labs/commerce-contracts";
import { recipeCollectionOf } from "../../commerce/recipe-commands";
import type { Env } from "../../env";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  resolveInventoryAccess,
  resolveInventoryMutation,
  finishInventoryOperation,
} from "../../kitchen/contract/inventory-control";

export async function handleRecipes(
  request: Request,
  env: Env,
  organisationId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationId,
    request.method === "GET" ? "viewer" : "operator",
  );
  if (!access.ok) return access.response;
  if (request.method === "GET") {
    const snapshot = await access.value.client.readStockSnapshot(
      access.value.binding.merchantId,
    );
    if (!snapshot.ok) return controlError("commerce_unavailable", 503);
    if (snapshot.value.commerce.merchantId !== access.value.binding.merchantId)
      return controlError("commerce_scope_mismatch", 502);
    return controlJson(recipeCollectionOf(snapshot.value));
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("recipe_invalid", 422);
  let action;
  try {
    action = parseRecipeWrite(body.value);
  } catch {
    return controlError("recipe_invalid", 422);
  }
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    `recipe.${action.kind}`,
  );
  if (!mutation.ok) return mutation.response;
  const snapshot = await mutation.value.client.readStockSnapshot(
    mutation.value.binding.merchantId,
  );
  if (!snapshot.ok) return controlError("commerce_unavailable", 503);
  if (snapshot.value.commerce.merchantId !== mutation.value.binding.merchantId)
    return controlError("commerce_scope_mismatch", 502);
  const current = snapshot.value.foodService.resources.recipeRevisions.find(
    recipeIdentity.bind(null, action.recipe.recipeId),
  );
  // Let Commerce replay an accepted command if the Portal receipt was lost.
  if (
    snapshot.value.commerce.merchantRevision === action.merchantRevision &&
    (action.kind === "create"
      ? current !== undefined
      : current?.revision !== action.expectedRecipeRevision)
  )
    return controlError("stale_resource_revision", 409);
  const result = await mutation.value.client.createRecipeRevision({
    merchantId: mutation.value.binding.merchantId,
    expectedMerchantRevision: action.merchantRevision,
    idempotencyKey: mutation.value.boundary.idempotencyKey,
    recipeRevision: action.recipe,
  });
  if (!result.ok) return controlError("commerce_unavailable", 503);
  if (result.value.outcome === "rejected")
    return controlJson({ ok: false, error: result.value.error.code }, 409);
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    result: result.value,
  });
}

function recipeIdentity(id: string, recipe: RecipeRevision): boolean {
  return recipe.recipeId === id;
}
