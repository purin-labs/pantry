import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readStringField,
  readOrganisationIdField,
  readWorkspaceIdField,
} from "@purin-labs/contracts/boundary";
import {
  consumeIdentityLink,
  issueIdentityLink,
  parseIdentityLinkToken,
  resolveIdentityLink,
  type ConsumeIdentityLinkError,
  type ResolveIdentityLinkError,
} from "@purin-labs/surface-slack/server/data/identity-link";
import {
  resolveControlSession,
  validateControlCsrf,
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonObject,
} from "@purin-labs/kernel/http";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import { parseSlackUserId } from "@purin-labs/surface-slack/server/events";
import { assertNever } from "@purin-labs/std";
import { identityLinkBrowserUrl } from "@purin-labs/surface-slack/server/slack-ingress/support";
import {
  decodePathSegment,
  fieldErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  isLocalDebugRequest,
  jsonBodyErrorResponse,
} from "@purin-labs/control/worker/gateway/request-helpers";

export async function handleIssueIdentityLink(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (
    !isLocalDebugRequest(request) &&
    !isAuthorizedOrganisationAdminRequest(request, env)
  ) {
    return notFound();
  }

  const requestId = newRequestId();

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const workspaceId = readWorkspaceIdField(body.value);
  const externalUserId = readStringField(body.value, "externalUserId");

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  if (!workspaceId.ok) {
    return fieldErrorResponse(workspaceId.error);
  }

  if (!externalUserId.ok) {
    return fieldErrorResponse(externalUserId.error);
  }

  const slackUserId = parseSlackUserId(externalUserId.value, "externalUserId");
  if (!slackUserId.ok) {
    return fieldErrorResponse({
      code: "invalid_field",
      field: "externalUserId",
    });
  }

  const now = Date.now();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "Organisation region is unavailable.",
      503,
    );
  const issued = await issueIdentityLink({
    env,
    organisationId: organisationId.value,
    workspaceId: workspaceId.value,
    externalUserId: slackUserId.value,
    source: { kind: "admin" },
    now,
    expiresAt: now + 10 * 60 * 1000,
  });

  if (!issued.ok) {
    const status =
      issued.error.code === "slack_workspace_not_found"
        ? 404
        : issued.error.code === "invalid_expiry"
          ? 400
          : 409;
    return errorResponse(
      issued.error.code,
      "Identity link invitation was not issued.",
      status,
    );
  }

  traceLog("identity_link.issued", {
    requestId,
    organisation_id: issued.value.organisationId,
    workspace_connection_id: issued.value.workspaceConnectionId,
    workspace_id: issued.value.workspaceId,
    external_user_id: issued.value.externalUserId,
    expires_at: issued.value.expiresAt,
  });

  return identityLinkJsonResponse(
    {
      ok: true,
      challengeId: issued.value.challengeId,
      browserUrl: identityLinkBrowserUrl(env, issued.value.token),
      expiresAt: issued.value.expiresAt,
    },
    201,
  );
}

export async function handleIdentityLinkChallenge(
  request: Request,
  env: Env,
  tokenRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const token = parseIdentityLinkPathToken(tokenRaw);

  if (token === null) {
    return notFound();
  }

  const invitation = await resolveIdentityLink({
    env,
    token,
    now: Date.now(),
  });

  if (!invitation.ok) {
    return identityLinkResolutionErrorResponse(invitation.error);
  }

  return identityLinkJsonResponse({
    ok: true,
    challengeId: invitation.value.challengeId,
    kind: "slack",
    workspaceId: invitation.value.workspaceId,
    externalUserId: invitation.value.externalUserId,
    expiresAt: invitation.value.expiresAt,
  });
}

export async function handleCompleteIdentityLink(
  request: Request,
  env: Env,
  tokenRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const token = parseIdentityLinkPathToken(tokenRaw);

  if (token === null) {
    return notFound();
  }

  const now = Date.now();
  const invitation = await resolveIdentityLink({ env, token, now });

  if (!invitation.ok) {
    return identityLinkResolutionErrorResponse(invitation.error);
  }

  const requestId = newRequestId();

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  if (Object.keys(body.value).length !== 0) {
    return errorResponse(
      "identity_link_request_invalid",
      "Identity link request must be empty.",
      422,
    );
  }
  const publicOrigin = env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "");
  if (request.headers.get("origin") !== publicOrigin) {
    return errorResponse(
      "origin_invalid",
      "Identity link origin was rejected.",
      403,
    );
  }
  const sessionToken = readRequestCookie(request, "pantry_session");
  const csrfCookie = readRequestCookie(request, "pantry_csrf");
  const csrfHeader = request.headers.get("x-pantry-csrf");
  if (
    sessionToken === null ||
    csrfCookie === null ||
    csrfHeader === null ||
    csrfCookie !== csrfHeader
  ) {
    return errorResponse(
      "control_session_missing",
      "Sign in to link this identity.",
      401,
    );
  }
  const session = await resolveControlSession({
    db: env.DB,
    token: sessionToken,
    now,
  });
  if (!session.ok) {
    return errorResponse(
      session.error.code,
      "Sign in to link this identity.",
      401,
    );
  }
  const csrf = await validateControlCsrf({
    db: env.DB,
    session: session.value,
    csrfToken: csrfHeader,
  });
  if (!csrf.ok) {
    return errorResponse(
      csrf.error.code,
      "Identity link request was rejected.",
      403,
    );
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    invitation.value.organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "Organisation region is unavailable.",
      503,
    );
  const consumed = await consumeIdentityLink({
    env,
    token,
    userId: session.value.userId,
    now,
  });

  if (!consumed.ok) {
    return identityLinkConsumptionErrorResponse(consumed.error);
  }

  traceLog("identity_link.completed", {
    requestId,
    organisation_id: consumed.value.organisationId,
    user_id: consumed.value.userId,
    workspace_connection_id: consumed.value.workspaceConnectionId,
    workspace_id: consumed.value.workspaceId,
    external_user_id: consumed.value.externalUserId,
    verified_by: consumed.value.verifiedBy,
  });

  return jsonResponse({
    ok: true,
    link: consumed.value,
  });
}

function parseIdentityLinkPathToken(raw: string) {
  const decoded = decodePathSegment(raw);
  return decoded.ok ? parseIdentityLinkToken(decoded.value) : null;
}

function readRequestCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = segment.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
}

function identityLinkJsonResponse(body: JsonObject, status = 200): Response {
  const response = jsonResponse(body, status);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function identityLinkResolutionErrorResponse(
  error: ResolveIdentityLinkError,
): Response {
  switch (error.code) {
    case "link_not_found":
      return notFound();
    case "link_expired":
      return errorResponse(
        error.code,
        "Identity link invitation expired.",
        410,
      );
    case "link_consumed":
      return errorResponse(
        error.code,
        "Identity link invitation was already used.",
        409,
      );
    case "invalid_link_record":
      return errorResponse(
        error.code,
        "Identity link invitation is invalid.",
        500,
      );
    default:
      return assertNever(error);
  }
}

function identityLinkConsumptionErrorResponse(
  error: ConsumeIdentityLinkError,
): Response {
  switch (error.code) {
    case "link_not_found":
    case "link_expired":
    case "link_consumed":
    case "invalid_link_record":
      return identityLinkResolutionErrorResponse(error);
    case "organisation_membership_missing":
      return errorResponse(
        error.code,
        "This identity is not an organisation member.",
        403,
      );
    case "identity_provider_unsupported":
      return errorResponse(
        error.code,
        "This sign-in method cannot link identities.",
        403,
      );
    case "identity_conflict":
      return errorResponse(
        error.code,
        "Slack identity is already linked.",
        409,
      );
    case "link_race_lost":
      return errorResponse(
        error.code,
        "Identity link invitation was already consumed.",
        409,
      );
    default:
      return assertNever(error);
  }
}
