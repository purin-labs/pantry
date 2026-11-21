import {
  COMMERCE_MACHINES,
  commerceTransition,
  type CheckoutProfile,
  type CheckoutProfileConfiguration,
  type CheckoutProfileLifecycle,
  type CommerceInvalidTransition,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";
import {
  insertProfile,
  listProfileActivations,
  listLatestProfiles,
  listStorefrontIds,
  merchantExists,
  profileExists,
  readActivationForProfile,
  readActiveProfile,
  readLatestProfile,
  readProfile,
  storefrontExists,
  updateProfileLifecycle,
  writeActivation,
  type ActiveStorefrontCheckoutProfile,
  type CheckoutProfileActivation,
} from "./checkout-profile-persistence.ts";
import { isPositiveInteger } from "@purin-labs/std";

export type {
  ActiveStorefrontCheckoutProfile,
  CheckoutProfileActivation,
} from "./checkout-profile-persistence.ts";

type CheckoutProfileState = CheckoutProfileLifecycle["state"];

type CheckoutProfileCommandError =
  | Readonly<{
      code: "invalid_profile";
      field: string;
    }>
  | Readonly<{
      code: "merchant_not_found";
      merchantId: string;
    }>
  | Readonly<{
      code: "profile_exists";
      checkoutProfileId: string;
    }>
  | Readonly<{
      code: "profile_not_found";
      checkoutProfileId: string;
    }>
  | Readonly<{
      code: "storefront_not_found";
      storefrontId: string;
    }>
  | Readonly<{
      code: "revision_conflict";
      expectedRevision: number;
      actualRevision: number;
    }>
  | Readonly<{
      code: "invalid_lifecycle";
      requiredState: CheckoutProfileState;
      actualState: CheckoutProfileState;
    }>
  | Readonly<{
      code: "profile_active";
      storefrontId: string;
    }>;

export type CheckoutProfileCommandResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: CheckoutProfileCommandError }>;

export type CreateCheckoutProfileDraft = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
  createdAt: string;
}>;

export type ReplaceCheckoutProfileDraft = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  name: string;
  configuration: CheckoutProfileConfiguration;
  updatedAt: string;
}>;

export type PublishCheckoutProfile = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  publishedAt: string;
  publishedBy: string;
}>;

export type RetireCheckoutProfile = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  retiredAt: string;
  retiredBy: string;
}>;

export type ActivateCheckoutProfile = Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}>;

type InstallPublishedCheckoutProfileTemplate = Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
  installedAt: string;
  installedBy: string;
}>;

type NormalizedCreateDraft = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
  createdAt: string;
}>;

/** The profile revision that a replace, a publish or a retire names. */
type ProfileTarget = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
}>;

type NormalizedReplaceDraft = ProfileTarget &
  Readonly<{
    name: string;
    configuration: CheckoutProfileConfiguration;
    updatedAt: string;
  }>;

type NormalizedPublish = ProfileTarget &
  Readonly<{
    publishedAt: string;
    publishedBy: string;
  }>;

type NormalizedRetire = ProfileTarget &
  Readonly<{
    retiredAt: string;
    retiredBy: string;
  }>;

type NormalizedActivation = CheckoutProfileActivation;

export class CheckoutProfileService {
  readonly #database: CommerceDatabase;

  constructor(database: CommerceDatabase) {
    this.#database = database;
  }

  createDraft(
    input: CreateCheckoutProfileDraft,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    const normalized = normalizeCreateDraft(input);
    if (!normalized.ok) return normalized;
    return this.#database.transaction(
      createDraftTransaction.bind(undefined, this.#database, normalized.value),
    );
  }

  replaceDraft(
    input: ReplaceCheckoutProfileDraft,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    const normalized = normalizeReplaceDraft(input);
    if (!normalized.ok) return normalized;
    return this.#database.transaction(
      replaceDraftTransaction.bind(undefined, this.#database, normalized.value),
    );
  }

  publish(
    input: PublishCheckoutProfile,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    const normalized = normalizePublish(input);
    if (!normalized.ok) return normalized;
    return this.#database.transaction(
      publishTransaction.bind(undefined, this.#database, normalized.value),
    );
  }

  retire(
    input: RetireCheckoutProfile,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    const normalized = normalizeRetire(input);
    if (!normalized.ok) return normalized;
    return this.#database.transaction(
      retireTransaction.bind(undefined, this.#database, normalized.value),
    );
  }

  activate(
    input: ActivateCheckoutProfile,
  ): CheckoutProfileCommandResult<ActiveStorefrontCheckoutProfile> {
    const normalized = normalizeActivation(input);
    if (!normalized.ok) return normalized;
    return this.#database.transaction(
      activateTransaction.bind(undefined, this.#database, normalized.value),
    );
  }

  installPublishedTemplateWithinTransaction(
    input: InstallPublishedCheckoutProfileTemplate,
  ): CheckoutProfileCommandResult<ActiveStorefrontCheckoutProfile> {
    const created = normalizeCreateDraft({
      merchantId: input.merchantId,
      checkoutProfileId: input.checkoutProfileId,
      name: input.name,
      configuration: input.configuration,
      createdAt: input.installedAt,
    });
    if (!created.ok) return created;
    const draft = createDraftTransaction(this.#database, created.value);
    if (!draft.ok) return draft;
    const publication = normalizePublish({
      merchantId: draft.value.merchantId,
      checkoutProfileId: draft.value.checkoutProfileId,
      expectedRevision: draft.value.revision,
      publishedAt: input.installedAt,
      publishedBy: input.installedBy,
    });
    if (!publication.ok) return publication;
    const published = publishTransaction(this.#database, publication.value);
    if (!published.ok) return published;
    const activation = normalizeActivation({
      merchantId: published.value.merchantId,
      storefrontId: input.storefrontId,
      checkoutProfileId: published.value.checkoutProfileId,
      checkoutProfileRevision: published.value.revision,
      activatedAt: input.installedAt,
      activatedBy: input.installedBy,
    });
    return activation.ok
      ? activateTransaction(this.#database, activation.value)
      : activation;
  }

  read(
    merchantId: string,
    checkoutProfileId: string,
    revision: number,
  ): CheckoutProfile | undefined {
    const normalizedMerchantId = requireIdentity(merchantId, "merchantId");
    const normalizedProfileId = requireIdentity(
      checkoutProfileId,
      "checkoutProfileId",
    );
    if (
      !normalizedMerchantId.ok ||
      !normalizedProfileId.ok ||
      !isPositiveInteger(revision)
    ) {
      return undefined;
    }
    return readProfile(
      this.#database,
      normalizedMerchantId.value,
      normalizedProfileId.value,
      revision,
    );
  }

  listLatest(merchantId: string): readonly CheckoutProfile[] {
    const normalized = requireIdentity(merchantId, "merchantId");
    if (!normalized.ok) return [];
    return listLatestProfiles(this.#database, normalized.value);
  }

  listActivations(merchantId: string): readonly CheckoutProfileActivation[] {
    const normalized = requireIdentity(merchantId, "merchantId");
    if (!normalized.ok) return [];
    return listProfileActivations(this.#database, normalized.value);
  }

  listStorefrontIds(merchantId: string): readonly string[] {
    const normalized = requireIdentity(merchantId, "merchantId");
    if (!normalized.ok) return [];
    return listStorefrontIds(this.#database, normalized.value);
  }

  readActiveForStorefront(
    merchantId: string,
    storefrontId: string,
  ): ActiveStorefrontCheckoutProfile | undefined {
    const normalizedMerchantId = requireIdentity(merchantId, "merchantId");
    const normalizedStorefrontId = requireIdentity(
      storefrontId,
      "storefrontId",
    );
    if (!normalizedMerchantId.ok || !normalizedStorefrontId.ok)
      return undefined;
    return readActiveProfile(
      this.#database,
      normalizedMerchantId.value,
      normalizedStorefrontId.value,
    );
  }
}

function normalizeCreateDraft(
  input: CreateCheckoutProfileDraft,
): CheckoutProfileCommandResult<NormalizedCreateDraft> {
  const merchantId = requireIdentity(input.merchantId, "merchantId");
  if (!merchantId.ok) return merchantId;
  const checkoutProfileId = requireIdentity(
    input.checkoutProfileId,
    "checkoutProfileId",
  );
  if (!checkoutProfileId.ok) return checkoutProfileId;
  const name = requireIdentity(input.name, "name");
  if (!name.ok) return name;
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  return {
    ok: true,
    value: {
      merchantId: merchantId.value,
      checkoutProfileId: checkoutProfileId.value,
      name: name.value,
      configuration: input.configuration,
      createdAt: createdAt.value,
    },
  };
}

function normalizeReplaceDraft(
  input: ReplaceCheckoutProfileDraft,
): CheckoutProfileCommandResult<NormalizedReplaceDraft> {
  const target = normalizeProfileTarget(input);
  if (!target.ok) return target;
  const name = requireIdentity(input.name, "name");
  if (!name.ok) return name;
  const updatedAt = requireTimestamp(input.updatedAt, "updatedAt");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      ...target.value,
      name: name.value,
      configuration: input.configuration,
      updatedAt: updatedAt.value,
    },
  };
}

function normalizePublish(
  input: PublishCheckoutProfile,
): CheckoutProfileCommandResult<NormalizedPublish> {
  const target = normalizeProfileTarget(input);
  if (!target.ok) return target;
  const publishedAt = requireTimestamp(input.publishedAt, "publishedAt");
  if (!publishedAt.ok) return publishedAt;
  const publishedBy = requireIdentity(input.publishedBy, "publishedBy");
  if (!publishedBy.ok) return publishedBy;
  return {
    ok: true,
    value: {
      ...target.value,
      publishedAt: publishedAt.value,
      publishedBy: publishedBy.value,
    },
  };
}

function normalizeRetire(
  input: RetireCheckoutProfile,
): CheckoutProfileCommandResult<NormalizedRetire> {
  const target = normalizeProfileTarget(input);
  if (!target.ok) return target;
  const retiredAt = requireTimestamp(input.retiredAt, "retiredAt");
  if (!retiredAt.ok) return retiredAt;
  const retiredBy = requireIdentity(input.retiredBy, "retiredBy");
  if (!retiredBy.ok) return retiredBy;
  return {
    ok: true,
    value: {
      ...target.value,
      retiredAt: retiredAt.value,
      retiredBy: retiredBy.value,
    },
  };
}

// The profile and the revision that a replace, a publish or a retire names.
function normalizeProfileTarget(
  input: ProfileTarget,
): CheckoutProfileCommandResult<ProfileTarget> {
  const merchantId = requireIdentity(input.merchantId, "merchantId");
  if (!merchantId.ok) return merchantId;
  const checkoutProfileId = requireIdentity(
    input.checkoutProfileId,
    "checkoutProfileId",
  );
  if (!checkoutProfileId.ok) return checkoutProfileId;
  const expectedRevision = requireRevision(
    input.expectedRevision,
    "expectedRevision",
  );
  if (!expectedRevision.ok) return expectedRevision;
  return {
    ok: true,
    value: {
      merchantId: merchantId.value,
      checkoutProfileId: checkoutProfileId.value,
      expectedRevision: expectedRevision.value,
    },
  };
}

function normalizeActivation(
  input: ActivateCheckoutProfile,
): CheckoutProfileCommandResult<NormalizedActivation> {
  const merchantId = requireIdentity(input.merchantId, "merchantId");
  if (!merchantId.ok) return merchantId;
  const storefrontId = requireIdentity(input.storefrontId, "storefrontId");
  if (!storefrontId.ok) return storefrontId;
  const checkoutProfileId = requireIdentity(
    input.checkoutProfileId,
    "checkoutProfileId",
  );
  if (!checkoutProfileId.ok) return checkoutProfileId;
  const checkoutProfileRevision = requireRevision(
    input.checkoutProfileRevision,
    "checkoutProfileRevision",
  );
  if (!checkoutProfileRevision.ok) return checkoutProfileRevision;
  const activatedAt = requireTimestamp(input.activatedAt, "activatedAt");
  if (!activatedAt.ok) return activatedAt;
  const activatedBy = requireIdentity(input.activatedBy, "activatedBy");
  if (!activatedBy.ok) return activatedBy;
  return {
    ok: true,
    value: {
      merchantId: merchantId.value,
      storefrontId: storefrontId.value,
      checkoutProfileId: checkoutProfileId.value,
      checkoutProfileRevision: checkoutProfileRevision.value,
      activatedAt: activatedAt.value,
      activatedBy: activatedBy.value,
    },
  };
}

function createDraftTransaction(
  database: CommerceDatabase,
  input: NormalizedCreateDraft,
): CheckoutProfileCommandResult<CheckoutProfile> {
  if (!merchantExists(database, input.merchantId)) {
    return {
      ok: false,
      error: { code: "merchant_not_found", merchantId: input.merchantId },
    };
  }
  if (profileExists(database, input.merchantId, input.checkoutProfileId)) {
    return {
      ok: false,
      error: {
        code: "profile_exists",
        checkoutProfileId: input.checkoutProfileId,
      },
    };
  }
  const profile: CheckoutProfile = {
    checkoutProfileId: input.checkoutProfileId,
    merchantId: input.merchantId,
    revision: 1,
    name: input.name,
    configuration: input.configuration,
    lifecycle: {
      state: "draft",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
  insertProfile(database, profile, input.createdAt);
  return { ok: true, value: profile };
}

function replaceDraftTransaction(
  database: CommerceDatabase,
  input: NormalizedReplaceDraft,
): CheckoutProfileCommandResult<CheckoutProfile> {
  const target = readTargetProfile(database, input);
  if (!target.ok) return target;
  const current = target.value;
  const replace = commerceTransition(
    "checkout_profile",
    current.lifecycle,
    "replace",
  );
  if (!replace.allowed) return refusedLifecycle(replace.refusal);
  if (Date.parse(input.updatedAt) < Date.parse(replace.from.updatedAt)) {
    return invalidProfile("updatedAt");
  }
  const profile: CheckoutProfile = {
    checkoutProfileId: current.checkoutProfileId,
    merchantId: current.merchantId,
    revision: current.revision + 1,
    name: input.name,
    configuration: input.configuration,
    lifecycle: {
      state: replace.to,
      createdAt: replace.from.createdAt,
      updatedAt: input.updatedAt,
    },
  };
  insertProfile(database, profile, input.updatedAt);
  return { ok: true, value: profile };
}

function publishTransaction(
  database: CommerceDatabase,
  input: NormalizedPublish,
): CheckoutProfileCommandResult<CheckoutProfile> {
  const target = readTargetProfile(database, input);
  if (!target.ok) return target;
  const current = target.value;
  const publish = commerceTransition(
    "checkout_profile",
    current.lifecycle,
    "publish",
  );
  if (!publish.allowed) return refusedLifecycle(publish.refusal);
  if (Date.parse(input.publishedAt) < Date.parse(publish.from.updatedAt)) {
    return invalidProfile("publishedAt");
  }
  const profile: CheckoutProfile = {
    checkoutProfileId: current.checkoutProfileId,
    merchantId: current.merchantId,
    revision: current.revision,
    name: current.name,
    configuration: current.configuration,
    lifecycle: {
      state: "published",
      publishedAt: input.publishedAt,
      publishedBy: input.publishedBy,
    },
  };
  updateProfileLifecycle(database, profile);
  return { ok: true, value: profile };
}

function retireTransaction(
  database: CommerceDatabase,
  input: NormalizedRetire,
): CheckoutProfileCommandResult<CheckoutProfile> {
  const target = readTargetProfile(database, input);
  if (!target.ok) return target;
  const current = target.value;
  const retire = commerceTransition(
    "checkout_profile",
    current.lifecycle,
    "retire",
  );
  if (!retire.allowed) return refusedLifecycle(retire.refusal);
  const active = readActivationForProfile(
    database,
    current.merchantId,
    current.checkoutProfileId,
    current.revision,
  );
  if (active !== undefined) {
    return {
      ok: false,
      error: { code: "profile_active", storefrontId: active.storefrontId },
    };
  }
  if (Date.parse(input.retiredAt) < Date.parse(retire.from.publishedAt)) {
    return invalidProfile("retiredAt");
  }
  const profile: CheckoutProfile = {
    checkoutProfileId: current.checkoutProfileId,
    merchantId: current.merchantId,
    revision: current.revision,
    name: current.name,
    configuration: current.configuration,
    lifecycle: {
      state: retire.to,
      publishedAt: retire.from.publishedAt,
      retiredAt: input.retiredAt,
      retiredBy: input.retiredBy,
    },
  };
  updateProfileLifecycle(database, profile);
  return { ok: true, value: profile };
}

function activateTransaction(
  database: CommerceDatabase,
  input: NormalizedActivation,
): CheckoutProfileCommandResult<ActiveStorefrontCheckoutProfile> {
  if (!storefrontExists(database, input.merchantId, input.storefrontId)) {
    return {
      ok: false,
      error: { code: "storefront_not_found", storefrontId: input.storefrontId },
    };
  }
  const profile = readProfile(
    database,
    input.merchantId,
    input.checkoutProfileId,
    input.checkoutProfileRevision,
  );
  if (profile === undefined) {
    return {
      ok: false,
      error: {
        code: "profile_not_found",
        checkoutProfileId: input.checkoutProfileId,
      },
    };
  }
  const activate = commerceTransition(
    "checkout_profile",
    profile.lifecycle,
    "activate",
  );
  if (!activate.allowed) return refusedLifecycle(activate.refusal);
  const current = readActiveProfile(
    database,
    input.merchantId,
    input.storefrontId,
  );
  if (
    current !== undefined &&
    current.activation.checkoutProfileId === input.checkoutProfileId &&
    current.activation.checkoutProfileRevision === input.checkoutProfileRevision
  ) {
    return { ok: true, value: current };
  }
  writeActivation(database, input);
  return { ok: true, value: { activation: input, profile } };
}

// The latest revision of the profile that a command names, when it is the
// revision that the command expects.
function readTargetProfile(
  database: CommerceDatabase,
  input: ProfileTarget,
): CheckoutProfileCommandResult<CheckoutProfile> {
  const current = readLatestProfile(
    database,
    input.merchantId,
    input.checkoutProfileId,
  );
  if (current === undefined) {
    return {
      ok: false,
      error: {
        code: "profile_not_found",
        checkoutProfileId: input.checkoutProfileId,
      },
    };
  }
  const revision = requireExpectedRevision(current, input.expectedRevision);
  return revision.ok ? { ok: true, value: current } : revision;
}

function requireExpectedRevision(
  profile: CheckoutProfile,
  expectedRevision: number,
): CheckoutProfileCommandResult<true> {
  return profile.revision === expectedRevision
    ? { ok: true, value: true }
    : {
        ok: false,
        error: {
          code: "revision_conflict",
          expectedRevision,
          actualRevision: profile.revision,
        },
      };
}

function requireIdentity(
  raw: string,
  field: string,
): CheckoutProfileCommandResult<string> {
  return raw.length > 0 && raw.length <= 255 && raw.trim() === raw
    ? { ok: true, value: raw }
    : invalidProfile(field);
}

function requireRevision(
  raw: number,
  field: string,
): CheckoutProfileCommandResult<number> {
  return isPositiveInteger(raw)
    ? { ok: true, value: raw }
    : invalidProfile(field);
}

function requireTimestamp(
  raw: string,
  field: string,
): CheckoutProfileCommandResult<string> {
  if (raw.trim() !== raw || raw.length === 0) return invalidProfile(field);
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds)
    ? { ok: true, value: new Date(milliseconds).toISOString() }
    : invalidProfile(field);
}

function invalidProfile(field: string): CheckoutProfileCommandResult<never> {
  return { ok: false, error: { code: "invalid_profile", field } };
}

/**
 * The profile machine's refusal in this service's error shape: the state
 * that the event needs, and the state that the profile is in.
 */
function refusedLifecycle(
  refusal: CommerceInvalidTransition<"checkout_profile">,
): CheckoutProfileCommandResult<never> {
  const required = COMMERCE_MACHINES.checkout_profile.transitions.find(
    (transition) => transition.event === refusal.event,
  )?.from[0];
  if (required === undefined)
    throw new Error(`Checkout profile event ${refusal.event} has no state`);
  return invalidLifecycle(required, refusal.state);
}

function invalidLifecycle(
  requiredState: CheckoutProfileState,
  actualState: CheckoutProfileState,
): CheckoutProfileCommandResult<never> {
  return {
    ok: false,
    error: { code: "invalid_lifecycle", requiredState, actualState },
  };
}
