import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CreateCommerceBuyerPaymentSessionV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceClientResult,
  type CommerceInventoryMovementV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  startCommerceWorker,
  type CommerceWorker,
} from "./commerce-fixture-worker";
import {
  executeCafeOperation,
  readCafeOperations,
} from "../src/commerce/cafe-operations";
import {
  executeShippingOperation,
  readShippingOperations,
} from "../src/commerce/shipping-operations";

const SCENARIO_TIMESTAMP = "2026-08-14T09:30:00.000Z";
// Each case starts the fixture Worker and seeds the Plan 22 café over HTTP.

it("runs the canonical menu and production actions from the CafeOS boundary", async () => {
  const fixture = await createFixture();
  try {
    await fixture.underclerk.fixture("merchant_plan22_demo", {
      kind: "plan22_phase3_cafe",
      organisationId: "organisation_plan22_demo",
    });
    await expect(
      readCafeOperations(fixture.client, "merchant_plan22_demo"),
    ).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: "satyr.cafe-operations.v1",
        merchantRevision: 93,
        menu: "ready_to_publish",
        production: "ready_to_complete",
        preparation: "awaiting_order",
        pickup: "awaiting_order",
        order: null,
        nextAction: "publish_menu",
        availableActions: ["publish_menu", "complete_production"],
        relatedResources: [],
      },
    });

    const published = await executeCafeOperation({
      client: fixture.client,
      merchantId: "merchant_plan22_demo",
      action: "publish_menu",
      idempotencyKey: "portal-cafe-publish-menu",
    });
    expect(published).toMatchObject({
      ok: true,
      value: {
        receipt: {
          outcome: "applied",
          receipt: { commandKind: "publish_menu" },
        },
        view: { merchantRevision: 94, menu: "published" },
      },
    });

    const completed = await executeCafeOperation({
      client: fixture.client,
      merchantId: "merchant_plan22_demo",
      action: "complete_production",
      idempotencyKey: "portal-cafe-complete-production",
    });
    expect(completed).toMatchObject({
      ok: true,
      value: {
        receipt: {
          outcome: "applied",
          receipt: { commandKind: "complete_production_batch" },
        },
        view: {
          merchantRevision: 95,
          menu: "published",
          production: "completed",
          availableActions: [],
        },
      },
    });
    const stock = await fixture.client.readStockSnapshot("merchant_plan22_demo");
    if (!stock.ok) throw new Error(JSON.stringify(stock.error));
    expect(stock.value.movements.filter(isProductionMovement)).toHaveLength(4);

    const session = await fixture.storefront.createSession(
      "merchant_plan22_demo",
      "storefront_cafe",
      {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Cafe buyer session failed");
    const catalog = await fixture.storefront.readCatalog(
      "merchant_plan22_demo",
      "storefront_cafe",
      session.value.token,
    );
    if (!catalog.ok) throw new Error("Cafe buyer catalog failed");
    expect(catalog.value.menus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          menuId: "menu_cafe_main",
          entries: expect.arrayContaining([
            expect.objectContaining({
              menuEntryId: "menu_entry_sesame_latte",
              price: { amountMinor: 700, currency: "JPY" },
            }),
            expect.objectContaining({
              menuEntryId: "menu_entry_sesame_cookie",
              price: { amountMinor: 450, currency: "JPY" },
            }),
            expect.objectContaining({
              menuEntryId: "menu_entry_sesame_financier",
              price: { amountMinor: 500, currency: "JPY" },
            }),
          ]),
        }),
      ]),
    );
    const cafeMenu = catalog.value.menus.find(
      (menu) => menu.menuId === "menu_cafe_main",
    );
    expect(cafeMenu?.entries).toHaveLength(12);
    expect(cafeMenu?.entries.map((entry) => entry.menuEntryId)).toEqual(
      expect.arrayContaining([
        "menu_entry_ginger_milk_tea",
        "menu_entry_ginger_cookie",
        "menu_entry_ginger_financier",
        "menu_entry_taro_milk_tea",
        "menu_entry_taro_cookie",
        "menu_entry_taro_financier",
        "menu_entry_matcha_tea",
        "menu_entry_matcha_cookie",
        "menu_entry_matcha_financier",
      ]),
    );
    expect(
      cafeMenu?.entries.find(
        (entry) => entry.menuEntryId === "menu_entry_ginger_milk_tea",
      ),
    ).toMatchObject({
      modifierGroups: [{ modifierGroupId: "modifier_group_milk", revision: 1 }],
    });
    expect(
      cafeMenu?.entries.find(
        (entry) => entry.menuEntryId === "menu_entry_taro_milk_tea",
      ),
    ).toMatchObject({
      modifierGroups: [{ modifierGroupId: "modifier_group_milk", revision: 1 }],
    });
    const cartLines = [
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
    ];
    const cart = await fixture.storefront.createCart(
      "merchant_plan22_demo",
      "storefront_cafe",
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: "cafe-operations-buyer-cart",
        lines: cartLines,
      },
    );
    if (!cart.ok) throw new Error("Cafe buyer Cart failed");
    const checkout = await fixture.storefront.createPickupCheckout(
      "merchant_plan22_demo",
      "storefront_cafe",
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
        idempotencyKey: "cafe-operations-buyer-checkout",
        cartId: cart.value.cartId,
        cartRevision: cart.value.revision,
        buyer: {
          kind: "guest",
          contact: { kind: "email", email: "buyer@example.test" },
        },
      },
    );
    if (!checkout.ok) throw new Error("Cafe buyer checkout failed");
    expect(checkout.value.quote.totals).toEqual({
      subtotal: { amountMinor: 1_250, currency: "JPY" },
      tax: { amountMinor: 125, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 1_375, currency: "JPY" },
    });
    const payment = await completeBuyerCheckout(
      fixture.storefront,
      "merchant_plan22_demo",
      "storefront_cafe",
      checkout.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: "cafe-operations-buyer-payment",
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
      },
    );
    if (!payment.ok || payment.value.state !== "placed")
      throw new Error("Cafe buyer payment failed");
    await expect(
      readCafeOperations(fixture.client, "merchant_plan22_demo"),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        preparation: "ready_to_create",
        pickup: "requested",
        nextAction: "create_preparation",
        availableActions: ["create_preparation"],
        order: {
          orderId: expect.any(String),
          fulfillmentId: expect.any(String),
          items: [
            expect.objectContaining({
              title: "Sesame Cookie",
              quantity: { amount: 1, scale: 0, unit: "each" },
              modifiers: [],
              linkedResources: expect.arrayContaining([
                {
                  kind: "inventory_item",
                  id: "inventory_sesame_cookie",
                  label: "Sesame cookie",
                },
                {
                  kind: "recipe_revision",
                  id: "recipe_sesame_cookie_stocked",
                  label: "Sesame cookie batch",
                },
              ]),
            }),
            expect.objectContaining({
              title: "Sesame Latte",
              quantity: { amount: 1, scale: 0, unit: "each" },
              modifiers: [
                {
                  modifierGroupId: "modifier_group_milk",
                  modifierOptionId: "modifier_option_oat_milk",
                  groupName: "Milk",
                  name: "Oat milk",
                },
              ],
              linkedResources: expect.arrayContaining([
                {
                  kind: "inventory_item",
                  id: "inventory_black_sesame",
                  label: "Black sesame",
                },
                {
                  kind: "inventory_item",
                  id: "inventory_oat_milk",
                  label: "Oat milk",
                },
                {
                  kind: "recipe_revision",
                  id: "recipe_sesame_latte",
                  label: "Sesame latte",
                },
              ]),
            }),
          ],
        },
      },
    });

    await requireCafeAction(
      fixture.client,
      "create_preparation",
      "portal-cafe-create-preparation",
    );
    await requireCafeAction(
      fixture.client,
      "start_preparation",
      "portal-cafe-start-preparation",
    );
    await requireCafeAction(
      fixture.client,
      "complete_preparation",
      "portal-cafe-complete-preparation",
    );
    await requireCafeAction(
      fixture.client,
      "mark_pickup_ready",
      "portal-cafe-mark-ready",
    );
    const pickup = await requireCafeAction(
      fixture.client,
      "complete_pickup",
      "portal-cafe-complete-pickup",
    );
    expect(pickup).toMatchObject({
      ok: true,
      value: {
        view: {
          menu: "published",
          production: "completed",
          preparation: "completed",
          pickup: "completed",
          nextAction: null,
          availableActions: [],
        },
      },
    });
  } finally {
    await fixture.close();
  }
}, 60_000);

it("runs shipping rate and label tasks while signed carrier events own handoff and delivery", async () => {
  const fixture = await createFixture();
  try {
    await fixture.underclerk.fixture("merchant_plan22_demo", {
      kind: "plan22_phase3_cafe",
      organisationId: "organisation_plan22_demo",
    });
    await fixture.underclerk.fixture("merchant_plan22_demo", {
      kind: "plan22_phase4_shipping",
      organisationId: "organisation_plan22_demo",
    });
    const session = await fixture.storefront.createSession(
      "merchant_plan22_demo",
      "storefront_cookie_store_sg",
      {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Shipping buyer session failed");
    const shippingAddress = {
      countryCode: "SG" as const,
      recipientName: "Shipping Workspace Buyer",
      addressLine1: "1 Raffles Quay",
      locality: "Singapore" as const,
      postalCode: "018956",
    };
    const validation = await fixture.storefront.validateShippingAddress(
      "merchant_plan22_demo",
      "storefront_cookie_store_sg",
      session.value.token,
      {
        schemaVersion: "underclerk.validate-buyer-shipping-address.v1",
        idempotencyKey: "shipping-operations-address-validation",
        address: shippingAddress,
      },
    );
    if (!validation.ok || validation.value.state !== "accepted") {
      throw new Error("Shipping buyer address validation failed");
    }
    const cart = await fixture.storefront.createCart(
      "merchant_plan22_demo",
      "storefront_cookie_store_sg",
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-cart.v1",
        idempotencyKey: "shipping-operations-buyer-cart",
        lines: [
          { kind: "catalog", variantId: "variant_cookie_box_6", quantity: 1 },
        ],
      },
    );
    if (!cart.ok) throw new Error("Shipping buyer Cart failed");
    const checkout = await fixture.storefront.createShippingCheckout(
      "merchant_plan22_demo",
      "storefront_cookie_store_sg",
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
        idempotencyKey: "shipping-operations-buyer-checkout",
        cartId: cart.value.cartId,
        cartRevision: cart.value.revision,
        shippingServiceCode: "ems_test",
        buyer: {
          kind: "guest",
          contact: { kind: "email", email: "buyer@example.test" },
        },
        shippingDestination: {
          kind: "provided_address",
          address: shippingAddress,
          acceptance: {
            kind: "accepted_as_entered",
            addressValidationReference: validation.value.validationReference,
          },
        },
      },
    );
    if (!checkout.ok) throw new Error("Shipping buyer checkout failed");
    const payment = await completeBuyerCheckout(
      fixture.storefront,
      "merchant_plan22_demo",
      "storefront_cookie_store_sg",
      checkout.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: "shipping-operations-buyer-payment",
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
      },
    );
    if (
      !payment.ok ||
      payment.value.state !== "placed" ||
      payment.value.shipping === undefined ||
      payment.value.shipmentId === undefined
    )
      throw new Error("Shipping buyer payment failed");
    const shipmentId = payment.value.shipmentId;
    const ready = await readShippingOperations(
      fixture.client,
      "merchant_plan22_demo",
      shipmentId,
    );
    expect(ready).toMatchObject({
      ok: true,
      value: {
        state: "ready",
        shipmentId: `underclerk:merchant_plan22_demo:${shipmentId}`,
        nextAction: "quote_label_rate",
      },
    });

    const rate = await executeShippingOperation({
      client: fixture.client,
      merchantId: "merchant_plan22_demo",
      shipmentId,
      request: { action: "quote_label_rate" },
      idempotencyKey: "portal-shipping-rate",
      requestedAt: "2026-08-14T09:46:00.000Z",
    });
    if (!rate.ok || rate.value.state !== "rate_quoted")
      throw new Error("Shipping rate failed");
    expect(JSON.stringify(rate.value)).not.toContain(
      "providerAccountReference",
    );
    expect(JSON.stringify(rate.value)).not.toContain("rateReference");

    const label = await executeShippingOperation({
      client: fixture.client,
      merchantId: "merchant_plan22_demo",
      shipmentId,
      request: {
        action: "purchase_label",
        labelRateId: rate.value.labelRateId,
        shipmentRevision: rate.value.shipmentRevision,
      },
      idempotencyKey: "portal-shipping-label",
      requestedAt: "2026-08-14T09:47:00.000Z",
    });
    if (!label.ok || label.value.state !== "label_purchased")
      throw new Error("Shipping label failed");
    expect(label.value.nextAction).toBe("hand_to_carrier");

    await recordCarrierEvent(
      fixture,
      shipmentId,
      label.value.shipmentRevision,
      "in_transit",
      "2026-08-14T10:00:00.000Z",
      "Tokyo outward office",
    );
    await expect(
      readShippingOperations(
        fixture.client,
        "merchant_plan22_demo",
        shipmentId,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        state: "in_transit",
        nextAction: "await_delivery",
        latestEvent: { location: "Tokyo outward office" },
      },
    });
    const inTransit = await readShippingOperations(
      fixture.client,
      "merchant_plan22_demo",
      shipmentId,
    );
    if (!inTransit.ok) throw new Error("In-transit shipping view failed");
    await recordCarrierEvent(
      fixture,
      shipmentId,
      inTransit.value.shipmentRevision,
      "delivered",
      "2026-08-17T03:00:00.000Z",
      "Singapore",
    );
    await expect(
      readShippingOperations(
        fixture.client,
        "merchant_plan22_demo",
        shipmentId,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        state: "delivered",
        nextAction: "complete",
        latestEvent: { location: "Singapore" },
      },
    });
  } finally {
    await fixture.close();
  }
}, 60_000);

function isProductionMovement(movement: CommerceInventoryMovementV1): boolean {
  return (
    movement.change.kind === "decrease" &&
    movement.change.reason.kind === "production"
  );
}

type Fixture = Readonly<{
  underclerk: CommerceWorker;
  client: CommerceAdminClient;
  storefront: CommerceStorefrontClient;
  close: () => Promise<void>;
}>;

async function createFixture(): Promise<Fixture> {
  const commerceEngine = await startCommerceWorker({ now: SCENARIO_TIMESTAMP });
  return {
    underclerk: commerceEngine,
    client: new CommerceAdminClient({
      baseUrl: commerceEngine.baseUrl,
      serviceToken: commerceEngine.serviceToken,
      fetch: commerceEngine.fetch,
    }),
    storefront: new CommerceStorefrontClient({
      baseUrl: commerceEngine.baseUrl,
      fetch: commerceEngine.fetch,
    }),
    close: () => commerceEngine.dispose(),
  };
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
      schemaVersion: "underclerk.reconcile-buyer-payment.v1",
      idempotencyKey: command.idempotencyKey,
      checkoutRevision: command.checkoutRevision,
      quoteDigest: command.quoteDigest,
      confirmation: { kind: "provider_ui_completed" },
    },
  );
}

async function recordCarrierEvent(
  fixture: Fixture,
  shipmentId: string,
  shipmentRevision: number,
  state: "in_transit" | "delivered",
  occurredAt: string,
  location: string,
): Promise<void> {
  const snapshot = await fixture.client.readSnapshot("merchant_plan22_demo");
  if (!snapshot.ok) throw new Error("Shipping snapshot failed");
  const shipment = snapshot.value.resources.shipments.find(
    (candidate) => candidate.id === shipmentId,
  );
  const fulfillment =
    shipment === undefined
      ? undefined
      : snapshot.value.resources.fulfillments.find(
          (candidate) => candidate.id === shipment.fulfillmentId,
        );
  if (
    fulfillment?.kind !== "shipping" ||
    fulfillment.binding.kind !== "first_party_checkout"
  ) {
    throw new Error("Accepted shipping route failed");
  }
  const providerEventId = `carrier_${state}`;
  // The fixture Worker acts as the carrier and signs with its carrier key.
  const { signature } = await fixture.underclerk.fixture<{ signature: string }>(
    "merchant_plan22_demo",
    {
      kind: "sign_tracking_event",
      event: {
        routeBinding: fulfillment.binding.acceptedShippingQuote.routeBinding,
        serviceCode:
          fulfillment.binding.acceptedShippingQuote.carrierRate.service.code,
        shipmentId,
        state,
        providerEventId,
        occurredAt,
        location,
      },
    },
  );
  const result = await fixture.client.recordShippingTracking({
    merchantId: "merchant_plan22_demo",
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: providerEventId,
    shipmentId,
    shipmentRevision,
    event: { state, providerEventId, occurredAt, location, signature },
  });
  if (!result.ok || result.value.outcome === "rejected")
    throw new Error(`Carrier event ${state} failed`);
}

async function requireCafeAction(
  client: CommerceAdminClient,
  action: Parameters<typeof executeCafeOperation>[0]["action"],
  idempotencyKey: string,
) {
  const result = await executeCafeOperation({
    client,
    merchantId: "merchant_plan22_demo",
    action,
    idempotencyKey,
  });
  if (!result.ok)
    throw new Error(`Cafe action ${action} failed: ${result.error.code}`);
  return result;
}
