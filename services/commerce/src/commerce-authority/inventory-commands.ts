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
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import type { ReceiptPurchaseCheck } from "../plugins/built-in-ports.ts";
import { readCommerceMigrationInventory } from "../migration-inventory.ts";
import { expireLapsedLots } from "./lot-expiry.ts";
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

export type InventoryMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

type InventoryCommand =
  | CreateCommerceInventoryItemV1
  | OpenCommerceInventoryPositionV1
  | ReceiveCommerceInventoryV3
  | ReconcileCommerceInventoryV1;

export type InventoryCommitRequest =
  | Readonly<{
      kind: "inventory_item";
      command: CreateCommerceInventoryItemV1;
      merchant: InventoryMerchantRow;
      item: CommerceInventoryItemV1;
    }>
  | Readonly<{
      kind: "inventory_position";
      command: OpenCommerceInventoryPositionV1;
      merchant: InventoryMerchantRow;
      position: CommerceInventoryPositionV1;
    }>
  | Readonly<{
      kind: "inventory_receipt";
      command: ReceiveCommerceInventoryV3;
      merchant: InventoryMerchantRow;
      plan: InventoryMovementPlan;
    }>
  | Readonly<{
      kind: "inventory_reconciliation";
      command: ReconcileCommerceInventoryV1;
      merchant: InventoryMerchantRow;
      plan: InventoryMovementPlan;
    }>;

type InventoryCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => InventoryMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: InventoryCommand,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: InventoryCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: InventoryMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  checkReceiptPurchase: ReceiptPurchaseCheck;
}>;

export class InventoryCommandAuthority {
  readonly #options: InventoryCommandAuthorityOptions;

  constructor(options: InventoryCommandAuthorityOptions) {
    this.#options = options;
  }

  createInventoryItem(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CreateCommerceInventoryItemV1;
    try {
      command = parseCreateInventoryItemCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
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
    let command: OpenCommerceInventoryPositionV1;
    try {
      command = parseOpenInventoryPositionCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
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
    let command: ReceiveCommerceInventoryV3;
    try {
      command = parseReceiveInventoryCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
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
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
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
    let command: ReconcileCommerceInventoryV1;
    try {
      command = parseReconcileInventoryCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
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
      requireInventoryIdentity(merchantId, "merchantId"),
      requireInventoryIdentity(lotId, "lotId"),
    );
  }

  listInventoryMovements(
    merchantId: string,
  ): readonly CommerceInventoryMovementV1[] {
    return listStoredInventoryMovements(
      this.#options.database,
      requireInventoryIdentity(merchantId, "merchantId"),
    );
  }

  listInventoryLots(merchantId: string): readonly CommerceInventoryLotV1[] {
    return listStoredInventoryLots(
      this.#options.database,
      requireInventoryIdentity(merchantId, "merchantId"),
    );
  }

  readMigrationInventory(
    merchantId: string,
  ): CommerceMigrationInventoryV2 | undefined {
    return readCommerceMigrationInventory(this.#options.database, merchantId);
  }
}

function requireInventoryIdentity(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim())
    throw new Error(`${field} must be normalized text`);
  return value;
}
