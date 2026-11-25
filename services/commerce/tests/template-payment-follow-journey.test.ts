// A new café's storefront sells on the checkout profile that the storefront
// template installed. The café has no payment account yet, so the template's
// binding charges nothing: Aki's payment session is refused, as on
// shop.purin.io on 25 November 2026. The café connects Square and links its
// front location. The storefront then sells on the Square location, with no
// staff step, and Ben's payment session opens Square's card form. Aki's
// checkout keeps the profile that it was quoted under, so it stays refused.
// Square is a fake that only answers. Set TEMPLATE_PAYMENT_ARTIFACT_DIR to
// keep the evidence; it repeats byte for byte.
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  SERVICE_TOKEN,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  merchantId,
  startBackend,
  writeEvidence,
  type Evidence,
  type Quoted,
} from "./journey-support.ts";

const OAUTH = { clientId: "sq0idp-cafe-app", clientSecret: "sq0csp-secret" };
const SELLER = "MLCAFESELLER";
const LOCATION = "LCAFEFRONT";
const SQUARE_BINDING = `square_${LOCATION}`;
const SMALL = "variant_tea_small_sencha";

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "moves the template checkout to the first working payment account, so a buyer can pay",
  { timeout: 60_000 },
  async () => {
    const backend = await startBackend({
      square: { fetch: squareFetch, oauth: OAUTH },
    });
    const evidence: Evidence = { merchantId };
    try {
      // 1. Before any account: the template's binding cannot charge.
      await new StaffDesk(backend.admin, "template").createTea();
      const before = await activeProfile(backend);
      expect(before.publishedBy).toBe("system_storefront_template");
      const aki = await Buyer.start(backend.buyer, "template_aki");
      const akiQuote = await aki.quote([catalogLine(SMALL)]);
      const refused = await paymentSession(backend, aki, akiQuote, "aki");
      expect(refused).toEqual({
        ok: false,
        code: "resource_relationship_invalid",
        field: "buyerCheckout.paymentBinding",
      });
      evidence.beforeAccount = { profile: before, akiPayment: refused };

      // 2. The café connects Square and links the front location.
      await linkSquare(backend);

      // 3. The storefront now sells on the Square location; Ben pays there.
      const after = await activeProfile(backend);
      expect(after).toMatchObject({
        publishedBy: "system_storefront_template",
        paymentProviderBindingId: SQUARE_BINDING,
      });
      expect(after.checkoutProfileId).not.toBe(before.checkoutProfileId);
      const ben = await Buyer.start(backend.buyer, "template_ben");
      const benQuote = await ben.quote([catalogLine(SMALL)]);
      const opened = await paymentSession(backend, ben, benQuote, "ben");
      expect(opened).toEqual({
        ok: true,
        publicConfiguration: {
          provider: "square_online",
          applicationId: OAUTH.clientId,
          locationId: LOCATION,
          environment: "production",
        },
      });

      // 4. Aki's checkout was quoted under the old profile: still refused.
      const akiAgain = await paymentSession(backend, aki, akiQuote, "aki");
      expect(akiAgain).toEqual(refused);

      // 5. A second link of the same location moves nothing.
      await call(backend, "PUT", "payment-accounts/square", {
        paymentProviderBindingId: SQUARE_BINDING,
        locationId: LOCATION,
      });
      expect(await activeProfile(backend)).toEqual(after);
      evidence.afterAccount = {
        profile: after,
        benPayment: opened,
        akiPayment: akiAgain,
      };
      writeEvidence(
        "TEMPLATE_PAYMENT_ARTIFACT_DIR",
        "template-payment-follow",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

async function linkSquare(backend: Backend): Promise<void> {
  const connected = await call(backend, "PUT", "square/connection", {
    environment: "production",
    grant: {
      kind: "authorization_code",
      code: "code-cafe",
      redirectUri: "https://pantry.example/callback",
    },
  });
  expect(connected.status).toBe(200);
  const linked = await call(backend, "PUT", "payment-accounts/square", {
    paymentProviderBindingId: SQUARE_BINDING,
    locationId: LOCATION,
  });
  expect(linked.status).toBe(200);
}

async function activeProfile(backend: Backend) {
  const answer = await call(
    backend,
    "GET",
    `storefronts/${STOREFRONT}/checkout-profile-activation`,
  );
  const body = answer.body as {
    profile: {
      checkoutProfileId: string;
      configuration: { paymentPolicy: { paymentProviderBindingId: string } };
      lifecycle: { publishedBy?: string };
    };
  };
  return {
    checkoutProfileId: body.profile.checkoutProfileId,
    paymentProviderBindingId:
      body.profile.configuration.paymentPolicy.paymentProviderBindingId,
    publishedBy: body.profile.lifecycle.publishedBy,
  };
}

async function paymentSession(
  backend: Backend,
  buyer: Buyer,
  checkout: Quoted,
  name: string,
) {
  const result = await backend.buyer.createPaymentSession(
    merchantId,
    STOREFRONT,
    checkout.checkoutId,
    buyer.token,
    {
      schemaVersion: "commerce.create-buyer-payment-session.v1",
      idempotencyKey: `template_payment_${name}`,
      checkoutRevision: checkout.revision,
      quoteDigest: checkout.quote.quoteDigest,
      returnUrl: `${BASE_URL}/store/cafe`,
    },
  );
  if (!result.ok)
    return result.error.kind === "rejected"
      ? {
          ok: false,
          code: result.error.error.code,
          field:
            "field" in result.error.error ? result.error.error.field : null,
        }
      : { ok: false, kind: result.error.kind };
  if (
    result.value.state !== "ready" ||
    result.value.session.kind !== "embedded_public_session"
  )
    return { ok: false, state: result.value.state };
  return {
    ok: true,
    publicConfiguration: result.value.session.publicConfiguration,
  };
}

async function call(
  backend: Backend,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** Square's OAuth, token status, seller and one location that takes cards. */
const squareFetch: typeof fetch = async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input))
    .pathname;
  if (path === "/oauth2/token")
    return Response.json({
      access_token: "sq-access-cafe",
      refresh_token: "sq-refresh-cafe",
      token_type: "bearer",
      expires_at: "2027-01-01T00:00:00.000Z",
      merchant_id: SELLER,
    });
  if (path === "/oauth2/token/status")
    return Response.json({
      scopes: [
        "DEVICE_CREDENTIAL_MANAGEMENT",
        "DEVICES_READ",
        "MERCHANT_PROFILE_READ",
        "PAYMENTS_READ",
        "PAYMENTS_WRITE",
        "PAYOUTS_READ",
      ],
      client_id: OAUTH.clientId,
      merchant_id: SELLER,
    });
  if (path === "/v2/merchants/me")
    return Response.json({
      merchant: {
        id: SELLER,
        business_name: "Pantry Café",
        country: "JP",
        currency: "JPY",
      },
    });
  const location = {
    id: LOCATION,
    name: "Café front",
    merchant_id: SELLER,
    country: "JP",
    currency: "JPY",
    status: "ACTIVE",
    capabilities: ["CREDIT_CARD_PROCESSING"],
  };
  if (path === `/v2/locations/${LOCATION}`) return Response.json({ location });
  if (path === "/v2/locations") return Response.json({ locations: [location] });
  return Response.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
};
