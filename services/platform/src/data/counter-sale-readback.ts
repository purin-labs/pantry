import {
  commercePickupCode,
  type CommerceCounterCashTenderV1,
} from "@purin-labs/commerce-client";
import type { Checkout, CheckoutPaymentAttempt } from "@purin-labs/contracts";
import type {
  CounterRegisterPaymentMethod,
  CounterSaleState,
} from "@purin-labs/control-api";

export type CounterSaleReadback = Readonly<{
  schemaVersion: "satyr.counter-sale.v1";
  checkoutId: string;
  satyrLocationId: string;
  revision: number;
  state: CounterSaleState;
  /**
   * Whether the till may present this sale on the terminal. False whenever the
   * payment's outcome is unknown or already settled: an unresolved payment is
   * recovered, never re-collected.
   */
  collectable: boolean;
  /**
   * The attempt an operator recovers. Present exactly when there is something
   * to reconcile, so a surface cannot offer recovery with nothing to recover.
   */
  recoverable: Readonly<{
    paymentAttemptId: string;
    reasonCode: string;
    reconcileAfter: string;
  }> | null;
  /** The quote as rung up, for the receipt and for the amount to present. */
  quote: Readonly<{
    quoteDigest: string;
    checkoutRevision: number;
    lineCount: number;
    amount: Readonly<{ amountMinor: number; currency: string }>;
  }> | null;
  orderId: string | null;
  capturedPaymentReference: string | null;
  pickupCode?: string | null;
  paymentMethod?: CounterRegisterPaymentMethod | null;
  tenderBrand?: string | null;
  providerRefundable?: boolean | null;
  manualTender?: Readonly<{
    cashReceivedMinor: number | null;
    changeDueMinor: number | null;
    currency: string;
  }> | null;
}>;

/**
 * Classify one counter sale.
 *
 * Checkout lifecycle and payment lifecycle are both consulted because neither
 * alone is sufficient: an accepted Checkout proves the Order was placed, and a
 * captured attempt proves money moved, but the dangerous state is exactly the
 * one where the second is true and the first is not.
 */
export function readCounterSale(
  input: Readonly<{
    checkout: Checkout;
    paymentAttempt: CheckoutPaymentAttempt | null;
    manualTender?: CommerceCounterCashTenderV1 | null;
  }>,
): CounterSaleReadback {
  const { checkout, paymentAttempt, manualTender } = input;
  const state = classify(checkout, paymentAttempt);
  const orderId =
    checkout.lifecycle.state === "accepted"
      ? checkout.lifecycle.orderId
      : null;
  const captured =
    paymentAttempt?.lifecycle.state === "captured"
      ? paymentAttempt.lifecycle
      : null;
  const extra: {
    pickupCode?: string | null;
    paymentMethod?: CounterRegisterPaymentMethod | null;
    tenderBrand?: string | null;
    providerRefundable?: boolean | null;
    manualTender?: Readonly<{
      cashReceivedMinor: number | null;
      changeDueMinor: number | null;
      currency: string;
    }> | null;
  } = {};
  if (orderId !== null) {
    extra.pickupCode = commercePickupCode(orderId);
  }
  if (captured?.paymentMethod !== undefined) {
    extra.paymentMethod = captured.paymentMethod;
  }
  if (captured?.tenderBrand !== undefined) {
    extra.tenderBrand = captured.tenderBrand;
  }
  if (captured?.providerRefundable !== undefined) {
    extra.providerRefundable = captured.providerRefundable;
  }
  if (manualTender !== undefined && manualTender !== null) {
    extra.manualTender = {
      cashReceivedMinor: manualTender.cashReceivedMinor,
      changeDueMinor: manualTender.changeDueMinor,
      currency: checkout.lifecycle.quote?.totals.total.currency ?? "JPY",
    };
  }
  return {
    schemaVersion: "satyr.counter-sale.v1",
    checkoutId: checkout.checkoutId,
    satyrLocationId:
      checkout.source.kind === "point_of_sale"
        ? checkout.source.satyrLocationId
        : "",
    revision: checkout.revision,
    state,
    // Only two states permit presenting an amount: one where nothing has been
    // presented, and one where the provider has definitively said no.
    collectable: state === "awaiting_collection" || state === "declined",
    recoverable: recoverableAttempt(paymentAttempt, state),
    quote: quoteOf(checkout),
    orderId,
    capturedPaymentReference: captured?.providerPaymentReference ?? null,
    ...extra,
  };
}

function classify(
  checkout: Checkout,
  paymentAttempt: CheckoutPaymentAttempt | null,
): CounterSaleState {
  if (checkout.lifecycle.state === "accepted") return "complete";
  if (paymentAttempt === null) {
    // An expired quote with nothing collected is over. An expired quote that
    // did collect is handled below, because the money outranks the deadline.
    return checkout.lifecycle.state === "expired"
      ? "expired"
      : "awaiting_collection";
  }
  switch (paymentAttempt.lifecycle.state) {
    case "pending":
      return "collecting";
    case "processing":
      return "collecting";
    case "indeterminate":
      return "submission_unknown";
    case "declined":
      // A declined attempt leaves the sale where it started, unless the quote
      // ran out in the meantime.
      return checkout.lifecycle.state === "expired" ? "expired" : "declined";
    case "captured":
      // Captured without an accepted Checkout is the state that costs a
      // customer money without giving them their order. It is never expired
      // and never collectable, whatever the quote's deadline says.
      return "captured_unplaced";
  }
}

function recoverableAttempt(
  paymentAttempt: CheckoutPaymentAttempt | null,
  state: CounterSaleState,
): CounterSaleReadback["recoverable"] {
  if (paymentAttempt === null) return null;
  if (state !== "submission_unknown" && state !== "collecting") return null;
  const lifecycle = paymentAttempt.lifecycle;
  return lifecycle.state === "indeterminate" || lifecycle.state === "processing"
    ? {
        paymentAttemptId: paymentAttempt.paymentAttemptId,
        reasonCode: lifecycle.reasonCode,
        reconcileAfter: lifecycle.reconcileAfter,
      }
    : null;
}

function quoteOf(checkout: Checkout): CounterSaleReadback["quote"] {
  const quote = checkout.lifecycle.quote;
  return quote === undefined
    ? null
    : {
        quoteDigest: quote.quoteDigest,
        checkoutRevision: quote.checkoutRevision,
        lineCount: quote.lines.length,
        amount: quote.totals.total,
      };
}
