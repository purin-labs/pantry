import { runtimeFetch } from "../../runtime-fetch";
import type { ApprovalActionBinding } from "../../approval-authentication";
import { digestApprovalAction } from "../../approval-authentication";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import { isCommerceActionNonce } from "../../commerce/action-model";
import {
  beginGoogleOidc,
  completeGoogleOidc,
  issueGoogleApprovalGrant,
} from "../oidc";
import {
  issueControlSession,
  listEligibleControlMemberships,
  listControlMemberships,
  renewControlSession,
  resolveUser,
  revokeControlSession,
  rotateControlSession,
  upsertUser,
  validateControlCsrf,
} from "../../data/control-plane";
import { resolveControlSupportRole } from "../../data/onboarding-support";
import type { Env } from "../../env";
import { requirePublicOrigin } from "../../public-origin";
import {
  APPROVAL_GRANT_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  authenticateControlMutation,
  authenticateControlRequest,
  authorizeOrganisationRequest,
  controlSessionError,
  parseCookies,
} from "../authorization";
import { googleConfig } from "../google-oidc-config";
import { controlError, controlHeaders, controlJson } from "../http";
import { assertNever } from "@purin-labs/std";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { resolvePantryAccountBinding } from "../../account-platform/binding";
import {
  linkPantryAccountUser,
  registerPantryOnboardingIdentity,
} from "../../account-platform/identity";
import type { ActiveControlSession } from "../../data/control-plane";
import type { Result } from "../../result";
import type { AccountPlatformError } from "../../account-platform/types";

const OIDC_STATE_COOKIE = "satyr_control_oidc_state";
// A session lasts seven days from its last use and thirty from its sign-in.
// The session read renews it at most once an hour, so most reads write nothing.
const CONTROL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTROL_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_SESSION_RENEWAL_STEP_MS = 60 * 60 * 1000;
const APPROVAL_STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export type SessionControlRoute =
  | Readonly<{ kind: "googleStart" }>
  | Readonly<{ kind: "googleCallback" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "rotateSession" }>
  | Readonly<{ kind: "logout" }>;

export function matchSessionControlRoute(
  pathname: string,
): SessionControlRoute | null {
  switch (pathname) {
    case "/v1/control/auth/google/start":
      return { kind: "googleStart" };
    case "/v1/control/auth/google/callback":
      return { kind: "googleCallback" };
    case "/v1/control/session":
      return { kind: "session" };
    case "/v1/control/session/rotate":
      return { kind: "rotateSession" };
    case "/v1/control/logout":
      return { kind: "logout" };
    default:
      return null;
  }
}

export function handleSessionControlRoute(
  request: Request,
  env: Env,
  route: SessionControlRoute,
  url: URL,
): Promise<Response> {
  switch (route.kind) {
    case "googleStart":
      return handleGoogleStart(request, env, url);
    case "googleCallback":
      return handleGoogleCallback(request, env, url);
    case "session":
      return handleSession(request, env);
    case "rotateSession":
      return handleRotateSession(request, env);
    case "logout":
      return handleLogout(request, env);
    default:
      return assertNever(route);
  }
}

async function handleGoogleStart(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  // The state cookie must be set on the origin that receives the callback. A
  // start on another host, such as a dev server that proxies /v1, would set it
  // where the callback cannot read it.
  const publicOrigin = new URL(requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN));
  if (url.host !== publicOrigin.host) {
    const headers = controlHeaders();
    headers.set(
      "location",
      `${publicOrigin.origin}${url.pathname}${url.search}`,
    );
    return new Response(null, { status: 302, headers });
  }
  const config = googleConfig(env);
  if (config === null) {
    return controlError("google_oidc_unconfigured", 503);
  }
  const purpose = url.searchParams.get("purpose");
  const now = Date.now();
  let authentication: Parameters<typeof beginGoogleOidc>[0]["authentication"] =
    { kind: "sign_in" };
  if (purpose === "approval") {
    const organisationIdRaw = url.searchParams.get("organisation");
    const actionNonceRaw = url.searchParams.get("action");
    if (
      organisationIdRaw === null ||
      actionNonceRaw === null ||
      !isCommerceActionNonce(actionNonceRaw)
    ) {
      return controlError("approval_step_up_required", 401);
    }
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "admin",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now,
    });
    const action = await organisation.getAction({
      organisationId: authorized.organisationId,
      nonce: actionNonceRaw,
      now,
    });
    if (
      !action.ok ||
      (action.value.state !== "proposed" &&
        action.value.state !== "approval_requested")
    ) {
      return controlError("approval_step_up_required", 409);
    }
    const actionDigest = await digestApprovalAction(action.value.action);
    const expiresAt = Math.min(
      action.value.action.exp,
      now + APPROVAL_STEP_UP_MAX_AGE_MS,
    );
    if (expiresAt <= now) {
      return controlError("approval_step_up_required", 409);
    }
    const challenge: ApprovalActionBinding = {
      stepUpId: crypto.randomUUID(),
      organisationId: authorized.organisationId,
      actionNonce: action.value.action.nonce.value,
      actionDigest,
      policy: { kind: "unversioned_default" },
      issuedAt: now,
      expiresAt,
    };
    authentication = { kind: "approval_step_up", challenge };
  } else if (purpose !== null && purpose !== "sign_in") {
    return controlError("oidc_callback_invalid", 400);
  }
  const started = await beginGoogleOidc({
    db: env.DB,
    config,
    redirectPath: url.searchParams.get("returnTo") ?? "/portal",
    authentication,
    now,
  });
  const headers = controlHeaders();
  headers.set("location", started.authorizationUrl);
  headers.append(
    "set-cookie",
    controlCookie(
      OIDC_STATE_COOKIE,
      started.state,
      started.expiresAt,
      true,
      "/v1/control/auth/google/callback",
    ),
  );
  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const config = googleConfig(env);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (config === null || state === null) {
    return controlError("oidc_callback_invalid", 400);
  }
  const stateCookie = parseCookies(request.headers.get("cookie")).get(
    OIDC_STATE_COOKIE,
  );
  if (stateCookie === undefined || stateCookie !== state) {
    return controlError("oidc_callback_invalid", 400);
  }
  if (code === null) {
    return oidcCallbackError("oidc_callback_invalid", 400);
  }

  const now = Date.now();
  const completed = await completeGoogleOidc({
    db: env.DB,
    config,
    state,
    code,
    now,
    fetcher: runtimeFetch,
  });
  if (!completed.ok) {
    return oidcCallbackError(completed.error.code, 401);
  }
  const identity = await upsertUser({
    db: env.DB,
    identity: completed.value.identity,
    now,
  });
  const issued = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: CONTROL_SESSION_TTL_MS,
  });
  const linked = await linkAuthenticatedAccountInstances({
    env,
    session: issued.session,
    redirectPath: completed.value.redirectPath,
    googleIdToken: completed.value.identityToken,
  });
  if (!linked.ok) {
    await revokeControlSession({ db: env.DB, session: issued.session, now });
    return oidcCallbackError(linked.error.code, 503);
  }
  const redirect = new URL(
    completed.value.redirectPath,
    requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN),
  );
  redirect.searchParams.delete("accountLink");
  redirect.searchParams.delete("accountInvitationLink");
  if (linked.value.kind === "incomplete") {
    redirect.searchParams.set("accountLink", "incomplete");
    if (linked.value.invitationError !== null)
      redirect.searchParams.set("accountInvitationLink", "failed");
  }
  const approvalGrant =
    completed.value.approvalChallenge === null
      ? undefined
      : await issueGoogleApprovalGrant(
          {
            stateHash: completed.value.approvalStateHash,
            userId: identity.userId,
            challenge: completed.value.approvalChallenge,
          },
          config.clientSecret,
        );
  const response = redirectWithControlCookies(
    redirect.toString(),
    issued.token,
    issued.csrfToken,
    issued.session.expiresAt,
    approvalGrant === undefined || completed.value.approvalChallenge === null
      ? undefined
      : {
          value: approvalGrant,
          expiresAt: completed.value.approvalChallenge.expiresAt,
        },
  );
  response.headers.append(
    "set-cookie",
    expiredCookie(OIDC_STATE_COOKIE, true, "/v1/control/auth/google/callback"),
  );
  return response;
}

function oidcCallbackError(code: string, status: number): Response {
  const response = controlError(code, status);
  response.headers.append(
    "set-cookie",
    expiredCookie(OIDC_STATE_COOKIE, true, "/v1/control/auth/google/callback"),
  );
  return response;
}

type AccountInstanceLinks =
  | Readonly<{ kind: "complete"; invitationError?: never }>
  | Readonly<{
      kind: "incomplete";
      invitationError: AccountPlatformError | null;
    }>;

type AccountInstanceLinkInput = Readonly<{
  env: Env;
  session: ActiveControlSession;
  googleIdToken: string;
}>;

async function linkAuthenticatedAccountInstance(
  input: AccountInstanceLinkInput,
  organisationId: OrganisationId,
): Promise<Result<void, AccountPlatformError>> {
  try {
    const binding = await resolvePantryAccountBinding(input.env, organisationId);
    if (!binding.ok) return binding;
    const linked = await linkPantryAccountUser(input.env, {
      binding: binding.value,
      userId: input.session.userId,
      nativeSessionId: input.session.controlSessionId,
      googleIdToken: input.googleIdToken,
    });
    return linked.ok ? { ok: true, value: undefined } : linked;
  } catch {
    return { ok: false, error: { code: "authority_unavailable" } };
  }
}

async function linkAuthenticatedAccountInstances(
  input: Readonly<{
    env: Env;
    session: ActiveControlSession;
    redirectPath: string;
    googleIdToken: string;
  }>,
): Promise<Result<AccountInstanceLinks, AccountPlatformError>> {
  const identity = await registerPantryOnboardingIdentity(
    input.env,
    input.session,
    input.googleIdToken,
  );
  if (!identity.ok) return identity;
  const grants = await listControlMemberships({
    env: input.env,
    userId: input.session.userId,
  });
  const organisations = new Set<OrganisationId>();
  for (const grant of grants) organisations.add(grant.organisationId);
  const invitationOrganisation = new URL(
    input.redirectPath,
    "https://satyr.invalid",
  ).searchParams.get("accountInvitationOrganisation");
  if (invitationOrganisation !== null) {
    const parsed = parseOrganisationId(invitationOrganisation);
    if (!parsed.ok) return { ok: false, error: { code: "scope_forbidden" } };
    organisations.add(parsed.value);
  }
  const organisationIds = Array.from(organisations);
  const links = await Promise.all(
    organisationIds.map(linkAuthenticatedAccountInstance.bind(null, input)),
  );
  let incomplete = false;
  let invitationError: AccountPlatformError | null = null;
  for (let index = 0; index < links.length; index += 1) {
    const result = links[index];
    if (result !== undefined && !result.ok) {
      incomplete = true;
      if (organisationIds[index] === invitationOrganisation)
        invitationError = result.error;
    }
  }
  return {
    ok: true,
    value: incomplete
      ? { kind: "incomplete", invitationError }
      : { kind: "complete" },
  };
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlRequest(request, env);
  if (!authenticated.ok) {
    return controlSessionError(authenticated.error);
  }
  // The three reads need only the session's user.
  const userId = authenticated.value.session.userId;
  const [identity, memberships, supportRole, renewal] = await Promise.all([
    resolveUser({ db: env.DB, userId }),
    listEligibleControlMemberships({
      env,
      session: authenticated.value.session,
    }),
    resolveControlSupportRole({ db: env.DB, userId }),
    renewSessionOnRead(request, env, authenticated.value.session),
  ]);
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const session = renewal?.session ?? authenticated.value.session;
  const response = controlJson({
    ok: true,
    identity: {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
    },
    session: {
      expiresAt: session.expiresAt,
      rotationGeneration: session.rotationGeneration,
    },
    supportRole: supportRole?.kind ?? null,
    memberships: memberships.memberships,
    membershipAvailability: memberships.availability,
  });
  if (renewal !== null) {
    appendControlCookies(
      response.headers,
      authenticated.value.token,
      renewal.csrfToken,
      session.expiresAt,
    );
  }
  return response;
}

function controlSessionExpiry(
  session: ActiveControlSession,
  now: number,
): number {
  return Math.min(
    now + CONTROL_SESSION_TTL_MS,
    session.createdAt + CONTROL_SESSION_MAX_AGE_MS,
  );
}

// The cookies are set again with the new expiry, so the CSRF value must be the
// session's own: a stale cookie from another path would replace it.
async function renewSessionOnRead(
  request: Request,
  env: Env,
  session: ActiveControlSession,
): Promise<{ session: ActiveControlSession; csrfToken: string } | null> {
  const expiresAt = controlSessionExpiry(session, Date.now());
  if (expiresAt - session.expiresAt < CONTROL_SESSION_RENEWAL_STEP_MS) {
    return null;
  }
  const csrfToken = parseCookies(request.headers.get("cookie")).get(
    CSRF_COOKIE,
  );
  if (csrfToken === undefined) return null;
  const csrf = await validateControlCsrf({ db: env.DB, session, csrfToken });
  if (!csrf.ok) return null;
  const renewed = await renewControlSession({
    db: env.DB,
    session,
    expiresAt,
  });
  return renewed === null ? null : { session: renewed, csrfToken };
}

async function handleRotateSession(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  const now = Date.now();
  const rotated = await rotateControlSession({
    db: env.DB,
    session: authenticated.value.session,
    now,
    expiresAt: controlSessionExpiry(authenticated.value.session, now),
  });
  if (!rotated.ok) {
    return controlSessionError(rotated.error);
  }
  return controlJsonWithCookies(
    { ok: true, expiresAt: rotated.value.session.expiresAt },
    rotated.value.token,
    rotated.value.csrfToken,
    rotated.value.session.expiresAt,
  );
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  await revokeControlSession({
    db: env.DB,
    session: authenticated.value.session,
    now: Date.now(),
  });
  return controlJsonWithExpiredCookies({ ok: true });
}

function redirectWithControlCookies(
  location: string,
  token: string,
  csrfToken: string,
  expiresAt: number,
  approvalGrant?: { readonly value: string; readonly expiresAt: number },
): Response {
  const headers = controlHeaders();
  headers.set("location", location);
  appendControlCookies(headers, token, csrfToken, expiresAt, approvalGrant);
  return new Response(null, { status: 302, headers });
}

function controlJsonWithCookies(
  body: unknown,
  token: string,
  csrfToken: string,
  expiresAt: number,
): Response {
  const headers = controlHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  appendControlCookies(headers, token, csrfToken, expiresAt);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function controlJsonWithExpiredCookies(body: unknown): Response {
  const headers = controlHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.append("set-cookie", expiredCookie(SESSION_COOKIE, true));
  headers.append("set-cookie", expiredCookie(CSRF_COOKIE, false));
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function appendControlCookies(
  headers: Headers,
  token: string,
  csrfToken: string,
  expiresAt: number,
  approvalGrant?: { readonly value: string; readonly expiresAt: number },
): void {
  headers.append(
    "set-cookie",
    controlCookie(SESSION_COOKIE, token, expiresAt, true),
  );
  headers.append(
    "set-cookie",
    controlCookie(CSRF_COOKIE, csrfToken, expiresAt, false),
  );
  if (approvalGrant !== undefined) {
    headers.append(
      "set-cookie",
      controlCookie(
        APPROVAL_GRANT_COOKIE,
        approvalGrant.value,
        approvalGrant.expiresAt,
        true,
      ),
    );
  }
}

function controlCookie(
  name: string,
  value: string,
  expiresAt: number,
  httpOnly: boolean,
  path = "/",
): string {
  const fields = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "Secure",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (httpOnly) {
    fields.push("HttpOnly");
  }
  return fields.join("; ");
}

function expiredCookie(name: string, httpOnly: boolean, path = "/"): string {
  return controlCookie(name, "", 0, httpOnly, path);
}
