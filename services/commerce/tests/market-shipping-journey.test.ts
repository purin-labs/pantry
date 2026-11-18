// Plan 77 step 2, markets at shipping checkouts: the Japan shop sells two
// boxes of cookies to Singapore. Mei, in the Singapore market, pays in SGD:
// each price, the shipping, the tax and the duty are the shop's yen amounts
// at the market's rate of 0.0091, rounded to 5 cents, and the carrier, tax
// and duty quotes stay in yen as their evidence. Her card pays the SGD total
// and the order ships. A market with a price list has no rate for the
// carrier's yen, so a shipping checkout refuses it. Set
// MARKET_SHIPPING_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceMarketPricingV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  NOW,
  merchantId,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk } from "./order-desk.ts";
import { PARCEL_SHOP, ParcelBuyer } from "./parcel-buyer.ts";

const SHOP = PARCEL_SHOP;

/** Yen at 0.0091 SGD, half up to 5 cents: 91 cents for each ¥100. */
function sgdCents(yen: number): number {
  return Math.round((yen * 0.91) / 5) * 5;
}

it(
  "sells a shipping checkout in the buyer's market currency",
  { timeout: 60_000 },
  marketShipping,
);

async function marketShipping(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new MarketDesk(admin);
    expect(
      await staff.create("market_sg", "SGD", {
        kind: "converted",
        rate: { value: "0.0091", setAt: NOW, source: "staff" },
        roundingIncrement: 5,
      }),
    ).toMatchObject({ outcome: "applied" });

    // 1. In yen, the same cookies.
    const yen = await (await ParcelBuyer.start(buyer, "parcel_ken")).quote();
    if (yen.outcome !== "quoted") throw new Error("The yen quote failed");
    const inYen = yen.checkout.quote;
    expect(inYen.totals.total.currency).toBe("JPY");
    expect(inYen.market).toBeUndefined();

    // 2. Mei in the Singapore market pays in SGD.
    const mei = await ParcelBuyer.start(buyer, "parcel_mei");
    const sgd = await mei.quote("market_sg");
    if (sgd.outcome !== "quoted")
      throw new Error(`The SGD quote failed: ${JSON.stringify(sgd.error)}`);
    const inSgd = sgd.checkout.quote;
    const line = inYen.lines[0];
    const meiLine = inSgd.lines[0];
    if (line === undefined || meiLine === undefined)
      throw new Error("A quote has no line");
    expect(meiLine.unitPrice).toEqual({
      amountMinor: sgdCents(line.unitPrice.amountMinor),
      currency: "SGD",
    });
    expect(meiLine.lineTotal.amountMinor).toBe(
      meiLine.unitPrice.amountMinor * meiLine.quantity,
    );
    const charges = {
      shipping: inSgd.totals.shipping,
      tax: inSgd.totals.tax,
      duty: inSgd.totals.duty,
    };
    expect(charges).toEqual({
      shipping: {
        amountMinor: sgdCents(inYen.totals.shipping.amountMinor),
        currency: "SGD",
      },
      tax: {
        amountMinor: sgdCents(inYen.totals.tax.amountMinor),
        currency: "SGD",
      },
      duty: {
        amountMinor: sgdCents(inYen.totals.duty.amountMinor),
        currency: "SGD",
      },
    });
    expect(inSgd.totals.total).toEqual({
      amountMinor:
        meiLine.lineTotal.amountMinor +
        charges.shipping.amountMinor +
        charges.tax.amountMinor +
        charges.duty.amountMinor,
      currency: "SGD",
    });
    // The carrier's quote stays in yen as its evidence.
    expect(inSgd.shipping.carrierQuote.shippingAmount).toEqual(
      inYen.totals.shipping,
    );
    expect(inSgd.market).toEqual({
      marketId: "market_sg",
      currency: "SGD",
      shopCurrency: "JPY",
      rate: "0.0091",
      roundingIncrement: 5,
    });

    // 3. Her card pays the SGD total, and the order ships.
    const placed = await mei.pay(sgd.checkout);
    if (placed.state !== "placed") throw new Error("Mei has no order");
    expect(placed).toMatchObject({
      shipmentId: expect.stringMatching(/^shipment_/),
      shipping: { destinationCountry: "SG" },
    });
    const payments = await staff.payments(placed.orderId);
    expect(payments.map((payment) => payment.amount)).toEqual([
      inSgd.totals.total,
    ]);

    // 4. A price list has no rate for the carrier's yen.
    expect(
      await staff.create("market_sg_list", "SGD", {
        kind: "price_list",
        prices: [{ variantId: meiLine.variantId, amountMinor: 1_450 }],
      }),
    ).toMatchObject({ outcome: "applied" });
    const listed = await (
      await ParcelBuyer.start(buyer, "parcel_lin")
    ).quote("market_sg_list");
    expect(listed).toMatchObject({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkout.market",
      },
    });

    Object.assign(evidence, {
      yenTotals: inYen.totals,
      sgdTotals: inSgd.totals,
      market: inSgd.market,
      payments: payments.map((payment) => payment.amount),
      priceList: listed.outcome === "rejected" ? listed.error : null,
    });
  } finally {
    writeEvidence("MARKET_SHIPPING_ARTIFACT_DIR", "market-shipping", evidence);
    backend.close();
  }
}

class MarketDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "market_shipping");
  }

  create(
    marketId: string,
    currency: string,
    pricing: CommerceMarketPricingV1,
  ) {
    return this.edit(
      this.admin.createMarket({
        ...this.editBase(`create_${marketId}`),
        marketId,
        name: "Singapore",
        countries: ["SG"],
        currency,
        storefrontIds: [SHOP],
        pricing,
      }),
    );
  }

  async payments(orderId: string) {
    return (await this.snapshot()).payments.filter(
      (payment) => payment.orderId === orderId,
    );
  }
}
