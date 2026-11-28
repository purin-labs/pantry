import {
  createStripeBillingCheckout,
  createStripeBillingCustomer,
  createStripeBillingPortal,
  stripeBillingConfig,
  type StripeBillingBindings,
} from "@purin-labs/area-organisation-contract/server/billing/stripe-client";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  createBillingAccount,
  readBillingAccount,
  readOrganisationBillingProfile,
} from "./billing-account";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";

/**
 * Payment setup of an Organisation in Pantry's own Stripe account (Plan 95
 * step 6). Only the owner starts it; the route checks the role. Pantry shows
 * no card form and keeps no card data: each function answers a Stripe
 * address that the owner opens.
 */
export type BillingSetupError = Readonly<{
  code:
    /** This deployment does not bill through Stripe. */
    | "billing_closed"
    | "billing_organisation_not_found"
    /** Payment is set up. "Manage payment" changes the card. */
    | "billing_payment_already_set_up"
    /** Payment setup never started, so there is nothing to manage. */
    | "billing_account_missing"
    | "billing_provider_unavailable"
    | "billing_provider_refused";
}>;

type BillingSetupInput = Readonly<{
  env: StripeBillingBindings;
  db: OrganisationQuerySource;
  organisationId: OrganisationId;
  /** The Portal address that Stripe returns the owner to. */
  returnUrl: string;
  now: number;
  fetcher?: typeof fetch;
}>;

/**
 * "Set up payment": the address of a Stripe Checkout in subscription mode
 * with the one metered price. The first start makes the Stripe customer and
 * the billing account row; a later start keeps both.
 */
export async function startBillingPaymentSetup(
  input: BillingSetupInput,
): Promise<Result<Readonly<{ url: string }>, BillingSetupError>> {
  const config = stripeBillingConfig(input.env);
  if (config === null) return failure("billing_closed");
  const call = {
    config,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  };
  let account = await readBillingAccount(input.db, input.organisationId);
  if (account === null) {
    const profile = await readOrganisationBillingProfile(
      input.db,
      input.organisationId,
    );
    if (profile === null) return failure("billing_organisation_not_found");
    const customer = await createStripeBillingCustomer(call, {
      organisationId: input.organisationId,
      name: profile.name,
    });
    if (!customer.ok) return providerFailure(customer.error.code);
    await createBillingAccount(input.db, {
      organisationId: input.organisationId,
      stripeCustomerId: customer.value,
      now: input.now,
    });
    account = await readBillingAccount(input.db, input.organisationId);
    if (account === null) return failure("billing_provider_unavailable");
  }
  if (account.paymentState === "active" || account.paymentState === "past_due")
    return failure("billing_payment_already_set_up");
  const checkout = await createStripeBillingCheckout(call, {
    organisationId: input.organisationId,
    customerId: account.stripeCustomerId,
    successUrl: input.returnUrl,
    cancelUrl: input.returnUrl,
  });
  return checkout.ok
    ? { ok: true, value: { url: checkout.value } }
    : providerFailure(checkout.error.code);
}

/** "Manage payment": the address of the Stripe Customer Portal. */
export async function openBillingPaymentPortal(
  input: BillingSetupInput,
): Promise<Result<Readonly<{ url: string }>, BillingSetupError>> {
  const config = stripeBillingConfig(input.env);
  if (config === null) return failure("billing_closed");
  const account = await readBillingAccount(input.db, input.organisationId);
  if (account === null) return failure("billing_account_missing");
  const portal = await createStripeBillingPortal(
    {
      config,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    },
    { customerId: account.stripeCustomerId, returnUrl: input.returnUrl },
  );
  return portal.ok
    ? { ok: true, value: { url: portal.value } }
    : providerFailure(portal.error.code);
}

function providerFailure(
  code:
    | "stripe_billing_unavailable"
    | "stripe_billing_refused"
    | "stripe_billing_answer_invalid",
): Result<never, BillingSetupError> {
  return failure(
    code === "stripe_billing_refused"
      ? "billing_provider_refused"
      : "billing_provider_unavailable",
  );
}

function failure(
  code: BillingSetupError["code"],
): Result<never, BillingSetupError> {
  return { ok: false, error: { code } };
}
