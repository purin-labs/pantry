import type { CheckoutProfile } from "@purin-labs/commerce-contracts";

import type { CheckoutProfileCollection, DraftCheckoutProfileSummary, PublishedCheckoutProfileSummary } from "./api";
import type {
  CheckoutProfileSummary,
} from "@purin-labs/commerce-control-api/portal/checkout-profiles";
import { formatMoneyMinor } from "../../formatting";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

export type { DraftCheckoutProfileSummary, PublishedCheckoutProfileSummary } from "./api";

export type ProfileDraft = Readonly<{
  checkoutProfileId: string;
  sourceRevision: number;
  name: string;
  configuration: CheckoutProfile["configuration"];
}>;

export type ReviewAction =
  | Readonly<{ kind: "publish"; profile: DraftCheckoutProfileSummary }>
  | Readonly<{
      kind: "activate";
      profile: PublishedCheckoutProfileSummary;
      storefrontId: string;
    }>
  | Readonly<{ kind: "retire"; profile: PublishedCheckoutProfileSummary }>;

export type BusyAction =
  "create" | "save" | "publish" | "activate" | "retire" | null;

export type Readiness = Readonly<{
  items: readonly Readonly<{ label: string; ready: boolean; detail: string }>[];
  blockers: readonly string[];
}>;

type IdleOperation = Readonly<{ kind: "idle"; error: string | null }>;

type ReviewStatus =
  | Readonly<{ kind: "ready"; error: string | null }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type CheckoutProfilesOperation =
  | IdleOperation
  | Readonly<{ kind: "submitting"; action: "create" | "save" }>
  | Readonly<{
      kind: "reviewing";
      review: ReviewAction;
      status: ReviewStatus;
    }>;

export type CheckoutProfilesReadyState = Readonly<{
  kind: "ready";
  organisationId: string;
  collection: CheckoutProfileCollection;
  selectedProfileId: string;
  draft: ProfileDraft;
  createForm: Readonly<{ checkoutProfileId: string; name: string }>;
  activationStorefrontId: string;
  operation: CheckoutProfilesOperation;
}>;

export type CheckoutProfilesState =
  | Readonly<{ kind: "loading"; organisationId: string }>
  | Readonly<{ kind: "loadFailed"; organisationId: string; message: string }>
  | Readonly<{
      kind: "empty";
      organisationId: string;
      collection: CheckoutProfileCollection;
    }>
  | CheckoutProfilesReadyState;

export type CheckoutProfileAppliedMutation =
  | Readonly<{
      kind: "profileChanged";
      selected: CheckoutProfileSummary;
      clearCreateForm: boolean;
    }>
  | Readonly<{
      kind: "activationChanged";
      selected: PublishedCheckoutProfileSummary;
      activation: CheckoutProfileCollection["activations"][number];
    }>;

export type CheckoutProfilesAction =
  | Readonly<{ kind: "loadStarted"; organisationId: string }>
  | Readonly<{
      kind: "loadSucceeded";
      organisationId: string;
      collection: CheckoutProfileCollection;
    }>
  | Readonly<{ kind: "loadFailed"; organisationId: string; message: string }>
  | Readonly<{ kind: "selectProfile"; profile: CheckoutProfileSummary }>
  | Readonly<{ kind: "replaceDraft"; draft: ProfileDraft }>
  | Readonly<{ kind: "changeCreateId"; value: string }>
  | Readonly<{ kind: "changeCreateName"; value: string }>
  | Readonly<{ kind: "changeActivationStorefront"; value: string }>
  | Readonly<{ kind: "startMutation"; action: "create" | "save" }>
  | Readonly<{ kind: "openReview"; review: ReviewAction }>
  | Readonly<{ kind: "startReview" }>
  | Readonly<{ kind: "closeReview" }>
  | Readonly<{
      kind: "operationFailed";
      organisationId: string;
      message: string;
    }>
  | Readonly<{
      kind: "mutationSucceeded";
      organisationId: string;
      mutation: CheckoutProfileAppliedMutation;
    }>;

export function initialCheckoutProfilesState(
  organisationId: string,
): CheckoutProfilesState {
  return { kind: "loading", organisationId };
}

export function reduceCheckoutProfilesState(
  state: CheckoutProfilesState,
  action: CheckoutProfilesAction,
): CheckoutProfilesState {
  switch (action.kind) {
    case "loadStarted":
      return { kind: "loading", organisationId: action.organisationId };
    case "loadSucceeded":
      return state.organisationId === action.organisationId
        ? stateFromCollection(action.organisationId, action.collection)
        : state;
    case "loadFailed":
      return state.organisationId === action.organisationId
        ? {
            kind: "loadFailed",
            organisationId: action.organisationId,
            message: action.message,
          }
        : state;
    case "selectProfile":
      return selectProfile(state, action.profile);
    case "replaceDraft":
      return replaceReadyDraft(state, action.draft);
    case "changeCreateId":
      return changeCreateId(state, action.value);
    case "changeCreateName":
      return changeCreateName(state, action.value);
    case "changeActivationStorefront":
      return changeActivationStorefront(state, action.value);
    case "startMutation":
      return startMutation(state, action.action);
    case "openReview":
      return openReview(state, action.review);
    case "startReview":
      return startReview(state);
    case "closeReview":
      return closeReview(state);
    case "operationFailed":
      return failOperation(state, action.organisationId, action.message);
    case "mutationSucceeded":
      return mutationSucceeded(state, action);
    default:
      return assertNever(action, "Unexpected checkout profile action");
  }
}

export function createProfileDraft(profile: CheckoutProfile): ProfileDraft {
  return {
    checkoutProfileId: profile.checkoutProfileId,
    sourceRevision: profile.revision,
    name: profile.name,
    configuration: profile.configuration,
  };
}

export function profileReadiness(draft: ProfileDraft): Readiness {
  const config = draft.configuration;
  const cartReady =
    Number.isSafeInteger(config.cartPolicy.minimumLines) &&
    Number.isSafeInteger(config.cartPolicy.maximumLines) &&
    Number.isSafeInteger(config.cartPolicy.maximumTotalQuantity) &&
    config.cartPolicy.minimumLines > 0 &&
    config.cartPolicy.maximumLines >= config.cartPolicy.minimumLines &&
    config.cartPolicy.maximumTotalQuantity >= config.cartPolicy.maximumLines;
  const referencesReady = requiredPolicyReferences(config).every(nonEmptyText);
  const currencyReady = /^[A-Z]{3}$/u.test(config.currencyPolicy.currency);
  const paymentReady = config.paymentPolicy.kind === "external_provider";
  const refundGovernanceReady =
    automaticRefundThresholdReady(config) ||
    config.afterSalePolicy.refundGovernance.kind === "approval_required";
  const items = [
    {
      label: "Profile fields",
      ready: draft.name.trim().length > 0 && currencyReady && referencesReady,
      detail: "Names, currency, and policy references are set.",
    },
    {
      label: "Cart limits",
      ready: cartReady,
      detail: "Line and quantity limits are valid.",
    },
    {
      label: "Payment provider",
      ready: paymentReady,
      detail: paymentReady
        ? "Provider selected. Activation needs an active payment account."
        : "Select one external provider binding.",
    },
    {
      label: "Refund governance",
      ready: refundGovernanceReady,
      detail: refundGovernanceReady
        ? refundGovernanceDescription(config)
        : `Enter a positive whole-number threshold in ${config.currencyPolicy.currency} minor units.`,
    },
  ];
  return {
    items,
    blockers: items.filter(readinessItemBlocked).map(readinessBlockerMessage),
  };
}

export function automaticRefundThresholdReady(
  config: CheckoutProfile["configuration"],
): boolean {
  const governance = config.afterSalePolicy.refundGovernance;
  return (
    governance.kind === "automatic_up_to" &&
    Number.isSafeInteger(governance.threshold.amountMinor) &&
    governance.threshold.amountMinor > 0 &&
    governance.threshold.currency === config.currencyPolicy.currency
  );
}

export function refundGovernanceDescription(
  config: CheckoutProfile["configuration"],
): string {
  const governance = config.afterSalePolicy.refundGovernance;
  switch (governance.kind) {
    case "approval_required":
      return "Every refund requires merchant approval.";
    case "automatic_up_to":
      if (automaticRefundThresholdReady(config)) {
        return `Refunds up to ${formatMoneyMinor(governance.threshold.amountMinor, config.currencyPolicy.currency)} are eligible for automatic processing when platform controls permit it; higher amounts require approval.`;
      }
      return `Enter a positive whole-number threshold in ${config.currencyPolicy.currency} minor units.`;
    default:
      return assertNever(governance, "Unexpected checkout profile action");
  }
}

export function selectedProfile(
  state: CheckoutProfilesReadyState,
): CheckoutProfileSummary {
  const selected = state.collection.profiles.find(
    profileHasId.bind(null, state.selectedProfileId),
  );
  if (selected === undefined) {
    throw new Error("The selected checkout profile is unavailable.");
  }
  return selected;
}

export function activeStorefrontIds(
  collection: CheckoutProfileCollection,
  summary: CheckoutProfileSummary,
): readonly string[] {
  return collection.activations
    .filter(activationMatchesProfile.bind(null, summary))
    .map(readActivationStorefrontId);
}

export function storefrontIds(
  collection: CheckoutProfileCollection,
): readonly string[] {
  return collection.storefrontIds;
}

export function selectedActivationStorefront(
  selected: string,
  storefronts: readonly string[],
): string | null {
  if (storefronts.includes(selected)) {
    return selected;
  }
  return storefronts[0] ?? null;
}

export function profileDraftChanged(
  draft: ProfileDraft,
  profile: CheckoutProfile,
): boolean {
  return (
    draft.name !== profile.name ||
    JSON.stringify(draft.configuration) !==
      JSON.stringify(profile.configuration)
  );
}

export function activeReview(
  state: CheckoutProfilesReadyState,
): ReviewAction | null {
  return state.operation.kind === "reviewing" ? state.operation.review : null;
}

export function isDraftProfileSummary(
  summary: CheckoutProfileSummary,
): summary is DraftCheckoutProfileSummary {
  return summary.profile.lifecycle.state === "draft";
}

export function isPublishedProfileSummary(
  summary: CheckoutProfileSummary,
): summary is PublishedCheckoutProfileSummary {
  return summary.profile.lifecycle.state === "published";
}

export function busyAction(state: CheckoutProfilesReadyState): BusyAction {
  if (state.operation.kind === "submitting") {
    return state.operation.action;
  }
  if (
    state.operation.kind === "reviewing" &&
    state.operation.status.kind === "submitting"
  ) {
    return state.operation.review.kind;
  }
  return null;
}

export function operationError(
  state: CheckoutProfilesReadyState,
): string | null {
  if (state.operation.kind === "idle") {
    return state.operation.error;
  }
  if (state.operation.kind !== "reviewing") {
    return null;
  }
  switch (state.operation.status.kind) {
    case "ready":
      return state.operation.status.error;
    case "submitting":
      return null;
    case "failed":
      return state.operation.status.message;
    default:
      return assertNever(
        state.operation.status,
        "Unexpected checkout profile action",
      );
  }
}

function stateFromCollection(
  organisationId: string,
  collection: CheckoutProfileCollection,
): CheckoutProfilesState {
  const selected = defaultSelectedProfile(collection);
  if (selected === null) {
    return { kind: "empty", organisationId, collection };
  }
  return {
    kind: "ready",
    organisationId,
    collection,
    selectedProfileId: selected.profile.checkoutProfileId,
    draft: createProfileDraft(selected.profile),
    createForm: { checkoutProfileId: "", name: "" },
    activationStorefrontId: "",
    operation: { kind: "idle", error: null },
  };
}

function defaultSelectedProfile(
  collection: CheckoutProfileCollection,
): CheckoutProfileSummary | null {
  const activeProfileId = collection.activations[0]?.checkoutProfileId;
  if (activeProfileId !== undefined) {
    const active = collection.profiles.find(
      profileHasId.bind(null, activeProfileId),
    );
    if (active !== undefined) {
      return active;
    }
  }
  return collection.profiles[0] ?? null;
}

function requiredPolicyReferences(
  config: CheckoutProfile["configuration"],
): readonly string[] {
  let fulfillment: readonly string[];
  switch (config.fulfillmentPolicy.kind) {
    case "pickup_only":
      fulfillment = [config.fulfillmentPolicy.pickupPolicyId];
      break;
    case "shipping_only":
      fulfillment = [config.fulfillmentPolicy.shippingPolicyId];
      break;
    case "buyer_choice":
      fulfillment = [
        config.fulfillmentPolicy.pickupPolicyId,
        config.fulfillmentPolicy.shippingPolicyId,
      ];
      break;
    default:
      fulfillment = assertNever(
        config.fulfillmentPolicy,
        "Unexpected checkout profile action",
      );
  }

  let tax: readonly string[];
  switch (config.taxPolicy.kind) {
    case "merchant_inclusive":
      tax = [config.taxPolicy.jurisdictionPolicyId];
      break;
    case "provider_quoted":
      tax = [
        config.taxPolicy.taxCapabilityId,
        config.taxPolicy.registrationPolicyId,
      ];
      break;
    default:
      tax = assertNever(config.taxPolicy, "Unexpected checkout profile action");
  }

  return [
    ...fulfillment,
    ...tax,
    config.paymentPolicy.paymentProviderBindingId,
    config.afterSalePolicy.cancellationPolicyId,
    config.afterSalePolicy.refundPolicyId,
    config.pricingPolicy.salesChannelId,
    config.presentationPolicy.merchantDisplayName,
    config.presentationPolicy.locale,
    config.presentationPolicy.termsPolicyId,
    config.presentationPolicy.privacyPolicyId,
    config.presentationPolicy.supportContact,
  ];
}

function nonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}

function readinessItemBlocked(item: Readiness["items"][number]): boolean {
  return !item.ready;
}

function readinessBlockerMessage(item: Readiness["items"][number]): string {
  return `${item.label}: ${item.detail}`;
}

function profileHasId(
  checkoutProfileId: string,
  summary: CheckoutProfileSummary,
): boolean {
  return summary.profile.checkoutProfileId === checkoutProfileId;
}

function activationMatchesProfile(
  summary: CheckoutProfileSummary,
  activation: CheckoutProfileCollection["activations"][number],
): boolean {
  return (
    activation.checkoutProfileId === summary.profile.checkoutProfileId &&
    activation.checkoutProfileRevision === summary.profile.revision
  );
}

function readActivationStorefrontId(
  activation: CheckoutProfileCollection["activations"][number],
): string {
  return activation.storefrontId;
}

function selectProfile(
  state: CheckoutProfilesState,
  profile: CheckoutProfileSummary,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  const selected = state.collection.profiles.find(
    profileHasId.bind(null, profile.profile.checkoutProfileId),
  );
  if (selected === undefined) {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: selected.profile.checkoutProfileId,
    draft: createProfileDraft(selected.profile),
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: { kind: "idle", error: null },
  });
}

function changeCreateId(
  state: CheckoutProfilesState,
  value: string,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: { checkoutProfileId: value, name: state.createForm.name },
    activationStorefrontId: state.activationStorefrontId,
    operation: state.operation,
  });
}

function changeCreateName(
  state: CheckoutProfilesState,
  value: string,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: {
      checkoutProfileId: state.createForm.checkoutProfileId,
      name: value,
    },
    activationStorefrontId: state.activationStorefrontId,
    operation: state.operation,
  });
}

function changeActivationStorefront(
  state: CheckoutProfilesState,
  value: string,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: value,
    operation: state.operation,
  });
}

function startMutation(
  state: CheckoutProfilesState,
  action: "create" | "save",
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: { kind: "submitting", action },
  });
}

function replaceReadyDraft(
  state: CheckoutProfilesState,
  draft: ProfileDraft,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  if (
    draft.checkoutProfileId !== state.selectedProfileId ||
    draft.sourceRevision !== state.draft.sourceRevision
  ) {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation:
      state.operation.kind === "reviewing"
        ? { kind: "idle", error: null }
        : state.operation,
  });
}

function openReview(
  state: CheckoutProfilesState,
  review: ReviewAction,
): CheckoutProfilesState {
  if (state.kind !== "ready" || !reviewMatchesState(state, review)) {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: {
      kind: "reviewing",
      review,
      status: { kind: "ready", error: operationError(state) },
    },
  });
}

function startReview(state: CheckoutProfilesState): CheckoutProfilesState {
  if (state.kind !== "ready" || state.operation.kind !== "reviewing") {
    return state;
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: {
      kind: "reviewing",
      review: state.operation.review,
      status: { kind: "submitting" },
    },
  });
}

function closeReview(state: CheckoutProfilesState): CheckoutProfilesState {
  if (state.kind !== "ready" || state.operation.kind !== "reviewing") {
    return state;
  }
  const error = operationError(state);
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: { kind: "idle", error },
  });
}

function failOperation(
  state: CheckoutProfilesState,
  organisationId: string,
  message: string,
): CheckoutProfilesState {
  if (state.kind !== "ready") {
    return state;
  }
  if (state.organisationId !== organisationId) {
    return state;
  }
  if (state.operation.kind === "reviewing") {
    return buildReadyState({
      organisationId: state.organisationId,
      collection: state.collection,
      selectedProfileId: state.selectedProfileId,
      draft: state.draft,
      createForm: state.createForm,
      activationStorefrontId: state.activationStorefrontId,
      operation: {
        kind: "reviewing",
        review: state.operation.review,
        status: { kind: "failed", message },
      },
    });
  }
  return buildReadyState({
    organisationId: state.organisationId,
    collection: state.collection,
    selectedProfileId: state.selectedProfileId,
    draft: state.draft,
    createForm: state.createForm,
    activationStorefrontId: state.activationStorefrontId,
    operation: { kind: "idle", error: message },
  });
}

function reviewMatchesState(
  state: CheckoutProfilesReadyState,
  review: ReviewAction,
): boolean {
  const selected = selectedProfile(state);
  if (
    review.profile.profile.checkoutProfileId !== state.selectedProfileId ||
    review.profile.profile.revision !== selected.profile.revision ||
    review.profile.configurationDigest !== selected.configurationDigest
  ) {
    return false;
  }

  switch (review.kind) {
    case "publish":
      return (
        state.draft.sourceRevision === review.profile.profile.revision &&
        !profileDraftChanged(state.draft, review.profile.profile) &&
        profileReadiness(state.draft).blockers.length === 0
      );
    case "activate":
      return (
        review.storefrontId.trim().length > 0 &&
        storefrontIds(state.collection).includes(review.storefrontId) &&
        !activeStorefrontIds(state.collection, review.profile).includes(
          review.storefrontId,
        )
      );
    case "retire":
      return activeStorefrontIds(state.collection, review.profile).length === 0;
    default:
      return assertNever(review, "Unexpected checkout profile action");
  }
}

function mutationSucceeded(
  state: CheckoutProfilesState,
  action: Variant<CheckoutProfilesAction, "mutationSucceeded">,
): CheckoutProfilesState {
  if (state.organisationId !== action.organisationId) {
    return state;
  }
  const collection = collectionAfterMutation(state, action.mutation);
  const selected = action.mutation.selected;
  const createForm =
    state.kind === "ready" && !mutationClearsCreateForm(action.mutation)
      ? state.createForm
      : { checkoutProfileId: "", name: "" };
  const activationStorefrontId =
    state.kind === "ready" ? state.activationStorefrontId : "";
  return buildReadyState({
    organisationId: action.organisationId,
    collection,
    selectedProfileId: selected.profile.checkoutProfileId,
    draft: createProfileDraft(selected.profile),
    createForm,
    activationStorefrontId,
    operation: { kind: "idle", error: null },
  });
}

function collectionAfterMutation(
  state: CheckoutProfilesState,
  mutation: CheckoutProfileAppliedMutation,
): CheckoutProfileCollection {
  const current =
    state.kind === "ready" || state.kind === "empty"
      ? state.collection
      : { profiles: [], activations: [], storefrontIds: [] };
  const profiles = replaceProfileSummary(current.profiles, mutation.selected);
  switch (mutation.kind) {
    case "profileChanged":
      return { ...current, profiles };
    case "activationChanged":
      return {
        ...current,
        profiles,
        activations: replaceActivation(
          current.activations,
          mutation.activation,
        ),
      };
    default:
      return assertNever(mutation, "Unexpected checkout profile action");
  }
}

function replaceProfileSummary(
  profiles: readonly CheckoutProfileSummary[],
  selected: CheckoutProfileSummary,
): readonly CheckoutProfileSummary[] {
  const retained = profiles.filter(
    profileDoesNotHaveId.bind(null, selected.profile.checkoutProfileId),
  );
  return [...retained, selected];
}

function profileDoesNotHaveId(
  checkoutProfileId: string,
  summary: CheckoutProfileSummary,
): boolean {
  return summary.profile.checkoutProfileId !== checkoutProfileId;
}

function replaceActivation(
  activations: CheckoutProfileCollection["activations"],
  activation: CheckoutProfileCollection["activations"][number],
): CheckoutProfileCollection["activations"] {
  const retained = activations.filter(
    activationHasDifferentStorefront.bind(null, activation.storefrontId),
  );
  return [...retained, activation];
}

function activationHasDifferentStorefront(
  storefrontId: string,
  activation: CheckoutProfileCollection["activations"][number],
): boolean {
  return activation.storefrontId !== storefrontId;
}

function mutationClearsCreateForm(
  mutation: CheckoutProfileAppliedMutation,
): boolean {
  return mutation.kind === "profileChanged" && mutation.clearCreateForm;
}

function buildReadyState(
  input: Omit<CheckoutProfilesReadyState, "kind">,
): CheckoutProfilesReadyState {
  return {
    kind: "ready",
    organisationId: input.organisationId,
    collection: input.collection,
    selectedProfileId: input.selectedProfileId,
    draft: input.draft,
    createForm: input.createForm,
    activationStorefrontId: input.activationStorefrontId,
    operation: input.operation,
  };
}
