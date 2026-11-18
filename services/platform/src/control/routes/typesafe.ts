import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";

export type TypeSafeConnectionRoute = Readonly<{
  kind: "typesafeConnection";
  organisationId: OrganisationId;
}>;

export function matchTypeSafeConnectionRoute(
  pathname: string,
): TypeSafeConnectionRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/integrations\/typesafe$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    return organisationId.ok
      ? { kind: "typesafeConnection", organisationId: organisationId.value }
      : null;
  } catch {
    return null;
  }
}

export async function handleTypeSafeConnectionRoute(
  request: Request,
  env: Env,
  route: TypeSafeConnectionRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  // Credential management requires an organisation-admin session, including CSRF on mutations.
  if (request.headers.has("authorization"))
    return controlError("not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  try {
    const actor = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    if (request.method === "GET") {
      return connectionResult(
        await actor.readTypeSafeConnectionConfiguration({
          organisationId: authorized.organisationId,
        }),
      );
    }
    const body = await readBoundedJsonRecord(request, 16_384);
    if (body === null) return controlError("typesafe_request_invalid", 400);
    return connectionResult(
      await actor.manageTypeSafeConnection({
        organisationId: authorized.organisationId,
        actorId: authorized.membership.userId,
        body,
      }),
    );
  } catch {
    return controlError("typesafe_connection_unavailable", 503);
  }
}

function connectionResult(
  result:
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; error: Readonly<{ code: string }> }>,
): Response {
  if (result.ok) return controlJson(result);
  if (result.error.code === "jev_test_rate_limited")
    return controlError(result.error.code, 429);
  if (result.error.code.endsWith("_invalid"))
    return controlError(result.error.code, 422);
  return controlError(result.error.code, 409);
}
