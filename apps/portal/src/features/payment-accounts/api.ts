import { isRecord } from "@purin-labs/std";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import {
  type StripePaymentAccount,
  parseStripeAccount,
  unexpected,
} from "@purin-labs/control-api/portal/payment-accounts";

function accountsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/payment-accounts`;
}

export async function readStripePaymentAccounts(
  organisationId: string,
): Promise<readonly StripePaymentAccount[]> {
  const raw = await controlRead(accountsPath(organisationId));
  const list = isRecord(raw) ? raw.accounts : undefined;
  if (!Array.isArray(list)) throw unexpected();
  return list
    .filter((item: unknown) => isRecord(item) && item.provider === "stripe")
    .map((item: unknown) => parseStripeAccount(item));
}

/** Opens Stripe's hosted onboarding; Stripe returns the owner to `returnPath`. */
export async function startStripeOnboarding(
  organisationId: string,
  country: string,
  returnPath: string,
): Promise<string> {
  const raw = await controlMutation(
    `${accountsPath(organisationId)}/stripe/onboarding`,
    "POST",
    { country, returnPath },
    undefined,
    // Each link is good for one visit; a new click asks for a new link.
    { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
  );
  if (!isRecord(raw) || typeof raw.onboardingUrl !== "string")
    throw unexpected();
  return raw.onboardingUrl;
}

export function paymentAccountErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.error === "string"
      ? error.details.error
      : null;
  switch (code) {
    case "payment_account_refused":
      return "Stripe refused this account for the shop.";
    case "stripe_onboarding_invalid":
      return "Choose the country of the business.";
    case "commerce_binding_missing":
      return "This workspace has no shop yet.";
    default:
      return "Pantry could not reach the shop. Try again.";
  }
}
