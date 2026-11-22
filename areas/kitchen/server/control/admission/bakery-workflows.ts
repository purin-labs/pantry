import { isBakeryWorkflowId } from "../../bakery/workflow-revisions";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { authorizeOrganisationSocket } from "@purin-labs/control/worker/admission/organisation-socket";

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
  return authorizeOrganisationSocket(
    request,
    env,
    route.organisationId,
    "viewer",
  );
}
