// The food-service plugin's system entity types in the entity plane (Plan 77
// step 6). The plugin keeps each revision of its resources as one JSON row
// in its own table. The entity plane reads those types only through what
// this file contributes: the type list, the row shape, and the SQL that
// selects the latest revision of a resource.
import type { CommerceDatabase } from "../../database.ts";

/** The entity types that the food-service plugin contributes, in list order. */
export const FOOD_SERVICE_ENTITY_TYPES = [
  "menu",
  "recipe_revision",
  "preparation_ticket",
  "production_batch",
  "stock_policy",
  "modifier_group_revision",
  "preparation_station",
] as const;

export type FoodServiceEntityType = (typeof FOOD_SERVICE_ENTITY_TYPES)[number];

/** Where an entity of a food-service type lives, for the entity plane. */
export const FOOD_SERVICE_ENTITY_ROWS = {
  table: "food_service_resource",
  idColumn: "resource_id",
  lifecycleColumn: "lifecycle_state",
  payloadColumn: "resource_json",
  occurredAt:
    "COALESCE(json_extract(resource_json, '$.occurredAt'), json_extract(resource_json, '$.provenance.occurredAt'))",
} as const;

/** SQL: the row named `alias` is the latest revision of its resource. */
export function foodServiceLatestRevision(alias: string): string {
  return `${alias}.revision = (
      SELECT MAX(latest.revision)
      FROM food_service_resource AS latest
      WHERE latest.merchant_id = ${alias}.merchant_id
        AND latest.resource_kind = ${alias}.resource_kind
        AND latest.resource_id = ${alias}.resource_id
    )`;
}

/**
 * SQL after FROM: the latest revision of each resource of `kinds`, as the
 * row `resource`.
 */
export function latestFoodServiceResources(
  kinds: readonly FoodServiceEntityType[],
): string {
  return `food_service_resource AS resource
     WHERE resource.resource_kind IN (${kinds.map((kind) => `'${kind}'`).join(", ")})
       AND ${foodServiceLatestRevision("resource")}`;
}

/** The shipment of each production batch made for a shipment's demand. */
export function readShipmentProductionBatches(
  database: CommerceDatabase,
  merchantId: string,
): readonly Readonly<{ sourceId: string; targetId: string }>[] {
  return database
    .prepare(
      `SELECT shipment.resource_id AS sourceId, batch.resource_id AS targetId
     FROM shipment AS shipment
     JOIN food_service_resource AS batch
       ON batch.merchant_id = shipment.merchant_id
      AND batch.resource_kind = 'production_batch'
      AND ${foodServiceLatestRevision("batch")}
      AND json_extract(batch.resource_json, '$.demand.shipmentId') = shipment.resource_id
     WHERE shipment.merchant_id = ?`,
    )
    .all<Readonly<{ sourceId: string; targetId: string }>>(merchantId);
}

/** The JSON of a resource's latest revision, or undefined. */
export function readLatestFoodServiceResourceJson(
  database: CommerceDatabase,
  merchantId: string,
  kind: FoodServiceEntityType,
  resourceId: string,
): string | undefined {
  return database
    .prepare(
      `SELECT resource_json AS resourceJson
       FROM food_service_resource
      WHERE merchant_id = ? AND resource_kind = ? AND resource_id = ?
      ORDER BY revision DESC LIMIT 1`,
    )
    .get<Readonly<{ resourceJson: string }>>(merchantId, kind, resourceId)
    ?.resourceJson;
}
