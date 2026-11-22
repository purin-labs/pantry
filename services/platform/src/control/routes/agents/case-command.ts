import type { Env } from "@purin-labs/kernel/env";
import { processDirectCaseCommand } from "../../../actors/case-direct-processing";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import { prepareControlMutationReceipt } from "@purin-labs/tenancy/data/control-mutation";
import { parseRequestId } from "@purin-labs/kernel/ids";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import {
  admitUserMutation,
  controlMutationIdentity,
} from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";

export async function handleCaseCommand(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok || typeof body.value.instruction !== "string") {
    return controlError("case_command_invalid", 422);
  }
  const instruction = body.value.instruction.trim();
  if (instruction.length === 0 || instruction.length > 8_000) {
    return controlError("case_command_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/cases/commands`,
    operation: "case.command",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const digest = boundary.requestHash.slice(0, 32);
  const requestId = parseRequestId(`request_case_api_${digest}`);
  if (!requestId.ok) return controlError("case_command_identity_invalid", 500);
  const now = Date.now();
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (membershipRevision === null)
    return controlError("case_command_authority_unavailable", 503);
  const requestAuthority = buildControlAuthority({
    organisationId: authorized.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: authorized.authenticated.session.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  const processed = await processDirectCaseCommand(env, {
    scope: authorized.executionScope,
    projectContext: null,
    organisationId: authorized.organisationId,
    requestId: requestId.value,
    stableIdentity: `${authorized.organisationId}:api:${authorized.authenticated.session.userId}:${boundary.idempotencyKey}`,
    operatorOrigin: {
      kind: "control_session",
      controlSessionId: authorized.authenticated.session.controlSessionId,
    },
    triggerSource: { kind: "api", commandId: `command_case_api_${digest}` },
    content: { kind: "text", text: instruction },
    purpose: instruction,
    principal: { kind: "human", principalId: authorized.membership.personId },
    requestAuthority,
    receivedAt: now,
    role: "coordinator",
    objective: instruction,
    delivery: { kind: "none" },
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
  });
  if (!processed.ok) return controlError(processed.error.code, 503);
  const responseBody = {
    ok: true,
    disposition: processed.value.kind,
    case_id: processed.value.caseId,
    session_id: processed.value.sessionId,
    assignment_id: processed.value.assignmentId,
  };
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    now,
  );
  const session =
    authorized.executionScope.database.withSession("first-primary");
  await session.batch([
    prepareControlMutationReceipt(session, {
      scope,
      boundary,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
  ]);
  return controlJson(responseBody);
}
