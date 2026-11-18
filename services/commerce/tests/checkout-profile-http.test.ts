import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CheckoutProfileConfiguration,
  OnlinePaymentBinding,
} from "@seams/commerce-contracts";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import type {
  MerchantPaymentRefundCommand,
  MerchantPaymentReconciliationCommand,
  MerchantPaymentSessionCommand,
  PaymentGateway,
  PaymentRefundGateway,
} from "../src/payments/provider.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const NOW = "2026-08-29T11:00:00.000Z";
const SERVICE_TOKEN = "checkout_profile_http_service_token";
const PROFILE_ID = "checkout_profile_domestic";
const REPLACEMENT_PROFILE_ID = "checkout_profile_replacement";

it(
  "runs the merchant checkout-profile lifecycle through the public admin API",
  merchantProfileApiLifecycle,
);

async function merchantProfileApiLifecycle(): Promise<void> {
  const fixture = createFixture();
  try {
    const unauthorized = await fixture.api.fetch(
      "https://underclerk.test/v1/admin/merchants/merchant_cafe/checkout-profiles",
    );
    expect(unauthorized.status).toBe(401);

    const created = await profileRequest(
      fixture.api,
      "/v1/admin/merchants/merchant_cafe/checkout-profiles",
      "POST",
      {
        schemaVersion: "underclerk.create-checkout-profile-draft.v1",
        merchantId: "merchant_cafe",
        checkoutProfileId: PROFILE_ID,
        name: "Domestic checkout",
        configuration: profileConfiguration(),
        createdAt: NOW,
      },
    );
    expect(created).toMatchObject({
      status: 200,
      body: { revision: 1, lifecycle: { state: "draft" } },
    });

    const replaced = await profileRequest(
      fixture.api,
      `/v1/admin/merchants/merchant_cafe/checkout-profiles/${PROFILE_ID}/draft`,
      "PUT",
      {
        schemaVersion: "underclerk.replace-checkout-profile-draft.v1",
        merchantId: "merchant_cafe",
        checkoutProfileId: PROFILE_ID,
        expectedRevision: 1,
        name: "Domestic and pickup checkout",
        configuration: profileConfiguration(),
        updatedAt: "2026-08-29T11:05:00.000Z",
      },
    );
    expect(replaced).toMatchObject({ status: 200, body: { revision: 2 } });

    const published = await profileRequest(
      fixture.api,
      `/v1/admin/merchants/merchant_cafe/checkout-profiles/${PROFILE_ID}/publication`,
      "POST",
      {
        schemaVersion: "underclerk.publish-checkout-profile.v1",
        merchantId: "merchant_cafe",
        checkoutProfileId: PROFILE_ID,
        expectedRevision: 2,
        publishedAt: "2026-08-29T11:10:00.000Z",
        publishedBy: "operator_owner",
      },
    );
    expect(published).toMatchObject({
      status: 200,
      body: { lifecycle: { state: "published" } },
    });

    const activated = await profileRequest(
      fixture.api,
      "/v1/admin/merchants/merchant_cafe/storefronts/storefront_online/checkout-profile-activation",
      "PUT",
      {
        schemaVersion: "underclerk.activate-checkout-profile.v1",
        merchantId: "merchant_cafe",
        storefrontId: "storefront_online",
        checkoutProfileId: PROFILE_ID,
        checkoutProfileRevision: 2,
        activatedAt: "2026-08-29T11:15:00.000Z",
        activatedBy: "operator_owner",
      },
    );
    expect(activated).toMatchObject({
      status: 200,
      body: {
        activation: {
          checkoutProfileId: PROFILE_ID,
          checkoutProfileRevision: 2,
        },
        profile: { revision: 2 },
      },
    });
    const originalSession = await fixture.storefrontClient.createSession(
      "merchant_cafe",
      "storefront_online",
      {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    expect(originalSession).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "underclerk.buyer-session.v4",
        buyer: { kind: "guest" },
        checkoutProfile: { checkoutProfileId: PROFILE_ID, revision: 2 },
        checkoutProfileConfiguration: profileConfiguration(),
      },
    });
    if (!originalSession.ok)
      throw new Error("Original buyer session was unavailable");

    const profile = await profileRequest(
      fixture.api,
      `/v1/admin/merchants/merchant_cafe/checkout-profiles/${PROFILE_ID}/revisions/2`,
      "GET",
    );
    expect(profile).toMatchObject({
      status: 200,
      body: { checkoutProfileId: PROFILE_ID, revision: 2 },
    });
    const active = await profileRequest(
      fixture.api,
      "/v1/admin/merchants/merchant_cafe/storefronts/storefront_online/checkout-profile-activation",
      "GET",
    );
    expect(active).toEqual(activated);
    const profiles = await profileRequest(
      fixture.api,
      "/v1/admin/merchants/merchant_cafe/checkout-profiles",
      "GET",
    );
    expect(profiles).toMatchObject({ status: 200, body: [{ revision: 2 }] });

    const mismatchedPath = await profileRequest(
      fixture.api,
      `/v1/admin/merchants/merchant_cafe/checkout-profiles/${PROFILE_ID}/publication`,
      "POST",
      {
        schemaVersion: "underclerk.publish-checkout-profile.v1",
        merchantId: "merchant_cafe",
        checkoutProfileId: "checkout_profile_other",
        expectedRevision: 1,
        publishedAt: "2026-08-29T11:16:00.000Z",
        publishedBy: "operator_owner",
      },
    );
    expect(mismatchedPath.status).toBe(400);

    const replacementCreated = await profileRequest(
      fixture.api,
      "/v1/admin/merchants/merchant_cafe/checkout-profiles",
      "POST",
      {
        schemaVersion: "underclerk.create-checkout-profile-draft.v1",
        merchantId: "merchant_cafe",
        checkoutProfileId: REPLACEMENT_PROFILE_ID,
        name: "Replacement checkout",
        configuration: replacementProfileConfiguration(),
        createdAt: "2026-08-29T11:20:00.000Z",
      },
    );
    expect(replacementCreated).toMatchObject({
      status: 200,
      body: { checkoutProfileId: REPLACEMENT_PROFILE_ID, revision: 1 },
    });

    const publishedReplacement = await fixture.client.publishCheckoutProfile({
      schemaVersion: "underclerk.publish-checkout-profile.v1",
      merchantId: "merchant_cafe",
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      expectedRevision: 1,
      publishedAt: "2026-08-29T11:25:00.000Z",
      publishedBy: "operator_owner",
    });
    expect(publishedReplacement).toMatchObject({
      ok: true,
      value: { lifecycle: { state: "published" } },
    });

    const activatedReplacement = await fixture.client.activateCheckoutProfile({
      schemaVersion: "underclerk.activate-checkout-profile.v1",
      merchantId: "merchant_cafe",
      storefrontId: "storefront_online",
      checkoutProfileId: REPLACEMENT_PROFILE_ID,
      checkoutProfileRevision: 1,
      activatedAt: "2026-08-29T11:30:00.000Z",
      activatedBy: "operator_owner",
    });
    expect(activatedReplacement).toMatchObject({
      ok: true,
      value: { activation: { checkoutProfileId: REPLACEMENT_PROFILE_ID } },
    });
    const replacementSession = await fixture.storefrontClient.createSession(
      "merchant_cafe",
      "storefront_online",
      {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "guest" },
      },
    );
    expect(replacementSession).toMatchObject({
      ok: true,
      value: {
        checkoutProfile: {
          checkoutProfileId: REPLACEMENT_PROFILE_ID,
          revision: 1,
        },
        checkoutProfileConfiguration: replacementProfileConfiguration(),
      },
    });
    expect(
      await fixture.storefrontClient.readCatalog(
        "merchant_cafe",
        "storefront_online",
        originalSession.value.token,
      ),
    ).toMatchObject({ ok: true });

    const retired = await fixture.client.retireCheckoutProfile({
      schemaVersion: "underclerk.retire-checkout-profile.v1",
      merchantId: "merchant_cafe",
      checkoutProfileId: PROFILE_ID,
      expectedRevision: 2,
      retiredAt: "2026-08-29T11:35:00.000Z",
      retiredBy: "operator_owner",
    });
    expect(retired).toMatchObject({
      ok: true,
      value: { lifecycle: { state: "retired" } },
    });

    const clientProfile = await fixture.client.readCheckoutProfile(
      "merchant_cafe",
      PROFILE_ID,
      2,
    );
    expect(clientProfile).toEqual(retired);
    const clientProfiles =
      await fixture.client.listCheckoutProfiles("merchant_cafe");
    expect(clientProfiles).toMatchObject({
      ok: true,
      value: [{ revision: 2 }, { revision: 1 }],
    });
    const clientActivations =
      await fixture.client.listCheckoutProfileActivations("merchant_cafe");
    expect(clientActivations).toMatchObject({
      ok: true,
      value: [
        {
          storefrontId: "storefront_online",
          checkoutProfileId: REPLACEMENT_PROFILE_ID,
          checkoutProfileRevision: 1,
        },
      ],
    });
    const storefrontIds =
      await fixture.client.listStorefrontIds("merchant_cafe");
    expect(storefrontIds).toEqual({
      ok: true,
      value: ["storefront_new", "storefront_online"],
    });
    const clientActive = await fixture.client.readActiveCheckoutProfile(
      "merchant_cafe",
      "storefront_online",
    );
    expect(clientActive).toEqual(activatedReplacement);
  } finally {
    fixture.close();
  }
}

function profileConfiguration(): CheckoutProfileConfiguration {
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
      locale: "ja-JP",
      merchantDisplayName: "Cafe",
      termsPolicyId: "terms_policy_cafe",
      privacyPolicyId: "privacy_policy_cafe",
      supportContact: "support@example.com",
    },
  };
}

function replacementProfileConfiguration(): CheckoutProfileConfiguration {
  const configuration = profileConfiguration();
  return {
    ...configuration,
    presentationPolicy: {
      ...configuration.presentationPolicy,
      locale: "en-US",
      merchantDisplayName: "Replacement Cafe",
    },
  };
}

async function profileRequest(
  api: CommerceHttpApi,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await api.fetch(`https://underclerk.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function createFixture(): Readonly<{
  api: CommerceHttpApi;
  client: CommerceAdminClient;
  storefrontClient: CommerceStorefrontClient;
  close: () => void;
}> {
  const databasePath = join(
    tmpdir(),
    `underclerk-checkout-profile-http-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, NOW);
  seedMerchantStorefront(database);
  const authority = new CommerceAuthority({
    database,
    signer: new DigestSigner(),
    paymentGateway: new UnusedPaymentGateway(),
    now: currentTime,
    shippingGateway: createJapanShippingGateway(
      "checkout-profile-http-carrier-key",
    ),
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "checkout_profile_http_buyer_session_secret",
      now: currentTime,
    }),
    serviceToken: SERVICE_TOKEN,
  });
  return {
    api,
    client: new CommerceAdminClient({
      baseUrl: "https://underclerk.test",
      serviceToken: SERVICE_TOKEN,
      fetch: api.fetch.bind(api),
    }),
    storefrontClient: new CommerceStorefrontClient({
      baseUrl: "https://underclerk.test",
      fetch: api.fetch.bind(api),
    }),
    close: createFixtureCloser(authority, databasePath),
  };
}

function seedMerchantStorefront(database: NodeCommerceDatabase): void {
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    )
    .run("merchant_cafe", "organisation_cafe", NOW, NOW);
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
      JSON.stringify({ state: "active", activeAt: NOW }),
      NOW,
    );
  seedStorefront(database, "storefront_online", "Online storefront");
  seedStorefront(database, "storefront_new", "New storefront");
}

function seedStorefront(
  database: NodeCommerceDatabase,
  storefrontId: string,
  name: string,
): void {
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
      storefrontId,
      name,
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
      JSON.stringify({ state: "active", activeAt: NOW }),
    );
}

function createFixtureCloser(
  authority: CommerceAuthority,
  databasePath: string,
): () => void {
  return function closeFixture(): void {
    authority.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  };
}

function currentTime(): string {
  return NOW;
}

class DigestSigner implements CommerceSigner {
  readonly keyId = "checkout_profile_http_signer";
  readonly publicKeyB64 = Buffer.alloc(32, 9).toString("base64url");

  sign(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
  }
}

class UnusedPaymentGateway implements PaymentGateway, PaymentRefundGateway {
  async binding(
    _paymentProviderBindingId: string,
  ): Promise<OnlinePaymentBinding> {
    throw new Error("Payment gateway is unused in checkout-profile tests");
  }

  async createSession(_request: MerchantPaymentSessionCommand): Promise<never> {
    throw new Error("Payment gateway is unused in checkout-profile tests");
  }

  async reconcile(
    _request: MerchantPaymentReconciliationCommand,
  ): Promise<never> {
    throw new Error("Payment gateway is unused in checkout-profile tests");
  }

  async refund(_request: MerchantPaymentRefundCommand): Promise<never> {
    throw new Error("Payment gateway is unused in checkout-profile tests");
  }
}
