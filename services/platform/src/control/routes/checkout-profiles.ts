import {
  parseCheckoutProfileConfiguration,
  type CheckoutProfile,
  type CheckoutProfileConfiguration,
} from "@purin-labs/commerce-contracts";
import {
  type CommerceActiveCheckoutProfileV1,
  type CommerceAdminClient,
  type CommerceClientError,
} from "@purin-labs/commerce-client";

import type { Env } from "../../env";
import type {
  ControlMutationReceiptScope,
  UnversionedControlMutationBoundary,
} from "../../data/control-mutation";
import {
  admitControlMutation,
  resolveMutationUser,
} from "../admission/control-mutation";
import {
  resolveMerchantControlContext,
  type MerchantControlContext,
} from "../commerce-merchant";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import type { Variant } from "@purin-labs/type-utils";
import { hasExactKeys, sha256Hex } from "@purin-labs/std";

export type CheckoutProfileControlRoute =
  | Readonly<{ kind: "checkoutProfiles"; organisationIdRaw: string }>
  | Readonly<{
      kind: "checkoutProfileRevision";
      organisationIdRaw: string;
      checkoutProfileIdRaw: string;
      revisionRaw: string;
    }>
  | Readonly<{
      kind: "checkoutProfileDraft";
      organisationIdRaw: string;
      checkoutProfileIdRaw: string;
    }>
  | Readonly<{
      kind: "checkoutProfilePublication";
      organisationIdRaw: string;
      checkoutProfileIdRaw: string;
    }>
  | Readonly<{
      kind: "checkoutProfileRetirement";
      organisationIdRaw: string;
      checkoutProfileIdRaw: string;
    }>
  | Readonly<{
      kind: "checkoutProfileActivation";
      organisationIdRaw: string;
      storefrontIdRaw: string;
    }>;

type CheckoutProfileMutationContext = MerchantControlContext &
  Readonly<{
    changedBy: string;
    authorized: AuthorizedOrganisationRequest;
    identity: Readonly<{
      userId: string;
      issuer: string;
      subject: string;
    }>;
  }>;

type CheckoutProfileMutationStart = Readonly<{
  context: CheckoutProfileMutationContext;
  boundary: UnversionedControlMutationBoundary;
  scope: ControlMutationReceiptScope;
  now: number;
}>;

type CheckoutProfileDraftReplacement = Readonly<{
  expectedRevision: number;
  name: string;
  configuration: CheckoutProfileConfiguration;
}>;

type CheckoutProfileDraftCreation = Readonly<{
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
}>;

export function matchCheckoutProfileControlRoute(
  pathname: string,
): CheckoutProfileControlRoute | null {
  const activation = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/storefronts\/([^/]+)\/checkout-profile-activation$/u,
  );
  if (activation !== null) {
    return {
      kind: "checkoutProfileActivation",
      organisationIdRaw: decode(activation[0]),
      storefrontIdRaw: decode(activation[1]),
    };
  }
  const revision = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/checkout-profiles\/([^/]+)\/revisions\/([^/]+)$/u,
  );
  if (revision !== null) {
    return {
      kind: "checkoutProfileRevision",
      organisationIdRaw: decode(revision[0]),
      checkoutProfileIdRaw: decode(revision[1]),
      revisionRaw: decode(revision[2]),
    };
  }
  const lifecycle = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/checkout-profiles\/([^/]+)\/(draft|publication|retirement)$/u,
  );
  if (lifecycle !== null) {
    const shared = {
      organisationIdRaw: decode(lifecycle[0]),
      checkoutProfileIdRaw: decode(lifecycle[1]),
    };
    switch (lifecycle[2]) {
      case "draft":
        return { kind: "checkoutProfileDraft", ...shared };
      case "publication":
        return { kind: "checkoutProfilePublication", ...shared };
      case "retirement":
        return { kind: "checkoutProfileRetirement", ...shared };
      default:
        throw new Error("Checkout profile lifecycle route is invalid");
    }
  }
  const profiles = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/checkout-profiles$/u,
  );
  return profiles === null
    ? null
    : { kind: "checkoutProfiles", organisationIdRaw: decode(profiles[0]) };
}

export async function handleCheckoutProfileControlRoute(
  request: Request,
  env: Env,
  route: CheckoutProfileControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "checkoutProfiles":
      return handleProfileList(request, env, route.organisationIdRaw);
    case "checkoutProfileRevision":
      return handleProfileRevision(request, env, route);
    case "checkoutProfileDraft":
      return handleProfileDraft(request, env, route);
    case "checkoutProfilePublication":
      return handleProfilePublication(request, env, route);
    case "checkoutProfileRetirement":
      return handleProfileRetirement(request, env, route);
    case "checkoutProfileActivation":
      return handleProfileActivation(request, env, route);
  }
}

async function handleProfileList(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "POST") {
    return handleProfileCreate(request, env, organisationIdRaw);
  }
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const context = await resolveCheckoutProfileReadContext(
    request,
    env,
    organisationIdRaw,
  );
  if (context instanceof Response) return context;
  const [profiles, activations, storefrontIds] = await Promise.all([
    context.client.listCheckoutProfiles(context.merchantId),
    context.client.listCheckoutProfileActivations(context.merchantId),
    context.client.listStorefrontIds(context.merchantId),
  ]);
  if (!profiles.ok) return checkoutProfileErrorResponse(profiles.error);
  if (!activations.ok) return checkoutProfileErrorResponse(activations.error);
  if (!storefrontIds.ok)
    return checkoutProfileErrorResponse(storefrontIds.error);
  return controlJson({
    ok: true,
    profiles: await Promise.all(profiles.value.map(profileSummary)),
    activations: activations.value,
    storefrontIds: storefrontIds.value,
  });
}

async function handleProfileCreate(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("checkout_profile_request_invalid", 422);
  const creation = parseDraftCreation(body.value);
  if (creation === null)
    return controlError("checkout_profile_request_invalid", 422);
  const started = await beginCheckoutProfileMutation(
    request,
    env,
    organisationIdRaw,
    body.value,
    "checkout_profile.create_draft",
  );
  if (started instanceof Response) return started;
  const created = await started.context.client.createCheckoutProfileDraft({
    schemaVersion: "underclerk.create-checkout-profile-draft.v1",
    merchantId: started.context.merchantId,
    checkoutProfileId: creation.checkoutProfileId,
    name: creation.name,
    configuration: creation.configuration,
    createdAt: new Date(started.now).toISOString(),
  });
  if (!created.ok) return checkoutProfileErrorResponse(created.error);
  const responseBody = {
    ok: true,
    profile: await profileSummary(created.value),
  };
  return completeCheckoutProfileMutation(request, env, started, responseBody);
}

async function handleProfileRevision(
  request: Request,
  env: Env,
  route: Variant<CheckoutProfileControlRoute, "checkoutProfileRevision">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const revision = parseRevision(route.revisionRaw);
  if (revision === null)
    return controlError("checkout_profile_revision_invalid", 422);
  const context = await resolveCheckoutProfileReadContext(
    request,
    env,
    route.organisationIdRaw,
  );
  if (context instanceof Response) return context;
  const profile = await context.client.readCheckoutProfile(
    context.merchantId,
    route.checkoutProfileIdRaw,
    revision,
  );
  return profile.ok
    ? controlJson({ ok: true, profile: await profileSummary(profile.value) })
    : checkoutProfileErrorResponse(profile.error);
}

async function handleProfileDraft(
  request: Request,
  env: Env,
  route: Variant<CheckoutProfileControlRoute, "checkoutProfileDraft">,
): Promise<Response> {
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("checkout_profile_request_invalid", 422);
  const replacement = parseDraftReplacement(body.value);
  if (replacement === null)
    return controlError("checkout_profile_request_invalid", 422);
  const started = await beginCheckoutProfileMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "checkout_profile.replace_draft",
  );
  if (started instanceof Response) return started;
  const updated = await started.context.client.replaceCheckoutProfileDraft({
    schemaVersion: "underclerk.replace-checkout-profile-draft.v1",
    merchantId: started.context.merchantId,
    checkoutProfileId: route.checkoutProfileIdRaw,
    expectedRevision: replacement.expectedRevision,
    name: replacement.name,
    configuration: replacement.configuration,
    updatedAt: new Date(started.now).toISOString(),
  });
  if (!updated.ok) return checkoutProfileErrorResponse(updated.error);
  const responseBody = {
    ok: true,
    profile: await profileSummary(updated.value),
  };
  return completeCheckoutProfileMutation(request, env, started, responseBody);
}

async function handleProfilePublication(
  request: Request,
  env: Env,
  route: Variant<CheckoutProfileControlRoute, "checkoutProfilePublication">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("checkout_profile_request_invalid", 422);
  const expectedRevision = parseExpectedRevision(body.value);
  if (expectedRevision === null)
    return controlError("checkout_profile_request_invalid", 422);
  const started = await beginCheckoutProfileMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "checkout_profile.publish",
  );
  if (started instanceof Response) return started;
  const draft = await started.context.client.readCheckoutProfile(
    started.context.merchantId,
    route.checkoutProfileIdRaw,
    expectedRevision,
  );
  if (!draft.ok) return checkoutProfileErrorResponse(draft.error);
  if (
    !(await checkoutProfilePaymentBindingIsPublishable(
      started.context,
      draft.value.configuration,
    ))
  ) {
    return controlError("checkout_payment_binding_uncertified", 409);
  }
  const published = await started.context.client.publishCheckoutProfile({
    schemaVersion: "underclerk.publish-checkout-profile.v1",
    merchantId: started.context.merchantId,
    checkoutProfileId: route.checkoutProfileIdRaw,
    expectedRevision,
    publishedAt: new Date(started.now).toISOString(),
    publishedBy: started.context.changedBy,
  });
  if (!published.ok) return checkoutProfileErrorResponse(published.error);
  const responseBody = {
    ok: true,
    profile: await profileSummary(published.value),
  };
  return completeCheckoutProfileMutation(request, env, started, responseBody);
}

async function handleProfileRetirement(
  request: Request,
  env: Env,
  route: Variant<CheckoutProfileControlRoute, "checkoutProfileRetirement">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("checkout_profile_request_invalid", 422);
  const expectedRevision = parseExpectedRevision(body.value);
  if (expectedRevision === null)
    return controlError("checkout_profile_request_invalid", 422);
  const started = await beginCheckoutProfileMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "checkout_profile.retire",
  );
  if (started instanceof Response) return started;
  const retired = await started.context.client.retireCheckoutProfile({
    schemaVersion: "underclerk.retire-checkout-profile.v1",
    merchantId: started.context.merchantId,
    checkoutProfileId: route.checkoutProfileIdRaw,
    expectedRevision,
    retiredAt: new Date(started.now).toISOString(),
    retiredBy: started.context.changedBy,
  });
  if (!retired.ok) return checkoutProfileErrorResponse(retired.error);
  const responseBody = {
    ok: true,
    profile: await profileSummary(retired.value),
  };
  return completeCheckoutProfileMutation(request, env, started, responseBody);
}

async function handleProfileActivation(
  request: Request,
  env: Env,
  route: Variant<CheckoutProfileControlRoute, "checkoutProfileActivation">,
): Promise<Response> {
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("checkout_profile_request_invalid", 422);
  const activation = parseActivationRequest(body.value);
  if (activation === null)
    return controlError("checkout_profile_request_invalid", 422);
  const started = await beginCheckoutProfileMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "checkout_profile.activate",
  );
  if (started instanceof Response) return started;
  const profile = await started.context.client.readCheckoutProfile(
    started.context.merchantId,
    activation.checkoutProfileId,
    activation.checkoutProfileRevision,
  );
  if (!profile.ok) return checkoutProfileErrorResponse(profile.error);
  if (
    !(await checkoutProfilePaymentBindingIsPublishable(
      started.context,
      profile.value.configuration,
    ))
  ) {
    return controlError("checkout_payment_binding_uncertified", 409);
  }
  const activated = await started.context.client.activateCheckoutProfile({
    schemaVersion: "underclerk.activate-checkout-profile.v1",
    merchantId: started.context.merchantId,
    storefrontId: route.storefrontIdRaw,
    checkoutProfileId: activation.checkoutProfileId,
    checkoutProfileRevision: activation.checkoutProfileRevision,
    activatedAt: new Date(started.now).toISOString(),
    activatedBy: started.context.changedBy,
  });
  if (!activated.ok) return checkoutProfileErrorResponse(activated.error);
  const responseBody = {
    ok: true,
    active: await activeProfileSummary(activated.value),
  };
  return completeCheckoutProfileMutation(request, env, started, responseBody);
}

// A profile may go live only on a binding that Commerce can charge now: an
// active Stripe account or a linked Square location (Plan 80 step 5).
async function checkoutProfilePaymentBindingIsPublishable(
  context: Readonly<{ client: CommerceAdminClient; merchantId: string }>,
  configuration: CheckoutProfileConfiguration,
): Promise<boolean> {
  const accounts = await context.client.listPaymentAccounts(context.merchantId);
  return (
    accounts.ok &&
    accounts.value.accounts.some(
      (account) =>
        account.paymentProviderBindingId ===
          configuration.paymentPolicy.paymentProviderBindingId &&
        account.state === "active",
    )
  );
}

async function resolveCheckoutProfileReadContext(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<MerchantControlContext | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  return resolveMerchantControlContext(env, authorized);
}

async function resolveCheckoutProfileMutationContext(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<CheckoutProfileMutationContext | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const authority = await resolveMerchantControlContext(env, authorized);
  if (authority instanceof Response) return authority;
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  return {
    ...authority,
    changedBy: authorized.authenticated.session.userId,
    authorized,
    identity,
  };
}

async function beginCheckoutProfileMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  body: JsonRecord,
  operation: string,
): Promise<CheckoutProfileMutationStart | Response> {
  const context = await resolveCheckoutProfileMutationContext(
    request,
    env,
    organisationIdRaw,
  );
  if (context instanceof Response) return context;
  // The receipt is in the Organisation's database, beside its effect
  // (recordCommerceMutationReceipt), so the replay reads it there.
  const admitted = await admitControlMutation({
    request,
    authorized: context.authorized,
    body,
    boundary: "unversioned",
    route: new URL(request.url).pathname,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  return { context, ...admitted, now: Date.now() };
}

async function completeCheckoutProfileMutation(
  request: Request,
  env: Env,
  started: CheckoutProfileMutationStart,
  responseBody: unknown,
): Promise<Response> {
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized: started.context.authorized,
    identity: started.context.identity,
    scope: started.scope,
    boundary: started.boundary,
    request,
    responseBody,
    now: started.now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function profileSummary(profile: CheckoutProfile): Promise<
  Readonly<{
    profile: CheckoutProfile;
    configurationDigest: string;
  }>
> {
  return {
    profile,
    configurationDigest: await sha256Hex(JSON.stringify(profile.configuration)),
  };
}

async function activeProfileSummary(
  active: CommerceActiveCheckoutProfileV1,
): Promise<
  Readonly<{
    activation: CommerceActiveCheckoutProfileV1["activation"];
    profile: CheckoutProfile;
    configurationDigest: string;
  }>
> {
  return {
    activation: active.activation,
    profile: active.profile,
    configurationDigest: await sha256Hex(
      JSON.stringify(active.profile.configuration),
    ),
  };
}

function checkoutProfileErrorResponse(error: CommerceClientError): Response {
  switch (error.kind) {
    case "http":
      if (error.status === 404)
        return controlError("checkout_profile_not_found", 404);
      if (error.status === 400)
        return controlError("checkout_profile_request_invalid", 422);
      if (error.status === 409)
        return controlError("checkout_profile_conflict", 409);
      return controlError("underclerk_unavailable", 503);
    case "rejected":
      return controlError("checkout_profile_conflict", 409);
    case "network":
    case "invalid_response":
      return controlError("underclerk_unavailable", 503);
  }
}

function parseDraftCreation(
  raw: JsonRecord,
): CheckoutProfileDraftCreation | null {
  if (!hasExactKeys(raw, ["checkoutProfileId", "name", "configuration"]))
    return null;
  const checkoutProfileId = parseText(raw.checkoutProfileId);
  const name = parseText(raw.name);
  const configuration = parseCheckoutProfileConfiguration(raw.configuration);
  return checkoutProfileId === null || name === null || !configuration.ok
    ? null
    : { checkoutProfileId, name, configuration: configuration.value };
}

function parseDraftReplacement(
  raw: JsonRecord,
): CheckoutProfileDraftReplacement | null {
  if (!hasExactKeys(raw, ["expectedRevision", "name", "configuration"]))
    return null;
  const expectedRevision = parseRevision(raw.expectedRevision);
  const name = parseText(raw.name);
  const configuration = parseCheckoutProfileConfiguration(raw.configuration);
  return expectedRevision === null || name === null || !configuration.ok
    ? null
    : { expectedRevision, name, configuration: configuration.value };
}

function parseActivationRequest(raw: JsonRecord): Readonly<{
  checkoutProfileId: string;
  checkoutProfileRevision: number;
}> | null {
  if (!hasExactKeys(raw, ["checkoutProfileId", "checkoutProfileRevision"]))
    return null;
  const checkoutProfileId = parseText(raw.checkoutProfileId);
  const checkoutProfileRevision = parseRevision(raw.checkoutProfileRevision);
  return checkoutProfileId === null || checkoutProfileRevision === null
    ? null
    : { checkoutProfileId, checkoutProfileRevision };
}

function parseExpectedRevision(body: JsonRecord): number | null {
  if (!hasExactKeys(body, ["expectedRevision"])) return null;
  return parseRevision(body.expectedRevision);
}

function parseText(raw: unknown): string | null {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 255 &&
    raw.trim() === raw
    ? raw
    : null;
}

function parseRevision(raw: unknown): number | null {
  if (typeof raw === "string" && /^[1-9][0-9]*$/u.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : null;
}

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Checkout profile route capture is missing");
  return decodeURIComponent(value);
}
