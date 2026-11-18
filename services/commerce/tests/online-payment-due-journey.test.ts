// Refactor 15, refactor 10, on a fake Stripe that only answers and records
// calls (`fake-stripe.ts`), with Platform stopped.
//
// 1. A buyer's card is declined and the buyer leaves. Stripe's notification
//    arrives while the quote is live, so the tins stay held: the buyer may
//    still try another card. When the quote expires, the alarm reads the
//    payment from Stripe, declines it and releases the tins, so another buyer
//    can buy them.
// 2. A buyer's first try fails and the checkout ends as declined. The buyer
//    then pays from an old tab, and Stripe takes the money. Commerce places
//    no order for an ended checkout, so the capture becomes a staff item with
//    the amount and Stripe's payment; staff record the refund once.
//
// Set ONLINE_PAYMENT_DUE_ARTIFACT_DIR to keep the evidence; it repeats byte
// for byte.
import { createHmac } from "node:crypto";

import { expect, it } from "vitest";

import { stripeWebhook } from "../src/worker.ts";
import { FakeStripe } from "./fake-stripe.ts";
import {
  BASE_URL,
  Buyer,
  CAFE_LOTS_EXPIRE,
  NOW,
  SERVICE_TOKEN,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const ACCOUNT = "acct_fakecafe";
const SECRET_KEY = "sk_test_fake_platform";
const WEBHOOK_SECRET = "whsec_payment_due_journey";
const BINDING = "payment_binding_primary_online";
const TIN = "position_tea_tin_cafe";
const SENCHA = catalogLine("variant_tea_small_sencha");

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "releases the holds of a declined card when the buyer does not come back",
  { timeout: 60_000 },
  async () => {
    let clock = Date.parse(NOW);
    const now = () => new Date(clock).toISOString();
    const stripe = new FakeStripe();
    stripe.connect(ACCOUNT);
    const backend = await startStripeBackend(stripe, now);
    const evidence: Evidence = {};
    try {
      const stock = await available(backend);
      const ana = await Buyer.start(backend.buyer, "due_ana");
      const checkout = await ana.quote([{ ...SENCHA, quantity: 2 }]);
      const intentId = await startPayment(backend, ana, checkout, "due_ana");
      expect(await available(backend)).toBe(stock - 2);

      // Ana's bank declines the card. Stripe tells Commerce at once, but
      // the quote is live: Ana may still try another card, so the tins stay
      // held.
      stripe.decline(intentId);
      const failed = await notify(
        backend,
        stripe,
        stripe.event(
          "payment_intent.payment_failed",
          ACCOUNT,
          stripe.intentObject(intentId),
          now(),
        ),
      );
      expect(failed.status).toBe(200);
      expect(await backend.runDueWork()).toBe(checkout.quote.expiresAt);
      expect(await available(backend)).toBe(stock - 2);
      evidence.whileQuoteLive = { notification: 200, held: 2 };

      // Ana does not come back. After the quote expires, the alarm reads the
      // payment from Stripe, declines it and releases the tins.
      clock = Date.parse(checkout.quote.expiresAt) + 1_000;
      await backend.runDueWork();
      expect(await available(backend)).toBe(stock);
      expect(await backend.runDueWork()).toBe(CAFE_LOTS_EXPIRE);
      evidence.afterDueTime = { held: 0, nextDue: CAFE_LOTS_EXPIRE };

      // Ana's own page now reads the decline, and Ben can buy the tins.
      const read = await required(
        backend.buyer.reconcilePayment(
          merchantId,
          STOREFRONT,
          checkout.checkoutId,
          ana.token,
          {
            schemaVersion: "underclerk.reconcile-buyer-payment.v1",
            idempotencyKey: "due_ana",
            checkoutRevision: checkout.revision,
            quoteDigest: checkout.quote.quoteDigest,
            confirmation: { kind: "provider_ui_completed" },
          },
        ),
      );
      expect(read).toMatchObject({
        state: "declined",
        reasonCode: "payment_method_required",
      });
      const ben = await Buyer.start(backend.buyer, "due_ben");
      await ben.quote([{ ...SENCHA, quantity: stock }]);
      expect(await available(backend)).toBe(0);
      evidence.buyerRead = { state: read.state };
      evidence.nextBuyer = { quotedTins: stock };
      writeEvidence(
        "ONLINE_PAYMENT_DUE_ARTIFACT_DIR",
        "online-payment-due-decline",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

it(
  "keeps a capture with no order as a staff item until staff record the refund",
  { timeout: 60_000 },
  async () => {
    let clock = Date.parse(NOW);
    const now = () => new Date(clock).toISOString();
    const stripe = new FakeStripe();
    stripe.connect(ACCOUNT);
    const backend = await startStripeBackend(stripe, now);
    const evidence: Evidence = {};
    try {
      const stock = await available(backend);
      const cai = await Buyer.start(backend.buyer, "due_cai");
      const checkout = await cai.quote([{ ...SENCHA, quantity: 1 }]);
      const intentId = await startPayment(backend, cai, checkout, "due_cai");

      // Cai's first try fails, and Cai's page reads the decline: the
      // checkout ends and the tin goes back.
      clock += 60_000;
      const declined = await required(
        backend.buyer.reconcilePayment(
          merchantId,
          STOREFRONT,
          checkout.checkoutId,
          cai.token,
          {
            schemaVersion: "underclerk.reconcile-buyer-payment.v1",
            idempotencyKey: "due_cai",
            checkoutRevision: checkout.revision,
            quoteDigest: checkout.quote.quoteDigest,
            confirmation: { kind: "provider_ui_completed" },
          },
        ),
      );
      expect(declined.state).toBe("declined");
      expect(await available(backend)).toBe(stock);

      // Cai then pays from an old tab, and Stripe takes the money.
      clock += 60_000;
      stripe.succeed(intentId);
      const succeeded = stripe.event(
        "payment_intent.succeeded",
        ACCOUNT,
        stripe.intentObject(intentId),
        now(),
      );
      expect((await notify(backend, stripe, succeeded)).status).toBe(200);
      expect((await notify(backend, stripe, succeeded)).status).toBe(200);
      const snapshot = await required(backend.admin.readSnapshot(merchantId));
      expect(snapshot.resources.orders).toHaveLength(0);
      expect(await available(backend)).toBe(stock);

      // Staff see one item with the amount and Stripe's payment.
      const open = await admin(backend, "GET", "unplaced-captures");
      expect(open.status).toBe(200);
      expect(open.body).toMatchObject({
        schemaVersion: "underclerk.unplaced-captures.v1",
        captures: [
          {
            checkoutId: checkout.checkoutId,
            revision: 1,
            amount: checkout.quote.totals.total,
            providerPaymentReference: intentId,
            reason: "checkout_expired",
            lifecycle: { state: "capture_unplaced" },
          },
        ],
      });
      const [item] = (open.body as { captures: { paymentAttemptId: string }[] })
        .captures;
      if (item === undefined) throw new Error("No staff item");
      evidence.staffItem = {
        orders: 0,
        items: 1,
        reason: "checkout_expired",
        amount: checkout.quote.totals.total,
      };

      // Staff refund Cai on Stripe and record it. A second record of the
      // same item is refused, and the alarm has nothing left to do.
      clock += 60_000;
      const resolution = `unplaced-captures/${item.paymentAttemptId}/resolution`;
      const resolved = await admin(backend, "POST", resolution, {
        schemaVersion: "underclerk.resolve-unplaced-capture.v1",
        expectedRevision: 1,
        resolution: "refunded",
        note: "Refunded on the Stripe dashboard",
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({
        revision: 2,
        lifecycle: {
          state: "resolved",
          resolution: "refunded",
          resolvedAt: now(),
        },
      });
      const again = await admin(backend, "POST", resolution, {
        schemaVersion: "underclerk.resolve-unplaced-capture.v1",
        expectedRevision: 2,
        resolution: "placed_by_hand",
      });
      expect(again).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "invalid_transition",
            machine: "unplaced_capture",
            state: "resolved",
            event: "resolve",
          },
        },
      });
      expect((await notify(backend, stripe, succeeded)).status).toBe(200);
      const after = await admin(backend, "GET", "unplaced-captures");
      expect((after.body as { captures: unknown[] }).captures).toHaveLength(1);
      expect(await backend.runDueWork()).toBe(CAFE_LOTS_EXPIRE);
      evidence.resolved = {
        resolution: "refunded",
        secondResolve: 409,
        items: 1,
      };
      writeEvidence(
        "ONLINE_PAYMENT_DUE_ARTIFACT_DIR",
        "online-payment-due-unplaced",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

async function startStripeBackend(
  stripe: FakeStripe,
  now: () => string,
): Promise<Backend> {
  const backend = await startBackend({
    now,
    stripe: {
      secretKey: SECRET_KEY,
      publishableKey: "pk_test_fake_platform",
      fetch: stripe.fetch,
    },
  });
  await new StaffDesk(backend.admin, "payment_due").createTea();
  const linked = await admin(backend, "PUT", "payment-accounts/stripe", {
    paymentProviderBindingId: BINDING,
    accountId: ACCOUNT,
  });
  expect(linked.status).toBe(200);
  return backend;
}

async function startPayment(
  backend: Backend,
  buyer: Buyer,
  checkout: Awaited<ReturnType<Buyer["quote"]>>,
  idempotencyKey: string,
): Promise<string> {
  const session = await required(
    backend.buyer.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      buyer.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey,
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
  return session.session.providerSessionReference;
}

async function available(backend: Backend): Promise<number> {
  const snapshot = await required(backend.admin.readSnapshot(merchantId));
  const position = snapshot.resources.inventoryPositions.find(
    (item) => item.id === TIN,
  );
  if (position?.balance.kind !== "accounted") throw new Error("No tins");
  return position.balance.available.amount;
}

async function admin(
  backend: Backend,
  method: string,
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
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function notify(
  backend: Backend,
  stripe: FakeStripe,
  body: string,
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
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
      STRIPE_SECRET_KEY: SECRET_KEY,
      UNDERCLERK_SERVICE_TOKEN: SERVICE_TOKEN,
      UNDERCLERK_MERCHANT: {
        getByName: () => ({
          fetch: (request: Request) => backend.fetch(request),
        }),
      } as never,
    },
    stripe.fetch,
  );
}
