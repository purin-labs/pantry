import type {
  Checkout,
  CheckoutPaymentAttempt,
} from "@purin-labs/commerce-contracts";
import { describe, expect, it } from "vitest";

import { readCounterSale } from "@purin-labs/area-cafe/server/data/counter-sale-readback";

const AT = "2026-09-05T00:00:00.000Z";
const DIGEST = `quote_${"ab".repeat(32)}`;

function quote(): Checkout["lifecycle"] extends { quote: infer TQuote }
  ? TQuote
  : never {
  return {
    quoteDigest: DIGEST,
    checkoutRevision: 2,
    lines: [
      {
        checkoutLineId: "checkout_line_1",
        source: {
          kind: "catalog",
          variantId: "variant_cookie",
          variantRevision: 1,
          merchantCode: "COOKIE",
          optionValues: [],
          offerId: "offer_cookie",
          offerRevision: 1,
          consumptionPlanId: "consumption_plan_cookie",
          consumptionPlanRevision: 1,
          inventory: { kind: "requirements", items: [] },
        },
        quantity: { amount: 1, scale: 0, unit: "each" },
        unitPrice: { currency: "JPY", minorUnits: 1200 },
        lineTotal: { currency: "JPY", minorUnits: 1200 },
      },
    ],
    subtotal: { currency: "JPY", minorUnits: 1200 },
    tax: { currency: "JPY", minorUnits: 120 },
    total: { currency: "JPY", minorUnits: 1320 },
    totals: {
      subtotal: { amountMinor: 1200, currency: "JPY" },
      tax: { amountMinor: 120, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 1320, currency: "JPY" },
    },
    expiresAt: AT,
  } as never;
}

function checkout(lifecycle: unknown): Checkout {
  return {
    checkoutId: "checkout_counter_1",
    source: {
      kind: "point_of_sale",
      pantryLocationId: "location_cafe",
      posConfigurationRevision: 3,
      operatorIdentity: "user_7585a72f-b277-50a2-8525-d876e77d83f8",
      terminalAssignmentRevision: 4,
      buyer: { kind: "anonymous" },
    },
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_counter",
      revision: 2,
    },
    revision: 2,
    lifecycle,
  } as unknown as Checkout;
}

function attempt(lifecycle: unknown): CheckoutPaymentAttempt {
  return {
    paymentAttemptId: "payment_attempt_1",
    revision: 1,
    binding: {},
    lifecycle,
  } as unknown as CheckoutPaymentAttempt;
}

describe("counter sale readback", function counterSaleReadbackSuite() {
  it("offers collection for a sale that has been rung up and nothing more", function fresh() {
    const state = readCounterSale({
      checkout: checkout({ state: "quoted", quote: quote() }),
      paymentAttempt: null,
    });
    expect(state.state).toBe("awaiting_collection");
    expect(state.collectable).toBe(true);
    expect(state.recoverable).toBeNull();
    expect(state.pantryLocationId).toBe("location_cafe");
    expect(state.quote?.quoteDigest).toBe(DIGEST);
  });

  it("refuses a second collection while a payment is still in flight", function collecting() {
    const state = readCounterSale({
      checkout: checkout({
        state: "payment_pending",
        quote: quote(),
        paymentAttemptId: "payment_attempt_1",
      }),
      paymentAttempt: attempt({
        state: "processing",
        reasonCode: "awaiting_card",
        reconcileAfter: AT,
      }),
    });
    expect(state.state).toBe("collecting");
    expect(state.collectable).toBe(false);
    expect(state.recoverable?.paymentAttemptId).toBe("payment_attempt_1");
  });

  it("keeps a captured sale out of expiry, whatever the quote deadline says", function capturedNotExpired() {
    const state = readCounterSale({
      checkout: checkout({ state: "expired", quote: quote(), expiredAt: AT }),
      paymentAttempt: attempt({
        state: "captured",
        providerPaymentReference: "square_payment_1",
        capturedAt: AT,
      }),
    });
    // Money outranks the deadline: an expired quote does not un-take a payment.
    expect(state.state).toBe("captured_unplaced");
    expect(state.collectable).toBe(false);
  });

  it("allows another attempt after the provider definitively declined", function declined() {
    const state = readCounterSale({
      checkout: checkout({
        state: "payment_pending",
        quote: quote(),
        paymentAttemptId: "payment_attempt_1",
      }),
      paymentAttempt: attempt({
        state: "declined",
        reasonCode: "card_declined",
        declinedAt: AT,
      }),
    });
    expect(state.state).toBe("declined");
    // A definitive no is the one failure a fresh collection is safe after.
    expect(state.collectable).toBe(true);
    expect(state.recoverable).toBeNull();
  });

  it("does not offer collection on a declined sale whose quote has run out", function declinedExpired() {
    const state = readCounterSale({
      checkout: checkout({ state: "expired", quote: quote(), expiredAt: AT }),
      paymentAttempt: attempt({
        state: "declined",
        reasonCode: "card_declined",
        declinedAt: AT,
      }),
    });
    expect(state.state).toBe("expired");
    expect(state.collectable).toBe(false);
  });

  it("reports a completed sale with the order it placed", function complete() {
    const state = readCounterSale({
      checkout: checkout({
        state: "accepted",
        quote: quote(),
        paymentAttemptId: "payment_attempt_1",
        orderId: "order_counter_1",
        acceptedAt: AT,
      }),
      paymentAttempt: attempt({
        state: "captured",
        providerPaymentReference: "square_payment_1",
        capturedAt: AT,
      }),
    });
    expect(state.state).toBe("complete");
    expect(state.collectable).toBe(false);
    expect(state.orderId).toBe("order_counter_1");
    expect(state.capturedPaymentReference).toBe("square_payment_1");
  });

  it("reports an abandoned sale as expired rather than collectable", function expired() {
    const state = readCounterSale({
      checkout: checkout({ state: "expired", quote: quote(), expiredAt: AT }),
      paymentAttempt: null,
    });
    expect(state.state).toBe("expired");
    expect(state.collectable).toBe(false);
  });
});
