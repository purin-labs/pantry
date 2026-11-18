import { createHash } from "node:crypto";

import {
  parseInventoryItem,
  parseInventoryLot,
  parseInventoryMovement,
  parseInventoryPosition,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type ReceiveCommerceInventoryV3,
  type ReconcileCommerceInventoryV1,
  type CommerceQuantityV1,
  type CommerceAggregateObservationV1,
  type CommerceInventoryItemV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import type { ReceiptPurchaseCheck } from "../plugins/built-in-ports.ts";
import {
  addQuantity,
  movedLotLifecycle,
  quantityAtScale,
  scaledAmount,
} from "./inventory-planning.ts";
import {
  listInventoryItems,
  listInventoryLots,
  readInventoryItem,
  readInventoryLot,
  readInventoryPosition,
  readInventoryPositionForItemLocation,
} from "../inventory-persistence.ts";

export type InventoryItemPlanResult =
  | Readonly<{ kind: "planned"; value: CommerceInventoryItemV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type InventoryPositionPlanResult =
  | Readonly<{ kind: "planned"; value: CommerceInventoryPositionV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type InventoryMovementPlan = Readonly<{
  lot: CommerceInventoryLotV1 | undefined;
  movement: CommerceInventoryMovementV1;
  inventoryPosition: CommerceInventoryPositionV1;
  committedAt: string;
}>;

export type InventoryMovementPlanResult =
  | Readonly<{ kind: "planned"; value: InventoryMovementPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planInventoryItem(
  database: CommerceDatabase,
  command: CreateCommerceInventoryItemV1,
): InventoryItemPlanResult {
  if (
    readInventoryItem(database, command.merchantId, command.inventoryItemId) !==
    undefined
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_already_exists",
        kind: "inventory_item",
        id: command.inventoryItemId,
      },
    };
  }
  for (const existing of listInventoryItems(database, command.merchantId)) {
    if (existing.merchantCode === command.merchantCode) {
      return {
        kind: "rejected",
        error: { code: "resource_relationship_invalid", field: "merchantCode" },
      };
    }
  }
  const item = parseInventoryItem({
    id: command.inventoryItemId,
    revision: 1,
    merchantCode: command.merchantCode,
    name: command.name,
    baseUnit: command.baseUnit,
    category: command.category,
    tracking: command.tracking,
    lifecycle: "active",
    occurredAt: command.requestedAt,
  });
  return { kind: "planned", value: item };
}

export function planInventoryPosition(
  database: CommerceDatabase,
  command: OpenCommerceInventoryPositionV1,
  snapshot: CommerceMerchantSnapshotV1 | undefined,
): InventoryPositionPlanResult {
  const item = readInventoryItem(
    database,
    command.merchantId,
    command.inventoryItemId,
  );
  const itemRevisionError = checkInventoryRevision(
    "inventory_item",
    command.inventoryItemId,
    command.inventoryItemRevision,
    item?.revision,
  );
  if (itemRevisionError !== undefined)
    return { kind: "rejected", error: itemRevisionError };
  if (item === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_item",
        id: command.inventoryItemId,
      },
    };
  }
  if (
    readInventoryPosition(
      database,
      command.merchantId,
      command.inventoryPositionId,
    ) !== undefined
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_already_exists",
        kind: "inventory_position",
        id: command.inventoryPositionId,
      },
    };
  }
  if (
    readInventoryPositionForItemLocation(
      database,
      command.merchantId,
      command.inventoryItemId,
      command.locationId,
    ) !== undefined
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "inventoryItemId+locationId",
      },
    };
  }
  const location = snapshot?.resources.locations.find(
    (candidate) => candidate.id === command.locationId,
  );
  const locationRevisionError = checkInventoryRevision(
    "location",
    command.locationId,
    command.locationRevision,
    location?.revision,
  );
  if (locationRevisionError !== undefined)
    return { kind: "rejected", error: locationRevisionError };
  if (location === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "location",
        id: command.locationId,
      },
    };
  }
  const zero = { amount: 0, scale: 0, unit: item.baseUnit };
  const position = parseInventoryPosition({
    id: command.inventoryPositionId,
    revision: 1,
    inventoryItemId: command.inventoryItemId,
    locationId: command.locationId,
    balance: {
      kind: "accounted",
      onHand: zero,
      allocated: zero,
      available: zero,
    },
    occurredAt: command.requestedAt,
  });
  return { kind: "planned", value: position };
}

export function planInventoryReceipt(
  database: CommerceDatabase,
  command: ReceiveCommerceInventoryV3,
  now: () => string,
  checkPurchase: ReceiptPurchaseCheck,
): InventoryMovementPlanResult {
  const position = readInventoryPosition(
    database,
    command.merchantId,
    command.inventoryPositionId,
  );
  const revisionError = checkInventoryRevision(
    "inventory_position",
    command.inventoryPositionId,
    command.inventoryPositionRevision,
    position?.revision,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (position === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_position",
        id: command.inventoryPositionId,
      },
    };
  }
  const item = readInventoryItem(
    database,
    command.merchantId,
    command.inventoryItemId,
  );
  if (item === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_item",
        id: command.inventoryItemId,
      },
    };
  }
  const itemRevisionError = checkInventoryRevision(
    "inventory_item",
    command.inventoryItemId,
    command.inventoryItemRevision,
    item.revision,
  );
  if (itemRevisionError !== undefined)
    return { kind: "rejected", error: itemRevisionError };
  if (position.inventoryItemId !== command.inventoryItemId) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "inventoryPositionId",
      },
    };
  }
  if (position.locationId !== command.locationId) {
    return {
      kind: "rejected",
      error: { code: "resource_relationship_invalid", field: "locationId" },
    };
  }
  if (item.baseUnit !== command.receivedQuantity.unit) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "receivedQuantity.unit",
      },
    };
  }
  const lotError = validateReceiptLot(command, item);
  if (lotError !== undefined) return { kind: "rejected", error: lotError };
  const purchaseError = checkPurchase(database, command);
  if (purchaseError !== undefined)
    return { kind: "rejected", error: purchaseError };
  if (command.lot.kind === "tracked") {
    if (
      readInventoryLot(database, command.merchantId, command.lot.lotId) !==
      undefined
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_already_exists",
          kind: "inventory_lot",
          id: command.lot.lotId,
        },
      };
    }
    for (const existing of listInventoryLots(database, command.merchantId)) {
      if (existing.lotCode === command.lot.lotCode) {
        return {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "lot.lotCode",
          },
        };
      }
    }
  }
  if (position.balance.kind !== "accounted") {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "inventoryPosition.balance",
      },
    };
  }
  const nextAvailable = addQuantity(
    position.balance.available,
    command.receivedQuantity,
  );
  const nextOnHand = addQuantity(
    position.balance.onHand,
    command.receivedQuantity,
  );
  const nextAllocated =
    nextOnHand === undefined
      ? undefined
      : quantityAtScale(position.balance.allocated, nextOnHand.scale);
  if (
    nextAvailable === undefined ||
    nextOnHand === undefined ||
    nextAllocated === undefined
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "receivedQuantity.amount",
      },
    };
  }
  const committedAt = now();
  const movementId = `movement_${sha256(
    `${command.merchantId}:${command.receiptId}:${command.receiptLineId}:receipt`,
  )}`;
  const movement = parseInventoryMovement({
    id: movementId,
    inventoryItemId: command.inventoryItemId,
    locationId: command.locationId,
    change: {
      kind: "increase",
      quantity: command.receivedQuantity,
      reason: {
        kind: "receipt",
        purchase: command.purchase,
        receiptId: command.receiptId,
        receiptLineId: command.receiptLineId,
      },
    },
    occurredAt: command.receivedAt,
    idempotencyKey: command.idempotencyKey,
  });
  const lot =
    command.lot.kind === "tracked"
      ? parseInventoryLot({
          id: command.lot.lotId,
          lotCode: command.lot.lotCode,
          inventoryItemId: command.inventoryItemId,
          locationId: command.locationId,
          revision: 1,
          sourceMovementId: movementId,
          receivedQuantity: command.receivedQuantity,
          remainingQuantity: command.receivedQuantity,
          expiry: command.lot.expiry,
          lifecycle: { state: "available" },
          occurredAt: command.receivedAt,
        })
      : undefined;
  return {
    kind: "planned",
    value: {
      lot,
      movement,
      inventoryPosition: parseInventoryPosition({
        id: position.id,
        revision: position.revision + 1,
        inventoryItemId: position.inventoryItemId,
        locationId: position.locationId,
        balance: {
          kind: "accounted",
          onHand: nextOnHand,
          allocated: nextAllocated,
          available: nextAvailable,
        },
        occurredAt: committedAt,
      }),
      committedAt,
    },
  };
}

export function planInventoryReconciliation(
  database: CommerceDatabase,
  command: ReconcileCommerceInventoryV1,
  now: () => string,
): InventoryMovementPlanResult {
  const position = readInventoryPosition(
    database,
    command.merchantId,
    command.inventoryPositionId,
  );
  const revisionError = checkInventoryRevision(
    "inventory_position",
    command.inventoryPositionId,
    command.inventoryPositionRevision,
    position?.revision,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (position === undefined || position.balance.kind !== "accounted") {
    return reconciliationRejected("inventoryPosition.balance");
  }
  const item = readInventoryItem(
    database,
    command.merchantId,
    position.inventoryItemId,
  );
  if (item === undefined || item.lifecycle !== "active")
    return reconciliationRejected("inventoryItem");
  const lot =
    command.target.kind === "lot"
      ? readInventoryLot(database, command.merchantId, command.target.lotId)
      : undefined;
  if (command.target.kind === "lot") {
    const lotError = checkInventoryRevision(
      "inventory_lot",
      command.target.lotId,
      command.target.lotRevision,
      lot?.revision,
    );
    if (lotError !== undefined) return { kind: "rejected", error: lotError };
    if (
      lot === undefined ||
      lot.inventoryItemId !== item.id ||
      lot.locationId !== position.locationId ||
      item.tracking.kind !== "lot_tracked"
    ) {
      return reconciliationRejected("target.lotId");
    }
  } else if (item.tracking.kind !== "aggregate") {
    return reconciliationRejected("target.kind");
  }
  const changedQuantity =
    command.change.kind === "count"
      ? command.change.observedQuantity
      : command.change.quantity;
  if (changedQuantity.unit !== item.baseUnit)
    return reconciliationRejected("change.quantity.unit");
  const currentQuantity =
    lot === undefined ? position.balance.onHand : lot.remainingQuantity;
  const scale = Math.max(
    changedQuantity.scale,
    currentQuantity.scale,
    position.balance.onHand.scale,
  );
  const current = scaledAmount(currentQuantity, scale);
  const proposed = scaledAmount(changedQuantity, scale);
  const difference =
    command.change.kind === "count"
      ? proposed - current
      : command.change.direction === "increase"
        ? proposed
        : -proposed;
  const nextPhysical =
    scaledAmount(position.balance.onHand, scale) + difference;
  const reserved = scaledAmount(position.balance.allocated, scale);
  const amount = difference < 0n ? -difference : difference;
  if (
    nextPhysical > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    reserved > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return reconciliationRejected("change.quantity.amount");
  }
  if (nextPhysical < reserved) {
    if (nextPhysical < 0n)
      return reconciliationRejected("change.quantity.amount");
    return {
      kind: "rejected",
      error: {
        code: "inventory_count_shortage",
        inventoryPositionId: position.id,
        observedAmount: Number(nextPhysical),
        reservedAmount: Number(reserved),
        scale,
        unit: item.baseUnit,
      },
    };
  }
  const quantity: CommerceQuantityV1 = {
    amount: Number(amount),
    scale,
    unit: item.baseUnit,
  };
  const committedAt = now();
  let nextLot: CommerceInventoryLotV1 | undefined;
  if (lot !== undefined) {
    const factor = 10n ** BigInt(scale - lot.remainingQuantity.scale);
    const remaining = current + difference;
    if (
      remaining < 0n ||
      remaining % factor !== 0n ||
      remaining / factor > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return reconciliationRejected("change.lotQuantity.precision");
    }
    const remainingQuantity = {
      amount: Number(remaining / factor),
      scale: lot.remainingQuantity.scale,
      unit: item.baseUnit,
    };
    nextLot = parseInventoryLot({
      id: lot.id,
      lotCode: lot.lotCode,
      inventoryItemId: lot.inventoryItemId,
      locationId: lot.locationId,
      revision: lot.revision + 1,
      sourceMovementId: lot.sourceMovementId,
      receivedQuantity: lot.receivedQuantity,
      remainingQuantity,
      expiry: lot.expiry,
      lifecycle: movedLotLifecycle(
        lot,
        remainingQuantity.amount,
        command.requestedAt,
      ),
      occurredAt: committedAt,
    });
  }
  const reason =
    command.change.kind === "count"
      ? {
          kind: "stock_count",
          countId: command.idempotencyKey,
          explanation: command.change.explanation,
          observedQuantity: command.change.observedQuantity,
        }
      : {
          kind: command.change.reason,
          explanation: command.change.explanation,
        };
  const movement = parseInventoryMovement({
    id: `movement_${sha256(`${command.merchantId}:${command.idempotencyKey}:reconciliation`)}`,
    inventoryItemId: item.id,
    locationId: position.locationId,
    change:
      difference >= 0n
        ? { kind: "increase", quantity, reason }
        : {
            kind: "decrease",
            quantity,
            reason,
            lotAllocation:
              lot === undefined
                ? { kind: "not_tracked" }
                : { kind: "allocated", lots: [{ lotId: lot.id, quantity }] },
          },
    occurredAt: command.requestedAt,
    idempotencyKey: command.idempotencyKey,
  });
  return {
    kind: "planned",
    value: {
      lot: nextLot,
      movement,
      committedAt,
      inventoryPosition: parseInventoryPosition({
        id: position.id,
        revision: position.revision + 1,
        inventoryItemId: item.id,
        locationId: position.locationId,
        balance: {
          kind: "accounted",
          onHand: { amount: Number(nextPhysical), scale, unit: item.baseUnit },
          allocated: { amount: Number(reserved), scale, unit: item.baseUnit },
          available: {
            amount: Number(nextPhysical - reserved),
            scale,
            unit: item.baseUnit,
          },
        },
        occurredAt: committedAt,
      }),
    },
  };
}

function reconciliationRejected(field: string): InventoryMovementPlanResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

export function inventoryMovementObservations(
  plan: InventoryMovementPlan,
): readonly CommerceAggregateObservationV1[] {
  const observations: CommerceAggregateObservationV1[] = [
    { kind: "inventory_movement", resource: plan.movement },
  ];
  if (plan.lot !== undefined) {
    observations.push({ kind: "inventory_lot", resource: plan.lot });
  }
  observations.push({
    kind: "inventory_position",
    resource: plan.inventoryPosition,
  });
  return observations;
}

function validateReceiptLot(
  command: ReceiveCommerceInventoryV3,
  item: CommerceInventoryItemV1,
): CommerceMutationErrorV1 | undefined {
  switch (item.tracking.kind) {
    case "aggregate":
      return command.lot.kind === "not_tracked"
        ? undefined
        : { code: "resource_relationship_invalid", field: "lot" };
    case "lot_tracked":
      if (command.lot.kind !== "tracked") {
        return { code: "resource_relationship_invalid", field: "lot" };
      }
      if (
        item.tracking.expiry === "required" &&
        command.lot.expiry.kind !== "expires"
      ) {
        return { code: "resource_relationship_invalid", field: "lot.expiry" };
      }
      return undefined;
  }
}

export function checkInventoryRevision(
  kind: string,
  id: string,
  expected: number,
  actual: number | undefined,
): CommerceMutationErrorV1 | undefined {
  if (actual === undefined) return { code: "resource_not_found", kind, id };
  if (actual !== expected)
    return { code: "stale_resource_revision", kind, id, expected, actual };
  return undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
