import type { ListEntryAttributeValue, Quantity } from "@seams/commerce-contracts";
import { parseQuantity } from "./commerce-resources.ts";
import { parseListEntryAttributeValue } from "./entity-plane/primitives.ts";

export type ProductionRequestFields = Readonly<{
  status: "requested" | "accepted" | "scheduled";
  recipeId: string;
  recipeRevision: number;
  locationId: string;
  quantity: Quantity;
  neededBy: string;
}>;

export function parseProductionRequestFields(
  attributes: readonly Pick<ListEntryAttributeValue, "attributeId" | "value">[],
): ProductionRequestFields {
  const values = new Map<string, ListEntryAttributeValue["value"]>();
  for (const attribute of attributes) {
    if (values.has(attribute.attributeId))
      throw new Error("Duplicate production field");
    values.set(attribute.attributeId, attribute.value);
  }
  const status = values.get("status");
  const state = status?.kind === "status" ? String(status.value) : null;
  const recipe = values.get("recipe_id");
  const revision = values.get("recipe_revision");
  const location = values.get("location_id");
  const requested = values.get("requested_quantity");
  const unit = values.get("quantity_unit");
  const needed = values.get("needed_by");
  if (
    status?.kind !== "status" ||
    (state !== "requested" && state !== "accepted" && state !== "scheduled") ||
    recipe?.kind !== "short_text" ||
    recipe.value.trim() === "" ||
    revision?.kind !== "integer" ||
    !Number.isSafeInteger(Number(revision.value)) ||
    Number(revision.value) < 1 ||
    location?.kind !== "short_text" ||
    location.value.trim() === "" ||
    requested?.kind !== "decimal" ||
    unit?.kind !== "short_text" ||
    needed?.kind !== "timestamp" ||
    !Number.isFinite(Date.parse(needed.value))
  )
    throw new Error("Invalid production request fields");
  let amount = requested.value.unscaled;
  let scale = requested.value.scale;
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 6
  )
    throw new Error("Invalid production quantity");
  while (scale > 0 && amount % 10 === 0) {
    amount /= 10;
    scale -= 1;
  }
  const quantity = parseQuantity(
    { amount, scale, unit: unit.value },
    "production.quantity",
  );
  productionQuantityUnscaled(quantity);
  return {
    status: state,
    recipeId: recipe.value,
    recipeRevision: Number(revision.value),
    locationId: location.value,
    quantity,
    neededBy: needed.value,
  };
}

export function productionQuantityUnscaled(quantity: Quantity): number {
  const scaled = BigInt(quantity.amount) * 10n ** BigInt(6 - quantity.scale);
  if (scaled <= 0n || scaled > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Production quantity is out of range");
  return Number(scaled);
}

export function productionRequestAttributes(
  fields: ProductionRequestFields,
): readonly ListEntryAttributeValue[] {
  return [
    productionAttribute("status", { kind: "status", value: fields.status }),
    productionAttribute("recipe_id", {
      kind: "short_text",
      value: fields.recipeId,
    }),
    productionAttribute("recipe_revision", {
      kind: "integer",
      value: BigInt(fields.recipeRevision),
    }),
    productionAttribute("location_id", {
      kind: "short_text",
      value: fields.locationId,
    }),
    productionAttribute("requested_quantity", {
      kind: "decimal",
      value: {
        unscaled: productionQuantityUnscaled(fields.quantity),
        scale: 6,
      },
    }),
    productionAttribute("quantity_unit", {
      kind: "short_text",
      value: fields.quantity.unit,
    }),
    productionAttribute("needed_by", {
      kind: "timestamp",
      value: fields.neededBy,
    }),
  ];
}

function productionAttribute(
  attributeId: string,
  value: unknown,
): ListEntryAttributeValue {
  return parseListEntryAttributeValue({
    attributeId,
    scope: {
      kind: "system",
      entityTypeId: "inventory_item",
      schemaRevision: 1,
    },
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  });
}
