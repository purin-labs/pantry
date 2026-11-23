import { createMigratedDatabase } from "./sqlite-d1";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import type {
  CheckoutProfile,
  CheckoutProfileConfiguration,
} from "@purin-labs/commerce-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkoutControlMocks = vi.hoisted(() => ({
  authorizeOrganisationRequest: vi.fn(),
  readOrganisationEnvironment: vi.fn(),
  resolveUser: vi.fn(),
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
  readControlMutationReplay: vi.fn(),
  recordCommerceMutationReceipt: vi.fn(),
  listCheckoutProfiles: vi.fn(),
  listCheckoutProfileActivations: vi.fn(),
  listStorefrontIds: vi.fn(),
  readCheckoutProfile: vi.fn(),
  activateCheckoutProfile: vi.fn(),
  listPaymentAccounts: vi.fn(),
}));

vi.mock("@purin-labs/control/worker/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/control/worker/authorization")>()),
  authorizeOrganisationRequest:
    checkoutControlMocks.authorizeOrganisationRequest,
}));
vi.mock("@purin-labs/agent/control/organisation-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/agent/control/organisation-runtime")
  >()),
  readOrganisationEnvironment: checkoutControlMocks.readOrganisationEnvironment,
}));
vi.mock("@purin-labs/connections/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/connections/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    checkoutControlMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  resolveUser: checkoutControlMocks.resolveUser,
}));
vi.mock("@purin-labs/tenancy/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-mutation")>()),
  readControlMutationReplay: checkoutControlMocks.readControlMutationReplay,
}));
vi.mock("@purin-labs/control/worker/mutation-receipt", () => ({
  recordCommerceMutationReceipt:
    checkoutControlMocks.recordCommerceMutationReceipt,
}));
vi.mock("@purin-labs/area-commerce/server/contract/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/area-commerce/server/contract/client")>()),
  createCommerceClient: vi.fn(() => ({
    listCheckoutProfiles: checkoutControlMocks.listCheckoutProfiles,
    listCheckoutProfileActivations:
      checkoutControlMocks.listCheckoutProfileActivations,
    listStorefrontIds: checkoutControlMocks.listStorefrontIds,
    readCheckoutProfile: checkoutControlMocks.readCheckoutProfile,
    activateCheckoutProfile: checkoutControlMocks.activateCheckoutProfile,
    listPaymentAccounts: checkoutControlMocks.listPaymentAccounts,
  })),
}));

import { handleControlRequest } from "../src/control-router";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_checkout_control";
const PROFILE_ID = "checkout_domestic";
const STOREFRONT_ID = "storefront_web";

describe("checkout profile control routes", () => {
  beforeEach(configureCheckoutControlMocks);

  it("rejects activation when the binding's payment account is not active", async () => {
    checkoutControlMocks.listPaymentAccounts.mockResolvedValue(
      paymentAccounts("restricted"),
    );
    const response = await handleControlRequest(
      activationRequest(),
      checkoutControlEnv(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "checkout_payment_account_inactive",
    });
    expect(checkoutControlMocks.activateCheckoutProfile).not.toHaveBeenCalled();
  });

  it("rejects mixed activation fields before calling Commerce", async () => {
    const response = await handleControlRequest(
      new Request(
        `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/storefronts/${STOREFRONT_ID}/checkout-profile-activation`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkoutProfileId: PROFILE_ID,
            checkoutProfileRevision: 2,
            providerToken: "must-not-cross-boundary",
          }),
        },
      ),
      checkoutControlEnv(),
    );
    expect(response.status).toBe(422);
    expect(checkoutControlMocks.activateCheckoutProfile).not.toHaveBeenCalled();
  });
});

async function configureCheckoutControlMocks(): Promise<void> {
  vi.clearAllMocks();
  const organisationId = parseOrganisationId(ORGANISATION_ID);
  if (!organisationId.ok)
    throw new Error("Checkout control organisation fixture is invalid");
  checkoutControlMocks.authorizeOrganisationRequest.mockResolvedValue({
    ok: true,
    executionScope: await createOrganisationExecutionFixture(
      createMigratedDatabase(),
      organisationId.value,
    ),
    organisationId: organisationId.value,
    authenticated: {
      token: "session-checkout",
      session: {
        userId: "user_05b55efb-4ffb-5084-8969-e67fd855608a",
        expiresAt: Date.now() + 60_000,
      },
    },
    membership: { organisationId: organisationId.value, role: "owner" },
  });
  checkoutControlMocks.readOrganisationEnvironment.mockResolvedValue(
    "development",
  );
  checkoutControlMocks.resolveUser.mockResolvedValue({
    userId: "user_05b55efb-4ffb-5084-8969-e67fd855608a",
    issuer: "https://accounts.google.com",
    subject: "checkout-control-subject",
    email: "owner@example.test",
    displayName: "Checkout Owner",
    emailVerified: true,
    createdAt: Date.now() - 60_000,
    lastAuthenticatedAt: Date.now() - 60_000,
  });
  checkoutControlMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue(
    {
      ok: true,
      value: { merchantId: "merchant_checkout_control" },
    },
  );
  checkoutControlMocks.listCheckoutProfiles.mockResolvedValue({
    ok: true,
    value: [profile()],
  });
  checkoutControlMocks.listCheckoutProfileActivations.mockResolvedValue({
    ok: true,
    value: [activation()],
  });
  checkoutControlMocks.listStorefrontIds.mockResolvedValue({
    ok: true,
    value: [STOREFRONT_ID, "storefront_new"],
  });
  checkoutControlMocks.readCheckoutProfile.mockResolvedValue({
    ok: true,
    value: profile(),
  });
  checkoutControlMocks.listPaymentAccounts.mockResolvedValue(
    paymentAccounts("active"),
  );
  checkoutControlMocks.activateCheckoutProfile.mockResolvedValue({
    ok: true,
    value: { activation: activation(), profile: profile() },
  });
  checkoutControlMocks.readControlMutationReplay.mockResolvedValue({
    kind: "absent",
  });
  checkoutControlMocks.recordCommerceMutationReceipt.mockResolvedValue({
    ok: true,
    value: null,
  });
}

function checkoutControlEnv(): UnitTestEnv {
  return platformEnv({ PANTRY_PUBLIC_ORIGIN: "https://pantry.example" });
}

function activationRequest(): Request {
  return new Request(
    `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/commerce/storefronts/${STOREFRONT_ID}/checkout-profile-activation`,
    {
      method: "PUT",
      headers: {
        origin: "https://pantry.example",
        cookie:
          "pantry_session=session-checkout; pantry_csrf=csrf-checkout",
        "x-pantry-csrf": "csrf-checkout",
        "idempotency-key": "checkout-activation-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        checkoutProfileId: PROFILE_ID,
        checkoutProfileRevision: 2,
      }),
    },
  );
}

function profile(): CheckoutProfile {
  return {
    checkoutProfileId: PROFILE_ID,
    merchantId: "merchant_checkout_control",
    revision: 2,
    name: "Domestic checkout",
    configuration: configuration(),
    lifecycle: {
      state: "published",
      publishedAt: "2026-08-29T12:00:00.000Z",
      publishedBy: "user_05b55efb-4ffb-5084-8969-e67fd855608a",
    },
  };
}

function activation(): Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}> {
  return {
    merchantId: "merchant_checkout_control",
    storefrontId: STOREFRONT_ID,
    checkoutProfileId: PROFILE_ID,
    checkoutProfileRevision: 2,
    activatedAt: "2026-08-29T12:05:00.000Z",
    activatedBy: "user_05b55efb-4ffb-5084-8969-e67fd855608a",
  };
}

function configuration(): CheckoutProfileConfiguration {
  return {
    currencyPolicy: { kind: "fixed", currency: "JPY" },
    buyerPolicy: { kind: "guest", requiredContact: "email_required" },
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
    taxPolicy: {
      kind: "merchant_inclusive",
      jurisdictionPolicyId: "tax_japan",
    },
    paymentPolicy: {
      kind: "external_provider",
      paymentProviderBindingId: "payment_binding_primary_online",
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
}

function paymentAccounts(state: "active" | "restricted") {
  return {
    ok: true,
    value: {
      accounts: [
        {
          provider: "stripe",
          paymentProviderBindingId: "payment_binding_primary_online",
          providerAccountId: "acct_checkout_control",
          environment: "development",
          country: "JP",
          currency: "JPY",
          state,
          updatedAt: "2026-10-27T00:00:00.000Z",
        },
      ],
    },
  };
}
