// A balance that staff took in cash or by bank transfer (Plan 77 step 2).
// After an edit raises an order's total, the buyer can pay the difference
// through a balance checkout, or staff record that they took it outside a
// payment provider. The record is one captured payment of the outstanding
// balance, its manual tender and the order's payment change, in one commit.
// While the buyer's card payment of a balance is in progress, staff cannot
// record the same money; a balance checkout from an earlier order revision
// cannot start a payment (planCheckoutPaymentStart).
import {
  parsePayment,
  type RecordCommerceOrderManualPaymentV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceOrderPaymentChangeV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
} from "@seams/commerce-client";
import { commerceTransition } from "@seams/commerce-contracts";

import { writePayment } from "../commerce-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  findResource,
  sameMoney,
  sha256,
} from "../commerce-authority/checkout-shared.ts";
import type {
  CommerceMutation,
  MerchantRow,
} from "../commerce-authority/ledger.ts";
import {
  orderObservation,
  paymentObservation,
} from "../commerce-authority/observations.ts";
import {
  insertOrderChange,
  orderWithAddedPayment,
  writeOrderAfterRevision,
} from "../commerce-authority/order-changes.ts";
import { writeManualTender, type ManualTender } from "./manual-tender.ts";
import { orderBalance } from "./position.ts";

type OrderManualPaymentPlan = Readonly<{
  order: CommerceOrderV1;
  previousOrderRevision: number;
  payment: CommercePaymentV1;
  tender: ManualTender;
  change: CommerceOrderPaymentChangeV1;
}>;

export function planOrderManualPayment(
  database: CommerceDatabase,
  command: RecordCommerceOrderManualPaymentV1,
  resources: CommerceMerchantSnapshotV1["resources"],
): OrderManualPaymentPlan | CommerceMutationErrorV1 {
  const order = findResource(resources.orders, command.orderId);
  if (order === undefined)
    return { code: "resource_not_found", kind: "order", id: command.orderId };
  if (order.revision !== command.expectedOrderRevision)
    return {
      code: "stale_resource_revision",
      kind: "order",
      id: order.id,
      expected: command.expectedOrderRevision,
      actual: order.revision,
    };
  if (findResource(resources.payments, command.paymentId) !== undefined)
    return {
      code: "resource_already_exists",
      kind: "payment",
      id: command.paymentId,
    };
  const payBalance = commerceTransition(
    "order",
    order.lifecycle,
    "pay_balance",
  );
  if (!payBalance.allowed) return payBalance.refusal;
  const outstanding = orderBalance(order, resources.payments).outstanding;
  if (outstanding.amountMinor === 0)
    return {
      code: "resource_relationship_invalid",
      field: "orderBalance.none",
    };
  if (!sameMoney(command.amount, outstanding))
    return { code: "resource_relationship_invalid", field: "amount" };
  if (balancePaymentInProgress(database, command.merchantId, order.id))
    return {
      code: "resource_relationship_invalid",
      field: "orderBalance.paymentPending",
    };
  const payment = parsePayment({
    id: command.paymentId,
    revision: 1,
    orderId: order.id,
    amount: command.amount,
    lifecycle: { state: "captured", capturedAt: command.requestedAt },
    occurredAt: command.requestedAt,
  });
  const next = orderWithAddedPayment(order, command.requestedAt);
  return {
    order: next,
    previousOrderRevision: order.revision,
    payment,
    tender: {
      ...command.tender,
      paymentId: payment.id,
      orderId: order.id,
      amountMinor: command.amount.amountMinor,
      currency: command.amount.currency,
      recordedAt: command.requestedAt,
    },
    change: {
      kind: "payment",
      id: `order_change_${sha256(`${order.id}:${payment.id}`)}`,
      orderId: order.id,
      orderRevisionBefore: order.revision,
      orderRevisionAfter: next.revision,
      paymentId: payment.id,
      amount: payment.amount,
      occurredAt: command.requestedAt,
    },
  };
}

export function orderManualPaymentMutation(
  command: RecordCommerceOrderManualPaymentV1,
  merchant: MerchantRow,
  plan: OrderManualPaymentPlan,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "record_order_manual_payment",
    resource: {
      kind: "commerce_order",
      id: plan.order.id,
      revision: plan.order.revision,
    },
    observations: [
      orderObservation(plan.order),
      paymentObservation(plan.payment),
    ],
    write: (database) => {
      writeOrderAfterRevision(
        database,
        command.merchantId,
        plan.order,
        plan.previousOrderRevision,
      );
      writePayment(database, command.merchantId, plan.payment);
      writeManualTender(database, command.merchantId, plan.tender);
      insertOrderChange(database, command.merchantId, plan.change);
    },
  };
}

/** Whether a buyer's card payment of the order's balance is under way. */
function balancePaymentInProgress(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS found FROM buyer_checkout
         WHERE merchant_id = ? AND lifecycle_state = 'payment_pending'
           AND json_extract(checkout_json,
             '$.lifecycle.quote.lines[0].source.kind') = 'order_balance'
           AND json_extract(checkout_json,
             '$.lifecycle.quote.lines[0].source.orderId') = ?
         LIMIT 1`,
      )
      .get<Readonly<{ found: number }>>(merchantId, orderId) !== undefined
  );
}
