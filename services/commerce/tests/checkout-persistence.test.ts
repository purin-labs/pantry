import { createHash, randomUUID } from "node:crypto";
import { clientInput } from "./command-input.ts";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PointOfSaleConfiguration,
  Cart,
  Checkout,
  CheckoutPaymentAttempt,
  CheckoutQuoteSnapshot,
  InventoryAllocation,
  InventoryConsumptionPlan,
  InPersonPaymentBinding,
  OnlinePaymentBinding,
  Storefront,
} from "@purin-labs/commerce-contracts";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CreateCommerceBuyerPickupCheckoutV1,
  type CreateCommerceBuyerPaymentSessionV1,
  type CommerceBuyerPickupCheckoutLineV1,
  type CommerceBuyerPaymentResultV1,
  type ObserveCommercePaymentDisputeV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceClientResult,
  type CommerceInPersonCollectionResultV1,
  type CommerceMutationResultV1,
  type CommerceInventoryMovementV1,
  type RefundCommerceOrderV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { CommerceAuthority } from "../src/commerce-authority.ts";
import { publishPointOfSaleConfiguration } from "../src/point-of-sale-configuration-persistence.ts";
import {
  readPaymentDispute,
  readRefundAttempt,
} from "../src/payments/payment-records.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import { checkoutQuoteDigest } from "../src/commerce-authority/checkout-shared.ts";
import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import {
  readCart,
  readCheckout,
  readCheckoutPaymentAttempt,
  readConsumptionPlan,
  readInventoryAllocation,
  readStorefront,
  writeCheckout,
  writeCheckoutPaymentAttempt,
} from "../src/checkout-persistence.ts";
import { CommerceHttpApi } from "../src/http.ts";
import {
  listFulfillments,
  listOrders,
  listPayments,
} from "../src/commerce-persistence.ts";
import {
  listInventoryMovements,
  listInventoryLots,
  readInventoryLot,
  readInventoryPositionForItemLocation,
} from "../src/inventory-persistence.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import {
  type MerchantPaymentRefundCommand,
  type MerchantInPersonCollectionCommand,
  type MerchantPaymentReconciliationCommand,
  type MerchantPaymentSessionCommand,
  type PaymentGateway,
  type PaymentRefundGateway,
  type InPersonCollectionGateway,
} from "../src/payments/provider.ts";
import type {
  CommercePaymentCaptureResultV1,
  CommercePaymentRefundResultV1,
  CommercePaymentSessionResultV1,
} from "@purin-labs/commerce-client";
import type { Variant, VariantBy } from "@purin-labs/type-utils";

const AT = "2026-08-14T09:30:00.000Z";
const READY_AT = "2026-08-14T09:45:00.000Z";
const EXPIRES_AT = "2026-08-14T09:40:00.000Z";
const SERVICE_TOKEN = "checkout_persistence_service_token";
const TEST_CARRIER_SIGNING_KEY = "pantry-plan22-test-carrier-key";
const TEST_BUYER_CONTACT = {
  kind: "email",
  email: "buyer@example.test",
} as const;
const TEST_BUYER_CONTACT_AUTHORITY = {
  kind: "provided",
  contact: { kind: "email", emailDigest: "a".repeat(64) },
} as const;
const TEST_GUEST_BUYER = {
  kind: "guest",
  contact: TEST_BUYER_CONTACT,
} as const;
const TEST_GUEST_BUYER_AUTHORITY = {
  kind: "guest",
  contactAuthority: TEST_BUYER_CONTACT_AUTHORITY,
} as const;

type ProductionInventoryMovement = CommerceInventoryMovementV1 &
  Readonly<{
    change: Variant<
      CommerceInventoryMovementV1["change"],
      "increase" | "decrease"
    > &
      Readonly<{ reason: Readonly<{ kind: "production" }> }>;
  }>;

function isProductionInventoryMovement(
  movement: CommerceInventoryMovementV1,
): movement is ProductionInventoryMovement {
  switch (movement.change.kind) {
    case "increase":
    case "decrease":
      return movement.change.reason.kind === "production";
  }
}

const PAYMENT_BINDING: VariantBy<
  OnlinePaymentBinding,
  "provider",
  "stripe_online"
> = {
  provider: "stripe_online",
  account: {
    integrationAccountId: "integration_stripe_test",
    providerAccountId: "acct_stripe_test",
    environment: "development",
    capabilityRevision: 1,
    country: "JP",
    currency: "JPY",
  },
  collection: "embedded_tokenization",
};

const ALTERNATE_PAYMENT_BINDING: VariantBy<
  OnlinePaymentBinding,
  "provider",
  "stripe_online"
> = {
  ...PAYMENT_BINDING,
  account: {
    ...PAYMENT_BINDING.account,
    providerAccountId: "acct_stripe_other",
  },
};

const IN_PERSON_PAYMENT_BINDING: VariantBy<
  InPersonPaymentBinding,
  "provider",
  "square_terminal"
> = {
  provider: "square_terminal",
  account: {
    integrationAccountId: "integration_square_terminal_test",
    providerAccountId: "merchant_square_terminal_test",
    environment: "development",
    capabilityRevision: 1,
    country: "JP",
    currency: "JPY",
  },
  locationId: "location_square_terminal_test",
  deviceId: "device_square_terminal_test",
  transport: "server_terminal",
};

class DigestSigner implements CommerceSigner {
  readonly keyId = "key_checkout_persistence_test";
  readonly publicKeyB64 = Buffer.alloc(32, 11).toString("base64url");

  sign(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
  }
}

class TestPaymentGateway implements PaymentGateway, PaymentRefundGateway {
  #result: CommercePaymentCaptureResultV1 = {
    schemaVersion: "commerce.payment-capture-result.v1",
    kind: "captured",
    providerPaymentReference: "pi_test_default",
    capturedAt: AT,
  };
  #calls = 0;
  #refundRequests: MerchantPaymentRefundCommand[] = [];
  #refundFailure: Error | undefined;
  #refundResults: CommercePaymentRefundResultV1[] = [];
  #refundedAt = AT;
  #sessionCalls = 0;
  readonly #paymentProviderBindingId: string;
  readonly #paymentBinding: OnlinePaymentBinding;

  constructor(
    paymentProviderBindingId = "payment_binding_primary_online",
    paymentBinding: OnlinePaymentBinding = PAYMENT_BINDING,
  ) {
    this.#paymentProviderBindingId = paymentProviderBindingId;
    this.#paymentBinding = paymentBinding;
  }

  get calls(): number {
    return this.#calls;
  }

  get refundRequests(): readonly MerchantPaymentRefundCommand[] {
    return this.#refundRequests;
  }

  get sessionCalls(): number {
    return this.#sessionCalls;
  }

  setResult(result: CommercePaymentCaptureResultV1): void {
    this.#result = result;
  }

  failNextRefund(error: Error): void {
    this.#refundFailure = error;
  }

  setRefundedAt(refundedAt: string): void {
    this.#refundedAt = refundedAt;
  }

  queueRefundResult(result: CommercePaymentRefundResultV1): void {
    this.#refundResults.push(result);
  }

  async binding(
    paymentProviderBindingId: string,
  ): Promise<OnlinePaymentBinding | null> {
    return paymentProviderBindingId === this.#paymentProviderBindingId
      ? this.#paymentBinding
      : null;
  }

  async createSession(
    request: MerchantPaymentSessionCommand,
  ): Promise<CommercePaymentSessionResultV1> {
    this.#sessionCalls += 1;
    return {
      schemaVersion: "commerce.payment-session-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "embedded_public_session",
        providerSessionReference: `pi_test_${request.providerRequestId}`,
        publicConfiguration: {
          provider: "stripe_online",
          clientSecret: `pi_test_${request.providerRequestId}_secret_test`,
          publishableKey: "pk_test_checkout",
          connectedAccountId: this.#paymentBinding.account.providerAccountId,
        },
        expiresAt: request.expiresAt,
      },
    };
  }

  async reconcile(
    _request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1> {
    this.#calls += 1;
    return this.#result;
  }

  async refund(
    request: MerchantPaymentRefundCommand,
  ): Promise<CommercePaymentRefundResultV1> {
    this.#refundRequests.push(request);
    const failure = this.#refundFailure;
    this.#refundFailure = undefined;
    if (failure !== undefined) throw failure;
    const queuedResult = this.#refundResults.shift();
    if (queuedResult !== undefined) return queuedResult;
    return {
      schemaVersion: "commerce.payment-refund-result.v1",
      kind: "refunded",
      providerRefundReference: `refund_${request.refundAttemptId}`,
      money: request.refundMoney,
      refundedAt: this.#refundedAt,
    };
  }
}

class TestInPersonCollectionGateway implements InPersonCollectionGateway {
  readonly requests: MerchantInPersonCollectionCommand[] = [];
  readonly #effects = new Set<string>();

  get effectCount(): number {
    return this.#effects.size;
  }

  async createInPersonCollection(
    request: MerchantInPersonCollectionCommand,
  ): Promise<CommerceInPersonCollectionResultV1> {
    this.requests.push(request);
    this.#effects.add(request.idempotencyKey);
    return {
      schemaVersion: "commerce.in-person-collection-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "server_terminal_checkout",
        providerCheckoutReference: `terminal_checkout_${request.paymentAttemptId}`,
        deviceId:
          request.paymentBinding.provider === "gmo_stera"
            ? request.paymentBinding.deviceSourceKey
            : (request.paymentBinding.deviceId ?? "square_pos_app"),
        expiresAt: request.expiresAt,
      },
    };
  }
}

class TestClock {
  #value = AT;

  read = (): string => this.#value;

  set(value: string): void {
    this.#value = value;
  }
}

it("rejects buyer payment when the pinned profile binding ID is unavailable", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-payment-binding-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway("payment_binding_other");
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    const buyerClient = storefrontClient(authority);
    const buyerSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!buyerSession.ok) throw new Error("Buyer session request failed");
    const checkout = await createPickupCheckoutFromLines(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "payment_binding_id_mismatch_checkout",
        buyer: TEST_GUEST_BUYER,
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 1 },
        ],
      },
    );
    if (!checkout.ok) throw new Error("Buyer checkout request failed");
    const result = await buyerClient.createPaymentSession(
      "merchant_cookie",
      "storefront_cafe",
      checkout.value.checkoutId,
      buyerSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: "payment_binding_id_mismatch_payment",
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
        returnUrl: "https://storefront.test/payment-return",
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      },
    });
    expect(paymentGateway.sessionCalls).toBe(0);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("rejects a pending buyer payment whose concrete binding changed", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-payment-binding-pending-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway(
    "payment_binding_primary_online",
    ALTERNATE_PAYMENT_BINDING,
  );
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    const buyerClient = storefrontClient(authority);
    const buyerSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!buyerSession.ok) throw new Error("Buyer session request failed");
    const checkout = await createPickupCheckoutFromLines(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "pending_payment_binding_mismatch_checkout",
        buyer: TEST_GUEST_BUYER,
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 1 },
        ],
      },
    );
    if (!checkout.ok) throw new Error("Buyer checkout request failed");
    const paymentIdempotencyKey = "pending_payment_binding_mismatch_payment";
    const paymentAttemptId = `payment_attempt_${sha256(
      JSON.stringify([
        "merchant_cookie",
        "storefront_cafe",
        "buyer_session_checkout_test",
        checkout.value.checkoutId,
        paymentIdempotencyKey,
      ]),
    )}`;
    requireApplied(
      authority.beginCheckoutPayment({
        schemaVersion: "commerce.begin-checkout-payment.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: requireMerchantRevision(authority),
        idempotencyKey: "internal_pending_payment_binding_mismatch",
        requestedAt: AT,
        checkoutId: checkout.value.checkoutId,
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
        paymentAttemptId,
        providerRequestId: "provider_pending_payment_binding_mismatch",
        amount: checkout.value.quote.totals.total,
        paymentBinding: PAYMENT_BINDING,
      }),
    );
    const result = await buyerClient.createPaymentSession(
      "merchant_cookie",
      "storefront_cafe",
      checkout.value.checkoutId,
      buyerSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: paymentIdempotencyKey,
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
        returnUrl: "https://storefront.test/payment-return",
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      },
    });
    expect(paymentGateway.sessionCalls).toBe(0);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("collects and replays one configured in-person checkout through the shared payment evidence", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-in-person-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const inPersonCollectionGateway = new TestInPersonCollectionGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    inPersonCollectionGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    const client = checkoutClient(authority);
    const command = collectInPersonCheckoutPaymentCommand();
    const first = await client.collectInPersonCheckoutPayment(
      clientInput(command),
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.in-person-checkout-payment-collection.v1",
        outcome: "ready",
        mutationOutcome: "applied",
        paymentAttemptId: "payment_attempt_cookie",
        receipt: {
          commandKind: "collect_in_person_checkout_payment",
          merchantRevision: 6,
          resource: {
            kind: "checkout_payment_attempt",
            id: "payment_attempt_cookie",
            revision: 1,
          },
        },
        session: {
          kind: "server_terminal_checkout",
          providerCheckoutReference: "terminal_checkout_payment_attempt_cookie",
          deviceId: "device_square_terminal_test",
          expiresAt: EXPIRES_AT,
        },
      },
    });
    const replay = await client.collectInPersonCheckoutPayment(
      clientInput(command),
    );
    expect(replay).toMatchObject({
      ok: true,
      value: {
        outcome: "ready",
        mutationOutcome: "replayed",
        paymentAttemptId: "payment_attempt_cookie",
        session: {
          providerCheckoutReference: "terminal_checkout_payment_attempt_cookie",
        },
      },
    });
    expect(inPersonCollectionGateway.requests).toHaveLength(2);
    expect(inPersonCollectionGateway.effectCount).toBe(1);
    expect(inPersonCollectionGateway.requests[0]).toEqual({
      merchantId: "merchant_cookie",
      providerRequestId: "square_terminal_request_cookie",
      paymentAttemptId: "payment_attempt_cookie",
      checkoutId: "checkout_cookie",
      idempotencyKey: "payment_cookie",
      money: checkoutQuote().totals.total,
      paymentBinding: IN_PERSON_PAYMENT_BINDING,
      expiresAt: EXPIRES_AT,
      receiptSummary: {
        merchantName: "Cafe storefront",
        lineCount: 1,
      },
    });
    const attempt = readCheckoutPaymentAttempt(
      database,
      "merchant_cookie",
      "payment_attempt_cookie",
    );
    expect(attempt?.binding).toMatchObject({
      quoteDigest: command.quoteDigest,
      amount: checkoutQuote().totals.total,
      paymentBinding: IN_PERSON_PAYMENT_BINDING,
    });
    expect(
      await client.recordCheckoutPaymentCapture(
        clientInput(recordCheckoutPaymentCaptureCommand()),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await client.placePaidCheckout(clientInput(placePaidCheckoutCommand())),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(listOrders(database, "merchant_cookie")).toMatchObject([
      {
        id: "order_cookie",
        origin: {
          kind: "online",
          configuration: {
            kind: "checkout_profile",
            checkoutProfile: checkoutProfileReference(),
          },
        },
      },
    ]);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("round-trips one normalized quote-bound pickup cohort", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-checkout-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const clock = new TestClock();
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: clock.read,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    const buyerClient = storefrontClient(authority);
    const buyerSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!buyerSession.ok) throw new Error("Buyer session request failed");
    const catalog = await buyerClient.readCatalog(
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
    );
    expect(catalog).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-catalog.v1",
        storefront: {
          storefrontId: "storefront_cafe",
          revision: 1,
          name: "Cafe storefront",
          fulfillment: "pickup",
        },
        listings: [
          {
            productId: "product_cookie",
            productRevision: 1,
            title: "Cookie",
            description: "One cookie.",
            variantId: "variant_cookie_single",
            variantRevision: 1,
            variantTitle: "Cookie",
            sku: "COOKIE",
            offerId: "offer_cookie_cafe",
            offerRevision: 1,
            price: { amountMinor: 450, currency: "JPY" },
            compareAtPrice: null,
            handle: null,
            options: [],
            media: [],
            availability: "available",
          },
        ],
        menus: [],
      },
    });
    expect(
      await buyerClient.readCatalog(
        "merchant_cookie",
        "storefront_cafe",
        `${buyerSession.value.token}tampered`,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "http", status: 401, message: "Unauthorized" },
    });
    const command = createPickupCheckoutCommand();
    const client = checkoutClient(authority);
    const clientResult = await client.createPickupCheckout(
      clientInput(command),
    );
    if (!clientResult.ok)
      throw new Error("Pickup checkout client request failed");
    const created = clientResult.value;
    expect(created).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "create_pickup_checkout",
        previousMerchantRevision: 4,
        merchantRevision: 5,
        resource: { kind: "checkout", id: "checkout_cookie", revision: 1 },
      },
    });
    expect(authority.createPickupCheckout(command)).toEqual(
      created.outcome === "applied"
        ? { outcome: "replayed", receipt: created.receipt }
        : created,
    );
    const paymentCommand = beginCheckoutPaymentCommand();
    const paymentResult = await client.beginCheckoutPayment(
      clientInput(paymentCommand),
    );
    if (!paymentResult.ok)
      throw new Error("Checkout payment client request failed");
    expect(paymentResult.value).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "begin_checkout_payment",
        previousMerchantRevision: 5,
        merchantRevision: 6,
        resource: {
          kind: "checkout_payment_attempt",
          id: "payment_attempt_cookie",
          revision: 1,
        },
      },
    });
    expect(
      await client.beginCheckoutPayment(clientInput(paymentCommand)),
    ).toEqual({
      ok: true,
      value:
        paymentResult.value.outcome === "applied"
          ? { outcome: "replayed", receipt: paymentResult.value.receipt }
          : paymentResult.value,
    });
    expect(
      authority.beginCheckoutPayment(staleCheckoutPaymentCommand()),
    ).toEqual({
      outcome: "rejected",
      error: {
        code: "invalid_transition",
        machine: "checkout",
        state: "payment_pending",
        event: "begin_payment",
      },
    });
    const captureRecordCommand = recordCheckoutPaymentCaptureCommand();
    const captureRecordResult = await client.recordCheckoutPaymentCapture(
      clientInput(captureRecordCommand),
    );
    if (!captureRecordResult.ok)
      throw new Error("Checkout capture-record client request failed");
    expect(captureRecordResult.value).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "record_checkout_payment_capture",
        previousMerchantRevision: 6,
        merchantRevision: 7,
        deliveryId: expect.stringMatching(/^delivery_/),
        resource: {
          kind: "checkout_payment_attempt",
          id: "payment_attempt_cookie",
          revision: 2,
        },
      },
    });
    // The payment start and the capture reach the event feed, and so the
    // merchant's webhooks, naming the payment attempt.
    const paymentEvents = (
      await authority.readEvents("merchant_cookie", undefined, 200, undefined)
    ).events.filter((event) =>
      ["checkout.payment_started", "payment.captured"].includes(event.kind),
    );
    expect(paymentEvents.map((event) => [event.kind, event.resources])).toEqual(
      [
        [
          "checkout.payment_started",
          [
            {
              kind: "checkout_payment_attempt",
              id: "payment_attempt_cookie",
              revision: 1,
            },
          ],
        ],
        [
          "payment.captured",
          [
            {
              kind: "checkout_payment_attempt",
              id: "payment_attempt_cookie",
              revision: 2,
            },
          ],
        ],
      ],
    );
    expect(
      await client.recordCheckoutPaymentCapture(
        clientInput(captureRecordCommand),
      ),
    ).toEqual({
      ok: true,
      value:
        captureRecordResult.value.outcome === "applied"
          ? { outcome: "replayed", receipt: captureRecordResult.value.receipt }
          : captureRecordResult.value,
    });
    const placementCommand = placePaidCheckoutCommand();
    const placementResult = await client.placePaidCheckout(
      clientInput(placementCommand),
    );
    if (!placementResult.ok)
      throw new Error("Paid checkout placement client request failed");
    expect(placementResult.value).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "place_paid_checkout",
        previousMerchantRevision: 7,
        merchantRevision: 8,
        resource: { kind: "commerce_order", id: "order_cookie", revision: 1 },
      },
    });
    expect(
      await client.placePaidCheckout(clientInput(placementCommand)),
    ).toEqual({
      ok: true,
      value:
        placementResult.value.outcome === "applied"
          ? { outcome: "replayed", receipt: placementResult.value.receipt }
          : placementResult.value,
    });
    const readyCommand = markPickupReadyCommand();
    const readyResult = await client.markPickupReady(clientInput(readyCommand));
    if (!readyResult.ok)
      throw new Error("Pickup readiness client request failed");
    expect(readyResult.value).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "mark_pickup_ready",
        previousMerchantRevision: 8,
        merchantRevision: 9,
        resource: {
          kind: "fulfillment",
          id: "fulfillment_cookie",
          revision: 2,
        },
      },
    });
    expect(await client.markPickupReady(clientInput(readyCommand))).toEqual({
      ok: true,
      value:
        readyResult.value.outcome === "applied"
          ? { outcome: "replayed", receipt: readyResult.value.receipt }
          : readyResult.value,
    });
    requireApplied(
      authority.receiveInventory(receiveFinerScaleInventoryCommand()),
    );
    expect(authority.completePickup(earlyPickupCompletionCommand())).toEqual({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "pickupCompletion.lifecycle",
      },
    });
    const completionCommand = completePickupCommand();
    const completionResult = await client.completePickup(
      clientInput(completionCommand),
    );
    if (!completionResult.ok)
      throw new Error("Pickup completion client request failed");
    if (completionResult.value.outcome === "rejected") {
      throw new Error(
        `Pickup completion rejected: ${JSON.stringify(completionResult.value.error)}`,
      );
    }
    if (completionResult.value.outcome !== "applied") {
      throw new Error("First pickup completion request unexpectedly replayed");
    }
    expect(completionResult.value).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "complete_pickup",
        previousMerchantRevision: 10,
        merchantRevision: 11,
        resource: {
          kind: "fulfillment",
          id: "fulfillment_cookie",
          revision: 3,
        },
      },
    });
    expect(await client.completePickup(clientInput(completionCommand))).toEqual(
      {
        ok: true,
        value:
          completionResult.value.outcome === "applied"
            ? { outcome: "replayed", receipt: completionResult.value.receipt }
            : completionResult.value,
      },
    );
    const completionDelivery = authority
      .pendingDeliveries("merchant_cookie")
      .find(
        deliveryHasId.bind(
          undefined,
          completionResult.value.receipt.deliveryId,
        ),
      );
    expect(completionDelivery?.observations.map(observationKind)).toEqual([
      "commerce_order",
      "fulfillment",
      "inventory_movement",
      "inventory_lot",
      "inventory_position",
    ]);

    expect(
      readStorefront(database, "merchant_cookie", "storefront_cafe"),
    ).toEqual(storefront());
    expect(
      readConsumptionPlan(
        database,
        "merchant_cookie",
        "consumption_plan_cookie",
      ),
    ).toEqual(consumptionPlan());
    expect(readCart(database, "merchant_cookie", "cart_cookie")).toEqual(
      cart(),
    );
    expect(
      readInventoryAllocation(database, "merchant_cookie", allocationId()),
    ).toEqual(committedAllocation());
    expect(
      readCheckout(database, "merchant_cookie", "checkout_cookie"),
    ).toEqual(acceptedCheckout());
    expect(
      readCheckoutPaymentAttempt(
        database,
        "merchant_cookie",
        "payment_attempt_cookie",
      ),
    ).toEqual(capturedPaymentAttempt());
    expect(listInventoryMovements(database, "merchant_cookie")).toContainEqual({
      id: saleMovementId(),
      inventoryItemId: "inventory_cookie",
      locationId: "location_cafe",
      change: {
        kind: "decrease",
        quantity: { amount: 1, scale: 0, unit: "gram" },
        reason: {
          kind: "sale",
          orderId: "order_cookie",
          orderLineId: orderLineId(),
        },
        lotAllocation: {
          kind: "allocated",
          lots: [
            {
              lotId: "lot_cookie",
              quantity: { amount: 1, scale: 0, unit: "gram" },
            },
          ],
        },
      },
      occurredAt: AT,
      idempotencyKey: `complete_cookie:${allocationId()}`,
    });
    expect(
      readInventoryLot(database, "merchant_cookie", "lot_cookie"),
    ).toMatchObject({
      id: "lot_cookie",
      revision: 2,
      remainingQuantity: { amount: 9, scale: 0, unit: "gram" },
      lifecycle: { state: "available" },
    });
    expect(authority.readSnapshot("merchant_cookie")).toMatchObject({
      merchantRevision: 11,
      resources: {
        orders: [
          {
            id: "order_cookie",
            revision: 2,
            origin: {
              kind: "online",
              salesChannelId: "channel_cafe",
              storefrontId: "storefront_cafe",
              checkoutId: "checkout_cookie",
              configuration: {
                kind: "checkout_profile",
                checkoutProfile: checkoutProfileReference(),
              },
            },
            buyer: { kind: "guest" },
            lineItems: [
              {
                id: orderLineId(),
                source: { kind: "catalog", variantId: "variant_cookie_single" },
                quantity: { amount: 1, scale: 0, unit: "each" },
                fulfilledQuantity: { amount: 1, scale: 0, unit: "each" },
                tax: { amountMinor: 45, currency: "JPY" },
                lineTotal: { amountMinor: 450, currency: "JPY" },
              },
            ],
            totals: {
              subtotal: { amountMinor: 450, currency: "JPY" },
              tax: { amountMinor: 45, currency: "JPY" },
              total: { amountMinor: 495, currency: "JPY" },
            },
            lifecycle: { state: "fulfilled", fulfilledAt: AT },
          },
        ],
        payments: [
          {
            id: "payment_cookie_record",
            revision: 1,
            orderId: "order_cookie",
            amount: { amountMinor: 495, currency: "JPY" },
            lifecycle: { state: "captured", capturedAt: AT },
          },
        ],
        fulfillments: [
          {
            id: "fulfillment_cookie",
            orderId: "order_cookie",
            lineItems: [{ lineItemId: orderLineId(), quantity: 1 }],
            locationId: "location_cafe",
            expectedBy: READY_AT,
            revision: 3,
            lifecycle: { state: "completed", completedAt: AT },
          },
        ],
        inventoryPositions: [
          {
            balance: {
              kind: "accounted",
              onHand: { amount: 95, scale: 1, unit: "gram" },
              allocated: { amount: 0, scale: 1, unit: "gram" },
              available: { amount: 95, scale: 1, unit: "gram" },
            },
          },
        ],
      },
    });
    const declineCheckout = createFailureCheckoutCommand(11, "decline");
    requireApplied(authority.createPickupCheckout(declineCheckout));
    const declineQuote = requireQuotedCheckout(
      readCheckout(database, "merchant_cookie", "checkout_decline"),
    );
    const declinePayment = failurePaymentCommand(12, declineQuote, "decline");
    requireApplied(authority.beginCheckoutPayment(declinePayment));
    expect(
      authority.resolveCheckoutPayment(
        indeterminatePaymentCommand(declineQuote, "2026-08-14T09:29:00.000Z"),
      ),
    ).toEqual({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkoutPayment.resolution",
      },
    });
    const indeterminate = indeterminatePaymentCommand(
      declineQuote,
      "2026-08-14T09:31:00.000Z",
    );
    requireApplied(authority.resolveCheckoutPayment(indeterminate));
    expect(
      readInventoryAllocation(
        database,
        "merchant_cookie",
        failureAllocationId("decline"),
      )?.lifecycle.state,
    ).toBe("held");
    const declined = declinedPaymentCommand(declineQuote);
    clock.set("2026-08-14T09:32:00.000Z");
    const declinedResult = await client.resolveCheckoutPayment(
      clientInput(declined),
    );
    clock.set(AT);
    expect(declinedResult).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "resolve_checkout_payment",
          merchantRevision: 15,
        },
      },
    });
    expect(await client.resolveCheckoutPayment(clientInput(declined))).toEqual({
      ok: true,
      value:
        declinedResult.ok && declinedResult.value.outcome === "applied"
          ? { outcome: "replayed", receipt: declinedResult.value.receipt }
          : declinedResult.ok
            ? declinedResult.value
            : undefined,
    });
    expect(
      readCheckoutPaymentAttempt(
        database,
        "merchant_cookie",
        "payment_attempt_decline",
      )?.lifecycle,
    ).toEqual({
      state: "declined",
      reasonCode: "card_declined",
      declinedAt: "2026-08-14T09:32:00.000Z",
    });
    expect(
      readInventoryAllocation(
        database,
        "merchant_cookie",
        failureAllocationId("decline"),
      )?.lifecycle.state,
    ).toBe("released");

    const expiryCheckout = createFailureCheckoutCommand(15, "expiry");
    requireApplied(authority.createPickupCheckout(expiryCheckout));
    const expiryQuote = requireQuotedCheckout(
      readCheckout(database, "merchant_cookie", "checkout_expiry"),
    );
    clock.set(EXPIRES_AT);
    const expiryResult = await client.expireCheckout(
      clientInput(expireCheckoutCommand(expiryQuote)),
    );
    clock.set(AT);
    expect(expiryResult).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: { commandKind: "expire_checkout", merchantRevision: 17 },
      },
    });
    expect(
      readInventoryAllocation(
        database,
        "merchant_cookie",
        failureAllocationId("expiry"),
      )?.lifecycle.state,
    ).toBe("released");
    expect(authority.readSnapshot("merchant_cookie")).toMatchObject({
      merchantRevision: 17,
      resources: {
        inventoryPositions: [
          {
            balance: {
              onHand: { amount: 95, scale: 1, unit: "gram" },
              allocated: { amount: 0, scale: 1, unit: "gram" },
              available: { amount: 95, scale: 1, unit: "gram" },
            },
          },
        ],
      },
    });
    requireApplied(
      authority.createPickupCheckout(
        createFailureCheckoutCommand(17, "reconcile"),
      ),
    );
    const reconciliationQuote = requireQuotedCheckout(
      readCheckout(database, "merchant_cookie", "checkout_reconcile"),
    );
    requireApplied(
      authority.beginCheckoutPayment(
        failurePaymentCommand(18, reconciliationQuote, "reconcile"),
      ),
    );
    requireApplied(
      authority.resolveCheckoutPayment(
        reconciliationIndeterminateCommand(reconciliationQuote),
      ),
    );
    clock.set("2026-08-14T09:32:00.000Z");
    const reconciliationCaptureRecord =
      await client.recordCheckoutPaymentCapture(
        clientInput(reconciliationCaptureRecordCommand(reconciliationQuote)),
      );
    clock.set(AT);
    expect(reconciliationCaptureRecord).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "record_checkout_payment_capture",
          merchantRevision: 21,
        },
      },
    });
    const reconciliationPlacement = await client.placePaidCheckout(
      clientInput(reconciliationPlacementCommand(reconciliationQuote)),
    );
    expect(reconciliationPlacement).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: { commandKind: "place_paid_checkout", merchantRevision: 22 },
      },
    });
    expect(
      readCheckoutPaymentAttempt(
        database,
        "merchant_cookie",
        "payment_attempt_reconcile",
      )?.lifecycle,
    ).toEqual({
      state: "captured",
      providerPaymentReference: "pi_reconciled_captured",
      capturedAt: "2026-08-14T09:32:00.000Z",
    });
    expect(
      readInventoryAllocation(
        database,
        "merchant_cookie",
        failureAllocationId("reconcile"),
      )?.lifecycle.state,
    ).toBe("allocated_to_order");
    const publicCheckoutCommand = {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1" as const,
      idempotencyKey: "public_cookie_checkout",
      buyer: TEST_GUEST_BUYER,
      lines: [
        {
          kind: "catalog" as const,
          variantId: "variant_cookie_single",
          quantity: 1,
        },
      ],
    };
    const publicCheckout = await createPickupCheckoutFromLines(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
      publicCheckoutCommand,
    );
    expect(publicCheckout).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-quoted-checkout.v1",
        revision: 1,
        state: "quoted",
        quote: {
          lines: [
            {
              kind: "catalog",
              variantId: "variant_cookie_single",
              quantity: 1,
              unitPrice: { amountMinor: 450, currency: "JPY" },
            },
          ],
          totals: { total: { amountMinor: 495, currency: "JPY" } },
          pickup: { locationId: "location_cafe", readyAt: READY_AT },
          expiresAt: EXPIRES_AT,
        },
      },
    });
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        buyerSession.value.token,
        publicCheckoutCommand,
      ),
    ).toEqual(publicCheckout);
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        buyerSession.value.token,
        {
          ...publicCheckoutCommand,
          buyer: {
            kind: "guest",
            contact: {
              kind: "email_and_phone",
              email: "buyer@example.test",
              phone: "+819012345678",
            },
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "idempotency_conflict",
          idempotencyKey: expect.stringMatching(/^buyer_checkout_/u),
        },
      },
    });
    if (!publicCheckout.ok) throw new Error("Public checkout request failed");
    expect(
      readCheckout(
        database,
        "merchant_cookie",
        publicCheckout.value.checkoutId,
      ),
    ).toMatchObject({
      source: {
        kind: "online",
        buyerSessionDigest: buyerSessionDigest(),
        checkoutProfile: checkoutProfileReference(),
      },
    });
    const sourceProfile = authority.readCheckoutProfile(
      "merchant_cookie",
      checkoutProfileReference().checkoutProfileId,
      checkoutProfileReference().revision,
    );
    if (sourceProfile === undefined)
      throw new Error("Source checkout profile was unavailable");
    expect(
      authority.createCheckoutProfileDraft({
        merchantId: "merchant_cookie",
        checkoutProfileId: "checkout_profile_storefront_cafe_replacement",
        name: "Replacement cafe checkout",
        configuration: sourceProfile.configuration,
        createdAt: AT,
      }),
    ).toMatchObject({ ok: true, value: { lifecycle: { state: "draft" } } });
    const replacementDraft = authority.readCheckoutProfile(
      "merchant_cookie",
      "checkout_profile_storefront_cafe_replacement",
      1,
    );
    if (replacementDraft === undefined)
      throw new Error("Replacement checkout profile was unavailable");
    expect(
      authority.replaceCheckoutProfileDraft({
        merchantId: "merchant_cookie",
        checkoutProfileId: "checkout_profile_storefront_cafe_replacement",
        expectedRevision: 1,
        name: replacementDraft.name,
        configuration: {
          ...replacementDraft.configuration,
          buyerPolicy: {
            kind: "guest_or_account",
            requiredContact: "email_and_phone_required",
            savedAddressPolicy: "enabled",
          },
          cartPolicy: {
            kind: "single_fulfillment",
            minimumLines: 1,
            maximumLines: 1,
            maximumTotalQuantity: 100,
          },
        },
        updatedAt: AT,
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(
      authority.publishCheckoutProfile({
        merchantId: "merchant_cookie",
        checkoutProfileId: "checkout_profile_storefront_cafe_replacement",
        expectedRevision: 2,
        publishedAt: AT,
        publishedBy: "operator_checkout_test",
      }),
    ).toMatchObject({ ok: true, value: { lifecycle: { state: "published" } } });
    expect(
      authority.activateCheckoutProfile({
        merchantId: "merchant_cookie",
        storefrontId: "storefront_cafe",
        checkoutProfileId: "checkout_profile_storefront_cafe_replacement",
        checkoutProfileRevision: 2,
        activatedAt: AT,
        activatedBy: "operator_checkout_test",
      }),
    ).toMatchObject({ ok: true });
    const replacementSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    expect(replacementSession).toMatchObject({
      ok: true,
      value: {
        checkoutProfile: {
          checkoutProfileId: "checkout_profile_storefront_cafe_replacement",
          revision: 2,
        },
      },
    });
    if (!replacementSession.ok)
      throw new Error("Replacement buyer session was unavailable");
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        replacementSession.value.token,
        {
          schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
          idempotencyKey: "replacement_profile_requires_phone",
          buyer: TEST_GUEST_BUYER,
          lines: [publicCheckoutCommand.lines[0]!],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkoutProfile.buyerPolicy",
        },
      },
    });
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        replacementSession.value.token,
        {
          schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
          idempotencyKey: "replacement_profile_rejects_multiple_lines",
          buyer: {
            kind: "guest",
            contact: {
              kind: "email_and_phone",
              email: "buyer@example.test",
              phone: "+819012345678",
            },
          },
          lines: [
            publicCheckoutCommand.lines[0]!,
            publicCheckoutCommand.lines[0]!,
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkoutProfile.cartPolicy",
        },
      },
    });
    const publicPaymentCommand = {
      schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
      idempotencyKey: "public_cookie_payment",
      checkoutRevision: publicCheckout.value.revision,
      quoteDigest: publicCheckout.value.quote.quoteDigest,
    };
    const publicPaymentSession = await buyerClient.createPaymentSession(
      "merchant_cookie",
      "storefront_cafe",
      publicCheckout.value.checkoutId,
      buyerSession.value.token,
      {
        ...publicPaymentCommand,
        returnUrl: "https://storefront.test/payment-return",
      },
    );
    expect(publicPaymentSession).toMatchObject({
      ok: true,
      value: { state: "ready", checkoutId: publicCheckout.value.checkoutId },
    });
    if (
      !publicPaymentSession.ok ||
      publicPaymentSession.value.state !== "ready"
    ) {
      throw new Error("Public payment session was unavailable");
    }
    expect(
      await buyerClient.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        buyerSession.value.token,
      ),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-checkout-recovery.v1",
        checkout: publicCheckout.value,
        progress: {
          state: "payment_pending",
          payment: {
            state: "pending",
            paymentAttemptId: publicPaymentSession.value.paymentAttemptId,
          },
        },
      },
    });
    expect(
      await buyerClient.createPaymentSession(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        buyerSession.value.token,
        {
          ...publicPaymentCommand,
          returnUrl: "https://storefront.test/payment-return",
        },
      ),
    ).toEqual(publicPaymentSession);
    const publicPlacement = await completeBuyerCheckout(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      publicCheckout.value.checkoutId,
      buyerSession.value.token,
      publicPaymentCommand,
    );
    expect(publicPlacement).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-payment-result.v1",
        state: "placed",
        checkoutId: publicCheckout.value.checkoutId,
        checkoutRevision: 3,
        placedAt: AT,
        total: { amountMinor: 495, currency: "JPY" },
        pickup: { locationId: "location_cafe", expectedBy: READY_AT },
      },
    });
    expect(
      await completeBuyerCheckout(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        buyerSession.value.token,
        publicPaymentCommand,
      ),
    ).toEqual(publicPlacement);
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        buyerSession.value.token,
        publicCheckoutCommand,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: { code: "idempotency_conflict" },
      },
    });
    expect(
      readCheckout(database, "merchant_cookie", publicCheckout.value.checkoutId)
        ?.lifecycle.state,
    ).toBe("accepted");
    if (!publicPlacement.ok || publicPlacement.value.state !== "placed") {
      throw new Error("Public placement was unavailable");
    }
    const publicOrderId = publicPlacement.value.orderId;
    expect(
      listOrders(database, "merchant_cookie").find(
        (order) => order.id === publicOrderId,
      ),
    ).toMatchObject({
      origin: {
        kind: "online",
        configuration: {
          kind: "checkout_profile",
          checkoutProfile: checkoutProfileReference(),
        },
      },
    });
    const recoveredBuyerClient = storefrontClient(authority);
    const recoveryToken = publicPlacement.value.orderRecovery.token;
    expect(
      await recoveredBuyerClient.readCatalog(
        "merchant_cookie",
        "storefront_cafe",
        recoveryToken,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "http", status: 401, message: "Unauthorized" },
    });
    const placedOrder = await recoveredBuyerClient.recoverOrder(
      "merchant_cookie",
      "storefront_cafe",
      publicCheckout.value.checkoutId,
      recoveryToken,
    );
    expect(placedOrder).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-order.v1",
        fulfillment: "pickup",
        state: "placed",
        checkoutId: publicCheckout.value.checkoutId,
        orderId: publicPlacement.value.orderId,
        paymentId: publicPlacement.value.paymentId,
        fulfillmentId: publicPlacement.value.fulfillmentId,
      },
    });
    expect(
      await recoveredBuyerClient.recoverOrder(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        recoveryToken,
      ),
    ).toEqual(placedOrder);
    expect(
      await recoveredBuyerClient.recoverOrder(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        `${buyerSession.value.token}tampered`,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "http", status: 401, message: "Unauthorized" },
    });
    const publicReadyRevision = requireMerchantRevision(authority);
    requireApplied(
      authority.markPickupReady({
        schemaVersion: "commerce.mark-pickup-ready.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: publicReadyRevision,
        idempotencyKey: "public_cookie_ready",
        requestedAt: AT,
        orderId: publicPlacement.value.orderId,
        orderRevision: 1,
        fulfillmentId: publicPlacement.value.fulfillmentId,
        fulfillmentRevision: 1,
      }),
    );
    expect(
      await recoveredBuyerClient.recoverOrder(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        recoveryToken,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-order.v1",
        fulfillment: "pickup",
        state: "ready_for_pickup",
        checkoutId: publicCheckout.value.checkoutId,
        readyAt: AT,
      },
    });
    requireApplied(
      authority.completePickup({
        schemaVersion: "commerce.complete-pickup.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: requireMerchantRevision(authority),
        idempotencyKey: "public_cookie_complete",
        requestedAt: AT,
        orderId: publicPlacement.value.orderId,
        orderRevision: 1,
        paymentId: publicPlacement.value.paymentId,
        paymentRevision: 1,
        fulfillmentId: publicPlacement.value.fulfillmentId,
        fulfillmentRevision: 2,
      }),
    );
    expect(
      await recoveredBuyerClient.recoverOrder(
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        recoveryToken,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-order.v1",
        fulfillment: "pickup",
        state: "completed",
        checkoutId: publicCheckout.value.checkoutId,
        completedAt: AT,
      },
    });
    expect(
      await completeBuyerCheckout(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        buyerSession.value.token,
        publicPaymentCommand,
      ),
    ).toEqual(publicPlacement);
    expect(
      await completeBuyerCheckout(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        publicCheckout.value.checkoutId,
        buyerSession.value.token,
        { ...publicPaymentCommand, quoteDigest: "quote_tampered" },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: { code: "idempotency_conflict" },
      },
    });

    paymentGateway.setResult({
      schemaVersion: "commerce.payment-capture-result.v1",
      kind: "declined",
      reason: "card_declined",
    });
    const declinedCheckout = await createPickupCheckoutFromLines(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
      { ...publicCheckoutCommand, idempotencyKey: "public_declined_checkout" },
    );
    if (!declinedCheckout.ok)
      throw new Error("Declined checkout request failed");
    const declinedPayment = await completeBuyerCheckout(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      declinedCheckout.value.checkoutId,
      buyerSession.value.token,
      {
        ...publicPaymentCommand,
        idempotencyKey: "public_declined_payment",
        checkoutRevision: declinedCheckout.value.revision,
        quoteDigest: declinedCheckout.value.quote.quoteDigest,
      },
    );
    expect(declinedPayment).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-payment-result.v1",
        state: "declined",
        checkoutId: declinedCheckout.value.checkoutId,
        reasonCode: "card_declined",
      },
    });
    expect(
      await buyerClient.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        declinedCheckout.value.checkoutId,
        buyerSession.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        checkout: { checkoutId: declinedCheckout.value.checkoutId },
        progress: {
          state: "payment_pending",
          payment: { state: "declined", reasonCode: "card_declined" },
        },
      },
    });
    expect(
      readCheckout(
        database,
        "merchant_cookie",
        declinedCheckout.value.checkoutId,
      )?.lifecycle.state,
    ).toBe("expired");
    expect(
      await createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        buyerSession.value.token,
        {
          ...publicCheckoutCommand,
          idempotencyKey: "public_declined_checkout",
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: { code: "idempotency_conflict" },
      },
    });
    expect(
      await buyerClient.readOrder(
        "merchant_cookie",
        "storefront_cafe",
        declinedCheckout.value.checkoutId,
        buyerSession.value.token,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "http", status: 404, message: "Order not found" },
    });
    expect(
      await recoveredBuyerClient.recoverOrder(
        "merchant_cookie",
        "storefront_cafe",
        declinedCheckout.value.checkoutId,
        recoveryToken,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "http", status: 401, message: "Unauthorized" },
    });

    paymentGateway.setResult({
      schemaVersion: "commerce.payment-capture-result.v1",
      kind: "indeterminate",
      reason: "provider_timeout",
      reconcileAfter: "2026-08-14T09:31:00.000Z",
    });
    const uncertainCheckout = await createPickupCheckoutFromLines(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      buyerSession.value.token,
      { ...publicCheckoutCommand, idempotencyKey: "public_uncertain_checkout" },
    );
    if (!uncertainCheckout.ok)
      throw new Error("Uncertain checkout request failed");
    const uncertainPaymentCommand = {
      ...publicPaymentCommand,
      idempotencyKey: "public_uncertain_payment",
      checkoutRevision: uncertainCheckout.value.revision,
      quoteDigest: uncertainCheckout.value.quote.quoteDigest,
    };
    const uncertainPayment = await completeBuyerCheckout(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      uncertainCheckout.value.checkoutId,
      buyerSession.value.token,
      uncertainPaymentCommand,
    );
    expect(uncertainPayment).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-payment-result.v1",
        state: "indeterminate",
        checkoutId: uncertainCheckout.value.checkoutId,
        reconcileAfter: "2026-08-14T09:31:00.000Z",
      },
    });
    expect(
      await buyerClient.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        uncertainCheckout.value.checkoutId,
        buyerSession.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        checkout: { checkoutId: uncertainCheckout.value.checkoutId },
        progress: {
          state: "payment_pending",
          payment: {
            state: "indeterminate",
            reconcileAfter: "2026-08-14T09:31:00.000Z",
          },
        },
      },
    });
    expect(
      await completeBuyerCheckout(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        uncertainCheckout.value.checkoutId,
        buyerSession.value.token,
        uncertainPaymentCommand,
      ),
    ).toEqual(uncertainPayment);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("holds inventory while processing payment recovers through an exact replay", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-processing-recovery-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const clock = new TestClock();
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: clock.read,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "commerce_processing_recovery_secret",
      now: clock.read,
      newSessionId: fixedBuyerSessionId,
    }),
    serviceToken: SERVICE_TOKEN,
  });
  const buyer = new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
  try {
    seedCookieAuthority(authority);
    const session = await buyer.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok)
      throw new Error("Processing recovery buyer session failed");
    const quoted = await createPickupCheckoutFromLines(
      buyer,
      "merchant_cookie",
      "storefront_cafe",
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "processing_recovery_checkout",
        buyer: TEST_GUEST_BUYER,
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 1 },
        ],
      },
    );
    if (!quoted.ok)
      throw new Error(
        `Processing recovery checkout failed: ${quoted.error.message}`,
      );
    const paymentCommand = {
      schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
      idempotencyKey: "processing_recovery_payment",
      checkoutRevision: quoted.value.revision,
      quoteDigest: quoted.value.quote.quoteDigest,
    };
    const paymentSession = await buyer.createPaymentSession(
      "merchant_cookie",
      "storefront_cafe",
      quoted.value.checkoutId,
      session.value.token,
      {
        ...paymentCommand,
        returnUrl: "https://storefront.test/payment-return",
      },
    );
    expect(paymentSession).toMatchObject({
      ok: true,
      value: { state: "ready", checkoutId: quoted.value.checkoutId },
    });
    const reconcileCommand = {
      schemaVersion: "commerce.reconcile-buyer-payment.v1" as const,
      idempotencyKey: paymentCommand.idempotencyKey,
      checkoutRevision: paymentCommand.checkoutRevision,
      quoteDigest: paymentCommand.quoteDigest,
      confirmation: { kind: "provider_ui_completed" as const },
    };
    paymentGateway.setResult({
      schemaVersion: "commerce.payment-capture-result.v1",
      kind: "processing",
      reason: "provider_processing",
      reconcileAfter: "2026-08-14T09:31:00.000Z",
    });
    const processing = await buyer.reconcilePayment(
      "merchant_cookie",
      "storefront_cafe",
      quoted.value.checkoutId,
      session.value.token,
      reconcileCommand,
    );
    expect(processing).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-payment-result.v1",
        state: "processing",
        checkoutId: quoted.value.checkoutId,
        reconcileAfter: "2026-08-14T09:31:00.000Z",
      },
    });
    const pendingCheckout = readCheckout(
      database,
      "merchant_cookie",
      quoted.value.checkoutId,
    );
    if (pendingCheckout?.lifecycle.state !== "payment_pending") {
      throw new Error(
        "Processing recovery checkout was not kept payment-pending",
      );
    }
    const paymentAttemptId = pendingCheckout.lifecycle.paymentAttemptId;
    const allocationId =
      pendingCheckout.lifecycle.quote.lines[0]?.allocationIds[0];
    if (allocationId === undefined)
      throw new Error("Processing recovery allocation was unavailable");
    expect(
      readCheckoutPaymentAttempt(database, "merchant_cookie", paymentAttemptId)
        ?.lifecycle,
    ).toEqual({
      state: "processing",
      reasonCode: "provider_processing",
      reconcileAfter: "2026-08-14T09:31:00.000Z",
    });
    expect(
      readInventoryAllocation(database, "merchant_cookie", allocationId)
        ?.lifecycle.state,
    ).toBe("held");

    expect(
      await buyer.reconcilePayment(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        reconcileCommand,
      ),
    ).toEqual(processing);
    expect(paymentGateway.calls).toBe(1);

    clock.set("2026-08-14T09:31:00.000Z");
    paymentGateway.setResult({
      schemaVersion: "commerce.payment-capture-result.v1",
      kind: "captured",
      providerPaymentReference: "pi_processing_recovered",
      capturedAt: clock.read(),
    });
    const placed = await buyer.reconcilePayment(
      "merchant_cookie",
      "storefront_cafe",
      quoted.value.checkoutId,
      session.value.token,
      reconcileCommand,
    );
    expect(placed).toMatchObject({
      ok: true,
      value: { state: "placed", checkoutId: quoted.value.checkoutId },
    });
    expect(paymentGateway.calls).toBe(2);
    expect(
      readCheckout(database, "merchant_cookie", quoted.value.checkoutId)
        ?.lifecycle.state,
    ).toBe("accepted");
    expect(
      readCheckoutPaymentAttempt(database, "merchant_cookie", paymentAttemptId)
        ?.lifecycle,
    ).toEqual({
      state: "captured",
      providerPaymentReference: "pi_processing_recovered",
      capturedAt: "2026-08-14T09:31:00.000Z",
    });
    expect(
      readInventoryAllocation(database, "merchant_cookie", allocationId)
        ?.lifecycle.state,
    ).toBe("allocated_to_order");
    expect(
      await buyer.reconcilePayment(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        reconcileCommand,
      ),
    ).toEqual(placed);
    expect(paymentGateway.calls).toBe(2);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("rejects tampered quote content before payment and placement effects", () => {
  const databasePath = join(
    tmpdir(),
    `commerce-checkout-quote-digest-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    const storedCheckout = readCheckout(
      database,
      "merchant_cookie",
      "checkout_cookie",
    );
    if (storedCheckout?.lifecycle.state !== "quoted") {
      throw new Error("Quote digest fixture checkout was unavailable");
    }
    const quote = storedCheckout.lifecycle.quote;
    const fulfillment = quote.fulfillment;
    if (fulfillment.kind !== "pickup") {
      throw new Error("Quote digest fixture checkout was not pickup");
    }
    const tamperedQuote: CheckoutQuoteSnapshot = {
      quoteDigest: "quote_tampered",
      checkoutRevision: quote.checkoutRevision,
      lines: quote.lines,
      totals: quote.totals,
      fulfillment: {
        kind: "pickup",
        promise: {
          locationId: fulfillment.promise.locationId,
          readyAt: "2026-08-14T10:00:00.000Z",
        },
      },
      quotedAt: quote.quotedAt,
      expiresAt: quote.expiresAt,
    };
    const tamperedQuotedCheckout: Checkout = {
      checkoutId: storedCheckout.checkoutId,
      source: storedCheckout.source,
      revision: storedCheckout.revision,
      lifecycle: {
        state: "quoted",
        quote: tamperedQuote,
      },
    };
    writeCheckout(database, "merchant_cookie", tamperedQuotedCheckout);

    expect(
      authority.beginCheckoutPayment({
        ...beginCheckoutPaymentCommand(),
        idempotencyKey: "payment_tampered_quote",
        quoteDigest: tamperedQuote.quoteDigest,
        paymentAttemptId: "payment_attempt_tampered_quote",
        providerRequestId: "stripe_request_tampered_quote",
      }),
    ).toEqual({
      outcome: "rejected",
      error: { code: "checkout_quote_mismatch", checkoutId: "checkout_cookie" },
    });
    expect(
      readCheckoutPaymentAttempt(
        database,
        "merchant_cookie",
        "payment_attempt_tampered_quote",
      ),
    ).toBeUndefined();
    expect(listOrders(database, "merchant_cookie")).toEqual([]);
    expect(listPayments(database, "merchant_cookie")).toEqual([]);

    const paymentPendingCheckout: Checkout = {
      checkoutId: tamperedQuotedCheckout.checkoutId,
      source: tamperedQuotedCheckout.source,
      revision: 2,
      lifecycle: {
        state: "payment_pending",
        quote: tamperedQuote,
        paymentAttemptId: "payment_attempt_tampered_placement",
      },
    };
    writeCheckout(database, "merchant_cookie", paymentPendingCheckout);
    writeCheckoutPaymentAttempt(database, "merchant_cookie", {
      paymentAttemptId: "payment_attempt_tampered_placement",
      revision: 2,
      binding: {
        checkoutId: "checkout_cookie",
        checkoutRevision: tamperedQuote.checkoutRevision,
        quoteDigest: tamperedQuote.quoteDigest,
        amount: tamperedQuote.totals.total,
        paymentBinding: PAYMENT_BINDING,
        providerRequestId: "stripe_request_tampered_placement",
        idempotencyKey: "payment_tampered_placement",
      },
      lifecycle: {
        state: "captured",
        providerPaymentReference: "pi_tampered_placement",
        capturedAt: AT,
      },
    });

    expect(
      authority.placePaidCheckout({
        ...placePaidCheckoutCommand(),
        expectedMerchantRevision: requireMerchantRevision(authority),
        idempotencyKey: "place_tampered_quote",
        checkoutRevision: 2,
        quoteDigest: tamperedQuote.quoteDigest,
        paymentAttemptId: "payment_attempt_tampered_placement",
        paymentAttemptRevision: 2,
        orderId: "order_tampered_quote",
        paymentId: "payment_tampered_quote",
        fulfillmentId: "fulfillment_tampered_quote",
      }),
    ).toEqual({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkoutPayment.binding",
      },
    });
    expect(listOrders(database, "merchant_cookie")).toEqual([]);
    expect(listPayments(database, "merchant_cookie")).toEqual([]);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("projects buyer-safe payment dispute states and closes on invalid money", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-payment-dispute-buyer-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    requireApplied(
      authority.beginCheckoutPayment(beginCheckoutPaymentCommand()),
    );
    requireApplied(
      authority.recordCheckoutPaymentCapture(
        recordCheckoutPaymentCaptureCommand(),
      ),
    );
    requireApplied(authority.placePaidCheckout(placePaidCheckoutCommand()));

    const buyerClient = storefrontClient(authority);
    const buyerSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!buyerSession.ok) throw new Error("Buyer session request failed");
    const orderBeforeDispute = await buyerClient.readOrder(
      "merchant_cookie",
      "storefront_cafe",
      "checkout_cookie",
      buyerSession.value.token,
    );
    expect(orderBeforeDispute).toMatchObject({
      ok: true,
      value: { state: "placed", paymentDisputes: [] },
    });

    const initial = cookiePaymentDisputeCommand(
      "payment_dispute_buyer_initial",
      {
        state: "action_required",
        observedAt: AT,
        responseDueAt: "2026-08-21T09:30:00.000Z",
      },
    );
    expect(authority.observePaymentDispute(initial).outcome).toBe("applied");
    const activeOrder = await buyerClient.readOrder(
      "merchant_cookie",
      "storefront_cafe",
      "checkout_cookie",
      buyerSession.value.token,
    );
    expect(activeOrder).toMatchObject({
      ok: true,
      value: {
        state: "placed",
        paymentDisputes: [
          {
            disputeId: expect.stringMatching(/^dispute_/),
            amount: { amountMinor: 495, currency: "JPY" },
            state: "action_required",
            observedAt: AT,
          },
        ],
      },
    });
    if (!activeOrder.ok) throw new Error("Active buyer Order read failed");
    expect(Object.keys(activeOrder.value.paymentDisputes[0] ?? {})).toEqual([
      "disputeId",
      "amount",
      "state",
      "observedAt",
    ]);

    const underReview = cookiePaymentDisputeCommand(
      "payment_dispute_buyer_review",
      { state: "under_review", observedAt: "2026-08-14T09:31:00.000Z" },
    );
    expect(authority.observePaymentDispute(underReview).outcome).toBe(
      "applied",
    );
    expect(
      await buyerClient.readOrder(
        "merchant_cookie",
        "storefront_cafe",
        "checkout_cookie",
        buyerSession.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        state: "placed",
        paymentDisputes: [
          { state: "under_review", observedAt: "2026-08-14T09:31:00.000Z" },
        ],
      },
    });

    const terminal = cookiePaymentDisputeCommand("payment_dispute_buyer_won", {
      state: "won",
      resolvedAt: "2026-08-14T09:32:00.000Z",
    });
    expect(authority.observePaymentDispute(terminal).outcome).toBe("applied");
    const terminalOrder = await buyerClient.readOrder(
      "merchant_cookie",
      "storefront_cafe",
      "checkout_cookie",
      buyerSession.value.token,
    );
    expect(terminalOrder).toMatchObject({
      ok: true,
      value: {
        state: "placed",
        paymentDisputes: [
          {
            state: "won",
            resolvedAt: "2026-08-14T09:32:00.000Z",
          },
        ],
      },
    });
    if (!terminalOrder.ok) throw new Error("Terminal buyer Order read failed");
    expect(Object.keys(terminalOrder.value.paymentDisputes[0] ?? {})).toEqual([
      "disputeId",
      "amount",
      "state",
      "resolvedAt",
    ]);

    const dispute = readPaymentDispute(
      database,
      "merchant_cookie",
      terminalOrder.value.paymentDisputes[0]?.disputeId ?? "",
    );
    if (dispute === undefined)
      throw new Error("Buyer payment dispute was not persisted");
    const invalidAmountDispute = {
      ...dispute,
      amount: { amountMinor: 496, currency: dispute.amount.currency },
    };
    database
      .prepare(
        `UPDATE payment_dispute
       SET amount_minor = ?, dispute_json = ?
       WHERE merchant_id = ? AND dispute_id = ?`,
      )
      .run(
        invalidAmountDispute.amount.amountMinor,
        JSON.stringify(invalidAmountDispute),
        "merchant_cookie",
        dispute.disputeId,
      );
    expect(
      await buyerClient.readOrder(
        "merchant_cookie",
        "storefront_cafe",
        "checkout_cookie",
        buyerSession.value.token,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "http", status: 404, message: "Order not found" },
    });
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("resumes one cancelled pickup through the same original-tender refund", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-cancellation-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    requireApplied(
      authority.beginCheckoutPayment(beginCheckoutPaymentCommand()),
    );
    requireApplied(
      authority.recordCheckoutPaymentCapture(
        recordCheckoutPaymentCaptureCommand(),
      ),
    );
    requireApplied(authority.placePaidCheckout(placePaidCheckoutCommand()));
    const command = cancelOrderCommand();
    paymentGateway.failNextRefund(
      new Error("provider interrupted after cancellation reservation"),
    );

    await expect(authority.cancelOrder(command)).rejects.toThrow(
      "provider interrupted after cancellation reservation",
    );

    expect(authority.readSnapshot("merchant_cookie")?.merchantRevision).toBe(9);
    expect(listOrders(database, "merchant_cookie")[0]).toMatchObject({
      revision: 2,
      lifecycle: { state: "cancelled", reason: "Buyer changed plans" },
      adjustments: [
        {
          kind: "cancellation",
          status: "completed",
          amount: { amountMinor: 0 },
        },
        { kind: "refund", status: "pending", amount: { amountMinor: 495 } },
      ],
    });
    expect(listFulfillments(database, "merchant_cookie")[0]).toMatchObject({
      revision: 2,
      lifecycle: { state: "cancelled", reason: "Buyer changed plans" },
    });
    expect(
      readInventoryAllocation(database, "merchant_cookie", allocationId()),
    ).toMatchObject({
      revision: 3,
      lifecycle: { state: "released", reason: "order_cancelled" },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_cookie",
        "location_cafe",
      ),
    ).toMatchObject({
      revision: 4,
      balance: { allocated: { amount: 0 }, available: { amount: 10 } },
    });
    expect(
      readRefundAttempt(database, "merchant_cookie", "refund_cancel_cookie")
        ?.attempt,
    ).toMatchObject({
      revision: 1,
      orderId: "order_cookie",
      paymentId: "payment_cookie_record",
      lifecycle: { state: "requested" },
      allocation: {
        lineAllocations: [{ amount: { amountMinor: 450, currency: "JPY" } }],
        taxAllocations: [{ amount: { amountMinor: 45, currency: "JPY" } }],
        shippingAllocation: { amountMinor: 0, currency: "JPY" },
      },
    });

    const api = checkoutApi(authority);
    const client = new CommerceAdminClient({
      baseUrl: "https://commerce.test",
      serviceToken: SERVICE_TOKEN,
      fetch: api.fetch,
    });
    const buyerClient = new CommerceStorefrontClient({
      baseUrl: "https://commerce.test",
      fetch: api.fetch,
    });
    const buyerSession = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!buyerSession.ok) throw new Error("Buyer session request failed");
    const pendingBuyerOrder = await buyerClient.readOrder(
      "merchant_cookie",
      "storefront_cafe",
      "checkout_cookie",
      buyerSession.value.token,
    );
    expect(pendingBuyerOrder).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-order.v1",
        fulfillment: "pickup",
        state: "cancelled",
        cancelledAt: AT,
        refund: {
          state: "pending",
          amount: { amountMinor: 495, currency: "JPY" },
        },
      },
    });
    const pendingBuyerOrderJson = JSON.stringify(pendingBuyerOrder);
    expect(pendingBuyerOrderJson).not.toContain("refund_cancel_cookie");
    expect(pendingBuyerOrderJson).not.toContain("pi_cookie_captured");
    expect(pendingBuyerOrderJson).not.toContain("providerRefundReference");
    const resumedResponse = await client.cancelOrder(clientInput(command));
    if (!resumedResponse.ok)
      throw new Error("Cancellation client request failed");
    const resumed = resumedResponse.value;

    expect(resumed).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "cancel_order",
        previousMerchantRevision: 9,
        merchantRevision: 10,
        resource: {
          kind: "refund_attempt",
          id: "refund_cancel_cookie",
          revision: 2,
        },
      },
    });
    expect(paymentGateway.refundRequests).toHaveLength(2);
    expect(paymentGateway.refundRequests[1]).toEqual(
      paymentGateway.refundRequests[0],
    );
    expect(paymentGateway.refundRequests[1]).toMatchObject({
      paymentAttemptId: "payment_attempt_cookie",
      checkoutId: "checkout_cookie",
      orderId: "order_cookie",
      refundAttemptId: "refund_cancel_cookie",
      idempotencyKey: "refund_cancel_cookie",
      providerPaymentReference: "pi_cookie_captured",
      money: { amountMinor: 495, currency: "JPY" },
      refundMoney: { amountMinor: 495, currency: "JPY" },
      paymentBinding: PAYMENT_BINDING,
    });
    expect(listOrders(database, "merchant_cookie")[0]).toMatchObject({
      revision: 3,
      lifecycle: { state: "cancelled" },
      adjustments: [
        { kind: "cancellation", status: "completed" },
        { kind: "refund", status: "completed", amount: { amountMinor: 495 } },
      ],
    });
    expect(listPayments(database, "merchant_cookie")[0]).toMatchObject({
      revision: 2,
      lifecycle: {
        state: "refunded",
        refundedAmount: { amountMinor: 495, currency: "JPY" },
      },
    });
    expect(
      readRefundAttempt(database, "merchant_cookie", "refund_cancel_cookie")
        ?.attempt,
    ).toMatchObject({
      revision: 2,
      lifecycle: {
        state: "succeeded",
        providerRefundReference: "refund_refund_cancel_cookie",
        refundedAt: AT,
      },
    });
    expect(
      await buyerClient.readOrder(
        "merchant_cookie",
        "storefront_cafe",
        "checkout_cookie",
        buyerSession.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-order.v1",
        fulfillment: "pickup",
        state: "cancelled",
        cancelledAt: AT,
        refund: {
          state: "refunded",
          amount: { amountMinor: 495, currency: "JPY" },
          refundedAt: AT,
        },
      },
    });
    if (resumed.outcome === "rejected")
      throw new Error("Cancellation was rejected");
    expect(await client.cancelOrder(clientInput(command))).toEqual({
      ok: true,
      value: { outcome: "replayed", receipt: resumed.receipt },
    });
    expect(paymentGateway.refundRequests).toHaveLength(2);
    const unauthorized = await api.fetch(
      "https://commerce.test/v1/admin/merchants/merchant_cookie/orders/order_cookie/cancellations",
      { method: "POST", body: JSON.stringify(command) },
    );
    expect(unauthorized.status).toBe(401);
    const mismatchedPath = await api.fetch(
      "https://commerce.test/v1/admin/merchants/merchant_cookie/orders/order_other/cancellations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      },
    );
    expect(mismatchedPath.status).toBe(400);
    expect(
      await authority.cancelOrder({ ...command, provider: "stripe" }),
    ).toMatchObject({
      outcome: "rejected",
      error: { code: "invalid_command" },
    });
    expect(paymentGateway.refundRequests).toHaveLength(2);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("applies exact order refunds and rejects cumulative over-refunds", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-order-refund-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    requireApplied(
      authority.beginCheckoutPayment(beginCheckoutPaymentCommand()),
    );
    requireApplied(
      authority.recordCheckoutPaymentCapture(
        recordCheckoutPaymentCaptureCommand(),
      ),
    );
    requireApplied(authority.placePaidCheckout(placePaidCheckoutCommand()));
    const orderLineId =
      authority.readSnapshot("merchant_cookie")?.resources.orders[0]
        ?.lineItems[0]?.id;
    if (orderLineId === undefined)
      throw new Error("Refund test order line was unavailable");
    const command = orderRefundCommand(orderLineId, 100, "refund_order_cookie");

    const first = await authority.refundOrder(command);
    expect(first).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "refund_order",
        resource: {
          kind: "refund_attempt",
          id: "refund_refund_order_cookie",
          revision: 2,
        },
      },
    });
    expect(paymentGateway.refundRequests).toHaveLength(1);
    expect(paymentGateway.refundRequests[0]).toMatchObject({
      orderId: "order_cookie",
      refundMoney: { amountMinor: 100, currency: "JPY" },
      money: { amountMinor: 495, currency: "JPY" },
    });
    expect(listOrders(database, "merchant_cookie")[0]).toMatchObject({
      revision: 3,
      adjustments: [
        { kind: "refund", status: "completed", amount: { amountMinor: 100 } },
      ],
    });
    expect(listPayments(database, "merchant_cookie")[0]).toMatchObject({
      revision: 2,
      lifecycle: {
        state: "partially_refunded",
        refundedAmount: { amountMinor: 100, currency: "JPY" },
      },
    });

    const overCap = orderRefundCommand(
      orderLineId,
      400,
      "refund_order_over_cap",
    );
    const rejected = await authority.refundOrder({
      ...overCap,
      expectedMerchantRevision: 10,
      orderRevision: 3,
      paymentRevision: 2,
    });
    expect(rejected).toEqual({
      outcome: "rejected",
      error: { code: "resource_relationship_invalid", field: "refund.amount" },
    });
    expect(await authority.refundOrder(command)).toEqual({
      outcome: "replayed",
      receipt: first.outcome === "rejected" ? undefined : first.receipt,
    });
    expect(paymentGateway.refundRequests).toHaveLength(1);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("retries after capture recording without recapturing or duplicating placement", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-capture-restart-${randomUUID()}.sqlite3`,
  );
  let database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  let authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    requireApplied(
      authority.createPickupCheckout(createPickupCheckoutCommand()),
    );
    const quote = requireQuotedCheckout(
      readCheckout(database, "merchant_cookie", "checkout_cookie"),
    );
    const identityDigest = restartPaymentIdentityDigest();
    requireApplied(
      authority.beginCheckoutPayment(
        restartPaymentStartCommand(quote, identityDigest),
      ),
    );
    const provider = await paymentGateway.reconcile(
      restartPaymentRequest(quote, identityDigest),
    );
    if (provider.kind !== "captured")
      throw new Error("Restart fixture provider capture did not capture");
    requireApplied(
      authority.recordCheckoutPaymentCapture(
        restartPaymentCaptureRecordCommand(quote, identityDigest, provider),
      ),
    );
    expect(paymentGateway.calls).toBe(1);

    authority.close();
    database = new NodeCommerceDatabase(databasePath);
    authority = new CommerceAuthority({
      database,
      signer: new DigestSigner(),
      paymentGateway,
      now: fixedNow,
      shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
    });
    const firstRetry = await authority.reconcileBuyerCheckoutPayment({
      claims: restartBuyerClaims(),
      checkoutId: "checkout_cookie",
      command: restartBuyerPaymentCommand(quote),
    });
    expect(firstRetry.kind).toBe("resolved");
    if (firstRetry.kind !== "resolved")
      throw new Error("Restart placement was rejected");
    expect(firstRetry.result.state).toBe("placed");
    const secondRetry = await authority.reconcileBuyerCheckoutPayment({
      claims: restartBuyerClaims(),
      checkoutId: "checkout_cookie",
      command: restartBuyerPaymentCommand(quote),
    });
    expect(secondRetry).toEqual(firstRetry);
    expect(paymentGateway.calls).toBe(1);
    expect(
      listOrders(database, "merchant_cookie").filter(
        resourceHasId.bind(
          undefined,
          restartOrderId(restartPaymentIdentityDigest()),
        ),
      ),
    ).toHaveLength(1);
    expect(
      listFulfillments(database, "merchant_cookie").filter(
        resourceHasId.bind(
          undefined,
          restartFulfillmentId(restartPaymentIdentityDigest()),
        ),
      ),
    ).toHaveLength(1);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("refreshes an expired buyer quote under the same checkout revision chain", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-refresh-checkout-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const clock = new TestClock();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    now: clock.read,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "commerce_refresh_buyer_session_secret",
      now: clock.read,
      newSessionId: fixedBuyerSessionId,
    }),
    serviceToken: SERVICE_TOKEN,
  });
  const buyer = new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
  try {
    seedCookieAuthority(authority);
    const session = await buyer.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Buyer session request failed");
    const quoted = await createPickupCheckoutFromLines(
      buyer,
      "merchant_cookie",
      "storefront_cafe",
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "buyer_quote_before_expiry",
        buyer: TEST_GUEST_BUYER,
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 1 },
        ],
      },
    );
    if (!quoted.ok) throw new Error("Initial buyer quote failed");
    const initialStored = readCheckout(
      database,
      "merchant_cookie",
      quoted.value.checkoutId,
    );
    if (initialStored?.lifecycle.state !== "quoted")
      throw new Error("Initial quote was not stored");
    const initialAllocationId =
      initialStored.lifecycle.quote.lines[0]?.allocationIds[0];
    if (initialAllocationId === undefined)
      throw new Error("Initial allocation was unavailable");

    clock.set("2026-08-14T09:41:00.000Z");
    expect(
      await buyer.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
      ),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-checkout-recovery.v1",
        checkout: quoted.value,
        progress: { state: "quoted" },
      },
    });
    const refreshed = await buyer.refreshPickupCheckout(
      "merchant_cookie",
      "storefront_cafe",
      quoted.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
        idempotencyKey: "buyer_quote_after_expiry",
        checkoutRevision: quoted.value.revision,
        quoteDigest: quoted.value.quote.quoteDigest,
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 2 },
        ],
      },
    );
    if (!refreshed.ok)
      throw new Error(`Buyer quote refresh failed: ${refreshed.error.message}`);
    expect(refreshed.value).toMatchObject({
      checkoutId: quoted.value.checkoutId,
      revision: 2,
      quote: {
        lines: [
          { kind: "catalog", variantId: "variant_cookie_single", quantity: 2 },
        ],
        totals: {
          subtotal: { amountMinor: 900, currency: "JPY" },
          tax: { amountMinor: 90, currency: "JPY" },
          total: { amountMinor: 990, currency: "JPY" },
        },
      },
    });
    expect(
      readInventoryAllocation(database, "merchant_cookie", initialAllocationId)
        ?.lifecycle,
    ).toMatchObject({ state: "released", reason: "checkout_refreshed" });
    expect(
      await buyer.refreshPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        {
          schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
          idempotencyKey: "buyer_quote_after_expiry",
          checkoutRevision: quoted.value.revision,
          quoteDigest: quoted.value.quote.quoteDigest,
          lines: [
            {
              kind: "catalog",
              variantId: "variant_cookie_single",
              quantity: 2,
            },
          ],
        },
      ),
    ).toEqual(refreshed);
    expect(
      await buyer.refreshPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        {
          schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
          idempotencyKey: "buyer_quote_after_expiry",
          checkoutRevision: quoted.value.revision,
          quoteDigest: "a".repeat(64),
          lines: [
            {
              kind: "catalog",
              variantId: "variant_cookie_single",
              quantity: 2,
            },
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "idempotency_conflict",
          idempotencyKey: "buyer_quote_after_expiry",
        },
      },
    });
    expect(
      await buyer.refreshPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        {
          schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
          idempotencyKey: "buyer_quote_after_expiry",
          checkoutRevision: refreshed.value.revision,
          quoteDigest: refreshed.value.quote.quoteDigest,
          lines: [
            {
              kind: "catalog",
              variantId: "variant_cookie_single",
              quantity: 3,
            },
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "idempotency_conflict",
          idempotencyKey: "buyer_quote_after_expiry",
        },
      },
    });
    expect(
      await completeBuyerCheckout(
        buyer,
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
        {
          schemaVersion: "commerce.create-buyer-payment-session.v1",
          idempotencyKey: "buyer_stale_quote_payment",
          checkoutRevision: quoted.value.revision,
          quoteDigest: quoted.value.quote.quoteDigest,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: { code: "idempotency_conflict" },
      },
    });
    expect(
      await completeBuyerCheckout(
        buyer,
        "merchant_cookie",
        "storefront_cafe",
        refreshed.value.checkoutId,
        session.value.token,
        {
          schemaVersion: "commerce.create-buyer-payment-session.v1",
          idempotencyKey: "buyer_refreshed_quote_payment",
          checkoutRevision: refreshed.value.revision,
          quoteDigest: refreshed.value.quote.quoteDigest,
        },
      ),
    ).toMatchObject({
      ok: true,
      value: { state: "placed", checkoutId: quoted.value.checkoutId },
    });
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("quotes a prepared sesame latte beside a catalog sesame cookie with exact snapshots", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-prepared-checkout-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const clock = new TestClock();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    now: clock.read,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority, SESAME_COOKIE_SEED);
    let revision = 4;
    revision = seedIngredient(
      authority,
      revision,
      "inventory_whole_milk",
      "WHOLE-MILK",
      "Whole milk",
      "milliliter",
      5_000,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_oat_milk",
      "OAT-MILK",
      "Oat milk",
      "milliliter",
      8_000,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_sugar",
      "SUGAR",
      "Sugar",
      "gram",
      1_500,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_black_sesame",
      "BLACK-SESAME",
      "Black sesame",
      "gram",
      4_000,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_glutinous_rice_flour",
      "GLUTINOUS-RICE-FLOUR",
      "Glutinous rice flour",
      "gram",
      2_000,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_water",
      "WATER",
      "Water",
      "milliliter",
      10_000,
    );
    revision = seedIngredient(
      authority,
      revision,
      "inventory_salt",
      "SALT",
      "Fine salt",
      "gram",
      5_000,
      1,
    );
    revision = applyMutation(
      authority.createPreparationStation({
        schemaVersion: "commerce.create-preparation-station.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "latte_station",
        requestedAt: AT,
        station: {
          stationId: "station_bar",
          locationId: "location_cafe",
          name: "Cafe Bar",
        },
      }),
    );
    revision = applyMutation(
      authority.createModifierGroupRevision({
        schemaVersion: "commerce.create-modifier-group-revision.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "latte_modifier",
        requestedAt: AT,
        modifierGroupRevision: {
          modifierGroupId: "modifier_group_milk",
          name: "Milk",
          minimumSelections: 0,
          maximumSelections: 1,
          options: [
            {
              modifierOptionId: "modifier_option_oat_milk",
              name: "Oat milk",
              priceDelta: { amountMinor: 100, currency: "JPY" },
              requirementAdjustments: [
                {
                  kind: "reduce",
                  inventoryItemId: "inventory_whole_milk",
                  quantity: { amount: 210, scale: 0, unit: "milliliter" },
                },
                {
                  kind: "add",
                  inventoryItemId: "inventory_oat_milk",
                  quantity: { amount: 210, scale: 0, unit: "milliliter" },
                },
              ],
            },
          ],
        },
      }),
    );
    revision = applyMutation(
      authority.createRecipeRevision({
        schemaVersion: "commerce.create-recipe-revision.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "latte_recipe",
        requestedAt: AT,
        recipeRevision: {
          recipeId: "recipe_sesame_latte",
          name: "Sesame Latte",
          inputs: [
            {
              inventoryItemId: "inventory_black_sesame",
              quantity: { amount: 22, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_sugar",
              quantity: { amount: 12, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_glutinous_rice_flour",
              quantity: { amount: 2, scale: 0, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_water",
              quantity: { amount: 40, scale: 0, unit: "milliliter" },
            },
            {
              inventoryItemId: "inventory_salt",
              quantity: { amount: 2, scale: 1, unit: "gram" },
            },
            {
              inventoryItemId: "inventory_whole_milk",
              quantity: { amount: 210, scale: 0, unit: "milliliter" },
            },
          ],
          output: { kind: "immediate" },
        },
      }),
    );
    revision = applyMutation(
      authority.configureStockPolicy({
        schemaVersion: "commerce.configure-stock-policy.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "latte_stock_policy",
        requestedAt: AT,
        stockPolicy: {
          stockPolicyId: "stock_policy_oat_milk",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_cafe",
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: 7_800, scale: 0, unit: "milliliter" },
            targetQuantity: { amount: 16_000, scale: 0, unit: "milliliter" },
          },
        },
      }),
    );
    revision = applyMutation(
      authority.prepareCatalogListing({
        schemaVersion: "commerce.prepare-catalog-listing.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "latte_catalog",
        requestedAt: AT,
        salesChannel: {
          id: "channel_cafe",
          revision: 1,
          name: "Cafe storefront",
          kind: "online",
          lifecycle: { state: "active", activeAt: AT },
          occurredAt: AT,
        },
        product: {
          id: "product_sesame_latte",
          revision: 1,
          title: "Sesame Latte",
          description:
            "Black sesame, milk, and a lightly sweet rice-flour concentrate.",
          occurredAt: AT,
        },
        variant: {
          id: "variant_sesame_latte",
          revision: 1,
          productId: "product_sesame_latte",
          sku: "SESAME-LATTE",
          title: "Sesame Latte",
          options: [],
          media: [],
          occurredAt: AT,
        },
        offer: {
          id: "offer_sesame_latte",
          revision: 1,
          variantId: "variant_sesame_latte",
          salesChannelId: "channel_cafe",
          price: { amountMinor: 700, currency: "JPY" },
          availability: { state: "available" },
          lifecycle: { state: "prepared", preparedAt: AT },
          occurredAt: AT,
        },
        consumptionPlan: {
          consumptionPlanId: "consumption_plan_sesame_latte",
          variantId: "variant_sesame_latte",
          revision: 1,
          scope: { kind: "location", locationId: "location_cafe" },
          mode: {
            kind: "prepared",
            recipeId: "recipe_sesame_latte",
            recipeRevision: 1,
          },
          lifecycle: "active",
        },
      }),
    );
    revision = applyMutation(
      authority.publishCatalogListing({
        schemaVersion: "commerce.publish-catalog-listing.v1",
        merchantId: "merchant_cookie",
        idempotencyKey: "latte_catalog_publish",
        requestedAt: AT,
        productId: "product_sesame_latte",
        productRevision: 1,
        variantId: "variant_sesame_latte",
        variantRevision: 1,
        offerId: "offer_sesame_latte",
        offerRevision: 1,
        salesChannelId: "channel_cafe",
        salesChannelRevision: 1,
      }),
    );
    revision = applyMutation(
      authority.publishMenu({
        schemaVersion: "commerce.publish-menu.v1",
        merchantId: "merchant_cookie",
        expectedMerchantRevision: revision,
        idempotencyKey: "cafe_main_menu",
        requestedAt: AT,
        menu: {
          menuId: "menu_cafe_main",
          name: "Cafe main menu",
          salesChannelId: "channel_cafe",
          scope: { kind: "location", locationId: "location_cafe" },
          validity: { kind: "always" },
          sections: [{ sectionId: "section_all", name: "Cafe", position: 0 }],
          entries: [
            {
              menuEntryId: "menu_entry_sesame_cookie",
              sectionId: "section_all",
              offerId: "offer_sesame_cookie_cafe",
              offerRevision: 1,
              consumptionPlanId: "consumption_plan_sesame_cookie",
              consumptionPlanRevision: 1,
              modifierGroupRevisions: [],
            },
            {
              menuEntryId: "menu_entry_sesame_latte",
              sectionId: "section_all",
              offerId: "offer_sesame_latte",
              offerRevision: 2,
              consumptionPlanId: "consumption_plan_sesame_latte",
              consumptionPlanRevision: 1,
              modifierGroupRevisions: [
                { modifierGroupId: "modifier_group_milk", revision: 1 },
              ],
            },
          ],
        },
      }),
    );
    expect(revision).toBe(32);

    const buyerClient = storefrontClient(authority);
    const session = await buyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Prepared checkout buyer session failed");
    const catalog = await buyerClient.readCatalog(
      "merchant_cookie",
      "storefront_cafe",
      session.value.token,
    );
    if (!catalog.ok) throw new Error("Prepared checkout catalog failed");
    expect(catalog.value.menus).toHaveLength(1);
    expect(catalog.value.menus[0]).toMatchObject({
      menuId: "menu_cafe_main",
      entries: [
        {
          menuEntryId: "menu_entry_sesame_cookie",
          variantId: "variant_sesame_cookie",
        },
        {
          menuEntryId: "menu_entry_sesame_latte",
          variantId: "variant_sesame_latte",
          modifierGroups: [
            {
              modifierGroupId: "modifier_group_milk",
              options: [
                {
                  modifierOptionId: "modifier_option_oat_milk",
                  name: "Oat milk",
                  priceDelta: { amountMinor: 100, currency: "JPY" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(catalog.value.menus[0]?.entries[1]).not.toHaveProperty(
      "requirementAdjustments",
    );
    const command = {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1" as const,
      idempotencyKey: "prepared_cookie_latte_checkout",
      buyer: TEST_GUEST_BUYER,
      lines: [
        {
          kind: "catalog" as const,
          variantId: "variant_sesame_cookie",
          quantity: 1,
        },
        {
          kind: "menu" as const,
          menuId: "menu_cafe_main",
          menuEntryId: "menu_entry_sesame_latte",
          modifierOptionIds: ["modifier_option_oat_milk"],
          quantity: 1,
        },
      ],
    };
    const cart = await buyerClient.createCart(
      "merchant_cookie",
      "storefront_cafe",
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: "prepared_cookie_latte_cart",
        lines: command.lines,
      },
    );
    if (!cart.ok)
      throw new Error(`Prepared Cart rejected: ${cart.error.message}`);
    expect(cart.value).toMatchObject({
      schemaVersion: "commerce.buyer-cart.v1",
      revision: 1,
      state: "active",
      fulfillment: "pickup",
      lines: command.lines,
    });
    expect(
      await buyerClient.readCart(
        "merchant_cookie",
        "storefront_cafe",
        cart.value.cartId,
        session.value.token,
      ),
    ).toEqual(cart);
    const replacement = {
      schemaVersion: "commerce.replace-buyer-cart.v1" as const,
      idempotencyKey: "prepared_cookie_latte_cart_replace",
      cartRevision: cart.value.revision,
      lines: [
        {
          kind: "catalog" as const,
          variantId: "variant_sesame_cookie",
          quantity: 2,
        },
        command.lines[1]!,
      ],
    };
    const replaced = await buyerClient.replaceCart(
      "merchant_cookie",
      "storefront_cafe",
      cart.value.cartId,
      session.value.token,
      replacement,
    );
    expect(replaced).toMatchObject({
      ok: true,
      value: {
        cartId: cart.value.cartId,
        revision: 2,
        state: "active",
        lines: replacement.lines,
      },
    });
    if (!replaced.ok) throw new Error("Prepared Cart replacement failed");
    expect(
      await buyerClient.replaceCart(
        "merchant_cookie",
        "storefront_cafe",
        cart.value.cartId,
        session.value.token,
        replacement,
      ),
    ).toEqual(replaced);
    expect(
      await buyerClient.replaceCart(
        "merchant_cookie",
        "storefront_cafe",
        cart.value.cartId,
        session.value.token,
        {
          ...replacement,
          idempotencyKey: "prepared_cookie_latte_cart_stale",
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: { code: "stale_resource_revision", expected: 1, actual: 2 },
      },
    });
    expect(
      await buyerClient.createCart(
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        {
          schemaVersion: "commerce.create-buyer-cart.v1",
          idempotencyKey: "prepared_cookie_latte_cart_invalid_modifier",
          lines: [
            {
              kind: "menu",
              menuId: "menu_cafe_main",
              menuEntryId: "menu_entry_sesame_latte",
              modifierOptionIds: ["modifier_option_unknown"],
              quantity: 1,
            },
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "resource_relationship_invalid",
          field: "cart.lines.modifiers",
        },
      },
    });
    expect(
      await buyerClient.createCart(
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        {
          schemaVersion: "commerce.create-buyer-cart.v1",
          idempotencyKey: "prepared_cookie_latte_cart",
          lines: [
            {
              kind: "catalog",
              variantId: "variant_sesame_cookie",
              quantity: 1,
            },
          ],
        },
      ),
    ).toMatchObject({ ok: false, error: { kind: "rejected", status: 409 } });
    expect(
      readCart(database, "merchant_cookie", cart.value.cartId)?.lines[1]
        ?.source,
    ).toEqual({
      kind: "food_service",
      variantId: "variant_sesame_latte",
      menuId: "menu_cafe_main",
      menuEntryId: "menu_entry_sesame_latte",
      modifierOptionIds: ["modifier_option_oat_milk"],
    });
    expect(
      await buyerClient.createPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        {
          schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
          idempotencyKey: "prepared_cookie_latte_checkout_stale",
          cartId: replaced.value.cartId,
          cartRevision: cart.value.revision,
          buyer: command.buyer,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "stale_resource_revision",
          kind: "cart",
          id: cart.value.cartId,
          expected: 1,
          actual: 2,
        },
      },
    });
    const checkoutCommand = {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1" as const,
      idempotencyKey: command.idempotencyKey,
      cartId: replaced.value.cartId,
      cartRevision: replaced.value.revision,
      buyer: command.buyer,
    };
    const quoted = await buyerClient.createPickupCheckout(
      "merchant_cookie",
      "storefront_cafe",
      session.value.token,
      checkoutCommand,
    );
    if (!quoted.ok)
      throw new Error(`Prepared checkout rejected: ${quoted.error.message}`);
    expect(quoted.value.quote.totals).toEqual({
      subtotal: { amountMinor: 1_700, currency: "JPY" },
      tax: { amountMinor: 170, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 1_870, currency: "JPY" },
    });
    expect(quoted.value.quote.lines).toEqual([
      {
        kind: "catalog",
        checkoutLineId:
          "checkout_line_41f83a8984b276ae2e40944b91d8703681e070ba359598c61d54209d2a62bdc7_0001",
        variantId: "variant_sesame_cookie",
        quantity: 2,
        unitPrice: { amountMinor: 450, currency: "JPY" },
        lineTotal: { amountMinor: 900, currency: "JPY" },
      },
      {
        kind: "menu",
        checkoutLineId:
          "checkout_line_41f83a8984b276ae2e40944b91d8703681e070ba359598c61d54209d2a62bdc7_0002",
        variantId: "variant_sesame_latte",
        menuId: "menu_cafe_main",
        menuEntryId: "menu_entry_sesame_latte",
        modifierOptionIds: ["modifier_option_oat_milk"],
        quantity: 1,
        unitPrice: { amountMinor: 800, currency: "JPY" },
        lineTotal: { amountMinor: 800, currency: "JPY" },
      },
    ]);
    expect(
      await buyerClient.createPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        checkoutCommand,
      ),
    ).toEqual(quoted);
    expect(
      await buyerClient.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        session.value.token,
      ),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: "commerce.buyer-checkout-recovery.v1",
        checkout: quoted.value,
        progress: { state: "quoted" },
      },
    });
    const otherBuyerClient = storefrontClientWithSessionId(
      authority,
      otherBuyerSessionId,
    );
    const otherSession = await otherBuyerClient.createSession(
      "merchant_cookie",
      "storefront_cafe",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!otherSession.ok) throw new Error("Other buyer session failed");
    expect(
      await buyerClient.readCheckout(
        "merchant_cookie",
        "storefront_cafe",
        quoted.value.checkoutId,
        otherSession.value.token,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "http", status: 404 },
    });
    expect(
      await buyerClient.readCart(
        "merchant_cookie",
        "storefront_cafe",
        cart.value.cartId,
        session.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        revision: 3,
        state: "submitted",
        checkoutId: quoted.value.checkoutId,
        lines: replacement.lines,
      },
    });
    expect(
      await buyerClient.createPickupCheckout(
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        {
          ...checkoutCommand,
          idempotencyKey: "prepared_cookie_latte_checkout_conflict",
          cartRevision: 3,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "resource_relationship_invalid",
          field: "checkout.cart",
        },
      },
    });
    const stored = readCheckout(
      database,
      "merchant_cookie",
      quoted.value.checkoutId,
    );
    if (stored?.lifecycle.state !== "quoted")
      throw new Error("Prepared checkout quote was not persisted");
    expect(stored.lifecycle.quote.lines[1]?.source).toMatchObject({
      kind: "food_service",
      menuId: "menu_cafe_main",
      menuRevision: 1,
      menuEntryId: "menu_entry_sesame_latte",
      menuEntryRevision: 1,
      preparation: {
        kind: "immediate_recipe",
        recipeId: "recipe_sesame_latte",
        recipeRevision: 1,
      },
      modifiers: [
        {
          modifierGroupId: "modifier_group_milk",
          modifierGroupRevision: 1,
          modifierOptionId: "modifier_option_oat_milk",
          name: "Oat milk",
          priceDelta: { amountMinor: 100, currency: "JPY" },
          requirementAdjustments: [
            {
              kind: "reduce",
              inventoryItemId: "inventory_whole_milk",
              quantity: { amount: 210, scale: 0, unit: "milliliter" },
            },
            {
              kind: "add",
              inventoryItemId: "inventory_oat_milk",
              quantity: { amount: 210, scale: 0, unit: "milliliter" },
            },
          ],
        },
      ],
      inventory: {
        kind: "requirements",
        items: [
          {
            inventoryItemId: "inventory_black_sesame",
            quantity: { amount: 22, scale: 0, unit: "gram" },
          },
          {
            inventoryItemId: "inventory_sugar",
            quantity: { amount: 12, scale: 0, unit: "gram" },
          },
          {
            inventoryItemId: "inventory_glutinous_rice_flour",
            quantity: { amount: 2, scale: 0, unit: "gram" },
          },
          {
            inventoryItemId: "inventory_water",
            quantity: { amount: 40, scale: 0, unit: "milliliter" },
          },
          {
            inventoryItemId: "inventory_salt",
            quantity: { amount: 2, scale: 1, unit: "gram" },
          },
          {
            inventoryItemId: "inventory_oat_milk",
            quantity: { amount: 210, scale: 0, unit: "milliliter" },
          },
        ],
      },
    });
    const latteAllocationIds =
      stored.lifecycle.quote.lines[1]?.allocationIds ?? [];
    expect(latteAllocationIds).toHaveLength(6);
    for (const allocationId of latteAllocationIds) {
      expect(
        readInventoryAllocation(database, "merchant_cookie", allocationId)
          ?.lifecycle,
      ).toEqual(
        expect.objectContaining({
          state: "held",
          demand: expect.objectContaining({
            consumeOn: "preparation_completed",
          }),
        }),
      );
    }
    const cookieAllocationId =
      stored.lifecycle.quote.lines[0]?.allocationIds[0];
    expect(cookieAllocationId).toBeDefined();
    expect(
      readInventoryAllocation(database, "merchant_cookie", cookieAllocationId!)
        ?.lifecycle,
    ).toEqual(
      expect.objectContaining({
        state: "held",
        demand: expect.objectContaining({ consumeOn: "fulfillment_completed" }),
      }),
    );
    expect(authority.readFoodServiceSnapshot("merchant_cookie")).toMatchObject({
      resources: {
        menus: [{ menuId: "menu_cafe_main", revision: 1 }],
        recipeRevisions: [{ recipeId: "recipe_sesame_latte", revision: 1 }],
        modifierGroupRevisions: [
          { modifierGroupId: "modifier_group_milk", revision: 1 },
        ],
        preparationStations: [
          { stationId: "station_bar", locationId: "location_cafe" },
        ],
        stockPolicies: [{ stockPolicyId: "stock_policy_oat_milk" }],
      },
    });
    await expect(
      createPickupCheckoutFromLines(
        buyerClient,
        "merchant_cookie",
        "storefront_cafe",
        session.value.token,
        {
          ...command,
          idempotencyKey: "prepared_cookie_latte_invalid",
          lines: [
            {
              kind: "menu" as const,
              menuId: "menu_cafe_main",
              menuEntryId: "menu_entry_sesame_latte",
              modifierOptionIds: [
                "modifier_option_oat_milk",
                "modifier_option_oat_milk",
              ],
              quantity: 1,
            },
          ],
        },
      ),
    ).rejects.toThrow();

    const payment = await completeBuyerCheckout(
      buyerClient,
      "merchant_cookie",
      "storefront_cafe",
      quoted.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: "prepared_cookie_latte_payment",
        checkoutRevision: quoted.value.revision,
        quoteDigest: quoted.value.quote.quoteDigest,
      },
    );
    if (!payment.ok || payment.value.state !== "placed")
      throw new Error("Prepared checkout payment failed");
    const adminClient = checkoutClient(authority);
    let merchantRevision = requireMerchantRevision(authority);
    const createTicket = {
      schemaVersion: "commerce.manage-preparation-ticket.v1" as const,
      merchantId: "merchant_cookie",
      expectedMerchantRevision: merchantRevision,
      idempotencyKey: "scenario_cafe_patisserie_v2:create_preparation_ticket:1",
      requestedAt: AT,
      operation: {
        kind: "create" as const,
        ticketId: "preparation_ticket_latte_1",
        orderId: payment.value.orderId,
        fulfillmentId: payment.value.fulfillmentId,
        stationId: "station_bar",
      },
    };
    const createdTicketResponse = await adminClient.managePreparationTicket(
      clientInput(createTicket),
    );
    if (!createdTicketResponse.ok)
      throw new Error("Preparation ticket create failed");
    const createdTicket = createdTicketResponse.value;
    expect(createdTicket).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "manage_preparation_ticket",
        resource: { id: "preparation_ticket_latte_1", revision: 1 },
      },
    });
    merchantRevision = requireMerchantRevision(authority);
    const startTicket = {
      ...createTicket,
      expectedMerchantRevision: merchantRevision,
      idempotencyKey: "scenario_cafe_patisserie_v2:start_preparation_ticket:1",
      operation: {
        kind: "start" as const,
        ticketId: "preparation_ticket_latte_1",
        expectedTicketRevision: 1,
      },
    };
    const startedTicketResponse = await adminClient.managePreparationTicket(
      clientInput(startTicket),
    );
    expect(startedTicketResponse).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    merchantRevision = requireMerchantRevision(authority);
    const completeTicket = {
      ...createTicket,
      expectedMerchantRevision: merchantRevision,
      idempotencyKey:
        "scenario_cafe_patisserie_v2:complete_preparation_ticket:1",
      operation: {
        kind: "complete" as const,
        ticketId: "preparation_ticket_latte_1",
        expectedTicketRevision: 2,
      },
    };
    const beforeExpiredAttempt = {
      merchantRevision: requireMerchantRevision(authority),
      ticket: authority.readPreparationTicket(
        "merchant_cookie",
        "preparation_ticket_latte_1",
      ),
      movements: authority.listInventoryMovements("merchant_cookie"),
      allocations: latteAllocationIds.map((id) =>
        readInventoryAllocation(database, "merchant_cookie", id),
      ),
      oatPosition: readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_oat_milk",
        "location_cafe",
      ),
      oatLot: readInventoryLot(
        database,
        "merchant_cookie",
        "lot_inventory_oat_milk",
      ),
    };
    const prematureReady = await adminClient.markPickupReady({
      merchantId: "merchant_cookie",
      expectedMerchantRevision: beforeExpiredAttempt.merchantRevision,
      idempotencyKey: "prepared_latte_ready_too_soon",
      orderId: payment.value.orderId,
      orderRevision: 1,
      fulfillmentId: payment.value.fulfillmentId,
      fulfillmentRevision: 1,
    });
    expect(prematureReady).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: { field: "pickupFulfillment.preparation" },
      },
    });
    clock.set("2026-08-22T09:30:00.000Z");
    const expiredCompleteResponse = await adminClient.managePreparationTicket({
      ...clientInput(completeTicket),
      idempotencyKey:
        "scenario_cafe_patisserie_v2:complete_preparation_ticket:expired",
    });
    clock.set(AT);
    expect(expiredCompleteResponse).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: { field: "preparationTicket.lotAvailability" },
      },
    });
    expect(requireMerchantRevision(authority)).toBe(
      beforeExpiredAttempt.merchantRevision,
    );
    expect(
      authority.readPreparationTicket(
        "merchant_cookie",
        "preparation_ticket_latte_1",
      ),
    ).toEqual(beforeExpiredAttempt.ticket);
    expect(authority.listInventoryMovements("merchant_cookie")).toEqual(
      beforeExpiredAttempt.movements,
    );
    expect(
      latteAllocationIds.map((id) =>
        readInventoryAllocation(database, "merchant_cookie", id),
      ),
    ).toEqual(beforeExpiredAttempt.allocations);
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_oat_milk",
        "location_cafe",
      ),
    ).toEqual(beforeExpiredAttempt.oatPosition);
    expect(
      readInventoryLot(database, "merchant_cookie", "lot_inventory_oat_milk"),
    ).toEqual(beforeExpiredAttempt.oatLot);
    const completedTicketResponse = await adminClient.managePreparationTicket(
      clientInput(completeTicket),
    );
    if (!completedTicketResponse.ok)
      throw new Error("Preparation ticket completion failed");
    const completedTicket = completedTicketResponse.value;
    expect(completedTicket).toMatchObject({
      outcome: "applied",
      receipt: { resource: { id: "preparation_ticket_latte_1", revision: 3 } },
    });
    const preparationMovements = authority
      .listInventoryMovements("merchant_cookie")
      .filter(
        (movement) =>
          movement.change.kind === "decrease" &&
          movement.change.reason.kind === "preparation",
      );
    expect(preparationMovements).toHaveLength(6);
    expect(
      preparationMovements.map((movement) => ({
        item: movement.inventoryItemId,
        quantity:
          movement.change.kind === "decrease"
            ? movement.change.quantity
            : undefined,
        reason:
          movement.change.kind === "decrease"
            ? movement.change.reason
            : undefined,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          item: "inventory_black_sesame",
          quantity: { amount: 22, scale: 0, unit: "gram" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_sugar",
          quantity: { amount: 12, scale: 0, unit: "gram" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_glutinous_rice_flour",
          quantity: { amount: 2, scale: 0, unit: "gram" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_water",
          quantity: { amount: 40, scale: 0, unit: "milliliter" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_salt",
          quantity: { amount: 2, scale: 1, unit: "gram" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_oat_milk",
          quantity: { amount: 210, scale: 0, unit: "milliliter" },
          reason: {
            kind: "preparation",
            ticketId: "preparation_ticket_latte_1",
            recipeRevision: 1,
          },
        },
      ]),
    );
    const completedTicketResource = authority.readPreparationTicket(
      "merchant_cookie",
      "preparation_ticket_latte_1",
    );
    if (completedTicketResource?.lifecycle.state !== "completed")
      throw new Error("Completed preparation ticket was not persisted");
    expect(completedTicketResource.lifecycle.movementIds).toHaveLength(6);
    expect(completedTicketResource?.lifecycle).toEqual({
      state: "completed",
      completedAt: AT,
      movementIds: expect.arrayContaining(
        preparationMovements.map((movement) => movement.id),
      ),
    });
    for (const allocationId of latteAllocationIds) {
      const allocation = readInventoryAllocation(
        database,
        "merchant_cookie",
        allocationId,
      );
      expect(allocation?.lifecycle.state).toBe("committed");
      if (allocation?.lifecycle.state === "committed") {
        expect(preparationMovements.map((movement) => movement.id)).toContain(
          allocation.lifecycle.movementId,
        );
      }
    }
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_black_sesame",
        "location_cafe",
      )?.balance,
    ).toMatchObject({
      kind: "accounted",
      onHand: { amount: 3_978, scale: 0, unit: "gram" },
      allocated: { amount: 0, scale: 0, unit: "gram" },
      available: { amount: 3_978, scale: 0, unit: "gram" },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_sugar",
        "location_cafe",
      )?.balance,
    ).toMatchObject({
      onHand: { amount: 1_488 },
      available: { amount: 1_488 },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_glutinous_rice_flour",
        "location_cafe",
      )?.balance,
    ).toMatchObject({
      onHand: { amount: 1_998 },
      available: { amount: 1_998 },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_water",
        "location_cafe",
      )?.balance,
    ).toMatchObject({
      onHand: { amount: 9_960 },
      available: { amount: 9_960 },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_cookie",
        "inventory_oat_milk",
        "location_cafe",
      )?.balance,
    ).toMatchObject({
      kind: "accounted",
      onHand: { amount: 7_790, scale: 0, unit: "milliliter" },
      allocated: { amount: 0, scale: 0, unit: "milliliter" },
      available: { amount: 7_790, scale: 0, unit: "milliliter" },
    });
    expect(
      readInventoryLot(database, "merchant_cookie", "lot_inventory_oat_milk")
        ?.remainingQuantity,
    ).toEqual({ amount: 7_790, scale: 0, unit: "milliliter" });
    expect(
      await adminClient.managePreparationTicket(clientInput(completeTicket)),
    ).toEqual({
      ok: true,
      value:
        completedTicket.outcome === "applied"
          ? { outcome: "replayed", receipt: completedTicket.receipt }
          : completedTicket,
    });
    merchantRevision = requireMerchantRevision(authority);
    const ready = await adminClient.markPickupReady({
      merchantId: "merchant_cookie",
      expectedMerchantRevision: merchantRevision,
      idempotencyKey: "prepared_latte_ready",
      orderId: payment.value.orderId,
      orderRevision: 1,
      fulfillmentId: payment.value.fulfillmentId,
      fulfillmentRevision: 1,
    });
    expect(ready).toMatchObject({ ok: true, value: { outcome: "applied" } });
    merchantRevision = requireMerchantRevision(authority);
    const completed = await adminClient.completePickup({
      merchantId: "merchant_cookie",
      expectedMerchantRevision: merchantRevision,
      idempotencyKey: "prepared_latte_pickup_complete",
      orderId: payment.value.orderId,
      orderRevision: 1,
      paymentId: payment.value.paymentId,
      paymentRevision: 1,
      fulfillmentId: payment.value.fulfillmentId,
      fulfillmentRevision: 2,
    });
    expect(completed).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    const decreasesAfterPickup = authority
      .listInventoryMovements("merchant_cookie")
      .filter((movement) => movement.change.kind === "decrease");
    expect(decreasesAfterPickup).toHaveLength(7);
    expect(
      decreasesAfterPickup.filter(
        (movement) =>
          movement.change.kind === "decrease" &&
          movement.change.reason.kind === "preparation",
      ),
    ).toHaveLength(6);
    expect(
      decreasesAfterPickup.filter(
        (movement) =>
          movement.change.kind === "decrease" &&
          movement.change.reason.kind === "sale",
      ),
    ).toHaveLength(1);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

it("completes a stocked production batch atomically with FEFO input consumption", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-production-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const clock = new TestClock();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    now: clock.read,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    let revision = seedProductionMerchant(authority);
    const client = checkoutClient(authority);
    revision = applyMutation(
      await awaitClientMutation(
        client.createPreparationStation({
          merchantId: "merchant_production",
          expectedMerchantRevision: revision,
          idempotencyKey: "production_station",
          station: {
            stationId: "station_bakery",
            locationId: "location_bakery",
            name: "Bakery",
          },
        }),
      ),
    );
    revision = applyMutation(
      await awaitClientMutation(
        client.createRecipeRevision({
          merchantId: "merchant_production",
          expectedMerchantRevision: revision,
          idempotencyKey: "production_recipe",
          recipeRevision: {
            recipeId: "recipe_cookie_stocked",
            name: "Cookie batch",
            inputs: [
              {
                inventoryItemId: "inventory_flour",
                quantity: { amount: 1_200, scale: 0, unit: "gram" },
              },
              {
                inventoryItemId: "inventory_butter",
                quantity: { amount: 600, scale: 0, unit: "gram" },
              },
              {
                inventoryItemId: "inventory_sugar",
                quantity: { amount: 400, scale: 0, unit: "gram" },
              },
            ],
            output: {
              kind: "stocked",
              inventoryItemId: "inventory_cookie",
              yieldQuantity: { amount: 24, scale: 0, unit: "each" },
            },
          },
        }),
      ),
    );
    const snapshotBefore = authority.readSnapshot("merchant_production");
    if (snapshotBefore === undefined)
      throw new Error("Production snapshot unavailable");
    const beforeFailedMovements = listInventoryMovements(
      database,
      "merchant_production",
    );
    const beforeFailedLots = listInventoryLots(database, "merchant_production");
    const beforeFailedFood = authority.readFoodServiceSnapshot(
      "merchant_production",
    );
    const inputPositions = [
      "inventory_flour",
      "inventory_butter",
      "inventory_sugar",
    ].map((inventoryItemId) => {
      const position = readInventoryPositionForItemLocation(
        database,
        "merchant_production",
        inventoryItemId,
        "location_bakery",
      );
      if (position === undefined)
        throw new Error(`Missing ${inventoryItemId} position`);
      return { inventoryPositionId: position.id, revision: position.revision };
    });
    const outputPosition = readInventoryPositionForItemLocation(
      database,
      "merchant_production",
      "inventory_cookie",
      "location_bakery",
    );
    if (outputPosition === undefined)
      throw new Error("Missing production output position");
    clock.set("2026-08-22T09:30:00.000Z");
    const failed = await client.completeProductionBatch({
      merchantId: "merchant_production",
      expectedMerchantRevision: revision,
      idempotencyKey: "production_expired_attempt",
      productionBatchId: "production_batch_cookie_20260814_a",
      demand: { kind: "stock" },
      outputLotId: "lot_cookie_20260814_a",
      outputInventoryPositionId: "position_inventory_cookie",
      recipeId: "recipe_cookie_stocked",
      recipeRevision: 1,
      stationId: "station_bakery",
      locationId: "location_bakery",
      plannedYield: { amount: 24, scale: 0, unit: "each" },
      actualYield: { amount: 22, scale: 0, unit: "each" },
      outputLotCode: "COOKIE-20260814-A",
      outputExpiresAt: "2026-08-29T00:00:00.000Z",
      expectedInputPositionRevisions: inputPositions,
      expectedOutputPositionRevision: outputPosition.revision,
    });
    clock.set(AT);
    expect(failed).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: { field: "productionBatch.inputLots" },
      },
    });
    expect(
      authority.readSnapshot("merchant_production")?.merchantRevision,
    ).toBe(snapshotBefore.merchantRevision);
    expect(
      authority.readSnapshot("merchant_production")?.resources
        .inventoryPositions,
    ).toEqual(snapshotBefore.resources.inventoryPositions);
    expect(listInventoryMovements(database, "merchant_production")).toEqual(
      beforeFailedMovements,
    );
    expect(listInventoryLots(database, "merchant_production")).toEqual(
      beforeFailedLots,
    );
    expect(authority.readFoodServiceSnapshot("merchant_production")).toEqual(
      beforeFailedFood,
    );
    const command = {
      schemaVersion: "commerce.complete-production-batch.v1" as const,
      merchantId: "merchant_production",
      expectedMerchantRevision: revision,
      idempotencyKey: "production_complete",
      requestedAt: AT,
      productionBatchId: "production_batch_cookie_20260814_a",
      demand: { kind: "stock" as const },
      outputLotId: "lot_cookie_20260814_a",
      outputInventoryPositionId: "position_inventory_cookie",
      recipeId: "recipe_cookie_stocked",
      recipeRevision: 1,
      stationId: "station_bakery",
      locationId: "location_bakery",
      plannedYield: { amount: 24, scale: 0, unit: "each" as const },
      actualYield: { amount: 22, scale: 0, unit: "each" as const },
      outputLotCode: "COOKIE-20260814-A",
      outputExpiresAt: "2026-08-21T00:00:00.000Z",
      expectedInputPositionRevisions: inputPositions,
      expectedOutputPositionRevision: outputPosition.revision,
    };
    const result = await client.completeProductionBatch(clientInput(command));
    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "complete_production_batch",
          previousMerchantRevision: revision,
          merchantRevision: revision + 1,
        },
      },
    });
    if (!result.ok || result.value.outcome !== "applied")
      throw new Error("Production batch did not apply");
    const movementCountAfterApply = listInventoryMovements(
      database,
      "merchant_production",
    ).length;
    const replay = await client.completeProductionBatch(clientInput(command));
    expect(replay).toEqual({
      ok: true,
      value: { outcome: "replayed", receipt: result.value.receipt },
    });
    expect(
      listInventoryMovements(database, "merchant_production"),
    ).toHaveLength(movementCountAfterApply);
    const movements = listInventoryMovements(database, "merchant_production");
    const productionMovements = movements.filter(isProductionInventoryMovement);
    expect(productionMovements).toHaveLength(4);
    expect(
      productionMovements
        .filter((movement) => movement.change.kind === "decrease")
        .map((movement) => ({
          item: movement.inventoryItemId,
          quantity: movement.change.quantity,
          reason: movement.change.reason,
        })),
    ).toEqual(
      expect.arrayContaining([
        {
          item: "inventory_flour",
          quantity: { amount: 1_200, scale: 0, unit: "gram" },
          reason: {
            kind: "production",
            productionBatchId: "production_batch_cookie_20260814_a",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_butter",
          quantity: { amount: 600, scale: 0, unit: "gram" },
          reason: {
            kind: "production",
            productionBatchId: "production_batch_cookie_20260814_a",
            recipeRevision: 1,
          },
        },
        {
          item: "inventory_sugar",
          quantity: { amount: 400, scale: 0, unit: "gram" },
          reason: {
            kind: "production",
            productionBatchId: "production_batch_cookie_20260814_a",
            recipeRevision: 1,
          },
        },
      ]),
    );
    const outputMovement = productionMovements.find(
      (movement) => movement.change.kind === "increase",
    );
    if (outputMovement === undefined)
      throw new Error("Production output movement missing");
    expect(outputMovement.change.quantity).toEqual({
      amount: 22,
      scale: 0,
      unit: "each",
    });
    expect(
      readInventoryLot(
        database,
        "merchant_production",
        "lot_cookie_20260814_a",
      ),
    ).toMatchObject({
      receivedQuantity: { amount: 22, unit: "each" },
      remainingQuantity: { amount: 22, unit: "each" },
      sourceMovementId: outputMovement.id,
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_production",
        "inventory_flour",
        "location_bakery",
      ),
    ).toMatchObject({
      balance: { onHand: { amount: 2_800 }, available: { amount: 2_800 } },
    });
    expect(
      readInventoryPositionForItemLocation(
        database,
        "merchant_production",
        "inventory_cookie",
        "location_bakery",
      ),
    ).toMatchObject({
      balance: { onHand: { amount: 22 }, available: { amount: 22 } },
    });
    expect(
      authority.readFoodServiceSnapshot("merchant_production"),
    ).toMatchObject({
      resources: {
        productionBatches: [
          {
            productionBatchId: "production_batch_cookie_20260814_a",
            demand: { kind: "stock" },
            inputMovementIds: expect.arrayContaining(
              movements
                .filter((movement) => movement.change.kind === "decrease")
                .map((movement) => movement.id),
            ),
          },
        ],
      },
    });
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

type CookieSeed = Readonly<{
  inventoryItemId: string;
  merchantCode: string;
  name: string;
  baseUnit: "each" | "gram";
  positionId: string;
  lotId: string;
  productId: string;
  variantId: string;
  sku: string;
  offerId: string;
  consumptionPlanId: string;
  quantity: Readonly<{ amount: number; scale: 0; unit: "each" | "gram" }>;
}>;

const LEGACY_COOKIE_SEED: CookieSeed = {
  inventoryItemId: "inventory_cookie",
  merchantCode: "COOKIE",
  name: "Cookie",
  baseUnit: "gram",
  positionId: "position_cookie",
  lotId: "lot_cookie",
  productId: "product_cookie",
  variantId: "variant_cookie_single",
  sku: "COOKIE",
  offerId: "offer_cookie_cafe",
  consumptionPlanId: "consumption_plan_cookie",
  quantity: { amount: 1, scale: 0, unit: "gram" },
};

const SESAME_COOKIE_SEED: CookieSeed = {
  inventoryItemId: "inventory_sesame_cookie",
  merchantCode: "SESAME-COOKIE",
  name: "Sesame Cookie",
  baseUnit: "each",
  positionId: "position_sesame_cookie",
  lotId: "lot_inventory_sesame_cookie",
  productId: "product_sesame_cookie",
  variantId: "variant_sesame_cookie",
  sku: "SESAME-COOKIE",
  offerId: "offer_sesame_cookie_cafe",
  consumptionPlanId: "consumption_plan_sesame_cookie",
  quantity: { amount: 1, scale: 0, unit: "each" },
};

function seedCookieAuthority(
  authority: CommerceAuthority,
  seed: CookieSeed = LEGACY_COOKIE_SEED,
): void {
  authority.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: "organisation_cookie",
    merchantId: "merchant_cookie",
    createdAt: AT,
  });
  requireApplied(
    authority.createInventoryItem({
      schemaVersion: "commerce.create-inventory-item.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision: 0,
      idempotencyKey: `item_${seed.inventoryItemId}`,
      requestedAt: AT,
      inventoryItemId: seed.inventoryItemId,
      merchantCode: seed.merchantCode,
      name: seed.name,
      baseUnit: seed.baseUnit,
      category: "finished_good",
      tracking: { kind: "lot_tracked", expiry: "optional" },
    }),
  );
  expect(
    authority.prepareCatalogListing({
      schemaVersion: "commerce.prepare-catalog-listing.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision: 1,
      idempotencyKey: "reject_uncommittable_direct_plan",
      requestedAt: AT,
      salesChannel: {
        id: "channel_uncommittable",
        revision: 1,
        name: "Uncommittable",
        kind: "online",
        lifecycle: { state: "active", activeAt: AT },
        occurredAt: AT,
      },
      product: {
        id: "product_uncommittable",
        revision: 1,
        title: "Uncommittable",
        description: "Uncommittable",
        occurredAt: AT,
      },
      variant: {
        id: "variant_uncommittable",
        revision: 1,
        productId: "product_uncommittable",
        sku: "UNCOMMITTABLE",
        title: "Uncommittable",
        options: [],
        media: [],
        occurredAt: AT,
      },
      offer: {
        id: "offer_uncommittable",
        revision: 1,
        variantId: "variant_uncommittable",
        salesChannelId: "channel_uncommittable",
        price: { amountMinor: 1, currency: "JPY" },
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: AT },
        occurredAt: AT,
      },
      consumptionPlan: {
        consumptionPlanId: "consumption_plan_uncommittable",
        variantId: "variant_uncommittable",
        revision: 1,
        scope: { kind: "organisation" },
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: seed.inventoryItemId,
              quantity: seed.quantity,
            },
          ],
          commitOn: "order_placed",
        },
        lifecycle: "active",
      },
    }),
  ).toEqual({
    outcome: "rejected",
    error: {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.mode.commitOn",
    },
  });
  expect(
    authority.configurePickupStorefront(
      pickupStorefrontCommand("order_placed", seed),
    ),
  ).toEqual({
    outcome: "rejected",
    error: {
      code: "resource_relationship_invalid",
      field: "consumptionPlan.mode",
    },
  });
  requireApplied(
    authority.configurePickupStorefront(
      pickupStorefrontCommand("fulfillment_completed", seed),
    ),
  );
  requireApplied(
    authority.openInventoryPosition({
      schemaVersion: "commerce.open-inventory-position.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision: 2,
      idempotencyKey: seed.positionId,
      requestedAt: AT,
      inventoryPositionId: seed.positionId,
      inventoryItemId: seed.inventoryItemId,
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  requireApplied(
    authority.receiveInventory({
      schemaVersion: "commerce.receive-inventory.v3",
      purchase: { kind: "unlinked" },
      merchantId: "merchant_cookie",
      expectedMerchantRevision: 3,
      idempotencyKey: `receive_${seed.inventoryItemId}`,
      requestedAt: AT,
      receiptId: `receipt_${seed.inventoryItemId}`,
      receiptLineId: `receipt_line_${seed.inventoryItemId}`,
      inventoryItemId: seed.inventoryItemId,
      inventoryItemRevision: 1,
      inventoryPositionId: seed.positionId,
      inventoryPositionRevision: 1,
      locationId: "location_cafe",
      receivedQuantity: {
        amount: seed.quantity.amount * 10,
        scale: 0,
        unit: seed.baseUnit,
      },
      lot: {
        kind: "tracked",
        lotId: seed.lotId,
        lotCode: `${seed.merchantCode}-20260814-A`,
        expiry:
          seed.baseUnit === "each"
            ? { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" }
            : { kind: "not_tracked" },
      },
      receivedAt: AT,
    }),
  );
}

function seedProductionMerchant(authority: CommerceAuthority): number {
  authority.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: "organisation_production",
    merchantId: "merchant_production",
    createdAt: AT,
  });
  let revision = applyMutation(
    authority.createLocation({
      schemaVersion: "commerce.create-location.v1",
      merchantId: "merchant_production",
      expectedMerchantRevision: 0,
      idempotencyKey: "production_location",
      requestedAt: AT,
      location: {
        id: "location_bakery",
        revision: 1,
        name: "Bakery",
        kind: "store",
        lifecycle: { state: "active", activeAt: AT },
        occurredAt: AT,
      },
    }),
  );
  for (const item of [
    {
      id: "inventory_flour",
      code: "FLOUR",
      name: "Flour",
      unit: "gram" as const,
      amount: 4_000,
    },
    {
      id: "inventory_butter",
      code: "BUTTER",
      name: "Butter",
      unit: "gram" as const,
      amount: 2_000,
    },
    {
      id: "inventory_sugar",
      code: "SUGAR",
      name: "Sugar",
      unit: "gram" as const,
      amount: 1_500,
    },
  ]) {
    revision = seedIngredientForMerchant(
      authority,
      revision,
      item.id,
      item.code,
      item.name,
      item.unit,
      item.amount,
    );
  }
  revision = applyMutation(
    authority.createInventoryItem({
      schemaVersion: "commerce.create-inventory-item.v1",
      merchantId: "merchant_production",
      expectedMerchantRevision: revision,
      idempotencyKey: "item_inventory_cookie",
      requestedAt: AT,
      inventoryItemId: "inventory_cookie",
      merchantCode: "COOKIE",
      name: "Cookie",
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "lot_tracked", expiry: "required" },
    }),
  );
  return applyMutation(
    authority.openInventoryPosition({
      schemaVersion: "commerce.open-inventory-position.v1",
      merchantId: "merchant_production",
      expectedMerchantRevision: revision,
      idempotencyKey: "position_inventory_cookie",
      requestedAt: AT,
      inventoryPositionId: "position_inventory_cookie",
      inventoryItemId: "inventory_cookie",
      inventoryItemRevision: 1,
      locationId: "location_bakery",
      locationRevision: 1,
    }),
  );
}

function seedIngredientForMerchant(
  authority: CommerceAuthority,
  expectedMerchantRevision: number,
  inventoryItemId: string,
  merchantCode: string,
  name: string,
  baseUnit: "gram" | "milliliter",
  amount: number,
): number {
  const created = applyMutation(
    authority.createInventoryItem({
      schemaVersion: "commerce.create-inventory-item.v1",
      merchantId: "merchant_production",
      expectedMerchantRevision,
      idempotencyKey: `item_${inventoryItemId}`,
      requestedAt: AT,
      inventoryItemId,
      merchantCode,
      name,
      baseUnit,
      category: "ingredient",
      tracking: { kind: "lot_tracked", expiry: "required" },
    }),
  );
  const opened = applyMutation(
    authority.openInventoryPosition({
      schemaVersion: "commerce.open-inventory-position.v1",
      merchantId: "merchant_production",
      expectedMerchantRevision: created,
      idempotencyKey: `position_${inventoryItemId}`,
      requestedAt: AT,
      inventoryPositionId: `position_${inventoryItemId}`,
      inventoryItemId,
      inventoryItemRevision: 1,
      locationId: "location_bakery",
      locationRevision: 1,
    }),
  );
  return applyMutation(
    authority.receiveInventory({
      schemaVersion: "commerce.receive-inventory.v3",
      purchase: { kind: "unlinked" },
      merchantId: "merchant_production",
      expectedMerchantRevision: opened,
      idempotencyKey: `receive_${inventoryItemId}`,
      requestedAt: AT,
      receiptId: `receipt_${inventoryItemId}`,
      receiptLineId: `receipt_line_${inventoryItemId}`,
      inventoryItemId,
      inventoryItemRevision: 1,
      inventoryPositionId: `position_${inventoryItemId}`,
      inventoryPositionRevision: 1,
      locationId: "location_bakery",
      receivedQuantity: { amount, scale: 0, unit: baseUnit },
      lot: {
        kind: "tracked",
        lotId: `lot_${inventoryItemId}`,
        lotCode: `${merchantCode}-20260814-A`,
        expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
      },
      receivedAt: AT,
    }),
  );
}

function seedIngredient(
  authority: CommerceAuthority,
  expectedMerchantRevision: number,
  inventoryItemId: string,
  merchantCode: string,
  name: string,
  baseUnit: "gram" | "milliliter",
  amount: number,
  scale: 0 | 1 = 0,
): number {
  const created = applyMutation(
    authority.createInventoryItem({
      schemaVersion: "commerce.create-inventory-item.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision,
      idempotencyKey: `item_${inventoryItemId}`,
      requestedAt: AT,
      inventoryItemId,
      merchantCode,
      name,
      baseUnit,
      category: "ingredient",
      tracking: { kind: "lot_tracked", expiry: "required" },
    }),
  );
  const opened = applyMutation(
    authority.openInventoryPosition({
      schemaVersion: "commerce.open-inventory-position.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision: created,
      idempotencyKey: `position_${inventoryItemId}`,
      requestedAt: AT,
      inventoryPositionId: `position_${inventoryItemId}`,
      inventoryItemId,
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  return applyMutation(
    authority.receiveInventory({
      schemaVersion: "commerce.receive-inventory.v3",
      purchase: { kind: "unlinked" },
      merchantId: "merchant_cookie",
      expectedMerchantRevision: opened,
      idempotencyKey: `receive_${inventoryItemId}`,
      requestedAt: AT,
      receiptId: `receipt_${inventoryItemId}`,
      receiptLineId: `receipt_line_${inventoryItemId}`,
      inventoryItemId,
      inventoryItemRevision: 1,
      inventoryPositionId: `position_${inventoryItemId}`,
      inventoryPositionRevision: 1,
      locationId: "location_cafe",
      receivedQuantity: { amount, scale, unit: baseUnit },
      lot: {
        kind: "tracked",
        lotId: `lot_${inventoryItemId}`,
        lotCode: `${merchantCode}-20260814-A`,
        expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
      },
      receivedAt: AT,
    }),
  );
}

function applyMutation(result: CommerceMutationResultV1): number {
  if (result.outcome !== "applied") {
    throw new Error(`Expected applied mutation, received ${result.outcome}`);
  }
  return result.receipt.merchantRevision;
}

async function awaitClientMutation(
  result: Promise<
    | { ok: true; value: CommerceMutationResultV1 }
    | { ok: false; error: { message: string } }
  >,
): Promise<CommerceMutationResultV1> {
  const response = await result;
  if (!response.ok) throw new Error(response.error.message);
  if (response.value === undefined)
    throw new Error(
      `Client mutation response was empty: ${JSON.stringify(response)}`,
    );
  return response.value;
}

function pickupStorefrontCommand(
  commitOn: "order_placed" | "fulfillment_completed",
  seed: CookieSeed = LEGACY_COOKIE_SEED,
) {
  return {
    schemaVersion: "commerce.configure-pickup-storefront.v1",
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 1,
    idempotencyKey: "catalog_cookie",
    requestedAt: AT,
    location: {
      id: "location_cafe",
      revision: 1,
      name: "Cafe",
      kind: "store",
      lifecycle: { state: "active", activeAt: AT },
      occurredAt: AT,
    },
    salesChannel: {
      id: "channel_cafe",
      revision: 1,
      name: "Cafe storefront",
      kind: "online",
      lifecycle: { state: "active", activeAt: AT },
      occurredAt: AT,
    },
    product: {
      id: seed.productId,
      revision: 1,
      title: seed.name,
      description: `One ${seed.name.toLowerCase()}.`,
      occurredAt: AT,
    },
    variant: {
      id: seed.variantId,
      revision: 1,
      productId: seed.productId,
      sku: seed.sku,
      title: seed.name,
      options: [],
      media: [],
      occurredAt: AT,
    },
    offer: {
      id: seed.offerId,
      revision: 1,
      variantId: seed.variantId,
      salesChannelId: "channel_cafe",
      price: { amountMinor: 450, currency: "JPY" },
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: AT },
      occurredAt: AT,
    },
    storefront: storefront(),
    consumptionPlan: {
      consumptionPlanId: seed.consumptionPlanId,
      variantId: seed.variantId,
      revision: 1,
      scope: { kind: "location", locationId: "location_cafe" },
      mode: {
        kind: "direct",
        components: [
          {
            inventoryItemId: seed.inventoryItemId,
            quantity: seed.quantity,
          },
        ],
        commitOn,
      },
      lifecycle: "active",
    },
  } as const;
}

function createPickupCheckoutCommand(quantity = 1) {
  return {
    schemaVersion: "commerce.create-pickup-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 4,
    idempotencyKey: "checkout_cookie",
    requestedAt: AT,
    storefrontId: "storefront_cafe",
    storefrontRevision: 1,
    checkoutProfile: checkoutProfileReference(),
    buyerSessionDigest: buyerSessionDigest(),
    buyerAuthority: TEST_GUEST_BUYER_AUTHORITY,
    cartId: "cart_cookie",
    checkoutId: "checkout_cookie",
    lines: [
      {
        cartLineId: "cart_line_cookie",
        checkoutLineId: "checkout_line_cookie",
        source: {
          kind: "catalog" as const,
          variantId: "variant_cookie_single",
        },
        quantity: { amount: quantity, scale: 0, unit: "each" as const },
      },
    ],
  };
}

function beginCheckoutPaymentCommand() {
  const quote = checkoutQuote();
  return {
    schemaVersion: "commerce.begin-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 5,
    idempotencyKey: "payment_cookie",
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 1,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_cookie",
    providerRequestId: "stripe_request_cookie",
    amount: quote.totals.total,
    paymentBinding: PAYMENT_BINDING,
  };
}

function collectInPersonCheckoutPaymentCommand() {
  const payment = beginCheckoutPaymentCommand();
  return {
    schemaVersion: "commerce.collect-in-person-checkout-payment.v1" as const,
    merchantId: payment.merchantId,
    expectedMerchantRevision: payment.expectedMerchantRevision,
    idempotencyKey: payment.idempotencyKey,
    requestedAt: payment.requestedAt,
    checkoutId: payment.checkoutId,
    checkoutRevision: payment.checkoutRevision,
    quoteDigest: payment.quoteDigest,
    paymentAttemptId: payment.paymentAttemptId,
    providerRequestId: "square_terminal_request_cookie",
    amount: payment.amount,
    paymentBinding: IN_PERSON_PAYMENT_BINDING,
  };
}

function restartPaymentIdentityDigest(): string {
  return sha256(
    JSON.stringify([
      "merchant_cookie",
      "storefront_cafe",
      "buyer_session_checkout_test",
      "checkout_cookie",
      "buyer_restart_payment",
    ]),
  );
}

function restartPaymentAttemptId(identityDigest: string): string {
  return `payment_attempt_${identityDigest}`;
}

function restartOrderId(identityDigest: string): string {
  return `order_${identityDigest}`;
}

function restartFulfillmentId(identityDigest: string): string {
  return `fulfillment_${identityDigest}`;
}

function restartPaymentStartCommand(
  quote: CheckoutQuoteSnapshot,
  identityDigest: string,
) {
  return {
    schemaVersion: "commerce.begin-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 5,
    idempotencyKey: `buyer_payment_start_${identityDigest}`,
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 1,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: restartPaymentAttemptId(identityDigest),
    providerRequestId: `stripe_test_request_${identityDigest}`,
    amount: quote.totals.total,
    paymentBinding: PAYMENT_BINDING,
  };
}

function restartPaymentRequest(
  quote: CheckoutQuoteSnapshot,
  identityDigest: string,
): MerchantPaymentReconciliationCommand {
  return {
    merchantId: "merchant_cookie",
    providerRequestId: `stripe_test_request_${identityDigest}`,
    paymentAttemptId: restartPaymentAttemptId(identityDigest),
    checkoutId: "checkout_cookie",
    idempotencyKey: `buyer_payment_start_${identityDigest}`,
    money: quote.totals.total,
    paymentBinding: PAYMENT_BINDING,
    confirmation: { kind: "provider_ui_completed" },
  };
}

function restartPaymentCaptureRecordCommand(
  quote: CheckoutQuoteSnapshot,
  identityDigest: string,
  provider: Variant<CommercePaymentCaptureResultV1, "captured">,
) {
  return {
    schemaVersion: "commerce.record-checkout-payment-capture.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 6,
    idempotencyKey: `buyer_payment_capture_record_${identityDigest}`,
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: restartPaymentAttemptId(identityDigest),
    paymentAttemptRevision: 1,
    providerPaymentReference: provider.providerPaymentReference,
    capturedAt: provider.capturedAt,
  };
}

function restartBuyerClaims() {
  return {
    sessionId: "buyer_session_checkout_test",
    merchantId: "merchant_cookie",
    storefrontId: "storefront_cafe",
    storefrontRevision: 1,
    checkoutProfile: checkoutProfileReference(),
    buyer: { kind: "guest" as const },
  };
}

function restartBuyerPaymentCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.reconcile-buyer-payment.v1" as const,
    idempotencyKey: "buyer_restart_payment",
    checkoutRevision: 1,
    quoteDigest: quote.quoteDigest,
    confirmation: { kind: "provider_ui_completed" as const },
  };
}

function staleCheckoutPaymentCommand() {
  const quote = checkoutQuote();
  return {
    schemaVersion: "commerce.begin-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 6,
    idempotencyKey: "payment_cookie_stale_quote",
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 2,
    quoteDigest: "quote_stale",
    paymentAttemptId: "payment_attempt_cookie_stale",
    providerRequestId: "stripe_request_cookie_stale",
    amount: quote.totals.total,
    paymentBinding: PAYMENT_BINDING,
  };
}

function recordCheckoutPaymentCaptureCommand() {
  return {
    schemaVersion: "commerce.record-checkout-payment-capture.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 6,
    idempotencyKey: "record_capture_payment_cookie",
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 2,
    quoteDigest: checkoutQuote().quoteDigest,
    paymentAttemptId: "payment_attempt_cookie",
    paymentAttemptRevision: 1,
    providerPaymentReference: "pi_cookie_captured",
    capturedAt: AT,
  };
}

function placePaidCheckoutCommand() {
  return {
    schemaVersion: "commerce.place-paid-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 7,
    idempotencyKey: "place_paid_checkout_cookie",
    requestedAt: AT,
    checkoutId: "checkout_cookie",
    checkoutRevision: 2,
    quoteDigest: checkoutQuote().quoteDigest,
    paymentAttemptId: "payment_attempt_cookie",
    paymentAttemptRevision: 2,
    orderId: "order_cookie",
    paymentId: "payment_cookie_record",
    fulfillmentId: "fulfillment_cookie",
    buyer: { kind: "guest" as const },
    placement: { kind: "pickup" as const },
  };
}

function cookiePaymentDisputeCommand(
  providerDeliveryId: string,
  lifecycle: ObserveCommercePaymentDisputeV1["lifecycle"],
): ObserveCommercePaymentDisputeV1 {
  return {
    schemaVersion: "commerce.observe-payment-dispute.v1",
    organisationId: "organisation_cookie",
    merchantId: "merchant_cookie",
    providerDeliveryId,
    receivedAt: AT,
    checkoutId: "checkout_cookie",
    paymentAttemptId: "payment_attempt_cookie",
    providerPaymentReference: "pi_cookie_captured",
    providerDisputeReference: "provider_dispute_buyer_cookie",
    amount: { amountMinor: 495, currency: "JPY" },
    reason: "cardholder_claim",
    evidenceReferences: ["receipt_cookie_dispute"],
    lifecycle,
  };
}

function cancelOrderCommand() {
  return {
    schemaVersion: "commerce.cancel-order.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 8,
    idempotencyKey: "cancel_order_cookie",
    requestedAt: AT,
    orderId: "order_cookie",
    orderRevision: 1,
    paymentId: "payment_cookie_record",
    paymentRevision: 1,
    fulfillmentId: "fulfillment_cookie",
    fulfillmentRevision: 1,
    refundAttemptId: "refund_cancel_cookie",
    reason: "Buyer changed plans",
  };
}

function orderRefundCommand(
  orderLineId: string,
  amountMinor: number,
  idempotencyKey: string,
): RefundCommerceOrderV1 {
  return {
    schemaVersion: "commerce.refund-order.v1",
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 8,
    idempotencyKey,
    requestedAt: AT,
    orderId: "order_cookie",
    orderRevision: 1,
    paymentId: "payment_cookie_record",
    paymentRevision: 1,
    refundAttemptId: `refund_${idempotencyKey}`,
    refundPolicyId: "refund_policy_standard",
    amount: { amountMinor, currency: "JPY" },
    allocation: {
      lineAllocations: [
        {
          orderLineId,
          amount: { amountMinor, currency: "JPY" },
        },
      ],
      taxAllocations: [],
      dutyAllocations: [],
      shippingAllocation: { amountMinor: 0, currency: "JPY" },
    },
    reason: "Merchant approved order refund",
  };
}

function markPickupReadyCommand() {
  return {
    schemaVersion: "commerce.mark-pickup-ready.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 8,
    idempotencyKey: "ready_cookie",
    requestedAt: AT,
    orderId: "order_cookie",
    orderRevision: 1,
    fulfillmentId: "fulfillment_cookie",
    fulfillmentRevision: 1,
  };
}

function completePickupCommand() {
  return {
    schemaVersion: "commerce.complete-pickup.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 10,
    idempotencyKey: "complete_cookie",
    requestedAt: AT,
    orderId: "order_cookie",
    orderRevision: 1,
    paymentId: "payment_cookie_record",
    paymentRevision: 1,
    fulfillmentId: "fulfillment_cookie",
    fulfillmentRevision: 2,
  };
}

function earlyPickupCompletionCommand() {
  return {
    schemaVersion: "commerce.complete-pickup.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 10,
    idempotencyKey: "complete_cookie_too_early",
    requestedAt: "2026-08-14T09:00:00.000Z",
    orderId: "order_cookie",
    orderRevision: 1,
    paymentId: "payment_cookie_record",
    paymentRevision: 1,
    fulfillmentId: "fulfillment_cookie",
    fulfillmentRevision: 2,
  };
}

function receiveFinerScaleInventoryCommand() {
  return {
    schemaVersion: "commerce.receive-inventory.v3" as const,
    purchase: { kind: "unlinked" } as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 9,
    idempotencyKey: "receive_cookie_finer_scale",
    requestedAt: AT,
    receiptId: "receipt_cookie_finer_scale",
    receiptLineId: "receipt_line_cookie_finer_scale",
    inventoryItemId: "inventory_cookie",
    inventoryItemRevision: 1,
    inventoryPositionId: "position_cookie",
    inventoryPositionRevision: 3,
    locationId: "location_cafe",
    receivedQuantity: { amount: 5, scale: 1, unit: "gram" as const },
    lot: {
      kind: "tracked" as const,
      lotId: "lot_cookie_finer_scale",
      lotCode: "COOKIE-20260814-B",
      expiry: { kind: "not_tracked" as const },
    },
    receivedAt: AT,
  };
}

function createFailureCheckoutCommand(
  expectedMerchantRevision: number,
  suffix: string,
) {
  return {
    schemaVersion: "commerce.create-pickup-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision,
    idempotencyKey: `checkout_${suffix}`,
    requestedAt: AT,
    storefrontId: "storefront_cafe",
    storefrontRevision: 1,
    checkoutProfile: checkoutProfileReference(),
    buyerSessionDigest: buyerSessionDigest(),
    buyerAuthority: TEST_GUEST_BUYER_AUTHORITY,
    cartId: `cart_${suffix}`,
    checkoutId: `checkout_${suffix}`,
    lines: [
      {
        cartLineId: `cart_line_${suffix}`,
        checkoutLineId: `checkout_line_${suffix}`,
        source: {
          kind: "catalog" as const,
          variantId: "variant_cookie_single",
        },
        quantity: { amount: 1, scale: 0, unit: "each" as const },
      },
    ],
  };
}

function failurePaymentCommand(
  expectedMerchantRevision: number,
  quote: CheckoutQuoteSnapshot,
  suffix: string,
) {
  const checkoutId = `checkout_${suffix}`;
  return {
    schemaVersion: "commerce.begin-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision,
    idempotencyKey: `payment_${suffix}`,
    requestedAt: AT,
    checkoutId,
    checkoutRevision: 1,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: `payment_attempt_${suffix}`,
    providerRequestId: `stripe_request_${suffix}`,
    amount: quote.totals.total,
    paymentBinding: PAYMENT_BINDING,
  };
}

function indeterminatePaymentCommand(
  quote: CheckoutQuoteSnapshot,
  reconcileAfter: string,
) {
  return {
    schemaVersion: "commerce.resolve-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 13,
    idempotencyKey: "payment_decline_indeterminate",
    requestedAt: AT,
    checkoutId: "checkout_decline",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_decline",
    paymentAttemptRevision: 1,
    outcome: {
      kind: "indeterminate" as const,
      reasonCode: "provider_timeout",
      reconcileAfter,
    },
  };
}

function declinedPaymentCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.resolve-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 14,
    idempotencyKey: "payment_decline_terminal",
    requestedAt: "2026-08-14T09:32:00.000Z",
    checkoutId: "checkout_decline",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_decline",
    paymentAttemptRevision: 2,
    outcome: { kind: "declined" as const, reasonCode: "card_declined" },
  };
}

function expireCheckoutCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.expire-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 16,
    idempotencyKey: "checkout_expiry_terminal",
    requestedAt: EXPIRES_AT,
    checkoutId: "checkout_expiry",
    checkoutRevision: 1,
    quoteDigest: quote.quoteDigest,
  };
}

function reconciliationIndeterminateCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.resolve-checkout-payment.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 19,
    idempotencyKey: "payment_reconcile_indeterminate",
    requestedAt: AT,
    checkoutId: "checkout_reconcile",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_reconcile",
    paymentAttemptRevision: 1,
    outcome: {
      kind: "indeterminate" as const,
      reasonCode: "provider_timeout",
      reconcileAfter: "2026-08-14T09:31:00.000Z",
    },
  };
}

function reconciliationCaptureRecordCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.record-checkout-payment-capture.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 20,
    idempotencyKey: "payment_reconcile_capture_recorded",
    requestedAt: "2026-08-14T09:32:00.000Z",
    checkoutId: "checkout_reconcile",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_reconcile",
    paymentAttemptRevision: 2,
    providerPaymentReference: "pi_reconciled_captured",
    capturedAt: "2026-08-14T09:32:00.000Z",
  };
}

function reconciliationPlacementCommand(quote: CheckoutQuoteSnapshot) {
  return {
    schemaVersion: "commerce.place-paid-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 21,
    idempotencyKey: "payment_reconcile_placed",
    requestedAt: "2026-08-14T09:32:00.000Z",
    checkoutId: "checkout_reconcile",
    checkoutRevision: 2,
    quoteDigest: quote.quoteDigest,
    paymentAttemptId: "payment_attempt_reconcile",
    paymentAttemptRevision: 3,
    orderId: "order_reconcile",
    paymentId: "payment_reconcile_record",
    fulfillmentId: "fulfillment_reconcile",
    buyer: { kind: "guest" as const },
    placement: { kind: "pickup" as const },
  };
}

function requireQuotedCheckout(
  checkout: Checkout | undefined,
): CheckoutQuoteSnapshot {
  if (checkout?.lifecycle.state !== "quoted")
    throw new Error("Expected quoted checkout");
  return checkout.lifecycle.quote;
}

function failureAllocationId(suffix: string): string {
  return `allocation_${sha256(
    `merchant_cookie:checkout_${suffix}:checkout_line_${suffix}:inventory_cookie`,
  )}`;
}

function buyerSessionDigest(): string {
  return sha256("buyer_session_checkout_test");
}

function checkoutProfileReference() {
  return {
    checkoutProfileId: "checkout_profile_storefront_cafe_default",
    revision: 1,
  } as const;
}

function storefront(): Storefront {
  return {
    storefrontId: "storefront_cafe",
    revision: 1,
    name: "Cafe storefront",
    salesChannelId: "channel_cafe",
    fulfillment: {
      kind: "pickup",
      locationId: "location_cafe",
      readyLeadTimeSeconds: 900,
    },
    checkout: {
      quoteTtlSeconds: 600,
      tax: { kind: "percentage", basisPoints: 1_000 },
    },
    lifecycle: { state: "active", activeAt: AT },
  };
}

function consumptionPlan(): InventoryConsumptionPlan {
  return {
    consumptionPlanId: "consumption_plan_cookie",
    variantId: "variant_cookie_single",
    revision: 1,
    scope: { kind: "location", locationId: "location_cafe" },
    mode: {
      kind: "direct",
      components: [
        {
          inventoryItemId: "inventory_cookie",
          quantity: { amount: 1, scale: 0, unit: "gram" },
        },
      ],
      commitOn: "fulfillment_completed",
    },
    lifecycle: "active",
  };
}

function cart(): Cart {
  return {
    cartId: "cart_cookie",
    storefrontId: "storefront_cafe",
    checkoutProfile: checkoutProfileReference(),
    buyerSessionDigest: buyerSessionDigest(),
    revision: 2,
    lines: [
      {
        cartLineId: "cart_line_cookie",
        source: { kind: "catalog", variantId: "variant_cookie_single" },
        quantity: { amount: 1, scale: 0, unit: "each" },
      },
    ],
    lifecycle: {
      state: "submitted",
      checkoutId: "checkout_cookie",
      submittedAt: AT,
    },
  };
}

function committedAllocation(): InventoryAllocation {
  return {
    allocationId: allocationId(),
    inventoryItemId: "inventory_cookie",
    locationId: "location_cafe",
    quantity: { amount: 1, scale: 0, unit: "gram" },
    revision: 3,
    lifecycle: {
      state: "committed",
      demand: {
        kind: "order",
        orderId: "order_cookie",
        orderLineId: orderLineId(),
      },
      movementId: saleMovementId(),
      committedAt: AT,
    },
  };
}

function acceptedCheckout(): Checkout {
  return {
    checkoutId: "checkout_cookie",
    source: {
      kind: "online",
      storefrontId: "storefront_cafe",
      cartId: "cart_cookie",
      buyerSessionDigest: buyerSessionDigest(),
      buyerContact: TEST_BUYER_CONTACT_AUTHORITY.contact,
      checkoutProfile: checkoutProfileReference(),
    },
    revision: 3,
    lifecycle: {
      state: "accepted",
      quote: checkoutQuote(),
      paymentAttemptId: "payment_attempt_cookie",
      orderId: "order_cookie",
      acceptedAt: AT,
    },
  };
}

function checkoutQuote(): VariantBy<
  Checkout["lifecycle"],
  "state",
  "quoted"
>["quote"] {
  const quote: Omit<CheckoutQuoteSnapshot, "quoteDigest"> = {
    checkoutRevision: 1,
    lines: [
      {
        checkoutLineId: "checkout_line_cookie",
        source: {
          kind: "catalog",
          variantId: "variant_cookie_single",
          variantRevision: 1,
          merchantCode: "COOKIE",
          optionValues: [],
          offerId: "offer_cookie_cafe",
          offerRevision: 1,
          consumptionPlanId: "consumption_plan_cookie",
          consumptionPlanRevision: 1,
          inventory: {
            kind: "requirements",
            items: [
              {
                inventoryItemId: "inventory_cookie",
                quantity: { amount: 1, scale: 0, unit: "gram" },
              },
            ],
          },
        },
        quantity: { amount: 1, scale: 0, unit: "each" },
        unitPrice: { amountMinor: 450, currency: "JPY" },
        lineTotal: { amountMinor: 450, currency: "JPY" },
        allocationIds: [allocationId()],
        title: "Cookie",
      },
    ],
    totals: {
      subtotal: { amountMinor: 450, currency: "JPY" },
      tax: { amountMinor: 45, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 495, currency: "JPY" },
    },
    fulfillment: {
      kind: "pickup",
      promise: { locationId: "location_cafe", readyAt: READY_AT },
    },
    quotedAt: AT,
    expiresAt: EXPIRES_AT,
  };
  return {
    quoteDigest: checkoutQuoteDigest(quote),
    checkoutRevision: quote.checkoutRevision,
    lines: quote.lines,
    totals: quote.totals,
    fulfillment: quote.fulfillment,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
  };
}

function paymentAttempt(): CheckoutPaymentAttempt {
  const quote = checkoutQuote();
  return {
    paymentAttemptId: "payment_attempt_cookie",
    revision: 1,
    binding: {
      checkoutId: "checkout_cookie",
      checkoutRevision: 1,
      quoteDigest: quote.quoteDigest,
      amount: quote.totals.total,
      paymentBinding: PAYMENT_BINDING,
      providerRequestId: "stripe_request_cookie",
      idempotencyKey: "payment_cookie",
    },
    lifecycle: { state: "pending", createdAt: AT },
  };
}

function capturedPaymentAttempt(): CheckoutPaymentAttempt {
  return {
    paymentAttemptId: "payment_attempt_cookie",
    revision: 2,
    binding: paymentAttempt().binding,
    lifecycle: {
      state: "captured",
      providerPaymentReference: "pi_cookie_captured",
      capturedAt: AT,
    },
  };
}

function allocationId(): string {
  return `allocation_${sha256(
    "merchant_cookie:checkout_cookie:checkout_line_cookie:inventory_cookie",
  )}`;
}

function orderLineId(): string {
  return `order_line_${sha256("order_cookie:checkout_line_cookie")}`;
}

function saleMovementId(): string {
  return `movement_${sha256(
    `merchant_cookie:fulfillment_cookie:${allocationId()}:sale`,
  )}`;
}

function deliveryHasId(
  deliveryId: string,
  delivery: ReturnType<CommerceAuthority["pendingDeliveries"]>[number],
): boolean {
  return delivery.deliveryId === deliveryId;
}

function resourceHasId(
  id: string,
  resource: Readonly<{ id: string }>,
): boolean {
  return resource.id === id;
}

function observationKind(
  observation: ReturnType<
    CommerceAuthority["pendingDeliveries"]
  >[number]["observations"][number],
): string {
  return observation.kind;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireApplied(
  result: ReturnType<CommerceAuthority["receiveInventory"]>,
): void {
  if (result.outcome !== "applied") {
    throw new Error(
      `Checkout fixture command did not apply: ${JSON.stringify(result)}`,
    );
  }
}

function requireMerchantRevision(authority: CommerceAuthority): number {
  const snapshot = authority.readSnapshot("merchant_cookie");
  if (snapshot === undefined)
    throw new Error("Merchant snapshot was unavailable");
  return snapshot.merchantRevision;
}

function fixedNow(): string {
  return AT;
}

function checkoutClient(authority: CommerceAuthority): CommerceAdminClient {
  const api = checkoutApi(authority);
  return new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
}

function storefrontClient(
  authority: CommerceAuthority,
): CommerceStorefrontClient {
  const api = checkoutApi(authority);
  return new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
}

function storefrontClientWithSessionId(
  authority: CommerceAuthority,
  newSessionId: () => string,
): CommerceStorefrontClient {
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "commerce_test_buyer_session_secret",
      now: fixedNow,
      newSessionId,
    }),
    serviceToken: SERVICE_TOKEN,
  });
  return new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
}

type BuyerPickupCheckoutFromLines = Omit<
  CreateCommerceBuyerPickupCheckoutV1,
  "cartId" | "cartRevision"
> &
  Readonly<{ lines: readonly CommerceBuyerPickupCheckoutLineV1[] }>;

async function createPickupCheckoutFromLines(
  client: CommerceStorefrontClient,
  merchantId: string,
  storefrontId: string,
  sessionToken: string,
  command: BuyerPickupCheckoutFromLines,
): Promise<CommerceClientResult<CommerceBuyerQuotedCheckoutV1>> {
  const cart = await client.createCart(merchantId, storefrontId, sessionToken, {
    schemaVersion: "commerce.create-buyer-cart.v1",
    idempotencyKey: `${command.idempotencyKey}_cart`,
    lines: command.lines,
  });
  if (!cart.ok) return { ok: false, error: cart.error };
  return client.createPickupCheckout(merchantId, storefrontId, sessionToken, {
    schemaVersion: command.schemaVersion,
    idempotencyKey: command.idempotencyKey,
    cartId: cart.value.cartId,
    cartRevision: cart.value.revision,
    buyer: command.buyer,
  });
}

async function completeBuyerCheckout(
  client: CommerceStorefrontClient,
  merchantId: string,
  storefrontId: string,
  checkoutId: string,
  sessionToken: string,
  command: Omit<CreateCommerceBuyerPaymentSessionV1, "returnUrl">,
): Promise<CommerceClientResult<CommerceBuyerPaymentResultV1>> {
  const session = await client.createPaymentSession(
    merchantId,
    storefrontId,
    checkoutId,
    sessionToken,
    { ...command, returnUrl: "https://storefront.test/payment-return" },
  );
  if (
    !session.ok &&
    (session.error.kind !== "rejected" ||
      session.error.error.code !== "resource_relationship_invalid")
  )
    return session;
  if (session.ok && session.value.state !== "ready")
    throw new Error("Payment session was unavailable");
  return client.reconcilePayment(
    merchantId,
    storefrontId,
    checkoutId,
    sessionToken,
    {
      schemaVersion: "commerce.reconcile-buyer-payment.v1",
      idempotencyKey: command.idempotencyKey,
      checkoutRevision: command.checkoutRevision,
      quoteDigest: command.quoteDigest,
      confirmation: { kind: "provider_ui_completed" },
    },
  );
}

function checkoutApi(authority: CommerceAuthority): CommerceHttpApi {
  return new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "commerce_test_buyer_session_secret",
      now: fixedNow,
      newSessionId: fixedBuyerSessionId,
    }),
    serviceToken: SERVICE_TOKEN,
  });
}

function fixedBuyerSessionId(): string {
  return "buyer_session_checkout_test";
}

function otherBuyerSessionId(): string {
  return "buyer_session_checkout_other";
}

function removeDatabase(databasePath: string): void {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
}

it("refuses a counter sale at a location with no active pickup storefront", () => {
  const databasePath = join(
    tmpdir(),
    `commerce-counter-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new TestPaymentGateway(),
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    publishCounterPolicy(database);
    expect(
      authority.createInPersonCheckout(
        createInPersonCheckoutCommand({ pantryLocationId: "location_unknown" }),
      ),
    ).toMatchObject({
      outcome: "rejected",
      error: {
        code: "resource_not_found",
        kind: "point_of_sale_configuration",
      },
    });
    // An anonymous buyer owns no customer identity, so naming one is invalid.
    expect(
      authority.createInPersonCheckout(
        createInPersonCheckoutCommand({
          buyer: { kind: "anonymous", customerId: "customer_regular" },
        }),
      ),
    ).toMatchObject({ outcome: "rejected" });
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});

function createInPersonCheckoutCommand(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "commerce.create-in-person-checkout.v1" as const,
    merchantId: "merchant_cookie",
    expectedMerchantRevision: 4,
    idempotencyKey: "checkout_counter",
    requestedAt: AT,
    pantryLocationId: "location_cafe",
    posConfigurationRevision: 1,
    operatorIdentity: "operator_barista",
    terminalAssignmentRevision: 1,
    buyer: { kind: "anonymous" as const },
    checkoutId: "checkout_counter",
    lines: [
      {
        cartLineId: "cart_line_counter",
        checkoutLineId: "checkout_line_counter",
        source: {
          kind: "catalog" as const,
          variantId: "variant_cookie_single",
        },
        quantity: { amount: 1, scale: 0, unit: "each" as const },
      },
    ],
    ...overrides,
  };
}

function publishCounterPolicy(database: NodeCommerceDatabase): void {
  // The counter sells under its own published policy — no storefront needed.
  publishPointOfSaleConfiguration(
    database,
    "merchant_cookie",
    {
      configurationId: "pos_configuration_counter",
      organisationId: "organisation_cookie",
      merchantId: "merchant_cookie" as PointOfSaleConfiguration["merchantId"],
      pantryLocationId: "location_cafe",
      salesChannelId: "channel_cafe",
      currency: "JPY",
      supportedItems: [
        { variantId: "variant_cookie_single", maxQuantityPerLine: 5 },
      ],
      quoteTtlSeconds: 900,
      tax: { kind: "percentage", basisPoints: 1_000 },
      pickupReadyLeadTimeSeconds: 0,
      afterSalePolicy: {
        cancellationPolicyId: "cancellation_counter",
        refundPolicyId: "refund_counter",
        refundGovernance: { kind: "approval_required" },
      },
      presentationPolicy: {
        locale: "ja-JP",
        merchantDisplayName: "Pantry Cafe",
        termsPolicyId: "terms_counter",
        privacyPolicyId: "privacy_counter",
        supportContact: "support@example.test",
      },
      revision: 1,
      lifecycle: {
        state: "published",
        publishedAt: AT,
        publishedBy: "operator_manager",
      },
    },
    AT,
  );
}

it(
  "recovers a captured counter sale after restart without another provider call",
  recoversCapturedCounterSale,
);

async function recoversCapturedCounterSale(): Promise<void> {
  const databasePath = join(
    tmpdir(),
    `commerce-counter-restart-${randomUUID()}.sqlite3`,
  );
  let database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  let authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    inPersonCollectionGateway: new TestInPersonCollectionGateway(),
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    publishCounterPolicy(database);
    requireApplied(
      authority.createInPersonCheckout(createInPersonCheckoutCommand()),
    );
    const checkout = readCheckout(
      database,
      "merchant_cookie",
      "checkout_counter",
    );
    if (checkout === undefined) throw new Error("Counter checkout unavailable");
    const quote = checkout.lifecycle.quote;
    const client = checkoutClient(authority);
    expect(
      await client.collectInPersonCheckoutPayment({
        ...clientInput(collectInPersonCheckoutPaymentCommand()),
        expectedMerchantRevision: 5,
        checkoutId: "checkout_counter",
        checkoutRevision: 1,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: "payment_attempt_counter",
        amount: quote.totals.total,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await client.recordCheckoutPaymentCapture({
        ...clientInput(recordCheckoutPaymentCaptureCommand()),
        checkoutId: "checkout_counter",
        checkoutRevision: 2,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: "payment_attempt_counter",
        providerPaymentReference: "square_counter_captured",
      }),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(listOrders(database, "merchant_cookie")).toHaveLength(0);
    authority.close();
    database = new NodeCommerceDatabase(databasePath);
    authority = new CommerceAuthority({
      database,
      signer: new DigestSigner(),
      paymentGateway,
      now: fixedNow,
      shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
    });
    const recovered = await authority.reconcileCounterSalePayment(
      "merchant_cookie",
      "checkout_counter",
    );
    expect(recovered.checkout.lifecycle.state).toBe("accepted");
    expect(recovered.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      providerPaymentReference: "square_counter_captured",
    });
    expect(
      await authority.reconcileCounterSalePayment(
        "merchant_cookie",
        "checkout_counter",
      ),
    ).toEqual(recovered);
    expect(paymentGateway.calls).toBe(0);
    expect(listOrders(database, "merchant_cookie")).toHaveLength(1);
    expect(listOrders(database, "merchant_cookie")[0]?.origin).toMatchObject({
      kind: "point_of_sale",
      checkoutId: "checkout_counter",
    });
    expect(listFulfillments(database, "merchant_cookie")).toHaveLength(1);
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
}

it("reconciles an interrupted counter-sale refund with the same provider identity", async () => {
  const databasePath = join(
    tmpdir(),
    `commerce-counter-refund-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, AT);
  const paymentGateway = new TestPaymentGateway();
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway,
    inPersonCollectionGateway: new TestInPersonCollectionGateway(),
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY),
  });
  try {
    seedCookieAuthority(authority);
    publishCounterPolicy(database);
    const client = checkoutClient(authority);

    expect(
      authority.createInPersonCheckout(createInPersonCheckoutCommand()),
    ).toMatchObject({ outcome: "applied" });
    const checkout = readCheckout(
      database,
      "merchant_cookie",
      "checkout_counter",
    );
    if (checkout === undefined)
      throw new Error("counter checkout was unavailable");
    const quote = checkout.lifecycle.quote;

    expect(
      await client.collectInPersonCheckoutPayment({
        ...clientInput(collectInPersonCheckoutPaymentCommand()),
        expectedMerchantRevision: 5,
        checkoutId: "checkout_counter",
        checkoutRevision: 1,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: "payment_attempt_counter",
        amount: quote.totals.total,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await client.recordCheckoutPaymentCapture({
        ...clientInput(recordCheckoutPaymentCaptureCommand()),
        checkoutId: "checkout_counter",
        checkoutRevision: 2,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: "payment_attempt_counter",
        providerPaymentReference: "square_counter_captured",
      }),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await client.placePaidCheckout({
        ...clientInput(placePaidCheckoutCommand()),
        checkoutId: "checkout_counter",
        checkoutRevision: 2,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: "payment_attempt_counter",
        orderId: "order_counter",
        paymentId: "payment_counter",
        fulfillmentId: "fulfillment_counter",
      }),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });

    const snapshot = authority.readSnapshot("merchant_cookie");
    const order = snapshot?.resources.orders[0];
    if (snapshot === undefined || order === undefined) {
      throw new Error("counter order was unavailable");
    }
    const refundAttemptId = "refund_counter";
    const command: RefundCommerceOrderV1 = {
      schemaVersion: "commerce.refund-order.v1",
      merchantId: "merchant_cookie",
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: refundAttemptId,
      requestedAt: AT,
      orderId: "order_counter",
      orderRevision: order.revision,
      paymentId: "payment_counter",
      paymentRevision: 1,
      refundAttemptId,
      refundPolicyId: "refund_counter",
      amount: order.totals.total,
      allocation: {
        lineAllocations: order.lineItems.map((line) => ({
          orderLineId: line.id,
          amount: line.lineTotal,
        })),
        taxAllocations: order.lineItems.map((line) => ({
          orderLineId: line.id,
          amount: line.tax,
        })),
        dutyAllocations: [],
        shippingAllocation: order.totals.shipping,
      },
      reason: "Counter sale returned in full",
    };
    paymentGateway.failNextRefund(
      new Error("provider interrupted after refund reservation"),
    );
    await expect(authority.refundOrder(command)).rejects.toThrow(
      "provider interrupted after refund reservation",
    );
    expect(
      readRefundAttempt(database, "merchant_cookie", refundAttemptId)?.attempt,
    ).toMatchObject({ lifecycle: { state: "requested" } });

    const reconciled = await authority.reconcileCounterSaleRefund(
      "merchant_cookie",
      "checkout_counter",
    );
    expect(reconciled.paymentAttempt?.lifecycle.state).toBe("captured");
    expect(paymentGateway.refundRequests).toHaveLength(2);
    expect(paymentGateway.refundRequests[1]).toEqual(
      paymentGateway.refundRequests[0],
    );
    expect(
      readRefundAttempt(database, "merchant_cookie", refundAttemptId)?.attempt,
    ).toMatchObject({
      lifecycle: {
        state: "succeeded",
        providerRefundReference: `refund_${refundAttemptId}`,
      },
    });
    expect(listPayments(database, "merchant_cookie")[0]).toMatchObject({
      lifecycle: {
        state: "refunded",
        refundedAmount: order.totals.total,
      },
    });
  } finally {
    authority.close();
    removeDatabase(databasePath);
  }
});
