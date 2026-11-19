import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { CheckoutProfileConfiguration } from "@purin-labs/commerce-contracts";

import { CheckoutProfileService } from "../src/checkout-profile-service.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const CREATED_AT = "2026-08-29T10:00:00.000Z";
const UPDATED_AT = "2026-08-29T10:05:00.000Z";
const PUBLISHED_AT = "2026-08-29T10:10:00.000Z";
const ACTIVATED_AT = "2026-08-29T10:15:00.000Z";
const RETIRED_AT = "2026-08-29T10:20:00.000Z";
const databasePaths: string[] = [];

describe("checkout profile service", checkoutProfileServiceTests);
afterEach(removeTemporaryDatabases);

function checkoutProfileServiceTests(): void {
  it(
    "rejects stale revisions and lifecycle escapes",
    rejectsStaleProfileMutation,
  );
}

function rejectsStaleProfileMutation(): void {
  const fixture = createFixture();
  try {
    fixture.service.createDraft(createDraft("checkout_profile_pickup"));
    fixture.service.replaceDraft({
      merchantId: "merchant_cafe",
      checkoutProfileId: "checkout_profile_pickup",
      expectedRevision: 1,
      name: "Pickup checkout",
      configuration: profileConfiguration("pickup_only"),
      updatedAt: UPDATED_AT,
    });
    // A storefront cannot take a draft that nobody has published.
    expect(
      fixture.service.activate({
        merchantId: "merchant_cafe",
        storefrontId: "storefront_online",
        checkoutProfileId: "checkout_profile_pickup",
        checkoutProfileRevision: 2,
        activatedAt: ACTIVATED_AT,
        activatedBy: "operator_owner",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_lifecycle",
        requiredState: "published",
        actualState: "draft",
      },
    });
    expect(
      fixture.service.publish({
        merchantId: "merchant_cafe",
        checkoutProfileId: "checkout_profile_pickup",
        expectedRevision: 1,
        publishedAt: PUBLISHED_AT,
        publishedBy: "operator_owner",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        expectedRevision: 1,
        actualRevision: 2,
      },
    });
    fixture.service.publish({
      merchantId: "merchant_cafe",
      checkoutProfileId: "checkout_profile_pickup",
      expectedRevision: 2,
      publishedAt: PUBLISHED_AT,
      publishedBy: "operator_owner",
    });
    fixture.service.activate({
      merchantId: "merchant_cafe",
      storefrontId: "storefront_online",
      checkoutProfileId: "checkout_profile_pickup",
      checkoutProfileRevision: 2,
      activatedAt: ACTIVATED_AT,
      activatedBy: "operator_owner",
    });
    expect(
      fixture.service.retire({
        merchantId: "merchant_cafe",
        checkoutProfileId: "checkout_profile_pickup",
        expectedRevision: 2,
        retiredAt: RETIRED_AT,
        retiredBy: "operator_owner",
      }),
    ).toEqual({
      ok: false,
      error: { code: "profile_active", storefrontId: "storefront_online" },
    });
    expect(
      fixture.service.replaceDraft({
        merchantId: "merchant_cafe",
        checkoutProfileId: "checkout_profile_pickup",
        expectedRevision: 2,
        name: "Changed published checkout",
        configuration: profileConfiguration("pickup_only"),
        updatedAt: RETIRED_AT,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid_lifecycle",
        requiredState: "draft",
        actualState: "published",
      },
    });

    fixture.service.createDraft(createDraft("checkout_profile_replacement"));
    fixture.service.publish({
      merchantId: "merchant_cafe",
      checkoutProfileId: "checkout_profile_replacement",
      expectedRevision: 1,
      publishedAt: PUBLISHED_AT,
      publishedBy: "operator_owner",
    });
    fixture.service.activate({
      merchantId: "merchant_cafe",
      storefrontId: "storefront_online",
      checkoutProfileId: "checkout_profile_replacement",
      checkoutProfileRevision: 1,
      activatedAt: RETIRED_AT,
      activatedBy: "operator_owner",
    });
    expect(
      fixture.service.retire({
        merchantId: "merchant_cafe",
        checkoutProfileId: "checkout_profile_pickup",
        expectedRevision: 2,
        retiredAt: RETIRED_AT,
        retiredBy: "operator_owner",
      }),
    ).toMatchObject({ ok: true, value: { lifecycle: { state: "retired" } } });
  } finally {
    fixture.close();
  }
}

function createDraft(checkoutProfileId: string) {
  return {
    merchantId: "merchant_cafe",
    checkoutProfileId,
    name: "Cafe checkout",
    configuration: profileConfiguration("buyer_choice"),
    createdAt: CREATED_AT,
  };
}

function profileConfiguration(
  fulfillment: "pickup_only" | "buyer_choice",
): CheckoutProfileConfiguration {
  return {
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
      salesChannelId: "sales_channel_online",
    },
    fulfillmentPolicy: fulfillmentPolicy(fulfillment),
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
      locale: "ja-JP",
      merchantDisplayName: "Cafe",
      termsPolicyId: "terms_policy_cafe",
      privacyPolicyId: "privacy_policy_cafe",
      supportContact: "support@example.com",
    },
  };
}

function fulfillmentPolicy(
  fulfillment: "pickup_only" | "buyer_choice",
): CheckoutProfileConfiguration["fulfillmentPolicy"] {
  switch (fulfillment) {
    case "pickup_only":
      return { kind: fulfillment, pickupPolicyId: "pickup_policy_cafe" };
    case "buyer_choice":
      return {
        kind: fulfillment,
        pickupPolicyId: "pickup_policy_cafe",
        shippingPolicyId: "shipping_policy_domestic",
      };
  }
}

function createFixture(): Readonly<{
  database: NodeCommerceDatabase;
  service: CheckoutProfileService;
  close: () => void;
}> {
  const databasePath = join(
    tmpdir(),
    `underclerk-checkout-profile-${randomUUID()}.sqlite3`,
  );
  databasePaths.push(databasePath);
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, CREATED_AT);
  seedMerchantStorefront(database);
  return {
    database,
    service: new CheckoutProfileService(database),
    close: database.close.bind(database),
  };
}

function seedMerchantStorefront(database: NodeCommerceDatabase): void {
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    )
    .run("merchant_cafe", "organisation_cafe", CREATED_AT, CREATED_AT);
  database
    .prepare(
      `INSERT INTO sales_channel (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'active', ?, ?)`,
    )
    .run(
      "merchant_cafe",
      "sales_channel_online",
      "Online",
      JSON.stringify({ state: "active", activeAt: CREATED_AT }),
      CREATED_AT,
    );
  database
    .prepare(
      `INSERT INTO storefront (
       merchant_id, storefront_id, revision, name, sales_channel_id,
       fulfillment_kind, fulfillment_json, checkout_json,
       lifecycle_state, lifecycle_json
     ) VALUES (?, ?, 1, ?, ?, 'pickup', ?, ?, 'active', ?)`,
    )
    .run(
      "merchant_cafe",
      "storefront_online",
      "Online storefront",
      "sales_channel_online",
      JSON.stringify({
        kind: "pickup",
        locationId: "location_cafe",
        readyLeadTimeSeconds: 900,
      }),
      JSON.stringify({
        quoteTtlSeconds: 900,
        tax: { kind: "percentage", basisPoints: 1_000 },
      }),
      JSON.stringify({ state: "active", activeAt: CREATED_AT }),
    );
}

function removeTemporaryDatabases(): void {
  while (databasePaths.length > 0) {
    const databasePath = databasePaths.pop();
    if (databasePath === undefined) continue;
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  }
}
