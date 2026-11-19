// Plan 76A step 4A: a shop that prices in yen sells to Singapore from a
// fixed SGD price list and to the United States at a rate the merchant sets,
// rounded to five cents. Buyers pay in their market's currency; each order
// keeps the shop subtotal and the rate. An open checkout keeps the rate it
// quoted; a new or refreshed checkout uses the new rate, and a refresh keeps
// the buyer's market and code. A refund is in the order's currency. A Square
// account that settles in yen refuses an SGD payment.
// Set MARKET_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import type {
  CreateCommerceMarketV1,
  CommerceCommandInput,
  CommerceAdminClient,
  CommerceMarketPricingV1,
  CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  usd,
  writeEvidence,
  type Evidence,
  type Quoted,
} from "./journey-support.ts";

const SMALL = "variant_tea_small_sencha";
const LARGE = "variant_tea_large_sencha";

it(
  "sells in market currencies at list prices and stored rates, and refunds in the order currency",
  { timeout: 60_000 },
  marketsAtCheckout,
);

it(
  "refuses an SGD payment on a Square account that settles in yen",
  { timeout: 60_000 },
  squareSettlesInItsOwnCurrency,
);

async function marketsAtCheckout(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new MarketStaff(admin);
    await staff.createTea();
    // A price list may name only known variants.
    expect(
      await staff.create("market_bad", "Bad", ["SG"], "SGD", {
        kind: "price_list",
        prices: [{ variantId: "variant_missing", amountMinor: 100 }],
      }),
    ).toMatchObject(rejectedWith({ code: "resource_not_found" }));
    expect(await staff.createSingapore()).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "create_market", resource: { kind: "market" } },
    });
    await staff.createUnitedStates("0.0067");
    await staff.createSaveTen();

    // Ana in Singapore pays the list price in SGD.
    const ana = await Buyer.start(buyer, "ana");
    ana.marketId = "market_sg";
    const anaQuote = await ana.quote([{ ...catalogLine(SMALL), quantity: 2 }]);
    expect(anaQuote.quote.totals).toMatchObject({
      subtotal: sgd(2_900),
      tax: sgd(290),
      total: sgd(3_190),
    });
    const anaOrderId = await ana.pay(anaQuote);
    const anaOrder = await staff.order(anaOrderId);
    expect(anaOrder.totals.total).toEqual(sgd(3_190));
    expect(anaOrder.market).toEqual({
      marketId: "market_sg",
      marketRevision: 1,
      shopCurrency: "JPY",
      rate: null,
      shopSubtotal: jpy(2_400),
    });
    expect((await staff.payment(anaOrderId)).amount).toEqual(sgd(3_190));
    // A variant without an SGD price cannot be sold there; nor can a buyer
    // name a market that does not exist.
    const noPrice = await Buyer.start(buyer, "no_price");
    noPrice.marketId = "market_sg";
    await noPrice.fillCart([catalogLine("variant_tea_large_hojicha")]);
    expect(await noPrice.tryCheckout()).toMatchObject({ field: "checkout.market.price" });
    noPrice.marketId = "market_mars";
    expect(await noPrice.tryCheckout()).toMatchObject({ field: "checkout.market" });

    // Bo in the United States: 1,200 yen is 8.04 dollars and rounds up to
    // 8.05; 1,800 yen is 12.06 and rounds down to 12.05.
    const bo = await Buyer.start(buyer, "bo");
    bo.marketId = "market_us";
    const boQuote = await bo.quote([catalogLine(SMALL), catalogLine(LARGE)]);
    expect(lineAmounts(boQuote)).toEqual([805, 1_205]);
    expect(boQuote.quote.totals).toMatchObject({ tax: usd(201), total: usd(2_211) });
    const dee = await Buyer.start(buyer, "dee");
    dee.marketId = "market_us";
    dee.discountCodes = ["SAVE10"];
    const deeQuote = await dee.quote([catalogLine(SMALL), catalogLine(LARGE)]);
    const eve = await Buyer.start(buyer, "eve");
    eve.marketId = "market_us";
    eve.discountCodes = ["SAVE10"];
    const eveQuote = await eve.quote([catalogLine(SMALL)]);

    // The merchant sets a new rate. A stale revision is refused.
    expect(await staff.setRate(5, "0.0070")).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );
    expect(await staff.setRate(1, "0.0070")).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "update_market" },
    });

    // Bo's open checkout keeps the rate it quoted.
    const boOrder = await staff.order(await bo.pay(boQuote));
    expect(boOrder.totals.total).toEqual(usd(2_211));
    expect(boOrder.market).toMatchObject({ marketRevision: 1, rate: "0.0067" });

    // Cy's new checkout uses the new rate: 1,200 yen is 8.40 dollars.
    const cy = await Buyer.start(buyer, "cy");
    cy.marketId = "market_us";
    const cyQuote = await cy.quote([catalogLine(SMALL)]);
    expect(cyQuote.quote.totals).toMatchObject({ subtotal: usd(840), total: usd(924) });
    const cyOrder = await staff.order(await cy.pay(cyQuote));
    expect(cyOrder.market).toMatchObject({
      marketRevision: 2,
      rate: "0.0070",
      shopSubtotal: jpy(1_200),
    });

    // Dee refreshes: the new quote is still in dollars at the new rate, and
    // still 10% off (840 + 1,260 less 210).
    const deeRefreshed = await dee.refresh(deeQuote, [catalogLine(SMALL), catalogLine(LARGE)]);
    expect(deeRefreshed.quote.totals).toEqual({
      subtotal: usd(1_890),
      tax: usd(189),
      duty: usd(0),
      shipping: usd(0),
      total: usd(2_079),
      discount: usd(210),
    });
    const deeOrder = await staff.order(await dee.pay(deeRefreshed));
    expect(deeOrder.market).toMatchObject({ marketId: "market_us", rate: "0.0070" });

    // The merchant ends SAVE10. Eve refreshes and pays the full price; her
    // checkout does not use up the code.
    await staff.endSaveTen();
    const eveRefreshed = await eve.refresh(eveQuote, [catalogLine(SMALL)]);
    expect(eveRefreshed.quote.totals).toMatchObject({ subtotal: usd(840), total: usd(924) });
    expect(eveRefreshed.quote.totals.discount).toBeUndefined();
    await eve.pay(eveRefreshed);
    const discounts = await required(admin.listDiscounts(merchantId));
    expect(discounts.map((discount) => [discount.id, discount.redeemed])).toEqual([
      ["discount_save_ten", 1],
    ]);

    // A refund of one of Ana's two teas is in SGD; a yen refund is refused.
    const line = anaOrder.lineItems[0];
    if (line === undefined) throw new Error("Ana's order has no line");
    expect(await staff.refund(anaOrderId, line.id, jpy(1_450), jpy(145), "yen")).toMatchObject({
      outcome: "rejected",
    });
    expect(
      await staff.refund(anaOrderId, line.id, sgd(1_450), sgd(145), "sgd"),
    ).toMatchObject({ outcome: "applied" });
    // The order keeps its market after the refund, and Cy's after pickup.
    expect((await staff.order(anaOrderId)).market).toMatchObject({ marketId: "market_sg" });
    await staff.collect(cyOrder.id);
    expect(await staff.order(cyOrder.id)).toMatchObject({
      lifecycle: { state: "fulfilled" },
      market: { marketId: "market_us", rate: "0.0070" },
    });

    const markets = await required(admin.listMarkets(merchantId));
    expect(markets.map((market) => [market.id, market.currency, market.revision])).toEqual([
      ["market_sg", "SGD", 1],
      ["market_us", "USD", 2],
    ]);
    Object.assign(evidence, {
      receipts: staff.receipts,
      quotes: {
        ana: anaQuote.quote,
        bo: boQuote.quote,
        cy: cyQuote.quote,
        deeRefreshed: deeRefreshed.quote,
        eveRefreshed: eveRefreshed.quote,
      },
      orders: [anaOrder, boOrder, cyOrder, deeOrder].map((order) => ({
        id: order.id,
        totals: order.totals,
        market: order.market,
      })),
      markets,
      discounts,
    });
  } finally {
    writeEvidence("MARKET_ARTIFACT_DIR", "markets", evidence);
    backend.close();
  }
}

async function squareSettlesInItsOwnCurrency(): Promise<void> {
  const backend = await startBackend({
    paymentBinding: {
      provider: "square_online",
      account: {
        integrationAccountId: "integration_square_deterministic",
        providerAccountId: "square_merchant_deterministic",
        environment: "development",
        capabilityRevision: 1,
        country: "JP",
        currency: "JPY",
      },
      applicationId: "sq0idp-deterministic",
      locationId: "square_location_deterministic",
    },
  });
  try {
    const staff = new MarketStaff(backend.admin);
    await staff.createTea();
    await staff.createSingapore();
    const ana = await Buyer.start(backend.buyer, "ana");
    ana.marketId = "market_sg";
    const quoted = await ana.quote([catalogLine(SMALL)]);
    expect(quoted.quote.totals.total).toEqual(sgd(1_595));
    expect(await ana.tryPay(quoted)).toMatchObject({ code: "checkout_quote_mismatch" });
  } finally {
    backend.close();
  }
}

function sgd(amountMinor: number) {
  return { amountMinor, currency: "SGD" };
}

function lineAmounts(checkout: Quoted): number[] {
  return checkout.quote.lines.map((line) => line.lineTotal.amountMinor);
}

class MarketStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "market");
  }

  async order(orderId: string) {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order;
  }

  // Marks the order's pickup ready, then hands it over.
  async collect(orderId: string): Promise<void> {
    for (const step of ["ready", "complete"] as const) {
      const resources = await this.snapshot();
      const order = resources.orders.find((item) => item.id === orderId);
      const fulfillment = resources.fulfillments.find((item) => item.orderId === orderId);
      const payment = resources.payments.find((item) => item.orderId === orderId);
      if (order === undefined || fulfillment === undefined || payment === undefined)
        throw new Error(`${orderId} is incomplete`);
      const base = {
        ...(await this.base(`${step}_${orderId.slice(-8)}`)),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
      };
      await this.apply(
        step === "ready"
          ? this.admin.markPickupReady(base)
          : this.admin.completePickup({
              ...base,
              paymentId: payment.id,
              paymentRevision: payment.revision,
            }),
      );
    }
  }

  async payment(orderId: string) {
    const payment = (await this.snapshot()).payments.find((item) => item.orderId === orderId);
    if (payment === undefined) throw new Error(`${orderId} has no payment`);
    return payment;
  }

  create(
    marketId: string,
    name: string,
    countries: readonly string[],
    currency: string,
    pricing: CommerceMarketPricingV1,
  ): Promise<CommerceMutationResultV1> {
    const command: CommerceCommandInput<CreateCommerceMarketV1> = {
      ...this.editBase(`create_${marketId}`),
      marketId,
      name,
      countries,
      currency,
      storefrontIds: [STOREFRONT],
      pricing,
    };
    return this.edit(this.admin.createMarket(command));
  }

  createSingapore(): Promise<CommerceMutationResultV1> {
    return this.create("market_sg", "Singapore", ["SG"], "SGD", {
      kind: "price_list",
      prices: [
        { variantId: SMALL, amountMinor: 1_450 },
        { variantId: LARGE, amountMinor: 2_100 },
      ],
    });
  }

  createUnitedStates(rate: string): Promise<CommerceMutationResultV1> {
    return this.create("market_us", "United States", ["US"], "USD", {
      kind: "converted",
      rate: { value: rate, setAt: NOW, source: "staff" },
      roundingIncrement: 5,
    });
  }

  setRate(expectedRevision: number, rate: string): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateMarket({
        ...this.editBase(`rate_${expectedRevision}_${rate}`),
        marketId: "market_us",
        expectedRevision,
        changes: {
          pricing: {
            kind: "converted",
            rate: { value: rate, setAt: NOW, source: "staff" },
            roundingIncrement: 5,
          },
        },
      }),
    );
  }

  async createSaveTen(): Promise<void> {
    await this.apply(
      this.admin.createDiscount({
        ...this.editBase("create_save_ten"),
        discountId: "discount_save_ten",
        title: "Save 10%",
        method: { kind: "code", codes: ["SAVE10"] },
        rule: { kind: "amount_off_order", value: { kind: "percentage", basisPoints: 1_000 } },
        conditions: {
          minimumSubtotal: null,
          startsAt: NOW,
          endsAt: null,
          usageLimit: null,
          oncePerCustomer: false,
        },
      }),
    );
  }

  async endSaveTen(): Promise<void> {
    await this.apply(
      this.admin.deactivateDiscount({
        ...this.editBase("end_save_ten"),
        discountId: "discount_save_ten",
        expectedRevision: 1,
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    line: Readonly<{ amountMinor: number; currency: string }>,
    tax: Readonly<{ amountMinor: number; currency: string }>,
    key: string,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || payment === undefined)
      throw new Error(`${orderId} is incomplete`);
    const zero = { amountMinor: 0, currency: line.currency };
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${key}`)),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_market_${key}`,
        refundPolicyId: "refund_policy_standard",
        amount: { amountMinor: line.amountMinor + tax.amountMinor, currency: line.currency },
        allocation: {
          lineAllocations: [{ orderLineId, amount: line }],
          taxAllocations: [{ orderLineId, amount: tax }],
          dutyAllocations: [],
          shippingAllocation: zero,
        },
        reason: "One tea returned",
      }),
    );
  }
}
