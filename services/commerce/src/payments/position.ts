// What an order's payments paid and what they can still refund (Plan 77 step
// 2). Every caller that needs these amounts asks this module; nothing else
// adds payments, refunds or refund reservations.
import type {
  CommerceOrderBalanceV1,
  CommerceOrderV1,
  CommercePaymentV1,
} from "@purin-labs/commerce-client";
import type { RefundAttempt } from "@purin-labs/commerce-contracts";

import { listRefundAttemptsForOrder } from "./payment-records.ts";
import type { CommerceDatabase } from "../database.ts";
import { storedValueRedemption } from "../plugins/stored-value/index.ts";
import {
  listManualCashRefundsForOrder,
  readManualTender,
} from "./manual-tender.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

/**
 * One tender of an order: a card payment taken through a payment provider, a
 * gift card or store credit account that paid part of the order, or cash or
 * a bank transfer that staff took.
 */
export type TenderPosition = Readonly<{
  paymentId: string;
  kind: "card" | "stored_value" | "manual";
  amount: Money;
  /** Refunds that went back: the larger of the payment's own record and its succeeded refund attempts. */
  settled: Money;
  /** Refund attempts that wait for the provider. */
  reserved: Money;
  /** What a new refund can still take. */
  refundable: Money;
  /** Cash handed back at the counter for non-provider-refundable captures (e.g. FeliCa). */
  manualCashRefunded: Money;
}>;

/**
 * The position of one payment, or undefined when its refunds are in another
 * currency or already take more than it paid.
 */
export function tenderPosition(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
  payment: CommercePaymentV1,
): TenderPosition | undefined {
  const currency = payment.amount.currency;
  let settled =
    payment.lifecycle.state === "partially_refunded" ||
    payment.lifecycle.state === "refunded"
      ? payment.lifecycle.refundedAmount.amountMinor
      : 0;
  let succeeded = 0;
  let reserved = 0;
  for (const { attempt } of listRefundAttemptsForOrder(
    database,
    merchantId,
    orderId,
  )) {
    if (attempt.paymentId !== payment.id) continue;
    const money = refundAttemptMoney(attempt);
    if (attempt.orderId !== orderId || money.currency !== currency)
      return undefined;
    switch (attempt.lifecycle.state) {
      case "requested":
      case "processing":
      case "indeterminate":
        reserved = safeMoneySum(reserved, money.amountMinor);
        break;
      case "succeeded":
        succeeded = safeMoneySum(succeeded, money.amountMinor);
        break;
      case "failed":
        break;
    }
  }
  const manualCashRefunded = listManualCashRefundsForOrder(
    database,
    merchantId,
    orderId,
  )
    .filter((entry) => entry.paymentId === payment.id)
    .reduce((sum, entry) => safeMoneySum(sum, entry.amountMinor), 0);
  settled = Math.max(settled, succeeded, manualCashRefunded);
  const refundable =
    payment.amount.amountMinor - safeMoneySum(settled, reserved);
  if (refundable < 0) return undefined;
  return {
    paymentId: payment.id,
    kind:
      storedValueRedemption(database, merchantId, payment.id) !== undefined
        ? "stored_value"
        : readManualTender(database, merchantId, payment.id) !== undefined
          ? "manual"
          : "card",
    amount: payment.amount,
    settled: { amountMinor: settled, currency },
    reserved: { amountMinor: reserved, currency },
    refundable: { amountMinor: refundable, currency },
    manualCashRefunded: { amountMinor: manualCashRefunded, currency },
  };
}

/** Whether a refund of `requested` fits what the payment can still refund. */
export function refundFits(
  position: TenderPosition | undefined,
  requested: Money,
): boolean {
  return (
    position !== undefined &&
    requested.currency === position.refundable.currency &&
    requested.amountMinor <= position.refundable.amountMinor
  );
}

export function orderPayments(
  order: CommerceOrderV1,
  payments: readonly CommercePaymentV1[],
): readonly CommercePaymentV1[] {
  return payments.filter((payment) => payment.orderId === order.id);
}

/**
 * The order's balance: its total against what its payments captured and
 * what went back. `outstanding` is owed by the buyer; `refundDue` is owed to
 * the buyer.
 */
export function orderBalance(
  order: CommerceOrderV1,
  payments: readonly CommercePaymentV1[],
): CommerceOrderBalanceV1 {
  const currency = order.totals.total.currency;
  let captured = 0;
  let refunded = 0;
  for (const payment of orderPayments(order, payments)) {
    switch (payment.lifecycle.state) {
      case "captured":
        captured += payment.amount.amountMinor;
        break;
      case "partially_refunded":
      case "refunded":
        captured += payment.amount.amountMinor;
        refunded += payment.lifecycle.refundedAmount.amountMinor;
        break;
      case "pending":
      case "authorized":
      case "failed":
        break;
    }
  }
  const total = order.totals.total.amountMinor;
  return {
    total: order.totals.total,
    captured: { amountMinor: captured, currency },
    refunded: { amountMinor: refunded, currency },
    outstanding: { amountMinor: Math.max(0, total - captured), currency },
    refundDue: {
      amountMinor: Math.max(0, captured - refunded - total),
      currency,
    },
  };
}

/** The money of a refund attempt: its allocations added up. */
export function refundAttemptMoney(attempt: RefundAttempt): Money {
  const currency = attempt.allocation.shippingAllocation.currency;
  let amountMinor = attempt.allocation.shippingAllocation.amountMinor;
  for (const allocation of [
    ...attempt.allocation.lineAllocations,
    ...attempt.allocation.taxAllocations,
    ...attempt.allocation.dutyAllocations,
  ]) {
    if (allocation.amount.currency !== currency)
      throw new Error("Refund allocation currencies must match");
    amountMinor = safeMoneySum(amountMinor, allocation.amount.amountMinor);
  }
  return { amountMinor, currency };
}

export function safeMoneySum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum))
    throw new Error("A money total exceeds safe integers");
  return sum;
}
