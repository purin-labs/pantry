import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";

/**
 * The failed payments of a day, with the retries that followed them. A decline
 * places no order, so each step shows what the buyer tried to buy and not who
 * they are.
 */

export type FailedPaymentStep = Readonly<{
  paymentAttemptId: string;
  /** The declined attempt that this one tried again; null for the first. */
  follows: string | null;
  channel: "online" | "counter";
  amount: Readonly<{ amountMinor: number; currency: string }>;
  at: string;
  state: "declined" | "paid";
  reasonCode: string | null;
  /** The pickup code of the order that a paid attempt placed. */
  orderCode: string | null;
  lines: readonly Readonly<{ title: string | null; quantity: number }>[];
}>;

export type FailedPaymentsDay = Readonly<{
  /** True when the day held more failed payments than this list shows. */
  truncated: boolean;
  steps: readonly FailedPaymentStep[];
}>;

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isFailedPaymentStep(
  value: unknown,
): value is FailedPaymentStep {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "paymentAttemptId",
      "follows",
      "channel",
      "amount",
      "at",
      "state",
      "reasonCode",
      "orderCode",
      "lines",
    ]) &&
    typeof value.paymentAttemptId === "string" &&
    isTextOrNull(value.follows) &&
    (value.channel === "online" || value.channel === "counter") &&
    isRecord(value.amount) &&
    isNonNegativeInteger(value.amount.amountMinor) &&
    typeof value.amount.currency === "string" &&
    typeof value.at === "string" &&
    (value.state === "declined" || value.state === "paid") &&
    isTextOrNull(value.reasonCode) &&
    isTextOrNull(value.orderCode) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line: unknown) =>
        isRecord(line) &&
        isTextOrNull(line.title) &&
        isNonNegativeInteger(line.quantity),
    )
  );
}

export function parseFailedPaymentsDay(value: unknown): FailedPaymentsDay {
  if (
    !isRecord(value) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isFailedPaymentStep)
  )
    throw new Error("The failed payments response is not valid.");
  return { truncated: value.truncated, steps: value.steps };
}
