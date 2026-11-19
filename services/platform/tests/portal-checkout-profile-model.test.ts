import type {
  CheckoutProfile,
  CheckoutProfileConfiguration,
} from "@purin-labs/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  CheckoutProfileCollection,
  DraftCheckoutProfileSummary,
} from "../../../apps/portal/src/features/checkout-profiles/api";
import type { CheckoutProfileSummary } from "@purin-labs/control-api/portal/checkout-profiles";
import { handleSaveSubmit } from "../../../apps/portal/src/features/checkout-profiles/controller";
import {
  activeReview,
  busyAction,
  createProfileDraft,
  initialCheckoutProfilesState,
  isDraftProfileSummary,
  isPublishedProfileSummary,
  operationError,
  profileReadiness,
  reduceCheckoutProfilesState,
  selectedProfile,
  type CheckoutProfilesAction,
  type CheckoutProfilesState,
} from "../../../apps/portal/src/features/checkout-profiles/model";
import type { Variant } from "@purin-labs/type-utils";

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

describe("checkout profile screen model", () => {
  it("constructs empty and active-profile screen branches", () => {
    const empty = reduceCheckoutProfilesState(
      initialCheckoutProfilesState("organisation-a"),
      {
        kind: "loadSucceeded",
        organisationId: "organisation-a",
        collection: collection([], []),
      },
    );
    expect(empty.kind).toBe("empty");

    const inactive = summary("inactive", 1, "draft");
    const active = summary("active", 4, "published");
    const ready = loadCollection(
      collection([inactive, active], [activation("active", 4)]),
    );
    expect(selectedProfile(ready)).toBe(active);
    expect(ready.draft).toEqual(createProfileDraft(active.profile));
  });

  it("keeps draft, selection, and mutation failure in one transition model", () => {
    const first = summary("first", 1, "published");
    const second = summary("second", 2, "draft");
    const ready = loadCollection(collection([first, second], []));
    const selected = reduceCheckoutProfilesState(ready, {
      kind: "selectProfile",
      profile: second,
    });
    expect(selected.kind).toBe("ready");
    if (selected.kind !== "ready") {
      return;
    }

    const editedDraft = { ...selected.draft, name: "Edited replacement" };
    const edited = reduceCheckoutProfilesState(selected, {
      kind: "replaceDraft",
      draft: editedDraft,
    });
    const submitting = reduceCheckoutProfilesState(edited, {
      kind: "startMutation",
      action: "save",
    });
    expect(submitting.kind === "ready" && busyAction(submitting)).toBe("save");

    const failed = reduceCheckoutProfilesState(submitting, {
      kind: "operationFailed",
      organisationId: "organisation-a",
      message: "Revision conflict.",
    });
    expect(failed.kind).toBe("ready");
    if (failed.kind !== "ready") {
      return;
    }
    expect(failed.draft).toEqual(editedDraft);
    expect(operationError(failed)).toBe("Revision conflict.");
  });

  it("ties review submission and failure to the exact action", () => {
    const published = publishedSummary("active", 3);
    const storefrontSource = summary("storefront-source", 1, "published");
    const loaded = loadCollection(
      collection(
        [published, storefrontSource],
        [activation("storefront-source", 1)],
      ),
    );
    const ready = reduceCheckoutProfilesState(loaded, {
      kind: "selectProfile",
      profile: published,
    });
    if (ready.kind !== "ready") {
      throw new Error("Expected a selected published profile.");
    }
    const reviewing = reduceCheckoutProfilesState(ready, {
      kind: "openReview",
      review: {
        kind: "activate",
        profile: published,
        storefrontId: "storefront_web",
      },
    });
    const submitting = reduceCheckoutProfilesState(reviewing, {
      kind: "startReview",
    });
    expect(submitting.kind).toBe("ready");
    if (submitting.kind !== "ready") {
      return;
    }
    expect(busyAction(submitting)).toBe("activate");
    expect(activeReview(submitting)).toMatchObject({
      kind: "activate",
      storefrontId: "storefront_web",
    });

    const failed = reduceCheckoutProfilesState(submitting, {
      kind: "operationFailed",
      organisationId: "organisation-a",
      message: "Activation failed.",
    });
    expect(failed.kind).toBe("ready");
    if (failed.kind !== "ready") {
      return;
    }
    expect(activeReview(failed)?.kind).toBe("activate");
    expect(operationError(failed)).toBe("Activation failed.");

    const closed = reduceCheckoutProfilesState(failed, { kind: "closeReview" });
    expect(closed.kind).toBe("ready");
    if (closed.kind === "ready") {
      expect(activeReview(closed)).toBeNull();
      expect(operationError(closed)).toBe("Activation failed.");
    }
  });

  it("reconciles an acknowledged profile mutation without another read", () => {
    const before = summary("replacement", 1, "draft");
    const ready = loadCollection(collection([before], []));
    const after = summary("replacement", 2, "draft");
    const succeeded = reduceCheckoutProfilesState(ready, {
      kind: "mutationSucceeded",
      organisationId: "organisation-a",
      mutation: {
        kind: "profileChanged",
        selected: after,
        clearCreateForm: false,
      },
    });
    expect(succeeded.kind).toBe("ready");
    if (succeeded.kind === "ready") {
      expect(succeeded.collection.profiles).toEqual([after]);
      expect(succeeded.draft.sourceRevision).toBe(2);
      expect(operationError(succeeded)).toBeNull();
    }
  });

  it("reconciles an acknowledged activation without another read", () => {
    const selected = publishedSummary("replacement", 2);
    const previous = publishedSummary("previous", 1);
    const ready = loadCollection({
      profiles: [selected, previous],
      activations: [activation("previous", 1)],
      storefrontIds: ["storefront_web"],
    });
    const nextActivation = activation("replacement", 2);
    const succeeded = reduceCheckoutProfilesState(ready, {
      kind: "mutationSucceeded",
      organisationId: "organisation-a",
      mutation: {
        kind: "activationChanged",
        selected,
        activation: nextActivation,
      },
    });

    expect(succeeded.kind).toBe("ready");
    if (succeeded.kind === "ready") {
      expect(succeeded.collection.activations).toEqual([nextActivation]);
      expect(succeeded.selectedProfileId).toBe("replacement");
      expect(operationError(succeeded)).toBeNull();
    }
  });

  it("invalidates publication review when the draft changes", () => {
    const draft = draftSummary("replacement", 2);
    const ready = loadCollection(collection([draft], []));
    const reviewing = reduceCheckoutProfilesState(ready, {
      kind: "openReview",
      review: { kind: "publish", profile: draft },
    });
    expect(reviewing.kind === "ready" && activeReview(reviewing)?.kind).toBe(
      "publish",
    );

    const changed = reduceCheckoutProfilesState(reviewing, {
      kind: "replaceDraft",
      draft: { ...ready.draft, name: "Unsaved change" },
    });
    expect(changed.kind === "ready" && activeReview(changed)).toBeNull();
  });

  it("ignores async completions from a previous organisation", () => {
    const organisationAProfile = summary("organisation-a-profile", 1, "draft");
    const organisationBProfile = summary("organisation-b-profile", 1, "draft");
    const organisationA = loadCollection(
      collection([organisationAProfile], []),
    );
    const organisationB = reduceCheckoutProfilesState(organisationA, {
      kind: "loadStarted",
      organisationId: "organisation-b",
    });
    const loadedOrganisationB = reduceCheckoutProfilesState(organisationB, {
      kind: "loadSucceeded",
      organisationId: "organisation-b",
      collection: collection([organisationBProfile], []),
    });
    const stale = reduceCheckoutProfilesState(loadedOrganisationB, {
      kind: "mutationSucceeded",
      organisationId: "organisation-a",
      mutation: {
        kind: "profileChanged",
        selected: organisationAProfile,
        clearCreateForm: false,
      },
    });

    expect(stale).toBe(loadedOrganisationB);
    expect(stale.organisationId).toBe("organisation-b");
  });

  it("derives readiness from the complete draft configuration", () => {
    const published = summary("ready", 1, "published");
    const ready = profileReadiness(createProfileDraft(published.profile));
    expect(ready.blockers).toEqual([]);

    const invalid = createProfileDraft(published.profile);
    const blocked = profileReadiness({
      ...invalid,
      configuration: {
        ...invalid.configuration,
        currencyPolicy: { kind: "fixed", currency: "yen" },
      },
    });
    expect(blocked.blockers[0]).toContain("Profile fields");
  });

  it("rejects a save command detached from its source revision", async () => {
    const source = draftSummary("checkout-draft", 2);
    const actions: CheckoutProfilesAction[] = [];
    const mutate = vi.fn();
    const draft = {
      ...createProfileDraft(source.profile),
      sourceRevision: 1,
    };

    await handleSaveSubmit(
      {
        organisationId: "organisation-a",
        mutate,
        dispatch: actions.push.bind(actions),
        scope: {
          organisationId: "organisation-a",
          currentOrganisation: { current: "organisation-a" },
          active: true,
        },
      },
      { source, draft },
      { preventDefault: () => {} },
    );

    // A stale draft never reaches the server, so it cannot overwrite a newer
    // revision that someone else saved.
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

function loadCollection(
  profiles: CheckoutProfileCollection,
): Variant<CheckoutProfilesState, "ready"> {
  const state = reduceCheckoutProfilesState(
    initialCheckoutProfilesState("organisation-a"),
    {
      kind: "loadSucceeded",
      organisationId: "organisation-a",
      collection: profiles,
    },
  );
  if (state.kind !== "ready") {
    throw new Error("Expected a ready checkout profile state.");
  }
  return state;
}

function publishedSummary(
  checkoutProfileId: string,
  revision: number,
): import("../../../apps/portal/src/features/checkout-profiles/model").PublishedCheckoutProfileSummary {
  const value = summary(checkoutProfileId, revision, "published");
  if (!isPublishedProfileSummary(value)) {
    throw new Error("Expected a published checkout profile.");
  }
  return value;
}

function draftSummary(
  checkoutProfileId: string,
  revision: number,
): DraftCheckoutProfileSummary {
  const value = summary(checkoutProfileId, revision, "draft");
  if (!isDraftProfileSummary(value)) {
    throw new Error("Expected a draft checkout profile.");
  }
  return value;
}

function collection(
  profiles: readonly CheckoutProfileSummary[],
  activations: CheckoutProfileCollection["activations"],
): CheckoutProfileCollection {
  return {
    profiles,
    activations,
    storefrontIds: [
      ...new Set(activations.map(readActivationStorefrontId)),
    ].sort(),
  };
}

function readActivationStorefrontId(
  activation: CheckoutProfileCollection["activations"][number],
): string {
  return activation.storefrontId;
}

function summary(
  checkoutProfileId: string,
  revision: number,
  lifecycle: "draft" | "published",
): CheckoutProfileSummary {
  return {
    profile: profile(checkoutProfileId, revision, lifecycle),
    configurationDigest: "a".repeat(64),
  };
}

function profile(
  checkoutProfileId: string,
  revision: number,
  lifecycle: "draft" | "published",
): CheckoutProfile {
  const createdAt = "2026-09-11T00:00:00.000Z";
  const updatedAt = "2026-09-11T00:00:00.000Z";
  const lifecycleState =
    lifecycle === "draft"
      ? { state: "draft" as const, createdAt, updatedAt }
      : {
          state: "published" as const,
          publishedAt: "2026-09-11T00:00:00.000Z",
          publishedBy: "operator_1",
        };
  return {
    checkoutProfileId,
    merchantId: "merchant_1",
    revision,
    name: checkoutProfileId,
    configuration: CONFIGURATION,
    lifecycle: lifecycleState,
  };
}

function activation(
  checkoutProfileId: string,
  checkoutProfileRevision: number,
): CheckoutProfileCollection["activations"][number] {
  return {
    merchantId: "merchant_1",
    storefrontId: "storefront_web",
    checkoutProfileId,
    checkoutProfileRevision,
    activatedAt: "2026-09-11T00:00:00.000Z",
    activatedBy: "operator_1",
  };
}
