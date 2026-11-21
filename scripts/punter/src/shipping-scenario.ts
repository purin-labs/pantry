import {
  CommerceStorefrontClient,
  type CommerceBuyerCatalogListingV1,
  type CommerceBuyerDutyQuoteV1,
  type CommerceBuyerOrderV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceBuyerShippingAddressAcceptanceV1,
  type CommerceFetch,
} from "@purin-labs/commerce-client";

import {
  collectAndReconcilePayment,
  recoverPunterPayment,
  replayAndReconcilePayment,
  type PunterPaymentSessionIdentity,
} from "./payment.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

type PunterMoney = Readonly<{ amountMinor: number; currency: string }>;
type PlacedPayment = VariantBy<
  CommerceBuyerPaymentResultV1,
  "state",
  "placed"
>;
type PunterPlacedPaymentEvidence = Omit<PlacedPayment, "orderRecovery">;
type PunterAcceptedShippingAddress = Readonly<{
  address: CommerceBuyerShippingAddressV1;
  acceptance: CommerceBuyerShippingAddressAcceptanceV1;
}>;

type PunterShippingTotals = Readonly<{
  subtotal: PunterMoney;
  tax: PunterMoney;
  duty: PunterMoney;
  shipping: PunterMoney;
  total: PunterMoney;
}>;

type PunterShippingComponentExpectation = Readonly<{
  reference: string;
  amount: PunterMoney;
  lineAllocations: readonly PunterMoney[];
}>;

type PunterTaxComponentExpectation = PunterShippingComponentExpectation &
  Readonly<{
    registrationPolicyReference: string;
  }>;

type PunterShippingLineScenario = Readonly<{
  variantId: string;
  initialQuantity: number;
  quantity: number;
  unitPrice: PunterMoney;
}>;

export type PunterOnlineCookieScenario = Readonly<{
  kind: "online_cookie_store" | "domestic_japan_store";
  variantId: string;
  unitPrice: PunterMoney;
  shippingServiceCode: string;
  initialQuantity: number;
  quantity: number;
  additionalLine: PunterShippingLineScenario;
  initialShippingAddress: CommerceBuyerShippingAddressV1;
  shippingAddress: CommerceBuyerShippingAddressV1;
  expectedDutyIncoterm: CommerceBuyerDutyQuoteV1["incoterm"];
  initialTotals: PunterShippingTotals;
  expectedTotals: PunterShippingTotals;
  expectedQuote: Readonly<{
    initialQuoteDigest: string;
    initialExpiresAt: string;
    quoteDigest: string;
    expiresAt: string;
    serviceName: string;
    estimatedDelivery: Readonly<{
      earliest: string;
      latest: string;
    }>;
    packagePlanDigest: string;
    packageId: string;
    dimensions: Readonly<{
      lengthMillimeters: number;
      widthMillimeters: number;
      heightMillimeters: number;
    }>;
    initialCarrierQuote: PunterShippingComponentExpectation;
    initialTaxQuote: PunterTaxComponentExpectation;
    initialDutyQuote: PunterShippingComponentExpectation;
    carrierQuote: PunterShippingComponentExpectation;
    taxQuote: PunterTaxComponentExpectation;
    dutyQuote: PunterShippingComponentExpectation;
  }>;
  expectedPackagePlan: Readonly<{
    package: Readonly<{
      weight: Readonly<{ grams: number }>;
      customsLines: readonly Readonly<{
        description: string;
        quantity: number;
        weight: Readonly<{ grams: number }>;
        declaredValue: PunterMoney;
        countryOfOrigin: string;
        hsCode: string;
      }>[];
    }>;
  }>;
}>;

type PunterShippingScenarioInput = Readonly<{
  baseUrl: string;
  merchantId: string;
  storefrontId: string;
  scenario: PunterOnlineCookieScenario;
  runId: string;
  fetch: CommerceFetch;
  orderPolling: Readonly<{
    maxAttempts: number;
    intervalMs: number;
    wait: (milliseconds: number) => Promise<void>;
  }>;
}>;

type PunterShippingEvidenceV1 = Readonly<{
  schemaVersion: "punter.shipping-evidence.v1";
  runId: string;
  merchantId: string;
  storefrontId: string;
  storefrontRevision: number;
  listing: CommerceBuyerCatalogListingV1;
  additionalListing: CommerceBuyerCatalogListingV1;
  checkout: CommerceBuyerQuotedShippingCheckoutV1;
  addressValidationReferences: Readonly<{
    initial: string;
    refreshed: string;
  }>;
  paymentSession: PunterPaymentSessionIdentity;
  payment: PunterPlacedPaymentEvidence;
  order: Extract<
    CommerceBuyerOrderV1,
    { fulfillment: "shipping"; state: "delivered" }
  >;
  statusProgression: readonly ShippingOrderState[];
}>;

type ShippingOrderState = VariantBy<
  CommerceBuyerOrderV1,
  "fulfillment",
  "shipping"
>["state"];

type PunterShippingScenarioFailure =
  | Readonly<{
      stage: "session" | "catalog" | "checkout" | "payment" | "order";
      kind:
        | "client_error"
        | "scenario_unavailable"
        | "identity_mismatch"
        | "commercial_snapshot_mismatch"
        | "status_regression"
        | "completion_timeout";
      message?: string;
      lastState?: ShippingOrderState;
    }>
  | Readonly<{
      stage: "payment";
      kind: "indeterminate";
      reconcileAfter: string;
    }>;

type PunterShippingScenarioResult =
  | Readonly<{ ok: true; evidence: PunterShippingEvidenceV1 }>
  | Readonly<{ ok: false; error: PunterShippingScenarioFailure }>;

export async function runPunterShippingScenario(
  input: PunterShippingScenarioInput,
): Promise<PunterShippingScenarioResult> {
  if (
    !Number.isSafeInteger(input.orderPolling.maxAttempts) ||
    input.orderPolling.maxAttempts < 1 ||
    !Number.isSafeInteger(input.orderPolling.intervalMs) ||
    input.orderPolling.intervalMs < 0
  ) {
    throw new Error(
      "orderPolling requires a positive attempt count and non-negative interval",
    );
  }
  const client = new CommerceStorefrontClient({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });
  const session = await client.createSession(
    input.merchantId,
    input.storefrontId,
    {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    },
  );
  if (!session.ok) return clientFailure("session", session.error.message);
  const catalog = await client.readCatalog(
    input.merchantId,
    input.storefrontId,
    session.value.token,
  );
  if (!catalog.ok) return clientFailure("catalog", catalog.error.message);
  if (
    catalog.value.storefront.storefrontId !== input.storefrontId ||
    catalog.value.storefront.fulfillment !== "shipping"
  ) {
    return {
      ok: false,
      error: {
        stage: "catalog",
        kind: "scenario_unavailable",
        message: "shipping storefront is unavailable",
      },
    };
  }
  const listing = uniqueAvailableListing(
    catalog.value.listings,
    input.scenario.variantId,
  );
  const additionalListing = uniqueAvailableListing(
    catalog.value.listings,
    input.scenario.additionalLine.variantId,
  );
  if (
    listing === undefined ||
    additionalListing === undefined ||
    listing.variantId === additionalListing.variantId
  ) {
    return {
      ok: false,
      error: {
        stage: "catalog",
        kind: "scenario_unavailable",
        message: "shipping listing is unavailable",
      },
    };
  }
  const selectedServiceCount = catalog.value.storefront.shippingServices.filter(
    (published) =>
      published.destinationCountry ===
        input.scenario.initialShippingAddress.countryCode &&
      published.service.code === input.scenario.shippingServiceCode,
  ).length;
  if (selectedServiceCount !== 1) {
    return {
      ok: false,
      error: {
        stage: "catalog",
        kind: "scenario_unavailable",
        message: "shipping service is unavailable",
      },
    };
  }
  const initialAddress = await validateShippingAddress({
    client,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    sessionToken: session.value.token,
    idempotencyKey: `${input.runId}_initial_address`,
    address: input.scenario.initialShippingAddress,
  });
  if (!initialAddress.ok)
    return clientFailure("checkout", initialAddress.message);
  const cart = await client.createCart(
    input.merchantId,
    input.storefrontId,
    session.value.token,
    {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: `${input.runId}_cart`,
      lines: [
        {
          kind: "catalog",
          variantId: listing.variantId,
          quantity: input.scenario.initialQuantity,
        },
        {
          kind: "catalog",
          variantId: additionalListing.variantId,
          quantity: input.scenario.additionalLine.initialQuantity,
        },
      ],
    },
  );
  if (!cart.ok) return clientFailure("checkout", cart.error.message);
  const checkout = await client.createShippingCheckout(
    input.merchantId,
    input.storefrontId,
    session.value.token,
    {
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: `${input.runId}_checkout`,
      cartId: cart.value.cartId,
      cartRevision: cart.value.revision,
      shippingServiceCode: input.scenario.shippingServiceCode,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: "punter@example.test" },
      },
      shippingDestination: {
        kind: "provided_address",
        address: initialAddress.value.address,
        acceptance: initialAddress.value.acceptance,
      },
    },
  );
  if (!checkout.ok) return clientFailure("checkout", checkout.error.message);
  if (
    checkout.value.quote.quoteDigest !==
      input.scenario.expectedQuote.initialQuoteDigest ||
    checkout.value.quote.expiresAt !==
      input.scenario.expectedQuote.initialExpiresAt ||
    checkout.value.quote.shipping.service.code !==
      input.scenario.shippingServiceCode ||
    checkout.value.quote.shipping.destinationCountry !==
      initialAddress.value.address.countryCode ||
    checkout.value.quote.shipping.dutyTerms.incoterm !==
      input.scenario.expectedDutyIncoterm ||
    checkout.value.quote.shipping.estimatedDelivery.earliest !==
      input.scenario.expectedQuote.estimatedDelivery.earliest ||
    checkout.value.quote.shipping.estimatedDelivery.latest !==
      input.scenario.expectedQuote.estimatedDelivery.latest ||
    !shippingQuoteMatches(
      checkout.value,
      input.scenario,
      "initial",
      initialAddress.value.acceptance.addressValidationReference,
    )
  ) {
    return {
      ok: false,
      error: { stage: "checkout", kind: "commercial_snapshot_mismatch" },
    };
  }
  const refreshedAddress = await validateShippingAddress({
    client,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    sessionToken: session.value.token,
    idempotencyKey: `${input.runId}_refreshed_address`,
    address: input.scenario.shippingAddress,
  });
  if (!refreshedAddress.ok)
    return clientFailure("checkout", refreshedAddress.message);
  const refreshed = await client.refreshShippingCheckout(
    input.merchantId,
    input.storefrontId,
    checkout.value.checkoutId,
    session.value.token,
    {
      schemaVersion: "commerce.refresh-buyer-shipping-checkout.v1",
      idempotencyKey: `${input.runId}_refresh`,
      checkoutRevision: checkout.value.revision,
      quoteDigest: checkout.value.quote.quoteDigest,
      lines: [
        { variantId: listing.variantId, quantity: input.scenario.quantity },
        {
          variantId: additionalListing.variantId,
          quantity: input.scenario.additionalLine.quantity,
        },
      ],
      shippingServiceCode: input.scenario.shippingServiceCode,
      shippingDestination: {
        kind: "provided_address",
        address: refreshedAddress.value.address,
        acceptance: refreshedAddress.value.acceptance,
      },
    },
  );
  if (!refreshed.ok) return clientFailure("checkout", refreshed.error.message);
  if (
    refreshed.value.checkoutId !== checkout.value.checkoutId ||
    refreshed.value.revision <= checkout.value.revision ||
    !shippingQuoteMatches(
      refreshed.value,
      input.scenario,
      "refreshed",
      refreshedAddress.value.acceptance.addressValidationReference,
    )
  ) {
    return {
      ok: false,
      error: { stage: "checkout", kind: "commercial_snapshot_mismatch" },
    };
  }
  const paymentCommand = {
    schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
    idempotencyKey: `${input.runId}_payment`,
    checkoutRevision: refreshed.value.revision,
    quoteDigest: refreshed.value.quote.quoteDigest,
  };
  const payment = await collectAndReconcilePayment({
    client,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    returnUrl: `${input.baseUrl}/store/shipping`,
    command: paymentCommand,
  });
  if (!payment.ok) return clientFailure("payment", payment.message);
  const recoveryClient = new CommerceStorefrontClient({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });
  const recoveredPayment = await recoverPunterPayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    command: paymentCommand,
    session: payment.value.session,
    payment: payment.value.payment,
    intervalMs: input.orderPolling.intervalMs,
    wait: input.orderPolling.wait,
  });
  if (!recoveredPayment.ok)
    return clientFailure("payment", recoveredPayment.message);
  const recoveredPaymentValue = recoveredPayment.value;
  const placedPayment = recoveredPaymentValue.payment;
  switch (placedPayment.state) {
    case "placed":
      break;
    case "declined":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "commercial_snapshot_mismatch",
          message: "shipping payment was declined",
        },
      };
    case "processing":
    case "indeterminate":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "indeterminate",
          reconcileAfter: placedPayment.reconcileAfter,
        },
      };
    default:
      return assertNever(placedPayment, "Unsupported Punter shipping branch");
  }
  if (
    placedPayment.shipmentId === undefined ||
    placedPayment.shipping === undefined ||
    !sameMoney(placedPayment.total, refreshed.value.quote.totals.total) ||
    placedPayment.shipping.destinationCountry !==
      refreshed.value.quote.shipping.destinationCountry
  ) {
    return {
      ok: false,
      error: {
        stage: "payment",
        kind: "commercial_snapshot_mismatch",
        message: "shipping payment was not placed",
      },
    };
  }
  const states: ShippingOrderState[] = [];
  let deliveredOrder:
    | Extract<
        CommerceBuyerOrderV1,
        { fulfillment: "shipping"; state: "delivered" }
      >
    | undefined;
  for (
    let attempt = 1;
    attempt <= input.orderPolling.maxAttempts;
    attempt += 1
  ) {
    const order = await recoveryClient.recoverOrder(
      input.merchantId,
      input.storefrontId,
      refreshed.value.checkoutId,
      placedPayment.orderRecovery.token,
    );
    if (!order.ok) return clientFailure("order", order.error.message);
    if (
      order.value.fulfillment !== "shipping" ||
      order.value.orderId !== placedPayment.orderId ||
      order.value.paymentId !== placedPayment.paymentId ||
      order.value.fulfillmentId !== placedPayment.fulfillmentId ||
      order.value.shipmentId !== placedPayment.shipmentId
    ) {
      return {
        ok: false,
        error: { stage: "order", kind: "identity_mismatch" },
      };
    }
    if (
      states.length > 0 &&
      shippingStateRank(order.value.state) <
        shippingStateRank(states[states.length - 1]!)
    ) {
      return {
        ok: false,
        error: { stage: "order", kind: "status_regression" },
      };
    }
    if (states[states.length - 1] !== order.value.state)
      states.push(order.value.state);
    if (order.value.state === "delivered") {
      deliveredOrder = order.value;
      break;
    }
    if (attempt < input.orderPolling.maxAttempts)
      await input.orderPolling.wait(input.orderPolling.intervalMs);
  }
  if (deliveredOrder === undefined) {
    return {
      ok: false,
      error: {
        stage: "order",
        kind: "completion_timeout",
        lastState: states[states.length - 1] ?? "ready",
      },
    };
  }
  const replayPayment = await replayAndReconcilePayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    returnUrl: `${input.baseUrl}/store/shipping`,
    command: paymentCommand,
    expectedSession: payment.value.session,
  });
  if (!replayPayment.ok) return clientFailure("payment", replayPayment.message);
  const recoveredReplayPayment = await recoverPunterPayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    command: paymentCommand,
    session: replayPayment.value.session,
    payment: replayPayment.value.payment,
    intervalMs: input.orderPolling.intervalMs,
    wait: input.orderPolling.wait,
  });
  if (!recoveredReplayPayment.ok)
    return clientFailure("payment", recoveredReplayPayment.message);
  const replayPaymentValue = recoveredReplayPayment.value;
  switch (replayPaymentValue.payment.state) {
    case "placed":
      break;
    case "declined":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "identity_mismatch",
          message: "payment replay was declined",
        },
      };
    case "processing":
    case "indeterminate":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "indeterminate",
          reconcileAfter: replayPaymentValue.payment.reconcileAfter,
        },
      };
    default:
      return assertNever(
        replayPaymentValue.payment,
        "Unsupported Punter shipping branch",
      );
  }
  if (
    replayPaymentValue.session.checkoutId !==
      recoveredPaymentValue.session.checkoutId ||
    replayPaymentValue.session.checkoutRevision !==
      recoveredPaymentValue.session.checkoutRevision ||
    replayPaymentValue.session.paymentAttemptId !==
      recoveredPaymentValue.session.paymentAttemptId ||
    replayPaymentValue.session.providerSessionReference !==
      recoveredPaymentValue.session.providerSessionReference ||
    JSON.stringify(replayPaymentValue.payment) !== JSON.stringify(placedPayment)
  ) {
    return {
      ok: false,
      error: {
        stage: "payment",
        kind: "identity_mismatch",
        message: "payment replay changed after delivery",
      },
    };
  }
  const replayOrder = await recoveryClient.recoverOrder(
    input.merchantId,
    input.storefrontId,
    refreshed.value.checkoutId,
    placedPayment.orderRecovery.token,
  );
  if (
    !replayOrder.ok ||
    JSON.stringify(replayOrder.value) !== JSON.stringify(deliveredOrder)
  ) {
    return {
      ok: false,
      error: {
        stage: "order",
        kind: "identity_mismatch",
        message: "order replay changed",
      },
    };
  }
  return {
    ok: true,
    evidence: {
      schemaVersion: "punter.shipping-evidence.v1",
      runId: input.runId,
      merchantId: input.merchantId,
      storefrontId: input.storefrontId,
      storefrontRevision: catalog.value.storefront.revision,
      listing,
      additionalListing,
      checkout: refreshed.value,
      addressValidationReferences: {
        initial: initialAddress.value.acceptance.addressValidationReference,
        refreshed: refreshedAddress.value.acceptance.addressValidationReference,
      },
      paymentSession: recoveredPayment.value.session,
      payment: paymentEvidence(placedPayment),
      order: deliveredOrder,
      statusProgression: states,
    },
  };
}

async function validateShippingAddress(
  input: Readonly<{
    client: CommerceStorefrontClient;
    merchantId: string;
    storefrontId: string;
    sessionToken: string;
    idempotencyKey: string;
    address: CommerceBuyerShippingAddressV1;
  }>,
): Promise<
  | Readonly<{ ok: true; value: PunterAcceptedShippingAddress }>
  | Readonly<{ ok: false; message: string }>
> {
  const validation = await input.client.validateShippingAddress(
    input.merchantId,
    input.storefrontId,
    input.sessionToken,
    {
      schemaVersion: "commerce.validate-buyer-shipping-address.v1",
      idempotencyKey: input.idempotencyKey,
      address: input.address,
    },
  );
  if (!validation.ok) return { ok: false, message: validation.error.message };
  switch (validation.value.state) {
    case "accepted":
      return {
        ok: true,
        value: {
          address: validation.value.address,
          acceptance: {
            kind: "accepted_as_entered",
            addressValidationReference: validation.value.validationReference,
          },
        },
      };
    case "correction_required":
      return {
        ok: true,
        value: {
          address: validation.value.proposedAddress,
          acceptance: {
            kind: "accepted_correction",
            addressValidationReference: validation.value.validationReference,
          },
        },
      };
    case "unserviceable":
      return { ok: false, message: validation.value.reason };
    case "indeterminate":
      return {
        ok: false,
        message: `Address validation is indeterminate until ${validation.value.retryAfter}`,
      };
    default:
      return assertNever(
        validation.value,
        "Unsupported Punter shipping branch",
      );
  }
}

function clientFailure(
  stage: PunterShippingScenarioFailure["stage"],
  message: string,
): PunterShippingScenarioResult {
  return { ok: false, error: { stage, kind: "client_error", message } };
}

function uniqueAvailableListing(
  listings: readonly CommerceBuyerCatalogListingV1[],
  variantId: string,
): CommerceBuyerCatalogListingV1 | undefined {
  let match: CommerceBuyerCatalogListingV1 | undefined;
  for (const listing of listings) {
    if (listing.variantId !== variantId || listing.availability !== "available")
      continue;
    if (match !== undefined) return undefined;
    match = listing;
  }
  return match;
}

function shippingQuoteMatches(
  checkout: CommerceBuyerQuotedShippingCheckoutV1,
  scenario: PunterOnlineCookieScenario,
  phase: "initial" | "refreshed",
  addressValidationReference: string,
): boolean {
  const initial = phase === "initial";
  const expectedTotals = initial
    ? scenario.initialTotals
    : scenario.expectedTotals;
  const expectedQuote = initial
    ? {
        digest: scenario.expectedQuote.initialQuoteDigest,
        expiresAt: scenario.expectedQuote.initialExpiresAt,
        carrierQuote: scenario.expectedQuote.initialCarrierQuote,
        taxQuote: scenario.expectedQuote.initialTaxQuote,
        dutyQuote: scenario.expectedQuote.initialDutyQuote,
      }
    : {
        digest: scenario.expectedQuote.quoteDigest,
        expiresAt: scenario.expectedQuote.expiresAt,
        carrierQuote: scenario.expectedQuote.carrierQuote,
        taxQuote: scenario.expectedQuote.taxQuote,
        dutyQuote: scenario.expectedQuote.dutyQuote,
      };
  const expectedAddress = initial
    ? scenario.initialShippingAddress
    : scenario.shippingAddress;
  const totals = checkout.quote.totals;
  if (
    !sameMoney(totals.subtotal, expectedTotals.subtotal) ||
    !sameMoney(totals.tax, expectedTotals.tax) ||
    !sameMoney(totals.duty, expectedTotals.duty) ||
    !sameMoney(totals.shipping, expectedTotals.shipping) ||
    !sameMoney(totals.total, expectedTotals.total) ||
    checkout.quote.quoteDigest !== expectedQuote.digest ||
    checkout.quote.expiresAt !== expectedQuote.expiresAt ||
    checkout.quote.shipping.addressValidationReference !==
      addressValidationReference ||
    !shippingLinesMatch(checkout.quote.lines, scenario, phase) ||
    !shippingComponentsMatch(
      checkout.quote,
      expectedQuote.carrierQuote,
      expectedQuote.taxQuote,
      expectedQuote.dutyQuote,
    )
  )
    return false;
  if (
    phase === "refreshed" &&
    !packagePlanMatches(
      checkout.quote.lines,
      checkout.quote.shipping.packagePlan,
      scenario.expectedPackagePlan,
      scenario.expectedQuote,
    )
  )
    return false;
  return (
    checkout.quote.shipping.service.code === scenario.shippingServiceCode &&
    checkout.quote.shipping.service.name ===
      scenario.expectedQuote.serviceName &&
    checkout.quote.shipping.destinationCountry ===
      expectedAddress.countryCode &&
    checkout.quote.shipping.dutyTerms.incoterm ===
      scenario.expectedDutyIncoterm &&
    checkout.quote.shipping.estimatedDelivery.earliest ===
      scenario.expectedQuote.estimatedDelivery.earliest &&
    checkout.quote.shipping.estimatedDelivery.latest ===
      scenario.expectedQuote.estimatedDelivery.latest
  );
}

function shippingLinesMatch(
  actual: CommerceBuyerQuotedShippingCheckoutV1["quote"]["lines"],
  scenario: PunterOnlineCookieScenario,
  phase: "initial" | "refreshed",
): boolean {
  const initial = phase === "initial";
  const expected = [
    {
      variantId: scenario.variantId,
      quantity: initial ? scenario.initialQuantity : scenario.quantity,
      unitPrice: scenario.unitPrice,
    },
    {
      variantId: scenario.additionalLine.variantId,
      quantity: initial
        ? scenario.additionalLine.initialQuantity
        : scenario.additionalLine.quantity,
      unitPrice: scenario.additionalLine.unitPrice,
    },
  ];
  if (actual.length !== expected.length) return false;
  const seenVariantIds = new Set<string>();
  return actual.every((line, index) => {
    const expectedLine = expected[index];
    if (expectedLine === undefined || seenVariantIds.has(line.variantId))
      return false;
    seenVariantIds.add(line.variantId);
    const lineTotal = multiplyMoney(
      expectedLine.unitPrice,
      expectedLine.quantity,
    );
    return (
      lineTotal !== undefined &&
      line.variantId === expectedLine.variantId &&
      line.quantity === expectedLine.quantity &&
      sameMoney(line.unitPrice, expectedLine.unitPrice) &&
      sameMoney(line.lineTotal, lineTotal)
    );
  });
}

function shippingComponentsMatch(
  checkout: CommerceBuyerQuotedShippingCheckoutV1["quote"],
  carrierQuote: PunterShippingComponentExpectation,
  taxQuote: PunterTaxComponentExpectation,
  dutyQuote: PunterShippingComponentExpectation,
): boolean {
  return (
    checkout.shipping.carrierQuote.rateReference === carrierQuote.reference &&
    sameMoney(
      checkout.shipping.carrierQuote.shippingAmount,
      carrierQuote.amount,
    ) &&
    shippingAllocationsMatch(
      checkout.shipping.carrierQuote.lineAllocations,
      checkout.lines,
      carrierQuote.lineAllocations,
    ) &&
    checkout.shipping.taxQuote.quoteReference === taxQuote.reference &&
    checkout.shipping.taxQuote.registrationPolicyReference ===
      taxQuote.registrationPolicyReference &&
    sameMoney(checkout.shipping.taxQuote.taxAmount, taxQuote.amount) &&
    shippingAllocationsMatch(
      checkout.shipping.taxQuote.lineAllocations,
      checkout.lines,
      taxQuote.lineAllocations,
    ) &&
    checkout.shipping.dutyQuote.quoteReference === dutyQuote.reference &&
    checkout.shipping.dutyQuote.incoterm ===
      checkout.shipping.dutyTerms.incoterm &&
    sameMoney(checkout.shipping.dutyQuote.dutyAmount, dutyQuote.amount) &&
    shippingAllocationsMatch(
      checkout.shipping.dutyQuote.lineAllocations,
      checkout.lines,
      dutyQuote.lineAllocations,
    )
  );
}

function shippingAllocationsMatch(
  actual: readonly Readonly<{
    checkoutLineId: string;
    amount: PunterMoney;
  }>[],
  lines: CommerceBuyerQuotedShippingCheckoutV1["quote"]["lines"],
  expectedAmounts: readonly PunterMoney[],
): boolean {
  if (actual.length !== lines.length || expectedAmounts.length !== lines.length)
    return false;
  const expectedByLineId = new Map<string, PunterMoney>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const expectedAmount = expectedAmounts[index];
    if (
      line === undefined ||
      expectedAmount === undefined ||
      expectedByLineId.has(line.checkoutLineId)
    )
      return false;
    expectedByLineId.set(line.checkoutLineId, expectedAmount);
  }
  const seenLineIds = new Set<string>();
  for (const allocation of actual) {
    const expectedAmount = expectedByLineId.get(allocation.checkoutLineId);
    if (
      expectedAmount === undefined ||
      !seenLineIds.add(allocation.checkoutLineId) ||
      !sameMoney(allocation.amount, expectedAmount)
    )
      return false;
  }
  return seenLineIds.size === expectedByLineId.size;
}

function packagePlanMatches(
  lines: CommerceBuyerQuotedShippingCheckoutV1["quote"]["lines"],
  actual: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["packagePlan"],
  expected: PunterOnlineCookieScenario["expectedPackagePlan"],
  expectedQuote: PunterOnlineCookieScenario["expectedQuote"],
): boolean {
  if (
    actual.packagePlanDigest !== expectedQuote.packagePlanDigest ||
    actual.package.packageId !== expectedQuote.packageId ||
    actual.package.dimensions.lengthMillimeters !==
      expectedQuote.dimensions.lengthMillimeters ||
    actual.package.dimensions.widthMillimeters !==
      expectedQuote.dimensions.widthMillimeters ||
    actual.package.dimensions.heightMillimeters !==
      expectedQuote.dimensions.heightMillimeters ||
    actual.package.weight.grams !== expected.package.weight.grams ||
    actual.package.lineQuantities.length !== lines.length ||
    actual.package.customsLines.length !== expected.package.customsLines.length
  )
    return false;
  if (
    !actual.package.lineQuantities.every((line, index) => {
      const checkoutLine = lines[index];
      return (
        checkoutLine !== undefined &&
        line.checkoutLineId === checkoutLine.checkoutLineId &&
        line.quantity.amount === checkoutLine.quantity &&
        line.quantity.scale === 0 &&
        line.quantity.unit === "each"
      );
    })
  )
    return false;
  return actual.package.customsLines.every((line, index) => {
    const expectedLine = expected.package.customsLines[index];
    const checkoutLine = lines[index];
    return (
      expectedLine !== undefined &&
      checkoutLine !== undefined &&
      line.checkoutLineId === checkoutLine.checkoutLineId &&
      line.description === expectedLine.description &&
      line.quantity.amount === expectedLine.quantity &&
      line.quantity.scale === 0 &&
      line.quantity.unit === "each" &&
      line.weight.grams === expectedLine.weight.grams &&
      sameMoney(line.declaredValue, expectedLine.declaredValue) &&
      line.countryOfOrigin === expectedLine.countryOfOrigin &&
      line.hsCode === expectedLine.hsCode
    );
  });
}

function sameMoney(left: PunterMoney, right: PunterMoney): boolean {
  return (
    left.amountMinor === right.amountMinor && left.currency === right.currency
  );
}

function multiplyMoney(
  money: PunterMoney,
  quantity: number,
): PunterMoney | undefined {
  const amountMinor = money.amountMinor * quantity;
  if (!Number.isSafeInteger(amountMinor)) return undefined;
  return { amountMinor, currency: money.currency };
}

function paymentEvidence(payment: PlacedPayment): PunterPlacedPaymentEvidence {
  const { orderRecovery: _orderRecovery, ...evidence } = payment;
  return evidence;
}

function shippingStateRank(state: ShippingOrderState): number {
  switch (state) {
    case "ready":
      return 0;
    case "label_purchased":
      return 1;
    case "in_transit":
      return 2;
    case "delivered":
      return 3;
  }
}
