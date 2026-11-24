import type { RecipeRevision } from "@purin-labs/commerce-contracts";

// The recipe save of the Kitchen recipe library, as the Kitchen tool services
// name it. A part of the Kitchen contract.

/** What a save asks for. A null recipe revision means a new recipe. */
export type RecipeDraft = Readonly<{
  recipeId: string;
  expectedRecipeRevision: number | null;
  name: string;
  inputs: RecipeRevision["inputs"];
  output: RecipeRevision["output"];
}>;
