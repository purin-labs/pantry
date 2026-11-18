import {
  type CommerceBuyerPaymentDisputeStatusV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  checkoutOnlineSource,
} from "@seams/commerce-client";
import type {
  Checkout,
  CheckoutPaymentAttempt,
  PaymentDispute,
} from "@seams/commerce-contracts";
import { buyerSessionDigest } from "../../buyer-session.ts";
import { sha256 } from "../checkout-shared.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import { placedPaymentMatches } from "./placements.ts";

export function buyerPaymentDisputeStatuses(
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  disputes: readonly PaymentDispute[],
): readonly CommerceBuyerPaymentDisputeStatusV1[] | undefined {
  const disputeIds = new Set<string>();
  const statuses: CommerceBuyerPaymentDisputeStatusV1[] = [];
  for (const dispute of disputes) {
    if (
      dispute.orderId !== order.id ||
      dispute.paymentId !== payment.id ||
      disputeIds.has(dispute.disputeId) ||
      dispute.amount.amountMinor <= 0 ||
      dispute.amount.currency !== payment.amount.currency ||
      dispute.amount.currency !== order.totals.total.currency ||
      dispute.amount.amountMinor > payment.amount.amountMinor
    ) {
      return undefined;
    }
    disputeIds.add(dispute.disputeId);
    statuses.push(buyerPaymentDisputeStatus(dispute));
  }
  return statuses;
}

export function buyerPaymentDisputeStatus(
  dispute: PaymentDispute,
): CommerceBuyerPaymentDisputeStatusV1 {
  switch (dispute.lifecycle.state) {
    case "action_required":
    case "under_review":
      return {
        disputeId: dispute.disputeId,
        amount: dispute.amount,
        state: dispute.lifecycle.state,
        observedAt: dispute.lifecycle.observedAt,
      };
    case "won":
    case "lost":
      return {
        disputeId: dispute.disputeId,
        amount: dispute.amount,
        state: dispute.lifecycle.state,
        resolvedAt: dispute.lifecycle.resolvedAt,
      };
    default:
      return assertNever(dispute.lifecycle, "Unsupported buyer checkout state");
  }
}

export function buyerPaymentMatchesAcceptedTender(
  payment: CommercePaymentV1,
  paymentAttempt: CheckoutPaymentAttempt | undefined,
  order: CommerceOrderV1,
  checkout: Checkout,
): boolean {
  if (
    checkout.lifecycle.state !== "accepted" ||
    order.origin.kind !== "online" ||
    order.origin.configuration.kind !== "checkout_profile" ||
    (paymentAttempt !== undefined &&
      (paymentAttempt.lifecycle.state !== "captured" ||
        paymentAttempt.paymentAttemptId !==
          checkout.lifecycle.paymentAttemptId))
  )
    return false;
  return placedPaymentMatches(payment, paymentAttempt, checkout);
}

export function buyerCheckoutCanStartPayment(
  checkout: Checkout | undefined,
  sessionId: string,
  storefrontId: string,
  command: Readonly<{ checkoutRevision: number; quoteDigest: string }>,
): checkout is Checkout &
  Readonly<{
    lifecycle: VariantBy<
      Checkout["lifecycle"],
      "state",
      "quoted" | "payment_pending"
    >;
  }> {
  if (
    checkout === undefined ||
    checkoutOnlineSource(checkout)?.storefrontId !== storefrontId ||
    checkoutOnlineSource(checkout)?.buyerSessionDigest !==
      buyerSessionDigest(sessionId)
  ) {
    return false;
  }
  switch (checkout.lifecycle.state) {
    case "quoted":
      return (
        checkout.revision === command.checkoutRevision &&
        checkout.lifecycle.quote.quoteDigest === command.quoteDigest
      );
    case "payment_pending":
      return (
        checkout.lifecycle.quote.checkoutRevision ===
          command.checkoutRevision &&
        checkout.lifecycle.quote.quoteDigest === command.quoteDigest
      );
    case "accepted":
    case "expired":
      return false;
  }
}

export function buyerCheckoutCanReconcilePayment(
  checkout: Checkout | undefined,
  sessionId: string,
  storefrontId: string,
  command: Readonly<{ checkoutRevision: number; quoteDigest: string }>,
  paymentAttemptId: string,
): checkout is Checkout &
  Readonly<{
    lifecycle: VariantBy<Checkout["lifecycle"], "state", "payment_pending">;
  }> {
  return (
    checkout !== undefined &&
    checkoutOnlineSource(checkout)?.storefrontId === storefrontId &&
    checkoutOnlineSource(checkout)?.buyerSessionDigest ===
      buyerSessionDigest(sessionId) &&
    checkout.lifecycle.state === "payment_pending" &&
    checkout.lifecycle.paymentAttemptId === paymentAttemptId &&
    checkout.lifecycle.quote.checkoutRevision === command.checkoutRevision &&
    checkout.lifecycle.quote.quoteDigest === command.quoteDigest
  );
}

export function buyerPaymentIdentityDigest(
  input: Readonly<{
    claims: Readonly<{
      merchantId: string;
      storefrontId: string;
      sessionId: string;
    }>;
    checkoutId: string;
    command: Readonly<{ idempotencyKey: string }>;
  }>,
): string {
  return sha256(
    JSON.stringify([
      input.claims.merchantId,
      input.claims.storefrontId,
      input.claims.sessionId,
      input.checkoutId,
      input.command.idempotencyKey,
    ]),
  );
}

export function buyerPaymentAttemptResult(
  checkout: Checkout | undefined,
  attempt: CheckoutPaymentAttempt | undefined,
  paymentAttemptId: string,
  sessionId: string,
  storefrontId: string,
): Exclude<CommerceBuyerPaymentResultV1, { state: "placed" }> | undefined {
  if (
    checkout === undefined ||
    checkoutOnlineSource(checkout)?.storefrontId !== storefrontId ||
    checkoutOnlineSource(checkout)?.buyerSessionDigest !==
      buyerSessionDigest(sessionId) ||
    (checkout.lifecycle.state !== "payment_pending" &&
      checkout.lifecycle.state !== "expired") ||
    (checkout.lifecycle.state === "payment_pending" &&
      checkout.lifecycle.paymentAttemptId !== paymentAttemptId) ||
    attempt?.binding.checkoutId !== checkout.checkoutId ||
    attempt.binding.quoteDigest !== checkout.lifecycle.quote.quoteDigest
  ) {
    return undefined;
  }
  switch (attempt.lifecycle.state) {
    case "declined":
      return {
        schemaVersion: "underclerk.buyer-payment-result.v1",
        state: "declined",
        checkoutId: checkout.checkoutId,
        reasonCode: attempt.lifecycle.reasonCode,
      };
    case "processing":
    case "indeterminate":
      return {
        schemaVersion: "underclerk.buyer-payment-result.v1",
        state: attempt.lifecycle.state,
        checkoutId: checkout.checkoutId,
        reconcileAfter: attempt.lifecycle.reconcileAfter,
      };
    case "pending":
    case "captured":
      return undefined;
  }
}
