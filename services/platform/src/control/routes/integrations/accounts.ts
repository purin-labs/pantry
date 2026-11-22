import type { Env } from "@purin-labs/kernel/env";
import { organisationServices } from "../../../organisation/contract/organisation-services";
import {
  disableIntegrationAccount,
  listIntegrationAccounts,
  switchDefaultIntegrationAccount,
} from "../../../data/integration-account";
import {
  admitUserMutation,
  controlMutationIdentity,
  projectionReplay,
  projectionResponse,
} from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { connectionParts } from "../../../integrations/contract/connection-parts";
import {
  authorizeAccountRequest,
  parseReplacementAccountId,
} from "./account-request";

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
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "DELETE",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("remove_account_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}`,
    operation: "provider.account.remove",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  // Stand a Gmail mailbox down before the connection goes: removal revokes the
  // Google grant, and a revoked grant cannot delete the drafts Pantry created.
  const mailboxTeardown = await connectionParts
    .use()
    .mailbox.tearDownAgentMailboxForRemoval(
      env,
      authorized.executionScope,
      integrationAccountId,
      "erase",
    );
  if (mailboxTeardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const removed = await organisationServices.use().removeIntegrationAccount({
    db: authorized.executionScope.database,
    directory: env.DB,
    organisationId: authorized.organisationId,
    integrationAccountId,
    removedByUserId: admitted.user.userId,
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
    },
    now,
  });
  if (!removed.ok) {
    return controlError(
      removed.error.code,
      removed.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  return projectionResponse(
    authorized,
    "removed account projection is missing",
    {
      receipt: {
        receipt_id: removed.value.receiptId,
        organisation_id: authorized.organisationId,
      },
      // A draft Pantry could not delete stays in the organisation's mailbox
      // after the grant is revoked, so it is reported rather than dropped
      // silently.
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
    },
  );
}

export async function handleDisableAccount(
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
    return controlError("disable_account_request_invalid", 422);
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
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/disable`,
    operation: "provider.account.disable",
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
      "stand_down",
    );
  if (teardown.kind === "connector_unavailable") {
    return controlError("email_teardown_unavailable", 503);
  }
  const disabled = await disableIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
    replacementIntegrationAccountId: replacement,
    disabledByUserId: admitted.user.userId,
    reasonCode: "merchant_disabled",
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
    },
    now,
  });
  if (!disabled.ok) {
    const status =
      disabled.error.code === "integration_account_not_found" ? 404 : 409;
    return controlError(disabled.error.code, status);
  }
  return projectionResponse(
    authorized,
    "disabled account projection is missing",
    {
      receipt: {
        receipt_id: disabled.value.receiptId,
        organisation_id: authorized.organisationId,
      },
    },
  );
}

export async function handleDefaultAccount(
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
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("default_account_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/default-for-provider`,
    operation: "provider.account.set_default_for_provider",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const switched = await switchDefaultIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    nextIntegrationAccountId: integrationAccountId,
    changedByUserId: admitted.user.userId,
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
    },
    now,
  });
  if (!switched.ok) {
    return controlError(
      switched.error.code,
      switched.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  return projectionResponse(
    authorized,
    "default account projection is missing",
    {
      receipt: {
        receipt_id: switched.value.receiptId,
        organisation_id: authorized.organisationId,
      },
    },
  );
}
