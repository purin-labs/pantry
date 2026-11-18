// The mutations of checkouts and their payments, as the ledger commits them.
import {
  advancePaymentDispute,
  reservePaymentDispute,
} from "../payments/payment-records.ts";
import {
  writeCart,
  writeCheckout,
  writeCheckoutPaymentAttempt,
  writeInventoryAllocation,
} from "../checkout-persistence.ts";
import {
  writeFulfillment,
  writeOrder,
  writePayment,
  writeShipment,
} from "../commerce-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import { updateInventoryPosition } from "../inventory-persistence.ts";
import {
  type CheckoutPaymentCapturePlan,
  type CheckoutPaymentStartPlan,
  type CheckoutPlacementPlan,
  type PaidPlacementCommand,
} from "./checkout-payment-planning.ts";
import { writeManualTender } from "../payments/manual-tender.ts";
import { writeInvoice } from "../plugins/companies/index.ts";
import { recordFunctionRuns } from "../plugins/merchant-plugins.ts";
import {
  type BuyerPickupCheckoutCommand,
  type BuyerShippingCheckoutCommand,
  type InPersonCheckoutPlan,
  type PickupCheckoutPlan,
} from "./checkout-planning.ts";
import { CustomerAuthority } from "../plugins/customers/index.ts";
import { holdDiscounts, redeemDiscounts } from "../plugins/discounts/index.ts";
import {
  holdStoredValue,
  redeemStoredValue,
  releaseStoredValue,
} from "../plugins/stored-value/index.ts";
import {
  fulfillmentObservation,
  inventoryPositionObservation,
  orderObservation,
  paymentObservation,
  shipmentObservation,
} from "./observations.ts";
import { insertOrderChange, writeOrderAfterRevision } from "./order-changes.ts";
import { type OrderBalanceCheckoutRequest } from "./order-edits.ts";
import {
  type BeginCommerceCheckoutPaymentV1,
  type CollectCommerceInPersonCheckoutPaymentV1,
  type CreateCommerceInPersonCheckoutV1,
  type CreateCommercePickupCheckoutV1,
  type ExpireCommerceCheckoutV1,
  type ObserveCommercePaymentDisputeV1,
  type RecordCommerceCheckoutPaymentCaptureV1,
  type ResolveCommerceCheckoutPaymentV1,
  type CommerceInventoryPositionV1,
} from "@seams/commerce-client";
import {
  type Checkout,
  type CheckoutPaymentAttempt,
  type InventoryAllocation,
  type PaymentDispute,
} from "@seams/commerce-contracts";
import type { CommerceMutation, MerchantRow } from "./ledger.ts";

export function inPersonCheckoutMutation(
  command: CreateCommerceInPersonCheckoutV1,
  merchant: MerchantRow,
  plan: InPersonCheckoutPlan,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "create_in_person_checkout",
    resource: {
      kind: "checkout",
      id: plan.checkout.checkoutId,
      revision: plan.checkout.revision,
    },
    observations: plan.positions.map(inventoryPositionObservation),
    write: (database) => {
      // No cart is written: a counter basket exists only as the Checkout.
      writeCheckout(database, command.merchantId, plan.checkout);
      for (const allocation of plan.allocations) {
        writeInventoryAllocation(
          database,
          command.merchantId,
          "open",
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
      if (plan.discountHolds !== undefined)
        holdDiscounts(
          database,
          command.merchantId,
          plan.checkout.checkoutId,
          plan.discountHolds.customerId,
          plan.discountHolds.holds,
          plan.discountHolds.expiresAt,
          committedAt,
        );
      const quote = plan.checkout.lifecycle.quote;
      if (
        quote.pluginRuns !== undefined ||
        (plan.pluginFailures?.length ?? 0) > 0
      )
        recordFunctionRuns(
          database,
          command.merchantId,
          {
            id: plan.checkout.checkoutId,
            attempt: String(plan.checkout.revision),
          },
          quote.pluginRuns ?? [],
          plan.pluginFailures ?? [],
          committedAt,
        );
    },
  };
}

export function pickupCheckoutMutation(
  command: CreateCommercePickupCheckoutV1 | BuyerPickupCheckoutCommand,
  merchant: MerchantRow,
  plan: PickupCheckoutPlan,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "create_pickup_checkout",
    resource: {
      kind: "checkout",
      id: plan.checkout.checkoutId,
      revision: plan.checkout.revision,
    },
    observations: plan.positions.map(inventoryPositionObservation),
    write: (database) => {
      writeCheckoutHolds(database, command.merchantId, plan, committedAt);
      // The buyer's own pickup time, which a refresh keeps.
      if ("pickupAt" in command && command.pickupAt !== undefined)
        database
          .prepare(
            `INSERT OR REPLACE INTO checkout_pickup_choice
               (merchant_id, checkout_id, pickup_at) VALUES (?, ?, ?)`,
          )
          .run(command.merchantId, plan.checkout.checkoutId, command.pickupAt);
      else
        database
          .prepare(
            "DELETE FROM checkout_pickup_choice WHERE merchant_id = ? AND checkout_id = ?",
          )
          .run(command.merchantId, plan.checkout.checkoutId);
      recordQuoteFunctionRuns(database, command.merchantId, plan, committedAt);
    },
  };
}

export function shippingCheckoutMutation(
  command: BuyerShippingCheckoutCommand,
  merchant: MerchantRow,
  plan: PickupCheckoutPlan,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "create_shipping_checkout",
    resource: {
      kind: "checkout",
      id: plan.checkout.checkoutId,
      revision: plan.checkout.revision,
    },
    observations: plan.positions.map(inventoryPositionObservation),
    write: (database) => {
      writeCheckoutHolds(database, command.merchantId, plan, committedAt);
      recordQuoteFunctionRuns(database, command.merchantId, plan, committedAt);
    },
  };
}

// The cart and checkout of a buyer checkout, with what its quote holds:
// stock, discounts and stored value.
function writeCheckoutHolds(
  database: CommerceDatabase,
  merchantId: string,
  plan: PickupCheckoutPlan,
  committedAt: string,
): void {
  writeCart(database, merchantId, plan.cart);
  writeCheckout(database, merchantId, plan.checkout);
  for (const allocation of plan.releasedAllocations ?? [])
    writeInventoryAllocation(database, merchantId, "release", allocation);
  // A refresh moves the holds of the lines that it keeps.
  for (const allocation of plan.allocations) {
    writeInventoryAllocation(
      database,
      merchantId,
      allocation.revision === 1 ? "open" : "refresh",
      allocation,
    );
  }
  for (const position of plan.positions) {
    updateInventoryPosition(
      database,
      merchantId,
      position.revision - 1,
      position,
    );
  }
  if (plan.discountHolds !== undefined)
    holdDiscounts(
      database,
      merchantId,
      plan.checkout.checkoutId,
      plan.discountHolds.customerId,
      plan.discountHolds.holds,
      plan.discountHolds.expiresAt,
      committedAt,
    );
  if (plan.storedValueHolds !== undefined)
    holdStoredValue(
      database,
      merchantId,
      plan.checkout.checkoutId,
      plan.storedValueHolds,
      committedAt,
    );
}

function recordQuoteFunctionRuns(
  database: CommerceDatabase,
  merchantId: string,
  plan: PickupCheckoutPlan,
  committedAt: string,
): void {
  if (plan.checkout.lifecycle.state === "quoted")
    recordFunctionRuns(
      database,
      merchantId,
      {
        id: plan.checkout.checkoutId,
        attempt: String(plan.checkout.revision),
      },
      plan.checkout.lifecycle.quote.pluginRuns ?? [],
      plan.pluginFailures ?? [],
      committedAt,
    );
}

export function checkoutPaymentStartMutation(
  command:
    BeginCommerceCheckoutPaymentV1 | CollectCommerceInPersonCheckoutPaymentV1,
  merchant: MerchantRow,
  plan: CheckoutPaymentStartPlan,
  committedAt: string,
): CommerceMutation {
  const commandKind =
    command.schemaVersion === "underclerk.collect-in-person-checkout-payment.v1"
      ? "collect_in_person_checkout_payment"
      : "begin_checkout_payment";
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: "checkout_payment_attempt",
      id: plan.paymentAttempt.paymentAttemptId,
      revision: plan.paymentAttempt.revision,
    },
    observations: [],
    write: (database) => {
      writeCheckout(database, command.merchantId, plan.checkout);
      writeCheckoutPaymentAttempt(
        database,
        command.merchantId,
        plan.paymentAttempt,
      );
    },
  };
}

export function checkoutPaymentCaptureMutation(
  command: RecordCommerceCheckoutPaymentCaptureV1,
  merchant: MerchantRow,
  plan: CheckoutPaymentCapturePlan,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "record_checkout_payment_capture",
    resource: {
      kind: "checkout_payment_attempt",
      id: plan.paymentAttempt.paymentAttemptId,
      revision: plan.paymentAttempt.revision,
    },
    observations: [],
    write: (database) => {
      writeCheckoutPaymentAttempt(
        database,
        command.merchantId,
        plan.paymentAttempt,
      );
    },
  };
}

export function paymentDisputeObservationMutation(
  command: ObserveCommercePaymentDisputeV1,
  merchant: MerchantRow,
  dispute: PaymentDispute,
  existing: PaymentDispute | undefined,
  committedAt: string,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    providerDeliveryId: command.providerDeliveryId,
    commandKind: "observe_payment_dispute",
    resource: {
      kind: "payment_dispute",
      id: dispute.disputeId,
      revision: dispute.revision,
    },
    observations: [],
    write: (database) => {
      if (existing === undefined) {
        reservePaymentDispute(database, command.merchantId, dispute);
      } else {
        advancePaymentDispute(
          database,
          command.merchantId,
          existing.revision,
          dispute,
        );
      }
    },
  };
}

export function paidCheckoutPlacementMutation(
  command: PaidPlacementCommand,
  merchant: MerchantRow,
  plan: CheckoutPlacementPlan,
  committedAt: string,
  customers: CustomerAuthority,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind:
      command.schemaVersion === "underclerk.place-stored-value-checkout.v1"
        ? "place_stored_value_checkout"
        : command.schemaVersion === "underclerk.mark-draft-order-paid.v1"
          ? "mark_draft_order_paid"
          : command.schemaVersion === "underclerk.place-draft-order-on-terms.v1"
            ? "place_draft_order_on_terms"
            : "place_paid_checkout",
    resource: {
      kind: "commerce_order",
      id: plan.order.id,
      revision: plan.order.revision,
    },
    observations: [
      orderObservation(plan.order),
      paymentObservation(plan.payment),
      ...plan.storedValuePayments.map(paymentObservation),
      ...(plan.kind === "balance"
        ? []
        : [fulfillmentObservation(plan.fulfillment)]),
      ...(plan.kind === "shipping" ? [shipmentObservation(plan.shipment)] : []),
    ],
    write: (database) => {
      if (
        plan.paymentAttempt !== undefined &&
        plan.paymentAttempt.lifecycle.state !== "captured"
      ) {
        throw new Error(
          "Paid checkout placement lost its captured payment attempt",
        );
      }
      writeCheckout(database, command.merchantId, plan.checkout);
      if (plan.kind === "balance") {
        writeOrderAfterRevision(
          database,
          command.merchantId,
          plan.order,
          plan.previousOrderRevision,
        );
        writePayment(database, command.merchantId, plan.payment);
        insertOrderChange(database, command.merchantId, plan.change);
      } else {
        writeOrder(database, command.merchantId, plan.order);
        writePayment(database, command.merchantId, plan.payment);
        for (const payment of plan.storedValuePayments)
          writePayment(database, command.merchantId, payment);
        if (plan.manualTender !== undefined)
          writeManualTender(database, command.merchantId, plan.manualTender);
        if (plan.invoice !== undefined)
          writeInvoice(database, command.merchantId, plan.invoice, undefined);
        const quote = plan.checkout.lifecycle.quote;
        if (quote.storedValue !== undefined) {
          const refusal = redeemStoredValue(
            database,
            command.merchantId,
            plan.checkout.checkoutId,
            plan.order.id,
            quote.storedValue.tenders,
          );
          if (refusal !== undefined) return refusal;
        }
        writeFulfillment(database, command.merchantId, plan.fulfillment);
        customers.linkPlacedOrder(
          command.merchantId,
          plan.order,
          plan.checkout.checkoutId,
          committedAt,
        );
        redeemDiscounts(
          database,
          command.merchantId,
          plan.checkout.checkoutId,
          plan.order.id,
          customers.customerIdFor(command.merchantId, "order", plan.order.id),
        );
      }
      if (plan.kind === "shipping") {
        writeShipment(database, command.merchantId, plan.shipment);
      }
      for (const allocation of plan.allocations) {
        writeInventoryAllocation(
          database,
          command.merchantId,
          "allocate",
          allocation,
        );
      }
    },
  };
}

export function checkoutReleaseMutation(
  command: ResolveCommerceCheckoutPaymentV1 | ExpireCommerceCheckoutV1,
  merchant: MerchantRow,
  checkout: Checkout,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
  allocations: readonly InventoryAllocation[],
  positions: readonly CommerceInventoryPositionV1[],
  commandKind: "resolve_checkout_payment" | "expire_checkout",
  resourceKind: "checkout_payment_attempt" | "checkout",
  resourceId: string,
  resourceRevision: number,
  committedAt: string,
): CommerceMutation {
  const observations = positions.map(inventoryPositionObservation);
  return {
    command,
    merchant,
    committedAt,
    commandKind,
    resource: {
      kind: resourceKind,
      id: resourceId,
      revision: resourceRevision,
    },
    observations,
    write: (database) => {
      writeCheckout(database, command.merchantId, checkout);
      // An expired checkout gives back the gift cards and credit it held.
      if (checkout.lifecycle.state === "expired")
        releaseStoredValue(database, command.merchantId, checkout.checkoutId);
      if (paymentAttempt !== undefined) {
        writeCheckoutPaymentAttempt(
          database,
          command.merchantId,
          paymentAttempt,
        );
      }
      for (const allocation of allocations) {
        writeInventoryAllocation(
          database,
          command.merchantId,
          "release",
          allocation,
        );
      }
      for (const position of positions) {
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      }
    },
  };
}

export function balanceCheckoutMutation(
  request: OrderBalanceCheckoutRequest,
  committedAt: string,
): CommerceMutation {
  const { command, merchant } = request;
  return {
    command,
    merchant,
    committedAt,
    commandKind: "open_order_balance",
    resource: {
      kind: "checkout",
      id: request.checkout.checkoutId,
      revision: request.checkout.revision,
    },
    observations: [],
    write: (database) => {
      writeCart(database, command.merchantId, request.cart);
      writeCheckout(database, command.merchantId, request.checkout);
    },
  };
}
