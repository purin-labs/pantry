import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type {
  CommerceBuyerOrderV1,
  CommerceBuyerPaymentDisputeStatusV1,
  CommerceBuyerQuotedShippingCheckoutV1,
  CommerceBuyerSessionV4,
} from "@seams/commerce-client";
import { parseCommerceBuyerSessionV4 } from "@seams/commerce-client";

import {
  parseStoredCheckoutRecovery,
  normalizedBuyerContact,
  orderNeedsPolling,
  orderTimelineWithPaymentReview,
  paymentReviewPresentation,
  profileAllowsFulfillment,
  ShippingQuoteEvidence,
  StorefrontApp,
  storefrontConfiguration,
} from "../src/storefront.tsx";
import { isRecord } from "@seams/std";

const SESSION_TOKEN = "buyer_session_recovery_token";
const OPERATION_ID = "storefront_recovery_operation";
const CART_ID = "cart_recovered";
const CHECKOUT_ID = "checkout_recovered";
const capturedRequests: Request[] = [];
let cartLifecycle: "active" | "submitted" = "active";
let checkoutHasExtraField = false;
let checkoutProgress: Readonly<Record<string, unknown>> = { state: "quoted" };
let checkoutExpiresAt = "2020-08-29T10:00:00.000Z";
const CHECKOUT_PROFILE_CONFIGURATION = {
  currencyPolicy: { kind: "fixed", currency: "JPY" },
  buyerPolicy: {
    kind: "guest_or_account",
    requiredContact: "email_required_phone_optional",
    savedAddressPolicy: "enabled",
  },
  cartPolicy: {
    kind: "single_fulfillment",
    minimumLines: 1,
    maximumLines: 50,
    maximumTotalQuantity: 100,
  },
  pricingPolicy: {
    kind: "published_offers",
    salesChannelId: "sales_channel_cafe",
  },
  fulfillmentPolicy: {
    kind: "buyer_choice",
    pickupPolicyId: "pickup_policy_cafe",
    shippingPolicyId: "shipping_policy_domestic",
  },
  taxPolicy: {
    kind: "merchant_inclusive",
    jurisdictionPolicyId: "tax_policy_jp",
  },
  paymentPolicy: {
    kind: "external_provider",
    paymentProviderBindingId: "payment_binding_stripe",
  },
  afterSalePolicy: {
    cancellationPolicyId: "cancellation_policy_standard",
    refundPolicyId: "refund_policy_standard",
    refundGovernance: { kind: "approval_required" },
  },
  presentationPolicy: {
    locale: "en-JP",
    merchantDisplayName: "Cafe",
    termsPolicyId: "terms_policy_cafe",
    privacyPolicyId: "privacy_policy_cafe",
    supportContact: "support@example.com",
  },
} as const;

it.each([
  ["email_required", { kind: "email", email: "buyer@example.test" }],
  [
    "email_required_phone_optional",
    {
      kind: "email_and_phone",
      email: "buyer@example.test",
      phone: "+819012345678",
    },
  ],
  [
    "email_and_phone_required",
    {
      kind: "email_and_phone",
      email: "buyer@example.test",
      phone: "+819012345678",
    },
  ],
] as const)("posts the contact union for %s", (policy, expected) => {
  expect(
    normalizedBuyerContact(
      { email: " buyer@example.test ", phone: " +819012345678 " },
      policy,
    ),
  ).toEqual(expected);
});

it("omits the phone branch when optional contact is left blank", () => {
  expect(
    normalizedBuyerContact(
      { email: "buyer@example.test", phone: " " },
      "email_required_phone_optional",
    ),
  ).toEqual({ kind: "email", email: "buyer@example.test" });
});

it("suppresses a phone value when the active profile only requires email", () => {
  expect(
    normalizedBuyerContact(
      { email: "buyer@example.test", phone: "+819012345678" },
      "email_required",
    ),
  ).toEqual({ kind: "email", email: "buyer@example.test" });
});

it("allows buyer-choice profiles to match either static storefront fulfillment", () => {
  const session = parseSession({
    fulfillmentPolicy: CHECKOUT_PROFILE_CONFIGURATION.fulfillmentPolicy,
  });
  expect(profileAllowsFulfillment(session, "pickup")).toBe(true);
  expect(profileAllowsFulfillment(session, "shipping")).toBe(true);
  const shippingOnly = parseSession({
    fulfillmentPolicy: {
      kind: "shipping_only",
      shippingPolicyId: "shipping_policy_domestic",
    },
  });
  expect(profileAllowsFulfillment(shippingOnly, "pickup")).toBe(false);
});

it("fails closed when a recovered profile disallows the static fulfillment", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify({
      ...storedCheckout(),
      session: {
        ...sessionRecord(),
        checkoutProfileConfiguration: {
          ...CHECKOUT_PROFILE_CONFIGURATION,
          fulfillmentPolicy: {
            kind: "shipping_only",
            shippingPolicyId: "shipping_policy_domestic",
          },
        },
      },
    }),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  try {
    const app = new StorefrontApp({ config });
    await expect(app.recoverBuyerContext(config)).resolves.toMatchObject({
      kind: "failed",
      message:
        "This checkout profile does not allow this storefront's fulfillment.",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("uses the active profile display name and locale for the shell", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const documentElement = { lang: "" };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://storefront.test" } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement, title: "" },
  });
  try {
    const app = new StorefrontApp({
      config: storefrontConfiguration("/store"),
    });
    const session = parseCommerceBuyerSessionV4({
      ...sessionRecord(),
      checkoutProfileConfiguration: {
        ...CHECKOUT_PROFILE_CONFIGURATION,
        presentationPolicy: {
          ...CHECKOUT_PROFILE_CONFIGURATION.presentationPolicy,
          locale: "ja-JP",
          merchantDisplayName: "Profile Café",
        },
      },
    });
    app.applySessionPresentation(session);
    expect(documentElement.lang).toBe("ja-JP");
    expect(globalThis.document.title).toBe("Profile Café · Seams Checkout");
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

it("renders domestic quote evidence with explicit duty and customs status", () => {
  const markup = renderToStaticMarkup(
    <ShippingQuoteEvidence quote={shippingQuote("JP")} />,
  );
  expect(markup).toContain("N/A (domestic delivery)");
  expect(markup).toContain("None required for domestic delivery.");
  expect(markup).toContain("address-validation-jp");
  expect(markup).toContain("package-jp");
});

it("renders Singapore export quote evidence with duty, customs, and allocation references", () => {
  const markup = renderToStaticMarkup(
    <ShippingQuoteEvidence quote={shippingQuote("SG")} />,
  );
  expect(markup).toContain("duty-quote-sg");
  expect(markup).toContain("DDP");
  expect(markup).toContain("HS 190531");
  expect(markup).toContain("rate-sg");
  expect(markup).toContain("tax-sg");
});

it.each([
  {
    dispute: activePaymentDispute("action_required"),
    language: "en",
    expected: {
      title: "Payment review in progress",
      detail: "Your payment review is in progress.",
      nextAction:
        "Keep checking this page while the payment review is in progress.",
      timeline: "Payment review in progress",
      active: true,
    },
  },
  {
    dispute: activePaymentDispute("under_review"),
    language: "ja",
    expected: {
      title: "お支払いを確認しています",
      detail: "お支払いの確認を進めています。",
      nextAction: "お支払いの確認が完了するまで、この画面をご確認ください。",
      timeline: "お支払いを確認中",
      active: true,
    },
  },
  {
    dispute: terminalPaymentDispute("won"),
    language: "en",
    expected: {
      title: "Payment review complete",
      detail: "The payment review is complete.",
      nextAction: "The payment review is complete. No action is needed.",
      timeline: "Payment review complete",
      active: false,
    },
  },
  {
    dispute: terminalPaymentDispute("lost"),
    language: "ja",
    expected: {
      title: "お支払いの確認が完了しました",
      detail: "お支払いの確認が完了しました。",
      nextAction: "お支払いの確認は完了しています。お手続きはありません。",
      timeline: "お支払いの確認完了",
      active: false,
    },
  },
] as const satisfies readonly Readonly<{
  dispute: CommerceBuyerPaymentDisputeStatusV1;
  language: "en" | "ja";
  expected: Readonly<{
    title: string;
    detail: string;
    nextAction: string;
    timeline: string;
    active: boolean;
  }>;
}>[])(
  "presents $dispute.state payment reviews in $language",
  ({ dispute, language, expected }) => {
    const presentation = paymentReviewPresentation([dispute], language);
    expect(presentation).toMatchObject({
      title: expected.title,
      detail: expected.detail,
      nextAction: expected.nextAction,
      active: expected.active,
    });
    expect(presentation?.timeline.find(timelineItemIsCurrent)?.label).toBe(
      expected.timeline,
    );
  },
);

it("aggregates multiple payment reviews without selecting an identity", () => {
  const active = paymentReviewPresentation(
    [
      activePaymentDispute("action_required", "dispute_z"),
      activePaymentDispute("under_review", "dispute_a"),
      terminalPaymentDispute("lost", "dispute_m"),
    ],
    "en",
  );
  expect(active).toMatchObject({
    title: "Payment reviews in progress",
    detail: "3 payment reviews: 2 in progress, 1 complete.",
    nextAction:
      "Keep checking this page while payment reviews are in progress.",
    active: true,
  });

  const terminal = paymentReviewPresentation(
    [
      terminalPaymentDispute("won", "dispute_z"),
      terminalPaymentDispute("lost", "dispute_a"),
    ],
    "ja",
  );
  expect(terminal).toMatchObject({
    title: "お支払いの確認が完了しました",
    detail: "お支払いの確認は2件すべて完了しました。",
    nextAction: "お支払いの確認は完了しています。お手続きはありません。",
    active: false,
  });
});

it("leaves the order presentation unchanged when there are no payment reviews", () => {
  expect(paymentReviewPresentation([], "en")).toBeUndefined();
});

it("keeps active payment reviews polling after fulfillment completes", () => {
  const active = [activePaymentDispute("under_review")];
  const terminal = [terminalPaymentDispute("won")];
  expect(orderNeedsPolling(pickupCompletedOrder(active))).toBe(true);
  expect(orderNeedsPolling(pickupCompletedOrder(terminal))).toBe(false);
  expect(orderNeedsPolling(shippingDeliveredOrder(active))).toBe(true);
  expect(orderNeedsPolling(shippingDeliveredOrder(terminal))).toBe(false);
});

function activePaymentDispute(
  state: "action_required" | "under_review",
  disputeId = `dispute_${state}`,
): CommerceBuyerPaymentDisputeStatusV1 {
  switch (state) {
    case "action_required":
      return {
        disputeId,
        amount: { amountMinor: 495, currency: "JPY" },
        state,
        observedAt: "2099-10-01T10:00:00.000Z",
      };
    case "under_review":
      return {
        disputeId,
        amount: { amountMinor: 495, currency: "JPY" },
        state,
        observedAt: "2099-10-01T10:01:00.000Z",
      };
  }
}

function terminalPaymentDispute(
  state: "won" | "lost",
  disputeId = `dispute_${state}`,
): CommerceBuyerPaymentDisputeStatusV1 {
  switch (state) {
    case "won":
      return {
        disputeId,
        amount: { amountMinor: 495, currency: "JPY" },
        state,
        resolvedAt: "2099-10-01T10:02:00.000Z",
      };
    case "lost":
      return {
        disputeId,
        amount: { amountMinor: 495, currency: "JPY" },
        state,
        resolvedAt: "2099-10-01T10:03:00.000Z",
      };
  }
}

function pickupCompletedOrder(
  paymentDisputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): Extract<
  CommerceBuyerOrderV1,
  { fulfillment: "pickup"; state: "completed" }
> {
  return {
    schemaVersion: "underclerk.buyer-order.v1",
    checkoutId: "checkout_storefront_test",
    orderId: "order_storefront_test",
    paymentId: "payment_storefront_test",
    fulfillmentId: "fulfillment_storefront_test",
    placedAt: "2099-10-01T09:00:00.000Z",
    total: { amountMinor: 495, currency: "JPY" },
    paymentDisputes,
    fulfillment: "pickup",
    pickup: {
      locationId: "location_storefront_test",
      expectedBy: "2099-10-01T09:15:00.000Z",
    },
    state: "completed",
    completedAt: "2099-10-01T09:15:00.000Z",
  };
}

function shippingDeliveredOrder(
  paymentDisputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): Extract<
  CommerceBuyerOrderV1,
  { fulfillment: "shipping"; state: "delivered" }
> {
  return {
    schemaVersion: "underclerk.buyer-order.v1",
    checkoutId: "checkout_storefront_test",
    orderId: "order_storefront_test",
    paymentId: "payment_storefront_test",
    fulfillmentId: "fulfillment_storefront_test",
    placedAt: "2099-10-01T09:00:00.000Z",
    total: { amountMinor: 495, currency: "JPY" },
    paymentDisputes,
    fulfillment: "shipping",
    shipmentId: "shipment_storefront_test",
    shipping: {
      destinationCountry: "SG",
      estimatedDelivery: {
        kind: "window",
        earliest: "2099-10-03T09:00:00.000Z",
        latest: "2099-10-05T09:00:00.000Z",
      },
    },
    state: "delivered",
    trackingNumber: "tracking_storefront_test",
    handedOverAt: "2099-10-02T09:00:00.000Z",
    deliveredAt: "2099-10-03T09:00:00.000Z",
  };
}

it("recovers and replaces the latest active Cart revision after reload", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify(storedCheckout()),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  capturedRequests.length = 0;
  cartLifecycle = "active";
  try {
    const app = new StorefrontApp({ config });
    const recovered = await app.recoverBuyerContext(config);
    expect(recovered).toMatchObject({
      kind: "recovered",
      context: {
        session: { token: SESSION_TOKEN },
        runId: OPERATION_ID,
        cart: {
          kind: "active",
          cart: { cartId: CART_ID, revision: 4, state: "active" },
        },
      },
    });
    expect(capturedRequests.map(requestSummary)).toEqual([
      "GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/catalog",
      `GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/carts/${CART_ID}`,
    ]);
    expect(capturedRequests.every(hasRecoveredSessionAuthorization)).toBe(true);
    expect(
      JSON.parse(
        storage.getItem(`satyr.checkout.${config.storefrontId}`) ?? "null",
      ),
    ).toMatchObject({
      schemaVersion: "satyr.storefront-checkout-session.v7",
      session: { token: SESSION_TOKEN },
      operationId: OPERATION_ID,
      cart: { kind: "active", cartId: CART_ID, revision: 4 },
    });
    if (recovered.kind !== "recovered")
      throw new Error("Checkout session was not recovered");
    const prepared = await app.prepareBuyerCart(recovered.context, [
      {
        kind: "catalog",
        variantId: "variant_cookie",
        quantity: 2,
      },
    ]);
    expect(prepared).toMatchObject({
      ok: true,
      cart: {
        cartId: CART_ID,
        revision: 5,
        state: "active",
        lines: [{ quantity: 2 }],
      },
    });
    const replaceRequest = capturedRequests.at(-1);
    expect(replaceRequest).toBeDefined();
    expect(replaceRequest?.method).toBe("PUT");
    await expect(replaceRequest?.clone().json()).resolves.toMatchObject({
      schemaVersion: "underclerk.replace-buyer-cart.v1",
      cartRevision: 4,
      lines: [{ kind: "catalog", variantId: "variant_cookie", quantity: 2 }],
    });
    expect(
      JSON.parse(
        storage.getItem(`satyr.checkout.${config.storefrontId}`) ?? "null",
      ),
    ).toMatchObject({ cart: { kind: "active", cartId: CART_ID, revision: 5 } });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("recovers and submits the buyer-selected shipping service", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store/shipping");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify(storedShippingCheckout()),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store/shipping",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = shippingRecoveryFetch;
  capturedRequests.length = 0;
  try {
    const app = new StorefrontApp({ config });
    const recovered = await app.recoverBuyerContext(config);
    if (
      recovered.kind !== "recovered" ||
      recovered.context.basket.kind !== "shipping"
    ) {
      throw new Error("Shipping checkout session was not recovered");
    }
    expect(recovered.context.basket.shippingServiceCode).toBe(
      "international_parcel_air_test",
    );
    expect(recovered.context.basket.items).toEqual([
      { variantId: "variant_cookie", quantity: 1 },
      { variantId: "variant_matcha", quantity: 2 },
    ]);
    expect(recovered.context.basket.address).toEqual({
      countryCode: "SG",
      recipientName: "Nuki Buyer",
      addressLine1: "1 Raffles Quay",
      locality: "Singapore",
      postalCode: "018956",
    });
    expect(
      JSON.parse(
        storage.getItem(`satyr.checkout.${config.storefrontId}`) ?? "null",
      ),
    ).toMatchObject({
      schemaVersion: "satyr.storefront-checkout-session.v7",
      basket: {
        items: [
          { variantId: "variant_cookie", quantity: 1 },
          { variantId: "variant_matcha", quantity: 2 },
        ],
        shippingServiceCode: "international_parcel_air_test",
      },
    });
    await app.submitShippingQuote(
      recovered.context,
      OPERATION_ID,
      {
        countryCode: "SG",
        recipientName: "Nuki Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
      {
        kind: "accepted_as_entered",
        addressValidationReference: "address_validation_sg_1",
      },
    );
    const replaceRequest = capturedRequests.find(isCartReplaceRequest);
    expect(replaceRequest).toBeDefined();
    await expect(replaceRequest?.clone().json()).resolves.toMatchObject({
      schemaVersion: "underclerk.replace-buyer-cart.v1",
      cartRevision: 4,
      lines: [
        { kind: "catalog", variantId: "variant_cookie", quantity: 1 },
        { kind: "catalog", variantId: "variant_matcha", quantity: 2 },
      ],
    });
    const checkoutRequest = capturedRequests.find(isShippingCheckoutRequest);
    expect(checkoutRequest).toBeDefined();
    await expect(checkoutRequest?.clone().json()).resolves.toMatchObject({
      schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
      cartId: CART_ID,
      cartRevision: 5,
      shippingServiceCode: "international_parcel_air_test",
    });
    if (checkoutRequest === undefined)
      throw new Error("Shipping checkout request was not captured");
    const checkoutBody: unknown = await checkoutRequest.clone().json();
    expect(checkoutBody).toMatchObject({
      shippingDestination: {
        kind: "provided_address",
        address: {
          countryCode: "SG",
          recipientName: "Nuki Buyer",
          addressLine1: "1 Raffles Quay",
          locality: "Singapore",
          postalCode: "018956",
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("recovers a Japan destination and sends every selected shipping line and address field", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store/shipping");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify(storedJapanShippingCheckout()),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store/shipping",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = shippingRecoveryFetch;
  capturedRequests.length = 0;
  try {
    const app = new StorefrontApp({ config });
    const recovered = await app.recoverBuyerContext(config);
    if (
      recovered.kind !== "recovered" ||
      recovered.context.basket.kind !== "shipping"
    ) {
      throw new Error("Japan shipping checkout session was not recovered");
    }
    expect(recovered.context.basket).toMatchObject({
      shippingServiceCode: "domestic_parcel_test",
      items: [
        { variantId: "variant_cookie", quantity: 1 },
        { variantId: "variant_matcha", quantity: 2 },
      ],
      address: {
        countryCode: "JP",
        recipientName: "Nuki Buyer",
        addressLine1: "1-2-3 Shibuya",
        locality: "Shibuya",
        administrativeArea: "Tokyo",
        postalCode: "150-0001",
      },
    });
    await app.submitShippingQuote(
      recovered.context,
      OPERATION_ID,
      {
        countryCode: "JP",
        recipientName: "Nuki Buyer",
        addressLine1: "1-2-3 Shibuya",
        locality: "Shibuya",
        administrativeArea: "Tokyo",
        postalCode: "150-0001",
      },
      {
        kind: "accepted_as_entered",
        addressValidationReference: "address_validation_jp_1",
      },
    );
    const replaceRequest = capturedRequests.find(isCartReplaceRequest);
    expect(replaceRequest).toBeDefined();
    await expect(replaceRequest?.clone().json()).resolves.toMatchObject({
      schemaVersion: "underclerk.replace-buyer-cart.v1",
      cartRevision: 4,
      lines: [
        { kind: "catalog", variantId: "variant_cookie", quantity: 1 },
        { kind: "catalog", variantId: "variant_matcha", quantity: 2 },
      ],
    });
    const checkoutRequest = capturedRequests.find(isShippingCheckoutRequest);
    expect(checkoutRequest).toBeDefined();
    if (checkoutRequest === undefined)
      throw new Error("Japan shipping checkout request was not captured");
    const checkoutBody: unknown = await checkoutRequest.clone().json();
    expect(checkoutBody).toMatchObject({
      schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
      cartId: CART_ID,
      cartRevision: 5,
      shippingServiceCode: "domestic_parcel_test",
      shippingDestination: {
        kind: "provided_address",
        address: {
          countryCode: "JP",
          recipientName: "Nuki Buyer",
          addressLine1: "1-2-3 Shibuya",
          locality: "Shibuya",
          administrativeArea: "Tokyo",
          postalCode: "150-0001",
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("recovers an expired quote when the Cart reached submitted state before the response", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify(storedCheckout()),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  capturedRequests.length = 0;
  cartLifecycle = "submitted";
  try {
    const app = new StorefrontApp({ config });
    expect(await app.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_quote",
      context: {
        session: { token: SESSION_TOKEN },
        cart: {
          kind: "submitted",
          cartId: CART_ID,
          revision: 4,
          checkoutId: CHECKOUT_ID,
        },
      },
      quote: {
        schemaVersion: "underclerk.buyer-quoted-checkout.v1",
        checkoutId: CHECKOUT_ID,
        quote: { expiresAt: "2020-08-29T10:00:00.000Z" },
      },
    });
    expect(capturedRequests.map(requestSummary)).toEqual([
      "GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/catalog",
      `GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/carts/${CART_ID}`,
      `GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/checkouts/${CHECKOUT_ID}`,
    ]);
    expect(
      JSON.parse(
        storage.getItem(`satyr.checkout.${config.storefrontId}`) ?? "null",
      ),
    ).toMatchObject({
      cart: {
        kind: "submitted",
        cartId: CART_ID,
        revision: 4,
        checkoutId: CHECKOUT_ID,
      },
    });
  } finally {
    cartLifecycle = "active";
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("recovers a quote directly from a persisted submitted Cart reference", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify({
      ...storedCheckout(),
      cart: {
        kind: "submitted",
        cartId: CART_ID,
        revision: 4,
        checkoutId: CHECKOUT_ID,
      },
    }),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  capturedRequests.length = 0;
  try {
    const app = new StorefrontApp({ config });
    expect(await app.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_quote",
      quote: { checkoutId: CHECKOUT_ID },
    });
    expect(capturedRequests.map(requestSummary)).toEqual([
      "GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/catalog",
      `GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/checkouts/${CHECKOUT_ID}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("reopens the same pending provider payment session after reload", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify({
      ...storedCheckout(),
      cart: {
        kind: "submitted",
        cartId: CART_ID,
        revision: 4,
        checkoutId: CHECKOUT_ID,
      },
    }),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  capturedRequests.length = 0;
  checkoutExpiresAt = "2099-08-29T10:00:00.000Z";
  checkoutProgress = {
    state: "payment_pending",
    payment: {
      state: "pending",
      paymentAttemptId: "payment_attempt_recovered",
    },
  };
  try {
    const app = new StorefrontApp({ config });
    expect(await app.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_payment",
      context: { runId: OPERATION_ID },
      payment: { paymentAttemptId: "payment_attempt_recovered" },
    });
    expect(capturedRequests.map(requestSummary)).toEqual([
      "GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/catalog",
      `GET /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/checkouts/${CHECKOUT_ID}`,
      `POST /v1/public/merchants/merchant_nuki_cafe_demo/storefronts/storefront_cafe/checkouts/${CHECKOUT_ID}/payment-sessions`,
    ]);
    const request = capturedRequests.at(-1);
    await expect(request?.clone().json()).resolves.toMatchObject({
      idempotencyKey: `${OPERATION_ID}_payment`,
      checkoutRevision: 1,
      quoteDigest: "quote_digest_recovered",
    });
  } finally {
    checkoutProgress = { state: "quoted" };
    checkoutExpiresAt = "2020-08-29T10:00:00.000Z";
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("restores indeterminate and declined payment outcomes without reopening collection", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify({
      ...storedCheckout(),
      cart: {
        kind: "submitted",
        cartId: CART_ID,
        revision: 4,
        checkoutId: CHECKOUT_ID,
      },
    }),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  try {
    checkoutProgress = {
      state: "payment_pending",
      payment: {
        state: "captured",
        paymentAttemptId: "payment_attempt_recovered",
      },
    };
    capturedRequests.length = 0;
    const captured = new StorefrontApp({ config });
    expect(await captured.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_indeterminate",
    });
    expect(capturedRequests.some(isPaymentSessionRequest)).toBe(false);

    checkoutProgress = {
      state: "payment_pending",
      payment: {
        state: "indeterminate",
        paymentAttemptId: "payment_attempt_recovered",
        reconcileAfter: "2099-08-29T10:01:00.000Z",
      },
    };
    capturedRequests.length = 0;
    const indeterminate = new StorefrontApp({ config });
    expect(await indeterminate.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_indeterminate",
      reconcileAfter: "2099-08-29T10:01:00.000Z",
    });
    expect(capturedRequests.some(isPaymentSessionRequest)).toBe(false);

    checkoutProgress = {
      state: "payment_pending",
      payment: {
        state: "processing",
        paymentAttemptId: "payment_attempt_recovered",
        reconcileAfter: "2099-08-29T10:02:00.000Z",
      },
    };
    capturedRequests.length = 0;
    const processing = new StorefrontApp({ config });
    expect(await processing.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_pickup_indeterminate",
      reconcileAfter: "2099-08-29T10:02:00.000Z",
    });
    expect(capturedRequests.some(isPaymentSessionRequest)).toBe(false);

    checkoutProgress = {
      state: "payment_pending",
      payment: {
        state: "declined",
        paymentAttemptId: "payment_attempt_recovered",
        reasonCode: "card_declined",
      },
    };
    capturedRequests.length = 0;
    const declined = new StorefrontApp({ config });
    expect(await declined.recoverBuyerContext(config)).toMatchObject({
      kind: "recovered_declined",
      reasonCode: "card_declined",
    });
    expect(capturedRequests.some(isPaymentSessionRequest)).toBe(false);
  } finally {
    checkoutProgress = { state: "quoted" };
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("rejects a recovered quote with fields outside the public response union", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  const config = storefrontConfiguration("/store");
  storage.setItem(
    `satyr.checkout.${config.storefrontId}`,
    JSON.stringify({
      ...storedCheckout(),
      cart: {
        kind: "submitted",
        cartId: CART_ID,
        revision: 4,
        checkoutId: CHECKOUT_ID,
      },
    }),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://storefront.test",
        href: "https://storefront.test/store",
      },
      sessionStorage: storage,
    },
  });
  globalThis.fetch = recoveryFetch;
  checkoutHasExtraField = true;
  try {
    const app = new StorefrontApp({ config });
    expect(await app.recoverBuyerContext(config)).toMatchObject({
      kind: "failed",
      message: "The store's reply could not be read. Try again.",
    });
    checkoutHasExtraField = false;
    checkoutProgress = {
      state: "quoted",
      payment: { state: "pending", paymentAttemptId: "payment_attempt_mixed" },
    };
    expect(await app.recoverBuyerContext(config)).toMatchObject({
      kind: "failed",
      message: "The store's reply could not be read. Try again.",
    });
  } finally {
    checkoutHasExtraField = false;
    checkoutProgress = { state: "quoted" };
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("rejects mixed and cross-storefront checkout recovery records", () => {
  const cafe = storefrontConfiguration("/store");
  const shipping = storefrontConfiguration("/store/shipping");
  expect(parseStoredCheckoutRecovery(storedCheckout(), cafe)).toMatchObject({
    session: { token: SESSION_TOKEN },
    operationId: OPERATION_ID,
    cart: { kind: "active", cartId: CART_ID, revision: 3 },
  });
  expect(
    parseStoredCheckoutRecovery(storedCheckout(), shipping),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      { ...storedCheckout(), unexpected: true },
      cafe,
    ),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...storedCheckout(),
        schemaVersion: "satyr.storefront-checkout-session.v4",
      },
      cafe,
    ),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...storedCheckout(),
        schemaVersion: "satyr.storefront-checkout-session.v5",
      },
      cafe,
    ),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...storedCheckout(),
        schemaVersion: "satyr.storefront-checkout-session.v6",
      },
      cafe,
    ),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...storedCheckout(),
        schemaVersion: "satyr.storefront-checkout-session.v1",
      },
      cafe,
    ),
  ).toBeUndefined();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...storedCheckout(),
        cart: { kind: "active", cartId: CART_ID, revision: 0 },
      },
      cafe,
    ),
  ).toBeUndefined();
  const expired = storedCheckout();
  expect(
    parseStoredCheckoutRecovery(
      {
        ...expired,
        session: { ...sessionRecord(), expiresAt: "2020-08-29T10:00:00.000Z" },
      },
      cafe,
    ),
  ).toBeUndefined();
});

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

async function recoveryFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  capturedRequests.push(request);
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/catalog")) return catalogResponse();
  if (pathname.endsWith(`/carts/${CART_ID}`) && request.method === "PUT") {
    return replacedCartResponse(request);
  }
  if (pathname.endsWith(`/checkouts/${CHECKOUT_ID}/payment-sessions`)) {
    return paymentSessionResponse();
  }
  if (pathname.endsWith(`/checkouts/${CHECKOUT_ID}`)) return checkoutResponse();
  if (pathname.endsWith(`/carts/${CART_ID}`)) return cartResponse();
  return Response.json({ message: "Route not found" }, { status: 404 });
}

async function shippingRecoveryFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  capturedRequests.push(request);
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/catalog")) return shippingCatalogResponse();
  if (pathname.endsWith(`/carts/${CART_ID}`) && request.method === "PUT") {
    return shippingReplacedCartResponse(request);
  }
  if (pathname.endsWith(`/carts/${CART_ID}`)) return shippingCartResponse();
  if (isShippingCheckoutRequest(request)) {
    return Response.json(
      { message: "Checkout stopped after request capture" },
      { status: 409 },
    );
  }
  return Response.json({ message: "Route not found" }, { status: 404 });
}

async function replacedCartResponse(request: Request): Promise<Response> {
  const body: unknown = await request.clone().json();
  if (!isRecord(body) || !Array.isArray(body.lines)) {
    return Response.json(
      { message: "Cart replacement is invalid" },
      { status: 400 },
    );
  }
  return Response.json({
    schemaVersion: "underclerk.buyer-cart.v1",
    cartId: CART_ID,
    revision: 5,
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_cafe",
      revision: 1,
    },
    fulfillment: "pickup",
    lines: body.lines,
    state: "active",
  });
}

function catalogResponse(): Response {
  return Response.json({
    schemaVersion: "underclerk.buyer-catalog.v1",
    storefront: {
      storefrontId: "storefront_cafe",
      revision: 1,
      name: "Nuki Café",
      fulfillment: "pickup",
    },
    listings: [],
    menus: [],
  });
}

function shippingCatalogResponse(): Response {
  return Response.json({
    schemaVersion: "underclerk.buyer-catalog.v1",
    storefront: {
      storefrontId: "storefront_cookie_store_sg",
      revision: 1,
      name: "Nuki Cookie Post",
      fulfillment: "shipping",
      shippingServices: [
        {
          destinationCountry: "JP",
          service: {
            code: "domestic_parcel_test",
            name: "Japan Post Domestic Test",
          },
          availability: { state: "available" },
        },
        {
          destinationCountry: "SG",
          service: { code: "ems_test", name: "Japan Post EMS Test" },
          availability: { state: "available" },
        },
        {
          destinationCountry: "SG",
          service: {
            code: "international_parcel_air_test",
            name: "Japan Post International Parcel Air Test",
          },
          availability: { state: "available" },
        },
      ],
    },
    listings: [
      {
        productId: "product_cookie_box",
        productRevision: 1,
        title: "Nuki cookie box",
        description: "Six cookies baked in Tokyo",
        variantId: "variant_cookie",
        variantRevision: 1,
        variantTitle: "Box of six",
        sku: "COOKIE-BOX-6-SG",
        offerId: "offer_cookie_box",
        offerRevision: 1,
        price: { amountMinor: 3_600, currency: "JPY" },
        availability: "available",
      },
      {
        productId: "product_matcha_box",
        productRevision: 1,
        title: "Matcha cookie box",
        description: "Six matcha cookies baked in Tokyo",
        variantId: "variant_matcha",
        variantRevision: 1,
        variantTitle: "Box of six matcha cookies",
        sku: "MATCHA-BOX-6-SG",
        offerId: "offer_matcha_box",
        offerRevision: 1,
        price: { amountMinor: 4_800, currency: "JPY" },
        availability: "available",
      },
    ],
    menus: [],
  });
}

function cartResponse(): Response {
  return Response.json({
    schemaVersion: "underclerk.buyer-cart.v1",
    cartId: CART_ID,
    revision: 4,
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_cafe",
      revision: 1,
    },
    fulfillment: "pickup",
    lines: [{ kind: "catalog", variantId: "variant_cookie", quantity: 1 }],
    state: cartLifecycle,
    ...(cartLifecycle === "submitted" ? { checkoutId: CHECKOUT_ID } : {}),
  });
}

function shippingCartResponse(): Response {
  return Response.json({
    schemaVersion: "underclerk.buyer-cart.v1",
    cartId: CART_ID,
    revision: 4,
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_shipping",
      revision: 1,
    },
    fulfillment: "shipping",
    lines: [{ kind: "catalog", variantId: "variant_cookie", quantity: 1 }],
    state: "active",
  });
}

async function shippingReplacedCartResponse(
  request: Request,
): Promise<Response> {
  const body: unknown = await request.clone().json();
  if (!isRecord(body) || !Array.isArray(body.lines)) {
    return Response.json(
      { message: "Cart replacement is invalid" },
      { status: 400 },
    );
  }
  return Response.json({
    schemaVersion: "underclerk.buyer-cart.v1",
    cartId: CART_ID,
    revision: 5,
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_shipping",
      revision: 1,
    },
    fulfillment: "shipping",
    lines: body.lines,
    state: "active",
  });
}

function checkoutResponse(): Response {
  const money = { amountMinor: 1_000, currency: "JPY" };
  const zeroMoney = { amountMinor: 0, currency: "JPY" };
  return Response.json({
    schemaVersion: "underclerk.buyer-checkout-recovery.v1",
    checkout: {
      schemaVersion: "underclerk.buyer-quoted-checkout.v1",
      checkoutId: CHECKOUT_ID,
      revision: 1,
      state: "quoted",
      quote: {
        quoteDigest: "quote_digest_recovered",
        lines: [
          {
            kind: "catalog",
            checkoutLineId: "checkout_line_cookie",
            variantId: "variant_cookie",
            quantity: 1,
            unitPrice: money,
            lineTotal: money,
          },
        ],
        totals: {
          subtotal: money,
          tax: zeroMoney,
          duty: zeroMoney,
          shipping: zeroMoney,
          total: money,
        },
        pickup: {
          locationId: "location_cafe",
          readyAt: "2020-08-29T09:30:00.000Z",
        },
        expiresAt: checkoutExpiresAt,
      },
    },
    progress: checkoutProgress,
    ...(checkoutHasExtraField
      ? { buyerSessionDigest: "must_never_cross_boundary" }
      : {}),
  });
}

function paymentSessionResponse(): Response {
  return Response.json({
    schemaVersion: "underclerk.buyer-payment-session.v1",
    state: "ready",
    checkoutId: CHECKOUT_ID,
    checkoutRevision: 1,
    paymentAttemptId: "payment_attempt_recovered",
    session: {
      kind: "embedded_public_session",
      providerSessionReference: "provider_session_recovered",
      publicConfiguration: {
        provider: "stripe_online",
        clientSecret: "pi_recovered_secret_test",
        publishableKey: "pk_test_recovered",
        connectedAccountId: "acct_recovered",
      },
      expiresAt: "2099-08-29T10:00:00.000Z",
    },
  });
}

function storedCheckout(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "satyr.storefront-checkout-session.v7",
    merchantId: "merchant_nuki_cafe_demo",
    storefrontId: "storefront_cafe",
    session: sessionRecord(),
    operationId: OPERATION_ID,
    cart: { kind: "active", cartId: CART_ID, revision: 3 },
    basket: {
      kind: "cafe",
      buyerContact: { email: "", phone: "" },
      items: [],
    },
  };
}

function storedShippingCheckout(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "satyr.storefront-checkout-session.v7",
    merchantId: "merchant_nuki_cafe_demo",
    storefrontId: "storefront_cookie_store_sg",
    session: {
      schemaVersion: "underclerk.buyer-session.v4",
      token: SESSION_TOKEN,
      expiresAt: "2099-08-29T10:00:00.000Z",
      storefrontRevision: 1,
      checkoutProfile: {
        checkoutProfileId: "checkout_profile_shipping",
        revision: 1,
      },
      checkoutProfileConfiguration: CHECKOUT_PROFILE_CONFIGURATION,
      buyer: { kind: "guest" },
    },
    operationId: OPERATION_ID,
    cart: { kind: "active", cartId: CART_ID, revision: 3 },
    basket: {
      kind: "shipping",
      buyerContact: { email: "buyer@example.test", phone: "+819012345678" },
      items: [
        { variantId: "variant_cookie", quantity: 1 },
        { variantId: "variant_matcha", quantity: 2 },
      ],
      shippingServiceCode: "international_parcel_air_test",
      address: {
        countryCode: "SG",
        recipientName: "Nuki Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
    },
  };
}

function storedJapanShippingCheckout(): Readonly<Record<string, unknown>> {
  return {
    ...storedShippingCheckout(),
    basket: {
      kind: "shipping",
      buyerContact: { email: "buyer@example.test", phone: "+819012345678" },
      items: [
        { variantId: "variant_cookie", quantity: 1 },
        { variantId: "variant_matcha", quantity: 2 },
      ],
      shippingServiceCode: "domestic_parcel_test",
      address: {
        countryCode: "JP",
        recipientName: "Nuki Buyer",
        addressLine1: "1-2-3 Shibuya",
        locality: "Shibuya",
        administrativeArea: "Tokyo",
        postalCode: "150-0001",
      },
    },
  };
}

function sessionRecord(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "underclerk.buyer-session.v4",
    token: SESSION_TOKEN,
    expiresAt: "2099-08-29T10:00:00.000Z",
    storefrontRevision: 1,
    checkoutProfile: {
      checkoutProfileId: "checkout_profile_cafe",
      revision: 1,
    },
    checkoutProfileConfiguration: CHECKOUT_PROFILE_CONFIGURATION,
    buyer: { kind: "guest" },
  };
}

function parseSession(
  override: Readonly<{ fulfillmentPolicy: unknown }>,
): CommerceBuyerSessionV4 {
  return parseCommerceBuyerSessionV4({
    ...sessionRecord(),
    checkoutProfileConfiguration: {
      ...CHECKOUT_PROFILE_CONFIGURATION,
      fulfillmentPolicy: override.fulfillmentPolicy,
    },
  });
}

function shippingQuote(
  country: "JP" | "SG",
): CommerceBuyerQuotedShippingCheckoutV1 {
  const domestic = country === "JP";
  const dutyAmount = domestic ? 0 : 100;
  const dutyIncoterm = domestic ? "not_applicable" : "ddp";
  return {
    schemaVersion: "underclerk.buyer-quoted-shipping-checkout.v1",
    checkoutId: "checkout_evidence",
    revision: 1,
    state: "quoted",
    quote: {
      quoteDigest: "quote-evidence",
      lines: [
        {
          kind: "catalog",
          checkoutLineId: "line-cookie",
          variantId: "variant-cookie",
          quantity: 1,
          unitPrice: { amountMinor: 900, currency: "JPY" },
          lineTotal: { amountMinor: 900, currency: "JPY" },
        },
      ],
      totals: {
        subtotal: { amountMinor: 900, currency: "JPY" },
        tax: { amountMinor: 90, currency: "JPY" },
        duty: { amountMinor: dutyAmount, currency: "JPY" },
        shipping: { amountMinor: 100, currency: "JPY" },
        total: { amountMinor: 1_090 + dutyAmount, currency: "JPY" },
      },
      shipping: {
        addressValidationReference: `address-validation-${country.toLowerCase()}`,
        service: { code: "carrier-test", name: "Carrier test" },
        destinationCountry: country,
        dutyTerms: { incoterm: dutyIncoterm },
        estimatedDelivery: {
          kind: "window",
          earliest: "2099-08-30T00:00:00.000Z",
          latest: "2099-09-01T00:00:00.000Z",
        },
        carrierQuote: {
          rateReference: `rate-${country.toLowerCase()}`,
          shippingAmount: { amountMinor: 100, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "line-cookie",
              amount: { amountMinor: 100, currency: "JPY" },
            },
          ],
        },
        taxQuote: {
          registrationPolicyReference: "tax-registration",
          quoteReference: `tax-${country.toLowerCase()}`,
          taxAmount: { amountMinor: 90, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "line-cookie",
              amount: { amountMinor: 90, currency: "JPY" },
            },
          ],
        },
        dutyQuote: {
          quoteReference: `duty-quote-${country.toLowerCase()}`,
          incoterm: dutyIncoterm,
          dutyAmount: { amountMinor: dutyAmount, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "line-cookie",
              amount: { amountMinor: dutyAmount, currency: "JPY" },
            },
          ],
        },
        packagePlan: {
          packagePlanDigest:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          package: {
            packageId: `package-${country.toLowerCase()}`,
            weight: { grams: 100 },
            dimensions: {
              lengthMillimeters: 100,
              widthMillimeters: 100,
              heightMillimeters: 100,
            },
            lineQuantities: [
              {
                checkoutLineId: "line-cookie",
                quantity: { amount: 1, scale: 0, unit: "each" },
              },
            ],
            customsLines: domestic
              ? []
              : [
                  {
                    checkoutLineId: "line-cookie",
                    description: "Cookie box",
                    quantity: { amount: 1, scale: 0, unit: "each" },
                    weight: { grams: 100 },
                    declaredValue: { amountMinor: 900, currency: "JPY" },
                    countryOfOrigin: "JP",
                    hsCode: "190531",
                  },
                ],
          },
        },
      },
      expiresAt: "2099-08-29T10:00:00.000Z",
    },
  };
}

function requestSummary(request: Request): string {
  return `${request.method} ${new URL(request.url).pathname}`;
}

function isPaymentSessionRequest(request: Request): boolean {
  return new URL(request.url).pathname.endsWith(
    `/checkouts/${CHECKOUT_ID}/payment-sessions`,
  );
}

function isShippingCheckoutRequest(request: Request): boolean {
  return (
    request.method === "POST" &&
    new URL(request.url).pathname.endsWith(
      "/storefronts/storefront_cookie_store_sg/checkouts",
    )
  );
}

function isCartReplaceRequest(request: Request): boolean {
  return (
    request.method === "PUT" &&
    new URL(request.url).pathname.endsWith(`/carts/${CART_ID}`)
  );
}

function hasRecoveredSessionAuthorization(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${SESSION_TOKEN}`;
}

function noop(): void {}

function timelineItemIsCurrent(item: Readonly<{ state: string }>): boolean {
  return item.state === "current";
}
