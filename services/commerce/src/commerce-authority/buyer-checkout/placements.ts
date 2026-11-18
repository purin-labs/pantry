import type {
  CommerceBuyerContactAuthorityV1,
  CommerceBuyerRefundStatusV1,
  CommerceBuyerV1,
  CommerceFulfillmentV1,
  CommercePickupFulfillmentV1,
  CommerceMutationErrorV1,
  CommerceOrderV1,
  CommercePaymentV1,
} from "@seams/commerce-client";
import type {
  Checkout,
  CheckoutPaymentAttempt,
  CheckoutProfileReference,
} from "@seams/commerce-contracts";
import { refundAttemptMoney } from "../../payments/position.ts";
import type { StoredRefundAttempt } from "../../payments/payment-records.ts";
import {
  amountDue,
  checkoutOrderProfileMatches,
  sameMoney,
} from "../checkout-shared.ts";
import { refundAdjustmentId } from "../after-sale-cancellation.ts";
import { storedValuePaymentId } from "../../plugins/stored-value/index.ts";
import { assertNever } from "@seams/std";
import type { BuyerCheckoutProfileClaims } from "./types.ts";

export function onlyBuyerOrder(
  orders: readonly CommerceOrderV1[],
  storefrontId: string,
  checkoutId: string,
  orderId: string,
  checkoutProfile: CheckoutProfileReference,
): CommerceOrderV1 | undefined {
  let match: CommerceOrderV1 | undefined;
  for (const order of orders) {
    if (
      order.id !== orderId ||
      !checkoutOrderProfileMatches(order.origin, checkoutProfile) ||
      order.origin.storefrontId !== storefrontId ||
      order.origin.checkoutId !== checkoutId
    ) {
      continue;
    }
    if (match !== undefined) return undefined;
    match = order;
  }
  return match;
}

export function orderBuyer(
  claims: Pick<BuyerCheckoutProfileClaims, "buyer">,
): CommerceBuyerV1 {
  switch (claims.buyer.kind) {
    case "guest":
      return { kind: "guest" };
    case "identified_customer":
      return {
        kind: "identified",
        customerReference: claims.buyer.protectedCustomerReference,
      };
    default:
      return assertNever(claims.buyer, "Unsupported buyer checkout state");
  }
}

export function buyerIdentityRejected(): Readonly<{
  kind: "rejected";
  error: CommerceMutationErrorV1;
}> {
  return {
    kind: "rejected",
    error: {
      code: "resource_relationship_invalid",
      field: "buyerCheckout.buyer",
    },
  };
}

export function retainedBuyerContactAuthority(
  checkout: Checkout,
): CommerceBuyerContactAuthorityV1 {
  return {
    kind: "retained_checkout",
    checkoutId: checkout.checkoutId,
    checkoutRevision: checkout.revision,
    quoteDigest: checkout.lifecycle.quote.quoteDigest,
  };
}

/**
 * The payments of a placed online order: the one its checkout names (the
 * card payment, or with nothing due the first stored-value payment) and the
 * order's other stored-value payments. Undefined when the order has any
 * other payment, such as the balance of an edit.
 */
export function placedOrderPayments(
  payments: readonly CommercePaymentV1[],
  orderId: string,
  checkout: Checkout,
):
  | Readonly<{
      primary: CommercePaymentV1;
      storedValue: readonly CommercePaymentV1[];
    }>
  | undefined {
  if (checkout.lifecycle.state !== "accepted") return undefined;
  const storedValueIds = (
    checkout.lifecycle.quote.storedValue?.tenders ?? []
  ).map((tender) => storedValuePaymentId(orderId, tender.accountId));
  const orderPayments = payments.filter(
    (payment) => payment.orderId === orderId,
  );
  const storedValue = orderPayments.filter((payment) =>
    storedValueIds.includes(payment.id),
  );
  const others = orderPayments.filter(
    (payment) => !storedValueIds.includes(payment.id),
  );
  if (storedValue.length !== storedValueIds.length) return undefined;
  if (checkout.lifecycle.paymentAttemptId !== undefined) {
    const primary = others.length === 1 ? others[0] : undefined;
    return primary === undefined ? undefined : { primary, storedValue };
  }
  const primary = storedValue.find(
    (payment) => payment.id === storedValueIds[0],
  );
  return primary === undefined || others.length > 0
    ? undefined
    : {
        primary,
        storedValue: storedValue.filter((payment) => payment !== primary),
      };
}

// The payment that placed an accepted checkout: its captured card payment
// for the amount due, or with nothing due, its first stored-value payment.
export function placedPaymentMatches(
  payment: CommercePaymentV1,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
  checkout: Checkout,
): boolean {
  if (checkout.lifecycle.state !== "accepted") return false;
  const quote = checkout.lifecycle.quote;
  if (checkout.lifecycle.paymentAttemptId === undefined) {
    const first = quote.storedValue?.tenders[0];
    return (
      quote.storedValue?.due.amountMinor === 0 &&
      first !== undefined &&
      payment.id ===
        storedValuePaymentId(checkout.lifecycle.orderId, first.accountId) &&
      sameMoney(payment.amount, first.amount)
    );
  }
  return (
    paymentAttempt !== undefined &&
    paymentAttempt.binding.checkoutId === checkout.checkoutId &&
    paymentAttempt.binding.checkoutRevision === quote.checkoutRevision &&
    paymentAttempt.binding.quoteDigest === quote.quoteDigest &&
    sameMoney(paymentAttempt.binding.amount, amountDue(quote)) &&
    sameMoney(payment.amount, paymentAttempt.binding.amount)
  );
}

export function buyerCancellationRefundStatus(
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  /** The order's other stored-value payments; cancellation refunds each. */
  storedValuePayments: readonly CommercePaymentV1[],
  storedAttempts: readonly StoredRefundAttempt[],
): CommerceBuyerRefundStatusV1 | undefined {
  if (
    order.lifecycle.state !== "cancelled" ||
    order.origin.kind !== "online" ||
    order.origin.configuration.kind !== "checkout_profile"
  )
    return undefined;
  // The buyer's refund status is that of the payment the checkout named;
  // the refunds of other stored-value payments return to their accounts.
  const primaryAttempts = storedAttempts.filter(
    (stored) => stored.attempt.paymentId === payment.id,
  );
  const otherAttempts = storedAttempts.filter(
    (stored) => stored.attempt.paymentId !== payment.id,
  );
  const storedAttempt = primaryAttempts[0];
  if (
    storedAttempt === undefined ||
    primaryAttempts.length !== 1 ||
    !refundAttemptIsCancellation(storedAttempt) ||
    otherAttempts.some(
      (stored) =>
        !storedValuePayments.some(
          (other) => other.id === stored.attempt.paymentId,
        ),
    ) ||
    order.adjustments.length !== 2 + otherAttempts.length
  ) {
    return undefined;
  }
  const attempt = storedAttempt.attempt;
  const refundedTotal = storedAttempts.reduce(
    (sum, stored) => sum + refundAttemptMoney(stored.attempt).amountMinor,
    0,
  );
  if (
    attempt === undefined ||
    attempt.orderId !== order.id ||
    attempt.paymentId !== payment.id ||
    attempt.idempotencyIdentity !== attempt.refundAttemptId ||
    refundedTotal > order.totals.total.amountMinor ||
    (otherAttempts.length === storedValuePayments.length &&
      refundedTotal !== order.totals.total.amountMinor) ||
    !sameMoney(refundAttemptMoney(attempt), payment.amount)
  )
    return undefined;
  const primaryRefundId = refundAdjustmentId(attempt.refundAttemptId);
  let cancellation: CommerceOrderV1["adjustments"][number] | undefined;
  let refund: CommerceOrderV1["adjustments"][number] | undefined;
  for (const adjustment of order.adjustments) {
    switch (adjustment.kind) {
      case "cancellation":
        if (cancellation !== undefined) return undefined;
        cancellation = adjustment;
        break;
      case "refund":
        if (adjustment.id !== primaryRefundId) break;
        if (refund !== undefined) return undefined;
        refund = adjustment;
        break;
      case "credit":
      case "price_adjustment":
      case "dispute":
        return undefined;
    }
  }
  if (
    cancellation?.status !== "completed" ||
    cancellation.occurredAt !== order.lifecycle.cancelledAt ||
    cancellation.amount.amountMinor !== 0 ||
    cancellation.amount.currency !== order.totals.total.currency ||
    refund === undefined ||
    !sameMoney(refund.amount, refundAttemptMoney(attempt))
  ) {
    return undefined;
  }
  switch (refund.status) {
    case "pending":
      return (attempt.lifecycle.state === "requested" ||
        attempt.lifecycle.state === "processing" ||
        attempt.lifecycle.state === "indeterminate") &&
        payment.lifecycle.state === "captured"
        ? { state: "pending", amount: refund.amount }
        : undefined;
    case "failed":
      return attempt.lifecycle.state === "failed" &&
        payment.lifecycle.state === "captured"
        ? { state: "failed", amount: refund.amount }
        : undefined;
    case "completed":
      return attempt.lifecycle.state === "succeeded" &&
        payment.lifecycle.state === "refunded" &&
        sameMoney(payment.lifecycle.refundedAmount, refund.amount) &&
        payment.lifecycle.refundedAt === attempt.lifecycle.refundedAt
        ? {
            state: "refunded",
            amount: refund.amount,
            refundedAt: attempt.lifecycle.refundedAt,
          }
        : undefined;
  }
}

function refundAttemptIsCancellation(stored: StoredRefundAttempt): boolean {
  return stored.attempt.reason.kind === "cancellation";
}

export function onlyFulfillmentForOrder(
  fulfillments: readonly CommerceFulfillmentV1[],
  orderId: string,
): CommerceFulfillmentV1 | undefined {
  let match: CommerceFulfillmentV1 | undefined;
  for (const fulfillment of fulfillments) {
    if (fulfillment.orderId !== orderId) continue;
    if (match !== undefined) return undefined;
    match = fulfillment;
  }
  return match;
}

export function buyerPlacementFulfillmentState(
  state: CommercePickupFulfillmentV1["lifecycle"]["state"],
  orderState: CommerceOrderV1["lifecycle"]["state"],
): boolean {
  switch (state) {
    case "requested":
    case "preparing":
    case "blocked":
    case "ready_for_pickup":
      return orderState === "fulfillment_pending";
    case "completed":
      return orderState === "fulfilled";
    case "cancelled":
      return false;
  }
}
