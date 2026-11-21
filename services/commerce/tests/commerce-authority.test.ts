import { createHash, randomUUID } from "node:crypto";
import { clientInput } from "./command-input.ts";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CreateCommerceBuyerPaymentSessionV1,
  type CreateCommerceBuyerShippingCheckoutV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerShippingCheckoutLineV1,
  type CommerceBuyerShippingAddressAcceptanceV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceClientResult,
  type CreateCommerceLocationV1,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type PrepareCommerceCatalogListingV1,
  type UpdateCommerceProductDescriptionV1,
  type PlaceCommerceChannelListingV1,
  type ConfigureCommerceShippingStorefrontV1,
  type PublishCommerceCatalogListingV1,
  type ReceiveCommerceInventoryV3,
  type CreatePreparationStationCommand,
  type CreateModifierGroupRevisionCommand,
  type CreateRecipeRevisionCommand,
  type ConfigureStockPolicyCommand,
  type PublishMenuCommand,
  parseFulfillment,
  parseOrder,
  parseSalesChannel,
  parseShipment,
  parseCreateBuyerShippingCheckoutCommand,
  commerceDeliverySignaturePayload,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { CommerceAuthority } from "../src/commerce-authority.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { DeterministicPaymentGateway } from "../src/payments/provider.ts";
import { rebuildPhase3Cafe } from "../scripts/rebuild-plan22-phase3-cafe.ts";
import { configurePhase4Shipping } from "../scripts/configure-plan22-phase4-shipping.ts";
import { configurePlan23FlavoredCatalog } from "../scripts/configure-plan23-flavored-catalog.ts";
import {
  createJapanExportShipping,
  createJapanShippingGateway,
} from "../src/plugins/japan-export/index.ts";
import { DeterministicJapanCheckoutChargeQuoteProvider } from "../src/plugins/japan-export/index.ts";
import { DeterministicJapanCarrierRateQuoteProvider } from "../src/plugins/japan-export/index.ts";
import {
  ReadyCheckoutProviderCapabilityHealthProvider,
  type CheckoutProviderCapabilityHealth,
  type CheckoutProviderCapabilityHealthProvider,
  type CheckoutProviderCapabilityHealthRequest,
  type ShippingQuoteLine as JapanShippingQuoteLine,
  type ShippingQuoteProviders,
  type ShippingQuoteRequest,
} from "../src/regional-shipping.ts";
import {
  type CheckoutChargeQuoteProvider,
  type DutyQuoteProviderRequest,
  type DutyQuoteProviderResult,
  type TaxQuoteProviderRequest,
  type TaxQuoteProviderResult,
} from "../src/checkout-charge-provider.ts";
import {
  type CarrierRateQuoteProvider,
  type CarrierRateQuoteProviderRequest,
  type CarrierRateQuoteProviderResult,
} from "../src/checkout-carrier-rate-provider.ts";
import {
  DurableCarrierRateQuoteProvider,
  DurableCheckoutChargeQuoteProvider,
} from "../src/checkout-charge-attempt.ts";
import { quoteShippingWithAttempt } from "../src/shipping-quote-attempt.ts";
import {
  createLocalShippingAddressValidationService,
  localAddressValidationProvider,
  ShippingAddressValidationService,
} from "../src/shipping-address-validation.ts";
import {
  writeFulfillment,
  writeOrder,
  writeSalesChannel,
  writeShipment,
} from "../src/commerce-persistence.ts";
import { assertNever } from "@purin-labs/std";

const JAPAN_EXPORT = createJapanExportShipping(
  "commerce-authority-carrier-signing-key",
);

function quoteJapanShippingWithProviders(
  request: ShippingQuoteRequest,
  providers: ShippingQuoteProviders,
) {
  return JAPAN_EXPORT.quote(request, providers);
}

function quoteJapanShipping(request: ShippingQuoteRequest) {
  return quoteJapanShippingWithProviders(request, {
    carrierRateQuoteProvider: JAPAN_EXPORT.carrierRates,
    chargeQuoteProvider: JAPAN_EXPORT.charges,
  });
}

const NOW = "2026-08-14T09:30:00.000Z";
const SERVICE_TOKEN = "commerce_test_service_token";
const TEST_CARRIER_SIGNING_KEY = "pantry-plan22-japan-post-ems-test-key";
const TEST_BUYER_CONTACT = {
  kind: "email",
  email: "buyer@example.test",
} as const;
const TEST_GUEST_BUYER = {
  kind: "guest",
  contact: TEST_BUYER_CONTACT,
} as const;
const TEST_SAVED_ADDRESS_REFERENCE = "saved_address_customer_ada_home";
const TEST_ADDRESS_ACCEPTANCE = {
  kind: "accepted_as_entered",
  addressValidationReference: "address_validation_fixture",
} as const;
let addressValidationTestTime = NOW;

type TestCapabilityHealthMode =
  | Readonly<{ state: "ready" }>
  | Readonly<{ state: "unavailable"; capabilityReference: string }>;

class TestCheckoutProviderCapabilityHealthProvider implements CheckoutProviderCapabilityHealthProvider {
  mode: TestCapabilityHealthMode = { state: "ready" };

  readHealth(
    request: CheckoutProviderCapabilityHealthRequest,
  ): CheckoutProviderCapabilityHealth {
    return this.mode.state === "unavailable" &&
      this.mode.capabilityReference === request.capabilityReference
      ? { state: "unavailable" }
      : { state: "ready" };
  }
}

class RecordingCheckoutChargeQuoteProvider implements CheckoutChargeQuoteProvider {
  readonly taxRequests: TaxQuoteProviderRequest[] = [];
  readonly dutyRequests: DutyQuoteProviderRequest[] = [];
  readonly delegate = new DeterministicJapanCheckoutChargeQuoteProvider();

  quoteTax(request: TaxQuoteProviderRequest): TaxQuoteProviderResult {
    this.taxRequests.push(request);
    return this.delegate.quoteTax(request);
  }

  quoteDuty(request: DutyQuoteProviderRequest): DutyQuoteProviderResult {
    this.dutyRequests.push(request);
    return this.delegate.quoteDuty(request);
  }
}

class RecordingCarrierRateQuoteProvider implements CarrierRateQuoteProvider {
  readonly requests: CarrierRateQuoteProviderRequest[] = [];
  readonly delegate = new DeterministicJapanCarrierRateQuoteProvider();

  quoteRate(
    request: CarrierRateQuoteProviderRequest,
  ): CarrierRateQuoteProviderResult {
    this.requests.push(request);
    return this.delegate.quoteRate(request);
  }
}

it("keeps address validation acceptance session-scoped and time-bounded", async () => {
  const fixture = createFixture();
  try {
    const service = new ShippingAddressValidationService({
      database: fixture.database,
      provider: localAddressValidationProvider,
      now: readAddressValidationTestTime,
      validitySeconds: 60,
    });
    const address = {
      countryCode: "SG" as const,
      recipientName: "Nuki Demo Buyer",
      addressLine1: "1 Raffles Quay",
      locality: "Singapore" as const,
      postalCode: "018956",
    };
    const input = {
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      storefrontId: "storefront_cookie_store_sg",
      buyerSessionDigest: "a".repeat(64),
      idempotencyKey: "address-validation-scope",
      address,
    };
    const validation = await service.validate(input);
    expect(validation).toMatchObject({
      kind: "resolved",
      value: { state: "accepted", expiresAt: "2026-08-14T09:31:00.000Z" },
    });
    if (
      validation.kind !== "resolved" ||
      validation.value.state !== "accepted"
    ) {
      throw new Error("Address validation was unavailable");
    }
    const acceptance = {
      kind: "accepted_as_entered" as const,
      addressValidationReference: validation.value.validationReference,
    };
    expect(
      await service.validate({
        ...input,
        address: { ...address, addressLine1: "2 Raffles Quay" },
      }),
    ).toEqual({ kind: "idempotency_conflict" });
    expect(service.accept({ ...input, acceptance })).toEqual({
      address,
      addressValidationReference: validation.value.validationReference,
    });
    expect(
      service.accept({
        ...input,
        buyerSessionDigest: "b".repeat(64),
        acceptance,
      }),
    ).toBeUndefined();

    addressValidationTestTime = "2026-08-14T09:30:30.000Z";
    expect(await service.validate(input)).toEqual(validation);
    addressValidationTestTime = "2026-08-14T09:31:00.000Z";
    expect(service.accept({ ...input, acceptance })).toBeUndefined();
  } finally {
    addressValidationTestTime = NOW;
    fixture.close();
  }
});

it("requires an exact Cart revision at the shipping checkout boundary", () => {
  const shippingAddress = {
    countryCode: "SG",
    recipientName: "Nuki Demo Buyer",
    addressLine1: "1 Raffles Quay",
    locality: "Singapore",
    postalCode: "018956",
  };
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "legacy_single_line",
      buyerContact: TEST_BUYER_CONTACT,
      line: { variantId: "variant_cookie_box_6", quantity: 1 },
      shippingAddress,
    }),
  ).toThrow();
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "retired_line_bearing_checkout",
      cartId: "cart_shipping",
      cartRevision: 1,
      buyer: TEST_GUEST_BUYER,
      lines: [],
      shippingDestination: {
        kind: "provided_address",
        address: shippingAddress,
        acceptance: TEST_ADDRESS_ACCEPTANCE,
      },
    }),
  ).toThrow();
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "invalid_cart_revision",
      cartId: "cart_shipping",
      cartRevision: 0,
      shippingServiceCode: "ems_test",
      buyer: TEST_GUEST_BUYER,
      shippingDestination: {
        kind: "provided_address",
        address: shippingAddress,
        acceptance: TEST_ADDRESS_ACCEPTANCE,
      },
    }),
  ).toThrow();

  expect(
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "japan_address",
      cartId: "cart_shipping",
      cartRevision: 1,
      shippingServiceCode: "takkyubin_test",
      buyer: TEST_GUEST_BUYER,
      shippingDestination: {
        kind: "provided_address",
        address: {
          countryCode: "JP",
          recipientName: "Pantry Buyer",
          addressLine1: "1-2-3 Marunouchi",
          locality: "Chiyoda-ku",
          administrativeArea: "Tokyo",
          postalCode: "1000005",
        },
        acceptance: TEST_ADDRESS_ACCEPTANCE,
      },
    }).shippingDestination,
  ).toEqual({
    kind: "provided_address",
    address: {
      countryCode: "JP",
      recipientName: "Pantry Buyer",
      addressLine1: "1-2-3 Marunouchi",
      locality: "Chiyoda-ku",
      administrativeArea: "Tokyo",
      postalCode: "100-0005",
    },
    acceptance: TEST_ADDRESS_ACCEPTANCE,
  });
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "retired_city_address",
      cartId: "cart_shipping",
      cartRevision: 1,
      shippingServiceCode: "ems_test",
      buyer: TEST_GUEST_BUYER,
      shippingDestination: {
        kind: "provided_address",
        address: {
          countryCode: "SG",
          recipientName: "Nuki Demo Buyer",
          addressLine1: "1 Raffles Quay",
          city: "Singapore",
          postalCode: "018956",
        },
        acceptance: TEST_ADDRESS_ACCEPTANCE,
      },
    }),
  ).toThrow();

  expect(
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "normalized_contact",
      cartId: "cart_shipping",
      cartRevision: 1,
      shippingServiceCode: "ems_test",
      buyer: {
        kind: "guest",
        contact: {
          kind: "email_and_phone",
          email: "Buyer@EXAMPLE.TEST",
          phone: "+819012345678",
        },
      },
      shippingDestination: {
        kind: "provided_address",
        address: shippingAddress,
        acceptance: TEST_ADDRESS_ACCEPTANCE,
      },
    }).buyer,
  ).toEqual({
    kind: "guest",
    contact: {
      kind: "email_and_phone",
      email: "Buyer@example.test",
      phone: "+819012345678",
    },
  });
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "invalid_contact_phone",
      cartId: "cart_shipping",
      cartRevision: 1,
      shippingServiceCode: "ems_test",
      buyer: {
        kind: "guest",
        contact: {
          kind: "email_and_phone",
          email: "buyer@example.test",
          phone: "090-1234-5678",
        },
      },
      shippingDestination: {
        kind: "provided_address",
        address: shippingAddress,
      },
    }),
  ).toThrow();
  expect(() =>
    parseCreateBuyerShippingCheckoutCommand({
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: "guest_saved_address",
      cartId: "cart_shipping",
      cartRevision: 1,
      shippingServiceCode: "ems_test",
      buyer: TEST_GUEST_BUYER,
      shippingDestination: {
        kind: "saved_address",
        savedAddressReference: TEST_SAVED_ADDRESS_REFERENCE,
      },
    }),
  ).toThrow();
});

it("attaches frozen tracking through the ordinary mutation, receipt, and delivery path", async () => {
  const fixture = createFixture();
  try {
    expect(
      fixture.authority.createLocation(
        createLocationCommand("tracking_attachment_location"),
      ),
    ).toMatchObject({ outcome: "applied", receipt: { merchantRevision: 1 } });
    writeSalesChannel(
      fixture.database,
      "merchant_demo",
      parseSalesChannel({
        id: "channel_tracking_attachment",
        revision: 1,
        name: "Tracking attachment channel",
        kind: "online",
        lifecycle: { state: "active", activeAt: NOW },
        occurredAt: NOW,
      }),
    );
    const zero = { amountMinor: 0, currency: "JPY" };
    writeOrder(
      fixture.database,
      "merchant_demo",
      parseOrder({
        id: "order_tracking_attachment",
        revision: 1,
        origin: {
          kind: "agent",
          salesChannelId: "channel_tracking_attachment",
          caseId: "case_tracking_attachment",
          externalReference: "tracking_attachment_fixture",
        },
        buyer: { kind: "guest" },
        lineItems: [],
        totals: {
          subtotal: zero,
          discount: zero,
          tax: zero,
          duty: zero,
          shipping: zero,
          serviceFee: zero,
          tip: zero,
          rounding: zero,
          total: zero,
        },
        adjustments: [],
        lifecycle: { state: "fulfillment_pending", since: NOW },
        occurredAt: NOW,
      }),
    );
    writeFulfillment(
      fixture.database,
      "merchant_demo",
      parseFulfillment({
        kind: "shipping",
        id: "fulfillment_tracking_attachment",
        revision: 1,
        orderId: "order_tracking_attachment",
        lineItems: [],
        locationId: "location_cafe",
        expectedBy: "2026-08-16T00:00:00.000Z",
        binding: {
          kind: "external",
          sourceReference: "tracking_attachment_fixture",
        },
        lifecycle: { state: "requested", requestedAt: NOW },
        occurredAt: NOW,
      }),
    );
    writeShipment(
      fixture.database,
      "merchant_demo",
      parseShipment({
        kind: "first_party",
        id: "shipment_tracking_attachment",
        revision: 1,
        orderId: "order_tracking_attachment",
        fulfillmentId: "fulfillment_tracking_attachment",
        package: {
          packageId: "package_tracking_attachment",
          weight: { grams: 100 },
          dimensions: {
            lengthMillimeters: 100,
            widthMillimeters: 100,
            heightMillimeters: 100,
          },
          lineQuantities: [],
          customsLines: [],
        },
        lifecycle: {
          state: "label_purchased",
          labelAttemptId: "label_attempt_tracking_attachment",
          trackingNumber: "JP123456789",
          purchasedAt: "2026-08-14T09:29:00.000Z",
        },
        events: [],
        occurredAt: "2026-08-14T09:29:00.000Z",
      }),
    );
    const client = createClient(fixture.authority);
    const command = {
      schemaVersion: "commerce.attach-fulfillment-tracking.v1" as const,
      merchantId: "merchant_demo",
      expectedMerchantRevision: 1,
      idempotencyKey: "attach_tracking_1",

      orderId: "order_tracking_attachment",
      fulfillmentId: "fulfillment_tracking_attachment",
      fulfillmentRevision: 1,
      shipmentId: "shipment_tracking_attachment",
      shipmentRevision: 1,
      trackingNumber: "JP123456789",
    };
    expect(
      await client.attachFulfillmentTracking({
        ...clientInput(command),
        idempotencyKey: "attach_tracking_wrong_number",
        trackingNumber: "WRONG",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "shipment.trackingAttachment",
        },
      },
    });

    const applied = await client.attachFulfillmentTracking(
      clientInput(command),
    );
    expect(applied).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "attach_fulfillment_tracking",
          previousMerchantRevision: 1,
          merchantRevision: 2,
          resource: {
            kind: "fulfillment",
            id: "fulfillment_tracking_attachment",
            revision: 2,
          },
          signer: { keyId: "key_commerce_test", algorithm: "ed25519" },
        },
      },
    });
    expect(
      await client.attachFulfillmentTracking(clientInput(command)),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "replayed",
        receipt: { commandKind: "attach_fulfillment_tracking" },
      },
    });
    expect(
      fixture.authority.readSnapshot("merchant_demo")?.resources,
    ).toMatchObject({
      fulfillments: [
        {
          id: "fulfillment_tracking_attachment",
          revision: 2,
          lifecycle: {
            state: "handed_to_carrier",
            shipmentId: "shipment_tracking_attachment",
            handedOverAt: NOW,
          },
        },
      ],
      shipments: [
        {
          id: "shipment_tracking_attachment",
          revision: 2,
          lifecycle: {
            state: "in_transit",
            trackingNumber: "JP123456789",
            handedOverAt: NOW,
          },
          events: [{ kind: { kind: "in_transit" }, occurredAt: NOW }],
        },
      ],
    });
    expect(
      fixture.authority.pendingDeliveries("merchant_demo").at(-1),
    ).toMatchObject({
      merchantRevision: 2,
      observations: [
        {
          kind: "shipment",
          resource: { revision: 2, lifecycle: { state: "in_transit" } },
        },
        {
          kind: "fulfillment",
          resource: { revision: 2, lifecycle: { state: "handed_to_carrier" } },
        },
      ],
      signer: { keyId: "key_commerce_test", algorithm: "ed25519" },
    });
    expect(
      fixture.database
        .prepare(
          `SELECT entity_type AS entityType, attribute_id AS attributeId,
              value_kind AS valueKind, comparable_text AS comparableText
         FROM commerce_entity_attribute_relation
        WHERE merchant_id = ? AND entity_id IN (?, ?)
        ORDER BY entity_type, attribute_id`,
        )
        .all<
          Readonly<{
            entityType: string;
            attributeId: string;
            valueKind: string;
            comparableText: string | null;
          }>
        >(
          "merchant_demo",
          "fulfillment_tracking_attachment",
          "shipment_tracking_attachment",
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "fulfillment",
          attributeId: "order_id",
          valueKind: "short_text",
          comparableText: "order_tracking_attachment",
        }),
        expect.objectContaining({
          entityType: "fulfillment",
          attributeId: "expected_by",
          valueKind: "timestamp",
          comparableText: "2026-08-16T00:00:00.000Z",
        }),
        expect.objectContaining({
          entityType: "shipment",
          attributeId: "tracking_number",
          valueKind: "short_text",
          comparableText: "JP123456789",
        }),
      ]),
    );
  } finally {
    fixture.close();
  }
});

class DigestSigner implements CommerceSigner {
  readonly keyId = "key_commerce_test";
  readonly publicKeyB64 = Buffer.alloc(32, 7).toString("base64url");

  sign(payload: Uint8Array): string {
    return `test_${createHash("sha256").update(payload).digest("hex")}`;
  }
}

it("prepares a catalog listing and publishes it exactly once", () => {
  const fixture = createFixture();
  try {
    const locationCommand = createLocationCommand("catalog_seed_location");
    const location = fixture.authority.createLocation(locationCommand);
    expect(location).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "create_location", merchantRevision: 1 },
    });
    expect(fixture.authority.createLocation(locationCommand)).toEqual(
      location.outcome === "applied"
        ? { outcome: "replayed", receipt: location.receipt }
        : location,
    );
    const catalogCommand = prepareCatalogCommand("catalog_seed_catalog", 1);
    const catalog = fixture.authority.prepareCatalogListing(catalogCommand);
    expect(catalog).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "prepare_catalog_listing", merchantRevision: 2 },
    });
    expect(fixture.authority.prepareCatalogListing(catalogCommand)).toEqual(
      catalog.outcome === "applied"
        ? { outcome: "replayed", receipt: catalog.receipt }
        : catalog,
    );
    const published = fixture.authority.publishCatalogListing(publishCommand());
    const replayed = fixture.authority.publishCatalogListing(publishCommand());
    expect(published).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "publish_catalog_listing",
        previousMerchantRevision: 2,
        merchantRevision: 3,
        resource: { kind: "offer", id: "offer_cookie_box", revision: 2 },
      },
    });
    expect(replayed).toEqual(
      published.outcome === "applied"
        ? { outcome: "replayed", receipt: published.receipt }
        : published,
    );
    expect(fixture.authority.readSnapshot("merchant_demo")).toMatchObject({
      merchantRevision: 3,
      resources: {
        offers: [{ id: "offer_cookie_box", lifecycle: { state: "listed" } }],
        inventoryItems: [],
        inventoryPositions: [],
      },
    });
  } finally {
    fixture.close();
  }
});

it("updates a product description through the signed mutation boundary", async () => {
  const fixture = createFixture();
  try {
    seedCatalog(fixture.authority, "description_update");
    const initialProducts = fixture.authority.readSnapshot("merchant_demo")?.resources.products ?? [];
    const initialProduct = initialProducts[0];
    if (initialProduct === undefined || initialProduct.id !== "product_cookie_box") {
      throw new Error("Description update fixture product is missing");
    }
    const command: UpdateCommerceProductDescriptionV1 = {
      schemaVersion: "commerce.update-product-description.v1",
      merchantId: "merchant_demo",
      expectedMerchantRevision: 2,
      productId: "product_cookie_box",
      expectedProductRevision: 1,
      description: "Six assorted cookies, freshly baked for browser acceptance.",
      idempotencyKey: "description_update_product",
      requestedAt: NOW,
    };
    const client = createClient(fixture.authority);
    const applied = await client.updateProductDescription(clientInput(command));
    expect(applied).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "update_product_description",
          previousMerchantRevision: 2,
          merchantRevision: 3,
          resource: { kind: "product", id: "product_cookie_box", revision: 2 },
        },
      },
    });
    expect(
      await client.updateProductDescription(clientInput(command)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "replayed" },
    });
    const afterApply = fixture.authority.readSnapshot("merchant_demo");
    if (afterApply === undefined) throw new Error("Description update snapshot is missing");
    const updatedProduct = afterApply.resources.products[0];
    expect(updatedProduct).toEqual({
      ...initialProduct,
      revision: initialProduct.revision + 1,
      description: command.description,
    });
    const deliveriesAfterApply = fixture.authority.pendingDeliveries("merchant_demo");
    const conflict = await client.updateProductDescription({
      ...clientInput(command),
      description: "A conflicting description must not replay.",
    });
    expect(conflict).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: { code: "idempotency_conflict", idempotencyKey: command.idempotencyKey },
      },
    });
    const stale = await client.updateProductDescription({
      ...clientInput(command),
      expectedMerchantRevision: 3,
      idempotencyKey: "description_update_stale_product",
    });
    expect(stale).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "stale_resource_revision",
          kind: "product",
          id: command.productId,
          expected: command.expectedProductRevision,
          actual: initialProduct.revision + 1,
        },
      },
    });
    expect(fixture.authority.readSnapshot("merchant_demo")).toEqual(afterApply);
    expect(fixture.authority.pendingDeliveries("merchant_demo")).toEqual(deliveriesAfterApply);
    expect(fixture.authority.readSnapshot("merchant_demo")).toMatchObject({
      merchantRevision: 3,
      resources: {
        products: [{ id: "product_cookie_box", revision: 2, description: command.description }],
      },
    });
    expect(fixture.authority.pendingDeliveries("merchant_demo")).toContainEqual(
      expect.objectContaining({
        merchantRevision: 3,
        observations: [{
          kind: "product",
          resource: expect.objectContaining({
            id: "product_cookie_box",
            revision: 2,
            description: command.description,
          }),
        }],
      }),
    );
  } finally {
    fixture.close();
  }
});

it("creates a preparation station in the canonical resource table and main delivery", () => {
  const fixture = createFixture();
  try {
    expect(
      fixture.authority.createLocation(
        createLocationCommand("station_location"),
      ),
    ).toMatchObject({
      outcome: "applied",
      receipt: { merchantRevision: 1 },
    });
    const command: CreatePreparationStationCommand = {
      schemaVersion: "commerce.create-preparation-station.v1",
      merchantId: "merchant_demo",
      expectedMerchantRevision: 1,
      idempotencyKey: "station_create",
      requestedAt: NOW,
      station: {
        stationId: "station_bar",
        locationId: "location_cafe",
        name: "Cafe Bar",
      },
    };
    const result = fixture.authority.createPreparationStation(command);
    expect(result).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "create_preparation_station",
        merchantRevision: 2,
        resource: {
          kind: "preparation_station",
          id: "station_bar",
          revision: 1,
        },
      },
    });
    expect(
      fixture.authority.readFoodServiceSnapshot("merchant_demo"),
    ).toMatchObject({
      resources: {
        preparationStations: [
          {
            stationId: "station_bar",
            locationId: "location_cafe",
            lifecycle: "active",
          },
        ],
      },
    });
    expect(fixture.authority.pendingDeliveries("merchant_demo")).toHaveLength(
      2,
    );
  } finally {
    fixture.close();
  }
});

it("retires a rejected delivery and replays its settlement on later acknowledgements", () => {
  const fixture = createFixture();
  try {
    expect(
      fixture.authority.createLocation(
        createLocationCommand("reject_seed_location"),
      ),
    ).toMatchObject({ outcome: "applied" });
    const before = fixture.authority.pendingDeliveries("merchant_demo");
    expect(before.length).toBeGreaterThan(0);
    const deliveryId = before.at(-1)!.deliveryId;
    const rejectCommand = {
      schemaVersion: "commerce.acknowledge-commerce-delivery.v2",
      organisationId: "organisation_demo",
      merchantId: "merchant_demo",
      deliveryId,
      acknowledgedAt: NOW,
      rejection: { reason: "commerce_revision_conflict" },
    };

    expect(fixture.authority.acknowledgeDelivery(rejectCommand)).toMatchObject({
      outcome: "rejected",
      deliveryId,
      acknowledgedAt: NOW,
    });
    // Retired: the delivery never resurfaces as pending.
    const after = fixture.authority.pendingDeliveries("merchant_demo");
    expect(after).toHaveLength(before.length - 1);
    expect(after.some((delivery) => delivery.deliveryId === deliveryId)).toBe(
      false,
    );
    // Replays settle to the recorded outcome, however the retry is phrased.
    expect(fixture.authority.acknowledgeDelivery(rejectCommand)).toMatchObject({
      outcome: "already_rejected",
      deliveryId,
    });
    expect(
      fixture.authority.acknowledgeDelivery({
        schemaVersion: "commerce.acknowledge-commerce-delivery.v2",
        organisationId: "organisation_demo",
        merchantId: "merchant_demo",
        deliveryId,
        acknowledgedAt: NOW,
      }),
    ).toMatchObject({ outcome: "already_rejected", deliveryId });
  } finally {
    fixture.close();
  }
});

it("routes the typed cafe resource slice through HTTP with authoritative relationships", async () => {
  const fixture = createFixture(false);
  try {
    const client = createClient(fixture.authority);
    expect(
      await client.provisionMerchant({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: "organisation_demo",
        merchantId: "merchant_demo",
        createdAt: NOW,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "provisioned" } });
    expect(
      await client.createInventoryItem(
        clientInput(cafeInventoryItemCommand(0)),
      ),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 1 } },
    });
    expect(
      await client.configurePickupStorefront(
        clientInput(cafeStorefrontCommand(1)),
      ),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 2 } },
    });
    expect(
      fixture.authority.readActiveCheckoutProfile(
        "merchant_demo",
        "storefront_cafe",
      ),
    ).toMatchObject({
      activation: {
        checkoutProfileId: "checkout_profile_storefront_cafe_default",
        checkoutProfileRevision: 1,
      },
      profile: {
        lifecycle: { state: "published" },
        configuration: {
          fulfillmentPolicy: { kind: "pickup_only" },
          taxPolicy: { kind: "merchant_inclusive" },
        },
      },
    });
    expect(
      await client.openInventoryPosition(
        clientInput(cafeInventoryPositionCommand(2)),
      ),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 3 } },
    });
    const station = cafePreparationStationCommand(3);
    expect(
      await client.createPreparationStation(clientInput(station)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 4 } },
    });
    const modifier = cafeModifierGroupCommand(4);
    expect(
      await client.createModifierGroupRevision(clientInput(modifier)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 5 } },
    });
    const recipe = cafeRecipeCommand(5);
    expect(
      await client.createRecipeRevision(clientInput(recipe)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 6 } },
    });
    const policy = cafeStockPolicyCommand(6);
    expect(
      await client.configureStockPolicy(clientInput(policy)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 7 } },
    });
    const menu = cafeMenuCommand(7);
    const applied = await client.publishMenu(clientInput(menu));
    expect(applied).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "publish_menu",
          merchantRevision: 8,
          resource: { kind: "menu", id: "menu_cafe_main" },
        },
      },
    });
    expect(await client.publishMenu(clientInput(menu))).toEqual({
      ok: true,
      value:
        applied.ok && applied.value.outcome === "applied"
          ? { outcome: "replayed", receipt: applied.value.receipt }
          : applied.ok
            ? applied.value
            : undefined,
    });
    expect(
      await client.publishMenu({
        ...clientInput(menu),
        expectedMerchantRevision: 8,
        idempotencyKey: "menu_invalid_offer_revision",
        menu: {
          ...menu.menu,
          menuId: "menu_invalid",
          entries: [{ ...menu.menu.entries[0]!, offerRevision: 99 }],
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "menu.entries.offer",
        },
      },
    });
    const snapshot = await client.readFoodServiceSnapshot("merchant_demo");
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        resources: {
          menus: [
            { menuId: "menu_cafe_main", lifecycle: { state: "published" } },
          ],
          modifierGroupRevisions: [{ modifierGroupId: "modifier_group_milk" }],
          recipeRevisions: [{ recipeId: "recipe_latte_large" }],
          preparationStations: [{ stationId: "station_bar" }],
          stockPolicies: [{ stockPolicyId: "stock_policy_oat_milk_cafe" }],
        },
      },
    });
    const deliveries = fixture.authority.pendingDeliveries("merchant_demo");
    expect(deliveries).toHaveLength(8);
    const menuDelivery = deliveries.find((delivery) =>
      delivery.observations.some((observation) => observation.kind === "menu"),
    );
    expect(menuDelivery).toBeDefined();
    expect(menuDelivery?.signer.signature).toBe(
      new DigestSigner().sign(
        commerceDeliverySignaturePayload(menuDelivery!),
      ),
    );
  } finally {
    fixture.close();
  }
});

it("quotes the same multi-line package for domestic Japan and Singapore routes", () => {
  const lines = japanShippingQuoteLines();
  const chargeQuoteProvider = new RecordingCheckoutChargeQuoteProvider();
  const carrierRateQuoteProvider = new RecordingCarrierRateQuoteProvider();
  const domestic = quoteJapanShipping({
    routeBinding: {
      kind: "domestic_japan",
      routeId: "route_jp_domestic_yamato",
      zoneId: "zone_domestic_japan",
      carrierRateCapabilityId: "carrier_rate_yamato_test",
      serviceCodes: ["takkyubin_test", "takkyubin_priority_test"],
    },
    serviceCode: "takkyubin_test",
    shippingQuoteId: "shipping_quote_domestic_fixture",
    packageId: "package_domestic_fixture",
    taxCalculation: {
      kind: "provider_quoted",
      providerAccountReference: "tax_account_jp_test",
      registrationPolicyReference: "tax_registration_domestic_fixture",
    },
    lines,
    addressAuthority: {
      kind: "provided_address",
      address: {
        countryCode: "JP",
        recipientName: "国内購入者",
        addressLine1: "丸の内1-1-1",
        locality: "千代田区",
        administrativeArea: "東京都",
        postalCode: "100-0005",
      },
      addressValidationReference: "address_validation_jp_fixture",
    },
    quotedAt: NOW,
    quoteTtlSeconds: 900,
  });
  const singapore = quoteJapanShippingWithProviders(
    {
      routeBinding: {
        kind: "japan_to_singapore",
        routeId: "route_jp_sg_ems",
        zoneId: "zone_singapore",
        carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
        serviceCodes: ["ems_test", "international_parcel_air_test"],
        dutyCapabilityId: "duty_singapore_test",
        incoterm: "ddp",
      },
      serviceCode: "ems_test",
      shippingQuoteId: "shipping_quote_sg_fixture",
      packageId: "package_sg_fixture",
      taxCalculation: {
        kind: "provider_quoted",
        providerAccountReference: "tax_account_sg_test",
        registrationPolicyReference: "tax_registration_singapore_fixture",
      },
      lines,
      addressAuthority: {
        kind: "provided_address",
        address: {
          countryCode: "SG",
          recipientName: "Singapore Buyer",
          addressLine1: "1 Raffles Quay",
          locality: "Singapore",
          postalCode: "018956",
        },
        addressValidationReference: "address_validation_sg_fixture",
      },
      quotedAt: NOW,
      quoteTtlSeconds: 900,
    },
    { carrierRateQuoteProvider, chargeQuoteProvider },
  );
  const unavailableDomestic = quoteJapanShipping({
    routeBinding: {
      kind: "domestic_japan",
      routeId: "route_jp_domestic_unavailable",
      zoneId: "zone_domestic_japan",
      carrierRateCapabilityId: "carrier_rate_unpublished",
      serviceCodes: ["takkyubin_test"],
    },
    serviceCode: "takkyubin_test",
    shippingQuoteId: "shipping_quote_domestic_unavailable",
    packageId: "package_domestic_unavailable",
    taxCalculation: {
      kind: "provider_quoted",
      providerAccountReference: "tax_account_jp_test",
      registrationPolicyReference: "tax_registration_domestic_fixture",
    },
    lines,
    addressAuthority: {
      kind: "provided_address",
      address: {
        countryCode: "JP",
        recipientName: "国内購入者",
        addressLine1: "丸の内1-1-1",
        locality: "千代田区",
        administrativeArea: "東京都",
        postalCode: "100-0005",
      },
      addressValidationReference: "address_validation_jp_unavailable",
    },
    quotedAt: NOW,
    quoteTtlSeconds: 900,
  });
  const singaporeDap = quoteJapanShipping({
    routeBinding: {
      kind: "japan_to_singapore",
      routeId: "route_jp_sg_dap",
      zoneId: "zone_singapore",
      carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
      serviceCodes: ["ems_test"],
      dutyCapabilityId: "duty_singapore_test",
      incoterm: "dap",
    },
    serviceCode: "ems_test",
    shippingQuoteId: "shipping_quote_sg_dap_fixture",
    packageId: "package_sg_dap_fixture",
    taxCalculation: {
      kind: "provider_quoted",
      providerAccountReference: "tax_account_sg_test",
      registrationPolicyReference: "tax_registration_singapore_fixture",
    },
    lines,
    addressAuthority: {
      kind: "provided_address",
      address: {
        countryCode: "SG",
        recipientName: "Singapore DAP Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
      addressValidationReference: "address_validation_sg_dap_fixture",
    },
    quotedAt: NOW,
    quoteTtlSeconds: 900,
  });

  expect(unavailableDomestic).toEqual({
    kind: "unavailable_route",
    field: "shippingRoute.carrierRateBinding",
  });
  expect(domestic).toMatchObject({
    kind: "quoted",
    quote: {
      carrierRate: {
        providerAccountReference: "yamato_transport_test",
        service: { code: "takkyubin_test", name: "Yamato Takkyubin Test" },
        shippingAmount: { amountMinor: 900, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 472, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 428, currency: "JPY" },
          },
        ],
      },
      taxQuote: {
        registrationPolicyReference: "tax_registration_domestic_fixture",
        taxAmount: { amountMinor: 890, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 467, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 423, currency: "JPY" },
          },
        ],
      },
      dutyQuote: {
        incoterm: "not_applicable",
        dutyAmount: { amountMinor: 0, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 0, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 0, currency: "JPY" },
          },
        ],
      },
      total: { amountMinor: 9_790, currency: "JPY" },
      address: { destinationCountry: "JP" },
      packagePlan: {
        package: {
          weight: { grams: 2_450 },
          lineQuantities: [
            { checkoutLineId: "line_matcha" },
            { checkoutLineId: "line_taro" },
          ],
          customsLines: [],
        },
      },
    },
  });
  expect(singapore).toMatchObject({
    kind: "quoted",
    quote: {
      carrierRate: {
        providerAccountReference: "japan_post_ems_test",
        service: { code: "ems_test", name: "Japan Post EMS Test" },
        shippingAmount: { amountMinor: 2_200, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 1_155, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 1_045, currency: "JPY" },
          },
        ],
      },
      taxQuote: {
        registrationPolicyReference: "tax_registration_singapore_fixture",
        taxAmount: { amountMinor: 918, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 481, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 437, currency: "JPY" },
          },
        ],
      },
      dutyQuote: {
        incoterm: "ddp",
        dutyAmount: { amountMinor: 400, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 210, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 190, currency: "JPY" },
          },
        ],
      },
      total: { amountMinor: 11_518, currency: "JPY" },
      address: { destinationCountry: "SG" },
      packagePlan: {
        package: {
          weight: { grams: 2_450 },
          lineQuantities: [
            { checkoutLineId: "line_matcha" },
            { checkoutLineId: "line_taro" },
          ],
          customsLines: [
            { checkoutLineId: "line_matcha" },
            { checkoutLineId: "line_taro" },
          ],
        },
      },
    },
  });
  expect(singaporeDap).toMatchObject({
    kind: "quoted",
    quote: {
      dutyQuote: {
        incoterm: "dap",
        dutyAmount: { amountMinor: 0, currency: "JPY" },
        lineAllocations: [
          {
            checkoutLineId: "line_matcha",
            amount: { amountMinor: 0, currency: "JPY" },
          },
          {
            checkoutLineId: "line_taro",
            amount: { amountMinor: 0, currency: "JPY" },
          },
        ],
      },
      total: { amountMinor: 11_118, currency: "JPY" },
    },
  });
  expect(chargeQuoteProvider.taxRequests).toEqual([
    {
      kind: "provider_quoted",
      providerAccountReference: "tax_account_sg_test",
      registrationPolicyReference: "tax_registration_singapore_fixture",
      destinationCountry: "SG",
      lines: [
        {
          checkoutLineId: "line_matcha",
          amount: { amountMinor: 4_200, currency: "JPY" },
        },
        {
          checkoutLineId: "line_taro",
          amount: { amountMinor: 3_800, currency: "JPY" },
        },
      ],
      shippingAmount: { amountMinor: 2_200, currency: "JPY" },
      addressDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      quotedAt: NOW,
      expiresAt: "2026-08-14T09:45:00.000Z",
    },
  ]);
  expect(carrierRateQuoteProvider.requests).toEqual([
    {
      providerAccountReference: "japan_post_ems_test",
      originCountry: "JP",
      destinationCountry: "SG",
      selectedServiceCode: "ems_test",
      packagePlanDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      package: {
        weight: { grams: 2_450 },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 200,
        },
      },
      lines: [
        {
          checkoutLineId: "line_matcha",
          amount: { amountMinor: 4_200, currency: "JPY" },
        },
        {
          checkoutLineId: "line_taro",
          amount: { amountMinor: 3_800, currency: "JPY" },
        },
      ],
      addressDigest: chargeQuoteProvider.taxRequests[0]?.addressDigest,
      quotedAt: NOW,
      expiresAt: "2026-08-14T09:45:00.000Z",
    },
  ]);
  expect(chargeQuoteProvider.dutyRequests).toEqual([
    {
      providerAccountReference: "singapore_duty_test",
      destinationCountry: "SG",
      incoterm: "ddp",
      customsLines: [
        {
          checkoutLineId: "line_matcha",
          declaredValue: { amountMinor: 4_200, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
        {
          checkoutLineId: "line_taro",
          declaredValue: { amountMinor: 3_800, currency: "JPY" },
          countryOfOrigin: "JP",
          hsCode: "190531",
        },
      ],
      addressDigest: chargeQuoteProvider.taxRequests[0]?.addressDigest,
      quotedAt: NOW,
      expiresAt: "2026-08-14T09:45:00.000Z",
    },
  ]);
  expect(JSON.stringify(chargeQuoteProvider.taxRequests)).not.toContain(
    "Raffles Quay",
  );
  expect(JSON.stringify(chargeQuoteProvider.dutyRequests)).not.toContain(
    "Singapore Buyer",
  );
  expect(JSON.stringify(carrierRateQuoteProvider.requests)).not.toContain(
    "Raffles Quay",
  );
});

it("replays one exact durable shipping quote attempt without retaining its raw address", () => {
  const database = new NodeCommerceDatabase(":memory:");
  try {
    initializeCommerceSchema(database, NOW);
    database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
      )
      .run("merchant_quote_attempt", "organisation_quote_attempt", NOW, NOW);
    const input = {
      database,
      organisationId: "organisation_quote_attempt",
      merchantId: "merchant_quote_attempt",
      storefrontId: "storefront_quote_attempt",
      checkoutId: "checkout_quote_attempt",
      checkoutRevision: 1,
      buyerSessionDigest: "a".repeat(64),
      idempotencyKey: "quote-attempt-1",
      request: {
        routeBinding: {
          kind: "japan_to_singapore" as const,
          routeId: "route_jp_sg_ems",
          zoneId: "zone_singapore",
          carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
          serviceCodes: ["ems_test", "international_parcel_air_test"],
          dutyCapabilityId: "duty_singapore_test",
          incoterm: "ddp" as const,
        },
        serviceCode: "ems_test",
        shippingQuoteId: "shipping_quote_attempt_fixture",
        packageId: "package_quote_attempt_fixture",
        taxCalculation: {
          kind: "provider_quoted" as const,
          providerAccountReference: "tax_account_sg_test",
          registrationPolicyReference: "tax_registration_quote_attempt",
        },
        lines: japanShippingQuoteLines(),
        addressAuthority: {
          kind: "provided_address" as const,
          address: {
            countryCode: "SG" as const,
            recipientName: "Durable Quote Buyer",
            addressLine1: "1 Raffles Quay",
            locality: "Singapore" as const,
            postalCode: "018956",
          },
          addressValidationReference: "address_validation_quote_attempt",
        },
        quotedAt: NOW,
        quoteTtlSeconds: 900,
      },
    };

    const first = quoteShippingWithAttempt({
      ...input,
      shipping: JAPAN_EXPORT,
    });

    expect(first).toMatchObject({
      kind: "quoted",
      quote: {
        carrierRate: { service: { code: "ems_test" } },
        quotedAt: NOW,
        expiresAt: "2026-08-14T09:45:00.000Z",
      },
    });
    const row = database
      .prepare(
        `SELECT attempt_id AS attemptId, lifecycle_state AS lifecycleState,
              attempt_json AS attemptJson,
              created_at AS createdAt, expires_at AS expiresAt
       FROM shipping_quote_attempt
       WHERE merchant_id = ?`,
      )
      .get<
        Readonly<{
          attemptId: string;
          lifecycleState: string;
          attemptJson: string;
          createdAt: string;
          expiresAt: string;
        }>
      >("merchant_quote_attempt");
    expect(row).toMatchObject({
      lifecycleState: "quoted",
      createdAt: NOW,
      expiresAt: "2026-08-14T09:45:00.000Z",
    });
    expect(row?.attemptJson).not.toMatch(
      /Durable Quote Buyer|Raffles Quay|018956/u,
    );
    if (row === undefined)
      throw new Error("Durable shipping quote attempt was unavailable");
    const replayDelegate = new RecordingCheckoutChargeQuoteProvider();
    const carrierReplayDelegate = new RecordingCarrierRateQuoteProvider();
    const componentReplay = quoteJapanShippingWithProviders(input.request, {
      carrierRateQuoteProvider: new DurableCarrierRateQuoteProvider({
        database,
        merchantId: input.merchantId,
        parentAttemptId: row.attemptId,
        checkoutId: input.checkoutId,
        checkoutRevision: input.checkoutRevision,
        buyerSessionDigest: input.buyerSessionDigest,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        provider: carrierReplayDelegate,
      }),
      chargeQuoteProvider: new DurableCheckoutChargeQuoteProvider({
        database,
        merchantId: input.merchantId,
        parentAttemptId: row.attemptId,
        checkoutId: input.checkoutId,
        checkoutRevision: input.checkoutRevision,
        buyerSessionDigest: input.buyerSessionDigest,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        provider: replayDelegate,
      }),
    });
    expect(componentReplay).toEqual(first);
    expect(carrierReplayDelegate.requests).toEqual([]);
    expect(replayDelegate.taxRequests).toEqual([]);
    expect(replayDelegate.dutyRequests).toEqual([]);
    const componentAttempts = database
      .prepare(
        `SELECT component_kind AS componentKind, lifecycle_state AS lifecycleState,
              provider_account_reference AS providerAccountReference,
              attempt_json AS attemptJson, created_at AS createdAt, expires_at AS expiresAt
       FROM checkout_charge_quote_attempt
       WHERE merchant_id = ? AND parent_attempt_id = ?
       ORDER BY component_kind`,
      )
      .all<
        Readonly<{
          componentKind: string;
          lifecycleState: string;
          providerAccountReference: string;
          attemptJson: string;
          createdAt: string;
          expiresAt: string;
        }>
      >(input.merchantId, row.attemptId);
    expect(componentAttempts).toMatchObject([
      {
        componentKind: "carrier_rate",
        lifecycleState: "quoted",
        providerAccountReference: "japan_post_ems_test",
        createdAt: NOW,
        expiresAt: "2026-08-14T09:45:00.000Z",
      },
      {
        componentKind: "duty",
        lifecycleState: "quoted",
        providerAccountReference: "singapore_duty_test",
        createdAt: NOW,
        expiresAt: "2026-08-14T09:45:00.000Z",
      },
      {
        componentKind: "tax",
        lifecycleState: "quoted",
        providerAccountReference: "tax_account_sg_test",
        createdAt: NOW,
        expiresAt: "2026-08-14T09:45:00.000Z",
      },
    ]);
    expect(JSON.parse(componentAttempts[0]?.attemptJson ?? "{}")).toMatchObject(
      {
        componentKind: "carrier_rate",
        state: "quoted",
        result: { kind: "quoted", rate: { service: { code: "ems_test" } } },
      },
    );
    expect(JSON.stringify(componentAttempts)).not.toMatch(
      /Durable Quote Buyer|Raffles Quay|018956/u,
    );
    const replay = quoteShippingWithAttempt({
      ...input,
      shipping: JAPAN_EXPORT,
    });
    expect(replay).toEqual(first);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM shipping_quote_attempt WHERE merchant_id = ?",
        )
        .get("merchant_quote_attempt"),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM checkout_charge_quote_attempt WHERE merchant_id = ?",
        )
        .get("merchant_quote_attempt"),
    ).toEqual({ count: 3 });
  } finally {
    database.close();
  }
});

it("binds carrier tracking signatures to one exact merchant route", () => {
  const gateway = createJapanShippingGateway(TEST_CARRIER_SIGNING_KEY);
  const event = {
    shipmentId: "shipment_route_signature_fixture",
    state: "in_transit" as const,
    providerEventId: "carrier_event_route_signature_fixture",
    occurredAt: NOW,
    location: "Tokyo",
  };
  const domesticRoute = {
    kind: "domestic_japan" as const,
    routeId: "route_jp_domestic_yamato",
    zoneId: "zone_domestic_japan",
    carrierRateCapabilityId: "carrier_rate_yamato_test",
    serviceCodes: ["takkyubin_test", "takkyubin_priority_test"],
  };
  const singaporeRoute = {
    kind: "japan_to_singapore" as const,
    routeId: "route_jp_sg_ems",
    zoneId: "zone_singapore",
    carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
    serviceCodes: ["ems_test", "international_parcel_air_test"],
    dutyCapabilityId: "duty_singapore_test",
    incoterm: "ddp" as const,
  };
  const signature = gateway.signTrackingEvent({
    routeBinding: domesticRoute,
    serviceCode: "takkyubin_test",
    ...event,
  });
  expect(
    gateway.verifyTrackingEvent({
      routeBinding: domesticRoute,
      serviceCode: "takkyubin_test",
      ...event,
      signature,
    }),
  ).toBe(true);
  expect(
    gateway.verifyTrackingEvent({
      routeBinding: singaporeRoute,
      serviceCode: "ems_test",
      ...event,
      signature,
    }),
  ).toBe(false);
});

it("creates an item and position, then receives one lot atomically", async () => {
  const fixture = createFixture();
  try {
    const client = createClient(fixture.authority);
    expect(seedCatalog(fixture.authority, "inventory_catalog_seed")).toBe(2);
    expect(
      await client.createInventoryItem(
        clientInput(createInventoryItemCommand(2)),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: { commandKind: "create_inventory_item", merchantRevision: 3 },
      },
    });
    expect(
      await client.openInventoryPosition(
        clientInput(openInventoryPositionCommand(3)),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "open_inventory_position",
          merchantRevision: 4,
        },
      },
    });

    const command = receiveInventoryCommand(4);
    const applied = await client.receiveInventory(clientInput(command));
    expect(applied).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "receive_inventory",
          previousMerchantRevision: 4,
          merchantRevision: 5,
          resource: { kind: "inventory_movement", revision: 1 },
        },
      },
    });
    if (!applied.ok || applied.value.outcome !== "applied") {
      throw new Error("Inventory receipt did not apply");
    }
    expect(await client.receiveInventory(clientInput(command))).toEqual({
      ok: true,
      value: { outcome: "replayed", receipt: applied.value.receipt },
    });
    expect(
      fixture.authority.readInventoryLot(
        "merchant_demo",
        "lot_receipt_line_oat_milk_accepted",
      ),
    ).toMatchObject({
      lotCode: "OAT-20260814-A",
      receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
      remainingQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
      expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
      lifecycle: { state: "available" },
    });
    expect(fixture.authority.listInventoryMovements("merchant_demo")).toEqual([
      expect.objectContaining({
        inventoryItemId: "inventory_oat_milk",
        change: {
          kind: "increase",
          quantity: { amount: 8_000, scale: 0, unit: "milliliter" },
          reason: {
            kind: "receipt",
        purchase: { kind: "unlinked" },
            receiptId: "receipt_oat_milk",
            receiptLineId: "receipt_line_oat_milk_accepted",
          },
        },
      }),
    ]);
    expect(fixture.authority.readSnapshot("merchant_demo")).toMatchObject({
      merchantRevision: 5,
      resources: {
        inventoryPositions: [
          {
            id: "position_oat_cafe",
            revision: 2,
            balance: {
              kind: "accounted",
              onHand: { amount: 8_000, scale: 0, unit: "milliliter" },
              allocated: { amount: 0, scale: 0, unit: "milliliter" },
              available: { amount: 8_000, scale: 0, unit: "milliliter" },
            },
          },
        ],
      },
    });
    const receiptDelivery = findDelivery(
      fixture.authority.pendingDeliveries("merchant_demo"),
      applied.value.receipt.deliveryId,
    );
    expect(receiptDelivery?.observations.map(observationKind)).toEqual([
      "inventory_movement",
      "inventory_lot",
      "inventory_position",
    ]);
  } finally {
    fixture.close();
  }
});

it("rejects a duplicate receipt identity without changing inventory", () => {
  const fixture = createInventoryFixture();
  try {
    const first = fixture.authority.receiveInventory(
      receiveInventoryCommand(4),
    );
    expect(first.outcome).toBe("applied");
    const duplicate = fixture.authority.receiveInventory({
      ...receiveInventoryCommand(5),
      idempotencyKey: "receive_oat_duplicate",
      inventoryPositionRevision: 2,
      lot: {
        kind: "tracked",
        lotId: "lot_receipt_line_oat_milk_duplicate",
        lotCode: "OAT-20260814-B",
        expiry: { kind: "expires", expiresAt: "2026-08-22T00:00:00.000Z" },
      },
    });
    expect(duplicate).toMatchObject({
      outcome: "rejected",
      error: {
        code: "inventory_receipt_already_applied",
        receiptId: "receipt_oat_milk",
        receiptLineId: "receipt_line_oat_milk_accepted",
      },
    });
    expect(
      fixture.authority.listInventoryMovements("merchant_demo"),
    ).toHaveLength(1);
    expect(
      fixture.authority.readSnapshot("merchant_demo")?.merchantRevision,
    ).toBe(5);
  } finally {
    fixture.close();
  }
});

it("provisions demo inventory only through typed commands", () => {
  const fixture = createFixture(false);
  try {
    const snapshot = fixture.authority.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: "organisation_demo",
      merchantId: "merchant_demo",
      profile: "pantry_ecommerce",
      createdAt: NOW,
    });
    expect(snapshot).toMatchObject({
      merchantRevision: 5,
      resources: {
        inventoryItems: { length: 1 },
        inventoryPositions: { length: 1 },
      },
    });
    expect(
      fixture.authority.listInventoryMovements("merchant_demo"),
    ).toHaveLength(1);
    expect(
      fixture.authority.provisionDemo({
        schemaVersion: "commerce.provision-demo.v2",
        externalReference: "organisation_demo",
        merchantId: "merchant_demo",
        profile: "pantry_ecommerce",
        createdAt: NOW,
      }),
    ).toEqual(snapshot);
  } finally {
    fixture.close();
  }
});

it("quotes and places shipping with the pinned merchant percentage tax policy", async () => {
  const capabilityHealth = new TestCheckoutProviderCapabilityHealthProvider();
  const fixture = createFixture(false, capabilityHealth);
  try {
    const admin = createClient(fixture.authority);
    expect(
      await admin.provisionMerchant({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: "organisation_demo",
        merchantId: "merchant_demo",
        createdAt: NOW,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "provisioned" } });
    expect(
      await admin.createInventoryItem(
        clientInput(shippingInventoryItemCommand(0, "cookie_box")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await admin.createInventoryItem(
        clientInput(shippingInventoryItemCommand(1, "packaging")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await admin.configureShippingStorefront(
        clientInput(merchantTaxShippingStorefrontCommand(2, "merchant_tax")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      fixture.authority.readActiveCheckoutProfile(
        "merchant_demo",
        "storefront_cookie_store_sg",
      ),
    ).toMatchObject({
      profile: {
        configuration: {
          taxPolicy: {
            kind: "merchant_inclusive",
            jurisdictionPolicyId: "tax_policy_storefront_cookie_store_sg",
          },
        },
      },
    });
    await admin.openInventoryPosition(
      clientInput(shippingInventoryPositionCommand(3, "cookie_box")),
    );
    await admin.openInventoryPosition(
      clientInput(shippingInventoryPositionCommand(4, "packaging")),
    );
    await admin.receiveInventory(
      clientInput(shippingReceiptCommand(5, "cookie_box")),
    );
    await admin.receiveInventory(
      clientInput(shippingReceiptCommand(6, "packaging")),
    );

    capabilityHealth.mode = {
      state: "unavailable",
      capabilityReference: "commerce_merchant_tax_authority",
    };
    const storefront = createStorefrontClient(fixture);
    const session = await storefront.createSession(
      "merchant_demo",
      "storefront_cookie_store_sg",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok)
      throw new Error("Merchant-tax buyer session was unavailable");
    expect(
      await storefront.readCatalog(
        "merchant_demo",
        "storefront_cookie_store_sg",
        session.value.token,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        storefront: {
          fulfillment: "shipping",
          shippingServices: [
            { availability: { state: "available" } },
            { availability: { state: "available" } },
            { availability: { state: "available" } },
            { availability: { state: "available" } },
          ],
        },
        listings: [{ availability: "available" }],
      },
    });
    const destination = await validateTestShippingAddress(
      storefront,
      session.value.token,
      {
        countryCode: "SG",
        recipientName: "Merchant Tax Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
      "merchant_tax_address",
    );
    const command = {
      ...shippingBuyerCheckoutCommand("018956", destination.acceptance),
      shippingDestination: {
        kind: "provided_address" as const,
        address: destination.address,
        acceptance: destination.acceptance,
      },
    };
    const checkout = await createShippingCheckoutFromLines(
      storefront,
      "merchant_demo",
      "storefront_cookie_store_sg",
      session.value.token,
      command,
    );
    if (!checkout.ok) throw new Error(JSON.stringify(checkout.error));
    expect(checkout).toMatchObject({
      ok: true,
      value: {
        quote: {
          totals: {
            subtotal: { amountMinor: 3_600, currency: "JPY" },
            tax: { amountMinor: 580, currency: "JPY" },
            duty: { amountMinor: 180, currency: "JPY" },
            shipping: { amountMinor: 2_200, currency: "JPY" },
            total: { amountMinor: 6_560, currency: "JPY" },
          },
        },
      },
    });
    const attempt = fixture.database
      .prepare(
        `SELECT attempt_json AS attemptJson
       FROM shipping_quote_attempt
       WHERE merchant_id = ? AND checkout_id = ?`,
      )
      .get<Readonly<{ attemptJson: string }>>(
        "merchant_demo",
        checkout.value.checkoutId,
      );
    expect(attempt).toBeDefined();
    expect(JSON.parse(attempt?.attemptJson ?? "null")).toMatchObject({
      state: "quoted",
      quote: {
        taxQuote: {
          providerAccountReference: "commerce_merchant_tax_authority",
          registrationPolicyReference: "tax_policy_storefront_cookie_store_sg",
          taxAmount: { amountMinor: 580, currency: "JPY" },
          lineAllocations: [{ amount: { amountMinor: 580, currency: "JPY" } }],
        },
      },
    });
    expect(
      await createShippingCheckoutFromLines(
        storefront,
        "merchant_demo",
        "storefront_cookie_store_sg",
        session.value.token,
        command,
      ),
    ).toEqual(checkout);
    const placed = await completeBuyerCheckout(
      storefront,
      "merchant_demo",
      "storefront_cookie_store_sg",
      checkout.value.checkoutId,
      session.value.token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: "merchant_tax_payment",
        checkoutRevision: checkout.value.revision,
        quoteDigest: checkout.value.quote.quoteDigest,
      },
    );
    expect(placed).toMatchObject({
      ok: true,
      value: {
        state: "placed",
        total: { amountMinor: 6_560, currency: "JPY" },
      },
    });
    expect(
      fixture.authority.readSnapshot("merchant_demo")?.resources.orders,
    ).toMatchObject([
      {
        lineItems: [{ tax: { amountMinor: 580, currency: "JPY" } }],
        totals: {
          tax: { amountMinor: 580, currency: "JPY" },
          total: { amountMinor: 6_560, currency: "JPY" },
        },
      },
    ]);
  } finally {
    fixture.close();
  }
});

it("places flavored channel listings and marks one variant on two channels", async () => {
  const fixture = createFixture(false);
  try {
    const client = createClient(fixture.authority);
    expect(
      await client.provisionMerchant({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: "organisation_demo",
        merchantId: "merchant_demo",
        createdAt: NOW,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "provisioned" } });
    expect(
      await client.createInventoryItem(
        clientInput(shippingInventoryItemCommand(0, "cookie_box")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await client.createInventoryItem(
        clientInput(shippingInventoryItemCommand(1, "packaging")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await client.configureShippingStorefront(
        clientInput(shippingStorefrontCommand(2, true, "flavored_base")),
      ),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });
    expect(
      await client.createInventoryItem(clientInput(matchaBoxItemCommand(3))),
    ).toMatchObject({ ok: true, value: { outcome: "applied" } });

    expect(
      await client.placeChannelListing(
        clientInput(matchaChannelListingCommand(4, false)),
      ),
    ).toEqual({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "shippingSpecification.required",
        },
      },
    });
    const placement = matchaChannelListingCommand(4, true);
    expect(
      await client.placeChannelListing(clientInput(placement)),
    ).toMatchObject({
      ok: true,
      value: {
        outcome: "applied",
        receipt: {
          commandKind: "place_channel_listing",
          merchantRevision: 5,
          resource: { kind: "offer", id: "offer_matcha_box_sg", revision: 1 },
        },
      },
    });
    expect(
      await client.placeChannelListing(clientInput(placement)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "replayed" },
    });
    expect(
      fixture.authority.readVariantShippingSpecification(
        "merchant_demo",
        "variant_matcha_box_6",
        1,
      ),
    ).toEqual(placement.shippingSpecification);

    expect(
      await client.placeChannelListing(
        clientInput(
          existingMatchaPlacementCommand(
            5,
            "channel_cookie_store_sg",
            "offer_matcha_box_duplicate",
            "duplicate",
          ),
        ),
      ),
    ).toEqual({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_already_exists",
          kind: "channel_offer",
          id: "offer_matcha_box_sg",
        },
      },
    });

    expect(
      await client.prepareCatalogListing(clientInput(giftTinCatalogCommand(5))),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 6 } },
    });
    expect(
      await client.placeChannelListing(
        clientInput(
          existingMatchaPlacementCommand(
            6,
            "channel_online",
            "offer_matcha_box_online",
            "online_with_spec",
            placement.shippingSpecification,
          ),
        ),
      ),
    ).toEqual({
      ok: true,
      value: {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "shippingSpecification.channel",
        },
      },
    });
    expect(
      await client.placeChannelListing(
        clientInput(
          existingMatchaPlacementCommand(
            6,
            "channel_online",
            "offer_matcha_box_online",
            "online",
          ),
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: { outcome: "applied", receipt: { merchantRevision: 7 } },
    });

    const offers =
      fixture.authority.readSnapshot("merchant_demo")?.resources.offers ?? [];
    expect(
      offers
        .filter((offer) => offer.variantId === "variant_matcha_box_6")
        .map((offer) => offer.salesChannelId)
        .sort(),
    ).toEqual(["channel_cookie_store_sg", "channel_online"]);

    const storefrontClient = createStorefrontClient(fixture);
    const session = await storefrontClient.createSession(
      "merchant_demo",
      "storefront_cookie_store_sg",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Shipping buyer session was unavailable");
    const catalog = await storefrontClient.readCatalog(
      "merchant_demo",
      "storefront_cookie_store_sg",
      session.value.token,
    );
    if (!catalog.ok) throw new Error("Shipping catalog was unavailable");
    expect(
      catalog.value.listings.map((listing) => listing.variantId).sort(),
    ).toEqual(["variant_cookie_box_6", "variant_matcha_box_6"]);
  } finally {
    fixture.close();
  }
});

it("configures the Plan 23 flavored catalog and quotes per-flavor customs facts", async () => {
  const fixture = createFixture(false);
  try {
    const client = createClient(fixture.authority);
    const identity = { organisationId: "organisation_demo", merchantId: "merchant_demo" };
    await rebuildPhase3Cafe(client, identity);
    await configurePhase4Shipping(client, identity);
    const configured = await configurePlan23FlavoredCatalog(client, identity);
    expect(configured).toEqual({
      ok: true,
      ...identity,
      merchantRevision: 116,
      storefrontId: "storefront_cookie_store_sg",
      flavors: ["sesame", "ginger", "taro", "matcha"],
      availableBoxesPerFlavor: 10,
    });
    await expect(
      configurePlan23FlavoredCatalog(client, identity),
    ).resolves.toEqual(configured);

    const storefrontClient = createStorefrontClient(fixture);
    const session = await storefrontClient.createSession(
      "merchant_demo",
      "storefront_cookie_store_sg",
      {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    if (!session.ok) throw new Error("Shipping buyer session was unavailable");
    const catalog = await storefrontClient.readCatalog(
      "merchant_demo",
      "storefront_cookie_store_sg",
      session.value.token,
    );
    if (!catalog.ok) throw new Error("Shipping catalog was unavailable");
    expect(
      catalog.value.listings
        .map((listing) => ({
          sku: listing.sku,
          price: listing.price.amountMinor,
          availability: listing.availability,
        }))
        .sort((left, right) => left.sku.localeCompare(right.sku)),
    ).toEqual([
      { sku: "COOKIE-BOX-6-SG", price: 3600, availability: "available" },
      { sku: "GINGER-BOX-6-SG", price: 3600, availability: "available" },
      { sku: "MATCHA-BOX-6-SG", price: 4200, availability: "available" },
      { sku: "SESAME-BOX-6-SG", price: 3600, availability: "available" },
      { sku: "TARO-BOX-6-SG", price: 3800, availability: "available" },
    ]);

    const flavoredAddress = await validateTestShippingAddress(
      storefrontClient,
      session.value.token,
      flavoredBuyerCheckoutCommand(
        "address_source",
        "variant_matcha_box_6",
        1,
        TEST_ADDRESS_ACCEPTANCE,
      ).shippingDestination.address,
      "flavored_address",
    );
    const correctedFlavoredAddress = await validateTestShippingAddress(
      storefrontClient,
      session.value.token,
      { ...flavoredAddress.address, addressLine1: "2 Raffles Quay" },
      "flavored_address_corrected",
    );

    expect(
      await createShippingCheckoutFromLines(
        storefrontClient,
        "merchant_demo",
        "storefront_cookie_store_sg",
        session.value.token,
        flavoredBuyerCheckoutCommand(
          "matcha_checkout",
          "variant_matcha_box_6",
          1,
          flavoredAddress.acceptance,
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        state: "quoted",
        quote: {
          lines: [
            {
              variantId: "variant_matcha_box_6",
              quantity: 1,
              lineTotal: { amountMinor: 4200, currency: "JPY" },
            },
          ],
          totals: {
            subtotal: { amountMinor: 4200, currency: "JPY" },
            duty: { amountMinor: 210, currency: "JPY" },
            tax: { amountMinor: 576, currency: "JPY" },
            shipping: { amountMinor: 2200, currency: "JPY" },
            total: { amountMinor: 7186, currency: "JPY" },
          },
          shipping: {
            destinationCountry: "SG",
            packagePlan: {
              package: {
                weight: { grams: 1210 },
                customsLines: [
                  {
                    description: "Six matcha cookies in one retail box",
                    declaredValue: { amountMinor: 4200, currency: "JPY" },
                    countryOfOrigin: "JP",
                    hsCode: "190531",
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(
      await createShippingCheckoutFromLines(
        storefrontClient,
        "merchant_demo",
        "storefront_cookie_store_sg",
        session.value.token,
        flavoredBuyerCheckoutCommand(
          "taro_checkout",
          "variant_taro_box_6",
          2,
          flavoredAddress.acceptance,
          "international_parcel_air_test",
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        state: "quoted",
        quote: {
          lines: [
            {
              variantId: "variant_taro_box_6",
              quantity: 2,
              lineTotal: { amountMinor: 7600, currency: "JPY" },
            },
          ],
          totals: {
            duty: { amountMinor: 380, currency: "JPY" },
            tax: { amountMinor: 846, currency: "JPY" },
            shipping: { amountMinor: 1800, currency: "JPY" },
            total: { amountMinor: 10626, currency: "JPY" },
          },
          shipping: {
            packagePlan: {
              package: {
                weight: { grams: 2480 },
                customsLines: [
                  {
                    description: "Six taro cookies in one retail box",
                    declaredValue: { amountMinor: 7600, currency: "JPY" },
                  },
                ],
              },
            },
          },
        },
      },
    });

    const multiLineCommand = flavoredBuyerMultiLineCheckoutCommand(
      flavoredAddress.acceptance,
    );
    const multiLine = await createShippingCheckoutFromLines(
      storefrontClient,
      "merchant_demo",
      "storefront_cookie_store_sg",
      session.value.token,
      multiLineCommand,
    );
    expect(multiLine).toMatchObject({
      ok: true,
      value: {
        state: "quoted",
        quote: {
          lines: [
            {
              variantId: "variant_matcha_box_6",
              quantity: 1,
              lineTotal: { amountMinor: 4200, currency: "JPY" },
            },
            {
              variantId: "variant_taro_box_6",
              quantity: 1,
              lineTotal: { amountMinor: 3800, currency: "JPY" },
            },
          ],
          totals: {
            subtotal: { amountMinor: 8000, currency: "JPY" },
            duty: { amountMinor: 400, currency: "JPY" },
            tax: { amountMinor: 918, currency: "JPY" },
            shipping: { amountMinor: 2200, currency: "JPY" },
            total: { amountMinor: 11518, currency: "JPY" },
          },
          shipping: {
            packagePlan: {
              package: {
                weight: { grams: 2450 },
                lineQuantities: [
                  { quantity: { amount: 1, scale: 0, unit: "each" } },
                  { quantity: { amount: 1, scale: 0, unit: "each" } },
                ],
                customsLines: [
                  {
                    description: "Six matcha cookies in one retail box",
                    declaredValue: { amountMinor: 4200, currency: "JPY" },
                  },
                  {
                    description: "Six taro cookies in one retail box",
                    declaredValue: { amountMinor: 3800, currency: "JPY" },
                  },
                ],
              },
            },
          },
        },
      },
    });
    if (!multiLine.ok)
      throw new Error("Multi-line shipping checkout was unavailable");
    expect(
      await createShippingCheckoutFromLines(
        storefrontClient,
        "merchant_demo",
        "storefront_cookie_store_sg",
        session.value.token,
        {
          ...multiLineCommand,
          shippingServiceCode: "international_parcel_air_test",
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "rejected",
        status: 409,
        error: {
          code: "idempotency_conflict",
          idempotencyKey: expect.stringMatching(/^buyer_shipping_checkout_/u),
        },
      },
    });
    const refreshCommand = flavoredBuyerMultiLineRefreshCommand(
      multiLine.value,
      flavoredAddress.acceptance,
    );
    const refreshedMultiLine = await storefrontClient.refreshShippingCheckout(
      "merchant_demo",
      "storefront_cookie_store_sg",
      multiLine.value.checkoutId,
      session.value.token,
      refreshCommand,
    );
    expect(refreshedMultiLine).toMatchObject({
      ok: true,
      value: {
        checkoutId: multiLine.value.checkoutId,
        revision: multiLine.value.revision + 1,
        quote: {
          lines: [
            { variantId: "variant_matcha_box_6", quantity: 2 },
            { variantId: "variant_taro_box_6", quantity: 1 },
          ],
          totals: {
            subtotal: { amountMinor: 12200, currency: "JPY" },
            duty: { amountMinor: 610, currency: "JPY" },
            tax: { amountMinor: 1296, currency: "JPY" },
            shipping: { amountMinor: 2200, currency: "JPY" },
            total: { amountMinor: 16306, currency: "JPY" },
          },
          shipping: {
            packagePlan: { package: { weight: { grams: 3660 } } },
          },
        },
      },
    });
    if (!refreshedMultiLine.ok)
      throw new Error("Multi-line shipping refresh was unavailable");
    expect(
      await storefrontClient.refreshShippingCheckout(
        "merchant_demo",
        "storefront_cookie_store_sg",
        multiLine.value.checkoutId,
        session.value.token,
        refreshCommand,
      ),
    ).toEqual(refreshedMultiLine);
    for (const changedRequest of [
      { ...refreshCommand, quoteDigest: "a".repeat(64) },
      {
        ...refreshCommand,
        shippingServiceCode: "international_parcel_air_test",
      },
      {
        ...refreshCommand,
        checkoutRevision: refreshedMultiLine.value.revision,
        quoteDigest: refreshedMultiLine.value.quote.quoteDigest,
        lines: [
          { variantId: "variant_matcha_box_6", quantity: 3 },
          { variantId: "variant_taro_box_6", quantity: 1 },
        ],
      },
      {
        ...refreshCommand,
        shippingDestination: {
          kind: "provided_address" as const,
          address: correctedFlavoredAddress.address,
          acceptance: correctedFlavoredAddress.acceptance,
        },
      },
    ]) {
      expect(
        await storefrontClient.refreshShippingCheckout(
          "merchant_demo",
          "storefront_cookie_store_sg",
          multiLine.value.checkoutId,
          session.value.token,
          changedRequest,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "rejected",
          status: 409,
          error: {
            code: "idempotency_conflict",
            idempotencyKey: refreshCommand.idempotencyKey,
          },
        },
      });
    }
  } finally {
    fixture.close();
  }
});

type Fixture = Readonly<{
  authority: CommerceAuthority;
  database: NodeCommerceDatabase;
  close: () => void;
}>;

function createFixture(
  provision = true,
  checkoutCapabilityHealthProvider: CheckoutProviderCapabilityHealthProvider = new ReadyCheckoutProviderCapabilityHealthProvider(),
): Fixture {
  const databasePath = temporaryDatabasePath("commerce");
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, NOW);
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new DeterministicPaymentGateway(fixedNow),
    now: fixedNow,
    shippingGateway: createJapanShippingGateway(
      "pantry-plan22-japan-post-ems-test-key",
    ),
    shipping: createJapanExportShipping(
        "pantry-plan22-japan-post-ems-test-key",
      ),
    checkoutCapabilityHealthProvider,
  });
  if (provision) provisionMerchant(authority);
  return {
    authority,
    database,
    close: createFixtureCloser(authority, databasePath),
  };
}

function createInventoryFixture(): Fixture {
  const fixture = createFixture();
  seedCatalog(fixture.authority, "inventory_fixture_catalog");
  const item = fixture.authority.createInventoryItem(
    createInventoryItemCommand(2),
  );
  if (item.outcome !== "applied")
    throw new Error("Inventory item fixture failed");
  const position = fixture.authority.openInventoryPosition(
    openInventoryPositionCommand(3),
  );
  if (position.outcome !== "applied")
    throw new Error("Inventory position fixture failed");
  return fixture;
}

function provisionMerchant(authority: CommerceAuthority): void {
  authority.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: "organisation_demo",
    merchantId: "merchant_demo",
    createdAt: NOW,
  });
}

function createFixtureCloser(
  authority: CommerceAuthority,
  databasePath: string,
): () => void {
  return function closeFixture(): void {
    authority.close();
    removeDatabase(databasePath);
  };
}

function createClient(authority: CommerceAuthority): CommerceAdminClient {
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: testBuyerSessions(),
    serviceToken: SERVICE_TOKEN,
  });
  return new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
}

function createStorefrontClient(fixture: Fixture) {
  const api = new CommerceHttpApi({
    authority: fixture.authority,
    buyerSessions: testBuyerSessions(),
    addressValidations: createLocalShippingAddressValidationService(
      fixture.database,
      fixedNow,
    ),
    serviceToken: SERVICE_TOKEN,
  });
  return new CommerceStorefrontClient({
    baseUrl: "https://commerce.test",
    fetch: api.fetch,
  });
}

type BuyerShippingCheckoutFromLines<T> =
  T extends CreateCommerceBuyerShippingCheckoutV1
    ? Omit<T, "cartId" | "cartRevision"> &
        Readonly<{
          lines: readonly CommerceBuyerShippingCheckoutLineV1[];
        }>
    : never;

async function createShippingCheckoutFromLines(
  client: CommerceStorefrontClient,
  merchantId: string,
  storefrontId: string,
  sessionToken: string,
  command: BuyerShippingCheckoutFromLines<CreateCommerceBuyerShippingCheckoutV1>,
): Promise<CommerceClientResult<CommerceBuyerQuotedShippingCheckoutV1>> {
  const cart = await client.createCart(merchantId, storefrontId, sessionToken, {
    schemaVersion: "commerce.create-buyer-cart.v1",
    idempotencyKey: `${command.idempotencyKey}_cart`,
    lines: command.lines.map(shippingCartLine),
  });
  if (!cart.ok) return { ok: false, error: cart.error };
  const common = {
    schemaVersion: command.schemaVersion,
    idempotencyKey: command.idempotencyKey,
    cartId: cart.value.cartId,
    cartRevision: cart.value.revision,
    shippingServiceCode: command.shippingServiceCode,
  };
  if (command.buyer.kind === "guest") {
    if (command.shippingDestination.kind !== "provided_address") {
      throw new Error("Guest test checkout selected a saved address");
    }
    return client.createShippingCheckout(
      merchantId,
      storefrontId,
      sessionToken,
      {
        ...common,
        buyer: command.buyer,
        shippingDestination: command.shippingDestination,
      },
    );
  }
  return client.createShippingCheckout(merchantId, storefrontId, sessionToken, {
    ...common,
    buyer: command.buyer,
    shippingDestination: command.shippingDestination,
  });
}

function shippingCartLine(
  line: CommerceBuyerShippingCheckoutLineV1,
): Readonly<{ kind: "catalog"; variantId: string; quantity: number }> {
  return {
    kind: "catalog",
    variantId: line.variantId,
    quantity: line.quantity,
  };
}

async function validateTestShippingAddress(
  client: CommerceStorefrontClient,
  sessionToken: string,
  address: CommerceBuyerShippingAddressV1,
  idempotencyKey: string,
): Promise<
  Readonly<{
    address: CommerceBuyerShippingAddressV1;
    acceptance: CommerceBuyerShippingAddressAcceptanceV1;
  }>
> {
  const result = await client.validateShippingAddress(
    "merchant_demo",
    "storefront_cookie_store_sg",
    sessionToken,
    {
      schemaVersion: "commerce.validate-buyer-shipping-address.v1",
      idempotencyKey,
      address,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  switch (result.value.state) {
    case "accepted":
      return {
        address: result.value.address,
        acceptance: {
          kind: "accepted_as_entered",
          addressValidationReference: result.value.validationReference,
        },
      };
    case "correction_required":
      return {
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
      return assertNever(result.value, "Unsupported commerce test branch");
  }
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

function testBuyerSessions(): BuyerSessionAuthority {
  return new BuyerSessionAuthority({
    secret: "commerce_test_buyer_session_secret",
    now: fixedNow,
    newSessionId: fixedBuyerSessionId,
  });
}

function fixedBuyerSessionId(): string {
  return "buyer_session_test";
}

function createLocationCommand(
  idempotencyKey: string,
): CreateCommerceLocationV1 {
  return {
    schemaVersion: "commerce.create-location.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision: 0,
    idempotencyKey,
    requestedAt: NOW,
    location: {
      id: "location_cafe",
      revision: 1,
      name: "Main Cafe",
      kind: "store",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
    },
  };
}

function prepareCatalogCommand(
  idempotencyKey: string,
  expectedMerchantRevision: number,
): PrepareCommerceCatalogListingV1 {
  return {
    schemaVersion: "commerce.prepare-catalog-listing.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey,
    requestedAt: NOW,
    salesChannel: {
      id: "channel_online",
      revision: 1,
      name: "Online Store",
      kind: "online",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
    },
    product: {
      id: "product_cookie_box",
      revision: 1,
      title: "Six-cookie box",
      description: "Six assorted cookies.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: NOW,
    },
    variant: {
      id: "variant_cookie_box_6",
      revision: 1,
      productId: "product_cookie_box",
      sku: "COOKIE-BOX-6",
      title: "Box of six",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: NOW,
    },
    offer: {
      id: "offer_cookie_box",
      revision: 1,
      variantId: "variant_cookie_box_6",
      salesChannelId: "channel_online",
      price: { amountMinor: 2400, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: NOW },
      occurredAt: NOW,
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_cookie_box",
      variantId: "variant_cookie_box_6",
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  };
}

function seedCatalog(
  authority: CommerceAuthority,
  idempotencyKey: string,
): number {
  const location = authority.createLocation(
    createLocationCommand(`${idempotencyKey}_location`),
  );
  if (location.outcome !== "applied")
    throw new Error("Location fixture failed");
  const catalog = authority.prepareCatalogListing(
    prepareCatalogCommand(`${idempotencyKey}_catalog`, 1),
  );
  if (catalog.outcome !== "applied") throw new Error("Catalog fixture failed");
  return catalog.receipt.merchantRevision;
}

function publishCommand(): PublishCommerceCatalogListingV1 {
  return {
    schemaVersion: "commerce.publish-catalog-listing.v1",
    merchantId: "merchant_demo",
    idempotencyKey: "publish_cookie_box",
    requestedAt: NOW,
    productId: "product_cookie_box",
    productRevision: 1,
    variantId: "variant_cookie_box_6",
    variantRevision: 1,
    offerId: "offer_cookie_box",
    offerRevision: 1,
    salesChannelId: "channel_online",
    salesChannelRevision: 1,
  };
}

function createInventoryItemCommand(
  expectedMerchantRevision: number,
): CreateCommerceInventoryItemV1 {
  return {
    schemaVersion: "commerce.create-inventory-item.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "create_oat_milk",
    requestedAt: NOW,
    inventoryItemId: "inventory_oat_milk",
    merchantCode: "OAT-MILK",
    name: "Oat milk",
    baseUnit: "milliliter",
    category: "ingredient",
    tracking: { kind: "lot_tracked", expiry: "required" },
  };
}

function openInventoryPositionCommand(
  expectedMerchantRevision: number,
): OpenCommerceInventoryPositionV1 {
  return {
    schemaVersion: "commerce.open-inventory-position.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "open_oat_cafe",
    requestedAt: NOW,
    inventoryPositionId: "position_oat_cafe",
    inventoryItemId: "inventory_oat_milk",
    inventoryItemRevision: 1,
    locationId: "location_cafe",
    locationRevision: 1,
  };
}

function receiveInventoryCommand(
  expectedMerchantRevision: number,
): ReceiveCommerceInventoryV3 {
  return {
    schemaVersion: "commerce.receive-inventory.v3",
    purchase: { kind: "unlinked" },
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "scenario_cafe_patisserie_v2:receive_oat_milk:1",
    requestedAt: NOW,
    receiptId: "receipt_oat_milk",
    receiptLineId: "receipt_line_oat_milk_accepted",
    inventoryItemId: "inventory_oat_milk",
    inventoryItemRevision: 1,
    inventoryPositionId: "position_oat_cafe",
    inventoryPositionRevision: 1,
    locationId: "location_cafe",
    receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
    lot: {
      kind: "tracked",
      lotId: "lot_receipt_line_oat_milk_accepted",
      lotCode: "OAT-20260814-A",
      expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
    },
    receivedAt: NOW,
  };
}

function cafeInventoryItemCommand(
  expectedMerchantRevision: number,
): CreateCommerceInventoryItemV1 {
  return {
    schemaVersion: "commerce.create-inventory-item.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_oat_milk_item",
    requestedAt: NOW,
    inventoryItemId: "inventory_oat_milk",
    merchantCode: "OAT-MILK",
    name: "Oat milk",
    baseUnit: "milliliter",
    category: "ingredient",
    tracking: { kind: "lot_tracked", expiry: "required" },
  };
}

function shippingInventoryItemCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "packaging",
): CreateCommerceInventoryItemV1 {
  if (kind === "cookie_box") {
    return {
      schemaVersion: "commerce.create-inventory-item.v1",
      merchantId: "merchant_demo",
      expectedMerchantRevision,
      idempotencyKey: "shipping_cookie_box_item",
      requestedAt: NOW,
      inventoryItemId: "inventory_cookie_box_6",
      merchantCode: "COOKIE-BOX-6",
      name: "Six-cookie box",
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "lot_tracked", expiry: "required" },
    };
  }
  return {
    schemaVersion: "commerce.create-inventory-item.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "shipping_carton_item",
    requestedAt: NOW,
    inventoryItemId: "inventory_shipping_carton",
    merchantCode: "SHIP-CARTON",
    name: "Shipping carton",
    baseUnit: "each",
    category: "packaging",
    tracking: { kind: "aggregate" },
  };
}

function shippingStorefrontCommand(
  expectedMerchantRevision: number,
  includePackaging: boolean,
  identity: string,
): ConfigureCommerceShippingStorefrontV1 {
  const components = includePackaging
    ? [
        {
          inventoryItemId: "inventory_cookie_box_6",
          quantity: { amount: 1, scale: 0, unit: "each" as const },
        },
        {
          inventoryItemId: "inventory_shipping_carton",
          quantity: { amount: 1, scale: 0, unit: "each" as const },
        },
      ]
    : [
        {
          inventoryItemId: "inventory_cookie_box_6",
          quantity: { amount: 1, scale: 0, unit: "each" as const },
        },
      ];
  return {
    schemaVersion: "commerce.configure-shipping-storefront.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: `shipping_storefront_${identity}`,
    requestedAt: NOW,
    location: {
      id: "location_tokyo_fulfillment",
      revision: 1,
      name: "Tokyo fulfillment",
      kind: "fulfillment_center",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
    },
    salesChannel: {
      id: "channel_cookie_store_sg",
      revision: 1,
      name: "Singapore cookie store",
      kind: "online",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
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
      occurredAt: NOW,
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
      occurredAt: NOW,
    },
    offer: {
      id: "offer_cookie_box_sg",
      revision: 1,
      variantId: "variant_cookie_box_6",
      salesChannelId: "channel_cookie_store_sg",
      price: { amountMinor: 3600, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: NOW },
      occurredAt: NOW,
    },
    storefront: {
      storefrontId: "storefront_cookie_store_sg",
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
      lifecycle: { state: "active", activeAt: NOW },
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_cookie_box_sg",
      variantId: "variant_cookie_box_6",
      revision: 1,
      scope: { kind: "location", locationId: "location_tokyo_fulfillment" },
      mode: { kind: "direct", components, commitOn: "fulfillment_completed" },
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
      lifecycle: { state: "active", activeAt: NOW },
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

function merchantTaxShippingStorefrontCommand(
  expectedMerchantRevision: number,
  identity: string,
): ConfigureCommerceShippingStorefrontV1 {
  const command = shippingStorefrontCommand(
    expectedMerchantRevision,
    true,
    identity,
  );
  return {
    ...command,
    storefront: {
      ...command.storefront,
      checkout: {
        ...command.storefront.checkout,
        tax: { kind: "percentage", basisPoints: 1_000 },
      },
    },
  };
}

function japanShippingQuoteLines(): readonly JapanShippingQuoteLine[] {
  return [
    {
      checkoutLineId: "line_matcha",
      quantity: 1,
      itemSubtotal: { amountMinor: 4_200, currency: "JPY" },
      inputIdentity: {
        storefrontId: "storefront_cookie_store",
        storefrontRevision: 1,
        variantId: "variant_matcha_box_6",
        variantRevision: 1,
        offerId: "offer_matcha_box",
        offerRevision: 1,
        shippingProfileId: "shipping_profile_japan",
        shippingProfileRevision: 1,
        consumptionPlanId: "consumption_plan_matcha_box",
        consumptionPlanRevision: 1,
      },
      specification: {
        kind: "physical",
        weight: { grams: 1_210 },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 100,
        },
        countryOfOrigin: "JP",
        hsCode: "190531",
        description: "Six matcha cookies in one retail box",
      },
    },
    {
      checkoutLineId: "line_taro",
      quantity: 1,
      itemSubtotal: { amountMinor: 3_800, currency: "JPY" },
      inputIdentity: {
        storefrontId: "storefront_cookie_store",
        storefrontRevision: 1,
        variantId: "variant_taro_box_6",
        variantRevision: 1,
        offerId: "offer_taro_box",
        offerRevision: 1,
        shippingProfileId: "shipping_profile_japan",
        shippingProfileRevision: 1,
        consumptionPlanId: "consumption_plan_taro_box",
        consumptionPlanRevision: 1,
      },
      specification: {
        kind: "physical",
        weight: { grams: 1_240 },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 100,
        },
        countryOfOrigin: "JP",
        hsCode: "190531",
        description: "Six taro cookies in one retail box",
      },
    },
  ];
}

function shippingInventoryPositionCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "packaging",
): OpenCommerceInventoryPositionV1 {
  const inventoryItemId =
    kind === "cookie_box"
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton";
  return {
    schemaVersion: "commerce.open-inventory-position.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: `shipping_position_${kind}`,
    requestedAt: NOW,
    inventoryPositionId: `position_${kind}_tokyo`,
    inventoryItemId,
    inventoryItemRevision: 1,
    locationId: "location_tokyo_fulfillment",
    locationRevision: 1,
  };
}

function shippingReceiptCommand(
  expectedMerchantRevision: number,
  kind: "cookie_box" | "packaging",
): ReceiveCommerceInventoryV3 {
  const inventoryItemId =
    kind === "cookie_box"
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton";
  const lot =
    kind === "cookie_box"
      ? {
          kind: "tracked" as const,
          lotId: "lot_cookie_box_tokyo",
          lotCode: "COOKIE-BOX-20260814-A",
          expiry: {
            kind: "expires" as const,
            expiresAt: "2026-08-21T00:00:00.000Z",
          },
        }
      : { kind: "not_tracked" as const };
  return {
    schemaVersion: "commerce.receive-inventory.v3",
    purchase: { kind: "unlinked" },
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: `shipping_receipt_${kind}`,
    requestedAt: NOW,
    receiptId: "receipt_shipping_opening_stock",
    receiptLineId: `receipt_line_${kind}`,
    inventoryItemId,
    inventoryItemRevision: 1,
    inventoryPositionId: `position_${kind}_tokyo`,
    inventoryPositionRevision: 1,
    locationId: "location_tokyo_fulfillment",
    receivedQuantity: { amount: 10, scale: 0, unit: "each" },
    lot,
    receivedAt: NOW,
  };
}

function shippingBuyerCheckoutCommand(
  postalCode: string,
  acceptance: CommerceBuyerShippingAddressAcceptanceV1 = TEST_ADDRESS_ACCEPTANCE,
  addressLine1 = "1 Raffles Quay",
) {
  return {
    schemaVersion: "commerce.create-buyer-shipping-checkout.v1" as const,
    idempotencyKey: "shipping_checkout_sg",
    buyer: TEST_GUEST_BUYER,
    lines: [{ variantId: "variant_cookie_box_6", quantity: 1 as const }],
    shippingServiceCode: "ems_test",
    shippingDestination: {
      kind: "provided_address" as const,
      address: {
        countryCode: "SG" as const,
        recipientName: "Nuki Demo Buyer",
        addressLine1,
        locality: "Singapore" as const,
        postalCode,
      },
      acceptance,
    },
  };
}

function cafeStorefrontCommand(expectedMerchantRevision: number) {
  return {
    schemaVersion: "commerce.configure-pickup-storefront.v1" as const,
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_storefront",
    requestedAt: NOW,
    location: {
      id: "location_cafe",
      revision: 1,
      name: "Cafe",
      kind: "store" as const,
      lifecycle: { state: "active" as const, activeAt: NOW },
      occurredAt: NOW,
    },
    salesChannel: {
      id: "channel_cafe",
      revision: 1,
      name: "Cafe storefront",
      kind: "online" as const,
      lifecycle: { state: "active" as const, activeAt: NOW },
      occurredAt: NOW,
    },
    product: {
      id: "product_cookie",
      revision: 1,
      title: "Cookie",
      description: "One cookie.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active" as const,
      occurredAt: NOW,
    },
    variant: {
      id: "variant_cookie",
      revision: 1,
      productId: "product_cookie",
      sku: "COOKIE",
      title: "Cookie",
      options: [],
      media: [],
      barcode: null,
      status: "active" as const,
      occurredAt: NOW,
    },
    offer: {
      id: "offer_cookie",
      revision: 1,
      variantId: "variant_cookie",
      salesChannelId: "channel_cafe",
      price: { amountMinor: 450, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" as const },
      lifecycle: { state: "listed" as const, listedAt: NOW },
      occurredAt: NOW,
    },
    storefront: {
      storefrontId: "storefront_cafe",
      revision: 1,
      name: "Cafe storefront",
      salesChannelId: "channel_cafe",
      fulfillment: {
        kind: "pickup" as const,
        locationId: "location_cafe",
        readyLeadTimeSeconds: 900,
      },
      checkout: {
        quoteTtlSeconds: 600,
        tax: { kind: "percentage" as const, basisPoints: 1_000 },
      },
      lifecycle: { state: "active" as const, activeAt: NOW },
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_cookie",
      variantId: "variant_cookie",
      revision: 1,
      scope: { kind: "location" as const, locationId: "location_cafe" },
      mode: {
        kind: "direct" as const,
        components: [
          {
            inventoryItemId: "inventory_oat_milk",
            quantity: { amount: 100, scale: 0, unit: "milliliter" as const },
          },
        ],
        commitOn: "fulfillment_completed" as const,
      },
      lifecycle: "active" as const,
    },
  };
}

function cafeInventoryPositionCommand(
  expectedMerchantRevision: number,
): OpenCommerceInventoryPositionV1 {
  return {
    schemaVersion: "commerce.open-inventory-position.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_oat_milk_position",
    requestedAt: NOW,
    inventoryPositionId: "position_oat_cafe",
    inventoryItemId: "inventory_oat_milk",
    inventoryItemRevision: 1,
    locationId: "location_cafe",
    locationRevision: 1,
  };
}

function cafePreparationStationCommand(
  expectedMerchantRevision: number,
): CreatePreparationStationCommand {
  return {
    schemaVersion: "commerce.create-preparation-station.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_station",
    requestedAt: NOW,
    station: {
      stationId: "station_bar",
      locationId: "location_cafe",
      name: "Cafe Bar",
    },
  };
}

function cafeModifierGroupCommand(
  expectedMerchantRevision: number,
): CreateModifierGroupRevisionCommand {
  return {
    schemaVersion: "commerce.create-modifier-group-revision.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_milk_modifier",
    requestedAt: NOW,
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
              kind: "add",
              inventoryItemId: "inventory_oat_milk",
              quantity: { amount: 300, scale: 0, unit: "milliliter" },
            },
          ],
        },
      ],
    },
  };
}

function cafeRecipeCommand(
  expectedMerchantRevision: number,
): CreateRecipeRevisionCommand {
  return {
    schemaVersion: "commerce.create-recipe-revision.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_latte_recipe",
    requestedAt: NOW,
    recipeRevision: {
      recipeId: "recipe_latte_large",
      name: "Large latte",
      inputs: [
        {
          inventoryItemId: "inventory_oat_milk",
          quantity: { amount: 300, scale: 0, unit: "milliliter" },
        },
      ],
      output: { kind: "immediate" },
    },
  };
}

function cafeStockPolicyCommand(
  expectedMerchantRevision: number,
): ConfigureStockPolicyCommand {
  return {
    schemaVersion: "commerce.configure-stock-policy.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_oat_stock_policy",
    requestedAt: NOW,
    stockPolicy: {
      stockPolicyId: "stock_policy_oat_milk_cafe",
      inventoryItemId: "inventory_oat_milk",
      locationId: "location_cafe",
      replenishment: {
        kind: "threshold",
        reorderPoint: { amount: 1_000, scale: 0, unit: "milliliter" },
        targetQuantity: { amount: 2_000, scale: 0, unit: "milliliter" },
      },
    },
  };
}

function cafeMenuCommand(expectedMerchantRevision: number): PublishMenuCommand {
  return {
    schemaVersion: "commerce.publish-menu.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "cafe_main_menu",
    requestedAt: NOW,
    menu: {
      menuId: "menu_cafe_main",
      name: "Cafe main menu",
      salesChannelId: "channel_cafe",
      scope: { kind: "location", locationId: "location_cafe" },
      validity: { kind: "always" },
      sections: [{ sectionId: "section_drinks", name: "Drinks", position: 0 }],
      entries: [
        {
          menuEntryId: "menu_entry_cookie",
          sectionId: "section_drinks",
          offerId: "offer_cookie",
          offerRevision: 1,
          consumptionPlanId: "consumption_plan_cookie",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [
            { modifierGroupId: "modifier_group_milk", revision: 1 },
          ],
        },
      ],
    },
  };
}

function observationKind(observation: Readonly<{ kind: string }>): string {
  return observation.kind;
}

function findDelivery<T extends Readonly<{ deliveryId: string }>>(
  deliveries: readonly T[],
  deliveryId: string,
): T | undefined {
  for (const delivery of deliveries) {
    if (delivery.deliveryId === deliveryId) return delivery;
  }
  return undefined;
}

function matchaBoxItemCommand(
  expectedMerchantRevision: number,
): CreateCommerceInventoryItemV1 {
  return {
    schemaVersion: "commerce.create-inventory-item.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "matcha_box_item",
    requestedAt: NOW,
    inventoryItemId: "inventory_matcha_box_6",
    merchantCode: "MATCHA-BOX-6",
    name: "Matcha cookie box",
    baseUnit: "each",
    category: "finished_good",
    tracking: { kind: "lot_tracked", expiry: "required" },
  };
}

function matchaChannelListingCommand(
  expectedMerchantRevision: number,
  includeSpecification: boolean,
): PlaceCommerceChannelListingV1 {
  return {
    schemaVersion: "commerce.place-channel-listing.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: `matcha_channel_listing_${includeSpecification ? "with_spec" : "without_spec"}`,
    requestedAt: NOW,
    salesChannelId: "channel_cookie_store_sg",
    catalog: {
      kind: "new_product",
      product: {
        id: "product_matcha_box",
        revision: 1,
        title: "Matcha cookie box",
        description: "Six matcha cookies shipped from Japan.",
        handle: null,
        productType: "",
        vendor: "",
        tags: [],
        status: "active",
        occurredAt: NOW,
      },
      variant: {
        id: "variant_matcha_box_6",
        revision: 1,
        productId: "product_matcha_box",
        sku: "MATCHA-BOX-6-SG",
        title: "Box of six",
        options: [],
        media: [],
        barcode: null,
        status: "active",
        occurredAt: NOW,
      },
      consumptionPlan: {
        consumptionPlanId: "consumption_plan_matcha_box_sg",
        variantId: "variant_matcha_box_6",
        revision: 1,
        scope: { kind: "location", locationId: "location_tokyo_fulfillment" },
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: "inventory_matcha_box_6",
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
    },
    offer: {
      id: "offer_matcha_box_sg",
      revision: 1,
      variantId: "variant_matcha_box_6",
      salesChannelId: "channel_cookie_store_sg",
      price: { amountMinor: 4_200, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: NOW },
      occurredAt: NOW,
    },
    ...(includeSpecification
      ? {
          shippingSpecification: {
            variantId: "variant_matcha_box_6",
            variantRevision: 1,
            shippingProfileId: "shipping_profile_jp_sg",
            shippingProfileRevision: 1,
            eligibility: {
              kind: "physical",
              weight: { grams: 1_210 },
              dimensions: {
                lengthMillimeters: 280,
                widthMillimeters: 220,
                heightMillimeters: 100,
              },
              countryOfOrigin: "JP",
              hsCode: "190531",
              description: "Six matcha cookies in one retail box",
            },
          },
        }
      : {}),
  };
}

function existingMatchaPlacementCommand(
  expectedMerchantRevision: number,
  salesChannelId: string,
  offerId: string,
  identity: string,
  shippingSpecification?: PlaceCommerceChannelListingV1["shippingSpecification"],
): PlaceCommerceChannelListingV1 {
  return {
    schemaVersion: "commerce.place-channel-listing.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: `matcha_existing_placement_${identity}`,
    requestedAt: NOW,
    salesChannelId,
    catalog: {
      kind: "existing_variant",
      variantId: "variant_matcha_box_6",
      variantRevision: 1,
    },
    offer: {
      id: offerId,
      revision: 1,
      variantId: "variant_matcha_box_6",
      salesChannelId,
      price: { amountMinor: 4_200, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: NOW },
      occurredAt: NOW,
    },
    ...(shippingSpecification === undefined ? {} : { shippingSpecification }),
  };
}

function giftTinCatalogCommand(
  expectedMerchantRevision: number,
): PrepareCommerceCatalogListingV1 {
  return {
    schemaVersion: "commerce.prepare-catalog-listing.v1",
    merchantId: "merchant_demo",
    expectedMerchantRevision,
    idempotencyKey: "gift_tin_catalog",
    requestedAt: NOW,
    salesChannel: {
      id: "channel_online",
      revision: 1,
      name: "Online Store",
      kind: "online",
      lifecycle: { state: "active", activeAt: NOW },
      occurredAt: NOW,
    },
    product: {
      id: "product_gift_tin",
      revision: 1,
      title: "Gift tin",
      description: "Empty keepsake tin.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: NOW,
    },
    variant: {
      id: "variant_gift_tin",
      revision: 1,
      productId: "product_gift_tin",
      sku: "GIFT-TIN",
      title: "Gift tin",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: NOW,
    },
    offer: {
      id: "offer_gift_tin",
      revision: 1,
      variantId: "variant_gift_tin",
      salesChannelId: "channel_online",
      price: { amountMinor: 900, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: NOW },
      occurredAt: NOW,
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_gift_tin",
      variantId: "variant_gift_tin",
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  };
}

function flavoredBuyerCheckoutCommand(
  idempotencyKey: string,
  variantId: string,
  quantity: number,
  acceptance: CommerceBuyerShippingAddressAcceptanceV1,
  shippingServiceCode = "ems_test",
) {
  return {
    schemaVersion: "commerce.create-buyer-shipping-checkout.v1" as const,
    idempotencyKey,
    buyer: TEST_GUEST_BUYER,
    lines: [{ variantId, quantity }],
    shippingServiceCode,
    shippingDestination: {
      kind: "provided_address" as const,
      address: {
        countryCode: "SG" as const,
        recipientName: "Nuki Demo Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore" as const,
        postalCode: "018956",
      },
      acceptance,
    },
  };
}

function flavoredBuyerMultiLineCheckoutCommand(
  acceptance: CommerceBuyerShippingAddressAcceptanceV1,
) {
  return {
    schemaVersion: "commerce.create-buyer-shipping-checkout.v1" as const,
    idempotencyKey: "flavored_multi_line_checkout",
    buyer: TEST_GUEST_BUYER,
    lines: [
      { variantId: "variant_matcha_box_6", quantity: 1 },
      { variantId: "variant_taro_box_6", quantity: 1 },
    ],
    shippingServiceCode: "ems_test",
    shippingDestination: {
      kind: "provided_address" as const,
      address: {
        countryCode: "SG" as const,
        recipientName: "Nuki Demo Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore" as const,
        postalCode: "018956",
      },
      acceptance,
    },
  };
}

function flavoredBuyerMultiLineRefreshCommand(
  checkout: Readonly<{
    revision: number;
    quote: Readonly<{ quoteDigest: string }>;
  }>,
  acceptance: CommerceBuyerShippingAddressAcceptanceV1,
) {
  return {
    schemaVersion: "commerce.refresh-buyer-shipping-checkout.v1" as const,
    idempotencyKey: "flavored_multi_line_refresh",
    checkoutRevision: checkout.revision,
    quoteDigest: checkout.quote.quoteDigest,
    lines: [
      { variantId: "variant_matcha_box_6", quantity: 2 },
      { variantId: "variant_taro_box_6", quantity: 1 },
    ],
    shippingServiceCode: "ems_test",
    shippingDestination: {
      kind: "provided_address" as const,
      address: {
        countryCode: "SG" as const,
        recipientName: "Nuki Demo Buyer",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore" as const,
        postalCode: "018956",
      },
      acceptance,
    },
  };
}

function temporaryDatabasePath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomUUID()}.sqlite3`);
}

function removeDatabase(databasePath: string): void {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
}

function fixedNow(): string {
  return NOW;
}

function readAddressValidationTestTime(): string {
  return addressValidationTestTime;
}
