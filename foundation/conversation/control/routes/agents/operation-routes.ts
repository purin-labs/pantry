import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
import {
  decodeCapture,
  organisationPath,
  pathCaptures,
} from "@purin-labs/control/worker/path-match";
import { handleCaseCommand } from "./case-command";
import {
  handleAgentOperationRevisions,
  handleAgentOperations,
} from "./operations";

/** The control routes of the agent operations and of the Case commands. */
export type AgentOperationRoute =
  | Readonly<{ kind: "agentOperations"; organisationIdRaw: string }>
  | Readonly<{
      kind: "agentOperationRevisions";
      organisationIdRaw: string;
      targetKind: "agent_definition" | "skill";
      targetId: string;
    }>
  | Readonly<{ kind: "caseCommand"; organisationIdRaw: string }>;

export function matchAgentOperationRoute(
  pathname: string,
): AgentOperationRoute | null {
  const revisions = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/operations\/(definitions|skills)\/([^/]+)\/revisions$/u,
  );
  if (revisions !== null) {
    return {
      kind: "agentOperationRevisions",
      organisationIdRaw: decodeCapture(revisions[0]),
      targetKind: revisions[1] === "definitions" ? "agent_definition" : "skill",
      targetId: decodeCapture(revisions[2]),
    };
  }
  const operations = organisationPath(pathname, "operations");
  if (operations !== null)
    return { kind: "agentOperations", organisationIdRaw: operations };
  const caseCommand = organisationPath(pathname, "cases/commands");
  return caseCommand === null
    ? null
    : { kind: "caseCommand", organisationIdRaw: caseCommand };
}

export function handleAgentOperationRoute(
  request: Request,
  env: Env,
  route: AgentOperationRoute,
): Promise<Response> {
  switch (route.kind) {
    case "agentOperations":
      return handleAgentOperations(request, env, route.organisationIdRaw);
    case "agentOperationRevisions":
      return handleAgentOperationRevisions(
        request,
        env,
        route.organisationIdRaw,
        route.targetKind,
        route.targetId,
      );
    case "caseCommand":
      return handleCaseCommand(request, env, route.organisationIdRaw);
    default:
      return assertNever(route);
  }
}
