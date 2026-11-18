// The mutations of cancellations and refunds, as the ledger commits them. A
// refund first reserves its attempt with a delivery and no receipt; the
// resolution after the payment provider answers records the receipt.
import {
  advanceRefundAttempt,
  insertRefundCommand,
  reserveRefundAttempt,
} from "../payments/payment-records.ts";
import { writeInventoryAllocation } from "../checkout-persistence.ts";
import {
  writeFulfillment,
  writeOrder,
  writePayment,
} from "../commerce-persistence.ts";
import { updateInventoryPosition } from "../inventory-persistence.ts";
import {
  type CancellationReservationPlan,
  type CancellationResolutionPlan,
  type RefundReservationPlan,
  type RefundResolutionPlan,
} from "./after-sale-cancellation.ts";
import { refundAttemptMoney } from "../payments/position.ts";
import {
  fulfillmentObservation,
  inventoryPositionObservation,
  orderObservation,
  paymentObservation,
} from "./observations.ts";
import {
  type CancelCommerceOrderV1,
  type RefundCommerceOrderV1,
} from "@seams/commerce-client";
import type { CustomerAuthority } from "../plugins/customers/index.ts";
import { creditStoredValueRefund } from "../plugins/stored-value/index.ts";
import {
  cancelledTicketObservation,
  writeCancelledTicket,
} from "../plugins/food-service/index.ts";
import type {
  CommerceMutation,
  CommerceReservation,
  MerchantRow,
} from "./ledger.ts";

export function cancellationReservation(
  command: CancelCommerceOrderV1,
  merchant: MerchantRow,
  plan: CancellationReservationPlan,
  digest: string,
): CommerceReservation {
  return {
    command,
    merchant,
    committedAt: command.requestedAt,
    commandDigest: digest,
    observations: [
      orderObservation(plan.order),
      fulfillmentObservation(plan.fulfillment),
      ...plan.tickets.map(cancelledTicketObservation),
      ...plan.positions.map(inventoryPositionObservation),
    ],
    write: (database) => {
      writeOrder(database, command.merchantId, plan.order);
      writeFulfillment(database, command.merchantId, plan.fulfillment);
      for (const ticket of plan.tickets)
        writeCancelledTicket(database, command.merchantId, ticket);
      for (const allocation of plan.allocations) {
        writeInventoryAllocation(
          database,
          command.merchantId,
          "release",
          allocation,
        );
      }
      for (const position of plan.positions) {
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      }
      reserveRefundAttempt(
        database,
        command.merchantId,
        plan.refundAttempt,
        digest,
      );
      insertRefundCommand(
        database,
        command.merchantId,
        plan.refundAttempt.refundAttemptId,
        command,
      );
    },
  };
}

export function refundReservation(
  command: RefundCommerceOrderV1,
  merchant: MerchantRow,
  plan: RefundReservationPlan,
  digest: string,
): CommerceReservation {
  return {
    command,
    merchant,
    committedAt: command.requestedAt,
    commandDigest: digest,
    observations: [orderObservation(plan.order)],
    write: (database) => {
      writeOrder(database, command.merchantId, plan.order);
      reserveRefundAttempt(
        database,
        command.merchantId,
        plan.refundAttempt,
        digest,
      );
      insertRefundCommand(
        database,
        command.merchantId,
        plan.refundAttempt.refundAttemptId,
        command,
      );
    },
  };
}

export function cancellationResolutionMutation(
  command: CancelCommerceOrderV1,
  merchant: MerchantRow,
  plan: CancellationResolutionPlan,
  committedAt: string,
  customers: CustomerAuthority,
): CommerceMutation {
  return refundResolution(
    command,
    merchant,
    plan,
    committedAt,
    customers,
    "cancel_order",
    "Successful cancellation refund plan lost terminal evidence",
  );
}

export function refundResolutionMutation(
  command: RefundCommerceOrderV1,
  merchant: MerchantRow,
  plan: RefundResolutionPlan,
  committedAt: string,
  customers: CustomerAuthority,
): CommerceMutation {
  return refundResolution(
    command,
    merchant,
    plan,
    committedAt,
    customers,
    "refund_order",
    "Successful refund plan lost terminal evidence",
  );
}

function refundResolution(
  command: CancelCommerceOrderV1 | RefundCommerceOrderV1,
  merchant: MerchantRow,
  plan: CancellationResolutionPlan | RefundResolutionPlan,
  committedAt: string,
  customers: CustomerAuthority,
  commandKind: "cancel_order" | "refund_order",
  lostEvidence: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "refund_attempt",
      id: plan.refundAttempt.refundAttemptId,
      revision: plan.refundAttempt.revision,
    },
    observations:
      plan.kind === "refunded"
        ? [orderObservation(plan.order), paymentObservation(plan.payment)]
        : [orderObservation(plan.order)],
    // A processing or indeterminate refund leaves the command open to a
    // retry, so no receipt answers it yet.
    recordReceipt: plan.kind !== "processing" && plan.kind !== "indeterminate",
    write: (database) => {
      if (
        plan.kind === "refunded" &&
        plan.refundAttempt.lifecycle.state !== "succeeded"
      ) {
        throw new Error(lostEvidence);
      }
      advanceRefundAttempt(
        database,
        command.merchantId,
        plan.refundAttempt.revision - 1,
        plan.refundAttempt,
      );
      writeOrder(database, command.merchantId, plan.order);
      if (plan.kind === "refunded") {
        writePayment(database, command.merchantId, plan.payment);
        // A refund with no payment provider credits its money here, in the
        // same transaction as the refund it records.
        if (plan.storedValueCredit !== undefined) {
          creditStoredValueRefund(
            database,
            command.merchantId,
            plan.storedValueCredit,
            {
              refundAttemptId: plan.refundAttempt.refundAttemptId,
              amountMinor: refundAttemptMoney(plan.refundAttempt).amountMinor,
              orderId: plan.refundAttempt.orderId,
              paymentId: plan.refundAttempt.paymentId,
              at: committedAt,
            },
          );
        }
        customers.notifyRefundIssued(
          command.merchantId,
          plan.refundAttempt.orderId,
          plan.refundAttempt.refundAttemptId,
          committedAt,
        );
      }
    },
  };
}
