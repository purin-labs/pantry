import type { CommerceDatabase } from "../database.ts";
import type { FoodServiceEntityProjection } from "../commerce-entity-projection.ts";
import { refreshCommerceRelationshipRelation } from "./commerce-relationship-relation.ts";
import { writeCommerceEntityRelationText } from "./relation-text.ts";

export function projectFoodServiceEntity(
  database: CommerceDatabase,
  merchantId: string,
  projection: FoodServiceEntityProjection,
): void {
  writeCommerceEntityRelationText(
    database,
    merchantId,
    projection.entityOrigin,
    projection.entityType,
    projection.entityId,
    projection.revision,
    projection.updatedAt,
    projection.displayName,
  );
  refreshCommerceRelationshipRelation(database, merchantId);
}
