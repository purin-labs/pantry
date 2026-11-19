// The stock movements of kitchen work: ingredients that a preparation ticket
// uses, and the inputs and output of a production batch.
import type { CommerceInventoryMovementV1 } from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "../../database.ts";
import { writeCommerceEntityRelationText } from "../../entity-plane/relation-text.ts";
import { insertMovementLotAllocations } from "../../inventory-persistence.ts";

export function insertPreparationMovement(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  movement: CommerceInventoryMovementV1,
): void {
  if (
    movement.change.kind !== "decrease" ||
    movement.change.reason.kind !== "preparation"
  ) {
    throw new Error(
      "Preparation persistence requires one preparation decrease movement",
    );
  }
  database
    .prepare(
      `INSERT INTO stock_movement (
       merchant_id, movement_id, inventory_item_id, inventory_position_id,
       location_id, direction, quantity_amount, quantity_scale, quantity_unit,
       reason_kind, preparation_ticket_id, recipe_revision, occurred_at, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, 'decrease', ?, ?, ?, 'preparation', ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      movement.id,
      movement.inventoryItemId,
      inventoryPositionId,
      movement.locationId,
      movement.change.quantity.amount,
      movement.change.quantity.scale,
      movement.change.quantity.unit,
      movement.change.reason.ticketId,
      movement.change.reason.recipeRevision,
      movement.occurredAt,
      movement.idempotencyKey,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_movement",
    movement.id,
    1,
    movement.occurredAt,
    movement.id,
  );
  insertMovementLotAllocations(database, merchantId, movement);
}

export function insertProductionMovement(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  movement: CommerceInventoryMovementV1,
): void {
  if (movement.change.reason.kind !== "production") {
    throw new Error("Production persistence requires a production movement");
  }
  const quantity = movement.change.quantity;
  const reason = movement.change.reason;
  const direction =
    movement.change.kind === "increase" ? "increase" : "decrease";
  database
    .prepare(
      `INSERT INTO stock_movement (
       merchant_id, movement_id, inventory_item_id, inventory_position_id,
       location_id, direction, quantity_amount, quantity_scale, quantity_unit,
       reason_kind, production_batch_id, recipe_revision, occurred_at, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'production', ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      movement.id,
      movement.inventoryItemId,
      inventoryPositionId,
      movement.locationId,
      direction,
      quantity.amount,
      quantity.scale,
      quantity.unit,
      reason.productionBatchId,
      reason.recipeRevision,
      movement.occurredAt,
      movement.idempotencyKey,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_movement",
    movement.id,
    1,
    movement.occurredAt,
    movement.id,
  );
  insertMovementLotAllocations(database, merchantId, movement);
}
