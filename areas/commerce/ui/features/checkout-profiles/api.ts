import type {
  CheckoutProfile,
  CheckoutProfileConfiguration,
} from "@purin-labs/commerce-contracts";
import { parseCheckoutProfileActivations, parseStorefrontIds, type CommerceCheckoutProfileActivationV1 } from "@purin-labs/commerce-client";
import { controlRead } from "@purin-labs/control/portal/control-client";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  type CheckoutProfileSummary,
  parseProfileMutation,
  parseProfileSummary,
  requireExactKeys,
  requireObject,
} from "@purin-labs/commerce-control-api/portal/checkout-profiles";
import type { CheckoutProfileMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/checkout-profiles/transport";

type CheckoutProfileWithLifecycle<
  TState extends CheckoutProfile["lifecycle"]["state"],
> = Omit<CheckoutProfile, "lifecycle"> &
  Readonly<{
    lifecycle: VariantBy<CheckoutProfile["lifecycle"], "state", TState>;
  }>;

type CheckoutProfileSummaryWithLifecycle<
  TState extends CheckoutProfile["lifecycle"]["state"],
> = Omit<CheckoutProfileSummary, "profile"> &
  Readonly<{ profile: CheckoutProfileWithLifecycle<TState> }>;

export type DraftCheckoutProfileSummary =
  CheckoutProfileSummaryWithLifecycle<"draft">;

export type PublishedCheckoutProfileSummary =
  CheckoutProfileSummaryWithLifecycle<"published">;

type RetiredCheckoutProfileSummary =
  CheckoutProfileSummaryWithLifecycle<"retired">;

export type CheckoutProfileCollection = Readonly<{
  profiles: readonly CheckoutProfileSummary[];
  activations: readonly CommerceCheckoutProfileActivationV1[];
  storefrontIds: readonly string[];
}>;

type CheckoutProfileActivationResult = Readonly<{
  profile: PublishedCheckoutProfileSummary;
  activation: CommerceCheckoutProfileActivationV1;
}>;

export type CheckoutProfileReadTransport = (path: string) => Promise<unknown>;

export async function readCheckoutProfiles(
  organisationId: string,
  read: CheckoutProfileReadTransport = controlRead,
): Promise<CheckoutProfileCollection> {
  const raw = await read(checkoutProfilesPath(organisationId));
  const object = requireObject(raw, "checkout profile response");
  requireExactKeys(
    object,
    ["ok", "profiles", "activations", "storefrontIds"],
    "checkout profile response",
  );
  if (object.ok !== true || !Array.isArray(object.profiles)) {
    throw new Error("Checkout profiles are unavailable.");
  }
  return {
    profiles: object.profiles.map(parseProfileSummary),
    activations: parseCheckoutProfileActivations(object.activations),
    storefrontIds: parseStorefrontIds(object.storefrontIds),
  };
}

export async function createCheckoutProfileDraft(
  organisationId: string,
  source: PublishedCheckoutProfileSummary,
  input: Readonly<{ checkoutProfileId: string; name: string }>,
  mutate: CheckoutProfileMutationTransport,
): Promise<DraftCheckoutProfileSummary> {
  const raw = await mutate(
    checkoutProfilesPath(organisationId),
    "POST",
    {
      checkoutProfileId: input.checkoutProfileId,
      name: input.name,
      configuration: source.profile.configuration,
    },
    `checkout-profile-create:${source.profile.checkoutProfileId}:${source.profile.revision}:${input.checkoutProfileId}`,
  );
  return requireDraftSummary(parseProfileMutation(raw));
}

export async function replaceCheckoutProfileDraft(
  organisationId: string,
  draft: DraftCheckoutProfileSummary,
  input: Readonly<{
    name: string;
    configuration: CheckoutProfileConfiguration;
  }>,
  mutate: CheckoutProfileMutationTransport,
): Promise<DraftCheckoutProfileSummary> {
  const raw = await mutate(
    `${checkoutProfilesPath(organisationId)}/${encodeURIComponent(draft.profile.checkoutProfileId)}/draft`,
    "PUT",
    {
      expectedRevision: draft.profile.revision,
      name: input.name,
      configuration: input.configuration,
    },
    `checkout-profile-replace:${draft.profile.checkoutProfileId}:${draft.profile.revision}`,
  );
  return requireDraftSummary(parseProfileMutation(raw));
}

export async function publishCheckoutProfile(
  organisationId: string,
  draft: DraftCheckoutProfileSummary,
  mutate: CheckoutProfileMutationTransport,
): Promise<PublishedCheckoutProfileSummary> {
  const raw = await mutate(
    `${checkoutProfilesPath(organisationId)}/${encodeURIComponent(draft.profile.checkoutProfileId)}/publication`,
    "POST",
    { expectedRevision: draft.profile.revision },
    `checkout-profile-publish:${draft.profile.checkoutProfileId}:${draft.profile.revision}:${draft.configurationDigest}`,
  );
  return requirePublishedSummary(parseProfileMutation(raw));
}

export async function retireCheckoutProfile(
  organisationId: string,
  profile: PublishedCheckoutProfileSummary,
  mutate: CheckoutProfileMutationTransport,
): Promise<RetiredCheckoutProfileSummary> {
  const raw = await mutate(
    `${checkoutProfilesPath(organisationId)}/${encodeURIComponent(profile.profile.checkoutProfileId)}/retirement`,
    "POST",
    { expectedRevision: profile.profile.revision },
    `checkout-profile-retire:${profile.profile.checkoutProfileId}:${profile.profile.revision}`,
  );
  return requireRetiredSummary(parseProfileMutation(raw));
}

export async function activateCheckoutProfile(
  organisationId: string,
  storefrontId: string,
  profile: PublishedCheckoutProfileSummary,
  mutate: CheckoutProfileMutationTransport,
): Promise<CheckoutProfileActivationResult> {
  const raw = await mutate(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/storefronts/${encodeURIComponent(storefrontId)}/checkout-profile-activation`,
    "PUT",
    {
      checkoutProfileId: profile.profile.checkoutProfileId,
      checkoutProfileRevision: profile.profile.revision,
    },
    `checkout-profile-activate:${storefrontId}:${profile.profile.checkoutProfileId}:${profile.profile.revision}`,
  );
  const object = requireObject(raw, "checkout profile activation response");
  requireExactKeys(
    object,
    ["ok", "active"],
    "checkout profile activation response",
  );
  if (object.ok !== true) {
    throw new Error("The checkout profile was not activated.");
  }
  const active = requireObject(object.active, "active checkout profile");
  requireExactKeys(
    active,
    ["activation", "profile", "configurationDigest"],
    "active checkout profile",
  );
  const activation = parseCheckoutProfileActivations([active.activation])[0];
  const summary = parseProfileSummary({
    profile: active.profile,
    configurationDigest: active.configurationDigest,
  });
  if (
    activation === undefined ||
    activation.checkoutProfileId !== summary.profile.checkoutProfileId ||
    activation.checkoutProfileRevision !== summary.profile.revision ||
    activation.storefrontId !== storefrontId
  ) {
    throw new Error(
      "The checkout profile activation response does not match the request.",
    );
  }
  return { profile: requirePublishedSummary(summary), activation };
}

function requireDraftSummary(
  summary: CheckoutProfileSummary,
): DraftCheckoutProfileSummary {
  if (!isDraftSummary(summary)) {
    throw new Error("The checkout profile response is not a draft.");
  }
  return summary;
}

function requirePublishedSummary(
  summary: CheckoutProfileSummary,
): PublishedCheckoutProfileSummary {
  if (!isPublishedSummary(summary)) {
    throw new Error("The checkout profile response is not published.");
  }
  return summary;
}

function requireRetiredSummary(
  summary: CheckoutProfileSummary,
): RetiredCheckoutProfileSummary {
  if (!isRetiredSummary(summary)) {
    throw new Error("The checkout profile response is not retired.");
  }
  return summary;
}

function isDraftSummary(
  summary: CheckoutProfileSummary,
): summary is DraftCheckoutProfileSummary {
  return summary.profile.lifecycle.state === "draft";
}

function isPublishedSummary(
  summary: CheckoutProfileSummary,
): summary is PublishedCheckoutProfileSummary {
  return summary.profile.lifecycle.state === "published";
}

function isRetiredSummary(
  summary: CheckoutProfileSummary,
): summary is RetiredCheckoutProfileSummary {
  return summary.profile.lifecycle.state === "retired";
}

function checkoutProfilesPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/checkout-profiles`;
}
