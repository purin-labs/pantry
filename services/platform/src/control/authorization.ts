import type { OrganisationAdmissionAction } from "@purin-labs/contracts";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  activeOrganisationMembershipFencedRead,
  authorizeOrganisationControl,
  parseFencedOrganisationMembership,
  resolveControlSession,
  validateControlCsrf,
  type ActiveControlSession,
  type ActiveOrganisationMembership,
  type ControlRole,
  type ControlSessionError,
  type OrganisationMembershipRow,
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";
import { controlError } from "./http";

export const SESSION_COOKIE = "pantry_session";
export const CSRF_COOKIE = "pantry_csrf";
const CSRF_HEADER = "x-pantry-csrf";
export const APPROVAL_GRANT_COOKIE = "pantry_approval";

export type AuthenticatedControlRequest = {
  readonly session: ActiveControlSession;
  readonly token: string;
};

export type AuthorizedOrganisationRequest = {
  readonly ok: true;
  readonly executionScope: OrganisationExecutionScope;
  readonly organisationId: OrganisationId;
  readonly authenticated: AuthenticatedControlRequest;
  readonly membership: ActiveOrganisationMembership;
};

type AuthenticatedControlResult =
  | { readonly ok: true; readonly value: AuthenticatedControlRequest }
  | { readonly ok: false; readonly response: Response };

/**
 * A mutation asks the access check for `execute` unless it names another
 * action: a write that only opens a view for its reader asks for `disclose`.
 */
export async function authorizeOrganisationRequest(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  role: ControlRole,
  mutation: boolean,
  action: OrganisationAdmissionAction = mutation ? "execute" : "disclose",
): Promise<
  | AuthorizedOrganisationRequest
  | { readonly ok: false; readonly response: Response }
> {
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return { ok: false, response: controlError("organisation_not_found", 404) };
  }
  const authentication = mutation
    ? authenticateControlMutation(request, env)
    : authenticateControlRead(request, env);
  // A request that presents no session is refused before any other read.
  if (
    parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE) ===
    undefined
  ) {
    const refused = await authentication;
    if (!refused.ok) return refused;
  }
  // The session read and the placement read do not depend on each other, so
  // they share one wait. The membership is then read in one statement with
  // the regional fence, so it comes from the placement that the fence admits.
  const resolution =
    OrganisationExecutionScope.resolveWithRead<OrganisationMembershipRow>(
      env,
      organisationId.value,
      async function membershipRead() {
        const authenticated = await authentication;
        return authenticated.ok
          ? activeOrganisationMembershipFencedRead(
              authenticated.value.session.userId,
            )
          : null;
      },
    ).then(resolvedScope, failedScope);
  // The session decides first, whatever the placement read gave.
  const authenticated = await authentication;
  if (!authenticated.ok) return authenticated;
  const settled = await resolution;
  if (settled.kind === "failed") throw settled.error;
  const resolved = settled.value;
  if (!resolved.ok)
    return { ok: false, response: controlError(resolved.error.code, 409) };
  if (resolved.value === null)
    throw new Error("organisation membership read was withdrawn");
  const authorization = await authorizeOrganisationControl({
    db: resolved.value.scope.database,
    accountAccess: resolved.value.scope.accountAccess,
    action,
    session: authenticated.value.session,
    organisationId: organisationId.value,
    requiredRole: role,
    membership: parseFencedOrganisationMembership(resolved.value.row),
  });
  return authorization.ok
    ? {
        ok: true,
        organisationId: organisationId.value,
        executionScope: resolved.value.scope,
        authenticated: authenticated.value,
        membership: authorization.value.membership,
      }
    : {
        ok: false,
        response: controlError(
          authorization.error.code,
          authorization.error.code === "authority_unavailable" ? 503 : 404,
        ),
      };
}

type ScopeWithMembership = Awaited<
  ReturnType<
    typeof OrganisationExecutionScope.resolveWithRead<OrganisationMembershipRow>
  >
>;

function resolvedScope(value: ScopeWithMembership) {
  return { kind: "resolved", value } as const;
}

function failedScope(error: unknown) {
  return { kind: "failed", error } as const;
}

export async function authenticateControlRead(
  request: Request,
  env: Env,
): Promise<AuthenticatedControlResult> {
  const authenticated = await authenticateControlRequest(request, env);
  return authenticated.ok
    ? authenticated
    : { ok: false, response: controlSessionError(authenticated.error) };
}

export async function authenticateControlMutation(
  request: Request,
  env: Env,
): Promise<AuthenticatedControlResult> {
  if (
    request.headers.get("origin") !==
    requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN)
  ) {
    return { ok: false, response: controlError("origin_invalid", 403) };
  }
  const authenticated = await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated;

  const cookies = parseCookies(request.headers.get("cookie"));
  const csrfCookie = cookies.get(CSRF_COOKIE);
  const csrfHeader = request.headers.get(CSRF_HEADER);
  if (
    csrfCookie === undefined ||
    csrfHeader === null ||
    csrfCookie !== csrfHeader
  ) {
    return { ok: false, response: controlError("csrf_invalid", 403) };
  }
  const valid = await validateControlCsrf({
    db: env.DB,
    session: authenticated.value.session,
    csrfToken: csrfHeader,
  });
  return valid.ok
    ? authenticated
    : { ok: false, response: controlError("csrf_invalid", 403) };
}

export async function authenticateControlRequest(
  request: Request,
  env: Env,
): Promise<
  | { readonly ok: true; readonly value: AuthenticatedControlRequest }
  | { readonly ok: false; readonly error: ControlSessionError }
> {
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (token === undefined) {
    return { ok: false, error: { code: "control_session_missing" } };
  }
  const session = await resolveControlSession({
    db: env.DB,
    token,
    now: Date.now(),
  });
  return session.ok
    ? { ok: true, value: { session: session.value, token } }
    : session;
}

export function parseCookies(
  header: string | null,
): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) return cookies;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(
      part.slice(0, separator).trim(),
      decodeURIComponent(part.slice(separator + 1).trim()),
    );
  }
  return cookies;
}

export function controlSessionError(error: ControlSessionError): Response {
  return controlError(error.code, 401);
}
