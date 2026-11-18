import { isBakeryWorkflowId } from "../../commerce/bakery/workflow-revisions";
import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { requirePublicOrigin } from "../../public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

/**
 * Plan 84: one recipe's applied workflow and the socket of its shared draft. A
 * viewer reads both. An owner or administrator applies a revision.
 */
export type BakeryWorkflowRoute = Readonly<{
  kind: "bakeryWorkflow";
  organisationId: OrganisationId;
  workflowId: string;
  transport:
    | "current"
    | "apply"
    | "socket"
    | "findings"
    | Readonly<{
        proposal: string;
        action: "read" | "approve" | "decline";
      }>;
}>;

export function matchBakeryWorkflowRoute(
  pathname: string,
): BakeryWorkflowRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/bakery\/workflows\/([^/]+)(?:\/(apply|socket|findings)|\/proposals\/([^/]{1,200})(?:\/(approve|decline))?)?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    const workflowId = decodeURIComponent(match[2] ?? "");
    if (!organisationId.ok || !isBakeryWorkflowId(workflowId)) return null;
    return {
      kind: "bakeryWorkflow",
      organisationId: organisationId.value,
      workflowId,
      transport:
        match[4] !== undefined
          ? {
              proposal: decodeURIComponent(match[4]),
              action:
                match[5] === "approve" || match[5] === "decline"
                  ? match[5]
                  : "read",
            }
          : match[3] === "apply" ||
              match[3] === "socket" ||
              match[3] === "findings"
            ? match[3]
            : "current",
    };
  } catch {
    return null;
  }
}

/** The socket's check. The Actor runs it again when the request reaches it. */
export async function authorizeBakeryWorkflowSocket(
  request: Request,
  env: Env,
  route: BakeryWorkflowRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
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
