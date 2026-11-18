import type { Env } from "../../../env";
import {
  cancelOrganisationCodexAuthorization,
  completeOrganisationChatGptSignIn,
  disconnectOrganisationCodex,
  readOrganisationCodexConnectionAtScope,
  startOrganisationCodexAuthorization,
  type CodexConnectionError,
  type OrganisationCodexConnection,
} from "../../../models/codex-connection";
import { parseCodexAuthorizationAttemptId } from "../../../ids";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../../http";
import { assertNever, hasExactKeys } from "@seams/std";

export async function handleOrganisationCodex(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    // The request resolved this scope; the read checks its fence itself.
    const reconciled = await readOrganisationCodexConnectionAtScope({
      env,
      scope: authorized.executionScope,
      now: Date.now(),
      reconcile: true,
    });
    if (reconciled.ok)
      return controlJson({
        ok: true,
        connection: organisationCodexConnectionWire(reconciled.value),
      });
    return organisationCodexError(reconciled.error);
  }
  if (request.method !== "DELETE")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const disconnected = await disconnectOrganisationCodex({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  return disconnected.ok
    ? controlJson({
        ok: true,
        connection: organisationCodexConnectionWire(disconnected.value),
      })
    : organisationCodexError(disconnected.error);
}

export async function handleOrganisationCodexAuthorizations(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  reconnect: boolean,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  // Portal signs in with "Sign in with ChatGPT" only (Plan 74B).
  const started = await startOrganisationCodexAuthorization({
    env,
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
    now: Date.now(),
    reconnect,
    signIn: "chatgpt_agent",
  });
  return started.ok
    ? controlJson({
        ok: true,
        connection: organisationCodexConnectionWire(started.value),
      })
    : organisationCodexError(started.error);
}

export async function handleCancelOrganisationCodexAuthorization(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  attemptIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const attemptId = parseCodexAuthorizationAttemptId(attemptIdRaw);
  if (!attemptId.ok) return controlError("codex_authorization_not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const cancelled = await cancelOrganisationCodexAuthorization({
    env,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
    now: Date.now(),
  });
  return cancelled.ok
    ? controlJson({
        ok: true,
        connection: organisationCodexConnectionWire(cancelled.value),
      })
    : organisationCodexError(cancelled.error);
}

/**
 * Plan 74B: the owner pastes the address of the "Sign in with ChatGPT"
 * callback page. The address holds a one-time code, so Portal sends it as a
 * secret mutation.
 */
export async function handleCompleteOrganisationChatGptSignIn(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  attemptIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const attemptId = parseCodexAuthorizationAttemptId(attemptIdRaw);
  if (!attemptId.ok) return controlError("codex_authorization_not_found", 404);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, 16_384);
  if (body === null || !hasExactKeys(body, ["callbackUrl"]))
    return controlError("codex_sign_in_address_invalid", 422);
  const completed = await completeOrganisationChatGptSignIn({
    env,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
    callbackUrl: body.callbackUrl,
    now: Date.now(),
  });
  return completed.ok
    ? controlJson({
        ok: true,
        connection: organisationCodexConnectionWire(completed.value),
      })
    : organisationCodexError(completed.error);
}

export function organisationCodexConnectionWire(
  connection: OrganisationCodexConnection,
): unknown {
  switch (connection.kind) {
    case "disconnected":
      return { kind: connection.kind, revision: connection.revision };
    case "authorizing":
      return {
        kind: connection.kind,
        revision: connection.revision,
        attempt: {
          attemptId: connection.attempt.attemptId,
          method: connection.attempt.method,
          verificationUrl: connection.attempt.verificationUrl,
          userCode: connection.attempt.userCode,
          expiresAt: connection.attempt.expiresAt,
        },
      };
    case "connected":
      return {
        kind: connection.kind,
        revision: connection.revision,
        signIn: connection.signIn,
        planType: connection.planType,
        allowance: connection.allowance,
        connectedAt: connection.connectedAt,
        verifiedAt: connection.verifiedAt,
      };
    case "action_required":
      return {
        kind: connection.kind,
        revision: connection.revision,
        signIn: connection.signIn,
        planType: connection.planType,
        allowance: connection.allowance,
        reason: connection.reason,
        observedAt: connection.observedAt,
      };
    default:
      return assertNever(connection);
  }
}

export function organisationCodexError(error: CodexConnectionError): Response {
  switch (error.code) {
    case "organisation_placement_missing":
    case "organisation_placement_corrupt":
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "invalid_organisation_placement":
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
      return controlError(error.code, 503);
    case "codex_authorization_not_found":
      return controlError(error.code, 404);
    case "codex_authorization_expired":
    case "codex_authorization_failed":
    case "codex_plan_usage_not_allowed":
    case "codex_connection_invalid":
      return controlError(error.code, 409);
    case "codex_device_authorization_unavailable":
    case "codex_sign_in_address_invalid":
      return controlError(error.code, 422);
    case "codex_sign_in_unavailable":
    case "codex_vault_unavailable":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}
