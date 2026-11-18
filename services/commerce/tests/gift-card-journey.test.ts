// Plan 76 phase 8, slice 1: gift cards and store credit, with Commerce's
// own Stripe payments on a fake that only answers and records calls
// (`fake-stripe.ts`). Staff issue gift cards with codes their own system
// makes. A card pays a whole order with no payment provider, or part of one
// while Stripe charges only the rest. An empty card is refused, and a card
// held by an abandoned checkout comes back when that quote lapses. A
// cancelled order returns the card's part to the card and refunds only the
// rest on Stripe. Staff refund a card payment as store credit with no Stripe
// refund, and the customer spends it after signing in. The unused balance
// at a base date matches the cards and credit, and no stored byte holds a
// gift card code. Set GIFT_CARD_ARTIFACT_DIR to keep the evidence; it
// repeats byte for byte.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  generateGiftCardCode,
  type CommerceAdminClient,
  type CommerceGiftCardBalanceV1,
  type CommerceMutationResultV1,
  type CommerceStorefrontClient,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

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
  type EmailOutbox,
  type Evidence,
  type Quoted,
} from "./journey-support.ts";

const ACCOUNT = "acct_fakegiftcafe";
const BINDING = "payment_binding_primary_online";
const SMALL = catalogLine("variant_tea_small_sencha");
const LARGE = catalogLine("variant_tea_large_sencha");

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "pays with gift cards and store credit, and returns them on cancellation and refund",
  { timeout: 60_000 },
  async () => {
    let clock = Date.parse(NOW);
    const now = () => new Date(clock).toISOString();
    const stripe = new FakeStripe();
    stripe.connect(ACCOUNT);
    const backend = await startBackend({
      now,
      customers: true,
      stripe: {
        secretKey: "sk_test_fake_platform",
        publishableKey: "pk_test_fake_platform",
        fetch: stripe.fetch,
      },
    });
    const evidence: Evidence = {};
    try {
      const staff = new GiftDesk(backend.admin);
      await staff.createTea();
      await linkStripe(backend);

      // 1. Staff issue a ¥5,000 card. A buyer reads its balance with the
      //    code typed in lower case and without hyphens.
      const spring = generateGiftCardCode();
      expect(
        (await staff.issueGiftCard("gift_spring", spring, 5_000)).outcome,
      ).toBe("applied");
      const ana = await Buyer.start(backend.buyer, "gift_ana");
      const typed = spring.replaceAll("-", "").toLowerCase();
      expect(await balanceOf(backend.buyer, ana, typed)).toMatchObject({
        lastCharacters: spring.slice(-4),
        balance: jpy(5_000),
        status: "active",
      });

      // 2. Ana's tea costs less than the card holds: nothing is due, no
      //    payment session opens, and Stripe sees no payment.
      ana.giftCardCodes = [spring];
      const anaCheckout = await ana.quote([SMALL]);
      const anaTotal = anaCheckout.quote.totals.total.amountMinor;
      expect(anaCheckout.quote.storedValue?.due).toEqual(jpy(0));
      expect(await ana.tryPay(anaCheckout)).toMatchObject({
        field: "checkout.storedValue.paidInFull",
      });
      const anaPlaced = await required(ana.placeStoredValue(anaCheckout));
      if (anaPlaced.state !== "placed")
        throw new Error("Ana's order is not placed");
      const again = await required(ana.placeStoredValue(anaCheckout));
      expect(again.state === "placed" ? again.orderId : again.state).toBe(
        anaPlaced.orderId,
      );
      expect(stripe.posts("/v1/payment_intents")).toBe(0);
      expect(
        await required(
          backend.buyer.readOrder(
            merchantId,
            STOREFRONT,
            anaCheckout.checkoutId,
            ana.token,
          ),
        ),
      ).toMatchObject({
        state: "placed",
        orderId: anaPlaced.orderId,
        total: jpy(anaTotal),
      });
      const afterAna = 5_000 - anaTotal;
      expect((await balanceOf(backend.buyer, ana, spring)).balance).toEqual(
        jpy(afterAna),
      );

      // 3. Ben's order costs more than is left: the card pays what is left,
      //    and Stripe charges only the rest.
      const ben = await Buyer.start(backend.buyer, "gift_ben");
      ben.giftCardCodes = [spring];
      const benCheckout = await ben.quote([{ ...LARGE, quantity: 3 }]);
      const benTotal = benCheckout.quote.totals.total.amountMinor;
      const benDue = benTotal - afterAna;
      expect(benCheckout.quote.storedValue).toMatchObject({
        amount: jpy(afterAna),
        due: jpy(benDue),
      });
      const benPaid = await payWithStripe(backend, stripe, ben, benCheckout);
      expect(benPaid.chargedOnStripe).toBe(benDue);
      expect(await staff.paymentAmounts(benPaid.orderId)).toEqual(
        [afterAna, benDue].sort((left, right) => left - right),
      );
      expect((await balanceOf(backend.buyer, ben, spring)).balance).toEqual(
        jpy(0),
      );

      // 4. Cai enters the empty card and an unknown code: both are refused.
      const cai = await Buyer.start(backend.buyer, "gift_cai");
      cai.giftCardCodes = [spring];
      expect(await cai.tryQuote([SMALL])).toMatchObject({
        kind: "refused",
        error: { field: "checkout.storedValue.giftCard.balance" },
      });
      cai.giftCardCodes = [generateGiftCardCode()];
      expect(await cai.tryQuote([SMALL])).toMatchObject({
        kind: "refused",
        error: { field: "checkout.storedValue.giftCard" },
      });

      // 5. A ¥3,000 card: Dee's quote holds all of it and she leaves. Eve
      //    cannot use the card until Dee's quote lapses and the alarm
      //    gives it back.
      const summer = generateGiftCardCode();
      expect(
        (
          await staff.issueGiftCard(
            "gift_summer",
            summer,
            3_000,
            "2026-12-31T15:00:00.000Z",
          )
        ).outcome,
      ).toBe("applied");
      const dee = await Buyer.start(backend.buyer, "gift_dee");
      dee.giftCardCodes = [summer];
      const deeCheckout = await dee.quote([{ ...LARGE, quantity: 2 }]);
      expect(deeCheckout.quote.storedValue?.amount).toEqual(jpy(3_000));
      const eve = await Buyer.start(backend.buyer, "gift_eve");
      eve.giftCardCodes = [summer];
      expect(await eve.tryQuote([SMALL])).toMatchObject({
        kind: "refused",
        error: { field: "checkout.storedValue.giftCard.balance" },
      });
      clock = Date.parse(deeCheckout.quote.expiresAt) + 1_000;
      await backend.runDueWork();
      const eveCheckout = await eve.quote([SMALL]);
      expect(eveCheckout.quote.storedValue?.due).toEqual(jpy(0));
      await required(eve.placeStoredValue(eveCheckout));
      expect((await balanceOf(backend.buyer, eve, summer)).balance).toEqual(
        jpy(3_000 - eveCheckout.quote.totals.total.amountMinor),
      );

      // 6. Staff cancel Ben's order. Stripe refunds only what it charged;
      //    the card's part returns to the card.
      expect((await staff.cancel(benPaid.orderId, benDue)).outcome).toBe(
        "applied",
      );
      expect(
        stripe.refundsOf(benPaid.intentId).map((refund) => refund.amount),
      ).toEqual([benDue]);
      expect((await balanceOf(backend.buyer, ben, spring)).balance).toEqual(
        jpy(afterAna),
      );
      expect(await staff.paymentStates(benPaid.orderId)).toEqual([
        "refunded",
        "refunded",
      ]);
      // Ben sees the card refund; the gift card part is back on the card.
      expect(
        await required(
          backend.buyer.readOrder(
            merchantId,
            STOREFRONT,
            benCheckout.checkoutId,
            ben.token,
          ),
        ),
      ).toMatchObject({
        state: "cancelled",
        refund: { state: "refunded", amount: jpy(benDue) },
      });

      // 7. Fay pays by card as a guest. Staff refund her order as store
      //    credit: Stripe refunds nothing. Fay signs in and spends the
      //    credit; the card pays what the credit does not cover.
      const fay = await Buyer.start(backend.buyer, "fay");
      const fayCheckout = await fay.quote([{ ...LARGE, quantity: 2 }]);
      const fayPaid = await payWithStripe(backend, stripe, fay, fayCheckout);
      const credit = await staff.refundLineToStoreCredit(fayPaid.orderId);
      expect(credit.result.outcome).toBe("applied");
      expect(stripe.refundsOf(fayPaid.intentId)).toEqual([]);
      const access = await signIn(
        backend.buyer,
        backend.emails,
        "fay@example.test",
      );
      const fayAccount = await Buyer.signedIn(
        backend.buyer,
        "fay_account",
        access,
      );
      fayAccount.storeCredit = true;
      const fayAgain = await fayAccount.quote([{ ...LARGE, quantity: 3 }]);
      expect(fayAgain.quote.storedValue?.tenders).toMatchObject([
        { kind: "store_credit", amount: jpy(credit.amount) },
      ]);
      const fayAgainPaid = await payWithStripe(
        backend,
        stripe,
        fayAccount,
        fayAgain,
      );
      expect(fayAgainPaid.chargedOnStripe).toBe(
        fayAgain.quote.totals.total.amountMinor - credit.amount,
      );

      // 8. The unused balance at a base date, as Japan's Payment Services
      //    Act asks: the cards' balances and no credit left. After the
      //    summer card expires it no longer counts.
      const springLeft = (await balanceOf(backend.buyer, ana, spring)).balance;
      const summerLeft = (await balanceOf(backend.buyer, ana, summer)).balance;
      const atBase = await required(
        backend.admin.readStoredValueLiability(merchantId, now()),
      );
      expect(atBase.currencies).toEqual([
        {
          currency: "JPY",
          giftCards: jpy(springLeft.amountMinor + summerLeft.amountMinor),
          storeCredit: jpy(0),
          accounts: 3,
        },
      ]);
      const afterSummer = await required(
        backend.admin.readStoredValueLiability(
          merchantId,
          "2027-03-31T14:59:59.000Z",
        ),
      );
      expect(afterSummer.currencies[0]?.giftCards).toEqual(springLeft);

      // 9. No stored byte holds a gift card code, in any form.
      const files = readdirSync(dirname(backend.databasePath)).map((name) =>
        readFileSync(join(dirname(backend.databasePath), name)),
      );
      for (const code of [spring, summer])
        for (const form of [code, code.replaceAll("-", "")])
          expect(files.some((bytes) => bytes.includes(form))).toBe(false);

      // 10. The event feed shows each card and each order that stored
      //     value placed.
      const kinds = await eventKinds(backend.admin);
      const accounts = await required(
        backend.admin.listStoredValueAccounts(merchantId),
      );
      Object.assign(evidence, {
        anaTotal,
        benTotal,
        benDue,
        chargedOnStripe: [
          benPaid.chargedOnStripe,
          fayAgainPaid.chargedOnStripe,
        ],
        stripeRefunds: [
          ...stripe.refundsOf(benPaid.intentId),
          ...stripe.refundsOf(fayPaid.intentId),
        ].map((refund) => refund.amount),
        storeCredit: credit.amount,
        accounts: accounts.map((account) => ({
          kind: account.kind,
          lastCharacters: account.lastCharacters === null ? null : "****",
          balance: account.balance,
          credited: account.credited,
          status: account.status,
        })),
        liability: {
          atBase: atBase.currencies,
          afterSummer: afterSummer.currencies,
        },
        events: Object.fromEntries(
          [
            "gift_card.created",
            "order.created",
            "order.cancelled",
            "refund.succeeded",
          ].map((kind) => [kind, kinds.filter((item) => item === kind).length]),
        ),
      });
      expect(kinds.filter((kind) => kind === "gift_card.created")).toHaveLength(
        2,
      );
    } finally {
      writeEvidence("GIFT_CARD_ARTIFACT_DIR", "gift-card", evidence);
      backend.close();
    }
  },
);

class GiftDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "gift");
  }

  async issueGiftCard(
    accountId: string,
    code: string,
    amountMinor: number,
    expiresAt: string | null = null,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.issueGiftCard({
        ...this.editBase(`issue_${accountId}`),
        accountId,
        code,
        amount: jpy(amountMinor),
        expiresAt,
        note: null,
      }),
    );
  }

  async paymentAmounts(orderId: string): Promise<readonly number[]> {
    return (await this.snapshot()).payments
      .filter((payment) => payment.orderId === orderId)
      .map((payment) => payment.amount.amountMinor)
      .sort((left, right) => left - right);
  }

  async paymentStates(orderId: string): Promise<readonly string[]> {
    return (await this.snapshot()).payments
      .filter((payment) => payment.orderId === orderId)
      .map((payment) => payment.lifecycle.state);
  }

  /** Cancels an order through the payment that Stripe took. */
  async cancel(
    orderId: string,
    cardMinor: number,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const fulfillment = resources.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    const payment = resources.payments.find(
      (item) =>
        item.orderId === orderId && item.amount.amountMinor === cardMinor,
    );
    if (
      order === undefined ||
      fulfillment === undefined ||
      payment === undefined
    )
      throw new Error(`${orderId} cannot be cancelled`);
    return this.edit(
      this.admin.cancelOrder({
        ...(await this.base("cancel")),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_cancel_${orderId.slice(-8)}`,
        reason: "Buyer cancelled",
      }),
    );
  }

  /** Refunds an order's one line, with its tax, as store credit. */
  async refundLineToStoreCredit(orderId: string) {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const line = order?.lineItems[0];
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || line === undefined || payment === undefined)
      throw new Error(`${orderId} cannot be refunded`);
    const amount = line.lineTotal.amountMinor + line.tax.amountMinor;
    const result = await this.edit(
      this.admin.refundOrder({
        ...(await this.base("store_credit")),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_credit_${orderId.slice(-8)}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amount),
        allocation: {
          lineAllocations: [{ orderLineId: line.id, amount: line.lineTotal }],
          taxAllocations: [{ orderLineId: line.id, amount: line.tax }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Tin arrived dented",
        destination: "store_credit",
      }),
    );
    return { result, amount };
  }
}

async function linkStripe(backend: Backend): Promise<void> {
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
}

// The buyer opens a payment session, confirms the card as Stripe.js would,
// and comes back to the shop, which reads the payment on Stripe.
async function payWithStripe(
  backend: Backend,
  stripe: FakeStripe,
  buyer: Buyer,
  checkout: Quoted,
) {
  const key = `${buyer.token.slice(-12)}_${checkout.checkoutId}`;
  const session = await required(
    backend.buyer.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      buyer.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: key,
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
  const placed = await required(
    backend.buyer.reconcilePayment(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      buyer.token,
      {
        schemaVersion: "underclerk.reconcile-buyer-payment.v1",
        idempotencyKey: key,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        confirmation: { kind: "provider_ui_completed" },
      },
    ),
  );
  if (placed.state !== "placed")
    throw new Error(`Payment ended ${placed.state}`);
  return {
    orderId: placed.orderId,
    intentId,
    chargedOnStripe: Number(stripe.intentObject(intentId).amount),
  };
}

async function balanceOf(
  client: CommerceStorefrontClient,
  buyer: Buyer,
  code: string,
): Promise<CommerceGiftCardBalanceV1> {
  return required(
    client.readGiftCardBalance(merchantId, STOREFRONT, buyer.token, code),
  );
}

async function signIn(
  client: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
): Promise<string> {
  const challenge = await required(
    client.requestCustomerSignIn(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const code = /\b(\d{6})\b/u.exec(emails.sent.at(-1)?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  const access = await required(
    client.verifyCustomerSignIn(merchantId, STOREFRONT, challenge.challengeId, {
      schemaVersion: "underclerk.verify-customer-sign-in.v1",
      code,
    }),
  );
  return access.customerAccessToken;
}

async function eventKinds(
  admin: CommerceAdminClient,
): Promise<readonly string[]> {
  const kinds: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await required(
      admin.readEvents(merchantId, {
        ...(after === undefined ? {} : { after }),
        limit: 200,
      }),
    );
    kinds.push(...page.events.map((event) => event.kind));
    if (page.nextCursor === null || page.events.length < 200) return kinds;
    after = page.nextCursor;
  }
}
