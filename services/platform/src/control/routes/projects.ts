import { signalChat } from "../../chat/signals";
import {
  isProjectId,
  parseCaseProjectCommand,
  parseProjectCommand,
  projectReferenceIdentity,
} from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import { parseCaseId } from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  listProjectCases,
  moveCase,
  readCaseProject,
} from "../../projects/case-moves";
import { mutateProject, readProjectCatalogue } from "../../projects/commands";
import { readProject } from "../../projects/records";
import {
  observeProjectReference,
  searchProjectReferences,
} from "../../projects/references";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";

// Projects and the Cases filed in them, for every surface. A member's sidebar
// ordering is the chat directory's.
export type ProjectsRoute = Readonly<{
  kind: "projects";
  organisationIdRaw: string;
  target:
    | Readonly<{ kind: "catalogue" }>
    | Readonly<{ kind: "references" }>
    | Readonly<{ kind: "project_cases"; projectIdRaw: string }>
    | Readonly<{ kind: "case_project"; caseIdRaw: string }>;
}>;

export function matchProjectsRoute(pathname: string): ProjectsRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/(?:projects(?:\/(references)|\/([^/]+)\/cases)?|cases\/([^/]+)\/project)$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined) return null;
  const organisationIdRaw = decodeURIComponent(match[1]);
  if (match[4] !== undefined)
    return {
      kind: "projects",
      organisationIdRaw,
      target: { kind: "case_project", caseIdRaw: decodeURIComponent(match[4]) },
    };
  if (match[3] !== undefined)
    return {
      kind: "projects",
      organisationIdRaw,
      target: {
        kind: "project_cases",
        projectIdRaw: decodeURIComponent(match[3]),
      },
    };
  return {
    kind: "projects",
    organisationIdRaw,
    target: { kind: match[2] === "references" ? "references" : "catalogue" },
  };
}

export async function handleProjectsRoute(
  request: Request,
  env: Env,
  route: ProjectsRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
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
  const target = route.target;
  if (target.kind === "references") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const query = (new URL(request.url).searchParams.get("search") ?? "")
      .trim()
      .toLocaleLowerCase();
    if (query.length > 120) return controlError("project_request_invalid", 422);
    return controlJson({
      references: await searchProjectReferences(
        env,
        authorized.executionScope,
        scope,
        query,
      ),
    });
  }
  if (target.kind === "project_cases") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    if (!isProjectId(target.projectIdRaw))
      return controlError("project_unavailable", 404);
    const cases = await listProjectCases(
      authorized.executionScope,
      scope,
      target.projectIdRaw,
    );
    return cases === null
      ? controlError("project_unavailable", 404)
      : controlJson({ cases });
  }
  if (target.kind === "case_project") {
    const caseId = parseCaseId(target.caseIdRaw);
    if (!caseId.ok) return controlError("case_not_found", 404);
    if (request.method === "GET") {
      const placement = await readCaseProject(
        authorized.executionScope,
        scope,
        caseId.value,
      );
      return placement === null
        ? controlError("case_not_found", 404)
        : controlJson({ placement });
    }
    const command = parseCaseProjectCommand(
      await readBoundedJsonRecord(request, 1024),
    );
    if (command === null) return controlError("project_request_invalid", 422);
    const execution = await OrganisationExecutionScope.resolve(
      env,
      scope.organisationId,
    );
    if (!execution.ok) return controlError(execution.error.code, 409);
    const moved = await moveCase(
      execution.value,
      scope.userId,
      caseId.value,
      command,
      Date.now(),
    );
    // A Case's Project decides who sees its conversation.
    if (moved.kind === "accepted")
      signalChat(execution.value, { kind: "organisation" });
    return controlJson(
      moved,
      moved.kind === "accepted"
        ? 200
        : moved.code === "case_not_found"
          ? 404
          : 409,
    );
  }
  if (request.method === "GET")
    return controlJson(
      await readProjectCatalogue(env, authorized.executionScope, scope),
    );
  const command = parseProjectCommand(
    await readBoundedJsonRecord(request, 16 * 1024),
  );
  if (command === null) return controlError("project_request_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  if (command.kind === "create_project" || command.kind === "edit_project") {
    // The author must be able to read every reference they add.
    const prior =
      command.kind === "edit_project"
        ? await readProject(
            authorized.executionScope.database,
            scope,
            command.projectId,
          )
        : null;
    const known = new Set(
      (prior?.references ?? []).map(projectReferenceIdentity),
    );
    for (const reference of command.content.references) {
      if (known.has(projectReferenceIdentity(reference))) continue;
      const observation = await observeProjectReference(
        env,
        authorized.executionScope,
        scope,
        reference,
        Date.now(),
      );
      if (observation.kind === "unavailable")
        return controlError("project_reference_unavailable", 422);
    }
  }
  const result = await mutateProject(
    env,
    execution.value,
    {
      userId: scope.userId,
      organisationRole: authorized.membership.role,
    },
    command,
    Date.now(),
  );
  // A Project's deletion returns its private chats to the default Project.
  if (result.kind === "accepted")
    signalChat(execution.value, { kind: "organisation" });
  return controlJson(result, result.kind === "accepted" ? 200 : 409);
}
