import { hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type { RecipeSaveRequest } from "./services";
import type { RecipeDraft } from "../../commerce/recipe-commands";
import { jsonSchema } from "../define-tool";
import { defineKitchenTool } from "./services";
import { ProposalArgumentError } from "../errors";

type RecipeQuantity = RecipeDraft["inputs"][number]["quantity"];

const RECIPE_QUANTITY_PARAMETER = {
  type: "object",
  properties: {
    amount: { type: "integer" },
    scale: { type: "integer", minimum: 0, maximum: 9 },
    unit: {
      type: "string",
      enum: ["each", "gram", "kilogram", "milliliter", "liter"],
    },
  },
  required: ["amount", "scale", "unit"],
  additionalProperties: false,
} as const;

export const recipeRead = defineKitchenTool({
  name: "recipe_read",
  description:
    "Read the shop's recipes, as staff see them on the Recipes page: each recipe's recipeId, latest revision, name, ingredients and output, and the stock items that a recipe can use with their ids and base units.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decode: () => null,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "recipe read is unavailable",
  handler: ({ readRecipes }) =>
    readRecipes === undefined ? undefined : () => readRecipes(),
});

export const recipeSave = defineKitchenTool({
  name: "recipe_save",
  description:
    "Add a recipe, or save a new revision of one, as staff do on the Recipes page. Give the whole recipe, because a save replaces it. " +
    "To edit, give recipeId and expectedRecipeRevision from recipe_read. To add, set both to null. " +
    "A quantity uses amount and scale, where the value is amount / 10^scale, and the base unit of its item. An immediate output sets inventoryItemId and yieldQuantity to null. A stocked output gives both. " +
    "Say what you will change before you save, unless the person gave the exact change. A save moves no stock and no money. Earlier production keeps its revision, and new production can use this one.",
  input: jsonSchema({
    type: "object",
    properties: {
      recipeId: {
        type: ["string", "null"],
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      expectedRecipeRevision: { type: ["integer", "null"], minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 200 },
      inputs: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            inventoryItemId: {
              type: "string",
              pattern: "^[A-Za-z0-9_:-]{1,128}$",
            },
            quantity: RECIPE_QUANTITY_PARAMETER,
          },
          required: ["inventoryItemId", "quantity"],
          additionalProperties: false,
        },
      },
      output: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["immediate", "stocked"] },
          inventoryItemId: {
            type: ["string", "null"],
            pattern: "^[A-Za-z0-9_:-]{1,128}$",
          },
          yieldQuantity: {
            ...RECIPE_QUANTITY_PARAMETER,
            type: ["object", "null"],
          },
        },
        required: ["kind", "inventoryItemId", "yieldQuantity"],
        additionalProperties: false,
      },
    },
    required: [
      "recipeId",
      "expectedRecipeRevision",
      "name",
      "inputs",
      "output",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseRecipeSaveArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The receipt answers a repeat. Lost before the receipt, the recipe that it saved answers, and a supplier's commands replay under their keys.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceRecipeSave,
  },
  unavailable: "recipe save is unavailable",
  prepare: ({ saveRecipe }) =>
    saveRecipe === undefined
      ? undefined
      : (request, call) => saveRecipe(request, call.operationId),
});

function parseRecipeSaveArgs(input: unknown): RecipeSaveRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "recipeId",
      "expectedRecipeRevision",
      "name",
      "inputs",
      "output",
    ]) ||
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    !Array.isArray(input.inputs) ||
    !isRecord(input.output)
  ) {
    throw new TypeError("recipe_save arguments are invalid");
  }
  const { recipeId, expectedRecipeRevision } = input;
  const edit =
    typeof recipeId === "string" &&
    recipeId.length > 0 &&
    Number.isSafeInteger(expectedRecipeRevision) &&
    Number(expectedRecipeRevision) > 0;
  if (!edit && (recipeId !== null || expectedRecipeRevision !== null)) {
    throw new ProposalArgumentError(
      "recipe_save needs both recipeId and expectedRecipeRevision from recipe_read to edit a recipe, or null for both to add one.",
    );
  }
  const inputs = input.inputs.map((line: unknown) => {
    const quantity = isRecord(line) ? parseRecipeQuantity(line.quantity) : null;
    if (
      !isRecord(line) ||
      !hasExactKeys(line, ["inventoryItemId", "quantity"]) ||
      typeof line.inventoryItemId !== "string" ||
      line.inventoryItemId.length === 0 ||
      quantity === null
    ) {
      throw new TypeError("recipe_save inputs are invalid");
    }
    return { inventoryItemId: line.inventoryItemId, quantity };
  });
  return {
    recipeId: edit ? recipeId : null,
    expectedRecipeRevision: edit ? Number(expectedRecipeRevision) : null,
    name: input.name.trim(),
    inputs,
    output: parseRecipeOutput(input.output),
  };
}

function parseRecipeOutput(
  output: Readonly<Record<string, unknown>>,
): RecipeDraft["output"] {
  if (!hasExactKeys(output, ["kind", "inventoryItemId", "yieldQuantity"])) {
    throw new TypeError("recipe_save output is invalid");
  }
  if (output.kind === "immediate") {
    if (output.inventoryItemId !== null || output.yieldQuantity !== null) {
      throw new ProposalArgumentError(
        "An immediate recipe output sets inventoryItemId and yieldQuantity to null.",
      );
    }
    return { kind: "immediate" };
  }
  const yieldQuantity = parseRecipeQuantity(output.yieldQuantity);
  if (
    output.kind !== "stocked" ||
    typeof output.inventoryItemId !== "string" ||
    output.inventoryItemId.length === 0 ||
    yieldQuantity === null
  ) {
    throw new ProposalArgumentError(
      "A stocked recipe output needs inventoryItemId and yieldQuantity.",
    );
  }
  return {
    kind: "stocked",
    inventoryItemId: output.inventoryItemId,
    yieldQuantity,
  };
}

function parseRecipeQuantity(input: unknown): RecipeQuantity | null {
  return isRecord(input) &&
    hasExactKeys(input, ["amount", "scale", "unit"]) &&
    Number.isSafeInteger(input.amount) &&
    Number.isSafeInteger(input.scale) &&
    isRecipeUnit(input.unit)
    ? {
        amount: Number(input.amount),
        scale: Number(input.scale),
        unit: input.unit,
      }
    : null;
}

function isRecipeUnit(value: unknown): value is RecipeQuantity["unit"] {
  return RECIPE_QUANTITY_PARAMETER.properties.unit.enum.some(
    (unit) => unit === value,
  );
}
