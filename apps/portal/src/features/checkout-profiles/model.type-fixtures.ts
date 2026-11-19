import type { CheckoutProfileSummary } from "@purin-labs/control-api/portal/checkout-profiles";
import type { CreateDraftCommand, SaveDraftCommand } from "./controller";
import type {
  CheckoutProfilesReadyState,
  DraftCheckoutProfileSummary,
  PublishedCheckoutProfileSummary,
  ReviewAction,
} from "./model";

declare const profile: CheckoutProfileSummary;
declare const draft: DraftCheckoutProfileSummary;
declare const published: PublishedCheckoutProfileSummary;

// @ts-expect-error Activation always requires an exact storefront.
const activationWithoutStorefront: ReviewAction = {
  kind: "activate",
  profile: published,
};

// @ts-expect-error Published profiles cannot enter publication review.
const publishPublished: ReviewAction = { kind: "publish", profile: published };

// @ts-expect-error Draft profiles cannot enter activation review.
const activateDraft: ReviewAction = {
  kind: "activate",
  profile: draft,
  storefrontId: "storefront-a",
};

// @ts-expect-error Ready state always carries a selected draft.
const readyWithoutDraft: CheckoutProfilesReadyState = {
  kind: "ready",
  organisationId: "organisation-a",
  collection: { profiles: [profile], activations: [], storefrontIds: [] },
  selectedProfileId: profile.profile.checkoutProfileId,
  createForm: { checkoutProfileId: "", name: "" },
  activationStorefrontId: "",
  operation: { kind: "idle", error: null },
};

const createFromDraft: CreateDraftCommand = {
  // @ts-expect-error New drafts must clone an immutable published revision.
  source: draft,
  checkoutProfileId: "replacement",
  name: "Replacement",
};

const savePublished: SaveDraftCommand = {
  // @ts-expect-error Saving requires the selected draft lifecycle branch.
  source: published,
  draft: {
    checkoutProfileId: published.profile.checkoutProfileId,
    sourceRevision: published.profile.revision,
    name: published.profile.name,
    configuration: published.profile.configuration,
  },
};

void activationWithoutStorefront;
void publishPublished;
void activateDraft;
void readyWithoutDraft;
void createFromDraft;
void savePublished;
