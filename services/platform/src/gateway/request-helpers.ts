import type { SurfaceKind } from "@purin-labs/contracts";
import { assertNever } from "@purin-labs/std";
import {
  parseSurfaceKind,
  readChannelIdPath,
  readOrganisationIdField,
  readStringField,
  readWorkspaceIdField,
  type FieldError,
} from "../boundary";
import type { Env } from "../env";
import {
  authorizeConfiguredBearer,
  authorizeFaultInjectionBearer,
} from "../fault-injection-auth";
import {
  errorResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonBodyError,
  type JsonObject,
} from "../http";
import {
  parseOrganisationId,
  parseThreadKey,
  parseWorkspaceId,
  type ChannelId,
  type OrganisationId,
  type ThreadKey,
  type WorkspaceId,
} from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";

/**
 * The request helpers of a gateway route (Refactor 17): the path segments, the
 * admin bearer, the body fields and the error answers. They name no area, so
 * a route file of an area reads them without an import of the gateway support
 * file, which holds the queue handlers of several areas.
 */

export type SegmentDecodeError = { code: "bad_path_encoding"; value: string };

export type RouteParamError =
  | SegmentDecodeError
  | { code: "invalid_organisation_id" }
  | { code: "invalid_surface_kind" }
  | { code: "invalid_workspace_id" }
  | { code: "invalid_channel_id" }
  | { code: "invalid_session_id" }
  | { code: "invalid_sandbox_id" }
  | { code: "invalid_region_bucket" };

export type RuntimeSecret =
  { ok: true; value: string } | { ok: false; code: "missing_secret" };

export function readJsonFailure(): null {
  return null;
}

export function decodePathSegmentValue(raw: string): string {
  const decoded = decodePathSegment(raw);
  return decoded.ok ? decoded.value : "";
}

export function parsePublicServiceUrl(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }

  try {
    const url = new URL(raw);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");

    if (url.protocol !== "https:" && !localHttp) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function readPositiveSafeIntegerField(
  body: JsonObject,
  field: string,
): Result<number, FieldError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value };
}

export function isAuthorizedFaultInjectionRequest(
  request: Request,
  env: Env,
): boolean {
  return authorizeFaultInjectionBearer({
    authorization: request.headers.get("authorization"),
    configuredToken: env.PANTRY_FAULT_INJECTION_TOKEN,
  });
}

export function isAuthorizedOrganisationAdminRequest(
  request: Request,
  env: Env,
): boolean {
  return authorizeConfiguredBearer({
    authorization: request.headers.get("authorization"),
    configuredToken: env.ORGANISATION_ADMIN_TOKEN,
  });
}

export function parseOrganisationPath(
  raw: string,
): Result<OrganisationId, RouteParamError> {
  const decoded = decodePathSegment(raw);

  if (!decoded.ok) {
    return decoded;
  }

  const parsed = parseOrganisationId(decoded.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_organisation_id" } };
  }

  return parsed;
}

export function parseWorkspacePath(
  raw: string,
): Result<WorkspaceId, RouteParamError> {
  const decoded = decodePathSegment(raw);

  if (!decoded.ok) {
    return decoded;
  }

  const parsed = parseWorkspaceId(decoded.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_workspace_id" } };
  }

  return parsed;
}

export function parseSurfaceKindPath(
  raw: string,
): Result<SurfaceKind, RouteParamError> {
  const decoded = decodePathSegment(raw);

  if (!decoded.ok) {
    return decoded;
  }

  const parsed = parseSurfaceKind(decoded.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_surface_kind" } };
  }

  return parsed;
}

export function decodePathSegment(
  raw: string,
): Result<string, SegmentDecodeError> {
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    return { ok: false, error: { code: "bad_path_encoding", value: raw } };
  }
}

export function readRuntimeSecret(value: string | undefined): RuntimeSecret {
  if (value === undefined || value.trim().length === 0) {
    return { ok: false, code: "missing_secret" };
  }

  return { ok: true, value };
}

export function isLocalDebugRequest(request: Request): boolean {
  const url = new URL(request.url);

  return isLocalHostname(url.hostname);
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function jsonBodyErrorResponse(error: JsonBodyError): Response {
  switch (error.code) {
    case "invalid_json":
      return errorResponse(error.code, "Request body is not valid JSON.", 400);
    case "object_required":
      return errorResponse(
        error.code,
        "Request body must be a JSON object.",
        400,
      );
    default:
      return assertNever(error);
  }
}

export function fieldErrorResponse(error: FieldError): Response {
  switch (error.code) {
    case "missing_field":
      return errorResponse(
        error.code,
        `Missing required field: ${error.field}.`,
        400,
      );
    case "invalid_field":
      return errorResponse(error.code, `Invalid field: ${error.field}.`, 400);
    default:
      return assertNever(error);
  }
}

export function routeParamErrorResponse(error: RouteParamError): Response {
  switch (error.code) {
    case "bad_path_encoding":
      return errorResponse(
        error.code,
        "Path segment is not valid URI encoding.",
        400,
      );
    case "invalid_organisation_id":
    case "invalid_surface_kind":
    case "invalid_workspace_id":
    case "invalid_channel_id":
    case "invalid_session_id":
    case "invalid_sandbox_id":
    case "invalid_region_bucket":
      return errorResponse(error.code, "Path parameter is invalid.", 400);
    default:
      return assertNever(error);
  }
}

/** The Slack channel that an admin cue route sets the cues of. */
export type CueChannelRequest = Readonly<{
  scope: OrganisationExecutionScope;
  organisationId: OrganisationId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
}>;

/**
 * The head of an admin route that sets the cues of one Slack channel: a POST
 * with the admin bearer and a JSON object with `organisationId`,
 * `workspaceId` and `channelId`. A failure is the answer of the route.
 */
export async function readCueChannelRequest(
  request: Request,
  env: Env,
): Promise<Result<CueChannelRequest, Response>> {
  if (request.method !== "POST") {
    return { ok: false, error: methodNotAllowed(["POST"]) };
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return { ok: false, error: notFound() };
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return { ok: false, error: jsonBodyErrorResponse(body.error) };
  }

  const organisationId = readOrganisationIdField(body.value);
  const workspaceId = readWorkspaceIdField(body.value);
  const channelIdRaw = readStringField(body.value, "channelId");

  if (!organisationId.ok) {
    return { ok: false, error: fieldErrorResponse(organisationId.error) };
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return {
      ok: false,
      error: errorResponse(
        execution.error.code,
        "The organisation region is unavailable.",
        503,
      ),
    };
  }

  if (!workspaceId.ok) {
    return { ok: false, error: fieldErrorResponse(workspaceId.error) };
  }

  if (!channelIdRaw.ok) {
    return { ok: false, error: fieldErrorResponse(channelIdRaw.error) };
  }

  const channelId = readChannelIdPath(channelIdRaw.value);
  const threadKey = parseThreadKey(
    `slack:${workspaceId.value}:${channelIdRaw.value}:channel`,
  );

  if (!channelId.ok) {
    return { ok: false, error: fieldErrorResponse(channelId.error) };
  }

  if (!threadKey.ok) {
    return {
      ok: false,
      error: errorResponse("invalid_field", "Cue thread is invalid.", 422),
    };
  }

  return {
    ok: true,
    value: {
      scope: execution.value,
      organisationId: organisationId.value,
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      threadKey: threadKey.value,
    },
  };
}
