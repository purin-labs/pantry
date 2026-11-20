import React from "react";
import type { PaymentStep as Payment } from "@purin-labs/control-api";

import { formatMoneyMinor } from "../../formatting";
import {
  nowIn,
  periodWords,
  TimeLanesNote,
  usePeriod,
  usePeriodRead,
  useWiderWhenEmpty,
  type PeriodWindow,
} from "../../ui";
import { PaymentLanes, type PaymentStep } from "./payment-lanes";
import { readPayments } from "./requests";

/**
 * The Payments page: the shop's card payments of a day, a week or a month, paid
 * and declined, and whether a declined buyer paid on a later try. A day with no
 * payment opens the week, and an empty week opens the month.
 */
export function PaymentsRoute(
  props: Readonly<{ organisationId: string }>,
): React.ReactNode {
  const { organisationId } = props;
  const control = usePeriod();
  const reader = React.useCallback(
    (window: PeriodWindow, signal: AbortSignal) =>
      readPayments(organisationId, window, signal),
    [organisationId],
  );
  const read = usePeriodRead(control.period, reader, {
    loading: "Loading the payments",
    failed: "The payments could not be read.",
  });
  useWiderWhenEmpty(
    control,
    read.window,
    read.value !== null && read.value.steps.length === 0,
  );
  const taken = takenWords(read.value?.steps ?? []);
  return (
    <section aria-label="Payments">
      <PaymentLanes
        control={control}
        now={nowIn(control.period, Date.now())}
        steps={(read.value?.steps ?? []).map(paymentStep)}
        {...(taken === undefined ? {} : { taken })}
        status={read.status}
        notes={
          read.value?.truncated === true ? (
            <TimeLanesNote>
              The view shows the most recent payments{" "}
              {periodWords(control.period)}. There are more.
            </TimeLanesNote>
          ) : null
        }
      />
    </section>
  );
}

/** What the paid steps took, one amount for each currency; undefined when none. */
function takenWords(steps: readonly Payment[]): string | undefined {
  const totals = new Map<string, number>();
  for (const step of steps)
    if (step.state === "paid")
      totals.set(
        step.amount.currency,
        (totals.get(step.amount.currency) ?? 0) + step.amount.amountMinor,
      );
  return totals.size === 0
    ? undefined
    : [...totals]
        .map(([currency, minor]) => formatMoneyMinor(minor, currency))
        .join(" + ");
}

function paymentStep(step: Payment): PaymentStep {
  return {
    stepId: step.paymentAttemptId,
    bought: boughtLabel(step),
    channel: step.channel,
    amount: formatMoneyMinor(step.amount.amountMinor, step.amount.currency),
    at: Date.parse(step.at),
    state: step.state,
    reason: step.reasonCode === null ? null : reasonWords(step.reasonCode),
    orderCode: step.orderCode,
    follows: step.follows,
  };
}

function boughtLabel(step: Payment): string {
  const first = step.lines[0];
  if (first === undefined) return "Payment";
  const title = first.title ?? "Item";
  const more = step.lines.length - 1;
  return more === 0
    ? `${title} × ${String(first.quantity)}`
    : `${title} + ${String(more)} more`;
}

/** The reason codes that the payment providers give, in words. */
function reasonWords(code: string): string {
  switch (code) {
    case "payment_method_required":
      return "the card was refused";
    case "payment_declined":
    case "card_declined":
      return "the bank declined the card";
    case "payment_cancelled":
      return "the payment was cancelled";
    default:
      return "the provider gave no other reason";
  }
}
