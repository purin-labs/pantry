import type { Env } from "../../../env";
import { processDirectCaseCommand } from "../../../actors/case-direct-processing";
import {
  readActiveOrganisationMembershipRevision,
  resolveUser,
} from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  prepareControlMutationReceipt,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import { parseRequestId } from "../../../ids";
import { buildControlAuthority } from "../../../request-authority";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { controlCausationId } from "../../mutation";

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
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const route = `/v1/control/organisations/${authorized.organisationId}/cases/commands`;
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route,
    operation: "case.command",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay")
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const digest = boundary.value.requestHash.slice(0, 32);
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
    stableIdentity: `${authorized.organisationId}:api:${authorized.authenticated.session.userId}:${boundary.value.idempotencyKey}`,
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
  const mutationIdentity = newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(
      identity.issuer,
      identity.subject,
    ),
    causationId: controlCausationId(request),
    now,
  });
  const session =
    authorized.executionScope.database.withSession("first-primary");
  await session.batch([
    prepareControlMutationReceipt(session, {
      scope,
      boundary: boundary.value,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
  ]);
  return controlJson(responseBody);
}
