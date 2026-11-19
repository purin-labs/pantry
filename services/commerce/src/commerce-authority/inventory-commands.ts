import {
  parseCreateInventoryItemCommand,
  parseOpenInventoryPositionCommand,
  parseReceiveInventoryCommand,
  parseReconcileInventoryCommand,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type ReceiveCommerceInventoryV3,
  type ReconcileCommerceInventoryV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryItemV1,
  type CommerceInventoryPositionV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMigrationInventoryV2,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import type { ReceiptPurchaseCheck } from "../plugins/built-in-ports.ts";
import { readCommerceMigrationInventory } from "../migration-inventory.ts";
import { requireIdentity } from "./command-guards.ts";
import type { MerchantRow } from "./ledger.ts";
import { expireLapsedLots } from "./lot-expiry.ts";
import {
  beginMerchantCommand,
  staleMerchantRevision,
  type MerchantCommandPorts,
} from "./merchant-command.ts";
import {
  listInventoryLots as listStoredInventoryLots,
  listInventoryMovements as listStoredInventoryMovements,
  readInventoryLot as readStoredInventoryLot,
  readReceiptMovement,
} from "../inventory-persistence.ts";
import {
  planInventoryItem,
  planInventoryPosition,
  planInventoryReceipt,
  planInventoryReconciliation,
  type InventoryMovementPlan,
} from "./inventory.ts";

type InventoryCommand =
  | CreateCommerceInventoryItemV1
  | OpenCommerceInventoryPositionV1
  | ReceiveCommerceInventoryV3
  | ReconcileCommerceInventoryV1;

export type InventoryCommitRequest =
  | Readonly<{
      kind: "inventory_item";
      command: CreateCommerceInventoryItemV1;
      merchant: MerchantRow;
      item: CommerceInventoryItemV1;
    }>
  | Readonly<{
      kind: "inventory_position";
      command: OpenCommerceInventoryPositionV1;
      merchant: MerchantRow;
      position: CommerceInventoryPositionV1;
    }>
  | Readonly<{
      kind: "inventory_receipt";
      command: ReceiveCommerceInventoryV3;
      merchant: MerchantRow;
      plan: InventoryMovementPlan;
    }>
  | Readonly<{
      kind: "inventory_reconciliation";
      command: ReconcileCommerceInventoryV1;
      merchant: MerchantRow;
      plan: InventoryMovementPlan;
    }>;

type InventoryCommandAuthorityOptions = MerchantCommandPorts<InventoryCommand> &
  Readonly<{
    database: CommerceDatabase;
    now: () => string;
    readSnapshot: (
      merchantId: string,
    ) => CommerceMerchantSnapshotV1 | undefined;
    commit: (request: InventoryCommitRequest) => CommerceMutationResultV1;
    checkReceiptPurchase: ReceiptPurchaseCheck;
  }>;

export class InventoryCommandAuthority {
  readonly #options: InventoryCommandAuthorityOptions;

  constructor(options: InventoryCommandAuthorityOptions) {
    this.#options = options;
  }

  createInventoryItem(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseCreateInventoryItemCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const plan = planInventoryItem(this.#options.database, command);
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "inventory_item",
      command,
      merchant,
      item: plan.value,
    });
  }

  openInventoryPosition(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseOpenInventoryPositionCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const plan = planInventoryPosition(
      this.#options.database,
      command,
      this.#options.readSnapshot(command.merchantId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "inventory_position",
      command,
      merchant,
      position: plan.value,
    });
  }

  receiveInventory(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseReceiveInventoryCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    // A receipt line applied before is refused before a stale revision.
    const existingMovement = readReceiptMovement(
      this.#options.database,
      command.merchantId,
      command.receiptId,
      command.receiptLineId,
    );
    if (existingMovement !== undefined) {
      return this.#options.rejected({
        code: "inventory_receipt_already_applied",
        receiptId: command.receiptId,
        receiptLineId: command.receiptLineId,
        movementId: existingMovement.id,
      });
    }
    const stale = staleMerchantRevision(merchant, command);
    if (stale !== undefined) return this.#options.rejected(stale);
    const plan = planInventoryReceipt(
      this.#options.database,
      command,
      this.#options.now,
      this.#options.checkReceiptPurchase,
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "inventory_receipt",
      command,
      merchant,
      plan: plan.value,
    });
  }

  reconcileInventory(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseReconcileInventoryCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const plan = planInventoryReconciliation(
      this.#options.database,
      command,
      this.#options.now,
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "inventory_reconciliation",
      command,
      merchant,
      plan: plan.value,
    });
  }

  /**
   * The `lot_expiry` pass: writes off the free stock of each lot whose
   * expiry passed. Returns when the next lot expires.
   */
  expireLapsedLots(): string | null {
    return expireLapsedLots({
      database: this.#options.database,
      now: this.#options.now,
      readMerchant: this.#options.readMerchant,
      reconcileInventory: (command) => this.reconcileInventory(command),
    });
  }

  readInventoryLot(
    merchantId: string,
    lotId: string,
  ): CommerceInventoryLotV1 | undefined {
    return readStoredInventoryLot(
      this.#options.database,
      requireIdentity(merchantId, "merchantId"),
      requireIdentity(lotId, "lotId"),
    );
  }

  listInventoryMovements(
    merchantId: string,
  ): readonly CommerceInventoryMovementV1[] {
    return listStoredInventoryMovements(
      this.#options.database,
      requireIdentity(merchantId, "merchantId"),
    );
  }

  listInventoryLots(merchantId: string): readonly CommerceInventoryLotV1[] {
    return listStoredInventoryLots(
      this.#options.database,
      requireIdentity(merchantId, "merchantId"),
    );
  }

  readMigrationInventory(
    merchantId: string,
  ): CommerceMigrationInventoryV2 | undefined {
    return readCommerceMigrationInventory(this.#options.database, merchantId);
  }
}
