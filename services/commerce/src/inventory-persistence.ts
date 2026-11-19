import {
  parseInventoryItem,
  parseInventoryLot,
  parseInventoryMovement,
  parseInventoryPosition,
  parseInventoryReceiptPurchase,
  type CommerceInventoryItemV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceLotAllocationV1,
  type CommerceQuantityUnit,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "./database.ts";
import { writeCommerceEntityRelationText } from "./entity-plane/relation-text.ts";
import type { Variant } from "@purin-labs/type-utils";

type InventoryItemRow = Readonly<{
  inventoryItemId: string;
  revision: number;
  merchantCode: string;
  name: string;
  baseUnit: string;
  category: string;
  trackingKind: string;
  expiryPolicy: string | null;
  lifecycle: string;
  occurredAt: string;
}>;

type InventoryPositionRow = Readonly<{
  inventoryPositionId: string;
  inventoryItemId: string;
  locationId: string;
  revision: number;
  balanceKind: string;
  onHandAmount: number | null;
  allocatedAmount: number | null;
  availableAmount: number;
  quantityScale: number;
  quantityUnit: string;
  observedAt: string;
}>;

type InventoryMovementRow = Readonly<{
  movementId: string;
  inventoryItemId: string;
  locationId: string;
  direction: string;
  quantityAmount: number;
  quantityScale: number;
  quantityUnit: string;
  reasonKind: string;
  reasonJson: string | null;
  receiptId: string | null;
  receiptLineId: string | null;
  productionBatchId: string | null;
  orderId: string | null;
  orderLineId: string | null;
  preparationTicketId: string | null;
  recipeRevision: number | null;
  occurredAt: string;
  idempotencyKey: string;
}>;

type InventoryLotRow = Readonly<{
  lotId: string;
  lotCode: string;
  inventoryItemId: string;
  locationId: string;
  revision: number;
  sourceMovementId: string;
  receivedAmount: number;
  remainingAmount: number;
  quantityScale: number;
  quantityUnit: string;
  expiryKind: string;
  expiresAt: string | null;
  lifecycle: string;
  quarantineReason: string | null;
  occurredAt: string;
}>;

type LotAllocationRow = Readonly<{
  lotId: string;
  quantityAmount: number;
  quantityScale: number;
  quantityUnit: string;
}>;

export function listInventoryItems(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceInventoryItemV1[] {
  const rows = database
    .prepare(
      `${inventoryItemSelect()}
     WHERE merchant_id = ? ORDER BY inventory_item_id`,
    )
    .all<InventoryItemRow>(merchantId);
  const items: CommerceInventoryItemV1[] = [];
  for (const row of rows) items.push(inventoryItemFromRow(row));
  return items;
}

export function readInventoryItem(
  database: CommerceDatabase,
  merchantId: string,
  inventoryItemId: string,
): CommerceInventoryItemV1 | undefined {
  const row = database
    .prepare(
      `${inventoryItemSelect()}
     WHERE merchant_id = ? AND inventory_item_id = ?`,
    )
    .get<InventoryItemRow>(merchantId, inventoryItemId);
  return row === undefined ? undefined : inventoryItemFromRow(row);
}

export function insertInventoryItem(
  database: CommerceDatabase,
  merchantId: string,
  item: CommerceInventoryItemV1,
): void {
  const expiryPolicy =
    item.tracking.kind === "lot_tracked" ? item.tracking.expiry : null;
  database
    .prepare(
      `INSERT INTO inventory_item (
       merchant_id, inventory_item_id, revision, merchant_code, name, base_unit,
       category, tracking_kind, expiry_policy, lifecycle, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      item.id,
      item.revision,
      item.merchantCode,
      item.name,
      item.baseUnit,
      item.category,
      item.tracking.kind,
      expiryPolicy,
      item.lifecycle,
      item.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_item",
    item.id,
    item.revision,
    item.occurredAt,
    item.name,
  );
}

export function listInventoryPositions(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceInventoryPositionV1[] {
  const rows = database
    .prepare(
      `${inventoryPositionSelect()}
     WHERE merchant_id = ? ORDER BY inventory_position_id`,
    )
    .all<InventoryPositionRow>(merchantId);
  const positions: CommerceInventoryPositionV1[] = [];
  for (const row of rows) positions.push(inventoryPositionFromRow(row));
  return positions;
}

export function readInventoryPosition(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
): CommerceInventoryPositionV1 | undefined {
  const row = database
    .prepare(
      `${inventoryPositionSelect()}
     WHERE merchant_id = ? AND inventory_position_id = ?`,
    )
    .get<InventoryPositionRow>(merchantId, inventoryPositionId);
  return row === undefined ? undefined : inventoryPositionFromRow(row);
}

export function readInventoryPositionForItemLocation(
  database: CommerceDatabase,
  merchantId: string,
  inventoryItemId: string,
  locationId: string,
): CommerceInventoryPositionV1 | undefined {
  const row = database
    .prepare(
      `${inventoryPositionSelect()}
     WHERE merchant_id = ? AND inventory_item_id = ? AND location_id = ?`,
    )
    .get<InventoryPositionRow>(merchantId, inventoryItemId, locationId);
  return row === undefined ? undefined : inventoryPositionFromRow(row);
}

export function insertInventoryPosition(
  database: CommerceDatabase,
  merchantId: string,
  position: CommerceInventoryPositionV1,
): void {
  if (position.balance.kind !== "accounted") {
    throw new Error(
      "Underclerk can persist only accounted inventory positions",
    );
  }
  database
    .prepare(
      `INSERT INTO inventory_position (
       merchant_id, inventory_position_id, inventory_item_id, location_id,
       revision, balance_kind, on_hand_amount, allocated_amount, available_amount,
       quantity_scale, quantity_unit, observed_at
     ) VALUES (?, ?, ?, ?, ?, 'accounted', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      position.id,
      position.inventoryItemId,
      position.locationId,
      position.revision,
      position.balance.onHand.amount,
      position.balance.allocated.amount,
      position.balance.available.amount,
      position.balance.onHand.scale,
      position.balance.onHand.unit,
      position.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_position",
    position.id,
    position.revision,
    position.occurredAt,
    position.id,
  );
}

export function updateInventoryPosition(
  database: CommerceDatabase,
  merchantId: string,
  expectedRevision: number,
  position: CommerceInventoryPositionV1,
): void {
  if (position.balance.kind !== "accounted") {
    throw new Error(
      "Underclerk can persist only accounted inventory positions",
    );
  }
  const updated = database
    .prepare(
      `UPDATE inventory_position
     SET revision = ?, balance_kind = 'accounted', on_hand_amount = ?,
         allocated_amount = ?, available_amount = ?, quantity_scale = ?,
         quantity_unit = ?, observed_at = ?
     WHERE merchant_id = ? AND inventory_position_id = ? AND revision = ?`,
    )
    .run(
      position.revision,
      position.balance.onHand.amount,
      position.balance.allocated.amount,
      position.balance.available.amount,
      position.balance.onHand.scale,
      position.balance.onHand.unit,
      position.occurredAt,
      merchantId,
      position.id,
      expectedRevision,
    );
  if (updated.changes !== 1) {
    throw new Error("Inventory position revision changed during commit");
  }
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_position",
    position.id,
    position.revision,
    position.occurredAt,
    position.id,
  );
}

export function listInventoryMovements(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceInventoryMovementV1[] {
  const rows = database
    .prepare(
      `${inventoryMovementSelect()}
     WHERE merchant_id = ? ORDER BY movement_id`,
    )
    .all<InventoryMovementRow>(merchantId);
  const movements: CommerceInventoryMovementV1[] = [];
  for (const row of rows)
    movements.push(inventoryMovementFromRow(database, merchantId, row));
  return movements;
}

export function readReceiptMovement(
  database: CommerceDatabase,
  merchantId: string,
  receiptId: string,
  receiptLineId: string,
): CommerceInventoryMovementV1 | undefined {
  const row = database
    .prepare(
      `${inventoryMovementSelect()}
     WHERE merchant_id = ? AND receipt_id = ? AND receipt_line_id = ?`,
    )
    .get<InventoryMovementRow>(merchantId, receiptId, receiptLineId);
  return row === undefined
    ? undefined
    : inventoryMovementFromRow(database, merchantId, row);
}

export function insertReceiptMovement(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  movement: CommerceInventoryMovementV1,
): void {
  if (
    movement.change.kind !== "increase" ||
    movement.change.reason.kind !== "receipt"
  ) {
    throw new Error(
      "Receipt persistence requires one receipt increase movement",
    );
  }
  database
    .prepare(
      `INSERT INTO stock_movement (
       merchant_id, movement_id, inventory_item_id, inventory_position_id,
       location_id, direction, quantity_amount, quantity_scale, quantity_unit,
       reason_kind, reason_json, receipt_id, receipt_line_id, occurred_at, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, 'increase', ?, ?, ?, 'receipt', ?, ?, ?, ?, ?)`,
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
      JSON.stringify(movement.change.reason),
      movement.change.reason.receiptId,
      movement.change.reason.receiptLineId,
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
}

export function insertReconciliationMovement(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  movement: CommerceInventoryMovementV1,
): void {
  const reason = movement.change.reason;
  if (
    reason.kind !== "stock_count" &&
    reason.kind !== "correction" &&
    reason.kind !== "waste" &&
    reason.kind !== "damage"
  ) {
    throw new Error(
      "Reconciliation persistence requires a count or explicit adjustment",
    );
  }
  database
    .prepare(
      `INSERT INTO stock_movement (
    merchant_id, movement_id, inventory_item_id, inventory_position_id,
    location_id, direction, quantity_amount, quantity_scale, quantity_unit,
    reason_kind, reason_json, occurred_at, idempotency_key
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      movement.id,
      movement.inventoryItemId,
      inventoryPositionId,
      movement.locationId,
      movement.change.kind,
      movement.change.quantity.amount,
      movement.change.quantity.scale,
      movement.change.quantity.unit,
      reason.kind,
      JSON.stringify(reason),
      movement.occurredAt,
      movement.idempotencyKey,
    );
  if (
    movement.change.kind === "decrease" &&
    movement.change.lotAllocation.kind === "allocated"
  ) {
    for (const lot of movement.change.lotAllocation.lots) {
      database
        .prepare(
          `INSERT INTO stock_movement_lot (
        merchant_id, movement_id, lot_id, quantity_amount, quantity_scale, quantity_unit
      ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchantId,
          movement.id,
          lot.lotId,
          lot.quantity.amount,
          lot.quantity.scale,
          lot.quantity.unit,
        );
    }
  }
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
}

export function insertSaleMovement(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  movement: CommerceInventoryMovementV1,
): void {
  if (
    movement.change.kind !== "decrease" ||
    movement.change.reason.kind !== "sale"
  ) {
    throw new Error("Sale persistence requires one sale decrease movement");
  }
  database
    .prepare(
      `INSERT INTO stock_movement (
       merchant_id, movement_id, inventory_item_id, inventory_position_id,
       location_id, direction, quantity_amount, quantity_scale, quantity_unit,
       reason_kind, order_id, order_line_id, occurred_at, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, 'decrease', ?, ?, ?, 'sale', ?, ?, ?, ?)`,
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
      movement.change.reason.orderId,
      movement.change.reason.orderLineId,
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
  if (movement.change.lotAllocation.kind === "allocated") {
    for (const lot of movement.change.lotAllocation.lots) {
      database
        .prepare(
          `INSERT INTO stock_movement_lot (
           merchant_id, movement_id, lot_id,
           quantity_amount, quantity_scale, quantity_unit
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchantId,
          movement.id,
          lot.lotId,
          lot.quantity.amount,
          lot.quantity.scale,
          lot.quantity.unit,
        );
    }
  }
}

export function insertMovementLotAllocations(
  database: CommerceDatabase,
  merchantId: string,
  movement: CommerceInventoryMovementV1,
): void {
  if (
    movement.change.kind !== "decrease" ||
    movement.change.lotAllocation.kind !== "allocated"
  ) {
    return;
  }
  for (const lot of movement.change.lotAllocation.lots) {
    database
      .prepare(
        `INSERT INTO stock_movement_lot (
         merchant_id, movement_id, lot_id,
         quantity_amount, quantity_scale, quantity_unit
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        movement.id,
        lot.lotId,
        lot.quantity.amount,
        lot.quantity.scale,
        lot.quantity.unit,
      );
  }
}

export function listInventoryLots(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceInventoryLotV1[] {
  const rows = database
    .prepare(
      `${inventoryLotSelect()}
     WHERE merchant_id = ? ORDER BY lot_id`,
    )
    .all<InventoryLotRow>(merchantId);
  const lots: CommerceInventoryLotV1[] = [];
  for (const row of rows) lots.push(inventoryLotFromRow(row));
  return lots;
}

export function listUsableInventoryLots(
  database: CommerceDatabase,
  merchantId: string,
  inventoryItemId: string,
  locationId: string,
): readonly CommerceInventoryLotV1[] {
  const rows = database
    .prepare(
      `${inventoryLotSelect()}
     WHERE merchant_id = ? AND inventory_item_id = ? AND location_id = ?
       AND lifecycle = 'available'`,
    )
    .all<InventoryLotRow>(merchantId, inventoryItemId, locationId);
  const lots: CommerceInventoryLotV1[] = [];
  for (const row of rows) lots.push(inventoryLotFromRow(row));
  return lots;
}

export function readInventoryLot(
  database: CommerceDatabase,
  merchantId: string,
  lotId: string,
): CommerceInventoryLotV1 | undefined {
  const row = database
    .prepare(
      `${inventoryLotSelect()}
     WHERE merchant_id = ? AND lot_id = ?`,
    )
    .get<InventoryLotRow>(merchantId, lotId);
  return row === undefined ? undefined : inventoryLotFromRow(row);
}

export function insertInventoryLot(
  database: CommerceDatabase,
  merchantId: string,
  inventoryPositionId: string,
  lot: CommerceInventoryLotV1,
): void {
  const expiresAt = lot.expiry.kind === "expires" ? lot.expiry.expiresAt : null;
  const quarantineReason =
    lot.lifecycle.state === "quarantined" ? lot.lifecycle.reason : null;
  database
    .prepare(
      `INSERT INTO stock_lot (
       merchant_id, lot_id, lot_code, inventory_item_id, inventory_position_id,
       location_id, revision, source_movement_id, received_amount,
       remaining_amount, quantity_scale, quantity_unit, expiry_kind, expires_at,
       lifecycle, quarantine_reason, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      lot.id,
      lot.lotCode,
      lot.inventoryItemId,
      inventoryPositionId,
      lot.locationId,
      lot.revision,
      lot.sourceMovementId,
      lot.receivedQuantity.amount,
      lot.remainingQuantity.amount,
      lot.receivedQuantity.scale,
      lot.receivedQuantity.unit,
      lot.expiry.kind,
      expiresAt,
      lot.lifecycle.state,
      quarantineReason,
      lot.occurredAt,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_lot",
    lot.id,
    lot.revision,
    lot.occurredAt,
    lot.lotCode,
  );
}

export function updateInventoryLot(
  database: CommerceDatabase,
  merchantId: string,
  expectedRevision: number,
  lot: CommerceInventoryLotV1,
): void {
  const quarantineReason =
    lot.lifecycle.state === "quarantined" ? lot.lifecycle.reason : null;
  const updated = database
    .prepare(
      `UPDATE stock_lot
     SET revision = ?, remaining_amount = ?, lifecycle = ?,
         quarantine_reason = ?, occurred_at = ?
     WHERE merchant_id = ? AND lot_id = ? AND revision = ?`,
    )
    .run(
      lot.revision,
      lot.remainingQuantity.amount,
      lot.lifecycle.state,
      quarantineReason,
      lot.occurredAt,
      merchantId,
      lot.id,
      expectedRevision,
    );
  if (updated.changes !== 1)
    throw new Error("Inventory lot revision changed during commit");
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    "inventory_lot",
    lot.id,
    lot.revision,
    lot.occurredAt,
    lot.lotCode,
  );
}

function inventoryItemSelect(): string {
  return `SELECT
    inventory_item_id AS inventoryItemId,
    revision,
    merchant_code AS merchantCode,
    name,
    base_unit AS baseUnit,
    category,
    tracking_kind AS trackingKind,
    expiry_policy AS expiryPolicy,
    lifecycle,
    occurred_at AS occurredAt
  FROM inventory_item`;
}

function inventoryPositionSelect(): string {
  return `SELECT
    inventory_position_id AS inventoryPositionId,
    inventory_item_id AS inventoryItemId,
    location_id AS locationId,
    revision,
    balance_kind AS balanceKind,
    on_hand_amount AS onHandAmount,
    allocated_amount AS allocatedAmount,
    available_amount AS availableAmount,
    quantity_scale AS quantityScale,
    quantity_unit AS quantityUnit,
    observed_at AS observedAt
  FROM inventory_position`;
}

function inventoryMovementSelect(): string {
  return `SELECT
    movement_id AS movementId,
    inventory_item_id AS inventoryItemId,
    location_id AS locationId,
    direction,
    quantity_amount AS quantityAmount,
    quantity_scale AS quantityScale,
    quantity_unit AS quantityUnit,
    reason_kind AS reasonKind,
    reason_json AS reasonJson,
    receipt_id AS receiptId,
    receipt_line_id AS receiptLineId,
    production_batch_id AS productionBatchId,
    order_id AS orderId,
    order_line_id AS orderLineId,
    preparation_ticket_id AS preparationTicketId,
    recipe_revision AS recipeRevision,
    occurred_at AS occurredAt,
    idempotency_key AS idempotencyKey
  FROM stock_movement`;
}

function inventoryLotSelect(): string {
  return `SELECT
    lot_id AS lotId,
    lot_code AS lotCode,
    inventory_item_id AS inventoryItemId,
    location_id AS locationId,
    revision,
    source_movement_id AS sourceMovementId,
    received_amount AS receivedAmount,
    remaining_amount AS remainingAmount,
    quantity_scale AS quantityScale,
    quantity_unit AS quantityUnit,
    expiry_kind AS expiryKind,
    expires_at AS expiresAt,
    lifecycle,
    quarantine_reason AS quarantineReason,
    occurred_at AS occurredAt
  FROM stock_lot`;
}

function inventoryItemFromRow(
  row: InventoryItemRow,
): CommerceInventoryItemV1 {
  return parseInventoryItem({
    id: row.inventoryItemId,
    revision: row.revision,
    merchantCode: row.merchantCode,
    name: row.name,
    baseUnit: row.baseUnit,
    category: row.category,
    tracking:
      row.trackingKind === "aggregate"
        ? { kind: "aggregate" }
        : { kind: "lot_tracked", expiry: row.expiryPolicy },
    lifecycle: row.lifecycle,
    occurredAt: row.occurredAt,
  });
}

function inventoryPositionFromRow(
  row: InventoryPositionRow,
): CommerceInventoryPositionV1 {
  if (row.balanceKind === "available_only") {
    return parseInventoryPosition({
      id: row.inventoryPositionId,
      revision: row.revision,
      inventoryItemId: row.inventoryItemId,
      locationId: row.locationId,
      balance: {
        kind: "available_only",
        available: quantityFromPositionRow(row, row.availableAmount),
      },
      occurredAt: row.observedAt,
    });
  }
  if (
    row.balanceKind !== "accounted" ||
    row.onHandAmount === null ||
    row.allocatedAmount === null
  ) {
    throw new Error("Inventory position balance branch is invalid");
  }
  return parseInventoryPosition({
    id: row.inventoryPositionId,
    revision: row.revision,
    inventoryItemId: row.inventoryItemId,
    locationId: row.locationId,
    balance: {
      kind: "accounted",
      onHand: quantityFromPositionRow(row, row.onHandAmount),
      allocated: quantityFromPositionRow(row, row.allocatedAmount),
      available: quantityFromPositionRow(row, row.availableAmount),
    },
    occurredAt: row.observedAt,
  });
}

function quantityFromPositionRow(
  row: InventoryPositionRow,
  amount: number,
): Readonly<{ amount: number; scale: number; unit: string }> {
  return { amount, scale: row.quantityScale, unit: row.quantityUnit };
}

function inventoryMovementFromRow(
  database: CommerceDatabase,
  merchantId: string,
  row: InventoryMovementRow,
): CommerceInventoryMovementV1 {
  return parseInventoryMovement({
    id: row.movementId,
    inventoryItemId: row.inventoryItemId,
    locationId: row.locationId,
    change: movementChangeFromRow(database, merchantId, row),
    occurredAt: row.occurredAt,
    idempotencyKey: row.idempotencyKey,
  });
}

function movementChangeFromRow(
  database: CommerceDatabase,
  merchantId: string,
  row: InventoryMovementRow,
): CommerceInventoryMovementV1["change"] {
  const quantity = movementQuantityFromRow(row);
  switch (row.reasonKind) {
    case "stock_count":
    case "correction":
    case "waste":
    case "damage": {
      const reason: unknown = JSON.parse(
        requireStoredText(row.reasonJson, "stock_movement.reason_json"),
      );
      return parseInventoryMovement({
        id: row.movementId,
        inventoryItemId: row.inventoryItemId,
        locationId: row.locationId,
        change:
          row.direction === "increase"
            ? { kind: "increase", quantity, reason }
            : {
                kind: "decrease",
                quantity,
                reason,
                lotAllocation: lotAllocationForMovement(
                  database,
                  merchantId,
                  row.movementId,
                ),
              },
        occurredAt: row.occurredAt,
        idempotencyKey: row.idempotencyKey,
      }).change;
    }
    case "receipt":
      return {
        kind: "increase",
        quantity,
        reason: {
          kind: "receipt",
          purchase: parseInventoryReceiptPurchase(
            JSON.parse(
              requireStoredText(row.reasonJson, "stock_movement.reason_json"),
            ).purchase,
          ),
          receiptId: requireStoredText(
            row.receiptId,
            "stock_movement.receipt_id",
          ),
          receiptLineId: requireStoredText(
            row.receiptLineId,
            "stock_movement.receipt_line_id",
          ),
        },
      };
    case "production": {
      const reason = {
        kind: "production" as const,
        productionBatchId: requireStoredText(
          row.productionBatchId,
          "stock_movement.production_batch_id",
        ),
        recipeRevision: requireStoredInteger(
          row.recipeRevision,
          "stock_movement.recipe_revision",
        ),
      };
      if (row.direction === "increase")
        return { kind: "increase", quantity, reason };
      if (row.direction === "decrease") {
        return {
          kind: "decrease",
          quantity,
          reason,
          lotAllocation: lotAllocationForMovement(
            database,
            merchantId,
            row.movementId,
          ),
        };
      }
      throw new Error(
        `Unsupported stored production movement direction: ${row.direction}`,
      );
    }
    case "sale":
      return {
        kind: "decrease",
        quantity,
        reason: {
          kind: "sale",
          orderId: requireStoredText(row.orderId, "stock_movement.order_id"),
          orderLineId: requireStoredText(
            row.orderLineId,
            "stock_movement.order_line_id",
          ),
        },
        lotAllocation: lotAllocationForMovement(
          database,
          merchantId,
          row.movementId,
        ),
      };
    case "preparation":
      return {
        kind: "decrease",
        quantity,
        reason: {
          kind: "preparation",
          ticketId: requireStoredText(
            row.preparationTicketId,
            "stock_movement.preparation_ticket_id",
          ),
          recipeRevision: requireStoredInteger(
            row.recipeRevision,
            "stock_movement.recipe_revision",
          ),
        },
        lotAllocation: lotAllocationForMovement(
          database,
          merchantId,
          row.movementId,
        ),
      };
    default:
      throw new Error(
        `Unsupported stored inventory movement reason: ${row.reasonKind}`,
      );
  }
}

function lotAllocationForMovement(
  database: CommerceDatabase,
  merchantId: string,
  movementId: string,
): Variant<
  CommerceInventoryMovementV1["change"],
  "decrease"
>["lotAllocation"] {
  const rows = database
    .prepare(
      `SELECT lot_id AS lotId, quantity_amount AS quantityAmount,
            quantity_scale AS quantityScale, quantity_unit AS quantityUnit
     FROM stock_movement_lot
     WHERE merchant_id = ? AND movement_id = ? ORDER BY lot_id`,
    )
    .all<LotAllocationRow>(merchantId, movementId);
  if (rows.length === 0) return { kind: "not_tracked" };
  const lots: CommerceLotAllocationV1[] = [];
  for (const row of rows) {
    lots.push({
      lotId: row.lotId,
      quantity: {
        amount: row.quantityAmount,
        scale: row.quantityScale,
        unit: requireQuantityUnit(row.quantityUnit),
      },
    });
  }
  return { kind: "allocated", lots };
}

function movementQuantityFromRow(row: InventoryMovementRow): Readonly<{
  amount: number;
  scale: number;
  unit: CommerceQuantityUnit;
}> {
  return {
    amount: row.quantityAmount,
    scale: row.quantityScale,
    unit: requireQuantityUnit(row.quantityUnit),
  };
}

function inventoryLotFromRow(row: InventoryLotRow): CommerceInventoryLotV1 {
  const expiry =
    row.expiryKind === "expires"
      ? {
          kind: "expires" as const,
          expiresAt: requireStoredText(row.expiresAt, "stock_lot.expires_at"),
        }
      : { kind: "not_tracked" as const };
  const lifecycle = lotLifecycleFromRow(row);
  return parseInventoryLot({
    id: row.lotId,
    lotCode: row.lotCode,
    inventoryItemId: row.inventoryItemId,
    locationId: row.locationId,
    revision: row.revision,
    sourceMovementId: row.sourceMovementId,
    receivedQuantity: quantityFromLotRow(row, row.receivedAmount),
    remainingQuantity: quantityFromLotRow(row, row.remainingAmount),
    expiry,
    lifecycle,
    occurredAt: row.occurredAt,
  });
}

function quantityFromLotRow(
  row: InventoryLotRow,
  amount: number,
): Readonly<{ amount: number; scale: number; unit: string }> {
  return { amount, scale: row.quantityScale, unit: row.quantityUnit };
}

function lotLifecycleFromRow(
  row: InventoryLotRow,
): CommerceInventoryLotV1["lifecycle"] {
  switch (row.lifecycle) {
    case "available":
    case "depleted":
    case "expired":
      return { state: row.lifecycle };
    case "quarantined":
      return {
        state: "quarantined",
        reason: requireStoredText(
          row.quarantineReason,
          "stock_lot.quarantine_reason",
        ),
      };
    default:
      throw new Error(
        `Unsupported stored inventory lot lifecycle: ${row.lifecycle}`,
      );
  }
}

function requireStoredText(value: string | null, field: string): string {
  if (value === null || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireStoredInteger(value: number | null, field: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireQuantityUnit(value: string): CommerceQuantityUnit {
  switch (value) {
    case "each":
    case "gram":
    case "kilogram":
    case "milliliter":
    case "liter":
      return value;
    default:
      throw new Error(`Unsupported stored inventory quantity unit: ${value}`);
  }
}
