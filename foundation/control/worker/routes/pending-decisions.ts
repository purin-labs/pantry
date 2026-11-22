import type { Env } from "@purin-labs/kernel/env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import {
  listPendingDecisions,
  type PendingDecisionSources,
} from "../pending-decisions";

export type PendingDecisionsRoute = Readonly<{
  kind: "pendingDecisions";
  organisationIdRaw: string;
}>;

export function matchPendingDecisionsRoute(
  pathname: string,
): PendingDecisionsRoute | null {
  const matched = /^\/v1\/control\/organisations\/([^/]+)\/decisions$/u.exec(
    pathname,
  );
  if (matched === null) return null;
  try {
    return {
      kind: "pendingDecisions",
      organisationIdRaw: decodeURIComponent(matched[1] ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * `GET /v1/control/organisations/{org}/decisions`: the decisions that wait
 * for the signed-in member, over every store. A viewer may call it, as a
 * viewer may call the read of each store. Each store applies its own check,
 * so a member sees here what that member sees on the pages of today. A
 * ledger that does not answer gives 503, as the Operations read does.
 */
export async function handlePendingDecisionsRoute(
  request: Request,
  env: Env,
  route: PendingDecisionsRoute,
  sources: PendingDecisionSources,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const decisions = await listPendingDecisions(sources, authorized);
  return decisions === null
    ? controlError("pending_decisions_unavailable", 503)
    : controlJson(decisions);
}
