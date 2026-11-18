// One refund split over an order's payments (Plan 77 step 2). Named tenders
// take the amounts given, in that order. With none named, card and manual
// payments come first, then gift cards and store credit, each up to what it
// can still refund. The allocation of lines, tax, duty and shipping is cut in
// the same order, so the parts add up to the refund.
import type {
  RefundCommerceOrderTendersV1,
  CommerceMutationErrorV1,
  CommerceOrderV1,
  CommercePaymentV1,
} from "@seams/commerce-client";
import type { RefundAllocation } from "@seams/commerce-contracts";

import { listRefundAttemptsForOrder } from "./payment-records.ts";
import { sha256 } from "../commerce-authority/checkout-shared.ts";
import type { CommerceDatabase } from "../database.ts";
import {
  orderPayments,
  refundAttemptMoney,
  safeMoneySum,
  tenderPosition,
  type TenderPosition,
} from "./position.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type TenderRefundPart = Readonly<{
  paymentId: string;
  refundAttemptId: string;
  amount: Money;
  allocation: RefundAllocation;
}>;

export type TenderRefundPlan =
  | Readonly<{ kind: "planned"; parts: readonly TenderRefundPart[] }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

const TENDER_ORDER: Readonly<Record<TenderPosition["kind"], number>> = {
  card: 0,
  manual: 1,
  stored_value: 2,
};

/** The refund attempt of the part that refunds `paymentId`. */
export function tenderRefundAttemptId(
  refundId: string,
  paymentId: string,
): string {
  return `${refundId}_${sha256(paymentId).slice(0, 16)}`;
}

export function planTenderRefund(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
  payments: readonly CommercePaymentV1[],
  command: RefundCommerceOrderTendersV1,
): TenderRefundPlan {
  const { currency } = command.amount;
  // What each payment could refund before this command's own parts, so that
  // the same command plans the same parts again after some of them ran.
  const own = new Map<string, number>();
  for (const { attempt } of listRefundAttemptsForOrder(
    database,
    merchantId,
    order.id,
  ))
    if (
      attempt.refundAttemptId ===
        tenderRefundAttemptId(command.refundId, attempt.paymentId) &&
      attempt.lifecycle.state !== "failed"
    )
      own.set(attempt.paymentId, refundAttemptMoney(attempt).amountMinor);
  const positions = new Map<string, TenderPosition>();
  for (const payment of orderPayments(order, payments)) {
    if (
      payment.lifecycle.state !== "captured" &&
      payment.lifecycle.state !== "partially_refunded" &&
      payment.lifecycle.state !== "refunded"
    )
      continue;
    const position = tenderPosition(database, merchantId, order.id, payment);
    if (position === undefined || position.refundable.currency !== currency)
      continue;
    positions.set(payment.id, {
      ...position,
      refundable: {
        amountMinor: safeMoneySum(
          position.refundable.amountMinor,
          own.get(payment.id) ?? 0,
        ),
        currency,
      },
    });
  }
  const amounts: { paymentId: string; amountMinor: number }[] = [];
  if (command.tenders !== undefined) {
    for (const tender of command.tenders) {
      const position = positions.get(tender.paymentId);
      if (
        position === undefined ||
        tender.amount.amountMinor > position.refundable.amountMinor
      )
        return rejected("refund.tenders");
      amounts.push({
        paymentId: tender.paymentId,
        amountMinor: tender.amount.amountMinor,
      });
    }
  } else {
    let remaining = command.amount.amountMinor;
    const ordered = [...positions.values()].sort(
      (left, right) =>
        TENDER_ORDER[left.kind] - TENDER_ORDER[right.kind] ||
        left.paymentId.localeCompare(right.paymentId),
    );
    for (const position of ordered) {
      const take = Math.min(remaining, position.refundable.amountMinor);
      if (take === 0) continue;
      amounts.push({ paymentId: position.paymentId, amountMinor: take });
      remaining -= take;
    }
    if (remaining > 0) return rejected("refund.amount");
  }
  const allocations = splitAllocation(
    command.allocation,
    amounts.map((part) => part.amountMinor),
  );
  return {
    kind: "planned",
    parts: amounts.map((part, index) => {
      const allocation = allocations[index];
      if (allocation === undefined)
        throw new Error("A refund part has no allocation");
      return {
        paymentId: part.paymentId,
        refundAttemptId: tenderRefundAttemptId(
          command.refundId,
          part.paymentId,
        ),
        amount: { amountMinor: part.amountMinor, currency },
        allocation,
      };
    }),
  };
}

// Cuts the allocation into consecutive pieces of the given amounts: lines,
// then tax, duty and shipping, each entry used up before the next.
function splitAllocation(
  allocation: RefundAllocation,
  amounts: readonly number[],
): readonly RefundAllocation[] {
  type Entry = {
    kind: "line" | "tax" | "duty" | "shipping";
    orderLineId: string;
    left: number;
  };
  const currency = allocation.shippingAllocation.currency;
  const entries: Entry[] = [
    ...allocation.lineAllocations.map((item) => ({
      kind: "line" as const,
      orderLineId: item.orderLineId,
      left: item.amount.amountMinor,
    })),
    ...allocation.taxAllocations.map((item) => ({
      kind: "tax" as const,
      orderLineId: item.orderLineId,
      left: item.amount.amountMinor,
    })),
    ...allocation.dutyAllocations.map((item) => ({
      kind: "duty" as const,
      orderLineId: item.orderLineId,
      left: item.amount.amountMinor,
    })),
    {
      kind: "shipping",
      orderLineId: "",
      left: allocation.shippingAllocation.amountMinor,
    },
  ];
  let cursor = 0;
  return amounts.map((amount) => {
    const piece: RefundAllocation = {
      lineAllocations: [],
      taxAllocations: [],
      dutyAllocations: [],
      shippingAllocation: { amountMinor: 0, currency },
    };
    let need = amount;
    while (need > 0) {
      const entry = entries[cursor];
      if (entry === undefined)
        throw new Error("The refund allocation is smaller than its amount");
      const take = Math.min(need, entry.left);
      if (take > 0) {
        const money = { amountMinor: take, currency };
        if (entry.kind === "shipping") piece.shippingAllocation = money;
        else
          (entry.kind === "line"
            ? piece.lineAllocations
            : entry.kind === "tax"
              ? piece.taxAllocations
              : piece.dutyAllocations
          ).push({ orderLineId: entry.orderLineId, amount: money });
      }
      entry.left -= take;
      need -= take;
      if (entry.left === 0) cursor += 1;
    }
    return piece;
  });
}

function rejected(field: string): TenderRefundPlan {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}
