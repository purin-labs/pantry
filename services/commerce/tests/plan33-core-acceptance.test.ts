import { createHash, randomUUID } from "node:crypto";
import { clientInput } from "./command-input.ts";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMMERCE_EUROPEAN_UNION_COUNTRIES,
  CommerceAdminClient,
  CommerceStorefrontClient,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceInventoryItemV1,
  type CreateCommerceBuyerShippingCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceBuyerShippingCheckoutLineV1,
  type CommerceClientResult,
  type CommerceResourcesV1,
  type CommercePaymentCaptureResultV1,
  type CommerceMutationResultV1,
  type OpenCommerceInventoryPositionV1,
  type PurchaseShippingLabelCommand,
  type QuoteShipmentLabelRateCommand,
  type RecordShippingTrackingCommand,
  type ReceiveCommerceInventoryV3,
  checkoutOnlineSource,
} from "@purin-labs/commerce-client";
import type {
  CheckoutProfileConfiguration,
  ShippingRouteBinding,
} from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import {
  readCart,
  readCheckout,
  readCheckoutPaymentAttemptForCheckout,
} from "../src/checkout-persistence.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { listOrders } from "../src/commerce-persistence.ts";
import {
  createJapanExportShipping,
  createJapanShippingGateway,
} from "../src/plugins/japan-export/index.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import type {
  CheckoutProviderCapabilityHealth,
  CheckoutProviderCapabilityHealthProvider,
  CheckoutProviderCapabilityHealthRequest,
} from "../src/regional-shipping.ts";
import {
  DeterministicPaymentGateway,
  type MerchantPaymentReconciliationCommand,
} from "../src/payments/provider.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { createLocalShippingAddressValidationService } from "../src/shipping-address-validation.ts";
import { configurePlan23FlavoredCatalog } from "../scripts/configure-plan23-flavored-catalog.ts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

const NOW = "2026-08-31T09:30:00.000Z";
const SHIPPING_NOW = "2026-08-14T10:00:00.000Z";
const SERVICE_TOKEN = "plan33_core_acceptance_service_token";
const ORGANISATION_ID = "organisation_plan33";
const MERCHANT_ID = "merchant_plan33";
const STOREFRONT_ID = "storefront_cafe";
const REPLACEMENT_PROFILE_ID = "checkout_profile_plan33_replacement";
const FIRST_VARIANT_ID = "variant_ginger_cookie";
const SECOND_VARIANT_ID = "variant_matcha_cookie";
const SHIPPING_STOREFRONT_ID = "storefront_cookie_store_sg";
const SHIPPING_MATCHA_VARIANT_ID = "variant_matcha_box_6";
const SHIPPING_TARO_VARIANT_ID = "variant_taro_box_6";
const SHIPPING_SIGNING_KEY = "plan33-core-shipping-carrier-key";
const BUYER = {
  kind: "guest" as const,
  contact: { kind: "email" as const, email: "plan33-buyer@example.test" },
};

class Plan33Signer implements CommerceSigner {
  readonly keyId = "key_plan33_core_acceptance";
  readonly publicKeyB64 = Buffer.alloc(32, 19).toString("base64url");

  sign(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
  }
}

class Plan33PaymentGateway extends DeterministicPaymentGateway {
  #reconcileResult: CommercePaymentCaptureResultV1 | undefined;
  reconcileCalls = 0;

  setReconcileResult(result: CommercePaymentCaptureResultV1): void {
    this.#reconcileResult = result;
  }

  override async reconcile(
    request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1> {
    this.reconcileCalls += 1;
    return this.#reconcileResult ?? super.reconcile(request);
  }
}

class Plan33CarrierHealth implements CheckoutProviderCapabilityHealthProvider {
  unavailableCapability: string | undefined;

  readHealth(
    request: CheckoutProviderCapabilityHealthRequest,
  ): CheckoutProviderCapabilityHealth {
    return request.capabilityReference === this.unavailableCapability
      ? { state: "unavailable" }
      : { state: "ready" };
  }
}

it(
  "pins one active checkout profile through pickup refresh, payment replay, and order recovery",
  plan33CoreAcceptance,
);

async function plan33CoreAcceptance(): Promise<void> {
  const databasePath = join(
    tmpdir(),
    `commerce-plan33-core-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, NOW);
  const paymentGateway = new Plan33PaymentGateway(() => NOW);
  const authority = new CommerceAuthority({
    database,
    signer: new Plan33Signer(),
    paymentGateway,
    now: () => NOW,
    shippingGateway: createJapanShippingGateway("plan33-core-carrier-key"),
    shipping: createJapanExportShipping("plan33-core-carrier-key"),
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "plan33_core_buyer_session_secret",
      now: () => NOW,
    }),
    serviceToken: SERVICE_TOKEN,
  });
  const admin = new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
  const storefront = new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });

  try {
    const provisioned = await admin.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: NOW,
    });
    if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));

    const activeBefore = authority.readActiveCheckoutProfile(
      MERCHANT_ID,
      STOREFRONT_ID,
    );
    if (activeBefore === undefined)
      throw new Error("Initial checkout profile was not active");
    const originalProfile = {
      checkoutProfileId: activeBefore.profile.checkoutProfileId,
      revision: activeBefore.profile.revision,
    } as const;

    const session = await storefront.createSession(MERCHANT_ID, STOREFRONT_ID, {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    expect(session.value.checkoutProfile).toEqual(originalProfile);
    expect(session.value.checkoutProfileConfiguration).toEqual(
      activeBefore.profile.configuration,
    );
    const catalog = await storefront.readCatalog(
      MERCHANT_ID,
      STOREFRONT_ID,
      session.value.token,
    );
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    expect(
      catalog.value.listings
        .filter((listing) =>
          [FIRST_VARIANT_ID, SECOND_VARIANT_ID].includes(listing.variantId),
        )
        .every((listing) => listing.availability === "available"),
    ).toBe(true);
    expect(catalog.value.listings.map((listing) => listing.variantId)).toEqual(
      expect.arrayContaining([FIRST_VARIANT_ID, SECOND_VARIANT_ID]),
    );

    const cart = await storefront.createCart(
      MERCHANT_ID,
      STOREFRONT_ID,
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: "plan33_original_cart",
        lines: [
          { kind: "catalog", variantId: FIRST_VARIANT_ID, quantity: 1 },
          { kind: "catalog", variantId: SECOND_VARIANT_ID, quantity: 1 },
        ],
      },
    );
    if (!cart.ok) throw new Error(JSON.stringify(cart.error));
    expect(cart.value.lines).toHaveLength(2);
    expect(cart.value.checkoutProfile).toEqual(originalProfile);

    const checkout = await storefront.createPickupCheckout(
      MERCHANT_ID,
      STOREFRONT_ID,
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "plan33_original_checkout",
        cartId: cart.value.cartId,
        cartRevision: cart.value.revision,
        buyer: BUYER,
      },
    );
    if (!checkout.ok) throw new Error(JSON.stringify(checkout.error));
    const checkoutId = checkout.value.checkoutId;
    const persistedCart = readCart(database, MERCHANT_ID, cart.value.cartId);
    const persistedCheckout = readCheckout(database, MERCHANT_ID, checkoutId);
    expect(persistedCart?.checkoutProfile).toEqual(originalProfile);
    expect(checkoutOnlineSource(persistedCheckout!)?.checkoutProfile).toEqual(
      originalProfile,
    );
    if (persistedCheckout === undefined)
      throw new Error("Initial checkout evidence was unavailable");
    const originalBuyerContact =
      checkoutOnlineSource(persistedCheckout)?.buyerContact;
    expect(originalBuyerContact).toEqual({
      kind: "email",
      emailDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const replacementConfiguration = replacementProfileConfiguration(
      activeBefore.profile.configuration,
    );
    const replacement = await admin.createCheckoutProfileDraft({
      schemaVersion: "commerce.create-checkout-profile-draft.v1",
      merchantId: MERCHANT_ID,
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      name: "Plan 33 replacement checkout",
      configuration: replacementConfiguration,
      createdAt: NOW,
    });
    if (!replacement.ok) throw new Error(JSON.stringify(replacement.error));
    const published = await admin.publishCheckoutProfile({
      schemaVersion: "commerce.publish-checkout-profile.v1",
      merchantId: MERCHANT_ID,
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      expectedRevision: replacement.value.revision,
      publishedAt: NOW,
      publishedBy: "plan33_acceptance",
    });
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    const activated = await admin.activateCheckoutProfile({
      schemaVersion: "commerce.activate-checkout-profile.v1",
      merchantId: MERCHANT_ID,
      storefrontId: STOREFRONT_ID,
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      checkoutProfileRevision: published.value.revision,
      activatedAt: NOW,
      activatedBy: "plan33_acceptance",
    });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
    expect(activated.value.activation).toEqual({
      merchantId: MERCHANT_ID,
      storefrontId: STOREFRONT_ID,
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      checkoutProfileRevision: published.value.revision,
      activatedAt: NOW,
      activatedBy: "plan33_acceptance",
    });

    const replacementSession = await storefront.createSession(
      MERCHANT_ID,
      STOREFRONT_ID,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!replacementSession.ok)
      throw new Error(JSON.stringify(replacementSession.error));
    expect(replacementSession.value.checkoutProfile).toEqual({
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      revision: published.value.revision,
    });
    expect(replacementSession.value.checkoutProfileConfiguration).toEqual(
      replacementConfiguration,
    );

    const cartAfterCutover = await storefront.readCart(
      MERCHANT_ID,
      STOREFRONT_ID,
      cart.value.cartId,
      session.value.token,
    );
    expect(cartAfterCutover).toMatchObject({
      ok: true,
      value: { checkoutProfile: originalProfile, state: "submitted" },
    });

    const refreshed = await storefront.refreshPickupCheckout(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
        idempotencyKey: "plan33_original_checkout_refresh",
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
        lines: [
          { kind: "catalog", variantId: FIRST_VARIANT_ID, quantity: 2 },
          { kind: "catalog", variantId: SECOND_VARIANT_ID, quantity: 1 },
        ],
      },
    );
    if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.error));
    expect(refreshed.value).toMatchObject({
      checkoutId,
      revision: checkout.value.revision + 1,
      state: "quoted",
      quote: {
        lines: [
          { variantId: FIRST_VARIANT_ID, quantity: 2 },
          { variantId: SECOND_VARIANT_ID, quantity: 1 },
        ],
      },
    });
    expect(
      checkoutOnlineSource(readCheckout(database, MERCHANT_ID, checkoutId)!)
        ?.checkoutProfile,
    ).toEqual(originalProfile);
    expect(
      checkoutOnlineSource(readCheckout(database, MERCHANT_ID, checkoutId)!)
        ?.buyerContact,
    ).toEqual(originalBuyerContact);

    const paymentCommand = {
      schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
      idempotencyKey: "plan33_original_payment",
      checkoutRevision: refreshed.value.revision,
      quoteDigest: refreshed.value.quote.quoteDigest,
      returnUrl: "https://storefront.test/plan33-return",
    };
    const paymentSession = await storefront.createPaymentSession(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      session.value.token,
      paymentCommand,
    );
    if (!paymentSession.ok || paymentSession.value.state !== "ready") {
      throw new Error(JSON.stringify(paymentSession));
    }
    const paymentSessionReplay = await storefront.createPaymentSession(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      session.value.token,
      paymentCommand,
    );
    expect(paymentSessionReplay).toEqual(paymentSession);

    const reconcileCommand = {
      schemaVersion: "commerce.reconcile-buyer-payment.v1" as const,
      idempotencyKey: paymentCommand.idempotencyKey,
      checkoutRevision: paymentCommand.checkoutRevision,
      quoteDigest: paymentCommand.quoteDigest,
      confirmation: { kind: "provider_ui_completed" as const },
    };
    const placed = await storefront.reconcilePayment(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      session.value.token,
      reconcileCommand,
    );
    if (!placed.ok || placed.value.state !== "placed") {
      throw new Error(JSON.stringify(placed));
    }
    const placedOrder = placed.value;
    expect(paymentGateway.reconcileCalls).toBe(1);
    const placedReplay = await storefront.reconcilePayment(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      session.value.token,
      reconcileCommand,
    );
    expect(placedReplay).toEqual(placed);
    expect(paymentGateway.reconcileCalls).toBe(1);

    const acceptedCheckout = readCheckout(database, MERCHANT_ID, checkoutId);
    expect(acceptedCheckout).toMatchObject({
      source: {
        kind: "online",
        buyerContact: originalBuyerContact,
        checkoutProfile: originalProfile,
      },
      lifecycle: {
        state: "accepted",
        orderId: placedOrder.orderId,
        paymentAttemptId: paymentSession.value.paymentAttemptId,
      },
    });
    if (
      acceptedCheckout === undefined ||
      acceptedCheckout.lifecycle.state !== "accepted"
    ) {
      throw new Error("Accepted checkout evidence was unavailable");
    }
    const capturedAttempt = readCheckoutPaymentAttemptForCheckout(
      database,
      MERCHANT_ID,
      checkoutId,
    );
    expect(capturedAttempt).toMatchObject({
      paymentAttemptId: paymentSession.value.paymentAttemptId,
      binding: {
        checkoutId,
        checkoutRevision: refreshed.value.revision,
        quoteDigest: refreshed.value.quote.quoteDigest,
      },
      lifecycle: {
        state: "captured",
        providerPaymentReference: expect.any(String),
      },
    });
    expect(acceptedCheckout.lifecycle.paymentAttemptId).toBe(
      capturedAttempt?.paymentAttemptId,
    );
    expect(
      listOrders(database, MERCHANT_ID).find(
        (order) => order.id === placedOrder.orderId,
      ),
    ).toMatchObject({
      origin: {
        checkoutId,
        configuration: {
          kind: "checkout_profile",
          checkoutProfile: originalProfile,
        },
      },
    });

    const recovered = await storefront.recoverOrder(
      MERCHANT_ID,
      STOREFRONT_ID,
      checkoutId,
      placed.value.orderRecovery.token,
    );
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        checkoutId,
        orderId: placedOrder.orderId,
        paymentId: placedOrder.paymentId,
        fulfillmentId: placedOrder.fulfillmentId,
      },
    });

    const indeterminateCart = await storefront.createCart(
      MERCHANT_ID,
      STOREFRONT_ID,
      replacementSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: "plan33_indeterminate_cart",
        lines: [{ kind: "catalog", variantId: FIRST_VARIANT_ID, quantity: 1 }],
      },
    );
    if (!indeterminateCart.ok)
      throw new Error(JSON.stringify(indeterminateCart.error));
    const indeterminateCheckout = await storefront.createPickupCheckout(
      MERCHANT_ID,
      STOREFRONT_ID,
      replacementSession.value.token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: "plan33_indeterminate_checkout",
        cartId: indeterminateCart.value.cartId,
        cartRevision: indeterminateCart.value.revision,
        buyer: BUYER,
      },
    );
    if (!indeterminateCheckout.ok)
      throw new Error(JSON.stringify(indeterminateCheckout.error));
    const indeterminatePaymentCommand = {
      schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
      idempotencyKey: "plan33_indeterminate_payment",
      checkoutRevision: indeterminateCheckout.value.revision,
      quoteDigest: indeterminateCheckout.value.quote.quoteDigest,
      returnUrl: "https://storefront.test/plan33-indeterminate-return",
    };
    const indeterminateSession = await storefront.createPaymentSession(
      MERCHANT_ID,
      STOREFRONT_ID,
      indeterminateCheckout.value.checkoutId,
      replacementSession.value.token,
      indeterminatePaymentCommand,
    );
    if (
      !indeterminateSession.ok ||
      indeterminateSession.value.state !== "ready"
    ) {
      throw new Error(JSON.stringify(indeterminateSession));
    }
    paymentGateway.setReconcileResult({
      schemaVersion: "commerce.payment-capture-result.v1",
      kind: "indeterminate",
      reason: "provider_timeout",
      reconcileAfter: "2026-08-31T09:35:00.000Z",
    });
    const indeterminateReconcileCommand = {
      schemaVersion: "commerce.reconcile-buyer-payment.v1" as const,
      idempotencyKey: indeterminatePaymentCommand.idempotencyKey,
      checkoutRevision: indeterminatePaymentCommand.checkoutRevision,
      quoteDigest: indeterminatePaymentCommand.quoteDigest,
      confirmation: { kind: "provider_ui_completed" as const },
    };
    const indeterminate = await storefront.reconcilePayment(
      MERCHANT_ID,
      STOREFRONT_ID,
      indeterminateCheckout.value.checkoutId,
      replacementSession.value.token,
      indeterminateReconcileCommand,
    );
    expect(indeterminate).toMatchObject({
      ok: true,
      value: {
        state: "indeterminate",
        checkoutId: indeterminateCheckout.value.checkoutId,
        reconcileAfter: "2026-08-31T09:35:00.000Z",
      },
    });
    expect(
      await storefront.reconcilePayment(
        MERCHANT_ID,
        STOREFRONT_ID,
        indeterminateCheckout.value.checkoutId,
        replacementSession.value.token,
        indeterminateReconcileCommand,
      ),
    ).toEqual(indeterminate);
    expect(paymentGateway.reconcileCalls).toBe(2);
  } finally {
    authority.close();
    rmSync(databasePath, { force: true });
  }
}

it(
  "quotes, replays, recovers, and delivers domestic and Singapore shipping checkouts",
  plan33ShippingAcceptance,
);

async function plan33ShippingAcceptance(): Promise<void> {
  const fixture = createShippingFixture();
  try {
    await createShippingItems(fixture.admin);
    // A parcel needs a carton: a storefront that consumes no packaging is
    // refused.
    const storefrontCommand = baseShippingStorefrontCommand(2);
    const withoutCarton: ConfigureCommerceShippingStorefrontV1 = {
      ...storefrontCommand,
      idempotencyKey: "plan33_shipping_storefront_without_carton",
      consumptionPlan: {
        ...storefrontCommand.consumptionPlan,
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: "inventory_cookie_box_6",
              quantity: { amount: 1, scale: 0, unit: "each" },
            },
          ],
          commitOn: "fulfillment_completed",
        },
      },
    };
    expect(
      await fixture.admin.configureShippingStorefront(
        clientInput(withoutCarton),
      ),
    ).toEqual({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "consumptionPlan.packaging",
        },
      },
    });
    await requireAppliedMutation(
      fixture.admin.configureShippingStorefront(clientInput(storefrontCommand)),
      "shipping storefront",
    );

    const session = await fixture.storefront.createSession(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    // The box is listed, but it does not sell before its stock arrives.
    const emptyCatalog = await fixture.storefront.readCatalog(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      session.value.token,
    );
    if (!emptyCatalog.ok) throw new Error(JSON.stringify(emptyCatalog.error));
    expect(emptyCatalog.value.listings).toEqual([
      expect.objectContaining({
        variantId: "variant_cookie_box_6",
        availability: "unavailable",
      }),
    ]);

    await receiveShippingStock(fixture.admin);
    await configurePlan23FlavoredCatalog(fixture.admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    const catalog = await fixture.storefront.readCatalog(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      session.value.token,
    );
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    expect(catalog.value.listings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: "variant_cookie_box_6",
          availability: "available",
        }),
        expect.objectContaining({
          variantId: SHIPPING_MATCHA_VARIANT_ID,
          availability: "available",
        }),
        expect.objectContaining({
          variantId: SHIPPING_TARO_VARIANT_ID,
          availability: "available",
        }),
      ]),
    );

    const domesticInitialAddress = await validateShippingAddress(
      fixture.storefront,
      session.value.token,
      {
        countryCode: "JP",
        recipientName: "Plan 33 Domestic Buyer",
        addressLine1: "1-1-1 Marunouchi",
        locality: "Chiyoda-ku",
        administrativeArea: "Tokyo",
        postalCode: "100-0005",
      },
      "plan33_domestic_initial_address",
    );
    const domesticInitial = await createShippingCheckoutFromLines(
      fixture.storefront,
      session.value.token,
      "plan33_domestic_checkout",
      [
        { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 1 },
        { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
      ],
      "takkyubin_test",
      domesticInitialAddress,
    );
    if (!domesticInitial.ok)
      throw new Error(JSON.stringify(domesticInitial.error));
    expectBuyerShippingQuoteEvidence(
      domesticInitial.value,
      domesticInitialAddress.acceptance.addressValidationReference,
      "not_applicable",
    );
    expect(domesticInitial.value.quote).toMatchObject({
      lines: [
        {
          variantId: SHIPPING_MATCHA_VARIANT_ID,
          quantity: 1,
          lineTotal: { amountMinor: 4_200, currency: "JPY" },
        },
        {
          variantId: SHIPPING_TARO_VARIANT_ID,
          quantity: 1,
          lineTotal: { amountMinor: 3_800, currency: "JPY" },
        },
      ],
      totals: {
        subtotal: { amountMinor: 8_000, currency: "JPY" },
        duty: { amountMinor: 0, currency: "JPY" },
        shipping: { amountMinor: 900, currency: "JPY" },
      },
      shipping: {
        service: { code: "takkyubin_test" },
        destinationCountry: "JP",
        dutyTerms: { incoterm: "not_applicable" },
        packagePlan: {
          package: {
            customsLines: [],
          },
        },
      },
    });

    const domesticRefreshedAddress = await validateShippingAddress(
      fixture.storefront,
      session.value.token,
      {
        countryCode: "JP",
        recipientName: "Plan 33 Domestic Buyer",
        addressLine1: "2-2-2 Marunouchi",
        locality: "Chiyoda-ku",
        administrativeArea: "Tokyo",
        postalCode: "100-0005",
      },
      "plan33_domestic_refreshed_address",
    );
    const domesticRefreshed = await fixture.storefront.refreshShippingCheckout(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      domesticInitial.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.refresh-buyer-shipping-checkout.v1",
        idempotencyKey: "plan33_domestic_checkout_refresh",
        checkoutRevision: domesticInitial.value.revision,
        quoteDigest: domesticInitial.value.quote.quoteDigest,
        lines: [
          { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 2 },
          { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
        ],
        shippingServiceCode: "takkyubin_test",
        shippingDestination: domesticRefreshedAddress,
      },
    );
    if (!domesticRefreshed.ok)
      throw new Error(JSON.stringify(domesticRefreshed.error));
    expectBuyerShippingQuoteEvidence(
      domesticRefreshed.value,
      domesticRefreshedAddress.acceptance.addressValidationReference,
      "not_applicable",
    );
    expect(domesticRefreshed.value).toMatchObject({
      checkoutId: domesticInitial.value.checkoutId,
      revision: domesticInitial.value.revision + 1,
      quote: {
        lines: [
          { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 2 },
          { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
        ],
        totals: {
          subtotal: { amountMinor: 12_200, currency: "JPY" },
          duty: { amountMinor: 0, currency: "JPY" },
          shipping: { amountMinor: 900, currency: "JPY" },
        },
        shipping: {
          destinationCountry: "JP",
          dutyTerms: { incoterm: "not_applicable" },
          packagePlan: { package: { customsLines: [] } },
        },
      },
    });
    const domesticPayment = await payShippingCheckout(
      fixture,
      domesticRefreshed.value,
      session.value.token,
      "plan33_domestic_payment",
    );
    expect(domesticPayment.result.shipping.destinationCountry).toBe("JP");
    await completeShippingLifecycle(
      fixture,
      domesticPayment,
      "takkyubin_test",
      "plan33_domestic",
    );

    // The buyer types a double space, and validation proposes a correction.
    const singaporeEnteredAddress: CommerceBuyerShippingAddressV1 = {
      countryCode: "SG",
      recipientName: "Plan 33 Export Buyer",
      addressLine1: "1  Raffles Quay",
      locality: "Singapore",
      postalCode: "018956",
    };
    const singaporeInitialAddress = await validateShippingAddress(
      fixture.storefront,
      session.value.token,
      singaporeEnteredAddress,
      "plan33_singapore_initial_address",
    );
    expect(singaporeInitialAddress).toMatchObject({
      address: { addressLine1: "1 Raffles Quay" },
      acceptance: { kind: "accepted_correction" },
    });
    const validationAttempts = fixture.database
      .prepare(
        "SELECT attempt_json AS attemptJson FROM address_validation_attempt WHERE merchant_id = ?",
      )
      .all<Readonly<{ attemptJson: string }>>(MERCHANT_ID);
    expect(validationAttempts).toHaveLength(3);
    for (const attempt of validationAttempts) {
      expect(attempt.attemptJson).not.toMatch(
        /Plan 33|Marunouchi|100-0005|Raffles Quay|018956/u,
      );
    }
    const singaporeLines = [
      { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 1 },
      { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
    ];
    // An accepted correction does not cover the address as it was entered.
    expect(
      await createShippingCheckoutFromLines(
        fixture.storefront,
        session.value.token,
        "plan33_singapore_checkout_uncorrected",
        singaporeLines,
        "ems_test",
        { ...singaporeInitialAddress, address: singaporeEnteredAddress },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "http",
        status: 409,
        message: "Shipping address acceptance is unavailable",
      },
    });
    // While the EMS carrier is down, the Singapore services ask the buyer to
    // try again later, and a Singapore checkout gets no quote.
    fixture.carrierHealth.unavailableCapability =
      "carrier_rate_japan_post_ems_test";
    expect(
      await fixture.storefront.readCatalog(
        MERCHANT_ID,
        SHIPPING_STOREFRONT_ID,
        session.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        storefront: {
          shippingServices: [
            {
              destinationCountry: "JP",
              availability: { state: "available" },
            },
            {
              destinationCountry: "JP",
              availability: { state: "available" },
            },
            {
              destinationCountry: "SG",
              availability: {
                state: "temporarily_unavailable",
                recovery: "try_again_later",
              },
            },
            {
              destinationCountry: "SG",
              availability: {
                state: "temporarily_unavailable",
                recovery: "try_again_later",
              },
            },
          ],
        },
      },
    });
    expect(
      await createShippingCheckoutFromLines(
        fixture.storefront,
        session.value.token,
        "plan33_singapore_checkout_carrier_down",
        singaporeLines,
        "ems_test",
        singaporeInitialAddress,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.shippingServiceAvailability",
        },
      },
    });
    fixture.carrierHealth.unavailableCapability = undefined;
    const singaporeInitial = await createShippingCheckoutFromLines(
      fixture.storefront,
      session.value.token,
      "plan33_singapore_checkout",
      singaporeLines,
      "ems_test",
      singaporeInitialAddress,
    );
    if (!singaporeInitial.ok)
      throw new Error(JSON.stringify(singaporeInitial.error));
    expectBuyerShippingQuoteEvidence(
      singaporeInitial.value,
      singaporeInitialAddress.acceptance.addressValidationReference,
      "ddp",
    );
    expect(singaporeInitial.value.quote).toMatchObject({
      lines: [
        {
          variantId: SHIPPING_MATCHA_VARIANT_ID,
          quantity: 1,
          lineTotal: { amountMinor: 4_200, currency: "JPY" },
        },
        {
          variantId: SHIPPING_TARO_VARIANT_ID,
          quantity: 1,
          lineTotal: { amountMinor: 3_800, currency: "JPY" },
        },
      ],
      totals: {
        subtotal: { amountMinor: 8_000, currency: "JPY" },
        duty: { amountMinor: 400, currency: "JPY" },
        shipping: { amountMinor: 2_200, currency: "JPY" },
      },
      shipping: {
        service: { code: "ems_test" },
        destinationCountry: "SG",
        dutyTerms: { incoterm: "ddp" },
        packagePlan: {
          package: {
            weight: { grams: 2_450 },
            customsLines: [
              {
                description: "Six matcha cookies in one retail box",
                declaredValue: { amountMinor: 4_200, currency: "JPY" },
                countryOfOrigin: "JP",
                hsCode: "190531",
              },
              {
                description: "Six taro cookies in one retail box",
                declaredValue: { amountMinor: 3_800, currency: "JPY" },
                countryOfOrigin: "JP",
                hsCode: "190531",
              },
            ],
          },
        },
      },
    });

    const singaporeRefreshedAddress = await validateShippingAddress(
      fixture.storefront,
      session.value.token,
      {
        countryCode: "SG",
        recipientName: "Plan 33 Export Buyer",
        addressLine1: "2 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
      "plan33_singapore_refreshed_address",
    );
    const singaporeRefreshed = await fixture.storefront.refreshShippingCheckout(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      singaporeInitial.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.refresh-buyer-shipping-checkout.v1",
        idempotencyKey: "plan33_singapore_checkout_refresh",
        checkoutRevision: singaporeInitial.value.revision,
        quoteDigest: singaporeInitial.value.quote.quoteDigest,
        lines: [
          { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 2 },
          { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
        ],
        shippingServiceCode: "ems_test",
        shippingDestination: singaporeRefreshedAddress,
      },
    );
    if (!singaporeRefreshed.ok)
      throw new Error(JSON.stringify(singaporeRefreshed.error));
    expectBuyerShippingQuoteEvidence(
      singaporeRefreshed.value,
      singaporeRefreshedAddress.acceptance.addressValidationReference,
      "ddp",
    );
    expect(singaporeRefreshed.value).toMatchObject({
      checkoutId: singaporeInitial.value.checkoutId,
      revision: singaporeInitial.value.revision + 1,
      quote: {
        lines: [
          { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 2 },
          { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
        ],
        totals: {
          subtotal: { amountMinor: 12_200, currency: "JPY" },
          duty: { amountMinor: 610, currency: "JPY" },
          shipping: { amountMinor: 2_200, currency: "JPY" },
        },
        shipping: {
          destinationCountry: "SG",
          dutyTerms: { incoterm: "ddp" },
          packagePlan: {
            package: {
              weight: { grams: 3_660 },
              customsLines: [
                { declaredValue: { amountMinor: 8_400, currency: "JPY" } },
                { declaredValue: { amountMinor: 3_800, currency: "JPY" } },
              ],
            },
          },
        },
      },
    });
    const singaporePayment = await payShippingCheckout(
      fixture,
      singaporeRefreshed.value,
      session.value.token,
      "plan33_singapore_payment",
    );
    expect(singaporePayment.result.shipping.destinationCountry).toBe("SG");
    await completeShippingLifecycle(
      fixture,
      singaporePayment,
      "ems_test",
      "plan33_singapore",
    );
  } finally {
    fixture.close();
  }
}

it(
  "quotes and delivers export shipping to Australia, the United States and the European Union",
  exportShippingAcceptance,
);

/**
 * Plan 76 phase 5 slice 2. One storefront ships from Tokyo to Japan,
 * Singapore and the general international zones. Each zone quotes its own
 * carrier rate, consumption tax and duty: Australian GST, US duty at the
 * Japan rate, and the VAT of the buyer's EU country. A US order goes through
 * payment, label and tracking. A country outside every zone and a malformed
 * postal code are refused.
 */
async function exportShippingAcceptance(): Promise<void> {
  const fixture = createShippingFixture();
  try {
    await configureShippingBase(fixture.admin, exportShippingStorefrontCommand);
    await configurePlan23FlavoredCatalog(fixture.admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    const session = await fixture.storefront.createSession(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const catalog = await fixture.storefront.readCatalog(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      session.value.token,
    );
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    const published =
      catalog.value.storefront.fulfillment === "shipping"
        ? catalog.value.storefront.shippingServices.map(
            (service) =>
              `${service.destinationCountry}:${service.service.code}`,
          )
        : [];
    expect(published).toEqual(
      expect.arrayContaining([
        "JP:takkyubin_test",
        "SG:ems_test",
        "AU:ems_test",
        "AU:international_parcel_air_test",
        "US:ems_test",
        "DE:ems_test",
        "FR:international_parcel_air_test",
        "IE:ems_test",
      ]),
    );
    expect(published).toHaveLength(2 * (1 + 1 + 1 + 1 + 27));

    const basket = [
      { variantId: SHIPPING_MATCHA_VARIANT_ID, quantity: 1 },
      { variantId: SHIPPING_TARO_VARIANT_ID, quantity: 1 },
    ];
    const quote = async (
      key: string,
      address: CommerceBuyerShippingAddressV1,
      service: string,
    ) => {
      const destination = await validateShippingAddress(
        fixture.storefront,
        session.value.token,
        address,
        `${key}_address`,
      );
      const checkout = await createShippingCheckoutFromLines(
        fixture.storefront,
        session.value.token,
        `${key}_checkout`,
        basket,
        service,
        destination,
      );
      if (!checkout.ok) throw new Error(JSON.stringify(checkout.error));
      expectBuyerShippingQuoteEvidence(
        checkout.value,
        destination.acceptance.addressValidationReference,
        "ddp",
      );
      return checkout.value;
    };
    const australia = await quote(
      "export_au",
      {
        countryCode: "AU",
        recipientName: "Export Buyer Sydney",
        addressLine1: "1 Macquarie Street",
        locality: "Sydney",
        administrativeArea: "nsw",
        postalCode: "2000",
      },
      "ems_test",
    );
    const unitedStates = await quote(
      "export_us",
      {
        countryCode: "US",
        recipientName: "Export Buyer New York",
        addressLine1: "350 Fifth Avenue",
        locality: "New York",
        administrativeArea: "NY",
        postalCode: "10118",
      },
      "ems_test",
    );
    const germany = await quote(
      "export_de",
      {
        countryCode: "DE",
        recipientName: "Export Buyer Berlin",
        addressLine1: "Unter den Linden 77",
        locality: "Berlin",
        postalCode: "10117",
      },
      "ems_test",
    );
    const france = await quote(
      "export_fr",
      {
        countryCode: "FR",
        recipientName: "Export Buyer Paris",
        addressLine1: "5 Avenue Anatole France",
        locality: "Paris",
        postalCode: "75007",
      },
      "international_parcel_air_test",
    );
    const evidence = Object.fromEntries(
      [australia, unitedStates, germany, france].map((checkout) => [
        checkout.quote.shipping.destinationCountry,
        {
          service: checkout.quote.shipping.service.code,
          subtotal: checkout.quote.totals.subtotal.amountMinor,
          shipping: checkout.quote.totals.shipping.amountMinor,
          tax: checkout.quote.totals.tax.amountMinor,
          duty: checkout.quote.totals.duty.amountMinor,
          total: checkout.quote.totals.total.amountMinor,
          customsLines:
            checkout.quote.shipping.packagePlan.package.customsLines.length,
        },
      ]),
    );
    expect(evidence).toEqual({
      // GST 10% on goods and postage; no duty up to AUD 1,000.
      AU: {
        service: "ems_test",
        subtotal: 8_000,
        shipping: 3_150,
        tax: 1_115,
        duty: 0,
        total: 12_265,
        customsLines: 2,
      },
      // No consumption tax; duty 15% on the goods.
      US: {
        service: "ems_test",
        subtotal: 8_000,
        shipping: 3_900,
        tax: 0,
        duty: 1_200,
        total: 13_100,
        customsLines: 2,
      },
      // German VAT 19%; French VAT 20%; no duty up to EUR 150.
      DE: {
        service: "ems_test",
        subtotal: 8_000,
        shipping: 4_100,
        tax: 2_299,
        duty: 0,
        total: 14_399,
        customsLines: 2,
      },
      FR: {
        service: "international_parcel_air_test",
        subtotal: 8_000,
        shipping: 3_300,
        tax: 2_260,
        duty: 0,
        total: 13_560,
        customsLines: 2,
      },
    });

    // A country outside every zone, and a postal code of the wrong form.
    const refused = await Promise.all(
      [
        {
          countryCode: "CA",
          recipientName: "Export Buyer Toronto",
          addressLine1: "290 Bremner Boulevard",
          locality: "Toronto",
          postalCode: "M5V 3L9",
        },
        {
          countryCode: "US",
          recipientName: "Export Buyer New York",
          addressLine1: "350 Fifth Avenue",
          locality: "New York",
          administrativeArea: "NY",
          postalCode: "1011",
        },
      ].map(async (address, index) => {
        // Raw HTTP: the client refuses both before it sends them.
        const response = await fixture.fetch(
          `https://commerce.test/v1/public/merchants/${MERCHANT_ID}/storefronts/${SHIPPING_STOREFRONT_ID}/address-validations`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.value.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              schemaVersion: "commerce.validate-buyer-shipping-address.v1",
              idempotencyKey: `export_refused_${index}`,
              address,
            }),
          },
        );
        return response.status;
      }),
    );
    expect(refused).toEqual([400, 400]);

    const payment = await payShippingCheckout(
      fixture,
      unitedStates,
      session.value.token,
      "export_us_payment",
    );
    expect(payment.result.shipping.destinationCountry).toBe("US");
    await completeShippingLifecycle(fixture, payment, "ems_test", "export_us");
    const delivered = fixture.authority.readSnapshot(MERCHANT_ID);
    if (delivered === undefined) throw new Error("Snapshot was unavailable");
    const shipped = firstPartyShipmentById(
      delivered.resources,
      payment.result.shipmentId,
    );
    expect(JSON.stringify(shipped)).toContain('"JP-US-');
  } finally {
    fixture.close();
  }

  // The same store in a core with no shipping extension: no buyer sees it.
  const bare = createShippingFixture({ shipping: false });
  try {
    await configureShippingBase(bare.admin, exportShippingStorefrontCommand);
    const session = await bare.storefront.createSession(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const catalog = await bare.storefront.readCatalog(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      session.value.token,
    );
    expect(catalog.ok ? "offered" : catalog.error).toMatchObject({
      status: 404,
    });
  } finally {
    bare.close();
  }
}

/** The base storefront with export zones and the export tax account. */
function exportShippingStorefrontCommand(
  expectedMerchantRevision: number,
): ConfigureCommerceShippingStorefrontV1 {
  const base = baseShippingStorefrontCommand(expectedMerchantRevision);
  return {
    ...base,
    idempotencyKey: "plan76_export_shipping_storefront",
    storefront: {
      ...base.storefront,
      name: "Japan cookie store for export",
      checkout: {
        ...base.storefront.checkout,
        tax: {
          kind: "provider_quoted",
          providerAccountReference: "tax_account_export_test",
        },
      },
    },
    shippingProfile: {
      ...base.shippingProfile,
      name: "Japan export",
      routes: [
        ...base.shippingProfile.routes,
        ...(
          [
            ["australia", ["AU"]],
            ["united_states", ["US"]],
            ["european_union", COMMERCE_EUROPEAN_UNION_COUNTRIES],
          ] as const
        ).map(([zone, destinationCountries]) => ({
          kind: "international" as const,
          routeId: `route_jp_${zone}_post`,
          zoneId: `zone_${zone}`,
          carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
          serviceCodes: ["ems_test", "international_parcel_air_test"],
          destinationCountries: [...destinationCountries],
          dutyCapabilityId: `duty_${zone}_test`,
          incoterm: "ddp" as const,
        })),
      ],
    },
  };
}

type ShippingFixture = Readonly<{
  database: NodeCommerceDatabase;
  authority: CommerceAuthority;
  fetch: CommerceHttpApi["fetch"];
  admin: CommerceAdminClient;
  storefront: CommerceStorefrontClient;
  paymentGateway: Plan33PaymentGateway;
  carrierHealth: Plan33CarrierHealth;
  close: () => void;
}>;

function replacementProfileConfiguration(
  configuration: CheckoutProfileConfiguration,
): CheckoutProfileConfiguration {
  return {
    ...configuration,
    presentationPolicy: {
      ...configuration.presentationPolicy,
      locale: "en-US",
      merchantDisplayName: "Plan 33 Replacement Cafe",
    },
  };
}

type ShippingLine = CommerceBuyerShippingCheckoutLineV1;
type ProvidedShippingDestination = Variant<
  CreateCommerceBuyerShippingCheckoutV1["shippingDestination"],
  "provided_address"
>;
type ShippingAddressEvidence = ProvidedShippingDestination;
type PlacedShippingPayment = Extract<
  CommerceBuyerPaymentResultV1,
  { state: "placed"; shipping: unknown }
>;
type ShippingPaymentEvidence = Readonly<{
  result: PlacedShippingPayment;
  paymentAttemptId: string;
}>;

function expectBuyerShippingQuoteEvidence(
  checkout: CommerceBuyerQuotedShippingCheckoutV1,
  addressValidationReference: string,
  expectedIncoterm: "not_applicable" | "ddp" | "dap",
): void {
  const shipping = checkout.quote.shipping;
  const lineIds = new Set<string>();
  for (const line of checkout.quote.lines) lineIds.add(line.checkoutLineId);
  expect(shipping.addressValidationReference).toBe(addressValidationReference);
  expect(shipping.carrierQuote.rateReference).toMatch(/^rate_[0-9a-f]{64}$/u);
  expect(shipping.taxQuote.quoteReference).toMatch(/^tax_[0-9a-f]{64}$/u);
  expect(shipping.dutyQuote.quoteReference).toMatch(/^duty_[0-9a-f]{64}$/u);
  expect(shipping.taxQuote.registrationPolicyReference).toBe(
    `tax_registration_${SHIPPING_STOREFRONT_ID}`,
  );
  expect(shipping.dutyTerms.incoterm).toBe(expectedIncoterm);
  expect(shipping.dutyQuote.incoterm).toBe(expectedIncoterm);
  expect(shipping.carrierQuote.shippingAmount).toEqual(
    checkout.quote.totals.shipping,
  );
  expect(shipping.taxQuote.taxAmount).toEqual(checkout.quote.totals.tax);
  expect(shipping.dutyQuote.dutyAmount).toEqual(checkout.quote.totals.duty);
  const allocationGroups = [
    shipping.carrierQuote.lineAllocations,
    shipping.taxQuote.lineAllocations,
    shipping.dutyQuote.lineAllocations,
  ];
  for (const allocations of allocationGroups) {
    const seenLineIds = new Set<string>();
    for (const allocation of allocations) {
      expect(lineIds.has(allocation.checkoutLineId)).toBe(true);
      expect(seenLineIds.has(allocation.checkoutLineId)).toBe(false);
      seenLineIds.add(allocation.checkoutLineId);
    }
    expect(seenLineIds).toEqual(lineIds);
  }
  expect(
    sumBuyerShippingAllocations(shipping.carrierQuote.lineAllocations),
  ).toBe(checkout.quote.totals.shipping.amountMinor);
  expect(sumBuyerShippingAllocations(shipping.taxQuote.lineAllocations)).toBe(
    checkout.quote.totals.tax.amountMinor,
  );
  expect(sumBuyerShippingAllocations(shipping.dutyQuote.lineAllocations)).toBe(
    checkout.quote.totals.duty.amountMinor,
  );
  expect(shipping).not.toHaveProperty("providerAccountReference");
  expect(shipping).not.toHaveProperty("protectedAddressReference");
  expect(shipping).not.toHaveProperty("addressDigest");
  expect(shipping).not.toHaveProperty("inputDigest");
  expect(JSON.stringify(shipping)).not.toContain("japan_post_ems_test");
  expect(JSON.stringify(shipping)).not.toContain("tax_account_sg_test");
}

function sumBuyerShippingAllocations(
  allocations: readonly Readonly<{
    amount: Readonly<{ amountMinor: number; currency: string }>;
  }>[],
): number {
  let amountMinor = 0;
  for (const allocation of allocations)
    amountMinor += allocation.amount.amountMinor;
  return amountMinor;
}

async function configureShippingBase(
  admin: CommerceAdminClient,
  storefront: (
    expectedMerchantRevision: number,
  ) => ConfigureCommerceShippingStorefrontV1,
): Promise<void> {
  await createShippingItems(admin);
  await requireAppliedMutation(
    admin.configureShippingStorefront(clientInput(storefront(2))),
    "shipping storefront",
  );
  await receiveShippingStock(admin);
}

async function createShippingItems(admin: CommerceAdminClient): Promise<void> {
  const provisioned = await admin.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    createdAt: SHIPPING_NOW,
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  await requireAppliedMutation(
    admin.createInventoryItem(
      clientInput(shippingInventoryItemCommand(0, "cookie_box")),
    ),
    "cookie box item",
  );
  await requireAppliedMutation(
    admin.createInventoryItem(
      clientInput(shippingInventoryItemCommand(1, "carton")),
    ),
    "shipping carton item",
  );
}

async function receiveShippingStock(admin: CommerceAdminClient): Promise<void> {
  await requireAppliedMutation(
    admin.openInventoryPosition(
      clientInput(shippingInventoryPositionCommand(3, "cookie_box")),
    ),
    "cookie box position",
  );
  await requireAppliedMutation(
    admin.openInventoryPosition(
      clientInput(shippingInventoryPositionCommand(4, "carton")),
    ),
    "shipping carton position",
  );
  await requireAppliedMutation(
    admin.receiveInventory(
      clientInput(shippingReceiptCommand(5, "cookie_box")),
    ),
    "cookie box receipt",
  );
  await requireAppliedMutation(
    admin.receiveInventory(clientInput(shippingReceiptCommand(6, "carton"))),
    "shipping carton receipt",
  );
}

async function requireAppliedMutation(
  pending: Promise<CommerceClientResult<CommerceMutationResultV1>>,
  operation: string,
): Promise<void> {
  const result = await pending;
  if (!result.ok || result.value.outcome !== "applied") {
    throw new Error(`${operation} failed: ${JSON.stringify(result)}`);
  }
}

function shippingInventoryItemCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): CreateCommerceInventoryItemV1 {
  const cookieBox = kind === "cookie_box";
  return {
    schemaVersion: "commerce.create-inventory-item.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision,
    idempotencyKey: `plan33_shipping_inventory_item_${kind}`,
    requestedAt: SHIPPING_NOW,
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    merchantCode: cookieBox ? "COOKIE-BOX-6" : "SHIP-CARTON",
    name: cookieBox ? "Six-cookie box" : "Shipping carton",
    baseUnit: "each",
    category: cookieBox ? "finished_good" : "packaging",
    tracking: cookieBox
      ? { kind: "lot_tracked", expiry: "required" }
      : { kind: "aggregate" },
  };
}

function baseShippingStorefrontCommand(
  expectedMerchantRevision: number,
): ConfigureCommerceShippingStorefrontV1 {
  return {
    schemaVersion: "commerce.configure-shipping-storefront.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision,
    idempotencyKey: "plan33_shipping_storefront",
    requestedAt: SHIPPING_NOW,
    location: {
      id: "location_tokyo_fulfillment",
      revision: 1,
      name: "Tokyo fulfillment",
      kind: "fulfillment_center",
      lifecycle: { state: "active", activeAt: SHIPPING_NOW },
      occurredAt: SHIPPING_NOW,
    },
    salesChannel: {
      id: "channel_cookie_store_sg",
      revision: 1,
      name: "Singapore cookie store",
      kind: "online",
      lifecycle: { state: "active", activeAt: SHIPPING_NOW },
      occurredAt: SHIPPING_NOW,
    },
    product: {
      id: "product_cookie_box",
      revision: 1,
      title: "Six-cookie box",
      description: "Six assorted cookies shipped from Japan.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: SHIPPING_NOW,
    },
    variant: {
      id: "variant_cookie_box_6",
      revision: 1,
      productId: "product_cookie_box",
      sku: "COOKIE-BOX-6-SG",
      title: "Box of six",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: SHIPPING_NOW,
    },
    offer: {
      id: "offer_cookie_box_sg",
      revision: 1,
      variantId: "variant_cookie_box_6",
      salesChannelId: "channel_cookie_store_sg",
      price: { amountMinor: 3_600, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: SHIPPING_NOW },
      occurredAt: SHIPPING_NOW,
    },
    storefront: {
      storefrontId: SHIPPING_STOREFRONT_ID,
      revision: 1,
      name: "Japan cookie store for Singapore",
      salesChannelId: "channel_cookie_store_sg",
      fulfillment: {
        kind: "shipping",
        originLocationId: "location_tokyo_fulfillment",
        shippingProfileId: "shipping_profile_jp_sg",
      },
      checkout: {
        quoteTtlSeconds: 900,
        tax: {
          kind: "provider_quoted",
          providerAccountReference: "tax_account_sg_test",
        },
      },
      lifecycle: { state: "active", activeAt: SHIPPING_NOW },
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_cookie_box_sg",
      variantId: "variant_cookie_box_6",
      revision: 1,
      scope: { kind: "location", locationId: "location_tokyo_fulfillment" },
      mode: {
        kind: "direct",
        components: [
          {
            inventoryItemId: "inventory_cookie_box_6",
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
          {
            inventoryItemId: "inventory_shipping_carton",
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
        ],
        commitOn: "fulfillment_completed",
      },
      lifecycle: "active",
    },
    shippingProfile: {
      shippingProfileId: "shipping_profile_jp_sg",
      revision: 1,
      name: "Japan to Singapore",
      originLocationId: "location_tokyo_fulfillment",
      routes: [
        {
          kind: "domestic_japan",
          routeId: "route_jp_domestic_yamato",
          zoneId: "zone_domestic_japan",
          carrierRateCapabilityId: "carrier_rate_yamato_test",
          serviceCodes: ["takkyubin_test", "takkyubin_priority_test"],
        },
        {
          kind: "japan_to_singapore",
          routeId: "route_jp_sg_ems",
          zoneId: "zone_singapore",
          carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
          serviceCodes: ["ems_test", "international_parcel_air_test"],
          dutyCapabilityId: "duty_singapore_test",
          incoterm: "ddp",
        },
      ],
      lifecycle: { state: "active", activeAt: SHIPPING_NOW },
    },
    shippingSpecification: {
      variantId: "variant_cookie_box_6",
      variantRevision: 1,
      shippingProfileId: "shipping_profile_jp_sg",
      shippingProfileRevision: 1,
      eligibility: {
        kind: "physical",
        weight: { grams: 1_200 },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 100,
        },
        countryOfOrigin: "JP",
        hsCode: "190531",
        description: "Six baked cookies in one retail box",
      },
    },
  };
}

function shippingInventoryPositionCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): OpenCommerceInventoryPositionV1 {
  const cookieBox = kind === "cookie_box";
  return {
    schemaVersion: "commerce.open-inventory-position.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision,
    idempotencyKey: `plan33_shipping_inventory_position_${kind}`,
    requestedAt: SHIPPING_NOW,
    inventoryPositionId: cookieBox
      ? "position_cookie_box_tokyo"
      : "position_carton_tokyo",
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    inventoryItemRevision: 1,
    locationId: "location_tokyo_fulfillment",
    locationRevision: 1,
  };
}

function shippingReceiptCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): ReceiveCommerceInventoryV3 {
  const cookieBox = kind === "cookie_box";
  return {
    schemaVersion: "commerce.receive-inventory.v3",
    purchase: { kind: "unlinked" },
    merchantId: MERCHANT_ID,
    expectedMerchantRevision,
    idempotencyKey: `plan33_shipping_receipt_${kind}`,
    requestedAt: SHIPPING_NOW,
    receiptId: "plan33_shipping_opening_stock",
    receiptLineId: `plan33_shipping_receipt_line_${kind}`,
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    inventoryItemRevision: 1,
    inventoryPositionId: cookieBox
      ? "position_cookie_box_tokyo"
      : "position_carton_tokyo",
    inventoryPositionRevision: 1,
    locationId: "location_tokyo_fulfillment",
    receivedQuantity: { amount: 10, scale: 0, unit: "each" },
    lot: cookieBox
      ? {
          kind: "tracked",
          lotId: "plan33_lot_cookie_box_tokyo",
          lotCode: "COOKIE-BOX-PLAN33-20260831-A",
          expiry: { kind: "expires", expiresAt: "2026-09-07T00:00:00.000Z" },
        }
      : { kind: "not_tracked" },
    receivedAt: SHIPPING_NOW,
  };
}

function createShippingFixture(
  options: Readonly<{ shipping: boolean }> = { shipping: true },
): ShippingFixture {
  const databasePath = join(
    tmpdir(),
    `commerce-plan33-shipping-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, SHIPPING_NOW);
  const paymentGateway = new Plan33PaymentGateway(() => SHIPPING_NOW);
  const carrierHealth = new Plan33CarrierHealth();
  const authority = new CommerceAuthority({
    database,
    signer: new Plan33Signer(),
    paymentGateway,
    now: () => SHIPPING_NOW,
    shippingGateway: createJapanShippingGateway(SHIPPING_SIGNING_KEY),
    ...(options.shipping
      ? { shipping: createJapanExportShipping(SHIPPING_SIGNING_KEY) }
      : {}),
    checkoutCapabilityHealthProvider: carrierHealth,
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "plan33_shipping_buyer_session_secret",
      now: () => SHIPPING_NOW,
    }),
    addressValidations: createLocalShippingAddressValidationService(
      database,
      () => SHIPPING_NOW,
    ),
    serviceToken: SERVICE_TOKEN,
  });
  const admin = new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
  const storefront = new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
  return {
    database,
    authority,
    fetch: api.fetch,
    admin,
    storefront,
    paymentGateway,
    carrierHealth,
    close: () => {
      authority.close();
      removeDatabase(databasePath);
    },
  };
}

async function validateShippingAddress(
  client: CommerceStorefrontClient,
  sessionToken: string,
  address: CommerceBuyerShippingAddressV1,
  idempotencyKey: string,
): Promise<ShippingAddressEvidence> {
  const result = await client.validateShippingAddress(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    sessionToken,
    {
      schemaVersion: "commerce.validate-buyer-shipping-address.v1",
      idempotencyKey,
      address,
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  switch (result.value.state) {
    case "accepted":
      return {
        kind: "provided_address",
        address: result.value.address,
        acceptance: {
          kind: "accepted_as_entered",
          addressValidationReference: result.value.validationReference,
        },
      };
    case "correction_required":
      return {
        kind: "provided_address",
        address: result.value.proposedAddress,
        acceptance: {
          kind: "accepted_correction",
          addressValidationReference: result.value.validationReference,
        },
      };
    case "unserviceable":
      throw new Error(result.value.reason);
    case "indeterminate":
      throw new Error(
        `Address validation is indeterminate until ${result.value.retryAfter}`,
      );
    default:
      return assertNever(result.value, "Unsupported shipping test branch");
  }
}

async function createShippingCheckoutFromLines(
  client: CommerceStorefrontClient,
  sessionToken: string,
  idempotencyKey: string,
  lines: readonly ShippingLine[],
  shippingServiceCode: string,
  shippingDestination: ProvidedShippingDestination,
): Promise<CommerceClientResult<CommerceBuyerQuotedShippingCheckoutV1>> {
  const cart = await client.createCart(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    sessionToken,
    {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: `${idempotencyKey}_cart`,
      lines: lines.map(shippingCartLine),
    },
  );
  if (!cart.ok) return { ok: false, error: cart.error };
  return client.createShippingCheckout(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    sessionToken,
    {
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey,
      cartId: cart.value.cartId,
      cartRevision: cart.value.revision,
      buyer: BUYER,
      shippingServiceCode,
      shippingDestination,
    },
  );
}

function shippingCartLine(line: ShippingLine): Readonly<{
  kind: "catalog";
  variantId: string;
  quantity: number;
}> {
  return {
    kind: "catalog",
    variantId: line.variantId,
    quantity: line.quantity,
  };
}

async function payShippingCheckout(
  fixture: ShippingFixture,
  checkout: CommerceBuyerQuotedShippingCheckoutV1,
  sessionToken: string,
  idempotencyKey: string,
): Promise<ShippingPaymentEvidence> {
  const beforeReconcileCalls = fixture.paymentGateway.reconcileCalls;
  const paymentCommand = {
    schemaVersion: "commerce.create-buyer-payment-session.v1" as const,
    idempotencyKey,
    checkoutRevision: checkout.revision,
    quoteDigest: checkout.quote.quoteDigest,
    returnUrl: `https://storefront.test/${idempotencyKey}-return`,
  };
  const paymentSession = await fixture.storefront.createPaymentSession(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    checkout.checkoutId,
    sessionToken,
    paymentCommand,
  );
  if (!paymentSession.ok || paymentSession.value.state !== "ready") {
    throw new Error(JSON.stringify(paymentSession));
  }
  const paymentSessionReplay = await fixture.storefront.createPaymentSession(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    checkout.checkoutId,
    sessionToken,
    paymentCommand,
  );
  expect(paymentSessionReplay).toEqual(paymentSession);

  const reconcileCommand = {
    schemaVersion: "commerce.reconcile-buyer-payment.v1" as const,
    idempotencyKey,
    checkoutRevision: checkout.revision,
    quoteDigest: checkout.quote.quoteDigest,
    confirmation: { kind: "provider_ui_completed" as const },
  };
  const placement = await fixture.storefront.reconcilePayment(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    checkout.checkoutId,
    sessionToken,
    reconcileCommand,
  );
  if (
    !placement.ok ||
    placement.value.state !== "placed" ||
    placement.value.shipping === undefined
  ) {
    throw new Error(JSON.stringify(placement));
  }
  const result = placement.value;
  expect(fixture.paymentGateway.reconcileCalls).toBe(beforeReconcileCalls + 1);
  const placementReplay = await fixture.storefront.reconcilePayment(
    MERCHANT_ID,
    SHIPPING_STOREFRONT_ID,
    checkout.checkoutId,
    sessionToken,
    reconcileCommand,
  );
  expect(placementReplay).toEqual(placement);
  expect(fixture.paymentGateway.reconcileCalls).toBe(beforeReconcileCalls + 1);
  return {
    result,
    paymentAttemptId: paymentSession.value.paymentAttemptId,
  };
}

async function completeShippingLifecycle(
  fixture: ShippingFixture,
  payment: ShippingPaymentEvidence,
  shippingServiceCode: string,
  idempotencyPrefix: string,
): Promise<void> {
  const initialSnapshot = fixture.authority.readSnapshot(MERCHANT_ID);
  if (initialSnapshot === undefined)
    throw new Error("Shipping snapshot was unavailable");
  const shipment = firstPartyShipmentById(
    initialSnapshot.resources,
    payment.result.shipmentId,
  );
  if (shipment === undefined)
    throw new Error("Shipping shipment was unavailable");
  const rateCommand: QuoteShipmentLabelRateCommand = {
    schemaVersion: "commerce.quote-shipment-label-rate.v1",
    merchantId: MERCHANT_ID,
    idempotencyKey: `${idempotencyPrefix}_label_rate`,
    requestedAt: SHIPPING_NOW,
    shipmentId: shipment.id,
    shipmentRevision: shipment.revision,
  };
  const rate = await fixture.admin.quoteShipmentLabelRate(
    clientInput(rateCommand),
  );
  if (!rate.ok) throw new Error(JSON.stringify(rate.error));
  expect(rate.value).toMatchObject({
    outcome: "quoted",
    rate: {
      shipmentId: shipment.id,
      shipmentRevision: shipment.revision,
      service: { code: shippingServiceCode },
    },
  });
  const purchaseCommand: PurchaseShippingLabelCommand = {
    schemaVersion: "commerce.purchase-shipping-label.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: initialSnapshot.merchantRevision,
    idempotencyKey: `${idempotencyPrefix}_label_purchase`,
    requestedAt: SHIPPING_NOW,
    shipmentId: shipment.id,
    shipmentRevision: shipment.revision,
    labelRateId: rate.value.rate.labelRateId,
    labelAttemptId: `${idempotencyPrefix}_label_attempt`,
  };
  expect(
    await fixture.admin.purchaseShippingLabel(clientInput(purchaseCommand)),
  ).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });

  const labeledSnapshot = fixture.authority.readSnapshot(MERCHANT_ID);
  if (labeledSnapshot === undefined)
    throw new Error("Labeled shipping snapshot was unavailable");
  const labeledShipment = firstPartyShipmentById(
    labeledSnapshot.resources,
    shipment.id,
  );
  if (
    labeledShipment === undefined ||
    labeledShipment.lifecycle.state !== "label_purchased"
  ) {
    throw new Error("Shipping label was not purchased");
  }
  const routeBinding = acceptedShippingRouteBinding(
    labeledSnapshot.resources,
    labeledShipment.id,
  );
  const carrier = createJapanShippingGateway(SHIPPING_SIGNING_KEY);
  const inTransitEvent = {
    state: "in_transit" as const,
    providerEventId: `${idempotencyPrefix}_carrier_in_transit`,
    occurredAt: "2026-08-14T10:20:00.000Z",
    location: "Tokyo",
  };
  const inTransitCommand: RecordShippingTrackingCommand = {
    schemaVersion: "commerce.record-shipping-tracking.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: labeledSnapshot.merchantRevision,
    idempotencyKey: `${idempotencyPrefix}_tracking_in_transit`,
    requestedAt: inTransitEvent.occurredAt,
    shipmentId: labeledShipment.id,
    shipmentRevision: labeledShipment.revision,
    event: {
      ...inTransitEvent,
      signature: carrier.signTrackingEvent({
        routeBinding,
        serviceCode: shippingServiceCode,
        shipmentId: labeledShipment.id,
        ...inTransitEvent,
      }),
    },
  };
  expect(
    await fixture.admin.recordShippingTracking(clientInput(inTransitCommand)),
  ).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });

  const handedSnapshot = fixture.authority.readSnapshot(MERCHANT_ID);
  if (handedSnapshot === undefined)
    throw new Error("In-transit shipping snapshot was unavailable");
  const handedShipment = firstPartyShipmentById(
    handedSnapshot.resources,
    shipment.id,
  );
  if (
    handedShipment === undefined ||
    handedShipment.lifecycle.state !== "in_transit"
  ) {
    throw new Error("Shipping handoff was not recorded");
  }
  const deliveredEvent = {
    state: "delivered" as const,
    providerEventId: `${idempotencyPrefix}_carrier_delivered`,
    occurredAt: "2026-08-14T10:21:00.000Z",
    location: "Singapore",
  };
  const deliveredCommand: RecordShippingTrackingCommand = {
    schemaVersion: "commerce.record-shipping-tracking.v1",
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: handedSnapshot.merchantRevision,
    idempotencyKey: `${idempotencyPrefix}_tracking_delivered`,
    requestedAt: deliveredEvent.occurredAt,
    shipmentId: handedShipment.id,
    shipmentRevision: handedShipment.revision,
    event: {
      ...deliveredEvent,
      signature: carrier.signTrackingEvent({
        routeBinding,
        serviceCode: shippingServiceCode,
        shipmentId: handedShipment.id,
        ...deliveredEvent,
      }),
    },
  };
  expect(
    await fixture.admin.recordShippingTracking(clientInput(deliveredCommand)),
  ).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });
  const deliveredSnapshot = fixture.authority.readSnapshot(MERCHANT_ID);
  if (deliveredSnapshot === undefined)
    throw new Error("Delivered shipping snapshot was unavailable");
  const deliveredShipment = firstPartyShipmentById(
    deliveredSnapshot.resources,
    shipment.id,
  );
  if (
    deliveredShipment === undefined ||
    deliveredShipment.lifecycle.state !== "delivered"
  ) {
    throw new Error("Shipping delivery was not recorded");
  }
  const acceptedCheckout = readCheckout(
    fixture.database,
    MERCHANT_ID,
    payment.result.checkoutId,
  );
  if (
    acceptedCheckout === undefined ||
    acceptedCheckout.lifecycle.state !== "accepted"
  ) {
    throw new Error("Accepted shipping checkout evidence was unavailable");
  }
  expect(checkoutOnlineSource(acceptedCheckout)?.buyerContact).toEqual({
    kind: "email",
    emailDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  const fulfillment = acceptedCheckout.lifecycle.quote.fulfillment;
  if (fulfillment.kind !== "shipping")
    throw new Error("Shipping quote evidence was unavailable");
  expect(fulfillment.quote.address.addressValidationReference).toMatch(
    /^address_validation_/u,
  );
  expect(fulfillment.quote.address.addressDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(fulfillment.quote.address)).not.toContain("Plan 33");
  const capturedAttempt = readCheckoutPaymentAttemptForCheckout(
    fixture.database,
    MERCHANT_ID,
    payment.result.checkoutId,
  );
  expect(capturedAttempt).toMatchObject({
    paymentAttemptId: payment.paymentAttemptId,
    binding: {
      checkoutId: payment.result.checkoutId,
      quoteDigest: acceptedCheckout.lifecycle.quote.quoteDigest,
    },
    lifecycle: {
      state: "captured",
      providerPaymentReference: expect.any(String),
    },
  });
  expect(
    await fixture.storefront.recoverOrder(
      MERCHANT_ID,
      SHIPPING_STOREFRONT_ID,
      payment.result.checkoutId,
      payment.result.orderRecovery.token,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      state: "delivered",
      checkoutId: payment.result.checkoutId,
      orderId: payment.result.orderId,
      shipmentId: payment.result.shipmentId,
    },
  });
}

function firstPartyShipmentById(
  resources: CommerceResourcesV1,
  shipmentId: string,
):
  | Variant<CommerceResourcesV1["shipments"][number], "first_party">
  | undefined {
  const shipment = resources.shipments.find(
    (candidate) => candidate.id === shipmentId,
  );
  return shipment?.kind === "first_party" ? shipment : undefined;
}

function acceptedShippingRouteBinding(
  resources: CommerceResourcesV1,
  shipmentId: string,
): ShippingRouteBinding {
  const shipment = firstPartyShipmentById(resources, shipmentId);
  if (shipment === undefined)
    throw new Error(`Shipping shipment ${shipmentId} was unavailable`);
  const fulfillment = resources.fulfillments.find(
    (candidate) => candidate.id === shipment.fulfillmentId,
  );
  if (
    fulfillment?.kind !== "shipping" ||
    fulfillment.binding.kind !== "first_party_checkout"
  ) {
    throw new Error(
      `Accepted shipping route was unavailable for ${shipmentId}`,
    );
  }
  return fulfillment.binding.acceptedShippingQuote.routeBinding;
}

function removeDatabase(databasePath: string): void {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
}
