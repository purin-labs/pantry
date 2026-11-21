// Plan 76 phase 3, on real Stripe test mode with Platform stopped: a partner
// connects the café's Stripe account, a buyer pays for tea, Stripe's
// notification places the order before the buyer comes back, the buyer's
// own reconcile then reads the same order, a repeated notification changes
// nothing, and staff refund part of the order on Stripe. A new shop opens
// Stripe's hosted onboarding.
//
// It calls api.stripe.com, so it runs only with
//   COMMERCE_STRIPE_TEST_SECRET_KEY  the platform's sk_test_ key
//   COMMERCE_STRIPE_TEST_PUBLISHABLE_KEY  the platform's pk_test_ key
//   COMMERCE_STRIPE_TEST_ACCOUNT     a connected test account with card payments
// The journey confirms the payment as Stripe.js does in the buyer's browser:
// with the session's publishable key, client secret and connected account,
// and Stripe's test card. Set STRIPE_ARTIFACT_DIR to keep the evidence; it
// repeats byte for byte, because it holds no Stripe ids.
import { createHmac } from "node:crypto";

import { CommerceAdminClient } from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { StripeApi } from "../src/payments/stripe/stripe-payments.ts";
import { stripeWebhook } from "../src/worker.ts";
import {
  BASE_URL,
  Buyer,
  SERVICE_TOKEN,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SECRET_KEY = process.env.COMMERCE_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.COMMERCE_STRIPE_TEST_ACCOUNT ?? "";
const PUBLISHABLE_KEY =
  process.env.COMMERCE_STRIPE_TEST_PUBLISHABLE_KEY ?? "";
const WEBHOOK_SECRET = "whsec_commerce_journey";
const BINDING = "payment_binding_primary_online";
// Stripe keeps idempotency keys for a day, and every other id here repeats
// from run to run, so each run pays under its own key.
const RUN = Date.now();
const PAYMENT_KEY = `stripe_buyer_payment_${RUN}`;
const SECOND_SHOP = `payment_binding_second_shop_${RUN}`;

type Backend = Awaited<ReturnType<typeof startBackend>>;

it.skipIf(
  !SECRET_KEY.startsWith("sk_test_") ||
    !PUBLISHABLE_KEY.startsWith("pk_test_") ||
    !ACCOUNT.startsWith("acct_"),
)(
  "takes, settles and partly refunds a Stripe payment with Platform stopped",
  { timeout: 120_000 },
  async () => {
    const backend = await startBackend({
      stripe: {
        secretKey: SECRET_KEY,
        publishableKey: PUBLISHABLE_KEY,
      },
    });
    const stripe = new StripeApi({ secretKey: SECRET_KEY });
    let onboardingAccount: string | undefined;
    try {
      const evidence: Evidence = {};
      const operator = new CommerceAdminClient({
        baseUrl: BASE_URL,
        serviceToken: SERVICE_TOKEN,
        fetch: backend.fetch,
      });
      await new StaffDesk(operator, "stripe").createTea();

      // 1. A partner key with settings:write connects the café's account;
      //    Commerce reads it from Stripe.
      const partnerKey = await issueKey(backend, [
        "settings:read",
        "settings:write",
      ]);
      const linked = await call(
        backend,
        partnerKey,
        "PUT",
        "payment-accounts/stripe",
        {
          paymentProviderBindingId: BINDING,
          accountId: ACCOUNT,
        },
      );
      const foreign = await call(
        backend,
        partnerKey,
        "PUT",
        "payment-accounts/stripe",
        {
          paymentProviderBindingId: "payment_binding_foreign",
          accountId: "acct_1NotConnectedToThis",
        },
      );
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({
        state: "active",
        environment: "development",
      });
      expect(foreign.status).toBe(409);

      // 2. A buyer starts a payment: Commerce makes the PaymentIntent on
      //    the connected account.
      const buyer = await Buyer.start(backend.buyer, "stripe_buyer");
      const checkout = await buyer.quote([
        catalogLine("variant_tea_small_sencha"),
      ]);
      const session = await required(
        backend.buyer.createPaymentSession(
          merchantId,
          STOREFRONT,
          checkout.checkoutId,
          buyer.token,
          {
            schemaVersion: "commerce.create-buyer-payment-session.v1",
            idempotencyKey: PAYMENT_KEY,
            checkoutRevision: checkout.revision,
            quoteDigest: checkout.quote.quoteDigest,
            returnUrl: `${BASE_URL}/store/cafe`,
          },
        ),
      );
      if (
        session.state !== "ready" ||
        session.session.kind !== "embedded_public_session"
      )
        throw new Error(`Payment session is ${session.state}`);
      const paymentIntentId = session.session.providerSessionReference;
      expect(session.session.publicConfiguration).toMatchObject({
        provider: "stripe_online",
        connectedAccountId: ACCOUNT,
      });

      // 3. The buyer's browser confirms with Stripe's test card, using only
      //    what the session gave it.
      const browser = session.session.publicConfiguration;
      if (browser.provider !== "stripe_online")
        throw new Error("Not a Stripe session");
      const confirmed = await fetch(
        `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${browser.publishableKey}`,
            "stripe-account": browser.connectedAccountId,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_secret: browser.clientSecret,
            payment_method: "pm_card_visa",
          }),
        },
      );
      const confirmedBody = (await confirmed.json()) as Record<string, unknown>;
      expect(confirmedBody.status, JSON.stringify(confirmedBody.error)).toBe(
        "succeeded",
      );

      // 4. Stripe's notification arrives before the buyer comes back, and
      //    places the order. Commerce reads the payment from Stripe.
      const event = await stripeEvent(stripe, paymentIntentId);
      const forged = await notify(backend, event, "whsec_someone_else");
      const notified = await notify(backend, event, WEBHOOK_SECRET);
      expect(forged.status).toBe(400);
      expect(notified.status).toBe(200);
      const afterNotification = await orders(operator);
      expect(afterNotification).toHaveLength(1);

      // 5. The buyer's reconcile reads the same order; a repeated
      //    notification changes nothing.
      const placed = await required(
        backend.buyer.reconcilePayment(
          merchantId,
          STOREFRONT,
          checkout.checkoutId,
          buyer.token,
          {
            schemaVersion: "commerce.reconcile-buyer-payment.v1",
            idempotencyKey: PAYMENT_KEY,
            checkoutRevision: checkout.revision,
            quoteDigest: checkout.quote.quoteDigest,
            confirmation: { kind: "provider_ui_completed" },
          },
        ),
      );
      if (placed.state !== "placed")
        throw new Error(`Buyer reconcile is ${placed.state}`);
      expect(placed.orderId).toBe(afterNotification[0]?.id);
      const repeated = await notify(backend, event, WEBHOOK_SECRET);
      expect(repeated.status).toBe(200);
      expect(await orders(operator)).toHaveLength(1);

      // 6. Staff refund part of the tea on Stripe.
      const resources = (await required(operator.readSnapshot(merchantId)))
        .resources;
      const order = resources.orders.find(
        (candidate) => candidate.id === placed.orderId,
      );
      const payment = resources.payments.find(
        (candidate) => candidate.orderId === placed.orderId,
      );
      const line = order?.lineItems[0];
      if (order === undefined || payment === undefined || line === undefined)
        throw new Error("Placed order is incomplete");
      const refund = await new RefundDesk(operator).refund(
        order,
        payment,
        line.id,
        500,
      );
      const charged = await stripe.request(
        "GET",
        `/v1/payment_intents/${paymentIntentId}?expand[]=latest_charge`,
        { account: ACCOUNT },
      );
      const charge =
        charged.kind === "ok" && typeof charged.body.latest_charge === "object"
          ? (charged.body.latest_charge as Record<string, unknown>)
          : {};
      expect(refund.outcome).toBe("applied");
      expect(charge.amount_refunded).toBe(500);

      // 7. A shop with no Stripe account opens Stripe's hosted onboarding.
      const onboarding = await call(
        backend,
        partnerKey,
        "POST",
        "payment-accounts/stripe/onboarding",
        {
          paymentProviderBindingId: SECOND_SHOP,
          country: "JP",
          returnUrl: "https://shop.example/stripe/done",
          refreshUrl: "https://shop.example/stripe/again",
        },
      );
      onboardingAccount = (
        onboarding.body.account as Record<string, unknown> | undefined
      )?.providerAccountId as string | undefined;
      expect(onboarding.status).toBe(200);
      expect(String(onboarding.body.url)).toMatch(
        /^https:\/\/connect\.stripe\.com\//u,
      );
      const listed = await call(backend, partnerKey, "GET", "payment-accounts");
      const states = Object.fromEntries(
        (listed.body.accounts as readonly Record<string, unknown>[]).map(
          (account) => [
            account.paymentProviderBindingId === BINDING
              ? "cafe"
              : "secondShop",
            account.state,
          ],
        ),
      );
      expect(states).toEqual({ cafe: "active", secondShop: "onboarding" });

      Object.assign(evidence, {
        connect: {
          linked: linked.status,
          state: linked.body.state,
          notConnected: foreign.status,
        },
        payment: {
          intentOnConnectedAccount:
            session.session.publicConfiguration.provider === "stripe_online" &&
            session.session.publicConfiguration.connectedAccountId === ACCOUNT,
          confirmedBy: "publishable key, client secret and pm_card_visa",
          amount: checkout.quote.totals.total,
        },
        notification: {
          forgedSignature: forged.status,
          verified: notified.status,
          ordersAfter: afterNotification.length,
          repeated: repeated.status,
        },
        buyerReconcile: {
          state: placed.state,
          sameOrder: placed.orderId === afterNotification[0]?.id,
        },
        refund: {
          outcome: refund.outcome,
          refundedOnStripe: charge.amount_refunded,
        },
        onboarding: {
          status: onboarding.status,
          hostedByStripe: true,
          accounts: states,
        },
      });
      writeEvidence("STRIPE_ARTIFACT_DIR", "stripe-payments", evidence);
    } finally {
      // Onboarding made a real test account; it is not needed again.
      if (onboardingAccount !== undefined)
        await stripe.request("DELETE", `/v1/accounts/${onboardingAccount}`);
      backend.close();
    }
  },
);

class RefundDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "stripe_refund");
  }

  async refund(
    order: Readonly<{ id: string; revision: number }>,
    payment: Readonly<{ id: string; revision: number }>,
    orderLineId: string,
    amountMinor: number,
  ) {
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base("refund")),
        orderId: order.id,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_stripe_part_${RUN}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amountMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(amountMinor) }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "One tin arrived dented",
      }),
    );
  }
}

async function issueKey(
  backend: Backend,
  scopes: readonly string[],
): Promise<string> {
  const issued = await call(backend, SERVICE_TOKEN, "POST", "api-keys", {
    label: "Payments partner",
    scopes,
  });
  if (issued.status !== 201)
    throw new Error(`Key issue failed: ${issued.status}`);
  return String(issued.body.key);
}

async function call(
  backend: Backend,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function orders(admin: CommerceAdminClient) {
  return (await required(admin.readSnapshot(merchantId))).resources.orders;
}

/** Stripe's own `payment_intent.succeeded` event for the payment. */
async function stripeEvent(
  stripe: StripeApi,
  paymentIntentId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await stripe.request(
      "GET",
      "/v1/events?type=payment_intent.succeeded&limit=20",
      { account: ACCOUNT },
    );
    const found =
      listed.kind === "ok" && Array.isArray(listed.body.data)
        ? listed.body.data.find(
            (event: unknown) =>
              typeof event === "object" &&
              event !== null &&
              JSON.stringify(event).includes(`"id":"${paymentIntentId}"`),
          )
        : undefined;
    if (found !== undefined) return JSON.stringify(found);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Stripe did not list the payment's event");
}

/** Posts an event to the Worker's webhook route, signed with `secret`. */
async function notify(
  backend: Backend,
  body: string,
  secret: string,
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return stripeWebhook(
    new Request(`${BASE_URL}/v1/providers/stripe/webhooks`, {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body,
    }),
    {
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      COMMERCE_SERVICE_TOKEN: SERVICE_TOKEN,
      // The merchant's object, as the Worker reaches it.
      COMMERCE_MERCHANT: {
        getByName: () => ({
          fetch: (request: Request) => backend.fetch(request),
        }),
      } as never,
    },
  );
}
