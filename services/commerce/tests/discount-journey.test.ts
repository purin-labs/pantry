// Plan 76A step 7: an automatic 300 yen off tea and a code WELCOME10 (10% off
// the order, one use per customer, two uses in all). A signed-in buyer gets
// both, with tax on the discounted amounts; the same buyer cannot use the
// code again; a guest takes the last use and the next guest is refused. A
// refund of one line gives back its discounted amount, not its list price.
// Set DISCOUNT_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import type {
  CreateCommerceDiscountV1,
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  CHANNEL,
  NOW,
  PRODUCT,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  teaOffer,
  teaPlan,
  teaVariant,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";

const CART = [
  { ...catalogLine("variant_tea_small_sencha"), quantity: 2 },
  catalogLine("variant_gift_box"),
];

it(
  "applies code and automatic discounts with limits, tax after discount and net refunds",
  { timeout: 60_000 },
  discountsAtCheckout,
);

async function discountsAtCheckout(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails } = backend;
    const staff = new DiscountStaff(admin);
    await staff.createTea();
    await staff.listGiftBox();
    expect(
      await staff.create("discount_tea_300", "300 yen off tea", { kind: "automatic" }, {
        kind: "amount_off_products",
        value: { kind: "fixed_amount", amount: jpy(300) },
        productIds: [PRODUCT],
      }),
    ).toMatchObject({ outcome: "applied", receipt: { commandKind: "create_discount" } });
    await staff.create(
      "discount_welcome",
      "Welcome",
      { kind: "code", codes: ["WELCOME10"] },
      { kind: "amount_off_order", value: { kind: "percentage", basisPoints: 1_000 } },
      { usageLimit: 2, oncePerCustomer: true },
    );
    // A code names one discount.
    expect(
      await staff.create(
        "discount_again",
        "Again",
        { kind: "code", codes: ["welcome10"] },
        { kind: "amount_off_order", value: { kind: "fixed_amount", amount: jpy(100) } },
      ),
    ).toMatchObject(rejectedWith({ field: "discount.code.taken" }));

    // Ana signs in and enters the code in lower case.
    const anaAccess = await signIn(buyer, emails, "ana@example.test");
    const ana = await Buyer.signedIn(buyer, "ana", anaAccess);
    ana.discountCodes = ["welcome10"];
    const quoted = await ana.quote(CART);
    // Tea: 2,400 less 300 first, then both lines less 10% of 4,600 (460),
    // spread 210 and 250. Tax is 10% of the 4,140 that is paid.
    expect(
      quoted.quote.lines.map((line) =>
        line.kind === "order_balance"
          ? null
          : [line.variantId, line.lineTotal.amountMinor, line.discount?.amountMinor],
      ),
    ).toEqual([
      ["variant_tea_small_sencha", 1_890, 510],
      ["variant_gift_box", 2_250, 250],
    ]);
    expect(quoted.quote.totals).toEqual({
      subtotal: jpy(4_140),
      tax: jpy(414),
      duty: jpy(0),
      shipping: jpy(0),
      total: jpy(4_554),
      discount: jpy(760),
    });
    const anaOrder = await ana.pay(quoted);
    const order = await staff.order(anaOrder);
    expect(order.totals).toMatchObject({ discount: jpy(760), total: jpy(4_554) });
    expect(order.lineItems.map((line) => [line.sku, line.discount.amountMinor])).toEqual([
      ["TEA-S-SENCHA", 510],
      ["GIFT-BOX", 250],
    ]);

    // Ana cannot use the code a second time; an unknown code is refused.
    const again = await Buyer.signedIn(buyer, "ana_again", anaAccess);
    again.discountCodes = ["WELCOME10"];
    await again.fillCart([catalogLine("variant_gift_box")]);
    expect(await again.tryCheckout()).toMatchObject({ field: "discount.code.used" });
    again.discountCodes = ["NOPE10"];
    expect(await again.tryCheckout()).toMatchObject({ field: "discount.code.unknown" });

    // Without the code, Ana still gets the automatic tea discount.
    again.discountCodes = [];
    const automaticOnly = await again.quote([catalogLine("variant_tea_small_sencha")]);
    expect(automaticOnly.quote.totals).toMatchObject({
      subtotal: jpy(900),
      discount: jpy(300),
    });

    // Bo takes the last use; Cy is refused.
    const bo = await Buyer.start(buyer, "bo");
    bo.discountCodes = ["WELCOME10"];
    await bo.buyLines([catalogLine("variant_gift_box")]);
    const cy = await Buyer.start(buyer, "cy");
    cy.discountCodes = ["WELCOME10"];
    await cy.fillCart([catalogLine("variant_gift_box")]);
    expect(await cy.tryCheckout()).toMatchObject({ field: "discount.code.exhausted" });
    const discounts = await required(admin.listDiscounts(merchantId));
    expect(discounts.map((discount) => [discount.id, discount.redeemed])).toEqual([
      ["discount_tea_300", 1],
      ["discount_welcome", 2],
    ]);

    // A refund of the gift line gives back what Ana paid for it, not more.
    const gift = order.lineItems.find((line) => line.sku === "GIFT-BOX");
    if (gift === undefined) throw new Error("Ana's order has no gift line");
    expect(
      await staff.refund(anaOrder, gift.id, 2_500, gift.tax.amountMinor, "list"),
    ).toMatchObject(rejectedWith({ field: "refund.relationships" }));
    expect(
      await staff.refund(anaOrder, gift.id, gift.lineTotal.amountMinor, gift.tax.amountMinor, "net"),
    ).toMatchObject({ outcome: "applied" });

    Object.assign(evidence, {
      receipts: staff.receipts,
      quote: quoted.quote,
      order: { lines: order.lineItems, totals: order.totals },
      discounts,
    });
  } finally {
    writeEvidence("DISCOUNT_ARTIFACT_DIR", "discounts", evidence);
    backend.close();
  }
}

async function signIn(
  buyer: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
): Promise<string> {
  const challenge = await required(
    buyer.requestCustomerSignIn(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const code = /\b(\d{6})\b/.exec(emails.sent.at(-1)?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  return (
    await required(
      buyer.verifyCustomerSignIn(merchantId, STOREFRONT, challenge.challengeId, {
        schemaVersion: "underclerk.verify-customer-sign-in.v1",
        code,
      }),
    )
  ).customerAccessToken;
}

class DiscountStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "discount");
  }

  async order(orderId: string) {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order;
  }

  async listGiftBox(): Promise<void> {
    await this.apply(
      this.admin.placeChannelListing({
        ...(await this.base("list_gift_box")),
        salesChannelId: CHANNEL,
        catalog: {
          kind: "new_product",
          product: {
            id: "product_gift_box",
            revision: 1,
            title: "Gift box",
            description: "A box of Kyoto tea.",
            handle: null,
            productType: "gift",
            vendor: "",
            tags: [],
            status: "active",
            occurredAt: NOW,
          },
          variant: {
            ...teaVariant("variant_gift_box", "Gift box", "GIFT-BOX", []),
            productId: "product_gift_box",
          },
          consumptionPlan: teaPlan("variant_gift_box"),
        },
        offer: teaOffer("variant_gift_box", 2_500),
      }),
    );
  }

  create(
    discountId: string,
    title: string,
    method: CreateCommerceDiscountV1["method"],
    rule: CreateCommerceDiscountV1["rule"],
    limits: Readonly<{ usageLimit?: number; oncePerCustomer?: boolean }> = {},
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.createDiscount({
        ...this.editBase(`create_${discountId}`),
        discountId,
        title,
        method,
        rule,
        conditions: {
          minimumSubtotal: null,
          startsAt: NOW,
          endsAt: null,
          usageLimit: limits.usageLimit ?? null,
          oncePerCustomer: limits.oncePerCustomer ?? false,
        },
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    lineMinor: number,
    taxMinor: number,
    key: string,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || payment === undefined)
      throw new Error(`${orderId} is incomplete`);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${key}`)),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_discount_${key}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor + taxMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [{ orderLineId, amount: jpy(taxMinor) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Gift box returned",
      }),
    );
  }
}
