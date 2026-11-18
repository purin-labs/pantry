import type {
  CommerceEntityRef,
  CommerceEntityPlaneError,
  ListEntryAttributeValue,
} from "@seams/commerce-contracts";
import {
  parseAttributeDefinitionId,
  parseProductionRequestFields,
  parseRecipeRevision,
  type ProductionRequestFields,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import {
  readInventoryItem,
  readInventoryPositionForItemLocation,
} from "../inventory-persistence.ts";
import { parseAttributeValue } from "./parsers.ts";
import { readFoodServiceRevisionJson } from "../plugins/food-service/index.ts";

export function readProductionRequestFields(
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  revision: number,
): ProductionRequestFields {
  const rows = database
    .prepare(
      `SELECT attribute_id AS id, value_kind AS kind, short_text_value AS text,
       status_value AS status, integer_value AS integer, decimal_value AS decimal,
       timestamp_value AS timestamp FROM commerce_list_entry_attribute_value
     WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ? ORDER BY attribute_id`,
    )
    .all<ProductionFieldRow>(merchantId, entryId, revision);
  return parseProductionRequestFields(rows.map(productionField));
}

type ProductionFieldRow = Readonly<{
  id: string;
  kind: string;
  text: string | null;
  status: string | null;
  integer: number | null;
  decimal: string | null;
  timestamp: string | null;
}>;

function productionField(
  row: ProductionFieldRow,
): Pick<ListEntryAttributeValue, "attributeId" | "value"> {
  let value: unknown;
  switch (row.kind) {
    case "short_text":
      value = row.text;
      break;
    case "status":
      value = row.status;
      break;
    case "integer":
      value = row.integer;
      break;
    case "decimal":
      value = row.decimal === null ? null : JSON.parse(row.decimal);
      break;
    case "timestamp":
      value = row.timestamp;
      break;
    default:
      throw new Error("Invalid stored production field");
  }
  return {
    attributeId: parseAttributeDefinitionId(row.id),
    value: parseAttributeValue({ kind: row.kind, value }),
  };
}

export function validateProductionRequestWrite(
  database: CommerceDatabase,
  merchantId: string,
  entity: CommerceEntityRef,
  attributes: readonly ListEntryAttributeValue[],
  previous: ProductionRequestFields | null,
): CommerceEntityPlaneError | undefined {
  let fields: ProductionRequestFields;
  try {
    fields = parseProductionRequestFields(attributes);
  } catch {
    return invalidProductionField("requested_quantity");
  }
  if (previous === null) {
    if (fields.status !== "requested") return invalidProductionField("status");
  } else {
    const validTransition =
      (previous.status === "requested" &&
        (fields.status === "requested" || fields.status === "accepted")) ||
      (previous.status === "accepted" && fields.status === "scheduled");
    if (!validTransition) return invalidProductionField("status");
    if (previous.status !== "requested" || fields.status !== "requested") {
      if (
        previous.recipeId !== fields.recipeId ||
        previous.recipeRevision !== fields.recipeRevision ||
        previous.locationId !== fields.locationId ||
        previous.neededBy !== fields.neededBy ||
        previous.quantity.amount !== fields.quantity.amount ||
        previous.quantity.scale !== fields.quantity.scale ||
        previous.quantity.unit !== fields.quantity.unit
      )
        return invalidProductionField("requested_quantity");
    }
  }
  if (entity.origin !== "system" || entity.typeId !== "inventory_item")
    return { code: "invalid_list_entry_entity_type" };
  const item = readInventoryItem(database, merchantId, entity.entityId);
  if (
    item === undefined ||
    item.lifecycle !== "active" ||
    item.category !== "finished_good" ||
    item.baseUnit !== fields.quantity.unit
  )
    return invalidProductionField("quantity_unit");
  const position = readInventoryPositionForItemLocation(
    database,
    merchantId,
    item.id,
    fields.locationId,
  );
  const location = database
    .prepare(
      "SELECT lifecycle_state AS state FROM location WHERE merchant_id = ? AND resource_id = ?",
    )
    .get<{ state: string }>(merchantId, fields.locationId);
  if (position === undefined || location?.state !== "active")
    return invalidProductionField("location_id");
  const json = readFoodServiceRevisionJson(
    database,
    merchantId,
    "recipe_revision",
    fields.recipeId,
    fields.recipeRevision,
  );
  if (json === undefined) return invalidProductionField("recipe_id");
  const recipe = parseRecipeRevision(JSON.parse(json));
  if (
    recipe.lifecycle.state !== "active" ||
    recipe.output.kind !== "stocked" ||
    recipe.output.inventoryItemId !== item.id ||
    recipe.output.yieldQuantity.unit !== fields.quantity.unit
  )
    return invalidProductionField("recipe_id");
  return undefined;
}

function invalidProductionField(id: string): CommerceEntityPlaneError {
  return {
    code: "invalid_attribute_value",
    attributeId: parseAttributeDefinitionId(id),
  };
}
