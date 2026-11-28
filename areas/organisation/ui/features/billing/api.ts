import { isRecord } from "@purin-labs/std";
import {
  parseBillingView,
  type BillingView,
} from "@purin-labs/control-api/portal/billing";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";

function billingPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/billing`;
}

/** The billing state. Only the owner and an admin may read it. */
export async function readBilling(
  organisationId: string,
): Promise<BillingView> {
  const raw = await controlRead(billingPath(organisationId));
  if (!isRecord(raw) || raw.ok !== true)
    throw new Error("Billing is unavailable.");
  return parseBillingView(raw.value);
}

/**
 * The Stripe address of "Set up payment" (Checkout) or "Manage payment" (the
 * Customer Portal). Stripe returns the owner to `returnPath`. Only the owner
 * may open one.
 */
export async function openBillingPayment(
  organisationId: string,
  page: "checkout" | "portal",
  returnPath: string,
): Promise<string> {
  const raw = await controlMutation(
    `${billingPath(organisationId)}/${page}`,
    "POST",
    { returnPath },
    undefined,
    // Each click opens a new Stripe page.
    { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
  );
  if (!isRecord(raw) || raw.ok !== true || typeof raw.url !== "string")
    throw new Error("Billing is unavailable.");
  return raw.url;
}

/** A short sentence for a refused read or a payment page that did not open. */
export function billingErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.error === "string"
      ? error.details.error
      : null;
  // The control role check hides a route from a member who may not use it.
  if (error instanceof ControlApiError && error.status === 404)
    return "Only the owner can set up or manage payment.";
  switch (code) {
    case "billing_closed":
      return "Payment setup is not open yet.";
    case "billing_payment_already_set_up":
      return "Payment is set up. Use Manage payment to change it.";
    case "billing_account_missing":
      return "Set up payment first.";
    case "billing_provider_refused":
    case "billing_provider_unavailable":
    case "billing_unavailable":
      return "Pantry could not reach Stripe. Try again.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not open the payment page. Try again.";
  }
}
