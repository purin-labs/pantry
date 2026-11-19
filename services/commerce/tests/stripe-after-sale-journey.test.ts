// Plan 76 phase 3, the after-sale part, on a fake Stripe that only answers and
// records calls (`fake-stripe.ts`), with Platform stopped. A buyer pays with
// Stripe; before the café links its account, a buyer's payment session is
// refused. Stripe reports a dispute of the payment to Commerce's own webhook
// route, then that the café won it; a dispute of a payment that Commerce did
// not run is left alone. Staff refund part of the order: Stripe reports the
// refund as pending, and the alarm reads it again until the bank finishes it,
// with one refund on Stripe; a retry of the staff command replays the same
// receipt. A second refund's answer is lost: the alarm finds that refund on
// Stripe instead of refunding twice. Set STRIPE_AFTER_SALE_ARTIFACT_DIR to
// keep the evidence; it repeats byte for byte.
import { clientInput } from "./command-input.ts";
import { createHmac } from "node:crypto";

import type {
  RefundCommerceOrderV1,
  CommerceEventV1,
  CommerceOrderV1,
  CommercePaymentV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { stripeWebhook } from "../src/worker.ts";
import { FakeStripe } from "./fake-stripe.ts";
import {
  BASE_URL,
  Buyer,
  NOW,
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

const ACCOUNT = "acct_fakecafe";
const SECRET_KEY = "sk_test_fake_platform";
const WEBHOOK_SECRET = "whsec_after_sale_journey";
const BINDING = "payment_binding_primary_online";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "records Stripe disputes and reads pending refunds again with Platform stopped",
  { timeout: 60_000 },
  async () => {
    let clock = Date.parse(NOW);
    const now = () => new Date(clock).toISOString();
    const stripe = new FakeStripe();
    stripe.connect(ACCOUNT);
    const backend = await startBackend({
      now,
      stripe: {
        secretKey: SECRET_KEY,
        publishableKey: "pk_test_fake_platform",
        fetch: stripe.fetch,
      },
    });
    const notify = (body: string) => post(backend, stripe, body);
    const evidence: Evidence = {};
    try {
      const operator = backend.admin;
      await new StaffDesk(operator, "after_sale").createTea();

      // 0. Before the café links its Stripe account, no provider takes the
      //    payment: the buyer's payment session is refused and nothing
      //    reaches Stripe.
      const early = await Buyer.start(backend.buyer, "after_sale_early");
      const earlyCheckout = await early.quote([
        { ...catalogLine("variant_tea_small_sencha"), quantity: 1 },
      ]);
      const unlinked = await backend.buyer.createPaymentSession(
        merchantId,
        STOREFRONT,
        earlyCheckout.checkoutId,
        early.token,
        {
          schemaVersion: "underclerk.create-buyer-payment-session.v1",
          idempotencyKey: "after_sale_unlinked_payment",
          checkoutRevision: earlyCheckout.revision,
          quoteDigest: earlyCheckout.quote.quoteDigest,
          returnUrl: `${BASE_URL}/store/cafe`,
        },
      );
      expect({
        refused: unlinked.ok ? null : unlinked.error,
        stripeCalls: stripe.calls.length,
      }).toMatchObject({
        refused: {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "buyerCheckout.paymentBinding",
          },
        },
        stripeCalls: 0,
      });
      evidence.unlinked = { session: "refused", stripeCalls: 0 };

      const linked = await backend.fetch(
        `${BASE_URL}/v1/admin/merchants/${merchantId}/payment-accounts/stripe`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${SERVICE_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            paymentProviderBindingId: BINDING,
            accountId: ACCOUNT,
          }),
        },
      );
      expect(linked.status).toBe(200);

      // 1. A buyer pays with Stripe; Stripe's notification places the order.
      const buyer = await Buyer.start(backend.buyer, "after_sale_buyer");
      const checkout = await buyer.quote([
        { ...catalogLine("variant_tea_small_sencha"), quantity: 2 },
      ]);
      const session = await required(
        backend.buyer.createPaymentSession(
          merchantId,
          STOREFRONT,
          checkout.checkoutId,
          buyer.token,
          {
            schemaVersion: "underclerk.create-buyer-payment-session.v1",
            idempotencyKey: "after_sale_payment",
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
      const intentId = session.session.providerSessionReference;
      stripe.succeed(intentId);
      const paid = await notify(
        stripe.event(
          "payment_intent.succeeded",
          ACCOUNT,
          stripe.intentObject(intentId),
          now(),
        ),
      );
      expect(paid.status).toBe(200);
      const placed = await sale(operator);
      const start = (await required(operator.readEvents(merchantId)))
        .nextCursor;

      // 2. The buyer's bank disputes the payment. Stripe tells Commerce;
      //    a repeated notification changes nothing; the café wins.
      clock += MINUTE;
      const dispute = {
        id: "dp_fake_1",
        object: "dispute",
        payment_intent: intentId,
        amount: placed.payment.amount.amountMinor,
        currency: placed.payment.amount.currency.toLowerCase(),
        reason: "product_not_received",
        status: "needs_response",
        evidence_details: { due_by: Math.floor((clock + 7 * DAY) / 1_000) },
      };
      const opened = stripe.event(
        "charge.dispute.created",
        ACCOUNT,
        dispute,
        now(),
      );
      expect((await notify(opened)).status).toBe(200);
      expect((await notify(opened)).status).toBe(200);
      // A dispute of a payment that Platform ran is not Commerce's.
      const foreign = stripe.foreignIntent(ACCOUNT, 900);
      expect(
        (
          await notify(
            stripe.event(
              "charge.dispute.created",
              ACCOUNT,
              {
                ...dispute,
                id: "dp_fake_foreign",
                payment_intent: foreign,
                amount: 900,
              },
              now(),
            ),
          )
        ).status,
      ).toBe(200);
      clock += MINUTE;
      const won = stripe.event(
        "charge.dispute.closed",
        ACCOUNT,
        { ...dispute, status: "won" },
        now(),
      );
      expect((await notify(won)).status).toBe(200);
      const disputeEvents = (await readAll(operator, start)).filter(
        (event) => event.kind === "dispute.updated",
      );
      expect(
        disputeEvents.map((event) =>
          event.resources.map((resource) => [resource.kind, resource.revision]),
        ),
      ).toEqual([[["payment_dispute", 1]], [["payment_dispute", 2]]]);

      // 3. Staff refund one tin. Stripe reports the refund as pending.
      stripe.nextRefundStatus = "pending";
      const line = placed.order.lineItems[0];
      if (line === undefined) throw new Error("Order has no line");
      const pendingCommand = await refundCommand(
        operator,
        placed,
        line.id,
        "after_sale_pending",
        jpy(500),
      );
      const pending = await required(
        operator.refundOrder(clientInput(pendingCommand)),
      );
      expect(pending.outcome).toBe("applied");
      expect(await adjustments(operator)).toEqual([["pending", 500]]);

      // 4. The alarm does not read it before it is due; after that it reads
      //    the refund by its id while the bank works, and once more when the
      //    bank has finished.
      const callsBefore = stripe.calls.length;
      await backend.reconcileRefunds();
      expect(stripe.calls.length).toBe(callsBefore);
      clock += 2 * MINUTE;
      await backend.reconcileRefunds();
      expect(await adjustments(operator)).toEqual([["pending", 500]]);
      const [refund] = stripe.refundsOf(intentId);
      if (refund === undefined) throw new Error("Stripe has no refund");
      stripe.finishRefund(refund.id);
      clock += 2 * MINUTE;
      await backend.reconcileRefunds();
      expect(await adjustments(operator)).toEqual([["completed", 500]]);
      expect(stripe.posts("/v1/refunds")).toBe(1);
      // Staff send the same command again and get its receipt.
      const retried = await required(
        operator.refundOrder(clientInput(pendingCommand)),
      );
      expect(retried.outcome).toBe("replayed");

      // 5. A second refund is made on Stripe, but its answer is lost. The
      //    alarm finds the refund by its attempt and makes no second one,
      //    though Stripe no longer knows the idempotency key.
      stripe.nextRefundStatus = "succeeded";
      stripe.loseNextRefundAnswer = true;
      const lostCommand = await refundCommand(
        operator,
        await sale(operator),
        line.id,
        "after_sale_lost",
        jpy(300),
      );
      expect(
        (await required(operator.refundOrder(clientInput(lostCommand))))
          .outcome,
      ).toBe("applied");
      expect(await adjustments(operator)).toEqual([
        ["completed", 500],
        ["pending", 300],
      ]);
      clock += 2 * MINUTE;
      await backend.reconcileRefunds();
      expect(await adjustments(operator)).toEqual([
        ["completed", 500],
        ["completed", 300],
      ]);
      expect(stripe.refundsOf(intentId)).toHaveLength(2);
      expect(stripe.posts("/v1/refunds")).toBe(2);
      const refundEvents = (await readAll(operator, start)).filter(
        (event) => event.kind === "refund.succeeded",
      );
      expect(refundEvents).toHaveLength(2);
      expect(await backend.reconcileRefunds()).toBeNull();

      Object.assign(evidence, {
        dispute: {
          notifications: ["created", "created again", "foreign", "closed won"],
          events: disputeEvents.map((event) => [
            event.kind,
            event.resources[0]?.revision,
          ]),
        },
        pendingRefund: {
          firstOutcome: pending.outcome,
          adjustmentsAfter: await adjustments(operator),
          retry: retried.outcome,
        },
        stripe: {
          refundPosts: stripe.posts("/v1/refunds"),
          refunds: stripe
            .refundsOf(intentId)
            .map((item) => [item.amount, item.status]),
          calls: stripe.calls.map(
            (call) =>
              `${call.method} ${call.path.replace(/(pi|re)_fake_\d+/gu, "$1_*")}`,
          ),
        },
        refundEvents: refundEvents.length,
      });
      writeEvidence(
        "STRIPE_AFTER_SALE_ARTIFACT_DIR",
        "stripe-after-sale",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

async function sale(
  admin: Backend["admin"],
): Promise<
  Readonly<{
    order: CommerceOrderV1;
    payment: CommercePaymentV1;
    merchantRevision: number;
  }>
> {
  const snapshot = await required(admin.readSnapshot(merchantId));
  const order = snapshot.resources.orders[0];
  const payment = snapshot.resources.payments.find(
    (candidate) => candidate.orderId === order?.id,
  );
  if (order === undefined || payment === undefined)
    throw new Error("No paid order");
  return { order, payment, merchantRevision: snapshot.merchantRevision };
}

async function refundCommand(
  admin: Backend["admin"],
  current: Awaited<ReturnType<typeof sale>>,
  orderLineId: string,
  key: string,
  amount: ReturnType<typeof jpy>,
): Promise<RefundCommerceOrderV1> {
  const fresh = await sale(admin);
  return {
    schemaVersion: "underclerk.refund-order.v1",
    merchantId,
    expectedMerchantRevision: fresh.merchantRevision,
    idempotencyKey: key,
    requestedAt: NOW,
    orderId: current.order.id,
    orderRevision: fresh.order.revision,
    paymentId: current.payment.id,
    paymentRevision: fresh.payment.revision,
    refundAttemptId: `refund_${key}`,
    refundPolicyId: "refund_policy_standard",
    amount,
    allocation: {
      lineAllocations: [{ orderLineId, amount }],
      taxAllocations: [],
      dutyAllocations: [],
      shippingAllocation: jpy(0),
    },
    reason: "A tin arrived dented",
  };
}

/** The status and amount of each refund adjustment on the order. */
async function adjustments(
  admin: Backend["admin"],
): Promise<readonly (readonly [string, number])[]> {
  return (await sale(admin)).order.adjustments
    .filter((adjustment) => adjustment.kind === "refund")
    .map(
      (adjustment) =>
        [adjustment.status, adjustment.amount.amountMinor] as const,
    );
}

async function readAll(
  admin: Backend["admin"],
  after: string | null,
): Promise<readonly CommerceEventV1[]> {
  const events: CommerceEventV1[] = [];
  let cursor = after ?? undefined;
  for (;;) {
    const page = await required(
      admin.readEvents(merchantId, {
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: 50,
      }),
    );
    events.push(...page.events);
    if (page.events.length < 50 || page.nextCursor === null) return events;
    cursor = page.nextCursor;
  }
}

/** Posts a Stripe event to the Worker's webhook route, correctly signed. */
async function post(
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
