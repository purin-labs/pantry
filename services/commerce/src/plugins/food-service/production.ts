import { readProductionRequestFields } from "../../entity-plane/production-requests.ts";
import { merchantOwner } from "./merchant-owner.ts";
import {
  productionQuantityUnscaled,
  type ProductionRequestFields,
} from "@purin-labs/commerce-client";
import { createHash } from "node:crypto";

import {
  parseInventoryMovement,
  type CompleteProductionBatchCommand,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceMutationErrorV1,
} from "@purin-labs/commerce-client";
import type { ProductionBatch } from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../../database.ts";
import { foodProvenance, readRecipeRevision } from "./food-service-store.ts";
import {
  accountedPositionCanConsume,
  consumedProductionInventoryPosition,
  increasedProductionInventoryPosition,
  isAccountedPosition,
  planSaleLotConsumption,
  sameQuantity,
} from "../../commerce-authority/inventory-planning.ts";
import {
  listInventoryLots,
  readInventoryLot,
  readInventoryPositionForItemLocation,
} from "../../inventory-persistence.ts";

export type ProductionBatchPlan = Readonly<{
  batch: ProductionBatch;
  inputMovements: readonly CommerceInventoryMovementV1[];
  outputMovement: CommerceInventoryMovementV1;
  outputLot: CommerceInventoryLotV1;
  positions: readonly CommerceInventoryPositionV1[];
  lots: readonly CommerceInventoryLotV1[];
}>;

export type ProductionBatchPlanResult =
  | Readonly<{ kind: "planned"; value: ProductionBatchPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planProductionBatch(
  database: CommerceDatabase,
  command: CompleteProductionBatchCommand,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): ProductionBatchPlanResult {
  const shipmentDemand =
    command.demand.kind === "shipment" ? command.demand : undefined;
  if (
    shipmentDemand !== undefined &&
    resources.shipments.every(
      (shipment) => shipment.id !== shipmentDemand.shipmentId,
    )
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "shipment",
        id: shipmentDemand.shipmentId,
      },
    };
  }
  const station = foodService.preparationStations.find(
    (candidate) => candidate.stationId === command.stationId,
  );
  if (station === undefined)
    return productionBatchRejected("productionBatch.station");
  if (
    station.lifecycle !== "active" ||
    station.locationId !== command.locationId
  ) {
    return productionBatchRejected("productionBatch.station.location");
  }
  const location = resources.locations.find(
    (candidate) => candidate.id === command.locationId,
  );
  if (location === undefined)
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "location",
        id: command.locationId,
      },
    };
  if (location.lifecycle.state !== "active")
    return productionBatchRejected("productionBatch.location");
  const recipe = readRecipeRevision(
    database,
    command.merchantId,
    command.recipeId,
    command.recipeRevision,
  );
  if (recipe === undefined)
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "recipe_revision",
        id: command.recipeId,
      },
    };
  if (
    recipe.revision !== command.recipeRevision ||
    recipe.lifecycle.state !== "active" ||
    recipe.output.kind !== "stocked"
  ) {
    return productionBatchRejected("productionBatch.recipe");
  }
  if (
    !sameQuantity(command.plannedYield, recipe.output.yieldQuantity) ||
    command.actualYield.unit !== recipe.output.yieldQuantity.unit ||
    command.actualYield.amount <= 0
  ) {
    return productionBatchRejected("productionBatch.yield");
  }
  if (command.demand.kind === "request") {
    const requestError = validateProductionRequest(
      database,
      command,
      recipe.output.inventoryItemId,
      foodService,
    );
    if (requestError !== undefined)
      return { kind: "rejected", error: requestError };
  }
  const items = new Map(
    resources.inventoryItems.map((item) => [item.id, item]),
  );
  const outputItem = items.get(recipe.output.inventoryItemId);
  if (outputItem === undefined)
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_item",
        id: recipe.output.inventoryItemId,
      },
    };
  if (
    outputItem.lifecycle !== "active" ||
    outputItem.tracking.kind !== "lot_tracked"
  ) {
    return productionBatchRejected("productionBatch.output.inventoryItem");
  }
  if (
    outputItem.tracking.expiry === "required" &&
    command.outputExpiresAt.length === 0
  ) {
    return productionBatchRejected("productionBatch.outputExpiresAt");
  }
  if (
    readInventoryLot(database, command.merchantId, command.outputLotId) !==
    undefined
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_already_exists",
        kind: "inventory_lot",
        id: command.outputLotId,
      },
    };
  }
  const duplicateLotCode = listInventoryLots(database, command.merchantId).some(
    (lot) => lot.lotCode === command.outputLotCode,
  );
  if (duplicateLotCode)
    return productionBatchRejected("productionBatch.outputLotCode");
  const outputPosition = readInventoryPositionForItemLocation(
    database,
    command.merchantId,
    outputItem.id,
    command.locationId,
  );
  if (outputPosition === undefined)
    return productionBatchRejected("productionBatch.outputPosition");
  if (
    outputPosition.id !== command.outputInventoryPositionId ||
    !isAccountedPosition(outputPosition) ||
    outputPosition.revision !== command.expectedOutputPositionRevision ||
    outputPosition.balance.onHand.unit !== command.actualYield.unit
  ) {
    return productionBatchRejected("productionBatch.outputPosition");
  }
  if (!timestampBefore(command.requestedAt, command.outputExpiresAt)) {
    return productionBatchRejected("productionBatch.outputExpiresAt");
  }
  const expectedRevisions = new Map<string, number>();
  for (const expected of command.expectedInputPositionRevisions) {
    if (expectedRevisions.has(expected.inventoryPositionId))
      return productionBatchRejected(
        "productionBatch.expectedInputPositionRevisions",
      );
    expectedRevisions.set(expected.inventoryPositionId, expected.revision);
  }
  const expectedPositions = new Map<string, CommerceInventoryPositionV1>();
  const currentLots = new Map<string, CommerceInventoryLotV1>();
  for (const lot of listInventoryLots(database, command.merchantId))
    currentLots.set(lot.id, lot);
  const changedLots = new Map<string, CommerceInventoryLotV1>();
  const positions = new Map<string, CommerceInventoryPositionV1>();
  const inputMovements: CommerceInventoryMovementV1[] = [];
  for (const requirement of recipe.inputs) {
    const item = items.get(requirement.inventoryItemId);
    if (item === undefined)
      return {
        kind: "rejected",
        error: {
          code: "resource_not_found",
          kind: "inventory_item",
          id: requirement.inventoryItemId,
        },
      };
    if (
      item.lifecycle !== "active" ||
      item.baseUnit !== requirement.quantity.unit
    )
      return productionBatchRejected("productionBatch.recipe.inputs");
    const position = readInventoryPositionForItemLocation(
      database,
      command.merchantId,
      item.id,
      command.locationId,
    );
    if (
      position === undefined ||
      !isAccountedPosition(position) ||
      expectedRevisions.get(position.id) !== position.revision ||
      !accountedPositionCanConsume(position, requirement.quantity)
    ) {
      return productionBatchRejected("productionBatch.inputPosition");
    }
    expectedPositions.set(position.id, position);
    const lotPlan = planSaleLotConsumption(
      item,
      {
        inventoryItemId: item.id,
        locationId: command.locationId,
        quantity: requirement.quantity,
      },
      currentLots,
      changedLots,
      command.requestedAt,
    );
    if (lotPlan.kind === "rejected")
      return productionBatchRejected("productionBatch.inputLots");
    const movementId = `movement_${sha256(`${command.merchantId}:${command.productionBatchId}:${item.id}:production`)}`;
    inputMovements.push(
      parseInventoryMovement({
        id: movementId,
        inventoryItemId: item.id,
        locationId: command.locationId,
        change: {
          kind: "decrease",
          quantity: requirement.quantity,
          reason: {
            kind: "production",
            productionBatchId: command.productionBatchId,
            recipeRevision: command.recipeRevision,
          },
          lotAllocation: lotPlan.allocation,
        },
        occurredAt: command.requestedAt,
        idempotencyKey: `${command.idempotencyKey}:${item.id}:input`,
      }),
    );
    const nextPosition = consumedProductionInventoryPosition(
      position,
      requirement.quantity,
      command.requestedAt,
      positions.has(position.id),
    );
    positions.set(position.id, nextPosition);
    for (const lot of lotPlan.lots) {
      currentLots.set(lot.id, lot);
      changedLots.set(lot.id, lot);
    }
  }
  if (expectedRevisions.size !== expectedPositions.size)
    return productionBatchRejected(
      "productionBatch.expectedInputPositionRevisions",
    );
  const currentOutputPosition =
    positions.get(outputPosition.id) ?? outputPosition;
  if (!isAccountedPosition(currentOutputPosition))
    return productionBatchRejected("productionBatch.outputPosition");
  const nextOutputPosition = increasedProductionInventoryPosition(
    currentOutputPosition,
    command.actualYield,
    command.requestedAt,
    positions.has(outputPosition.id),
  );
  positions.set(outputPosition.id, nextOutputPosition);
  const outputMovementId = `movement_${sha256(`${command.merchantId}:${command.productionBatchId}:output:production`)}`;
  const outputMovement = parseInventoryMovement({
    id: outputMovementId,
    inventoryItemId: outputItem.id,
    locationId: command.locationId,
    change: {
      kind: "increase",
      quantity: command.actualYield,
      reason: {
        kind: "production",
        productionBatchId: command.productionBatchId,
        recipeRevision: command.recipeRevision,
      },
    },
    occurredAt: command.requestedAt,
    idempotencyKey: `${command.idempotencyKey}:output`,
  });
  const outputLot = {
    id: command.outputLotId,
    lotCode: command.outputLotCode,
    inventoryItemId: outputItem.id,
    locationId: command.locationId,
    revision: 1,
    sourceMovementId: outputMovement.id,
    receivedQuantity: command.actualYield,
    remainingQuantity: command.actualYield,
    expiry: { kind: "expires" as const, expiresAt: command.outputExpiresAt },
    lifecycle: { state: "available" as const },
    occurredAt: command.requestedAt,
  } satisfies CommerceInventoryLotV1;
  const batch: ProductionBatch = {
    provenance: foodProvenance(
      merchantOwner(database, command.merchantId),
      command.merchantId,
      "production_batch",
      command.productionBatchId,
      1,
      command.requestedAt,
    ),
    productionBatchId: command.productionBatchId,
    demand: command.demand,
    recipeId: recipe.recipeId,
    recipeRevision: recipe.revision,
    locationId: command.locationId,
    stationId: command.stationId,
    revision: 1,
    plannedYield: command.plannedYield,
    actualYield: command.actualYield,
    completedAt: command.requestedAt,
    inputMovementIds: inputMovements.map((movement) => movement.id),
    outputMovementId: outputMovement.id,
    outputLotId: command.outputLotId,
  };
  return {
    kind: "planned",
    value: {
      batch,
      inputMovements,
      outputMovement,
      outputLot,
      positions: [...positions.values()],
      lots: [...changedLots.values()],
    },
  };
}

function validateProductionRequest(
  database: CommerceDatabase,
  command: CompleteProductionBatchCommand,
  inventoryItemId: string,
  foodService: CommerceFoodServiceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  if (command.demand.kind !== "request") return undefined;
  const demand = command.demand;
  const row = database
    .prepare(
      `SELECT revision, entity_id AS itemId FROM commerce_list_entry
    WHERE merchant_id = ? AND entry_id = ? AND list_id = 'production_requests' AND lifecycle_state = 'active'`,
    )
    .get<{ revision: number; itemId: string }>(
      command.merchantId,
      demand.requestId,
    );
  if (row === undefined)
    return {
      code: "resource_not_found",
      kind: "production_request",
      id: demand.requestId,
    };
  if (row.revision !== demand.requestRevision)
    return {
      code: "stale_resource_revision",
      kind: "production_request",
      id: demand.requestId,
      expected: demand.requestRevision,
      actual: row.revision,
    };
  let request: ProductionRequestFields;
  try {
    request = readProductionRequestFields(
      database,
      command.merchantId,
      demand.requestId,
      row.revision,
    );
  } catch {
    return {
      code: "resource_relationship_invalid",
      field: "productionBatch.demand.request",
    };
  }
  if (
    row.itemId !== inventoryItemId ||
    request.recipeId !== command.recipeId ||
    request.recipeRevision !== command.recipeRevision ||
    request.locationId !== command.locationId ||
    request.quantity.unit !== command.actualYield.unit ||
    (request.status !== "accepted" && request.status !== "scheduled")
  )
    return {
      code: "resource_relationship_invalid",
      field: "productionBatch.demand.request",
    };
  let produced = 0n;
  for (const batch of foodService.productionBatches) {
    if (
      batch.demand.kind === "request" &&
      batch.demand.requestId === demand.requestId
    )
      produced +=
        BigInt(batch.actualYield.amount) *
        10n ** BigInt(6 - batch.actualYield.scale);
  }
  produced +=
    BigInt(command.actualYield.amount) *
    10n ** BigInt(6 - command.actualYield.scale);
  if (produced > BigInt(productionQuantityUnscaled(request.quantity)))
    return {
      code: "resource_relationship_invalid",
      field: "productionBatch.demand.remainingQuantity",
    };
  return undefined;
}

function productionBatchRejected(field: string): ProductionBatchPlanResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function timestampBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
