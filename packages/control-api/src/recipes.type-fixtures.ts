import type { RecipeWrite } from "./recipes";

declare const recipe: RecipeWrite["recipe"];
declare function acceptRecipeWrite(value: RecipeWrite): void;

// An edit always carries the recipe revision that the operator read.
// @ts-expect-error Missing the recipe revision.
acceptRecipeWrite({
  kind: "edit",
  merchantRevision: 1,
  requestedAt: "2026-10-25T00:00:00Z",
  recipe,
});

// @ts-expect-error Creation cannot carry an edit revision.
acceptRecipeWrite({
  kind: "create",
  merchantRevision: 1,
  expectedRecipeRevision: 1,
  requestedAt: "2026-10-25T00:00:00Z",
  recipe,
});

const editFields = {
  merchantRevision: 1,
  expectedRecipeRevision: 1,
  requestedAt: "2026-10-25T00:00:00Z",
  recipe,
};
// @ts-expect-error A broad spread cannot turn edit fields into a creation.
acceptRecipeWrite({ ...editFields, kind: "create" });
