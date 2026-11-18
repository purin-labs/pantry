import type { Quantity } from "@seams/contracts";
import type { ControlMutationIntent } from "../../control-client";
export type RecipeMutation = (
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
) => Promise<unknown>;
export function recipesPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/recipes`;
}
export function quantityText(quantity: Quantity): string {
  return String(quantity.amount / 10 ** quantity.scale);
}
export function recipeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Recipes are unavailable. Try again.";
}
