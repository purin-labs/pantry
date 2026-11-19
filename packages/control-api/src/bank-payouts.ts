import { isRecord } from "@purin-labs/std";

/**
 * The money that Stripe and Square send to the shop's bank: how much, the day
 * that it arrives and the sales that it pays out. It names no bank account.
 */
export type BankPayout = Readonly<{
  provider: "stripe" | "square";
  payoutId: string;
  /** The amount is negative when the provider takes money back. */
  amount: Readonly<{ amountMinor: number; currency: string }>;
  status: "on_its_way" | "arrived" | "failed" | "cancelled";
  /** A calendar day: `YYYY-MM-DD`. */
  arrivalDate: string;
  sentAt: string;
  sales: Readonly<{ from: string; to: string }> | null;
}>;

/** How this read went for one connected provider. */
export type BankPayoutSource = Readonly<{
  provider: "stripe" | "square";
  /**
   * `needs_permission`: the provider refused the key or the token. Square
   * also names its cause: a missing scope, a token that Square refused to
   * refresh, or the application removed in Square.
   */
  state:
    | "read"
    | "needs_permission"
    | "scope_missing"
    | "refresh_failed"
    | "revoked"
    | "unavailable";
}>;

export type BankPayoutsWindow = Readonly<{
  /** The providers that the shop connected. */
  sources: readonly BankPayoutSource[];
  /** True when the window held more payouts than this read returns. */
  truncated: boolean;
  payouts: readonly BankPayout[];
}>;

function isProvider(value: unknown): value is BankPayout["provider"] {
  return value === "stripe" || value === "square";
}

function isBankPayoutSource(value: unknown): value is BankPayoutSource {
  return (
    isRecord(value) &&
    isProvider(value.provider) &&
    (value.state === "read" ||
      value.state === "needs_permission" ||
      value.state === "scope_missing" ||
      value.state === "refresh_failed" ||
      value.state === "revoked" ||
      value.state === "unavailable")
  );
}

function isBankPayout(value: unknown): value is BankPayout {
  return (
    isRecord(value) &&
    isProvider(value.provider) &&
    typeof value.payoutId === "string" &&
    isRecord(value.amount) &&
    Number.isSafeInteger(value.amount.amountMinor) &&
    typeof value.amount.currency === "string" &&
    (value.status === "on_its_way" ||
      value.status === "arrived" ||
      value.status === "failed" ||
      value.status === "cancelled") &&
    typeof value.arrivalDate === "string" &&
    typeof value.sentAt === "string" &&
    (value.sales === null ||
      (isRecord(value.sales) &&
        typeof value.sales.from === "string" &&
        typeof value.sales.to === "string"))
  );
}

export function parseBankPayouts(value: unknown): BankPayoutsWindow {
  if (
    !isRecord(value) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.sources) ||
    !value.sources.every(isBankPayoutSource) ||
    !Array.isArray(value.payouts) ||
    !value.payouts.every(isBankPayout)
  )
    throw new Error("The bank payouts response is not valid.");
  return {
    sources: value.sources,
    truncated: value.truncated,
    payouts: value.payouts,
  };
}
