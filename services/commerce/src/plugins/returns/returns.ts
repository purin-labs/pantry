import { guardMove } from "../machine-guards.ts";
import {
  parseAuthorizeReturnCommand,
  parseCloseReturnCommand,
  parseReceiveReturnCommand,
  parseRequestReturnCommand,
  parseReturn,
  type ReceiveCommerceInventoryV3,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceOrderV1,
  type CommercePluginSettingsV1,
  type CommerceReturnCommandV1,
  type CommerceReturnLineV1,
  type CommerceReturnV1,
} from "@seams/commerce-client";

import { commerceTransition } from "@seams/commerce-contracts";
import { listRefundAttemptsForOrder } from "../../payments/payment-records.ts";
import type { CommerceDatabase } from "../../database.ts";
import type { ReceiptPurchaseCheck } from "../built-in-ports.ts";
import { returnWindowMs } from "./settings.ts";
import { findResource, sha256 } from "../../commerce-authority/checkout-shared.ts";
import {
  planInventoryReceipt,
  type InventoryMovementPlan,
} from "../../commerce-authority/inventory.ts";

export type ReturnMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type ReturnCommitRequest = Readonly<{
  command: CommerceReturnCommandV1;
  merchant: ReturnMerchantRow;
  record: CommerceReturnV1;
  /** Stock receipts for restocked units, one for each stock position. */
  restocks: readonly InventoryMovementPlan[];
}>;

type ReturnCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => ReturnMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CommerceReturnCommandV1,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: ReturnCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: ReturnMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  /** The plugin's settings for the merchant, with the defaults filled in. */
  readSettings: (merchantId: string) => CommercePluginSettingsV1;
}>;

type Planned = Readonly<{
  record: CommerceReturnV1;
  restocks: readonly InventoryMovementPlan[];
}>;

export class ReturnCommandAuthority {
  readonly #options: ReturnCommandAuthorityOptions;

  constructor(options: ReturnCommandAuthorityOptions) {
    this.#options = options;
  }

  requestReturn(
    rawCommand: unknown,
    requestedBy: CommerceReturnV1["requestedBy"] = "staff",
  ): CommerceMutationResultV1 {
    return this.#run(
      rawCommand,
      parseRequestReturnCommand,
      (command, resources) => {
        if (this.#read(command.merchantId, command.returnId) !== undefined)
          return {
            code: "resource_already_exists",
            kind: "return",
            id: command.returnId,
          };
        const order = findResource(resources.orders, command.orderId);
        if (order === undefined)
          return {
            code: "resource_not_found",
            kind: "commerce_order",
            id: command.orderId,
          };
        const request = commerceTransition(
          "order",
          order.lifecycle,
          "request_return",
        );
        if (!request.allowed) return request.refusal;
        if (
          Date.parse(command.requestedAt) >
          Date.parse(request.from.fulfilledAt) +
            returnWindowMs(this.#options.readSettings(command.merchantId))
        )
          return invalid("return.window");
        const returned = this.#returnedQuantities(command.merchantId, order.id);
        for (const line of command.lines) {
          const error = requestLineError(order, line, returned);
          if (error !== undefined) return error;
        }
        return {
          record: {
            id: command.returnId,
            revision: 1,
            orderId: order.id,
            requestedBy,
            lines: command.lines.map((line) => ({
              ...line,
              decision: "pending",
              disposition: null,
            })),
            lifecycle: { state: "requested", requestedAt: command.requestedAt },
            occurredAt: command.requestedAt,
          },
          restocks: [],
        };
      },
    );
  }

  authorizeReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseAuthorizeReturnCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.returnId,
        command.expectedReturnRevision,
      );
      if ("code" in current) return current;
      // One authorized line authorizes the return; none rejects it.
      const event = command.decisions.some(
        (item) => item.decision === "authorized",
      )
        ? "authorize"
        : "reject";
      const decide = commerceTransition("return", current.lifecycle, event);
      if (!decide.allowed) return decide.refusal;
      // A merchant plugin's guard can refuse the decision.
      const guarded = guardMove(this.#options.database, command.merchantId, {
        machine: "return",
        event,
        from: current.lifecycle.state,
        to: decide.to,
        subject: {
          kind: "return",
          id: command.returnId,
          orderId: current.orderId,
          decisions: command.decisions,
        },
        at: command.requestedAt,
        attempt: command.idempotencyKey,
      });
      if (guarded !== undefined) return guarded;
      const decisions = new Map(
        command.decisions.map((item) => [item.orderLineId, item.decision]),
      );
      if (
        decisions.size !== command.decisions.length ||
        decisions.size !== current.lines.length ||
        current.lines.some((line) => !decisions.has(line.orderLineId))
      )
        return invalid("return.decisions");
      const lines = current.lines.map((line) => ({
        ...line,
        decision: decisions.get(line.orderLineId) ?? line.decision,
      }));
      return {
        record: {
          ...current,
          revision: current.revision + 1,
          lines,
          lifecycle:
            decide.to === "authorized"
              ? { state: decide.to, authorizedAt: command.requestedAt }
              : { state: decide.to, rejectedAt: command.requestedAt },
          occurredAt: command.requestedAt,
        },
        restocks: [],
      };
    });
  }

  receiveReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(
      rawCommand,
      parseReceiveReturnCommand,
      (command, resources) => {
        const current = this.#current(
          command.merchantId,
          command.returnId,
          command.expectedReturnRevision,
        );
        if ("code" in current) return current;
        const receive = commerceTransition(
          "return",
          current.lifecycle,
          "receive",
        );
        if (!receive.allowed) return receive.refusal;
        const authorized = current.lines.filter(
          (line) => line.decision === "authorized",
        );
        const dispositions = new Map(
          command.dispositions.map((item) => [
            item.orderLineId,
            item.disposition,
          ]),
        );
        if (
          dispositions.size !== command.dispositions.length ||
          dispositions.size !== authorized.length ||
          authorized.some((line) => !dispositions.has(line.orderLineId))
        )
          return invalid("return.dispositions");
        const location = findResource(resources.locations, command.locationId);
        if (location === undefined)
          return {
            code: "resource_not_found",
            kind: "location",
            id: command.locationId,
          };
        const order = findResource(resources.orders, current.orderId);
        if (order === undefined) throw new Error("A return lost its order");
        const lines: CommerceReturnLineV1[] = current.lines.map((line) => ({
          ...line,
          disposition: dispositions.get(line.orderLineId) ?? null,
        }));
        const restocks = this.#restocks(command, resources, order, lines);
        if ("code" in restocks) return restocks;
        return {
          record: {
            ...current,
            revision: current.revision + 1,
            lines,
            lifecycle: {
              state: receive.to,
              receivedAt: command.requestedAt,
              locationId: command.locationId,
            },
            occurredAt: command.requestedAt,
          },
          restocks,
        };
      },
    );
  }

  closeReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCloseReturnCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.returnId,
        command.expectedReturnRevision,
      );
      if ("code" in current) return current;
      const close = commerceTransition("return", current.lifecycle, "close");
      if (!close.allowed) return close.refusal;
      if (command.refundAttemptId !== null) {
        const refund = listRefundAttemptsForOrder(
          this.#options.database,
          command.merchantId,
          current.orderId,
        ).find(
          (stored) =>
            stored.attempt.refundAttemptId === command.refundAttemptId,
        );
        if (refund === undefined)
          return {
            code: "resource_not_found",
            kind: "refund_attempt",
            id: command.refundAttemptId,
          };
        if (refund.attempt.lifecycle.state !== "succeeded")
          return invalid("return.refund.lifecycle");
        if (
          this.#listForOrder(command.merchantId, current.orderId).some(
            (other) =>
              other.id !== current.id &&
              other.lifecycle.state === "closed" &&
              other.lifecycle.refundAttemptId === command.refundAttemptId,
          )
        )
          return invalid("return.refund.used");
      }
      return {
        record: {
          ...current,
          revision: current.revision + 1,
          lifecycle: {
            state: close.to,
            closedAt: command.requestedAt,
            refundAttemptId: command.refundAttemptId,
          },
          occurredAt: command.requestedAt,
        },
        restocks: [],
      };
    });
  }

  listOrderReturns(
    merchantId: string,
    orderId: string,
  ): readonly CommerceReturnV1[] {
    return this.#listForOrder(merchantId, orderId);
  }

  #run<TCommand extends CommerceReturnCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
      resources: CommerceMerchantSnapshotV1["resources"],
    ) => Planned | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    let command: TCommand;
    try {
      command = parse(rawCommand);
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
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const planned = plan(command, snapshot.resources);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({ command, merchant, ...planned });
  }

  // One stock receipt for each position: the order line's inventory items,
  // times the returned units, at the receiving location.
  #restocks(
    command: Extract<
      CommerceReturnCommandV1,
      { schemaVersion: "underclerk.receive-return.v1" }
    >,
    resources: CommerceMerchantSnapshotV1["resources"],
    order: CommerceOrderV1,
    lines: readonly CommerceReturnLineV1[],
  ): readonly InventoryMovementPlan[] | CommerceMutationErrorV1 {
    const amounts = new Map<string, number>();
    for (const line of lines) {
      if (line.disposition !== "restock") continue;
      const orderLine = findResource(order.lineItems, line.orderLineId);
      if (orderLine === undefined || orderLine.source.kind !== "catalog")
        return invalid("return.restock.line");
      const inventory = orderLine.source.inventory;
      if (inventory.kind !== "requirements") continue;
      for (const requirement of inventory.items) {
        if (
          requirement.quantity.unit !== "each" ||
          requirement.quantity.scale !== 0
        )
          return invalid("return.restock.unit");
        amounts.set(
          requirement.inventoryItemId,
          (amounts.get(requirement.inventoryItemId) ?? 0) +
            requirement.quantity.amount * line.quantity,
        );
      }
    }
    const plans: InventoryMovementPlan[] = [];
    for (const [inventoryItemId, amount] of [...amounts].sort()) {
      const item = findResource(resources.inventoryItems, inventoryItemId);
      if (item === undefined)
        return {
          code: "resource_not_found",
          kind: "inventory_item",
          id: inventoryItemId,
        };
      // A returned unit has no lot of its own to go back to.
      if (item.tracking.kind !== "aggregate")
        return invalid("return.restock.lotTracked");
      const position = resources.inventoryPositions.find(
        (candidate) =>
          candidate.inventoryItemId === inventoryItemId &&
          candidate.locationId === command.locationId,
      );
      if (position === undefined) return invalid("return.restock.position");
      const receipt: ReceiveCommerceInventoryV3 = {
        schemaVersion: "underclerk.receive-inventory.v3",
        purchase: { kind: "unlinked" },
        merchantId: command.merchantId,
        expectedMerchantRevision: 0,
        idempotencyKey: `${command.idempotencyKey}:restock:${position.id}`,
        requestedAt: command.requestedAt,
        receiptId: `return_${sha256(`${command.merchantId}:${command.returnId}`)}`,
        receiptLineId: position.id,
        inventoryItemId,
        inventoryItemRevision: item.revision,
        inventoryPositionId: position.id,
        inventoryPositionRevision: position.revision,
        locationId: command.locationId,
        receivedQuantity: { amount, scale: 0, unit: "each" },
        lot: { kind: "not_tracked" },
        receivedAt: command.requestedAt,
      };
      // A return restocks with no purchase request.
      const planned = planInventoryReceipt(
        this.#options.database,
        receipt,
        this.#options.now,
        restockNamesNoPurchase,
      );
      if (planned.kind === "rejected") return planned.error;
      plans.push(planned.value);
    }
    return plans;
  }

  // Units already in a return that was not rejected, for each order line.
  #returnedQuantities(
    merchantId: string,
    orderId: string,
  ): ReadonlyMap<string, number> {
    const returned = new Map<string, number>();
    for (const record of this.#listForOrder(merchantId, orderId)) {
      if (record.lifecycle.state === "rejected") continue;
      for (const line of record.lines) {
        if (line.decision === "rejected") continue;
        returned.set(
          line.orderLineId,
          (returned.get(line.orderLineId) ?? 0) + line.quantity,
        );
      }
    }
    return returned;
  }

  #current(
    merchantId: string,
    returnId: string,
    expectedRevision: number,
  ): CommerceReturnV1 | CommerceMutationErrorV1 {
    const record = this.#read(merchantId, returnId);
    if (record === undefined)
      return { code: "resource_not_found", kind: "return", id: returnId };
    if (record.revision !== expectedRevision)
      return {
        code: "stale_resource_revision",
        kind: "return",
        id: returnId,
        expected: expectedRevision,
        actual: record.revision,
      };
    return record;
  }

  #read(merchantId: string, returnId: string): CommerceReturnV1 | undefined {
    const row = this.#options.database
      .prepare(
        `SELECT return_json AS returnJson FROM order_return
         WHERE merchant_id = ? AND return_id = ?`,
      )
      .get<Readonly<{ returnJson: string }>>(merchantId, returnId);
    return row === undefined
      ? undefined
      : parseReturn(JSON.parse(row.returnJson));
  }

  #listForOrder(
    merchantId: string,
    orderId: string,
  ): readonly CommerceReturnV1[] {
    return this.#options.database
      .prepare(
        `SELECT return_json AS returnJson FROM order_return
         WHERE merchant_id = ? AND order_id = ? ORDER BY return_id`,
      )
      .all<Readonly<{ returnJson: string }>>(merchantId, orderId)
      .map((row) => parseReturn(JSON.parse(row.returnJson)));
  }
}

export function readReturn(
  database: CommerceDatabase,
  merchantId: string,
  returnId: string,
): CommerceReturnV1 | undefined {
  const row = database
    .prepare(
      `SELECT return_json AS returnJson FROM order_return
       WHERE merchant_id = ? AND return_id = ?`,
    )
    .get<Readonly<{ returnJson: string }>>(merchantId, returnId);
  return row === undefined ? undefined : parseReturn(JSON.parse(row.returnJson));
}

export function writeReturn(
  database: CommerceDatabase,
  merchantId: string,
  record: CommerceReturnV1,
): void {
  const written = database
    .prepare(
      `INSERT INTO order_return (
         merchant_id, return_id, order_id, revision, lifecycle_state,
         return_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, return_id) DO UPDATE SET
         revision = excluded.revision,
         lifecycle_state = excluded.lifecycle_state,
         return_json = excluded.return_json,
         occurred_at = excluded.occurred_at
       WHERE order_return.revision = excluded.revision - 1`,
    )
    .run(
      merchantId,
      record.id,
      record.orderId,
      record.revision,
      record.lifecycle.state,
      JSON.stringify(record),
      record.occurredAt,
    );
  if (written.changes !== 1)
    throw new Error(`Return ${record.id} moved during the write`);
}

function requestLineError(
  order: CommerceOrderV1,
  line: Readonly<{ orderLineId: string; quantity: number }>,
  returned: ReadonlyMap<string, number>,
): CommerceMutationErrorV1 | undefined {
  const orderLine = findResource(order.lineItems, line.orderLineId);
  if (orderLine === undefined)
    return {
      code: "resource_not_found",
      kind: "order_line",
      id: line.orderLineId,
    };
  // Food made to order is not returnable.
  if (orderLine.source.kind !== "catalog")
    return invalid("return.lines.returnable");
  const fulfilled = orderLine.fulfilledQuantity.amount;
  if (line.quantity > fulfilled - (returned.get(line.orderLineId) ?? 0))
    return invalid("return.lines.quantity");
  return undefined;
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

/** A restock from a return never names a purchase request. */
const restockNamesNoPurchase: ReceiptPurchaseCheck = (_database, command) =>
  command.purchase.kind === "unlinked"
    ? undefined
    : { code: "resource_relationship_invalid", field: "purchase.entryId" };
