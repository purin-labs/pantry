import type { PaymentStep } from "@purin-labs/control-api";

/** A local month is at most 31 days and one hour. */
const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

/** Whether a window of epoch milliseconds is one that the payments read takes. */
export function isPaymentWindow(from: number, to: number): boolean {
  return (
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    from < to &&
    to - from <= MAX_WINDOW_MS
  );
}

/**
 * How a run of tries ended. A run starts with one payment. A later try follows
 * a decline, so a run that ends paid after a decline is recovered.
 */
type PaymentRunOutcome =
  "paid_first_try" | "recovered_after_decline" | "not_recovered";

export type PaymentsSummary = Readonly<{
  /** Each run counts once, however many tries it holds. */
  runs: number;
  runsByOutcome: Readonly<Record<PaymentRunOutcome, number>>;
  /** What the paid steps took, one total for each currency. */
  paid: readonly Readonly<{ currency: string; amountMinor: number }>[];
}>;

export type PaymentsToolRead = Readonly<{
  /** True when the window held more runs than this read lists. */
  truncated: boolean;
  summary: PaymentsSummary;
  steps: readonly PaymentStep[];
}>;

/** The payments of a window as the Payments page shows them, with the counts. */
export function presentPayments(
  day: Readonly<{ truncated: boolean; steps: readonly PaymentStep[] }>,
): PaymentsToolRead {
  const follows = new Map(
    day.steps.map((step) => [step.paymentAttemptId, step]),
  );
  const rootOf = (step: PaymentStep): string => {
    const parent =
      step.follows === null ? undefined : follows.get(step.follows);
    return parent === undefined ? step.paymentAttemptId : rootOf(parent);
  };
  const outcomes = new Map<string, PaymentRunOutcome>();
  const totals = new Map<string, number>();
  for (const step of day.steps) {
    const root = rootOf(step);
    if (step.state === "paid") {
      outcomes.set(
        root,
        step.follows === null ? "paid_first_try" : "recovered_after_decline",
      );
      totals.set(
        step.amount.currency,
        (totals.get(step.amount.currency) ?? 0) + step.amount.amountMinor,
      );
    } else if (!outcomes.has(root)) outcomes.set(root, "not_recovered");
  }
  const runsByOutcome: Record<PaymentRunOutcome, number> = {
    paid_first_try: 0,
    recovered_after_decline: 0,
    not_recovered: 0,
  };
  for (const outcome of outcomes.values()) runsByOutcome[outcome] += 1;
  return {
    truncated: day.truncated,
    summary: {
      runs: outcomes.size,
      runsByOutcome,
      paid: [...totals].map(([currency, amountMinor]) => ({
        currency,
        amountMinor,
      })),
    },
    steps: day.steps,
  };
}
