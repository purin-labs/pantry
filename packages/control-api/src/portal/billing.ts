import { isRecord } from "@purin-labs/std";

/**
 * Settings › Billing (Plan 95 step 6): the plan, the payment state in
 * Pantry's own Stripe account, and the free and paid Jev use of the month.
 * Only the owner and an admin read it. Pantry keeps no card data, so the view
 * has none.
 */
export type BillingPaymentState = "none" | "active" | "past_due" | "canceled";

export type BillingView = Readonly<{
  plan: Readonly<{
    id: string;
    name: string;
    /** The free Jev use of each UTC month, as TypeSafe cost. */
    freeJevUseMicrousd: number;
    /** The highest monthly spending limit, in US cents. */
    highestSpendingLimitMinor: number;
  }>;
  /** Whether this deployment bills through Stripe. When false, payment setup is closed. */
  open: boolean;
  paymentState: BillingPaymentState;
  /** Null when the Organisation's own TypeSafe key pays for Jev. */
  freeUse: Readonly<{
    usedMicrousd: number;
    limitMicrousd: number;
    /** The first millisecond of the next UTC month. */
    resetsAt: number;
  }> | null;
  paidUse: Readonly<{
    enabled: boolean;
    /** The charge of the month so far, in US cents. */
    spentMinor: number;
    spendingLimitMinor: number;
    /** Paid use is on and at its limit: Jev stops until the next month. */
    limitReached: boolean;
  }>;
}>;

const UNAVAILABLE = "Billing is unavailable.";

export function parseBillingView(raw: unknown): BillingView {
  if (
    !isRecord(raw) ||
    !isRecord(raw.plan) ||
    typeof raw.plan.id !== "string" ||
    typeof raw.plan.name !== "string" ||
    !amount(raw.plan.freeJevUseMicrousd) ||
    !amount(raw.plan.highestSpendingLimitMinor) ||
    typeof raw.open !== "boolean" ||
    !isBillingPaymentState(raw.paymentState) ||
    !isRecord(raw.paidUse) ||
    typeof raw.paidUse.enabled !== "boolean" ||
    !amount(raw.paidUse.spentMinor) ||
    !amount(raw.paidUse.spendingLimitMinor) ||
    typeof raw.paidUse.limitReached !== "boolean"
  )
    throw new Error(UNAVAILABLE);
  const { freeUse } = raw;
  if (
    freeUse !== null &&
    (!isRecord(freeUse) ||
      !amount(freeUse.usedMicrousd) ||
      !amount(freeUse.limitMicrousd) ||
      !amount(freeUse.resetsAt))
  )
    throw new Error(UNAVAILABLE);
  return {
    plan: {
      id: raw.plan.id,
      name: raw.plan.name,
      freeJevUseMicrousd: raw.plan.freeJevUseMicrousd,
      highestSpendingLimitMinor: raw.plan.highestSpendingLimitMinor,
    },
    open: raw.open,
    paymentState: raw.paymentState,
    freeUse:
      freeUse === null
        ? null
        : {
            usedMicrousd: freeUse.usedMicrousd as number,
            limitMicrousd: freeUse.limitMicrousd as number,
            resetsAt: freeUse.resetsAt as number,
          },
    paidUse: {
      enabled: raw.paidUse.enabled,
      spentMinor: raw.paidUse.spentMinor,
      spendingLimitMinor: raw.paidUse.spendingLimitMinor,
      limitReached: raw.paidUse.limitReached,
    },
  };
}

export function isBillingPaymentState(
  value: unknown,
): value is BillingPaymentState {
  return (
    value === "none" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled"
  );
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
