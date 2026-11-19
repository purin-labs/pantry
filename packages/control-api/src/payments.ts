import { isRecord } from "@purin-labs/std";

import { isFailedPaymentStep, type FailedPaymentStep } from "./failed-payments.ts";

/**
 * The payments of a window: each card payment that the provider answered, paid
 * or declined. A step has the shape of a failed-payment step, so a decline
 * still shows the later try that followed it. A step shows what the buyer
 * bought and not who they are.
 */

export type PaymentStep = FailedPaymentStep;

export type PaymentsDay = Readonly<{
  /** True when the window held more payments than this list shows. */
  truncated: boolean;
  steps: readonly PaymentStep[];
}>;

export function parsePaymentsDay(value: unknown): PaymentsDay {
  if (
    !isRecord(value) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isFailedPaymentStep)
  )
    throw new Error("The payments response is not valid.");
  return { truncated: value.truncated, steps: value.steps };
}
