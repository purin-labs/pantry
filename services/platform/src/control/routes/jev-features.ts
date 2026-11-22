import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";

/** Settings › AI features › Jev (Plan 88 section 2). */
export type JevFeaturesRoute = Readonly<{
  kind: "jevFeatures";
  organisationId: OrganisationId;
  /** `paid_use` changes paid use; only the owner may (Plan 88 section 4). */
  operation: "features" | "paid_use";
}>;

export function matchJevFeaturesRoute(
  pathname: string,
): JevFeaturesRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/jev-features(\/paid-use)?$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    return organisationId.ok
      ? {
          kind: "jevFeatures",
          organisationId: organisationId.value,
          operation: match[2] === undefined ? "features" : "paid_use",
        }
      : null;
  } catch {
    return null;
  }
}

export async function handleJevFeaturesRoute(
  request: Request,
  env: Env,
  route: JevFeaturesRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  if (route.operation === "paid_use" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  // Every member reads the switches; only an admin changes one, with CSRF.
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    route.operation === "paid_use"
      ? "owner"
      : request.method === "POST"
        ? "admin"
        : "viewer",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  try {
    const actor = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    if (request.method === "GET")
      return featuresResult(
        await actor.readJevFeatures({
          organisationId: authorized.organisationId,
        }),
      );
    const body = await readBoundedJsonRecord(request, 4_096);
    if (body === null) return controlError("jev_feature_invalid", 400);
    if (route.operation === "paid_use")
      return featuresResult(
        await actor.manageJevPaidUse({
          organisationId: authorized.organisationId,
          actorId: authorized.membership.userId,
          body,
        }),
      );
    return featuresResult(
      await actor.manageJevFeature({
        organisationId: authorized.organisationId,
        actorId: authorized.membership.userId,
        body,
      }),
    );
  } catch {
    return controlError("jev_features_unavailable", 503);
  }
}

function featuresResult(
  result:
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; error: Readonly<{ code: string }> }>,
): Response {
  if (result.ok) return controlJson(result);
  if (result.error.code.endsWith("_invalid"))
    return controlError(result.error.code, 422);
  return controlError(result.error.code, 409);
}
