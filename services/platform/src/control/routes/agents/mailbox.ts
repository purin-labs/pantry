import { runtimeFetch } from "../../../runtime-fetch";
import type { Env } from "../../../env";
import {
  authorizeCredentialRevocation,
  recordCredentialRevocationMutation,
} from "../../../integrations/contract/credential-lifecycle";
import {
  assignAgentMailbox,
  parseMailboxIngressPolicyPublishRequest,
  publishMailboxIngressPolicy,
  type MailboxIngressPolicyPublishRequest,
  readAgentMailboxBinding,
  readEmailMailboxAccount,
  readMailboxIngressPolicy,
} from "../../../data/email-mailbox";
import { setIntegrationAccountLifecycle } from "../../../data/integration-account";
import { revokeCredential } from "../../../credential-vault";
import { resolveCredentialRevocationSecret } from "../../../credential-vault/credential-revocation-resolution";
import { revokeGoogleOAuthToken } from "../../../integrations/contract/google-oauth-revocation";
import { newRequestId, parseIntegrationAccountId } from "../../../ids";
import { traceWarn } from "../../../observability";
import { activateRevocationPolicy } from "../../credential-revocation-policy";
import {
  admitUserMutation,
  controlMutationIdentity,
} from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  isBoundedIdentifier,
  readJsonRecord,
} from "../../http";
import { readInstallationPins } from "../../installation-pins";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { assertNever, hasExactKeys, isRecord } from "@purin-labs/std";
import { readIntegrationAccountReasonCode } from "../../../data/integration-account-reads";
import {
  agentMailboxConnector,
  emailLimitsFromPolicy,
} from "../../../mail-inbox/agent-mailbox-connector";
import { readAgentMailboxProjection } from "../../../mail-inbox/agent-mailbox-projection";
import { withdrawGmailModelConsentsWhenNoMailboxIsOn } from "../../../mail-inbox/contract/gmail-inference-eligibility";
import { consentToGmailModel } from "../../../mail-inbox/gmail-model-consent";
import { parseMailboxModelConsentRequest } from "@purin-labs/control-api";

/** The actions of a mailbox route. The route matcher of the Worker reads them. */
const AGENT_MAILBOX_ROUTE_ACTIONS = [
  "bind",
  "policy",
  "resume",
  "skip-and-resume",
  "reconnect",
  "disable",
  "revoke",
  // An owner or admin accepts the data terms of the workspace's model for
  // new mail. Turn on sends it first when the setup asks for it.
  "model-consent",
] as const;

export type AgentMailboxRouteAction =
  (typeof AGENT_MAILBOX_ROUTE_ACTIONS)[number];

export function isAgentMailboxRouteAction(
  value: string | undefined,
): value is AgentMailboxRouteAction {
  return AGENT_MAILBOX_ROUTE_ACTIONS.some((action) => action === value);
}

type AgentMailboxAction = AgentMailboxRouteAction;

export async function handleAgentMailbox(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  action: AgentMailboxAction | null,
): Promise<Response> {
  if (action === null) {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
    if (!accountId.ok) return controlError("agent_mailbox_not_connected", 404);
    const projection = await readAgentMailboxProjection(
      env,
      authorized.executionScope,
      accountId.value,
    );
    if (projection === null)
      return controlError("agent_mailbox_not_connected", 404);
    return controlJson({ ok: true, mailbox: projection });
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
  if (!accountId.ok) return controlError("agent_mailbox_not_connected", 404);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("agent_mailbox_request_invalid", 422);
  // Revocation destroys credentials and drafts, so it carries the same
  // configuration-version precondition as every other destructive account
  // mutation. The reversible mailbox actions stay unversioned.
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: action === "revoke" ? "configuration_versioned" : "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/agent-mailboxes/${accountId.value}/${action}`,
    operation: `agent_mailbox.${action.replaceAll("-", "_")}`,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const mailbox = await readEmailMailboxAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
  });
  if (!mailbox.ok) return controlError("agent_mailbox_not_connected", 404);
  const now = Date.now();
  if (action === "model-consent") {
    const consent = parseMailboxModelConsentRequest(body.value);
    if (consent === null)
      return controlError("agent_mailbox_request_invalid", 422);
    if (boundary.kind !== "unversioned")
      return controlError("mutation_boundary_invalid", 422);
    const accepted = await consentToGmailModel({
      env,
      scope: authorized.executionScope,
      request: consent,
      consentedBy: identity.userId,
      mutation: {
        boundary,
        scope,
        identity: await controlMutationIdentity(request, identity, now),
      },
      now,
    });
    return accepted.ok
      ? controlJson(accepted.value)
      : controlError(accepted.error.code, 409);
  }
  let responseBody: Record<string, unknown>;
  if (action === "bind") {
    if (
      !hasExactKeys(body.value, ["installationId"]) ||
      typeof body.value.installationId !== "string" ||
      !isBoundedIdentifier(body.value.installationId)
    ) {
      return controlError("agent_mailbox_request_invalid", 422);
    }
    const pinned = await readInstallationPins(
      authorized.executionScope,
      body.value.installationId,
    );
    if (pinned === null)
      return controlError("agent_mailbox_installation_inactive", 422);
    const bound = await assignAgentMailbox({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      mailboxBindingId: `mailbox_binding_${crypto.randomUUID()}`,
      installationId: body.value.installationId,
      grantsDigest: pinned.grantsDigest,
      policyDigest: pinned.policyDigest,
      createdBy: authorized.authenticated.session.userId,
      now,
    });
    if (!bound.ok) {
      return bound.error.code === "mailbox_installation_inactive"
        ? controlError("agent_mailbox_installation_inactive", 422)
        : controlError(
            bound.error.code,
            bound.error.code === "email_mailbox_account_missing" ? 404 : 500,
          );
    }
    responseBody = { ok: true, binding: bound.value };
  } else if (action === "policy" || action === "disable") {
    // Turn off is the policy that an operator turned off, with no body.
    let policy: MailboxIngressPolicyPublishRequest;
    if (action === "disable") {
      if (Object.keys(body.value).length > 0)
        return controlError("agent_mailbox_request_invalid", 422);
      policy = { kind: "disabled_by_operator" };
    } else {
      if (
        !hasExactKeys(body.value, ["policy"]) ||
        !isRecord(body.value.policy)
      ) {
        return controlError("agent_mailbox_request_invalid", 422);
      }
      const parsed = parseMailboxIngressPolicyPublishRequest(body.value.policy);
      if (!parsed.ok) return controlError("agent_mailbox_policy_invalid", 422);
      policy = parsed.value;
    }
    if (policy.kind === "enabled") {
      const binding = await readAgentMailboxBinding({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        integrationAccountId: accountId.value,
      });
      if (!binding.ok) return controlError("agent_mailbox_unassigned", 409);
    }
    const published = await publishMailboxIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      environment: mailbox.value.environment,
      request: policy,
      publishedBy: authorized.authenticated.session.userId,
      now,
    });
    if (!published.ok) {
      return published.error.code === "mailbox_policy_publish_conflict"
        ? controlError("agent_mailbox_policy_conflict", 409)
        : controlError("agent_mailbox_not_connected", 404);
    }
    const connector = await agentMailboxConnector(
      env,
      authorized.organisationId,
      accountId.value,
    );
    if (!connector.ok)
      return controlError("agent_mailbox_connector_unavailable", 502);
    if (published.value.kind === "enabled") {
      const activated = await connector.value.stub.activateEmailProcessing({
        identity: connector.value.identity,
        integrationAccountId: accountId.value,
        policyVersion: published.value.policyVersion,
        limits: emailLimitsFromPolicy(published.value),
        now,
      });
      if (!activated.ok)
        return controlError("agent_mailbox_activation_failed", 502);
      responseBody = {
        ok: true,
        policy: published.value,
        processing: activated.value.processing.kind,
      };
    } else {
      const disabled = await connector.value.stub.disableEmailProcessing({
        identity: connector.value.identity,
        now,
      });
      if (!disabled.ok)
        return controlError("agent_mailbox_deactivation_failed", 502);
      await withdrawGmailModelConsentsWhenNoMailboxIsOn({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        now,
      });
      responseBody = {
        ok: true,
        policy: published.value,
        processing: "waiting",
      };
    }
  } else if (action === "reconnect") {
    if (Object.keys(body.value).length > 0) {
      return controlError("agent_mailbox_request_invalid", 422);
    }
    const current = await readMailboxIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      connectedAt: 0,
    });
    if (current.kind !== "enabled") {
      return controlError("agent_mailbox_policy_not_enabled", 409);
    }
    const connector = await agentMailboxConnector(
      env,
      authorized.organisationId,
      accountId.value,
    );
    if (!connector.ok)
      return controlError("agent_mailbox_connector_unavailable", 502);
    // How the mailbox broke decides how it is repaired. A credential that
    // expired leaves the cursor valid, so keeping it lets the next evaluation
    // catch up on the outage. A cursor Gmail can no longer serve cannot be
    // caught up at all, and only that case takes a fresh floor.
    const reasonCode = await readIntegrationAccountReasonCode(
      authorized.executionScope.database,
      authorized.organisationId,
      accountId.value,
    );
    const resetCursor = reasonCode === "gmail_history_expired";
    const activated = await connector.value.stub.reconnectEmailProcessing({
      identity: connector.value.identity,
      integrationAccountId: accountId.value,
      policyVersion: current.policyVersion,
      limits: emailLimitsFromPolicy(current),
      resetCursor,
      now,
    });
    if (!activated.ok)
      return controlError("agent_mailbox_activation_failed", 502);
    await setIntegrationAccountLifecycle({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      lifecycle: { kind: "active" },
      now,
    });
    responseBody = {
      ok: true,
      processing: activated.value.processing.kind,
      cursor_reset: resetCursor,
      accepted_history_id: activated.value.acceptedHistoryId,
      watch_expires_at: activated.value.watchExpiresAt,
    };
  } else if (action === "revoke") {
    if (Object.keys(body.value).length > 0) {
      return controlError("agent_mailbox_request_invalid", 422);
    }
    if (boundary.kind !== "configuration_versioned") {
      return controlError("mutation_boundary_invalid", 422);
    }
    const authorization = await authorizeCredentialRevocation({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      replacementIntegrationAccountId: null,
      expectedConfigurationVersion: boundary.expectedConfigurationVersion,
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
    const connector = await agentMailboxConnector(
      env,
      authorized.organisationId,
      accountId.value,
    );
    if (!connector.ok)
      return controlError("agent_mailbox_connector_unavailable", 502);
    // Fence and clean up while the credential still works. Reversing this order
    // would leave every outstanding draft undeletable in the organisation's mailbox.
    const revoked = await connector.value.stub.revokeEmailMailbox({
      identity: connector.value.identity,
      kind: "erase",
      integrationAccountId: accountId.value,
      now,
    });
    if (!revoked.ok) return controlError("agent_mailbox_revoke_failed", 502);
    const credential = await resolveCredentialRevocationSecret({
      db: authorized.executionScope.database,
      keys: env,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      provider: "gmail",
      environment: authorization.value.account.environment,
      providerAccountId: authorization.value.account.providerAccountId,
      providerConnectionId: authorization.value.connection.providerConnectionId,
      handle: authorization.value.handle,
    });
    const providerGrant =
      credential.ok && credential.value.kind === "oauth_tokens"
        ? await revokeGoogleOAuthToken(
            credential.value.refreshToken,
            runtimeFetch,
          )
        : {
            kind: "permanent_failure" as const,
            reason: "provider_cleanup_credential_missing" as const,
            instruction: "revoke_gmail_access_in_google" as const,
          };
    await publishMailboxIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      environment: mailbox.value.environment,
      request: { kind: "disabled_by_operator" },
      publishedBy: authorized.authenticated.session.userId,
      now,
    });
    await withdrawGmailModelConsentsWhenNoMailboxIsOn({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      now,
    });
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
      if (!activation.ok)
        return controlError("credential_revocation_policy_pending", 503);
    }
    const unresolved = revoked.value.disposals.filter(
      (disposal) => disposal.kind !== "deleted",
    );
    const revocationBody = {
      ok: true,
      watch_stopped: revoked.value.watchStopped,
      credential_revoked: committed.state === "committed",
      inbox_erased: true,
      provider_grant_revoked: providerGrant.kind === "removed",
      provider_cleanup_needed: providerGrant.kind !== "removed",
      drafts_deleted: revoked.value.disposals.length - unresolved.length,
      cleanup_needed: unresolved.map((disposal) => ({
        proposal_id: disposal.proposalId,
        version: disposal.version,
        state: disposal.kind,
      })),
    };
    await recordCredentialRevocationMutation({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      authorization: authorization.value,
      mutation: {
        boundary,
        scope,
        identity: await controlMutationIdentity(request, identity, now),
      },
      actorUserId: identity.userId,
      receiptBody: {
        receipt_id: `agent-mailbox-revocation:${authorized.organisationId}`,
        organisation_id: authorized.organisationId,
        integration_account_id: accountId.value,
      },
      now,
    });
    return controlJson(revocationBody);
  } else {
    const current = await readMailboxIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId.value,
      connectedAt: 0,
    });
    if (current.kind !== "enabled") {
      return controlError("agent_mailbox_policy_not_enabled", 409);
    }
    let skipProviderMessageId: string | null = null;
    if (action === "skip-and-resume") {
      if (
        !hasExactKeys(body.value, ["providerMessageId"]) ||
        typeof body.value.providerMessageId !== "string" ||
        body.value.providerMessageId.length === 0
      ) {
        return controlError("agent_mailbox_request_invalid", 422);
      }
      skipProviderMessageId = body.value.providerMessageId;
    } else if (Object.keys(body.value).length > 0) {
      return controlError("agent_mailbox_request_invalid", 422);
    }
    const connector = await agentMailboxConnector(
      env,
      authorized.organisationId,
      accountId.value,
    );
    if (!connector.ok)
      return controlError("agent_mailbox_connector_unavailable", 502);
    const resumed = await connector.value.stub.resumeEmailProcessing({
      identity: connector.value.identity,
      policyVersion: current.policyVersion,
      limits: emailLimitsFromPolicy(current),
      skipProviderMessageId,
      now,
    });
    if (!resumed.ok) {
      if (resumed.error.code === "connector_email_not_paused") {
        return controlError("agent_mailbox_not_paused", 409);
      }
      if (resumed.error.code === "connector_email_skip_target_invalid") {
        return controlError("agent_mailbox_skip_target_invalid", 422);
      }
      return controlError("agent_mailbox_resume_failed", 502);
    }
    responseBody = { ok: true, processing: resumed.value.processing.kind };
  }
  // Revocation returned above with its own receipt, so every remaining action
  // carries the unversioned boundary this recorder accepts.
  if (boundary.kind !== "unversioned") {
    return controlError("mutation_boundary_invalid", 422);
  }
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
  return controlJson(responseBody);
}

/**
 * Checks one agent mailbox for new mail now. Gmail tells Pantry about new mail
 * by a Pub/Sub push alone. A push can be late, and a local backend gets none,
 * so an operator can ask for the check. The Connector reads the mailbox's
 * history id with the mailbox's credential and admits it as a push, so the
 * answer is the evaluation that a push would get.
 */
export async function handleAgentMailboxCheck(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
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
  const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
  if (!accountId.ok) return controlError("agent_mailbox_missing", 404);
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length > 0)
    return controlError("agent_mailbox_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/agent-mailboxes/${accountId.value}/check`,
    operation: "agent_mailbox.check",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const mailbox = await readEmailMailboxAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
  });
  if (!mailbox.ok) return controlError("agent_mailbox_missing", 404);
  const policy = await readMailboxIngressPolicy({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
    connectedAt: 0,
  });
  if (policy.kind !== "enabled")
    return controlError("agent_mailbox_not_processing", 409);
  const connector = await agentMailboxConnector(
    env,
    authorized.organisationId,
    accountId.value,
  );
  if (!connector.ok)
    return controlError("agent_mailbox_connector_unavailable", 502);
  const now = Date.now();
  const requestId = newRequestId();
  const checked = await connector.value.stub.checkEmailChange({
    identity: connector.value.identity,
    integrationAccountId: accountId.value,
    checkId: requestId,
    now,
  });
  if (!checked.ok) {
    traceWarn("control.agent_mailbox_check_failed", {
      requestId,
      reason: checked.error.code,
    });
    return controlError("agent_mailbox_check_failed", 502);
  }
  let responseBody: Record<string, unknown>;
  switch (checked.value.kind) {
    case "scheduled":
      responseBody = { kind: "scheduled", at: checked.value.at };
      break;
    case "observed":
      responseBody = { kind: "observed" };
      break;
    case "inactive":
      return controlError("agent_mailbox_not_processing", 409);
    case "duplicate":
      // Each check has a new identifier, so only a broken Connector answers
      // that it saw this one before.
      return controlError("agent_mailbox_check_failed", 502);
    default:
      return assertNever(checked.value);
  }
  const recorded = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recorded.ok) return controlError(recorded.error.code, 409);
  return controlJson(responseBody);
}
