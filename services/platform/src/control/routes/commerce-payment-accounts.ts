import type { CommerceClientError } from "@purin-labs/commerce-client";

import type { Env } from "../../env";
import { resolveMerchantControlContext } from "../commerce-merchant";
import { authorizeOrganisationRequest } from "../authorization";
import { resolveOpenProviderSupportReferences } from "../../data/onboarding-support";
import { controlError, controlJson, readJsonRecord } from "../http";
import { PRIMARY_ONLINE_PAYMENT_BINDING_ID } from "../../commerce/stripe-link";

/**
 * The payment accounts of an organisation's merchant (Plan 80 step 5): an
 * owner or an admin reads which Stripe and Square accounts take its
 * payments in Commerce, and opens Stripe's hosted onboarding for a new
 * Stripe account, which Commerce creates on the platform and links under
 * the primary online binding.
 */
export type CommercePaymentAccountControlRoute =
  | Readonly<{ kind: "commercePaymentAccounts"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceStripeOnboarding"; organisationIdRaw: string }>;

export function matchCommercePaymentAccountControlRoute(
  pathname: string,
): CommercePaymentAccountControlRoute | null {
  const onboarding =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/payment-accounts\/stripe\/onboarding$/u.exec(
      pathname,
    );
  if (onboarding !== null)
    return {
      kind: "commerceStripeOnboarding",
      organisationIdRaw: decode(onboarding[1]),
    };
  const accounts =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/payment-accounts$/u.exec(
      pathname,
    );
  return accounts === null
    ? null
    : {
        kind: "commercePaymentAccounts",
        organisationIdRaw: decode(accounts[1]),
      };
}

export async function handleCommercePaymentAccountControlRoute(
  request: Request,
  env: Env,
  route: CommercePaymentAccountControlRoute,
): Promise<Response> {
  const reading = route.kind === "commercePaymentAccounts";
  if (request.method !== (reading ? "GET" : "POST"))
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    !reading,
  );
  if (!authorized.ok) return authorized.response;
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  if (reading) {
    const listed = await merchant.client.listPaymentAccounts(
      merchant.merchantId,
    );
    if (!listed.ok) return commerceErrorResponse(listed.error);
    // Commerce stores a Stripe account's state when it links it, and Stripe
    // finishes hosted onboarding later, so each unfinished account is read
    // again. A failed read keeps the stored state.
    const accounts = await Promise.all(
      listed.value.accounts.map(async (account) => {
        if (account.provider !== "stripe" || account.state === "active")
          return account;
        const linked = await merchant.client.linkStripeAccount(
          merchant.merchantId,
          {
            paymentProviderBindingId: account.paymentProviderBindingId,
            accountId: account.providerAccountId,
          },
        );
        return linked.ok ? linked.value : account;
      }),
    );
    // A working Stripe account closes an earlier failed Stripe Connect, which
    // the Portal otherwise shows again on each visit.
    if (
      accounts.some(
        (account) =>
          account.provider === "stripe" && account.state === "active",
      )
    )
      await resolveOpenProviderSupportReferences(
        authorized.executionScope.database,
        {
          organisationId: authorized.organisationId,
          provider: "stripe",
          now: Date.now(),
        },
      );
    return controlJson({ ok: true, accounts });
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("stripe_onboarding_invalid", 422);
  const { country, returnPath } = body.value;
  if (
    typeof country !== "string" ||
    !/^[A-Z]{2}$/u.test(country) ||
    typeof returnPath !== "string" ||
    !/^\/portal\/[A-Za-z0-9/_?=&.-]{0,500}$/u.test(returnPath)
  )
    return controlError("stripe_onboarding_invalid", 422);
  // Stripe returns the owner to the Portal page that opened onboarding. A
  // repeated request reuses the merchant's account and opens a new link.
  const origin = env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "");
  if (!origin.startsWith("https://"))
    return controlError("public_origin_missing", 503);
  const opened = await merchant.client.startStripeOnboarding(
    merchant.merchantId,
    {
      paymentProviderBindingId: PRIMARY_ONLINE_PAYMENT_BINDING_ID,
      country,
      returnUrl: `${origin}${returnPath}`,
      refreshUrl: `${origin}${returnPath}`,
    },
  );
  return opened.ok
    ? controlJson({
        ok: true,
        onboardingUrl: opened.value.url,
        expiresAt: opened.value.expiresAt,
        account: opened.value.account,
      })
    : commerceErrorResponse(opened.error);
}

function commerceErrorResponse(error: CommerceClientError): Response {
  // Commerce refuses an account that another binding holds, or a Stripe
  // that is not configured; the owner cannot fix either here.
  if (error.kind === "http" && (error.status === 409 || error.status === 422))
    return controlJson(
      { ok: false, error: "payment_account_refused", detail: error.message },
      409,
    );
  return controlError("underclerk_unavailable", 503);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Payment account route capture is missing");
  return decodeURIComponent(value);
}
