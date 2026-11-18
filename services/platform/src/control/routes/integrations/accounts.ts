import type { Env } from "../../../env";
import { removeIntegrationAccount } from "../../../data/account-removal";
import { resolveUser } from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  disableIntegrationAccount,
  listIntegrationAccounts,
  switchDefaultIntegrationAccount,
} from "../../../data/integration-account";
import { buildOnboardingProjection } from "../../../data/onboarding-projection";
import { parseIntegrationAccountId } from "../../../ids";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { controlCausationId } from "../../mutation";
import { mutationProjectionResponse } from "../../mutation-projection";
import { tearDownAgentMailboxForRemoval } from "../../../mail-inbox/agent-mailbox-teardown";

export async function handleAccounts(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const accounts = await listIntegrationAccounts({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  return controlJson({ ok: true, accounts });
}

export async function handleRemoveAccount(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "DELETE") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("remove_account_request_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}`,
    operation: "provider.account.remove",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return mutationProjectionResponse(
      authorized.executionScope.database,
      authorized.organisationId,
      authorized.membership,
      replay.receipt,
    );
  }
  const now = Date.now();
  // Stand a Gmail mailbox down before the connection goes: removal revokes the
  // Google grant, and a revoked grant cannot delete the drafts Pantry created.
  const mailboxTeardown = await tearDownAgentMailboxForRemoval(
    env,
    authorized.executionScope,
    integrationAccountId.value,
    "erase",
  );
  if (mailboxTeardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const removed = await removeIntegrationAccount({
    db: authorized.executionScope.database,
    directory: env.DB,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    removedByUserId: identity.userId,
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  if (!removed.ok) {
    return controlError(
      removed.error.code,
      removed.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("removed account projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    receipt: {
      receipt_id: removed.value.receiptId,
      organisation_id: authorized.organisationId,
    },
    // A draft Pantry could not delete stays in the organisation's mailbox after the
    // grant is revoked, so it is reported rather than dropped silently.
    ...(mailboxTeardown.kind === "torn_down"
      ? {
          mailbox_teardown: {
            watch_stopped: mailboxTeardown.watchStopped,
            cleanup_needed: mailboxTeardown.cleanupNeeded.map((entry) => ({
              proposal_id: entry.proposalId,
              version: entry.version,
              state: entry.state,
            })),
          },
        }
      : {}),
  });
}

export async function handleDisableAccount(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("disable_account_request_invalid", 422);
  }
  const replacementRaw = body.value.replacementIntegrationAccountId;
  const replacement =
    replacementRaw === undefined || replacementRaw === null
      ? { ok: true as const, value: null }
      : typeof replacementRaw === "string"
        ? parseIntegrationAccountId(replacementRaw)
        : {
            ok: false as const,
            error: { code: "invalid" as const, value: "" },
          };
  if (!replacement.ok) {
    return controlError("default_account_replacement_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/disable`,
    operation: "provider.account.disable",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return mutationProjectionResponse(
      authorized.executionScope.database,
      authorized.organisationId,
      authorized.membership,
      replay.receipt,
    );
  }
  const now = Date.now();
  const teardown = await tearDownAgentMailboxForRemoval(
    env,
    authorized.executionScope,
    integrationAccountId.value,
    "stand_down",
  );
  if (teardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const disabled = await disableIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    replacementIntegrationAccountId: replacement.value,
    disabledByUserId: identity.userId,
    reasonCode: "merchant_disabled",
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  if (!disabled.ok) {
    const status =
      disabled.error.code === "integration_account_not_found" ? 404 : 409;
    return controlError(disabled.error.code, status);
  }
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("disabled account projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    receipt: {
      receipt_id: disabled.value.receiptId,
      organisation_id: authorized.organisationId,
    },
  });
}

export async function handleDefaultAccount(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("default_account_request_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/default-for-provider`,
    operation: "provider.account.set_default_for_provider",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return mutationProjectionResponse(
      authorized.executionScope.database,
      authorized.organisationId,
      authorized.membership,
      replay.receipt,
    );
  }
  const now = Date.now();
  const switched = await switchDefaultIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    nextIntegrationAccountId: integrationAccountId.value,
    changedByUserId: identity.userId,
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  if (!switched.ok) {
    return controlError(
      switched.error.code,
      switched.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("default account projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    receipt: {
      receipt_id: switched.value.receiptId,
      organisation_id: authorized.organisationId,
    },
  });
}
