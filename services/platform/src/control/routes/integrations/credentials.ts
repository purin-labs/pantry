import type { Env } from "../../../env";
import { requireActiveOrganisationActor } from "../../../actors/actor-router";
import {
  parseVaultHandle,
  revokeCredential,
  storeVaultSecret,
} from "../../../credential-vault";
import {
  authorizeCredentialRevocation,
  beginCredentialRotation,
  commitCredentialRotation,
  listCredentialInventory,
  markCredentialRotationFailed,
  markCredentialRotationVerified,
  recordCredentialRevocationMutation,
} from "../../../data/credential-lifecycle";
import { resolveUser } from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import { buildOnboardingProjection } from "../../../data/onboarding-projection";
import { parseIntegrationAccountId } from "../../../ids";
import { activateProviderCredentialCutover } from "../../../provider-lifecycle/credential-cutover";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { controlCausationId } from "../../mutation";
import { mutationProjectionResponse } from "../../mutation-projection";
import { activateRevocationPolicy } from "../../credential-revocation-policy";
import { tearDownAgentMailboxForRemoval } from "../../../mail-inbox/agent-mailbox-teardown";
import {
  credentialRotationSlug,
  validateReplacementCredential,
} from "../../../provider-lifecycle/credential-replacement";

export async function handleCredentialInventory(
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
    "admin",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const inventory = await listCredentialInventory({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (!inventory.ok) {
    return controlError(inventory.error.code, 500);
  }
  return controlJson({
    kind: "success",
    schema_version: "satyr.credential-inventory.v1",
    inventory: inventory.value,
  });
}

export async function handleRevokeAccountCredential(
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
    return controlError("revoke_credential_request_invalid", 422);
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
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/revoke-credential`,
    operation: "provider.credential.revoke",
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
    "erase",
  );
  if (teardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const authorization = await authorizeCredentialRevocation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    replacementIntegrationAccountId: replacement.value,
    expectedConfigurationVersion: boundary.value.expectedConfigurationVersion,
  });
  if (!authorization.ok) {
    const status =
      authorization.error.code === "integration_account_not_found" ||
      authorization.error.code === "provider_connection_not_found"
        ? 404
        : authorization.error.code === "configuration_version_conflict" ||
            authorization.error.code === "credential_already_revoked"
          ? 409
          : 422;
    return controlError(authorization.error.code, status);
  }
  const committed = await revokeCredential({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    handle: authorization.value.handle,
    now,
  });
  if (committed.state === "committed") {
    const activation = await activateRevocationPolicy(
      env,
      authorized.executionScope,
      committed,
      Date.now(),
    );
    if (!activation.ok) {
      return controlError("credential_revocation_policy_pending", 503);
    }
  }
  await recordCredentialRevocationMutation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    authorization: authorization.value,
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
    actorUserId: identity.userId,
    receiptBody: {
      receipt_id: `credential-revocation:${authorized.organisationId}`,
      organisation_id: authorized.organisationId,
      integration_account_id: integrationAccountId.value,
    },
    now,
  });
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("credential revocation projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    revocation: {
      revocation_id: committed.revocationId,
      state: committed.state,
      credential_generation_count: committed.credentialGenerationCount,
      vault_secret_count: committed.vaultSecretCount,
      started_at: committed.startedAt,
      committed_at: committed.committedAt,
    },
  });
}

export const CREDENTIAL_ROTATION_PROVIDERS = [
  "airtable",
  "notion",
  "stripe",
  "shopify",
] as const;

export async function handleRotateAccountCredentialSupplied(
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
  if (
    !body.ok ||
    typeof body.value.replacementSecret !== "string" ||
    body.value.replacementSecret.trim().length === 0
  ) {
    return controlError("credential_rotation_request_invalid", 422);
  }
  const replacementSecret = body.value.replacementSecret.trim();
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
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/credential-rotations`,
    operation: "provider.credential.rotate_supplied",
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
  const rotationSlug = credentialRotationSlug(boundary.value.idempotencyKey);
  const replacementHandle = parseVaultHandle(
    `vault:${authorized.organisationId.toLowerCase()}:rotation:${rotationSlug}`,
  );
  if (!replacementHandle.ok) {
    return controlError("credential_rotation_request_invalid", 422);
  }
  const rotation = await beginCredentialRotation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    credentialRotationId: `rotation_${authorized.organisationId}_${rotationSlug}`,
    replacementHandle: replacementHandle.value,
    createdByUserId: identity.userId,
    expectedConfigurationVersion: boundary.value.expectedConfigurationVersion,
    now,
  });
  if (!rotation.ok) {
    const status =
      rotation.error.code === "integration_account_not_found" ||
      rotation.error.code === "provider_connection_not_found"
        ? 404
        : rotation.error.code === "configuration_version_conflict" ||
            rotation.error.code === "credential_rotation_conflict"
          ? 409
          : 422;
    return controlError(rotation.error.code, status);
  }
  const provider = rotation.value.connection.provider;
  if (
    !(CREDENTIAL_ROTATION_PROVIDERS as readonly string[]).includes(provider)
  ) {
    await markCredentialRotationFailed({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      credentialRotationId: rotation.value.credentialRotationId,
      failureCode: "replacement_validation_failed",
    });
    return controlError("credential_rotation_provider_unsupported", 422);
  }
  if (
    rotation.value.resumedStatus === null ||
    rotation.value.resumedStatus === "pending_verification"
  ) {
    const validation = await validateReplacementCredential(
      env,
      rotation.value,
      replacementSecret,
    );
    if (!validation.ok) {
      await markCredentialRotationFailed({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        credentialRotationId: rotation.value.credentialRotationId,
        failureCode: validation.failureCode,
      });
      return controlError(validation.failureCode, 422);
    }
    await markCredentialRotationVerified({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      credentialRotationId: rotation.value.credentialRotationId,
      now: Date.now(),
    });
  }
  if (rotation.value.resumedStatus !== "committed") {
    const stored = await storeVaultSecret({
      db: authorized.executionScope.database,
      keys: env,
      organisationId: authorized.organisationId,
      handle: rotation.value.replacementHandle,
      secret:
        provider === "stripe" ||
        provider === "airtable" ||
        provider === "notion"
          ? { kind: "bearer", value: replacementSecret }
          : {
              kind: "header",
              header: "X-Shopify-Access-Token",
              value: replacementSecret,
            },
      now: Date.now(),
    });
    if (!stored.ok) {
      await markCredentialRotationFailed({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        credentialRotationId: rotation.value.credentialRotationId,
        failureCode: "replacement_store_failed",
      });
      return controlError("replacement_store_failed", 502);
    }
    await commitCredentialRotation({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      rotation: rotation.value,
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
      actorUserId: identity.userId,
      receiptBody: {
        receipt_id: rotation.value.credentialRotationId,
        organisation_id: authorized.organisationId,
        integration_account_id: integrationAccountId.value,
      },
      now: Date.now(),
    });
  }
  let activation: "completed" | "reconciling" = "completed";
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    const cutover = await activateProviderCredentialCutover({
      db: authorized.executionScope.database,
      kv: env.POLICY_KV,
      organisation,
      organisationId: authorized.organisationId,
      providerConnectionId: rotation.value.connection.providerConnectionId,
      now: Date.now(),
    });
    if (!cutover.ok) {
      activation = "reconciling";
    }
  } catch {
    activation = "reconciling";
  }
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("credential rotation projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    rotation: {
      credential_rotation_id: rotation.value.credentialRotationId,
      status: "committed",
      previous_generation: rotation.value.authority.credentialGeneration,
      active_generation: rotation.value.authority.credentialGeneration + 1,
      policy_activation: activation,
    },
  });
}
