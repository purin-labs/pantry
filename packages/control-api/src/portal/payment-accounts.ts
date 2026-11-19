import { isRecord } from "@purin-labs/std";

/** A Stripe account that takes the shop's online payments in Commerce. */
export type StripePaymentAccount = Readonly<{
  providerAccountId: string;
  country: string;
  currency: string;
  state: "onboarding" | "active" | "restricted";
}>;

export function parseStripeAccount(raw: unknown): StripePaymentAccount {
  if (
    !isRecord(raw) ||
    typeof raw.providerAccountId !== "string" ||
    typeof raw.country !== "string" ||
    typeof raw.currency !== "string" ||
    (raw.state !== "onboarding" &&
      raw.state !== "active" &&
      raw.state !== "restricted")
  )
    throw unexpected();
  return {
    providerAccountId: raw.providerAccountId,
    country: raw.country,
    currency: raw.currency,
    state: raw.state,
  };
}

export function unexpected(): Error {
  return new Error("The shop answered in an unexpected form.");
}
