import type { Env } from "../../../env";
import {
  parseAgentOperationInput,
  readAgentOperations,
  type AgentOperationInput,
} from "../../../data/agent-operations";
import {
  readAgentDefinitionRevisions,
  readSkillRevisions,
} from "../../../data/agent-operations/revisions";
import {
  isPublishedResourceBoundaryError,
  runAgentOperation,
} from "../../../data/agent-operation-runner";
import type { PublishedResourceBoundaryError } from "../../../data/agent-operations/scope-commerce";
import { readAgentOperationsWithActivity } from "../../agent-operation-activity";
import { admitUserMutation } from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { assertNever } from "@purin-labs/std";

/**
 * Operator-initiated manual agent run (plan 30 phase 4). Follows the
 * handleCaseCommand precedent: control authority, human principal, and the
 * direct-case path — plus the same assignment pin the cue and schedule paths
 * record, so lineage, grants, and the governance budget cap are identical.
 * Replay protection comes from the surrounding control-mutation boundary.
 */
export async function handleAgentOperationRevisions(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  targetKind: "agent_definition" | "skill",
  targetId: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const revisions =
    targetKind === "agent_definition"
      ? await readAgentDefinitionRevisions(
          authorized.executionScope.database,
          authorized.organisationId,
          targetId,
        )
      : await readSkillRevisions(
          authorized.executionScope.database,
          authorized.organisationId,
          targetId,
        );
  if (revisions.length === 0)
    return controlError("agent_operation_not_found", 404);
  return controlJson({ ok: true, targetKind, targetId, revisions });
}

export async function handleAgentOperations(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    request.method === "GET" ? "viewer" : "admin",
    request.method !== "GET",
  );
  if (!authorized.ok) return authorized.response;
  if (request.method === "GET") {
    const operations = await readAgentOperations(
      authorized.executionScope.database,
      authorized.organisationId,
    );
    const enriched = await readAgentOperationsWithActivity(
      env,
      authorized.organisationId,
      operations,
    );
    return enriched === null
      ? controlError("agent_operations_unavailable", 503)
      : controlJson({ ok: true, operations: enriched });
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("agent_operation_invalid", 422);
  const parsed = parseAgentOperationInput(body.value);
  if (!parsed.ok) return agentOperationsErrorResponse(parsed.error);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/operations`,
    operation: `agent.operations.${parsed.value.kind}`,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  // The same runner a confirmed Slack draft uses, so the two surfaces cannot
  // carry out a command differently.
  const applied = await runAgentOperation({
    env,
    scope: authorized.executionScope,
    operation: parsed.value,
    actor: {
      userId: authorized.authenticated.session.userId,
      personId: authorized.membership.personId,
      role: authorized.membership.role,
      origin: {
        kind: "control_session",
        controlSessionId: authorized.authenticated.session.controlSessionId,
      },
    },
    operationId: operationIdFor(parsed.value.kind, boundary.requestHash),
    now,
  });
  if (!applied.ok) {
    return isPublishedResourceBoundaryError(applied.error)
      ? publishedResponsibilityScopeErrorResponse(applied.error)
      : agentOperationsErrorResponse(applied.error);
  }
  const enriched = await readAgentOperationsWithActivity(
    env,
    authorized.organisationId,
    applied.value,
  );
  if (enriched === null)
    return controlError("agent_operations_unavailable", 503);
  const responseBody = {
    ok: true,
    operation: parsed.value.kind,
    operations: enriched,
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody, 201);
}

function operationIdFor(
  kind: AgentOperationInput["kind"],
  requestHash: string,
): string {
  const prefix =
    kind === "create_area"
      ? "area"
      : kind === "create_skill"
        ? "skill"
        : kind === "publish_skill_revision"
          ? "skill_revision"
          : kind === "dispatch_manual_run"
            ? "manual_run"
            : kind === "create_agent_definition"
              ? "agent_definition"
              : kind === "publish_agent_definition_revision"
                ? "agent_definition_revision"
                : kind === "install_agent"
                  ? "installation"
                  : "binding";
  return `${prefix}_${requestHash.slice(0, 32)}`;
}

export function agentOperationsErrorResponse(
  error: import("../../../data/agent-operations").AgentOperationsError,
): Response {
  switch (error.code) {
    case "agent_operation_invalid":
      return controlError(error.code, 422);
    case "agent_operation_not_found":
      return controlJson(
        { ok: false, error: error.code, field: error.field },
        404,
      );
    case "agent_operation_conflict":
      return controlJson(
        { ok: false, error: error.code, field: error.field },
        409,
      );
    case "agent_operation_persistence_failed":
      return controlError(error.code, 500);
    default:
      return assertNever(error);
  }
}

function publishedResponsibilityScopeErrorResponse(
  error: PublishedResourceBoundaryError,
): Response {
  switch (error.code) {
    case "invalid_reference":
    case "not_published":
    case "revision_conflict":
    case "organisation_mismatch":
    case "merchant_mismatch":
      return controlError("agent_operation_invalid", 422);
    case "unavailable":
      return controlError("commerce_unavailable", 503);
  }
}
