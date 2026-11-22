import { signalChat } from "../../chat/signals";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isProjectId, parseProjectAccessCommand } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import {
  authorizeProject,
  listProjectCandidates,
  listProjectMembers,
} from "../../projects/access";
import { mutateProjectAccess } from "../../projects/membership";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "@purin-labs/control/worker/http";

export type ProjectAccessRoute = Readonly<{
  kind: "projectAccess";
  organisationIdRaw: string;
  projectIdRaw: string;
}>;

export function matchProjectAccessRoute(
  pathname: string,
): ProjectAccessRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/projects\/([^/]+)\/access$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    kind: "projectAccess",
    organisationIdRaw: decodeURIComponent(match[1]),
    projectIdRaw: decodeURIComponent(match[2]),
  };
}

export async function handleProjectAccessRoute(
  request: Request,
  env: Env,
  route: ProjectAccessRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  if (!isProjectId(route.projectIdRaw))
    return controlError("project_unavailable", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  const scope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  if (request.method === "GET") {
    const project = await authorizeProject(
      authorized.executionScope.database,
      scope,
      route.projectIdRaw,
      "read",
    );
    if (project === null) return controlError("project_unavailable", 404);
    const members = await listProjectMembers(
      authorized.executionScope.database,
      scope,
      route.projectIdRaw,
    );
    if (members === null) return controlError("project_unavailable", 404);
    const candidates = await listProjectCandidates(
      authorized.executionScope.database,
      scope,
      route.projectIdRaw,
    );
    const current = await authorizeProject(
      authorized.executionScope.database,
      scope,
      route.projectIdRaw,
      "read",
    );
    if (
      current === null ||
      current.access.accessRevision !== project.access.accessRevision
    ) {
      return controlError("project_access_conflict", 409);
    }
    return controlJson({ access: current.access, members, candidates });
  }
  const body = await readBoundedJsonRecord(request, 16 * 1024);
  const command = parseProjectAccessCommand(body);
  if (command === null) return controlError("project_request_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const result = await mutateProjectAccess(
    env,
    execution.value,
    scope.userId,
    route.projectIdRaw,
    command,
  );
  // Project membership decides who sees its shared conversations.
  if (result.kind === "accepted")
    signalChat(execution.value, { kind: "organisation" });
  return controlJson(result, result.kind === "accepted" ? 200 : 409);
}
