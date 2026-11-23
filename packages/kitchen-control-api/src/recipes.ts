import { Type, type Static } from "typebox";
import { recordParser, PositiveInteger } from "@purin-labs/contract-schema";
import {
  recipeRevisionInputSchema,
  recipeRevisionResourceSchema,
} from "@purin-labs/commerce-contracts/records/api-food-service";

const text = Type.String({ minLength: 1 });
const revision = PositiveInteger;
const itemSchema = Type.Object({
  id: text,
  name: text,
  baseUnit: Type.Union([
    Type.Literal("each"),
    Type.Literal("gram"),
    Type.Literal("kilogram"),
    Type.Literal("milliliter"),
    Type.Literal("liter"),
  ]),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
});
const collectionSchema = Type.Object({
  ok: Type.Literal(true),
  merchantRevision: revision,
  recipes: Type.Array(recipeRevisionResourceSchema),
  items: Type.Array(itemSchema),
});
const writeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("create"),
    merchantRevision: revision,
    requestedAt: Type.String({ minLength: 1 }),
    expectedRecipeRevision: Type.Optional(Type.Never()),
    recipe: recipeRevisionInputSchema,
  }),
  Type.Object({
    kind: Type.Literal("edit"),
    merchantRevision: revision,
    requestedAt: Type.String({ minLength: 1 }),
    expectedRecipeRevision: revision,
    recipe: recipeRevisionInputSchema,
  }),
]);
export type RecipeCollection = Static<typeof collectionSchema>;
export type RecipeWrite = Static<typeof writeSchema>;
export type RecipeItem = RecipeCollection["items"][number];

const decodeCollection = recordParser(collectionSchema);
const decodeWrite = recordParser(writeSchema);

export function parseRecipeCollection(value: unknown): RecipeCollection {
  const result = decodeCollection(value);
  if (!result.ok) throw new Error("Recipes could not be read.");
  return result.value;
}

export function parseRecipeWrite(value: unknown): RecipeWrite {
  const result = decodeWrite(value);
  if (!result.ok) throw new Error("The recipe is invalid.");
  if (!Number.isFinite(Date.parse(result.value.requestedAt)))
    throw new Error("The recipe save time is invalid.");
  const recipe = result.value.recipe;
  const ids = new Set<string>();
  if (recipe.inputs.length === 0)
    throw new Error("Add at least one ingredient.");
  for (const input of recipe.inputs) {
    if (ids.has(input.inventoryItemId))
      throw new Error("Choose each ingredient only once.");
    if (input.quantity.amount <= 0)
      throw new Error("Enter a positive ingredient quantity.");
    ids.add(input.inventoryItemId);
  }
  if (
    recipe.output.kind === "stocked" &&
    recipe.output.yieldQuantity.amount <= 0
  )
    throw new Error("Enter a positive batch yield.");
  return result.value;
}
