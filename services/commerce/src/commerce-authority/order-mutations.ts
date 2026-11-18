// The mutations of draft orders, returns and order edits, as the ledger
// commits them.
import {
  orderChangeAllocationWrite,
  writeInventoryAllocation,
} from "../checkout-persistence.ts";
import { writeFulfillment } from "../commerce-persistence.ts";
import {
  insertReceiptMovement,
  updateInventoryPosition,
} from "../inventory-persistence.ts";
import {
  type DraftOrderCommitRequest,
  writeDraftOrder,
} from "../plugins/draft-orders/index.ts";
import { inventoryMovementObservations } from "./inventory.ts";
import {
  fulfillmentObservation,
  inventoryPositionObservation,
  orderObservation,
} from "./observations.ts";
import { insertOrderChange, writeOrderAfterRevision } from "./order-changes.ts";
import {
  type OrderEditCommitRequest,
  type OrderExchangeCommitRequest,
} from "./order-edits.ts";
import {
  type ReturnCommitRequest,
  writeReturn,
} from "../plugins/returns/index.ts";
import type { CommerceMutation } from "./ledger.ts";

export function draftOrderMutation(
  request: DraftOrderCommitRequest,
  committedAt: string,
  sealBuyerEmail: (merchantId: string, email: string, at: string) => string,
): CommerceMutation {
  const { command, merchant, draft } = request;
  const commandKind =
    command.schemaVersion === "underclerk.create-draft-order.v1"
      ? ("create_draft_order" as const)
      : command.schemaVersion === "underclerk.update-draft-order.v1"
        ? ("update_draft_order" as const)
        : command.schemaVersion === "underclerk.send-draft-invoice.v1"
          ? ("send_draft_invoice" as const)
          : ("cancel_draft_order" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: { kind: "draft_order", id: draft.id, revision: draft.revision },
    observations: [],
    write: (database) => {
      writeDraftOrder(
        database,
        command.merchantId,
        request.buyerEmail === undefined
          ? draft
          : {
              ...draft,
              buyer: {
                customerId: sealBuyerEmail(
                  command.merchantId,
                  request.buyerEmail,
                  committedAt,
                ),
                email: null,
              },
            },
      );
    },
  };
}

export function returnMutation(
  request: ReturnCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant, record, restocks } = request;
  const commandKind =
    command.schemaVersion === "underclerk.request-return.v1"
      ? ("request_return" as const)
      : command.schemaVersion === "underclerk.authorize-return.v1"
        ? ("authorize_return" as const)
        : command.schemaVersion === "underclerk.receive-return.v1"
          ? ("receive_return" as const)
          : ("close_return" as const);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: { kind: "return", id: record.id, revision: record.revision },
    observations: restocks.flatMap(inventoryMovementObservations),
    write: (database) => {
      writeReturn(database, command.merchantId, record);
      for (const restock of restocks) {
        insertReceiptMovement(
          database,
          command.merchantId,
          restock.inventoryPosition.id,
          restock.movement,
        );
        updateInventoryPosition(
          database,
          command.merchantId,
          restock.inventoryPosition.revision - 1,
          restock.inventoryPosition,
        );
      }
    },
  };
}

export function orderEditMutation(
  request: OrderEditCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: "edit_order",
    resource: {
      kind: "commerce_order",
      id: request.order.id,
      revision: request.order.revision,
    },
    observations: [
      orderObservation(request.order),
      fulfillmentObservation(request.fulfillment),
      ...request.positions.map(inventoryPositionObservation),
    ],
    write: (database) => {
      writeOrderAfterRevision(
        database,
        command.merchantId,
        request.order,
        request.previousOrderRevision,
      );
      writeFulfillment(database, command.merchantId, request.fulfillment);
      for (const allocation of request.allocations)
        writeInventoryAllocation(
          database,
          command.merchantId,
          orderChangeAllocationWrite(allocation),
          allocation,
        );
      for (const position of request.positions)
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      insertOrderChange(database, command.merchantId, request.edit);
    },
  };
}

export function orderExchangeMutation(
  request: OrderExchangeCommitRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: "exchange_order_lines",
    resource: {
      kind: "commerce_order",
      id: request.order.id,
      revision: request.order.revision,
    },
    observations: [
      orderObservation(request.order),
      fulfillmentObservation(request.fulfillment),
      ...request.positions.map(inventoryPositionObservation),
    ],
    write: (database) => {
      writeOrderAfterRevision(
        database,
        command.merchantId,
        request.order,
        request.previousOrderRevision,
      );
      writeFulfillment(database, command.merchantId, request.fulfillment);
      for (const allocation of request.allocations)
        writeInventoryAllocation(
          database,
          command.merchantId,
          orderChangeAllocationWrite(allocation),
          allocation,
        );
      for (const position of request.positions)
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      insertOrderChange(database, command.merchantId, request.exchange);
      writeReturn(database, command.merchantId, request.returnRecord);
    },
  };
}
