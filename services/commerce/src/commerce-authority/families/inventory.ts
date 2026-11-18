import {
  listInventoryAllocations,
  listConsumptionPlansForVariant,
} from "../../checkout-persistence.ts";
import { usableInventoryQuantity } from "../inventory-planning.ts";
import type {
  CommerceMutationResultV1,
  CommerceInventoryLotV1,
  CommerceInventoryMovementV1,
  CommerceStockSnapshot,
} from "@seams/commerce-client";
import { inventoryItemWithId } from "../inventory-items.ts";
import { IntegrationFamily } from "./integrations.ts";

/**
 * Inventory commands and the food service kitchen.
 */
export abstract class InventoryFamily extends IntegrationFamily {
  /** Whether the food service extension is installed. */
  get hasFoodService(): boolean {
    return this.foodService !== undefined;
  }

  createPreparationStation(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().createPreparationStation(rawCommand);
  }

  createModifierGroupRevision(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().createModifierGroupRevision(rawCommand);
  }

  createRecipeRevision(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().createRecipeRevision(rawCommand);
  }

  configureStockPolicy(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().configureStockPolicy(rawCommand);
  }

  publishMenu(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().publishMenu(rawCommand);
  }

  markSoldOut(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().markSoldOut(rawCommand);
  }

  managePreparationTicket(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().managePreparationTicket(rawCommand);
  }

  completeProductionBatch(rawCommand: unknown): CommerceMutationResultV1 {
    return this.kitchen().completeProductionBatch(rawCommand);
  }

  createInventoryItem(rawCommand: unknown): CommerceMutationResultV1 {
    return this.inventoryCommands.createInventoryItem(rawCommand);
  }

  openInventoryPosition(rawCommand: unknown): CommerceMutationResultV1 {
    return this.inventoryCommands.openInventoryPosition(rawCommand);
  }

  receiveInventory(rawCommand: unknown): CommerceMutationResultV1 {
    return this.inventoryCommands.receiveInventory(rawCommand);
  }

  reconcileInventory(rawCommand: unknown): CommerceMutationResultV1 {
    return this.inventoryCommands.reconcileInventory(rawCommand);
  }

  /** The alarm's `lot_expiry` pass; returns when the next lot expires. */
  expireLapsedLots(): string | null {
    return this.inventoryCommands.expireLapsedLots();
  }

  readInventoryLot(
    merchantId: string,
    lotId: string,
  ): CommerceInventoryLotV1 | undefined {
    return this.inventoryCommands.readInventoryLot(merchantId, lotId);
  }

  listInventoryMovements(
    merchantId: string,
  ): readonly CommerceInventoryMovementV1[] {
    return this.inventoryCommands.listInventoryMovements(merchantId);
  }

  listInventoryLots(merchantId: string): readonly CommerceInventoryLotV1[] {
    return this.inventoryCommands.listInventoryLots(merchantId);
  }

  readStockSnapshot(merchantId: string): CommerceStockSnapshot | undefined {
    const commerce = this.readSnapshot(merchantId);
    const foodService = this.readFoodServiceSnapshot(merchantId);
    if (commerce === undefined || foodService === undefined) return undefined;
    const consumptionPlans = [];
    for (const variant of commerce.resources.variants)
      consumptionPlans.push(
        ...listConsumptionPlansForVariant(
          this.database,
          merchantId,
          variant.id,
        ),
      );
    const lots = this.listInventoryLots(merchantId);
    const usable = [];
    const observedAt = this.now();
    for (const position of commerce.resources.inventoryPositions) {
      const item = commerce.resources.inventoryItems.find(
        inventoryItemWithId.bind(null, position.inventoryItemId),
      );
      if (item === undefined) throw new Error("Inventory position has no item");
      usable.push({
        positionId: position.id,
        quantity: usableInventoryQuantity(item, position, lots, observedAt),
      });
    }
    return {
      commerce,
      foodService,
      consumptionPlans,
      lots,
      usable,
      movements: this.listInventoryMovements(merchantId),
      allocations: listInventoryAllocations(this.database, merchantId),
    };
  }
}
