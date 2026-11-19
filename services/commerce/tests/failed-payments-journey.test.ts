// A shop's failed payments and payments of a day, as staff read them. A decline
// places no order and expires its checkout, so a buyer tries again on a new
// checkout: the reads follow the buyer session and show whether the buyer paid
// in the end. The payments read also lists a payment that no decline came before.
// Only the provider's answer is a stand-in; the attempts, the checkouts and the
// read are the product's. Set FAILED_PAYMENTS_ARTIFACT_DIR to keep the evidence.
import { commercePickupCode } from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
} from "./journey-support.ts";

const SENCHA = "variant_tea_small_sencha";
const START = Date.parse(NOW);

class ProviderDesk extends StaffDesk {
  /** The card provider refuses the attempt. */
  async decline(
    checkout: Readonly<{
      checkoutId: string;
      quote: Readonly<{ quoteDigest: string }>;
    }>,
    session: Readonly<{ checkoutRevision: number; paymentAttemptId: string }>,
    reasonCode: string,
  ): Promise<void> {
    await this.apply(
      this.admin.resolveCheckoutPayment({
        ...(await this.base(`decline_${session.paymentAttemptId}`)),
        checkoutId: checkout.checkoutId,
        // The session names the revision that it quoted; starting it moved it.
        checkoutRevision: session.checkoutRevision + 1,
        quoteDigest: checkout.quote.quoteDigest,
        paymentAttemptId: session.paymentAttemptId,
        paymentAttemptRevision: 1,
        outcome: { kind: "declined", reasonCode },
      }),
    );
  }
}

it(
  "shows each failed payment with its retries, and whether the buyer paid in the end",
  { timeout: 120_000 },
  async () => {
    let clock = START;
    const at = (minutes: number): string =>
      new Date(START + minutes * 60_000).toISOString();
    const backend = await startBackend({
      now: () => new Date(clock).toISOString(),
    });
    try {
      const desk = new ProviderDesk(backend.admin, "failed");
      await desk.createTea();
      const declineAt = async (
        buyer: Buyer,
        minutes: number,
        reason: string,
      ): Promise<string> => {
        clock = START + minutes * 60_000;
        const checkout = await quoted(buyer);
        const session = await required(
          backend.buyer.createPaymentSession(
            merchantId,
            STOREFRONT,
            checkout.checkoutId,
            buyer.token,
            {
              schemaVersion: "underclerk.create-buyer-payment-session.v1",
              idempotencyKey: `session_${String(minutes)}`,
              checkoutRevision: checkout.revision,
              quoteDigest: checkout.quote.quoteDigest,
              returnUrl: `${BASE_URL}/return`,
            },
          ),
        );
        if (session.state !== "ready") throw new Error("No payment session");
        await desk.decline(checkout, session, reason);
        return session.paymentAttemptId;
      };
      const payAt = async (buyer: Buyer, minutes: number): Promise<string> => {
        clock = START + minutes * 60_000;
        return buyer.pay(await quoted(buyer));
      };

      // Aki is declined twice and then pays. Ben never pays. Cho pays at the
      // first try. Dee is declined, and buys later in a new session: a buyer
      // session lasts 30 minutes, so that purchase is not a retry.
      const aki = await Buyer.start(backend.buyer, "failed_aki");
      const ben = await Buyer.start(backend.buyer, "failed_ben");
      const cho = await Buyer.start(backend.buyer, "failed_cho");
      const akiFirst = await declineAt(aki, 0, "card_declined");
      const benOnly = await declineAt(ben, 5, "payment_method_required");
      const choOrder = await payAt(cho, 6);
      const akiSecond = await declineAt(aki, 10, "card_declined");
      const akiOrder = await payAt(aki, 20);
      clock = START + 25 * 60_000;
      const dee = await Buyer.start(backend.buyer, "failed_dee");
      const deeOnly = await declineAt(dee, 30, "payment_cancelled");
      clock = START + 45 * 60_000;
      const deeLaterOrder = await payAt(
        await Buyer.start(backend.buyer, "failed_dee_later"),
        45,
      );

      const read = (startMinutes: number, endMinutes: number) =>
        required(
          backend.admin.readFailedPayments(merchantId, {
            start: at(startMinutes),
            end: at(endMinutes),
          }),
        );

      const hour = await read(0, 60);
      const summary = hour.steps.map((step) => ({
        id: step.paymentAttemptId,
        follows: step.follows,
        state: step.state,
        reason: step.reasonCode,
      }));
      // The most recent failure comes first, with each buyer's tries in order.
      // Cho's payment is absent, and Dee's later purchase is not a recovery.
      expect(summary).toEqual([
        {
          id: deeOnly,
          follows: null,
          state: "declined",
          reason: "payment_cancelled",
        },
        {
          id: benOnly,
          follows: null,
          state: "declined",
          reason: "payment_method_required",
        },
        {
          id: akiFirst,
          follows: null,
          state: "declined",
          reason: "card_declined",
        },
        {
          id: akiSecond,
          follows: akiFirst,
          state: "declined",
          reason: "card_declined",
        },
        {
          id: expect.any(String),
          follows: akiSecond,
          state: "paid",
          reason: null,
        },
      ]);
      const paid = hour.steps.at(-1);
      expect(paid?.orderCode).toBe(commercePickupCode(akiOrder));
      expect(paid?.channel).toBe("online");
      expect(paid?.at).toBe(at(20));
      expect(paid?.amount.amountMinor).toBeGreaterThan(0);
      expect(paid?.lines).toEqual([
        { title: expect.any(String), quantity: 1 },
      ]);
      // Staff see what was bought, and not who tried to buy it.
      expect(JSON.stringify(hour)).not.toContain("@");
      expect(JSON.stringify(hour)).not.toContain("failed_aki");

      // A run belongs to the day of its first decline: Aki's second try inside
      // this window does not show again without its start.
      const later = await read(10, 60);
      expect(later.steps.map((step) => step.paymentAttemptId)).toEqual([
        deeOnly,
      ]);
      // Dee's later purchase is no failed payment of its own.
      const purchase = await read(40, 50);
      expect(purchase.steps).toEqual([]);

      // A window with its end first is refused.
      const refused = await backend.admin.readFailedPayments(merchantId, {
        start: at(60),
        end: at(0),
      });
      expect(refused.ok).toBe(false);

      // The payments read lists every answered payment, the most recent run
      // first: Cho's payment and Dee's later purchase have no decline before
      // them, so each stands alone as paid.
      const everyPayment = await required(
        backend.admin.readPayments(merchantId, {
          start: at(0),
          end: at(60),
        }),
      );
      expect(
        everyPayment.steps.map((step) => ({
          follows: step.follows,
          state: step.state,
          orderCode: step.orderCode,
        })),
      ).toEqual([
        {
          follows: null,
          state: "paid",
          orderCode: commercePickupCode(deeLaterOrder),
        },
        { follows: null, state: "declined", orderCode: null },
        {
          follows: null,
          state: "paid",
          orderCode: commercePickupCode(choOrder),
        },
        { follows: null, state: "declined", orderCode: null },
        { follows: null, state: "declined", orderCode: null },
        { follows: akiFirst, state: "declined", orderCode: null },
        {
          follows: akiSecond,
          state: "paid",
          orderCode: commercePickupCode(akiOrder),
        },
      ]);
      // Every failed payment is also a payment, with the same tries.
      const declinedIds = everyPayment.steps
        .filter((step) => step.state === "declined")
        .map((step) => step.paymentAttemptId);
      expect(declinedIds.sort()).toEqual(
        hour.steps
          .filter((step) => step.state === "declined")
          .map((step) => step.paymentAttemptId)
          .sort(),
      );
      // A narrow window keeps only the runs that start inside it.
      const purchases = await required(
        backend.admin.readPayments(merchantId, {
          start: at(40),
          end: at(50),
        }),
      );
      expect(purchases.steps.map((step) => step.orderCode)).toEqual([
        commercePickupCode(deeLaterOrder),
      ]);
      expect(JSON.stringify(everyPayment)).not.toContain("@");
      expect(JSON.stringify(everyPayment)).not.toContain("failed_aki");
      const backwards = await backend.admin.readPayments(merchantId, {
        start: at(60),
        end: at(0),
      });
      expect(backwards.ok).toBe(false);

      writeEvidence("FAILED_PAYMENTS_ARTIFACT_DIR", "failed-payments", {
        window: [at(0), at(60)],
        steps: summary.length,
        recovered: hour.steps.filter((step) => step.state === "paid").length,
        paidFirstTimeShown: false,
        laterPurchaseShownAsRecovery: false,
        payments: everyPayment.steps.length,
        paidFirstTimeListedAsPayment: true,
      });
    } finally {
      backend.close();
    }
  },
);

async function quoted(buyer: Buyer) {
  const result = await buyer.tryQuote([catalogLine(SENCHA)]);
  if (result.kind !== "quoted")
    throw new Error(`No quote: ${JSON.stringify(result.error)}`);
  return result.checkout;
}
