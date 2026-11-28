import type { Result } from "@purin-labs/kernel/result";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { isRecord } from "@purin-labs/std";

/**
 * The client of Pantry's own Stripe account (Plan 95 step 6, decision 3). One
 * Purin Stripe account bills the Pantry Organisations for paid Jev use. It is
 * not the Stripe account of a shop: those belong to Commerce.
 *
 * Pantry keeps no card data. Stripe Checkout and the Stripe Customer Portal
 * show each card form.
 */
export type StripeBillingBindings = Readonly<{
  PANTRY_DEPLOYMENT_PROFILE?: string;
  PANTRY_STRIPE_BILLING_SECRET_KEY?: string;
  PANTRY_STRIPE_BILLING_WEBHOOK_SECRET?: string;
  PANTRY_STRIPE_BILLING_PRICE_ID?: string;
}>;

export type StripeBillingConfig = Readonly<{
  secretKey: string;
  webhookSecret: string;
  /** The one metered price, on the meter of `STRIPE_JEV_METER_EVENT_NAME`. */
  priceId: string;
}>;

/** The event name of the Stripe meter for Jev input tokens above the free use. */
const STRIPE_JEV_METER_EVENT_NAME = "pantry_jev_input_tokens";

/**
 * The billing configuration of this deployment, or null when billing is
 * closed. Billing is closed without the two secrets and the price id. In
 * production it is also closed with a test-mode key, so that no Organisation
 * gets paid use for a test card.
 */
export function stripeBillingConfig(
  env: StripeBillingBindings,
): StripeBillingConfig | null {
  const secretKey = env.PANTRY_STRIPE_BILLING_SECRET_KEY;
  const webhookSecret = env.PANTRY_STRIPE_BILLING_WEBHOOK_SECRET;
  const priceId = env.PANTRY_STRIPE_BILLING_PRICE_ID;
  if (
    secretKey === undefined ||
    !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/u.test(secretKey) ||
    webhookSecret === undefined ||
    !/^whsec_[A-Za-z0-9_]+$/u.test(webhookSecret) ||
    priceId === undefined ||
    !/^price_[A-Za-z0-9_]+$/u.test(priceId)
  )
    return null;
  if (
    env.PANTRY_DEPLOYMENT_PROFILE === "production" &&
    !/^(?:sk|rk)_live_/u.test(secretKey)
  )
    return null;
  return { secretKey, webhookSecret, priceId };
}

export type StripeBillingError =
  /** Stripe did not answer, or answered 429 or 5xx. A retry can pass. */
  | Readonly<{ code: "stripe_billing_unavailable" }>
  /** Stripe refused the request. The same request fails again. */
  | Readonly<{ code: "stripe_billing_refused"; status: number }>
  | Readonly<{ code: "stripe_billing_answer_invalid" }>;

type StripeBillingCall = Readonly<{
  config: StripeBillingConfig;
  fetcher?: typeof fetch;
}>;

/** One POST to the Stripe API with a form body. */
async function stripeBillingRequest(
  call: StripeBillingCall,
  request: Readonly<{
    path: string;
    form: Readonly<Record<string, string>>;
    /** Stripe returns the first answer again for the same key. */
    idempotencyKey?: string;
  }>,
): Promise<Result<Record<string, unknown>, StripeBillingError>> {
  const fetcher = call.fetcher ?? runtimeFetch;
  let response: Response;
  try {
    response = await fetcher(`https://api.stripe.com${request.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${call.config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(request.idempotencyKey === undefined
          ? {}
          : { "idempotency-key": request.idempotencyKey }),
      },
      body: new URLSearchParams(request.form).toString(),
    });
  } catch {
    return { ok: false, error: { code: "stripe_billing_unavailable" } };
  }
  if (response.status === 429 || response.status >= 500)
    return { ok: false, error: { code: "stripe_billing_unavailable" } };
  if (!response.ok)
    return {
      ok: false,
      error: { code: "stripe_billing_refused", status: response.status },
    };
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, error: { code: "stripe_billing_answer_invalid" } };
  }
  return isRecord(raw)
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "stripe_billing_answer_invalid" } };
}

const INVALID: Result<never, StripeBillingError> = {
  ok: false,
  error: { code: "stripe_billing_answer_invalid" },
};

/** The Stripe customer of one Organisation. Its metadata names the Organisation. */
export async function createStripeBillingCustomer(
  call: StripeBillingCall,
  input: Readonly<{ organisationId: string; name: string }>,
): Promise<Result<string, StripeBillingError>> {
  const created = await stripeBillingRequest(call, {
    path: "/v1/customers",
    form: {
      name: input.name,
      "metadata[organisation_id]": input.organisationId,
    },
    // One customer for each Organisation, also when the first answer is lost.
    idempotencyKey: `pantry-billing-customer:${input.organisationId}`,
  });
  if (!created.ok) return created;
  return typeof created.value.id === "string" &&
    /^cus_[A-Za-z0-9]+$/u.test(created.value.id)
    ? { ok: true, value: created.value.id }
    : INVALID;
}

/**
 * A Stripe Checkout session in subscription mode with the one metered price.
 * The session and its subscription name the Organisation, so that a webhook
 * event finds its billing account.
 */
export async function createStripeBillingCheckout(
  call: StripeBillingCall,
  input: Readonly<{
    organisationId: string;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }>,
): Promise<Result<string, StripeBillingError>> {
  return sessionUrl(
    await stripeBillingRequest(call, {
      path: "/v1/checkout/sessions",
      form: {
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.organisationId,
        "line_items[0][price]": call.config.priceId,
        "metadata[organisation_id]": input.organisationId,
        "subscription_data[metadata][organisation_id]": input.organisationId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    }),
  );
}

/** A Stripe Customer Portal session, for the card and the invoices. */
export async function createStripeBillingPortal(
  call: StripeBillingCall,
  input: Readonly<{ customerId: string; returnUrl: string }>,
): Promise<Result<string, StripeBillingError>> {
  return sessionUrl(
    await stripeBillingRequest(call, {
      path: "/v1/billing_portal/sessions",
      form: { customer: input.customerId, return_url: input.returnUrl },
    }),
  );
}

function sessionUrl(
  session: Result<Record<string, unknown>, StripeBillingError>,
): Result<string, StripeBillingError> {
  if (!session.ok) return session;
  return typeof session.value.url === "string" &&
    session.value.url.startsWith("https://")
    ? { ok: true, value: session.value.url }
    : INVALID;
}

/**
 * One meter event: `value` input tokens of one customer. Stripe keeps one
 * event for each `identifier`, so a repeated send charges nothing more.
 */
export async function sendStripeJevMeterEvent(
  call: StripeBillingCall,
  input: Readonly<{
    customerId: string;
    value: number;
    identifier: string;
    /** When the use happened, in seconds. */
    timestamp: number;
  }>,
): Promise<Result<null, StripeBillingError>> {
  const sent = await stripeBillingRequest(call, {
    path: "/v1/billing/meter_events",
    form: {
      event_name: STRIPE_JEV_METER_EVENT_NAME,
      identifier: input.identifier,
      timestamp: String(input.timestamp),
      "payload[stripe_customer_id]": input.customerId,
      "payload[value]": String(input.value),
    },
    idempotencyKey: input.identifier,
  });
  return sent.ok ? { ok: true, value: null } : sent;
}
