// The mutations of the inventory commands, as the ledger commits them.
import {
  insertInventoryItem,
  insertInventoryLot,
  insertInventoryPosition,
  insertReceiptMovement,
  insertReconciliationMovement,
  updateInventoryLot,
  updateInventoryPosition,
} from "../inventory-persistence.ts";
import {
  type InventoryMovementPlan,
  inventoryMovementObservations,
} from "./inventory.ts";
import { assertNever } from "@purin-labs/std";
import {
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type ReceiveCommerceInventoryV3,
  type ReconcileCommerceInventoryV1,
  type CommerceInventoryItemV1,
  type CommerceInventoryPositionV1,
} from "@purin-labs/commerce-client";
import type { CommerceMutation, MerchantRow } from "./ledger.ts";

export function inventoryItemMutation(
  command: CreateCommerceInventoryItemV1,
  merchant: MerchantRow,
  item: CommerceInventoryItemV1,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "create_inventory_item",
    resource: {
      kind: "inventory_item",
      id: item.id,
      revision: item.revision,
    },
    observations: [{ kind: "inventory_item", resource: item }],
    write: (database) => {
      insertInventoryItem(database, command.merchantId, item);
    },
  };
}

export function inventoryPositionMutation(
  command: OpenCommerceInventoryPositionV1,
  merchant: MerchantRow,
  position: CommerceInventoryPositionV1,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "open_inventory_position",
    resource: {
      kind: "inventory_position",
      id: position.id,
      revision: position.revision,
    },
    observations: [{ kind: "inventory_position", resource: position }],
    write: (database) => {
      insertInventoryPosition(database, command.merchantId, position);
    },
  };
}

export function inventoryMovementMutation(
  command: ReceiveCommerceInventoryV3 | ReconcileCommerceInventoryV1,
  merchant: MerchantRow,
  plan: InventoryMovementPlan,
): CommerceMutation {
  const committedAt = plan.committedAt;
  const commandKind =
    command.schemaVersion === "commerce.receive-inventory.v3"
      ? "receive_inventory"
      : "reconcile_inventory";
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "inventory_movement",
      id: plan.movement.id,
      revision: 1,
    },
    observations: inventoryMovementObservations(plan),
    write: (database) => {
      switch (command.schemaVersion) {
        case "commerce.receive-inventory.v3":
          insertReceiptMovement(
            database,
            command.merchantId,
            command.inventoryPositionId,
            plan.movement,
          );
          if (plan.lot !== undefined)
            insertInventoryLot(
              database,
              command.merchantId,
              command.inventoryPositionId,
              plan.lot,
            );
          break;
        case "commerce.reconcile-inventory.v1":
          insertReconciliationMovement(
            database,
            command.merchantId,
            command.inventoryPositionId,
            plan.movement,
          );
          if (command.target.kind === "lot" && plan.lot !== undefined)
            updateInventoryLot(
              database,
              command.merchantId,
              command.target.lotRevision,
              plan.lot,
            );
          break;
        default:
          assertNever(command);
      }
      updateInventoryPosition(
        database,
        command.merchantId,
        command.inventoryPositionRevision,
        plan.inventoryPosition,
      );
    },
  };
}
