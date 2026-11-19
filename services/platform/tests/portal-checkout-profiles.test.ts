import type { CheckoutProfileConfiguration } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import {
  activateCheckoutProfile,
  createCheckoutProfileDraft,
  readCheckoutProfiles,
  type CheckoutProfileMutationTransport,
  type CheckoutProfileReadTransport,
  type DraftCheckoutProfileSummary,
  type PublishedCheckoutProfileSummary,
} from "../../../apps/portal/src/features/checkout-profiles/api";

const CONFIGURATION: CheckoutProfileConfiguration = {
  currencyPolicy: { kind: "fixed", currency: "JPY" },
  buyerPolicy: {
    kind: "guest_or_account",
    requiredContact: "email_required_phone_optional",
    savedAddressPolicy: "enabled",
  },
  cartPolicy: {
    kind: "single_fulfillment",
    minimumLines: 1,
    maximumLines: 20,
    maximumTotalQuantity: 50,
  },
  pricingPolicy: {
    kind: "published_offers",
    salesChannelId: "sales_channel_web",
  },
  fulfillmentPolicy: {
    kind: "shipping_only",
    shippingPolicyId: "shipping_domestic",
  },
  taxPolicy: { kind: "merchant_inclusive", jurisdictionPolicyId: "tax_japan" },
  paymentPolicy: {
    kind: "external_provider",
    paymentProviderBindingId: "payment_binding_square",
  },
  afterSalePolicy: {
    cancellationPolicyId: "cancellation_standard",
    refundPolicyId: "refunds_standard",
    refundGovernance: { kind: "approval_required" },
  },
  presentationPolicy: {
    locale: "ja-JP",
    merchantDisplayName: "Cafe Central",
    termsPolicyId: "terms_standard",
    privacyPolicyId: "privacy_standard",
    supportContact: "support@example.test",
  },
};

const DIGEST = "a".repeat(64);

describe("Portal checkout-profile boundary", () => {
  it("parses exact profile and storefront activation collections", async () => {
    const read: CheckoutProfileReadTransport = async (path) => {
      expect(path).toBe(
        "/v1/control/organisations/organisation_cafe/commerce/checkout-profiles",
      );
      return profileCollectionResponse();
    };
    const collection = await readCheckoutProfiles("organisation_cafe", read);
    expect(collection.profiles[0]).toMatchObject({
      profile: {
        checkoutProfileId: "checkout_domestic",
        revision: 2,
      },
      configurationDigest: DIGEST,
    });
    expect(collection.activations[0]).toMatchObject({
      storefrontId: "storefront_web",
      checkoutProfileId: "checkout_domestic",
      checkoutProfileRevision: 2,
    });
    expect(collection.storefrontIds).toEqual([
      "storefront_new",
      "storefront_web",
    ]);
  });

  it("rejects unknown collection fields", async () => {
    const read: CheckoutProfileReadTransport = async () => ({
      ...profileCollectionResponse(),
      merchantSecret: "must-not-cross-boundary",
    });
    await expect(
      readCheckoutProfiles("organisation_cafe", read),
    ).rejects.toThrow("checkout profile response fields are invalid");
  });

  it("binds activation mutations to the exact source revision", async () => {
    const requests: Array<
      Readonly<{ path: string; method: string; body: unknown }>
    > = [];
    const mutate: CheckoutProfileMutationTransport = async (
      path,
      method,
      body,
    ) => {
      requests.push({ path, method, body });
      return {
        ok: true,
        active: {
          activation: activation(),
          profile: profile(),
          configurationDigest: DIGEST,
        },
      };
    };
    const source = { profile: profile(), configurationDigest: DIGEST };
    const result = await activateCheckoutProfile(
      "organisation_cafe",
      "storefront_web",
      source,
      mutate,
    );
    expect(result.activation.storefrontId).toBe("storefront_web");
    expect(requests).toEqual([
      {
        path: "/v1/control/organisations/organisation_cafe/commerce/storefronts/storefront_web/checkout-profile-activation",
        method: "PUT",
        body: {
          checkoutProfileId: "checkout_domestic",
          checkoutProfileRevision: 2,
        },
      },
    ]);
  });

  it("copies a selected published profile into a new draft", async () => {
    const requests: Array<
      Readonly<{ path: string; method: string; body: unknown; intent: string }>
    > = [];
    const mutate: CheckoutProfileMutationTransport = async (
      path,
      method,
      body,
      intent,
    ) => {
      requests.push({ path, method, body, intent });
      return {
        ok: true,
        profile: { profile: draftProfile(), configurationDigest: DIGEST },
      };
    };
    const source = { profile: profile(), configurationDigest: DIGEST };
    await createCheckoutProfileDraft(
      "organisation_cafe",
      source,
      {
        checkoutProfileId: "checkout_replacement",
        name: "Replacement checkout",
      },
      mutate,
    );
    expect(requests).toEqual([
      {
        path: "/v1/control/organisations/organisation_cafe/commerce/checkout-profiles",
        method: "POST",
        body: {
          checkoutProfileId: "checkout_replacement",
          name: "Replacement checkout",
          configuration: CONFIGURATION,
        },
        intent:
          "checkout-profile-create:checkout_domestic:2:checkout_replacement",
      },
    ]);
  });
});

function profileCollectionResponse(): Readonly<Record<string, unknown>> {
  return {
    ok: true,
    profiles: [{ profile: profile(), configurationDigest: DIGEST }],
    activations: [activation()],
    storefrontIds: ["storefront_web", "storefront_new"],
  };
}

function profile(): PublishedCheckoutProfileSummary["profile"] {
  return {
    checkoutProfileId: "checkout_domestic",
    merchantId: "merchant_cafe",
    revision: 2,
    name: "Domestic delivery",
    configuration: CONFIGURATION,
    lifecycle: {
      state: "published",
      publishedAt: "2026-08-29T11:00:00.000Z",
      publishedBy: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    },
  };
}

function draftProfile(): DraftCheckoutProfileSummary["profile"] {
  return {
    checkoutProfileId: "checkout_replacement",
    merchantId: "merchant_cafe",
    revision: 1,
    name: "Replacement checkout",
    configuration: CONFIGURATION,
    lifecycle: {
      state: "draft",
      createdAt: "2026-08-29T11:00:00.000Z",
      updatedAt: "2026-08-29T11:00:00.000Z",
    },
  };
}

function activation(): Readonly<Record<string, unknown>> {
  return {
    merchantId: "merchant_cafe",
    storefrontId: "storefront_web",
    checkoutProfileId: "checkout_domestic",
    checkoutProfileRevision: 2,
    activatedAt: "2026-08-29T11:05:00.000Z",
    activatedBy: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
  };
}
