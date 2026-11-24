import type { Env } from "@purin-labs/kernel/env";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  parseVaultHandle,
  revokeCredential,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import {
  authorizeCredentialRevocation,
  beginCredentialRotation,
  commitCredentialRotation,
  listCredentialInventory,
  markCredentialRotationFailed,
  markCredentialRotationVerified,
  recordCredentialRevocationMutation,
} from "@purin-labs/area-integrations-contract/server/credential-lifecycle";
import { activateProviderCredentialCutover } from "@purin-labs/area-integrations-contract/server/credential-cutover";
import {
  admitUserMutation,
  controlMutationIdentity,
  projectionReplay,
  projectionResponse,
} from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import { activateRevocationPolicy } from "@purin-labs/control/worker/credential-revocation-policy";
import { connectionParts } from "../../../contract/connection-parts";
import {
  credentialRotationSlug,
  validateReplacementCredential,
} from "../../../provider-lifecycle/credential-replacement";
import {
  authorizeAccountRequest,
  parseReplacementAccountId,
} from "./account-request";

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
    schema_version: "pantry.credential-inventory.v1",
    inventory: inventory.value,
  });
}

export async function handleRevokeAccountCredential(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "POST",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("revoke_credential_request_invalid", 422);
  }
  const replacement = parseReplacementAccountId(
    body.value.replacementIntegrationAccountId,
  );
  if (replacement === undefined) {
    return controlError("default_account_replacement_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/revoke-credential`,
    operation: "provider.credential.revoke",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const teardown = await connectionParts
    .use()
    .mailbox.tearDownAgentMailboxForRemoval(
      env,
      authorized.executionScope,
      integrationAccountId,
      "erase",
    );
  if (teardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const authorization = await authorizeCredentialRevocation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
    replacementIntegrationAccountId: replacement,
    expectedConfigurationVersion:
      admitted.boundary.expectedConfigurationVersion,
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
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
    },
    actorUserId: admitted.user.userId,
    receiptBody: {
      receipt_id: `credential-revocation:${authorized.organisationId}`,
      organisation_id: authorized.organisationId,
      integration_account_id: integrationAccountId,
    },
    now,
  });
  return projectionResponse(
    authorized,
    "credential revocation projection is missing",
    {
      revocation: {
        revocation_id: committed.revocationId,
        state: committed.state,
        credential_generation_count: committed.credentialGenerationCount,
        vault_secret_count: committed.vaultSecretCount,
        started_at: committed.startedAt,
        committed_at: committed.committedAt,
      },
    },
  );
}

const CREDENTIAL_ROTATION_PROVIDERS = [
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
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "POST",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    typeof body.value.replacementSecret !== "string" ||
    body.value.replacementSecret.trim().length === 0
  ) {
    return controlError("credential_rotation_request_invalid", 422);
  }
  const replacementSecret = body.value.replacementSecret.trim();
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/credential-rotations`,
    operation: "provider.credential.rotate_supplied",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const rotationSlug = credentialRotationSlug(admitted.boundary.idempotencyKey);
  const replacementHandle = parseVaultHandle(
    `vault:${authorized.organisationId.toLowerCase()}:rotation:${rotationSlug}`,
  );
  if (!replacementHandle.ok) {
    return controlError("credential_rotation_request_invalid", 422);
  }
  const rotation = await beginCredentialRotation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
    credentialRotationId: `rotation_${authorized.organisationId}_${rotationSlug}`,
    replacementHandle: replacementHandle.value,
    createdByUserId: admitted.user.userId,
    expectedConfigurationVersion:
      admitted.boundary.expectedConfigurationVersion,
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
        boundary: admitted.boundary,
        scope: admitted.scope,
        identity: await controlMutationIdentity(request, admitted.user, now),
      },
      actorUserId: admitted.user.userId,
      receiptBody: {
        receipt_id: rotation.value.credentialRotationId,
        organisation_id: authorized.organisationId,
        integration_account_id: integrationAccountId,
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
  return projectionResponse(
    authorized,
    "credential rotation projection is missing",
    {
      rotation: {
        credential_rotation_id: rotation.value.credentialRotationId,
        status: "committed",
        previous_generation: rotation.value.authority.credentialGeneration,
        active_generation: rotation.value.authority.credentialGeneration + 1,
        policy_activation: activation,
      },
    },
  );
}
