import type { CheckoutProfileConfiguration } from "@seams/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DraftCheckoutProfileSummary } from "../../../apps/portal/src/features/checkout-profiles/api";
import {
  handleSaveSubmit,
  type CheckoutProfilesCommandContext,
} from "../../../apps/portal/src/features/checkout-profiles/controller";
import {
  createProfileDraft,
  type CheckoutProfilesAction,
} from "../../../apps/portal/src/features/checkout-profiles/model";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const CONFIGURATION: CheckoutProfileConfiguration = {
  currencyPolicy: { kind: "fixed", currency: "JPY" },
  buyerPolicy: {
    kind: "guest",
    requiredContact: "email_required_phone_optional",
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
    kind: "pickup_only",
    pickupPolicyId: "pickup_tokyo",
  },
  taxPolicy: {
    kind: "merchant_inclusive",
    jurisdictionPolicyId: "tax_japan",
  },
  paymentPolicy: {
    kind: "external_provider",
    paymentProviderBindingId: "payment_binding",
  },
  afterSalePolicy: {
    cancellationPolicyId: "cancellation_standard",
    refundPolicyId: "refund_standard",
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

describe("checkout profile command controller", () => {
  it("rejects a save command detached from its source revision", async () => {
    const source = draftSummary(2);
    const actions: CheckoutProfilesAction[] = [];
    const mutate = vi.fn();
    const context = commandContext(actions, mutate);
    const draft = {
      ...createProfileDraft(source.profile),
      sourceRevision: 1,
    };

    await handleSaveSubmit(
      context,
      { source, draft },
      { preventDefault: noOp },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(actions).toEqual([
      {
        kind: "operationFailed",
        organisationId: "organisation-a",
        message: "The selected draft changed. Review it before saving.",
      },
    ]);
  });
});

function commandContext(
  actions: CheckoutProfilesAction[],
  mutate: CheckoutProfilesCommandContext["mutate"],
): CheckoutProfilesCommandContext {
  return {
    organisationId: "organisation-a",
    mutate,
    dispatch: actions.push.bind(actions),
    scope: {
      organisationId: "organisation-a",
      currentOrganisation: { current: "organisation-a" },
      active: true,
    },
  };
}

function draftSummary(revision: number): DraftCheckoutProfileSummary {
  return {
    profile: {
      checkoutProfileId: "checkout-draft",
      merchantId: "merchant-a",
      revision,
      name: "Draft checkout",
      configuration: CONFIGURATION,
      lifecycle: {
        state: "draft",
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    },
    configurationDigest: "a".repeat(64),
  };
}

function noOp(): void {}
