// Plan 77 step 2: shipping checkouts run the same pipeline stages as pickup
// checkouts. A discount code comes off the lines before the shipping quote,
// so tax and duty are on what the buyer pays; a gift card pays the total
// after shipping, and the card pays the rest. A gift card that covers the
// whole total places a shipping order with no card payment. A refund of the
// mixed order splits card first. Set SHIPPING_TENDERS_ARTIFACT_DIR to keep
// the run's evidence; the file repeats byte for byte for the same commit.
import {
  type CommerceAdminClient,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  NOW,
  jpy,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk } from "./order-desk.ts";

const SHOP = "storefront_cookie_store_sg";
// Fixed codes, so that the evidence repeats; a merchant's codes are random.
const RIO_CODE = "RIO1-2345-6789-ABCD";
const SORA_CODE = "SORA-2345-6789-ABCD";

it(
  "takes discounts and gift cards at a shipping checkout, before tax and duty",
  { timeout: 60_000 },
  shippingTenders,
);

async function shippingTenders(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ShippingDesk(admin);
    await staff.createDiscount("discount_ship_10", "SHIP10", 1_000);
    await staff.issueGiftCard("gift_rio", RIO_CODE, 1_000);

    // Without a code, the cookies to Singapore cost the full price.
    const plain = await ShippingBuyer.start(buyer, "ship_plain");
    const full = await plain.quote({});
    expect(full.quote.totals.discount).toBeUndefined();

    // Rio enters the code and a ¥1,000 gift card for the same cookies.
    const rio = await ShippingBuyer.start(buyer, "ship_rio");
    const quoted = await rio.quote({
      discountCodes: ["ship10"],
      giftCardCodes: [RIO_CODE],
    });
    const gross = full.quote.totals.subtotal.amountMinor;
    const discount = Math.floor((gross * 1_000 + 5_000) / 10_000);
    const totals = quoted.quote.totals;
    expect(totals.discount).toEqual(jpy(discount));
    expect(totals.subtotal).toEqual(jpy(gross - discount));
    expect(quoted.quote.lines[0]?.discount).toEqual(jpy(discount));
    // Duty is on the value the buyer pays, so the code lowers it too.
    expect(totals.duty.amountMinor).toBeLessThan(
      full.quote.totals.duty.amountMinor,
    );
    expect(totals.total.amountMinor).toBe(
      totals.subtotal.amountMinor +
        totals.tax.amountMinor +
        totals.duty.amountMinor +
        totals.shipping.amountMinor,
    );
    expect(quoted.quote.storedValue).toMatchObject({
      amount: jpy(1_000),
      due: jpy(totals.total.amountMinor - 1_000),
    });
    const rioPlaced = await rio.pay(quoted);
    if (rioPlaced.state !== "placed") throw new Error("Rio has no order");
    const rioPayments = await staff.payments(rioPlaced.orderId);
    expect(rioPayments.map((payment) => payment.amount.amountMinor)).toEqual(
      [1_000, totals.total.amountMinor - 1_000].sort((a, b) => a - b),
    );
    expect(await staff.giftCardBalance("gift_rio")).toEqual(jpy(0));

    // Rio's cookies arrive crushed. Staff refund ¥1,500 of the line: the
    // card money goes back first.
    const split = await staff.splitRefund(rioPlaced.orderId, 1_500);
    const card = rioPayments.find(
      (payment) => !payment.id.startsWith("payment_stored_value_"),
    );
    expect(split).toMatchObject({
      outcome: "split",
      parts: [
        {
          paymentId: card?.id,
          amount: jpy(1_500),
          result: { outcome: "applied" },
        },
      ],
    });

    // Sora's ¥20,000 gift card pays everything: no card payment, and the
    // order ships.
    await staff.issueGiftCard("gift_sora", SORA_CODE, 20_000);
    const sora = await ShippingBuyer.start(buyer, "ship_sora");
    const covered = await sora.quote({ giftCardCodes: [SORA_CODE] });
    expect(covered.quote.storedValue?.due).toEqual(jpy(0));
    const soraPlaced = await required(sora.placeStoredValue(covered));
    if (soraPlaced.state !== "placed") throw new Error("Sora has no order");
    expect(soraPlaced).toMatchObject({
      shipmentId: expect.stringMatching(/^shipment_/),
      shipping: { destinationCountry: "SG" },
    });
    expect(
      (await staff.payments(soraPlaced.orderId)).map((payment) => ({
        amount: payment.amount,
        state: payment.lifecycle.state,
      })),
    ).toEqual([{ amount: covered.quote.totals.total, state: "captured" }]);
    expect(await staff.giftCardBalance("gift_sora")).toEqual(
      jpy(20_000 - covered.quote.totals.total.amountMinor),
    );

    Object.assign(evidence, {
      receipts: staff.receipts,
      plainTotals: full.quote.totals,
      rioTotals: totals,
      rioStoredValue: quoted.quote.storedValue,
      rioSplit: split,
      soraTotals: covered.quote.totals,
      soraStoredValue: covered.quote.storedValue,
    });
  } finally {
    writeEvidence(
      "SHIPPING_TENDERS_ARTIFACT_DIR",
      "shipping-tenders",
      evidence,
    );
    backend.close();
  }
}

/** A guest buyer who ships two boxes of cookies to Singapore. */
class ShippingBuyer {
  readonly #client: CommerceStorefrontClient;
  readonly #name: string;
  readonly #token: string;

  private constructor(
    client: CommerceStorefrontClient,
    name: string,
    token: string,
  ) {
    this.#client = client;
    this.#name = name;
    this.#token = token;
  }

  static async start(
    client: CommerceStorefrontClient,
    name: string,
  ): Promise<ShippingBuyer> {
    const session = await required(
      client.createSession(merchantId, SHOP, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    return new ShippingBuyer(client, name, session.token);
  }

  async quote(
    codes: Readonly<{
      discountCodes?: readonly string[];
      giftCardCodes?: readonly string[];
    }>,
  ): Promise<CommerceBuyerQuotedShippingCheckoutV1> {
    const catalog = await required(
      this.#client.readCatalog(merchantId, SHOP, this.#token),
    );
    const listing = catalog.listings.find(
      (item) => item.availability === "available",
    );
    const service =
      catalog.storefront.fulfillment === "shipping"
        ? catalog.storefront.shippingServices.find(
            (item) =>
              item.destinationCountry === "SG" &&
              item.availability.state === "available",
          )
        : undefined;
    if (listing === undefined || service === undefined)
      throw new Error("The shipping storefront sells nothing to Singapore");
    const cart = await required(
      this.#client.createCart(merchantId, SHOP, this.#token, {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: `${this.#name}_cart`,
        lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 2 }],
      }),
    );
    const validation = await required(
      this.#client.validateShippingAddress(merchantId, SHOP, this.#token, {
        schemaVersion: "underclerk.validate-buyer-shipping-address.v1",
        idempotencyKey: `${this.#name}_address`,
        address: {
          countryCode: "SG",
          recipientName: "Rio Tan",
          addressLine1: "1 Raffles Quay",
          locality: "Singapore",
          postalCode: "018956",
        },
      }),
    );
    if (validation.state !== "accepted")
      throw new Error("The Singapore address was not accepted");
    return required(
      this.#client.createShippingCheckout(merchantId, SHOP, this.#token, {
        schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
        idempotencyKey: `${this.#name}_checkout`,
        cartId: cart.cartId,
        cartRevision: cart.revision,
        buyer: {
          kind: "guest",
          contact: { kind: "email", email: `${this.#name}@example.test` },
        },
        shippingServiceCode: service.service.code,
        shippingDestination: {
          kind: "provided_address",
          address: validation.address,
          acceptance: {
            kind: "accepted_as_entered",
            addressValidationReference: validation.validationReference,
          },
        },
        ...codes,
      }),
    );
  }

  async pay(checkout: CommerceBuyerQuotedShippingCheckoutV1) {
    const key = `${this.#name}_payment`;
    const session = await required(
      this.#client.createPaymentSession(
        merchantId,
        SHOP,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "underclerk.create-buyer-payment-session.v1",
          idempotencyKey: key,
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          returnUrl: "https://underclerk.test/store/cookies",
        },
      ),
    );
    if (session.state !== "ready")
      throw new Error(`${this.#name} payment is not ready`);
    return required(
      this.#client.reconcilePayment(
        merchantId,
        SHOP,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "underclerk.reconcile-buyer-payment.v1",
          idempotencyKey: key,
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          confirmation: { kind: "provider_ui_completed" },
        },
      ),
    );
  }

  placeStoredValue(checkout: CommerceBuyerQuotedShippingCheckoutV1) {
    return this.#client.placeStoredValueCheckout(
      merchantId,
      SHOP,
      checkout.checkoutId,
      this.#token,
      {
        schemaVersion: "underclerk.place-buyer-stored-value-checkout.v1",
        idempotencyKey: `${this.#name}_stored_value`,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
      },
    );
  }
}

class ShippingDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "shipping_tenders");
  }

  async createDiscount(discountId: string, code: string, basisPoints: number) {
    await this.apply(
      this.admin.createDiscount({
        ...this.editBase(`create_${discountId}`),
        discountId,
        title: code,
        method: { kind: "code", codes: [code] },
        rule: {
          kind: "amount_off_order",
          value: { kind: "percentage", basisPoints },
        },
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

  async issueGiftCard(accountId: string, code: string, amountMinor: number) {
    await this.apply(
      this.admin.issueGiftCard({
        ...this.editBase(`issue_${accountId}`),
        accountId,
        code,
        amount: jpy(amountMinor),
        expiresAt: null,
        note: null,
      }),
    );
  }

  async payments(orderId: string) {
    return (await this.snapshot()).payments
      .filter((payment) => payment.orderId === orderId)
      .sort(
        (left, right) => left.amount.amountMinor - right.amount.amountMinor,
      );
  }

  async giftCardBalance(accountId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.id === accountId);
    if (account === undefined) throw new Error(`${accountId} is missing`);
    return account.balance;
  }

  async splitRefund(orderId: string, amountMinor: number) {
    const lineId = await this.lineId(orderId);
    return required(
      this.admin.refundOrderTenders({
        merchantId,
        idempotencyKey: `split_${orderId}`,
        orderId,
        refundId: `refund_split_${orderId.slice(-8)}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amountMinor),
        allocation: {
          lineAllocations: [{ orderLineId: lineId, amount: jpy(amountMinor) }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Crushed in transit",
      }),
    );
  }
}
