import { isProductionPlanLocationId } from "../../actors/production-plan";
import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { requirePublicOrigin } from "../../public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

/**
 * Plan 40D: the shared production plan of one location. The socket carries
 * the draft quantities; "Accept plan" applies them to the production requests
 * through Commerce's validated commands.
 */
export type ProductionPlanRoute = Readonly<{
  kind: "productionPlan";
  organisationId: OrganisationId;
  locationId: string;
  transport: "socket" | "accept" | "share";
}>;

export function matchProductionPlanRoute(
  pathname: string,
): ProductionPlanRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/inventory\/production-plan\/([^/]+)\/(socket|accept|share)$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    const locationId = decodeURIComponent(match[2] ?? "");
    return organisationId.ok && isProductionPlanLocationId(locationId)
      ? {
          kind: "productionPlan",
          organisationId: organisationId.value,
          locationId,
          transport:
            match[3] === "accept"
              ? "accept"
              : match[3] === "share"
                ? "share"
                : "socket",
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * The checks of the routes that the Actor serves. Viewers open the plan and
 * read its share; owners and admins set or end the share.
 */
export async function authorizeProductionPlanSocket(
  request: Request,
  env: Env,
  route: ProductionPlanRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (route.transport === "share") {
    if (request.method === "GET")
      return authorizeOrganisationRequest(
        request,
        env,
        route.organisationId,
        "viewer",
        false,
      );
    if (
      request.method !== "POST" &&
      request.method !== "PUT" &&
      request.method !== "DELETE"
    )
      return { ok: false, response: controlError("method_not_allowed", 405) };
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "admin",
      true,
    );
  }
  if (route.transport !== "socket")
    return { ok: false, response: controlError("not_found", 404) };
  if (request.method !== "GET")
    return { ok: false, response: controlError("method_not_allowed", 405) };
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return { ok: false, response: controlError("websocket_required", 426) };
  // Browser WebSockets cannot set the CSRF header. Require the exact configured origin.
  if (
    request.headers.get("Origin") !==
    requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)
  )
    return { ok: false, response: controlError("origin_invalid", 403) };
  return authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
}
