// Plan 76A step 3, saved addresses at checkout: Ana signs in on the shipping
// storefront, saves a Singapore address, a Japanese address without a
// prefecture and an address with doubled spaces, and checks out to the
// Singapore one by its reference without typing it. The quote carries an
// address validation of its own and the order is placed. The address that
// cannot be shipped to and the one that needs a correction are refused, as
// are another customer's reference, a guest's use of a reference, and a
// reference after the customer is erased.
// A second journey follows Ana's order: she gets one email when it ships,
// with the tracking number, however many carrier scans follow, and one for
// each refund, with its amount.
// Set SAVED_ADDRESS_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceBuyerCatalogV1,
  CommerceCustomerAddressInputV1,
  CommerceStorefrontClient,
} from "@seams/commerce-client";
import type { ShippingRouteBinding } from "@seams/commerce-contracts";

import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";

const SHOP = "storefront_cookie_store_sg";

const SINGAPORE: CommerceCustomerAddressInputV1 = {
  recipient: "Ana Lim",
  line1: "1 Raffles Place",
  line2: "#20-01",
  locality: "Singapore",
  region: null,
  postalCode: "048616",
  countryCode: "SG",
};

it(
  "checks out to a saved address after validating it, and refuses what it cannot ship to",
  { timeout: 60_000 },
  savedAddressCheckout,
);

async function savedAddressCheckout(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { buyer, admin, emails, fetch } = backend;
    const anaAccess = await signIn(buyer, emails, "ana@example.test");
    for (const address of [
      SINGAPORE,
      { ...SINGAPORE, countryCode: "JP", locality: "Chiyoda-ku", postalCode: "100-0005" },
      { ...SINGAPORE, line1: "1  Raffles  Place" },
    ])
      await required(
        buyer.saveCustomerAddress(merchantId, SHOP, anaAccess, {
          schemaVersion: "underclerk.save-customer-address.v1",
          address,
        }),
      );
    const saved = await required(buyer.readCustomer(merchantId, SHOP, anaAccess));
    expect(saved.addresses.map((address) => address.addressId)).toEqual([
      "address_1",
      "address_2",
      "address_3",
    ]);

    // Ana checks out to her Singapore address by its reference.
    const ana = await ShippingBuyer.signedIn(buyer, "ana", anaAccess);
    const quoted = await ana.checkout("address_1");
    if (!quoted.ok) throw new Error(JSON.stringify(quoted.error));
    expect(quoted.value.quote.shipping).toMatchObject({
      destinationCountry: "SG",
      addressValidationReference: expect.stringMatching(/\S/),
    });
    const placed = await ana.pay(quoted.value);
    expect(placed).toMatchObject({ state: "placed" });

    // What cannot be shipped to, or needs a correction, is typed again.
    const refusals = {
      noPrefecture: await ana.checkoutStatus("address_2"),
      needsCorrection: await ana.checkoutStatus("address_3"),
      unknown: await ana.checkoutStatus("address_9"),
    };
    // Bo has no addresses: Ana's reference means nothing in his account.
    const bo = await ShippingBuyer.signedIn(
      buyer,
      "bo",
      await signIn(buyer, emails, "bo@example.test"),
    );
    const otherCustomer = await bo.checkoutStatus("address_1");
    // A guest session cannot name a saved address. The client refuses to
    // send it, so the request goes as a browser could send it.
    const guestUse = await guestSavedAddressStatus(buyer, fetch);
    // After erasure, Ana's open session reaches no saved address.
    if (placed.state !== "placed") throw new Error("Ana's order was not placed");
    const resources = (await required(admin.readSnapshot(merchantId))).resources;
    const order = resources.orders.find((item) => item.id === placed.orderId);
    if (order?.buyer.kind !== "identified") throw new Error("Ana's order has no customer");
    const customer = await required(admin.readCustomer(merchantId, order.buyer.customerReference));
    expect(
      await required(
        admin.eraseCustomer({
          merchantId,
          idempotencyKey: "erase_ana",
          customerId: customer.id,
          expectedRevision: customer.revision,
          reason: "Customer asked to be forgotten",
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    const erased = await ana.checkoutStatus("address_1");
    expect({ ...refusals, otherCustomer, guestUse, erased }).toEqual({
      noPrefecture: 409,
      needsCorrection: 409,
      unknown: 409,
      otherCustomer: 409,
      guestUse: 400,
      erased: 409,
    });

    Object.assign(evidence, {
      addresses: saved.addresses.map((address) => address.addressId),
      quote: {
        totals: quoted.value.quote.totals,
        destinationCountry: quoted.value.quote.shipping.destinationCountry,
        service: quoted.value.quote.shipping.service,
      },
      placed: { state: placed.state },
      refusals: { ...refusals, otherCustomer, guestUse, erased },
    });
  } finally {
    writeEvidence("SAVED_ADDRESS_ARTIFACT_DIR", "saved-addresses", evidence);
    backend.close();
  }
}

it(
  "emails the buyer once when the order ships and once for each refund",
  { timeout: 60_000 },
  shippedAndRefundedEmails,
);

async function shippedAndRefundedEmails(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { buyer, admin, emails } = backend;
    const access = await signIn(buyer, emails, "ana@example.test");
    await required(
      buyer.saveCustomerAddress(merchantId, SHOP, access, {
        schemaVersion: "underclerk.save-customer-address.v1",
        address: SINGAPORE,
      }),
    );
    const ana = await ShippingBuyer.signedIn(buyer, "ana", access);
    const quoted = await ana.checkout("address_1");
    if (!quoted.ok) throw new Error(JSON.stringify(quoted.error));
    const placed = await ana.pay(quoted.value);
    if (placed.state !== "placed" || placed.shipmentId === undefined)
      throw new Error("Ana's shipping order was not placed");
    const desk = new ShippingDesk(admin);
    const tracking = await desk.shipAndScan(placed.shipmentId);
    // A refund of 500 of the line, and later 200 more.
    await desk.refund(placed.orderId, 500, "first");
    await desk.refund(placed.orderId, 200, "second");
    // Sign-in codes are random; the rest is what Ana reads.
    const mail = emails.sent
      .filter((message) => message.subject !== "Your sign-in code")
      .map((message) => [message.subject, message.text]);
    const currency = placed.total.currency;
    expect(mail).toEqual([
      ["Order confirmed", `Your order ${placed.orderId} is confirmed. Total: ${placed.total.amountMinor} ${currency}.`],
      ["Your order is on its way", `Your order ${placed.orderId} has shipped. Tracking number: ${tracking}.`],
      ["Your refund", `We refunded 500 ${currency} for your order ${placed.orderId}.`],
      ["Your refund", `We refunded 200 ${currency} for your order ${placed.orderId}.`],
    ]);
    Object.assign(evidence, { mail });
  } finally {
    writeEvidence("SAVED_ADDRESS_ARTIFACT_DIR", "customer-emails", evidence);
    backend.close();
  }
}

/** Staff on the shipping side: label, carrier scans and refunds. */
class ShippingDesk {
  readonly #admin: CommerceAdminClient;
  #step = 0;

  constructor(admin: CommerceAdminClient) {
    this.#admin = admin;
  }

  async #snapshot() {
    return required(this.#admin.readSnapshot(merchantId));
  }

  #key(name: string): string {
    return `desk_${name}_${(this.#step += 1)}`;
  }

  /** Buys a label, then reports two carrier scans; returns the tracking number. */
  async shipAndScan(shipmentId: string): Promise<string> {
    const before = await this.#snapshot();
    const shipment = before.resources.shipments.find((item) => item.id === shipmentId);
    if (shipment === undefined) throw new Error(`${shipmentId} is missing`);
    const rate = await required(
      this.#admin.quoteShipmentLabelRate({
        merchantId,
        idempotencyKey: this.#key("rate"),
        shipmentId,
        shipmentRevision: shipment.revision,
      }),
    );
    if (rate.outcome !== "quoted") throw new Error(JSON.stringify(rate));
    const key = this.#key("label");
    await required(
      this.#admin.purchaseShippingLabel({
        merchantId,
        expectedMerchantRevision: before.merchantRevision,
        idempotencyKey: key,
        shipmentId,
        shipmentRevision: shipment.revision,
        labelRateId: rate.rate.labelRateId,
        labelAttemptId: `${key}_attempt`,
      }),
    );
    for (const [state, at] of [
      ["in_transit", "2026-08-14T10:20:00.000Z"],
      ["delivered", "2026-08-15T09:00:00.000Z"],
    ] as const) {
      const current = await this.#snapshot();
      const labeled = current.resources.shipments.find((item) => item.id === shipmentId);
      const fulfillment = current.resources.fulfillments.find(
        (item) => item.id === labeled?.fulfillmentId,
      );
      if (
        labeled?.kind !== "first_party" ||
        fulfillment?.kind !== "shipping" ||
        fulfillment.binding.kind !== "first_party_checkout"
      )
        throw new Error(`${shipmentId} has no first-party route`);
      const routeBinding: ShippingRouteBinding =
        fulfillment.binding.acceptedShippingQuote.routeBinding;
      const event = {
        state,
        providerEventId: `desk_${state}`,
        occurredAt: at,
        location: state === "in_transit" ? "Tokyo" : "Singapore",
      };
      const scanKey = this.#key(state);
      const result = await required(
        this.#admin.recordShippingTracking({
          merchantId,
          expectedMerchantRevision: current.merchantRevision,
          idempotencyKey: scanKey,
          shipmentId,
          shipmentRevision: labeled.revision,
          event: {
            ...event,
            signature: createJapanShippingGateway("catalog-editing-carrier-key").signTrackingEvent({
              routeBinding,
              serviceCode: fulfillment.binding.acceptedShippingQuote.carrierRate.service.code,
              shipmentId,
              ...event,
            }),
          },
        }),
      );
      if (result.outcome !== "applied") throw new Error(JSON.stringify(result));
    }
    const shipped = (await this.#snapshot()).resources.shipments.find(
      (item) => item.id === shipmentId,
    );
    if (shipped?.kind !== "first_party" || !("trackingNumber" in shipped.lifecycle))
      throw new Error(`${shipmentId} has no tracking number`);
    return shipped.lifecycle.trackingNumber;
  }

  async refund(orderId: string, lineMinor: number, name: string): Promise<void> {
    const snapshot = await this.#snapshot();
    const order = snapshot.resources.orders.find((item) => item.id === orderId);
    const payment = snapshot.resources.payments.find((item) => item.orderId === orderId);
    const line = order?.lineItems[0];
    if (order === undefined || payment === undefined || line === undefined)
      throw new Error(`${orderId} is incomplete`);
    const currency = order.totals.total.currency;
    const key = this.#key(`refund_${name}`);
    const result = await required(
      this.#admin.refundOrder({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: key,
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_${name}`,
        refundPolicyId: "refund_policy_standard",
        amount: { amountMinor: lineMinor, currency },
        allocation: {
          lineAllocations: [{ orderLineId: line.id, amount: { amountMinor: lineMinor, currency } }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: { amountMinor: 0, currency },
        },
        reason: "A box arrived damaged",
      }),
    );
    if (result.outcome !== "applied") throw new Error(JSON.stringify(result));
  }
}

async function signIn(
  buyer: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
): Promise<string> {
  const challenge = await required(
    buyer.requestCustomerSignIn(merchantId, SHOP, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const code = /\b(\d{6})\b/.exec(emails.sent.at(-1)?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  return (
    await required(
      buyer.verifyCustomerSignIn(merchantId, SHOP, challenge.challengeId, {
        schemaVersion: "underclerk.verify-customer-sign-in.v1",
        code,
      }),
    )
  ).customerAccessToken;
}

async function guestSavedAddressStatus(
  buyer: CommerceStorefrontClient,
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<number> {
  const session = await required(
    buyer.createSession(merchantId, SHOP, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const catalog = await required(buyer.readCatalog(merchantId, SHOP, session.token));
  const listing = catalog.listings.find((item) => item.availability === "available");
  if (listing === undefined) throw new Error("The shipping storefront sells nothing");
  const cart = await required(
    buyer.createCart(merchantId, SHOP, session.token, {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: "guest_cart",
      lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 1 }],
    }),
  );
  const response = await fetch(
    `${BASE_URL}/v1/public/merchants/${merchantId}/storefronts/${SHOP}/checkouts`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
        idempotencyKey: "guest_checkout",
        cartId: cart.cartId,
        cartRevision: cart.revision,
        buyer: { kind: "guest", contact: { kind: "email", email: "guest@example.test" } },
        shippingServiceCode: "any",
        shippingDestination: { kind: "saved_address", savedAddressReference: "address_1" },
      }),
    },
  );
  return response.status;
}

/** A signed-in buyer on the shipping storefront. */
class ShippingBuyer {
  readonly #client: CommerceStorefrontClient;
  readonly #name: string;
  readonly #token: string;
  readonly #catalog: CommerceBuyerCatalogV1;
  #step = 0;

  private constructor(
    client: CommerceStorefrontClient,
    name: string,
    token: string,
    catalog: CommerceBuyerCatalogV1,
  ) {
    this.#client = client;
    this.#name = name;
    this.#token = token;
    this.#catalog = catalog;
  }

  static async signedIn(
    client: CommerceStorefrontClient,
    name: string,
    customerAccessToken: string,
  ): Promise<ShippingBuyer> {
    const session = await required(
      client.createSession(merchantId, SHOP, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "identified_customer", customerAccessToken },
      }),
    );
    const catalog = await required(client.readCatalog(merchantId, SHOP, session.token));
    return new ShippingBuyer(client, name, session.token, catalog);
  }

  async checkout(savedAddressReference: string) {
    const listing = this.#catalog.listings.find((item) => item.availability === "available");
    const service =
      this.#catalog.storefront.fulfillment === "shipping"
        ? this.#catalog.storefront.shippingServices.find(
            (item) => item.destinationCountry === "SG" && item.availability.state === "available",
          )
        : undefined;
    if (listing === undefined || service === undefined)
      throw new Error("The shipping storefront sells nothing to Singapore");
    const step = (this.#step += 1);
    const cart = await required(
      this.#client.createCart(merchantId, SHOP, this.#token, {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: `${this.#name}_cart_${step}`,
        lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 1 }],
      }),
    );
    return this.#client.createShippingCheckout(merchantId, SHOP, this.#token, {
      schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
      idempotencyKey: `${this.#name}_checkout_${step}`,
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: { kind: "identified_customer" },
      shippingServiceCode: service.service.code,
      shippingDestination: { kind: "saved_address", savedAddressReference },
    });
  }

  async checkoutStatus(savedAddressReference: string): Promise<number | "quoted"> {
    const result = await this.checkout(savedAddressReference);
    if (result.ok) return "quoted";
    return result.error.kind === "http" ? result.error.status : 0;
  }

  async pay(checkout: Readonly<{ checkoutId: string; revision: number; quote: { quoteDigest: string } }>) {
    const key = `${this.#name}_payment_${checkout.revision}`;
    const session = await required(
      this.#client.createPaymentSession(merchantId, SHOP, checkout.checkoutId, this.#token, {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: key,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: "https://underclerk.test/store/cookies",
      }),
    );
    if (session.state !== "ready") throw new Error(`${this.#name} payment is not ready`);
    return required(
      this.#client.reconcilePayment(merchantId, SHOP, checkout.checkoutId, this.#token, {
        schemaVersion: "underclerk.reconcile-buyer-payment.v1",
        idempotencyKey: key,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        confirmation: { kind: "provider_ui_completed" },
      }),
    );
  }
}
