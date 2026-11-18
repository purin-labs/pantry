import {
  CommerceAdminClient,
  parseEntityPlaneObservation,
  type PrepareCommerceCatalogListingV1,
  type PublishCommerceCatalogListingV1,
  type CommerceDeliveryV1,
  type CommerceFetch,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceFulfillmentV1,
  type CommerceMerchantSnapshotV1,
} from "@seams/commerce-client";
import { commerceCommandInput } from "@seams/commerce-client";
import type { CheckoutProfile, FoodServicePreparation } from "@seams/contracts";
import { expect, it } from "vitest";

import { startCommerceWorker } from "./commerce-fixture-worker.ts";
import {
  normalizeCommerceEngineDelivery,
  publishCatalogListingThroughCommerce,
  resolveCommerceCancellationAuthority,
  createCommerceEd25519Verifier,
  type CommerceDeliveryVerifier,
} from "../src/commerce/provider.ts";

const NOW = "2026-08-09T09:00:00Z";

it("normalizes one verified Underclerk delivery onto the canonical resource spine", async () => {
  const result = await normalizeCommerceEngineDelivery({
    delivery: DELIVERY,
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(result).toMatchObject({
    ok: true,
    delivery: {
      schemaVersion: 1,
      providerDeliveryId: "delivery_1",
      observations: [
        {
          kind: "upsert",
          projection: {
            kind: "inventory_position",
            projection: {
              provenance: {
                source: "underclerk",
                resourceType: "inventory_position",
                resourceId: "underclerk:merchant_demo:position_1",
                revision: 3,
              },
              inventoryItemId: "underclerk:merchant_demo:inventory_1",
              locationId: "underclerk:merchant_demo:location_1",
              balance: {
                kind: "available_only",
                available: { amount: 8, scale: 0, unit: "each" },
              },
            },
          },
        },
      ],
    },
  });
});

it("routes entity-plane observations to typed admission without provider projection normalization", async () => {
  const result = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "entity_plane_delivery_1",
      merchantRevision: 3,
      observations: [
        parseEntityPlaneObservation({
          kind: "custom_entity_changed",
          observationId: "create_partner",
          entityRef: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          revision: 1,
          merchantRevision: 3,
        }),
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(result).toEqual({
    ok: true,
    kind: "entity_plane",
    admission: {
      deliveryId: "entity_plane_delivery_1",
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      merchantRevision: 3,
      observedAt: NOW,
      observations: [
        {
          kind: "custom_entity_changed",
          observationId: "create_partner",
          entityRef: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          revision: 1,
          merchantRevision: 3,
        },
      ],
    },
  });
});

it("preserves empty aggregate deliveries and rejects mixed-category deliveries", async () => {
  const empty = await normalizeCommerceEngineDelivery({
    delivery: { ...DELIVERY, observations: [] },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });
  expect(empty).toMatchObject({
    ok: true,
    kind: "aggregate",
    delivery: { observations: [] },
  });

  const mixed = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      observations: [
        DELIVERY.observations[0]!,
        parseEntityPlaneObservation({
          kind: "custom_entity_changed",
          observationId: "create_partner",
          entityRef: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          revision: 1,
          merchantRevision: 3,
        }),
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });
  expect(mixed).toEqual({
    ok: false,
    error: "underclerk_delivery_mixed_observation_categories",
  });
});

it("normalizes provider clock skew without producing an impossible observation order", async () => {
  const result = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      observedAt: "2026-08-09T08:59:00Z",
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(result).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            projection: {
              provenance: {
                occurredAt: NOW,
                observedAt: NOW,
              },
            },
          },
        },
      ],
    },
  });
});

it("rejects an unverified Underclerk delivery before canonical projection", async () => {
  expect(
    await normalizeCommerceEngineDelivery({
      delivery: DELIVERY,
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      integrationAccountId: "underclerk_merchant_demo",
      verifier: new RejectVerifier(),
    }),
  ).toEqual({ ok: false, error: "underclerk_delivery_signature_invalid" });
});

it("normalizes Underclerk order and operational resource states", async () => {
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "delivery_order_1",
      observations: [
        {
          kind: "commerce_order",
          resource: {
            id: "order_cafe_001",
            revision: 1,
            origin: {
              kind: "online",
              salesChannelId: "channel_online",
              storefrontId: "nuki-cafe.example",
              checkoutId: "checkout_cafe_001",
              configuration: {
                kind: "checkout_profile",
                checkoutProfile: {
                  checkoutProfileId: "checkout_profile_cafe",
                  revision: 2,
                },
              },
            },
            buyer: { kind: "identified", customerReference: "customer_hana" },
            lineItems: [
              {
                id: "line_cafe_001",
                source: {
                  kind: "catalog",
                  variantId: "variant_espresso",
                  variantRevision: 1,
                  merchantCode: "CAFE-ESPRESSO",
                  optionValues: [],
                  offerId: "offer_espresso",
                  offerRevision: 1,
                  consumptionPlanId: "plan_espresso",
                  consumptionPlanRevision: 1,
                  inventory: { kind: "untracked" },
                },
                sku: "CAFE-ESPRESSO",
                title: "Espresso",
                quantity: { amount: 2, scale: 0, unit: "each" },
                fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
                unitPrice: { amountMinor: 450, currency: "JPY" },
                tax: { amountMinor: 0, currency: "JPY" },
                discount: { amountMinor: 0, currency: "JPY" },
                lineTotal: { amountMinor: 900, currency: "JPY" },
              },
            ],
            totals: {
              subtotal: { amountMinor: 900, currency: "JPY" },
              discount: { amountMinor: 0, currency: "JPY" },
              tax: { amountMinor: 0, currency: "JPY" },
              duty: { amountMinor: 0, currency: "JPY" },
              shipping: { amountMinor: 0, currency: "JPY" },
              serviceFee: { amountMinor: 0, currency: "JPY" },
              tip: { amountMinor: 0, currency: "JPY" },
              rounding: { amountMinor: 0, currency: "JPY" },
              total: { amountMinor: 900, currency: "JPY" },
            },
            adjustments: [],
            lifecycle: { state: "confirmed", confirmedAt: NOW },
            occurredAt: NOW,
          },
        },
        {
          kind: "payment",
          resource: {
            id: "payment_cafe_001",
            revision: 1,
            orderId: "order_cafe_001",
            amount: { amountMinor: 900, currency: "JPY" },
            lifecycle: {
              state: "failed",
              failedAt: NOW,
              reason: "card_declined",
            },
            occurredAt: NOW,
          },
        },
        {
          kind: "fulfillment",
          resource: {
            id: "fulfillment_cafe_001",
            revision: 1,
            kind: "pickup",
            orderId: "order_cafe_001",
            lineItems: [{ lineItemId: "line_cafe_001", quantity: 2 }],
            locationId: "location_nuki_cafe",
            expectedBy: NOW,
            lifecycle: {
              state: "blocked",
              blockedAt: NOW,
              reason: "payment_failed",
            },
            occurredAt: NOW,
          },
        },
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });
  expect(normalized).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            kind: "commerce_order",
            projection: {
              provenance: {
                resourceId: "underclerk:merchant_demo:order_cafe_001",
              },
              origin: {
                kind: "online",
                checkoutId: "underclerk:merchant_demo:checkout_cafe_001",
                configuration: {
                  kind: "checkout_profile",
                  checkoutProfile: {
                    checkoutProfileId: "checkout_profile_cafe",
                    revision: 2,
                  },
                },
              },
            },
          },
        },
        {
          projection: {
            kind: "payment",
            projection: {
              orderId: "underclerk:merchant_demo:order_cafe_001",
              lifecycle: { state: "failed" },
            },
          },
        },
        {
          projection: {
            kind: "fulfillment",
            projection: {
              lifecycle: { state: "blocked" },
              locationId: "underclerk:merchant_demo:location_nuki_cafe",
            },
          },
        },
      ],
    },
  });
});

it("preserves the accepted first-party shipping quote while canonicalizing its identities", async () => {
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "delivery_shipping_fulfillment_1",
      observations: [
        { kind: "fulfillment", resource: createShippingFulfillment() },
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(normalized).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            kind: "fulfillment",
            projection: {
              kind: "shipping",
              binding: {
                kind: "first_party_checkout",
                protectedAddressReference:
                  "underclerk:merchant_demo:protected_address_sg_1",
                acceptedShippingQuote: {
                  shippingQuoteId: "underclerk:merchant_demo:shipping_quote_1",
                  routeBinding: {
                    routeId: "underclerk:merchant_demo:route_jp_sg_ems",
                    zoneId: "underclerk:merchant_demo:zone_singapore",
                  },
                  address: {
                    protectedAddressReference:
                      "underclerk:merchant_demo:protected_address_sg_1",
                  },
                  packagePlan: {
                    package: {
                      packageId: "underclerk:merchant_demo:package_1",
                      lineQuantities: [
                        {
                          checkoutLineId:
                            "underclerk:merchant_demo:checkout_line_1",
                        },
                      ],
                      customsLines: [
                        {
                          checkoutLineId:
                            "underclerk:merchant_demo:checkout_line_1",
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  });
});

it("canonicalizes food-service menu and preparation identities", async () => {
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "delivery_food_service_1",
      observations: [
        {
          kind: "commerce_order",
          resource: createFoodServiceOrder({
            kind: "immediate_recipe",
            recipeId: "recipe_oat_latte",
            recipeRevision: 7,
          }),
        },
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(normalized).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            kind: "commerce_order",
            projection: {
              lineItems: [
                {
                  source: {
                    kind: "food_service",
                    menuId: "underclerk:merchant_demo:menu_cafe",
                    menuRevision: 3,
                    menuEntryId:
                      "underclerk:merchant_demo:menu_entry_oat_latte",
                    menuEntryRevision: 4,
                    preparation: {
                      kind: "immediate_recipe",
                      recipeId: "underclerk:merchant_demo:recipe_oat_latte",
                      recipeRevision: 7,
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });
});

it("preserves stocked-inventory food-service preparation", async () => {
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "delivery_food_service_stocked_1",
      observations: [
        {
          kind: "commerce_order",
          resource: createFoodServiceOrder({ kind: "stocked_inventory" }),
        },
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(normalized).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            kind: "commerce_order",
            projection: {
              lineItems: [
                {
                  source: {
                    kind: "food_service",
                    menuId: "underclerk:merchant_demo:menu_cafe",
                    menuRevision: 3,
                    preparation: { kind: "stocked_inventory" },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });
});

it("canonicalizes production-batch inventory decrease reasons", async () => {
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: {
      ...DELIVERY,
      deliveryId: "delivery_production_decrease_1",
      observations: [
        {
          kind: "inventory_movement",
          resource: {
            id: "movement_production_input_1",
            inventoryItemId: "inventory_espresso",
            locationId: "location_cafe",
            change: {
              kind: "decrease",
              quantity: { amount: 18, scale: 0, unit: "gram" },
              reason: {
                kind: "production",
                productionBatchId: "batch_oat_latte_1",
                recipeRevision: 2,
              },
              lotAllocation: { kind: "not_tracked" },
            },
            occurredAt: NOW,
            idempotencyKey: "production:batch_oat_latte_1:input:1",
          },
        },
      ],
    },
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    integrationAccountId: "underclerk_merchant_demo",
    verifier: new ExactVerifier(),
  });

  expect(normalized).toMatchObject({
    ok: true,
    delivery: {
      observations: [
        {
          projection: {
            kind: "inventory_movement",
            projection: {
              provenance: {
                resourceId:
                  "underclerk:merchant_demo:movement_production_input_1",
              },
              change: {
                kind: "decrease",
                reason: {
                  kind: "production",
                  productionBatchId:
                    "underclerk:merchant_demo:batch_oat_latte_1",
                  recipeRevision: 2,
                },
              },
            },
          },
        },
      ],
    },
  });
});

it("resolves approval-required cancellation authority from exact provider resources", async () => {
  const result = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient(),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });

  expect(result).toEqual({
    ok: true,
    value: {
      kind: "underclerk_full_refund",
      merchantRevision: 7,
      paymentId: "payment_cancel_1",
      paymentRevision: 2,
      fulfillmentId: "fulfillment_cancel_1",
      fulfillmentRevision: 3,
      checkoutProfileId: "checkout_profile_cancel_1",
      checkoutProfileRevision: 5,
      refundPolicyId: "refund_policy_cancel",
      refundAmountMinor: 900,
      refundCurrency: "JPY",
      refundGovernance: "approval_required",
    },
  });
});

it("marks a cancellation automatically eligible only below the same-currency threshold", async () => {
  const eligible = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      profile: cancellationProfile({
        refundGovernance: {
          kind: "automatic_up_to",
          threshold: { amountMinor: 900, currency: "JPY" },
        },
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(eligible).toMatchObject({
    ok: true,
    value: { refundGovernance: "automatic_eligible" },
  });

  const exceeded = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      profile: cancellationProfile({
        refundGovernance: {
          kind: "automatic_up_to",
          threshold: { amountMinor: 899, currency: "JPY" },
        },
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(exceeded).toMatchObject({
    ok: true,
    value: { refundGovernance: "approval_required" },
  });

  const mismatchedCurrency = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      profile: cancellationProfile({
        currencyPolicy: { kind: "fixed", currency: "USD" },
        refundGovernance: {
          kind: "automatic_up_to",
          threshold: { amountMinor: 900, currency: "USD" },
        },
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(mismatchedCurrency).toMatchObject({
    ok: true,
    value: { refundGovernance: "approval_required" },
  });
});

it("resolves requested shipping cancellation for a food-service order line", async () => {
  const result = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      snapshot: cancellationSnapshot({
        order: cancellationOrderWithFoodServiceLine(),
        fulfillments: [CANCELLATION_SHIPPING_FULFILLMENT],
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });

  expect(result).toMatchObject({
    ok: true,
    value: {
      fulfillmentId: "fulfillment_cancel_shipping_1",
      refundAmountMinor: 900,
      refundCurrency: "JPY",
    },
  });
});

it("fails closed when cancellation totals do not reconcile", async () => {
  const result = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      snapshot: cancellationSnapshot({
        order: {
          ...CANCELLATION_ORDER,
          totals: {
            ...CANCELLATION_ORDER.totals,
            shipping: { amountMinor: 1, currency: "JPY" },
          },
        },
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });

  expect(result).toEqual({
    ok: false,
    error: {
      code: "underclerk_cancellation_authority_incomplete",
      field: "order.totals",
    },
  });
});

it("returns a typed unavailable result when Underclerk cannot be read", async () => {
  const result = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      snapshot: {
        ok: false,
        error: { kind: "http", status: 503, message: "Underclerk unavailable" },
      },
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "underclerk_unavailable",
      cause: { kind: "http", status: 503, message: "Underclerk unavailable" },
    },
  });
});

it("fails closed on ambiguous related resources", async () => {
  const duplicateOrder = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      snapshot: cancellationSnapshot({
        orders: [CANCELLATION_ORDER, CANCELLATION_ORDER],
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(duplicateOrder).toEqual({
    ok: false,
    error: {
      code: "underclerk_cancellation_authority_incomplete",
      field: "order",
    },
  });

  const duplicatePayment = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      snapshot: cancellationSnapshot({
        payments: [CANCELLATION_PAYMENT, CANCELLATION_PAYMENT],
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(duplicatePayment).toEqual({
    ok: false,
    error: {
      code: "underclerk_cancellation_authority_incomplete",
      field: "payment",
    },
  });
});

it("rejects invalid cancellation lifecycle, lines, money, and timestamps", async () => {
  const cases = [
    [
      "order.lifecycle",
      {
        order: {
          ...CANCELLATION_ORDER,
          lifecycle: { state: "confirmed", confirmedAt: NOW },
        },
      },
    ],
    [
      "order.lineItems",
      {
        order: cancellationOrderWithLine({
          source: { kind: "source_only", sourceItemReference: "legacy" },
        }),
      },
    ],
    [
      "order.totals",
      {
        order: {
          ...CANCELLATION_ORDER,
          totals: {
            ...CANCELLATION_ORDER.totals,
            total: { amountMinor: 0, currency: "JPY" },
          },
        },
      },
    ],
    [
      "payment.timestamp",
      {
        payment: {
          ...CANCELLATION_PAYMENT,
          lifecycle: { state: "captured", capturedAt: "2026-08-09T09:01:00Z" },
        },
      },
    ],
  ] as const;
  for (const [field, override] of cases) {
    const result = await resolveCommerceCancellationAuthority({
      client: createCancellationAuthorityClient({
        snapshot: cancellationSnapshot(override),
      }),
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      orderId: "order_cancel_1",
      orderRevision: 4,
      requestedAt: NOW,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "underclerk_cancellation_authority_incomplete", field },
    });
  }
});

it("rejects mismatched, draft, or future-published checkout profiles", async () => {
  const mismatched = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      profile: cancellationProfile({ checkoutProfileId: "other_profile" }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(mismatched).toEqual({
    ok: false,
    error: {
      code: "underclerk_cancellation_authority_incomplete",
      field: "checkoutProfile",
    },
  });

  const draft = await resolveCommerceCancellationAuthority({
    client: createCancellationAuthorityClient({
      profile: cancellationProfile({
        lifecycle: { state: "draft", createdAt: NOW, updatedAt: NOW },
      }),
    }),
    organisationId: "organisation_demo",
    merchantId: "merchant_demo",
    orderId: "order_cancel_1",
    orderRevision: 4,
    requestedAt: NOW,
  });
  expect(draft).toEqual({
    ok: false,
    error: {
      code: "underclerk_cancellation_authority_incomplete",
      field: "checkoutProfile",
    },
  });
});

type CancellationAuthoritySnapshotResult = Awaited<
  ReturnType<CommerceAdminClient["readSnapshot"]>
>;

type CancellationAuthorityClientOptions = Readonly<{
  snapshot?: CommerceMerchantSnapshotV1 | CancellationAuthoritySnapshotResult;
  profile?: CheckoutProfile;
  orders?: readonly CommerceOrderV1[];
  payments?: readonly CommercePaymentV1[];
  fulfillments?: readonly CommerceFulfillmentV1[];
}>;

function createCancellationAuthorityClient(
  options: CancellationAuthorityClientOptions = {},
): CommerceAdminClient {
  const snapshot =
    options.snapshot === undefined
      ? {
          ok: true as const,
          value: cancellationSnapshot({
            orders: options.orders,
            payments: options.payments,
            fulfillments: options.fulfillments,
          }),
        }
      : "ok" in options.snapshot
        ? options.snapshot
        : { ok: true as const, value: options.snapshot };
  const profile = options.profile ?? cancellationProfile();
  return createClient(async (input) => {
    const url = String(input);
    if (url.endsWith("/snapshot")) {
      return snapshot.ok
        ? jsonResponse(200, snapshot.value)
        : jsonResponse(503, { message: snapshot.error.message });
    }
    return jsonResponse(200, profile);
  });
}

function cancellationSnapshot(
  options: Readonly<{
    order?: CommerceOrderV1;
    orders?: readonly CommerceOrderV1[];
    payment?: CommercePaymentV1;
    payments?: readonly CommercePaymentV1[];
    fulfillments?: readonly CommerceFulfillmentV1[];
  }> = {},
): CommerceMerchantSnapshotV1 {
  return {
    schemaVersion: "underclerk.commerce-snapshot.v2",
    merchantId: "merchant_demo",
    merchantRevision: 7,
    deliverySigner: {
      keyId: "key_underclerk",
      algorithm: "ed25519",
      publicKeyB64: "public-key",
    },
    resources: {
      locations: [],
      salesChannels: [],
      products: [],
      variants: [],
      inventoryItems: [],
      offers: [],
      inventoryPositions: [],
      orders: options.orders ?? [options.order ?? CANCELLATION_ORDER],
      payments: options.payments ?? [options.payment ?? CANCELLATION_PAYMENT],
      fulfillments: options.fulfillments ?? [CANCELLATION_FULFILLMENT],
      shipments: [],
    },
  };
}

function cancellationProfile(
  options: Readonly<{
    checkoutProfileId?: string;
    merchantId?: string;
    revision?: number;
    lifecycle?: CheckoutProfile["lifecycle"];
    currencyPolicy?: CheckoutProfile["configuration"]["currencyPolicy"];
    refundGovernance?: CheckoutProfile["configuration"]["afterSalePolicy"]["refundGovernance"];
  }> = {},
): CheckoutProfile {
  return {
    checkoutProfileId: options.checkoutProfileId ?? "checkout_profile_cancel_1",
    merchantId: options.merchantId ?? "merchant_demo",
    revision: options.revision ?? 5,
    name: "Cancellation checkout",
    lifecycle: options.lifecycle ?? {
      state: "published",
      publishedAt: NOW,
      publishedBy: "merchant_owner",
    },
    configuration: {
      currencyPolicy: options.currencyPolicy ?? {
        kind: "fixed",
        currency: "JPY",
      },
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
        salesChannelId: "channel_online",
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
        cancellationPolicyId: "cancellation_policy_cancel",
        refundPolicyId: "refund_policy_cancel",
        refundGovernance: options.refundGovernance ?? {
          kind: "approval_required",
        },
      },
      presentationPolicy: {
        locale: "ja-JP",
        merchantDisplayName: "Cafe",
        termsPolicyId: "terms_policy_cafe",
        privacyPolicyId: "privacy_policy_cafe",
        supportContact: "support@example.com",
      },
    },
  };
}

function cancellationOrderWithLine(
  line: Readonly<Pick<CommerceOrderV1["lineItems"][number], "source">>,
): CommerceOrderV1 {
  const currentLine = CANCELLATION_ORDER.lineItems[0];
  if (currentLine === undefined)
    throw new Error("Missing cancellation fixture line");
  return { ...CANCELLATION_ORDER, lineItems: [{ ...currentLine, ...line }] };
}

function cancellationOrderWithFoodServiceLine(): CommerceOrderV1 {
  const foodServiceLine = createFoodServiceOrder({ kind: "stocked_inventory" })
    .lineItems[0];
  if (foodServiceLine === undefined)
    throw new Error("Missing food-service fixture line");
  return cancellationOrderWithLine({ source: foodServiceLine.source });
}

const CANCELLATION_ORDER: CommerceOrderV1 = {
  id: "order_cancel_1",
  revision: 4,
  origin: {
    kind: "online",
    salesChannelId: "channel_online",
    storefrontId: "storefront_cafe",
    checkoutId: "checkout_cancel_1",
    configuration: {
      kind: "checkout_profile",
      checkoutProfile: {
        checkoutProfileId: "checkout_profile_cancel_1",
        revision: 5,
      },
    },
  },
  buyer: { kind: "guest" },
  lineItems: [
    {
      id: "line_cancel_1",
      source: {
        kind: "catalog",
        variantId: "variant_cancel",
        variantRevision: 1,
        merchantCode: "CANCEL-1",
        optionValues: [],
        offerId: "offer_cancel",
        offerRevision: 1,
        consumptionPlanId: "plan_cancel",
        consumptionPlanRevision: 1,
        inventory: { kind: "untracked" },
      },
      sku: "CANCEL-1",
      title: "Cancel item",
      quantity: { amount: 2, scale: 0, unit: "each" },
      fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
      unitPrice: { amountMinor: 450, currency: "JPY" },
      tax: { amountMinor: 0, currency: "JPY" },
      discount: { amountMinor: 0, currency: "JPY" },
      lineTotal: { amountMinor: 900, currency: "JPY" },
    },
  ],
  totals: {
    subtotal: { amountMinor: 900, currency: "JPY" },
    discount: { amountMinor: 0, currency: "JPY" },
    tax: { amountMinor: 0, currency: "JPY" },
    duty: { amountMinor: 0, currency: "JPY" },
    shipping: { amountMinor: 0, currency: "JPY" },
    serviceFee: { amountMinor: 0, currency: "JPY" },
    tip: { amountMinor: 0, currency: "JPY" },
    rounding: { amountMinor: 0, currency: "JPY" },
    total: { amountMinor: 900, currency: "JPY" },
  },
  adjustments: [],
  lifecycle: { state: "fulfillment_pending", since: NOW },
  occurredAt: NOW,
};

const CANCELLATION_PAYMENT: CommercePaymentV1 = {
  id: "payment_cancel_1",
  revision: 2,
  orderId: "order_cancel_1",
  amount: { amountMinor: 900, currency: "JPY" },
  lifecycle: { state: "captured", capturedAt: NOW },
  occurredAt: NOW,
};

const CANCELLATION_FULFILLMENT: CommerceFulfillmentV1 = {
  id: "fulfillment_cancel_1",
  revision: 3,
  orderId: "order_cancel_1",
  kind: "pickup",
  lineItems: [{ lineItemId: "line_cancel_1", quantity: 2 }],
  locationId: "location_cafe",
  expectedBy: NOW,
  occurredAt: NOW,
  lifecycle: { state: "requested", requestedAt: NOW },
};

const CANCELLATION_SHIPPING_FULFILLMENT: CommerceFulfillmentV1 = {
  id: "fulfillment_cancel_shipping_1",
  revision: 3,
  orderId: "order_cancel_1",
  kind: "shipping",
  binding: { kind: "external", sourceReference: "shipping_route_cancel_1" },
  lineItems: [{ lineItemId: "line_cancel_1", quantity: 2 }],
  locationId: "location_cafe",
  expectedBy: NOW,
  occurredAt: NOW,
  lifecycle: { state: "requested", requestedAt: NOW },
};

it(
  "publishes through the authenticated Underclerk API and verifies its signed observation",
  runCommerceWalkingPath,
);

async function runCommerceWalkingPath(): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = new CommerceAdminClient({
      baseUrl: commerceEngine.baseUrl,
      serviceToken: commerceEngine.serviceToken,
      fetch: commerceEngine.fetch,
    });
    const provisioned = await client.provisionMerchant({
      schemaVersion: "underclerk.provision-merchant.v2",
      merchantId: "merchant_demo",
      externalReference: "organisation_demo",
      createdAt: NOW,
    });
    expect(provisioned.ok).toBe(true);
    const fixture = { client };
    const seeded = await client.prepareCatalogListing(
      commerceCommandInput(seedCommand()),
    );
    expect(seeded).toMatchObject({ ok: true, value: { outcome: "applied" } });

    const publication = await publishCatalogListingThroughCommerce({
      client: fixture.client,
      command: commerceCommandInput(PUBLISH_COMMAND),
    });
    expect(publication).toMatchObject({
      status: "applied",
      receipt: {
        commandKind: "publish_catalog_listing",
        resource: { kind: "offer", id: "offer_1", revision: 2 },
      },
    });
    if (publication.status !== "applied")
      throw new Error("Expected applied publication");

    const reader = await fixture.client.readFeedConsumer(
      "merchant_demo",
      "satyr",
    );
    if (!reader.ok) throw new Error("Expected Satyr's feed cursor");
    const page = await fixture.client.readEvents("merchant_demo", {
      after: reader.value.cursor,
    });
    if (!page.ok) throw new Error("Expected Underclerk events");
    const publishedEvent = page.value.events.find((event) =>
      isPublishedOfferDelivery(event.delivery),
    );
    if (publishedEvent === undefined)
      throw new Error("Expected published Offer delivery");
    const publishedDelivery = publishedEvent.delivery;
    const normalized = await normalizeCommerceEngineDelivery({
      delivery: publishedDelivery,
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      integrationAccountId: "integration_underclerk_demo",
      verifier: createCommerceEd25519Verifier({
        expectedKeyId: commerceEngine.signingKeyId,
        publicKey: new Uint8Array(
          Buffer.from(commerceEngine.publicKeyB64, "base64url"),
        ),
      }),
    });
    expect(normalized).toMatchObject({
      ok: true,
      delivery: {
        providerDeliveryId: publishedDelivery.deliveryId,
        observations: [
          {
            kind: "upsert",
            projection: {
              kind: "offer",
              projection: {
                lifecycle: { state: "listed" },
                provenance: {
                  source: "underclerk",
                  integrationAccountId: "integration_underclerk_demo",
                  revision: 2,
                },
              },
            },
          },
        ],
      },
    });
    const applied = await fixture.client.advanceFeedConsumer(
      "merchant_demo",
      "satyr",
      publishedEvent.cursor,
    );
    expect(applied).toMatchObject({
      ok: true,
      value: { cursor: publishedEvent.cursor },
    });
    expect(
      await publishCatalogListingThroughCommerce({
        client: fixture.client,
        command: commerceCommandInput(PUBLISH_COMMAND),
      }),
    ).toEqual({ status: "replayed", receipt: publication.receipt });
    const afterReplay = await fixture.client.readEvents("merchant_demo", {
      after: publishedEvent.cursor,
    });
    expect(afterReplay.ok).toBe(true);
    expect(
      afterReplay.ok &&
        afterReplay.value.events.some((event) =>
          isPublishedOfferDelivery(event.delivery),
        ),
    ).toBe(false);
  } finally {
    await commerceEngine.dispose();
  }
}

function createFoodServiceOrder(
  preparation: FoodServicePreparation,
): CommerceOrderV1 {
  return {
    id: "order_food_service_stocked_001",
    revision: 1,
    origin: {
      kind: "online",
      salesChannelId: "channel_online",
      storefrontId: "nuki-cafe.example",
      checkoutId: "checkout_food_service_stocked_001",
      configuration: {
        kind: "checkout_profile",
        checkoutProfile: {
          checkoutProfileId: "checkout_profile_cafe",
          revision: 2,
        },
      },
    },
    buyer: { kind: "guest" },
    lineItems: [
      {
        id: "line_food_service_stocked_001",
        source: {
          kind: "food_service",
          variantId: "variant_oat_latte",
          variantRevision: 2,
          merchantCode: "CAFE-OAT-LATTE",
          optionValues: [],
          menuId: "menu_cafe",
          menuRevision: 3,
          menuEntryId: "menu_entry_oat_latte",
          menuEntryRevision: 4,
          offerId: "offer_oat_latte",
          offerRevision: 5,
          consumptionPlanId: "plan_oat_latte",
          consumptionPlanRevision: 6,
          preparation,
          modifiers: [],
          inventory: { kind: "untracked" },
        },
        sku: "CAFE-OAT-LATTE",
        title: "Oat Latte",
        quantity: { amount: 1, scale: 0, unit: "each" },
        fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
        unitPrice: { amountMinor: 650, currency: "JPY" },
        tax: { amountMinor: 0, currency: "JPY" },
        discount: { amountMinor: 0, currency: "JPY" },
        lineTotal: { amountMinor: 650, currency: "JPY" },
      },
    ],
    totals: {
      subtotal: { amountMinor: 650, currency: "JPY" },
      discount: { amountMinor: 0, currency: "JPY" },
      tax: { amountMinor: 0, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      serviceFee: { amountMinor: 0, currency: "JPY" },
      tip: { amountMinor: 0, currency: "JPY" },
      rounding: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 650, currency: "JPY" },
    },
    adjustments: [],
    lifecycle: { state: "confirmed", confirmedAt: NOW },
    occurredAt: NOW,
  };
}

function isPublishedOfferDelivery(delivery: CommerceDeliveryV1): boolean {
  for (const observation of delivery.observations) {
    if (observation.kind === "offer" && observation.resource.revision === 2)
      return true;
  }
  return false;
}

function seedCommand(): PrepareCommerceCatalogListingV1 {
  return {
    schemaVersion: "underclerk.prepare-catalog-listing.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision: 0,
    idempotencyKey: "seed_underclerk_demo",
    requestedAt: NOW,
    salesChannel: {
      id: "channel_1",
      revision: 1,
      name: "Online Store",
      kind: "online",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
    },
    product: {
      id: "product_1",
      revision: 1,
      title: "House Coffee",
      description: "Freshly roasted house coffee.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: NOW,
    },
    variant: {
      id: "variant_1",
      revision: 1,
      productId: "product_1",
      sku: "COFFEE-1",
      title: "House Coffee 12 oz",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: NOW,
    },
    offer: {
      id: "offer_1",
      revision: 1,
      variantId: "variant_1",
      salesChannelId: "channel_1",
      price: { amountMinor: 1800, currency: "USD" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: NOW },
      occurredAt: NOW,
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_1",
      variantId: "variant_1",
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  };
}

class ExactVerifier implements CommerceDeliveryVerifier {
  async verify(input: Readonly<{ signature: string }>): Promise<boolean> {
    return Promise.resolve(input.signature === "delivery_signature");
  }
}

class RejectVerifier implements CommerceDeliveryVerifier {
  async verify(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const DELIVERY: CommerceDeliveryV1 = {
  schemaVersion: "underclerk.commerce-delivery.v1",
  deliveryId: "delivery_1",
  organisationId: "organisation_demo",
  merchantId: "merchant_demo",
  merchantRevision: 2,
  observedAt: NOW,
  observations: [
    {
      kind: "inventory_position",
      resource: {
        id: "position_1",
        revision: 3,
        inventoryItemId: "inventory_1",
        locationId: "location_1",
        balance: {
          kind: "available_only",
          available: { amount: 8, scale: 0, unit: "each" },
        },
        occurredAt: NOW,
      },
    },
  ],
  signer: {
    keyId: "underclerk_key_1",
    algorithm: "ed25519",
    signature: "delivery_signature",
  },
};

function createShippingFulfillment(): CommerceFulfillmentV1 {
  const digest = "ab".repeat(32);
  return {
    id: "fulfillment_shipping_1",
    revision: 1,
    kind: "shipping",
    binding: {
      kind: "first_party_checkout",
      protectedAddressReference: "protected_address_sg_1",
      acceptedShippingQuote: {
        shippingQuoteId: "shipping_quote_1",
        routeBinding: {
          kind: "japan_to_singapore",
          routeId: "route_jp_sg_ems",
          zoneId: "zone_singapore",
          carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
          serviceCodes: ["EMS"],
          dutyCapabilityId: "duty_singapore_test",
          incoterm: "ddp",
        },
        carrierRate: {
          providerAccountReference: "carrier_test",
          rateReference: "rate_1",
          service: { code: "EMS", name: "EMS" },
          shippingAmount: { amountMinor: 2_200, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "checkout_line_1",
              amount: { amountMinor: 2_200, currency: "JPY" },
            },
          ],
        },
        taxQuote: {
          providerAccountReference: "tax_test",
          registrationPolicyReference: "tax_registration_test",
          quoteReference: "tax_quote_1",
          taxAmount: { amountMinor: 522, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "checkout_line_1",
              amount: { amountMinor: 522, currency: "JPY" },
            },
          ],
        },
        dutyQuote: {
          providerAccountReference: "duty_test",
          quoteReference: "duty_quote_1",
          incoterm: "ddp",
          dutyAmount: { amountMinor: 180, currency: "JPY" },
          lineAllocations: [
            {
              checkoutLineId: "checkout_line_1",
              amount: { amountMinor: 180, currency: "JPY" },
            },
          ],
        },
        itemSubtotal: { amountMinor: 3_600, currency: "JPY" },
        total: { amountMinor: 6_502, currency: "JPY" },
        estimatedDelivery: { kind: "window", earliest: NOW, latest: NOW },
        address: {
          protectedAddressReference: "protected_address_sg_1",
          destinationCountry: "SG",
          addressValidationReference: "address_validation_1",
          addressDigest: digest,
        },
        packagePlan: {
          packagePlanDigest: digest,
          package: {
            packageId: "package_1",
            weight: { grams: 780 },
            dimensions: {
              lengthMillimeters: 240,
              widthMillimeters: 180,
              heightMillimeters: 90,
            },
            lineQuantities: [
              {
                checkoutLineId: "checkout_line_1",
                quantity: { amount: 1, scale: 0, unit: "each" },
              },
            ],
            customsLines: [
              {
                checkoutLineId: "checkout_line_1",
                description: "Six-cookie box",
                quantity: { amount: 1, scale: 0, unit: "each" },
                weight: { grams: 600 },
                declaredValue: { amountMinor: 3_600, currency: "JPY" },
                countryOfOrigin: "JP",
                hsCode: "190531",
              },
            ],
          },
        },
        inputDigest: digest,
        quotedAt: NOW,
        expiresAt: "2026-08-09T09:15:00Z",
      },
    },
    orderId: "order_shipping_1",
    lineItems: [{ lineItemId: "order_line_1", quantity: 1 }],
    locationId: "location_cafe",
    expectedBy: NOW,
    lifecycle: { state: "requested", requestedAt: NOW },
    occurredAt: NOW,
  };
}

const PUBLISH_COMMAND: PublishCommerceCatalogListingV1 = {
  schemaVersion: "underclerk.publish-catalog-listing.v1",
  merchantId: "merchant_demo",
  idempotencyKey: "publish_1",
  requestedAt: NOW,
  productId: "product_1",
  productRevision: 1,
  variantId: "variant_1",
  variantRevision: 1,
  offerId: "offer_1",
  offerRevision: 1,
  salesChannelId: "channel_1",
  salesChannelRevision: 1,
};

function createClient(fetcher: CommerceFetch): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: "https://underclerk.test",
    serviceToken: "underclerk_test_service_token",
    fetch: fetcher,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
