// Runs an approved stock action through the commands of the person's Stock
// page. The action keeps what the approval signed; the merchant revision, and
// for a delivery the item and position revisions, are read now, because a
// delivery adds to whatever is on the shelf.
import {
  parseListEntryReadRequest,
  parseReceiveInventoryCommand,
  parseReconcileInventoryCommand,
  productionRequestAttributes,
  commerceCommandInput,
  type CommerceAdminClient,
  type CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import type { CommerceCommandResult } from "@purin-labs/commerce-contracts";

import {
  commerceListEntryPatchCommand,
  productionRequestCreateCommand,
} from "./contract/list-entry-commands";
import type {
  StockOperationAction,
  StockProductionAdvanceOperation,
  StockProductionRequestOperation,
  StockPurchaseRequestOperation,
  StockReceiveOperation,
  StockCountOperation,
} from "./stock-action";

export type StockReceiptFields = Readonly<{
  receiptId: string;
  effectId: string;
  deliveryId: string;
  resource: Readonly<{ revision: number }>;
  merchantId: string;
  merchantRevision: number;
  committedAt: string;
}>;

export type StockExecution =
  | Readonly<{ kind: "settled"; receipt: StockReceiptFields }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

type StockExecutionInput = Readonly<{
  admin: CommerceAdminClient;
  plane: CommerceEntityPlaneClient;
  organisationId: string;
  merchantId: string;
  actor: string;
  idempotencyKey: string;
  nonce: string;
  action: StockOperationAction;
  now: number;
}>;

const ABSENT: StockExecution = { kind: "absent" };
const INDETERMINATE: StockExecution = { kind: "indeterminate" };

export function executeStockOperation(
  input: StockExecutionInput,
): Promise<StockExecution> {
  const operation = input.action.operation;
  switch (operation.kind) {
    case "receive_stock":
      return receiveStock(input, operation);
    case "count_stock":
      return countStock(input, operation);
    case "request_production":
    case "advance_production_request":
    case "update_purchase_request":
      return commandListEntry(input, operation);
  }
}

/** Whether the action committed under its key. Absent lets it run again. */
export async function reconcileStockOperation(
  input: StockExecutionInput,
): Promise<StockExecution> {
  const operation = input.action.operation;
  switch (operation.kind) {
    case "receive_stock":
    case "count_stock": {
      const read = await input.admin.readMutationReceipt(
        input.merchantId,
        input.idempotencyKey,
      );
      if (!read.ok) return INDETERMINATE;
      if (read.value === null) return ABSENT;
      return read.value.merchantId === input.merchantId &&
        read.value.idempotencyKey === input.idempotencyKey
        ? { kind: "settled", receipt: read.value }
        : INDETERMINATE;
    }
    case "request_production":
    case "advance_production_request":
    case "update_purchase_request": {
      const read = await input.plane.readListEntry(
        parseListEntryReadRequest({
          merchantId: input.merchantId,
          listId: listIdOf(operation),
          entryId: entryIdOf(input, operation),
        }),
      );
      if (!read.ok) return INDETERMINATE;
      if (operation.kind === "request_production") {
        if (read.value.kind === "missing") return ABSENT;
      } else {
        if (read.value.kind === "missing") return ABSENT;
        const revision = Number(read.value.entry.revision);
        if (revision === operation.expectedRevision) return ABSENT;
        if (revision !== operation.expectedRevision + 1) return INDETERMINATE;
      }
      // The same command under the same id answers with its first receipt.
      // A change that someone else made is refused as a stale list entry.
      return commandListEntry(input, operation);
    }
  }
}

async function receiveStock(
  input: StockExecutionInput,
  operation: StockReceiveOperation,
): Promise<StockExecution> {
  const snapshot = await input.admin.readStockSnapshot(input.merchantId);
  if (!snapshot.ok) return INDETERMINATE;
  const resources = snapshot.value.commerce.resources;
  const position = resources.inventoryPositions.find(
    (candidate) => candidate.id === operation.inventoryPositionId,
  );
  const item = resources.inventoryItems.find(
    (candidate) => candidate.id === operation.inventoryItemId,
  );
  if (position === undefined || item === undefined) return ABSENT;
  let purchase:
    | Readonly<{ kind: "unlinked" }>
    | Readonly<{ kind: "replenishment"; entryId: string; entryRevision: number }> =
    { kind: "unlinked" };
  if (operation.purchaseRequestEntryId !== null) {
    const entry = await input.plane.readListEntry(
      parseListEntryReadRequest({
        merchantId: input.merchantId,
        listId: "replenishment_queue",
        entryId: operation.purchaseRequestEntryId,
      }),
    );
    if (!entry.ok) return INDETERMINATE;
    if (entry.value.kind === "missing") return ABSENT;
    purchase = {
      kind: "replenishment",
      entryId: operation.purchaseRequestEntryId,
      entryRevision: Number(entry.value.entry.revision),
    };
  }
  const receivedAt = operation.receivedAt ?? new Date(input.now).toISOString();
  let command: ReturnType<typeof parseReceiveInventoryCommand>;
  try {
    command = parseReceiveInventoryCommand({
      schemaVersion: "underclerk.receive-inventory.v3",
      purchase,
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision: snapshot.value.commerce.merchantRevision,
      inventoryItemId: item.id,
      inventoryItemRevision: item.revision,
      inventoryPositionId: position.id,
      inventoryPositionRevision: position.revision,
      locationId: operation.locationId,
      receivedQuantity: operation.quantity,
      lot:
        operation.lot.kind === "not_tracked"
          ? { kind: "not_tracked" }
          : {
              kind: "tracked",
              lotId: `lot_${input.nonce}`,
              lotCode: operation.lot.lotCode,
              expiry:
                operation.lot.expiresAt === null
                  ? { kind: "not_tracked" }
                  : { kind: "expires", expiresAt: operation.lot.expiresAt },
            },
      receiptId: `receipt_${input.nonce}`,
      receiptLineId: "1",
      receivedAt,
      requestedAt: receivedAt,
      idempotencyKey: input.idempotencyKey,
      actionNonce: `inventory_receipt:${input.nonce}`,
    });
  } catch {
    return ABSENT;
  }
  return settleMutation(
    await input.admin.receiveInventory(commerceCommandInput(command)),
  );
}

async function countStock(
  input: StockExecutionInput,
  operation: StockCountOperation,
): Promise<StockExecution> {
  const snapshot = await input.admin.readStockSnapshot(input.merchantId);
  if (!snapshot.ok) return INDETERMINATE;
  const explanation = input.action.reason;
  let command: ReturnType<typeof parseReconcileInventoryCommand>;
  try {
    command = parseReconcileInventoryCommand({
      schemaVersion: "underclerk.reconcile-inventory.v1",
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision: snapshot.value.commerce.merchantRevision,
      inventoryPositionId: operation.inventoryPositionId,
      inventoryPositionRevision: operation.expectedPositionRevision,
      target:
        operation.target.kind === "aggregate"
          ? { kind: "aggregate" }
          : {
              kind: "lot",
              lotId: operation.target.lotId,
              lotRevision: operation.target.lotRevision,
            },
      change:
        operation.change.kind === "count"
          ? {
              kind: "count",
              observedQuantity: operation.change.observedQuantity,
              explanation,
            }
          : {
              kind: "adjustment",
              direction: operation.change.direction,
              quantity: operation.change.quantity,
              reason: operation.change.reason,
              explanation,
            },
      requestedAt: new Date(input.now).toISOString(),
      idempotencyKey: input.idempotencyKey,
      actionNonce: `inventory_reconciliation:${input.nonce}`,
    });
  } catch {
    return ABSENT;
  }
  return settleMutation(
    await input.admin.reconcileInventory(commerceCommandInput(command)),
  );
}

function settleMutation(
  result: Awaited<ReturnType<CommerceAdminClient["receiveInventory"]>>,
): StockExecution {
  if (!result.ok)
    return result.error.kind === "rejected" ? ABSENT : INDETERMINATE;
  if (result.value.outcome === "rejected") return ABSENT;
  return { kind: "settled", receipt: result.value.receipt };
}

type ListEntryOperation =
  | StockProductionRequestOperation
  | StockProductionAdvanceOperation
  | StockPurchaseRequestOperation;

function listIdOf(operation: ListEntryOperation): string {
  return operation.kind === "update_purchase_request"
    ? "replenishment_queue"
    : "production_requests";
}

function entryIdOf(
  input: Pick<StockExecutionInput, "idempotencyKey">,
  operation: ListEntryOperation,
): string {
  return operation.kind === "request_production"
    ? `production_request_${input.idempotencyKey}`
    : operation.entryId;
}

async function commandListEntry(
  input: StockExecutionInput,
  operation: ListEntryOperation,
): Promise<StockExecution> {
  const snapshot = await input.admin.readStockSnapshot(input.merchantId);
  if (!snapshot.ok) return INDETERMINATE;
  const commandId = `stock:${input.idempotencyKey}`;
  let command;
  try {
    command = listEntryCommand(input, operation, {
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      principalId: input.actor,
      commandId,
      merchantRevision: snapshot.value.commerce.merchantRevision,
      listRevision: operation.listRevision,
    });
  } catch {
    return ABSENT;
  }
  const result = await input.plane.command(command);
  if (!result.ok) return INDETERMINATE;
  return settleListEntry(result.value, input.merchantId, commandId);
}

function listEntryCommand(
  input: StockExecutionInput,
  operation: ListEntryOperation,
  scope: Parameters<typeof commerceListEntryPatchCommand>[0] extends infer T
    ? Omit<T, "listId" | "entryId" | "entryRevision" | "attributeValues">
    : never,
) {
  switch (operation.kind) {
    case "request_production":
      return productionRequestCreateCommand({
        ...scope,
        entryId: entryIdOf(input, operation),
        inventoryItemId: operation.inventoryItemId,
        fields: {
          status: "requested",
          recipeId: operation.recipeId,
          recipeRevision: operation.recipeRevision,
          locationId: operation.locationId,
          quantity: operation.quantity,
          neededBy: operation.neededBy,
        },
      });
    case "advance_production_request":
      return commerceListEntryPatchCommand({
        ...scope,
        listId: "production_requests",
        entryId: operation.entryId,
        entryRevision: operation.expectedRevision,
        attributeValues: productionRequestAttributes({
          status: operation.status,
          recipeId: operation.recipeId,
          recipeRevision: operation.recipeRevision,
          locationId: operation.locationId,
          quantity: operation.quantity,
          neededBy: operation.neededBy,
        }),
      });
    case "update_purchase_request":
      return commerceListEntryPatchCommand({
        ...scope,
        listId: "replenishment_queue",
        entryId: operation.entryId,
        entryRevision: operation.expectedRevision,
        attributeValues: operation.attributeValues,
      });
  }
}

function settleListEntry(
  result: CommerceCommandResult,
  merchantId: string,
  commandId: string,
): StockExecution {
  if (result.status !== "accepted") return ABSENT;
  const { receipt } = result;
  if (receipt.target.kind !== "commerce_list_entry") return INDETERMINATE;
  return {
    kind: "settled",
    receipt: {
      receiptId: commandId,
      effectId: commandId,
      deliveryId: receipt.deliveryId ?? commandId,
      resource: { revision: Number(receipt.target.revision) },
      merchantId,
      merchantRevision: Number(receipt.merchantRevision),
      committedAt: String(receipt.committedAt),
    },
  };
}
