import {
  parseWorkflowCanvasSource,
  type WorkflowCanvasSource,
} from "@purin-labs/bakery-model/bakery-canvas-source";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError } from "../http";
import { authorizeOrganisationSocket } from "./organisation-socket";

export type WorkflowCanvasRoute = Readonly<{
  kind: "workflowCanvas";
  organisationId: OrganisationId;
  reference: WorkflowCanvasSource;
  transport: "snapshot" | "socket" | "move" | "chat" | "chat/continue" | "undo";
}>;

export function matchWorkflowCanvasRoute(
  pathname: string,
): WorkflowCanvasRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/collaboration\/workflow-canvas\/([^/]+)(?:\/(socket|move|chat\/continue|chat|undo))?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    const reference = parseWorkflowCanvasSource(
      decodeURIComponent(match[2] ?? ""),
    );
    let transport: WorkflowCanvasRoute["transport"] = "snapshot";
    if (match[3] === "socket") transport = "socket";
    if (match[3] === "move") transport = "move";
    if (match[3] === "chat") transport = "chat";
    if (match[3] === "chat/continue") transport = "chat/continue";
    if (match[3] === "undo") transport = "undo";
    return {
      kind: "workflowCanvas",
      organisationId: organisationId.value,
      reference,
      transport,
    };
  } catch {
    return null;
  }
}

export async function authorizeWorkflowCanvasRequest(
  request: Request,
  env: Env,
  route: WorkflowCanvasRoute,
) {
  if (route.transport === "chat") {
    if (request.method !== "GET" && request.method !== "POST")
      return {
        ok: false as const,
        response: controlError("method_not_allowed", 405),
      };
    // A POST opens the reader's view of the canvas chat and starts no turn,
    // so a viewer may send it.
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      request.method === "POST",
      "disclose",
    );
  }
  if (
    route.transport === "move" ||
    route.transport === "undo" ||
    route.transport === "chat/continue"
  ) {
    if (request.method !== "POST")
      return {
        ok: false as const,
        response: controlError("method_not_allowed", 405),
      };
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "operator",
      true,
    );
  }
  if (request.method !== "GET")
    return {
      ok: false as const,
      response: controlError("method_not_allowed", 405),
    };
  if (route.transport === "socket")
    return authorizeOrganisationSocket(
      request,
      env,
      route.organisationId,
      "viewer",
    );
  return authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
}
