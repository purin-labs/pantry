import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readInstallationPins } from "@purin-labs/control/worker/installation-pins";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  isBoundedIdentifier,
  noStoreJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import { resolveUser } from "@purin-labs/tenancy/data/control-plane";
import {
  assignWhatsAppSupportAgent,
  ensureWhatsAppSupportContextGrant,
  listWhatsAppPhoneNumberAccounts,
  listWhatsAppReplyProposalProjections,
  parseWhatsAppIngressPolicyPublishRequest,
  projectWhatsAppReplyProposal,
  readWhatsAppCaseConversationWindowByCaseId,
  readWhatsAppIngressPolicy,
  readWhatsAppPhoneNumberAccount,
  selectWhatsAppPhoneNumberAccount,
  readWhatsAppReplyProposalProjection,
  readWhatsAppSupportBinding,
  publishWhatsAppIngressPolicy,
  revokeWhatsAppConnection,
  type WhatsAppIngressPolicy,
  type WhatsAppPhoneNumber,
} from "@purin-labs/area-inbox/server/data/whatsapp";
import type { Env } from "@purin-labs/kernel/env";
import { permissionRequiredResponse } from "@purin-labs/control/worker/permission-required";
import { mailControlAuthority } from "@purin-labs/area-inbox-contract/server/control-authority";
import { whatsappConnector } from "@purin-labs/area-inbox/server/mail-inbox/agent-mailbox-connector";
import {
  authorizeWhatsAppSupportRead,
  whatsappSupportReadPermission,
} from "@purin-labs/area-inbox/server/whatsapp/read-authorization";
import { parseIntegrationAccountId, type IntegrationAccountId } from "@purin-labs/kernel/ids";
import { resolveWhatsAppApplicationConfiguration } from "@purin-labs/connections/whatsapp/application";
import { resolveWhatsAppOrganisationCredential } from "./credential";
import { unsubscribeWhatsAppApp } from "@purin-labs/connections/whatsapp/graph";
import type { Variant } from "@purin-labs/type-utils";
import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";

/**
 * The WhatsApp operator control plane: connect-time account inspection, agent
 * assignment, ingress-policy publication, enable/pause/resume, and the
 * approval queue with takeover and direct human reply.
 *
 * Message text and proposal bodies never enter a list response. They appear
 * only in the single-Case and single-proposal reads, which are served
 * `no-store` and fetch from the Connector's encrypted envelope just in time.
 */

const WHATSAPP_MAX_REPLY_CHARS = 4_000;
const WHATSAPP_QUEUE_LIMIT = 50;
const WHATSAPP_HUMAN_REPLY_TTL_MS = 60 * 60_000;

export type WhatsAppAccountAction =
  | "select"
  | "bind"
  | "policy"
  | "resume"
  | "skip-and-resume"
  | "disable"
  | "reconnect"
  | "revoke";

export type WhatsAppReplyAction = "approve" | "reject" | "edit" | "resolve";

export type WhatsAppCaseAction =
  "take-over" | "return-to-agent" | "human-reply" | "close";

export function isWhatsAppAccountAction(
  raw: string | undefined,
): raw is WhatsAppAccountAction {
  return (
    raw === "select" ||
    raw === "bind" ||
    raw === "policy" ||
    raw === "resume" ||
    raw === "skip-and-resume" ||
    raw === "disable" ||
    raw === "reconnect" ||
    raw === "revoke"
  );
}

export function isWhatsAppReplyAction(
  raw: string | undefined,
): raw is WhatsAppReplyAction {
  return (
    raw === "approve" || raw === "reject" || raw === "edit" || raw === "resolve"
  );
}

export function isWhatsAppCaseAction(
  raw: string | undefined,
): raw is WhatsAppCaseAction {
  return (
    raw === "take-over" ||
    raw === "return-to-agent" ||
    raw === "human-reply" ||
    raw === "close"
  );
}

function whatsappLimitsFromPolicy(
  policy: Variant<WhatsAppIngressPolicy, "enabled">,
): {
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyAgentTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxActiveCaseMessages: number;
  readonly maxActiveCaseBytes: number;
  readonly debounceSeconds: number;
} {
  return {
    maxActiveCases: policy.maxActiveCases,
    maxMessagesPerHour: policy.maxMessagesPerHour,
    dailyAgentTokenBudget: policy.dailyAgentTokenBudget,
    maxMessageBytes: policy.maxMessageBytes,
    maxActiveCaseMessages: policy.maxActiveCaseMessages,
    maxActiveCaseBytes: policy.maxActiveCaseBytes,
    debounceSeconds: policy.debounceSeconds,
  };
}

function projectAccount(
  account: WhatsAppPhoneNumber,
  policy: WhatsAppIngressPolicy,
  binding: {
    readonly supportBindingId: string;
    readonly currentRevision: number;
    readonly installationId: string;
  } | null,
  runtime: unknown,
): JsonRecord {
  return {
    integration_account_id: account.integrationAccountId,
    provider_connection_id: account.providerConnectionId,
    business_portfolio_id: account.businessPortfolioId,
    waba_id: account.wabaId,
    phone_number_id: account.phoneNumberId,
    display_phone_number: account.displayPhoneNumber,
    verified_name: account.verifiedName,
    provider_health: account.providerHealth,
    selected_at: account.selectedAt,
    policy,
    binding:
      binding === null
        ? null
        : {
            support_binding_id: binding.supportBindingId,
            current_revision: binding.currentRevision,
            installation_id: binding.installationId,
          },
    runtime,
  };
}

export async function handleWhatsAppAccounts(
  request: Request,
  env: Env,
  organisationIdRaw: string,
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
  const accounts = await listWhatsAppPhoneNumberAccounts({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  const projected: JsonRecord[] = [];
  for (const account of accounts) {
    const [policy, binding] = await Promise.all([
      readWhatsAppIngressPolicy({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        integrationAccountId: account.integrationAccountId,
        connectedAt: 0,
      }),
      readWhatsAppSupportBinding({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        integrationAccountId: account.integrationAccountId,
      }),
    ]);
    const connector = await whatsappConnector(
      env,
      authorized.organisationId,
      account.integrationAccountId,
    );
    const inspected = connector.ok
      ? await connector.value.stub.inspectWhatsAppRuntime()
      : null;
    const runtime = inspected !== null && inspected.ok ? inspected.value : null;
    projected.push(
      projectAccount(
        account,
        policy,
        binding.ok ? binding.value : null,
        runtime,
      ),
    );
  }
  const application = resolveWhatsAppApplicationConfiguration(env);
  return controlJson({
    ok: true,
    application_configured: application.ok,
    accounts: projected,
  });
}

export async function handleWhatsAppAccount(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  action: WhatsAppAccountAction,
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
  if (!accountId.ok) return controlError("whatsapp_account_not_connected", 404);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("whatsapp_request_invalid", 422);
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
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/whatsapp-accounts/${accountId.value}/${action}`,
    operation: `whatsapp_account.${action.replaceAll("-", "_")}`,
  };
  const replayed = await replayGuard(authorized.executionScope, scope, boundary.value);
  if (replayed !== null) return replayed;
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const account = await readWhatsAppPhoneNumberAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
  });
  if (!account.ok) return controlError("whatsapp_account_not_connected", 404);
  const now = Date.now();
  const outcome = await runAccountAction({
    env,
    authorized,
    account: account.value,
    accountId: accountId.value,
    action,
    body: body.value,
    now,
  });
  if (!outcome.ok) return outcome.error;
  const recordedMutationReceipt = await recordCommerceMutationReceipt({

    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody: outcome.value,
    now,
  });
  if (!recordedMutationReceipt.ok) return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(outcome.value);
}

async function runAccountAction(
  input: Readonly<{
    env: Env;
    authorized: AuthorizedOrganisationRequest;
    account: WhatsAppPhoneNumber;
    accountId: IntegrationAccountId;
    action: WhatsAppAccountAction;
    body: JsonRecord;
    now: number;
  }>,
): Promise<
  | { readonly ok: true; readonly value: JsonRecord }
  | { readonly ok: false; readonly error: Response }
> {
  const { env, authorized, accountId, action, body, now } = input;
  if (action === "select") {
    if (!hasExactKeys(body, [])) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    const selected = await selectWhatsAppPhoneNumberAccount({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId,
      now,
    });
    return selected.ok
      ? {
          ok: true,
          value: { ok: true, selected_at: selected.value.selectedAt },
        }
      : { ok: false, error: controlError(selected.error.code, 409) };
  }
  // Everything past selection acts on a number this organisation actually answers
  // for. A discovered candidate has no claim on the phone-number id, so it
  // cannot be bound, enabled, or replied through. Revoking one is still
  // allowed: declining a discovered number is a legitimate owner decision.
  if (input.account.selectedAt === null && action !== "revoke") {
    return {
      ok: false,
      error: controlError("whatsapp_account_unselected", 409),
    };
  }
  if (action === "bind") {
    if (
      !hasExactKeys(body, ["installationId"]) ||
      typeof body.installationId !== "string" ||
      !isBoundedIdentifier(body.installationId)
    ) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    const pinned = await readInstallationPins(
      authorized.executionScope,
      body.installationId,
    );
    if (pinned === null) {
      return {
        ok: false,
        error: controlError("whatsapp_installation_inactive", 422),
      };
    }
    const execution = await OrganisationExecutionScope.resolve(
      env,
      authorized.organisationId,
    );
    if (!execution.ok)
      return { ok: false, error: controlError(execution.error.code, 409) };
    const bound = await assignWhatsAppSupportAgent({
      scope: execution.value,
      integrationAccountId: accountId,
      supportBindingId: `whatsapp_binding_${crypto.randomUUID()}`,
      installationId: body.installationId,
      grantsDigest: pinned.grantsDigest,
      policyDigest: pinned.policyDigest,
      createdBy: authorized.authenticated.session.userId,
      now,
    });
    if (!bound.ok) {
      const status =
        bound.error.code === "organisation_placement_conflict" ? 409 : 422;
      return { ok: false, error: controlError(bound.error.code, status) };
    }
    return { ok: true, value: { ok: true, binding: bound.value } };
  }
  if (action === "policy") {
    if (
      !isRecord(body) ||
      (hasExactKeys(body, ["agent"])
        ? !isRecord(body.agent)
        : !hasExactKeys(body, ["policy"]) || !isRecord(body.policy))
    ) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    // Plan 83: the agent setting changes only its own fields of the current
    // policy. A number with no enabled policy has no setting to change yet.
    let policyRequest: unknown = body.policy;
    if (isRecord(body.agent)) {
      const current = await readWhatsAppIngressPolicy({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        integrationAccountId: accountId,
        connectedAt: now,
      });
      if (current.kind !== "enabled")
        return {
          ok: false,
          error: controlError("whatsapp_policy_not_enabled", 409),
        };
      policyRequest = {
        ...current,
        agentMode: body.agent.agentMode,
        alwaysWaitTopics: body.agent.alwaysWaitTopics,
      };
    }
    const parsed = parseWhatsAppIngressPolicyPublishRequest(policyRequest);
    if (!parsed.ok)
      return { ok: false, error: controlError("whatsapp_policy_invalid", 422) };
    const binding = await readWhatsAppSupportBinding({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId,
    });
    if (parsed.value.kind === "enabled" && !binding.ok) {
      return { ok: false, error: controlError("whatsapp_unassigned", 409) };
    }
    const published = await publishWhatsAppIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId,
      environment: input.account.environment,
      request: parsed.value,
      publishedBy: authorized.authenticated.session.userId,
      now,
    });
    if (!published.ok) {
      return {
        ok: false,
        error: controlError(
          published.error.code,
          published.error.code === "whatsapp_policy_publish_conflict"
            ? 409
            : 404,
        ),
      };
    }
    const connector = await whatsappConnector(
      env,
      authorized.organisationId,
      accountId,
    );
    if (!connector.ok) {
      return {
        ok: false,
        error: controlError("whatsapp_connector_unavailable", 502),
      };
    }
    if (published.value.kind === "enabled" && binding.ok) {
      const execution = await OrganisationExecutionScope.resolve(
        env,
        authorized.organisationId,
      );
      if (!execution.ok)
        return { ok: false, error: controlError(execution.error.code, 409) };
      const contextGrant = await ensureWhatsAppSupportContextGrant({
        scope: execution.value,
        integrationAccountId: accountId,
        supportBindingId: binding.value.supportBindingId,
        bindingRevision: binding.value.currentRevision,
        now,
      });
      if (!contextGrant.ok) {
        const status =
          contextGrant.error.code === "organisation_placement_conflict" ? 409 : 500;
        return {
          ok: false,
          error: controlError(contextGrant.error.code, status),
        };
      }
      const credential = await resolveWhatsAppOrganisationCredential({
        env,
        scope: authorized.executionScope,
        integrationAccountId: accountId,
        now,
      });
      if (!credential.ok) {
        return { ok: false, error: controlError(credential.error.code, 503) };
      }
      const activated = await connector.value.stub.activateWhatsAppProcessing({
        identity: connector.value.identity,
        integrationAccountId: accountId,
        policyVersion: published.value.policyVersion,
        limits: whatsappLimitsFromPolicy(published.value),
        supportBindingId: binding.value.supportBindingId,
        bindingRevision: binding.value.currentRevision,
        credentialGeneration: credential.value.credentialGeneration,
        now,
      });
      return activated.ok
        ? {
            ok: true,
            value: {
              ok: true,
              policy: published.value,
              processing: activated.value.processing.kind,
            },
          }
        : { ok: false, error: controlError("whatsapp_activation_failed", 502) };
    }
    const disabled = await connector.value.stub.disableWhatsAppProcessing({
      identity: connector.value.identity,
      now,
    });
    return disabled.ok
      ? {
          ok: true,
          value: { ok: true, policy: published.value, processing: "waiting" },
        }
      : { ok: false, error: controlError("whatsapp_deactivation_failed", 502) };
  }
  if (action === "disable") {
    if (Object.keys(body).length > 0) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    const published = await publishWhatsAppIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: accountId,
      environment: input.account.environment,
      request: { kind: "disabled_by_operator" },
      publishedBy: authorized.authenticated.session.userId,
      now,
    });
    if (!published.ok) {
      return { ok: false, error: controlError(published.error.code, 409) };
    }
    const connector = await whatsappConnector(
      env,
      authorized.organisationId,
      accountId,
    );
    if (!connector.ok) {
      return {
        ok: false,
        error: controlError("whatsapp_connector_unavailable", 502),
      };
    }
    const disabled = await connector.value.stub.disableWhatsAppProcessing({
      identity: connector.value.identity,
      now,
    });
    return disabled.ok
      ? {
          ok: true,
          value: { ok: true, policy: published.value, processing: "waiting" },
        }
      : { ok: false, error: controlError("whatsapp_deactivation_failed", 502) };
  }
  if (action === "revoke") {
    return revokeWhatsAppAccess(input);
  }
  if (action === "reconnect") {
    if (Object.keys(body).length > 0) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    return {
      ok: true,
      value: {
        ok: true,
        kind: "reconnect_required",
        provider: "whatsapp",
        start_path: `/v1/control/organisations/${authorized.organisationId}/providers/whatsapp/start`,
      },
    };
  }
  const current = await readWhatsAppIngressPolicy({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId,
    connectedAt: 0,
  });
  if (current.kind !== "enabled") {
    return {
      ok: false,
      error: controlError("whatsapp_policy_not_enabled", 409),
    };
  }
  const binding = await readWhatsAppSupportBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId,
  });
  if (!binding.ok)
    return { ok: false, error: controlError("whatsapp_unassigned", 409) };
  let skipProviderMessageId: string | null = null;
  if (action === "skip-and-resume") {
    if (
      !hasExactKeys(body, ["providerMessageId"]) ||
      typeof body.providerMessageId !== "string" ||
      body.providerMessageId.length === 0
    ) {
      return {
        ok: false,
        error: controlError("whatsapp_request_invalid", 422),
      };
    }
    skipProviderMessageId = body.providerMessageId;
  } else if (Object.keys(body).length > 0) {
    return { ok: false, error: controlError("whatsapp_request_invalid", 422) };
  }
  const credential = await resolveWhatsAppOrganisationCredential({
    env,
    scope: authorized.executionScope,
    integrationAccountId: accountId,
    now,
  });
  if (!credential.ok)
    return { ok: false, error: controlError(credential.error.code, 503) };
  const connector = await whatsappConnector(
    env,
    authorized.organisationId,
    accountId,
  );
  if (!connector.ok) {
    return {
      ok: false,
      error: controlError("whatsapp_connector_unavailable", 502),
    };
  }
  const resumed = await connector.value.stub.resumeWhatsAppProcessing({
    identity: connector.value.identity,
    policyVersion: current.policyVersion,
    limits: whatsappLimitsFromPolicy(current),
    supportBindingId: binding.value.supportBindingId,
    bindingRevision: binding.value.currentRevision,
    credentialGeneration: credential.value.credentialGeneration,
    skipProviderMessageId,
    now,
  });
  if (!resumed.ok) {
    const status =
      resumed.error.code === "connector_whatsapp_not_paused" ? 409 : 502;
    return { ok: false, error: controlError(resumed.error.code, status) };
  }
  return {
    ok: true,
    value: { ok: true, processing: resumed.value.processing.kind },
  };
}

/**
 * Revocation is the organisation taking Pantry's access away. Pantry asks Meta to
 * remove the app subscription, then revokes
 * locally whether or not Meta answered: an unreachable provider must not
 * leave an organisation unable to cut Pantry off. The Graph outcome is reported back
 * so an operator can finish the removal in Meta's own UI if it failed.
 */
async function revokeWhatsAppAccess(
  input: Readonly<{
    env: Env;
    authorized: AuthorizedOrganisationRequest;
    account: WhatsAppPhoneNumber;
    accountId: IntegrationAccountId;
    body: JsonRecord;
    now: number;
  }>,
): Promise<
  | { readonly ok: true; readonly value: JsonRecord }
  | { readonly ok: false; readonly error: Response }
> {
  const { env, authorized, account, body, now } = input;
  if (!hasExactKeys(body, ["confirmed"]) || body.confirmed !== true) {
    return {
      ok: false,
      error: controlError("whatsapp_revoke_not_confirmed", 422),
    };
  }
  const credential = await resolveWhatsAppOrganisationCredential({
    env,
    scope: authorized.executionScope,
    integrationAccountId: input.accountId,
    now,
  });
  const providerRemoval = credential.ok
    ? (
        await unsubscribeWhatsAppApp({
          wabaId: account.wabaId,
          accessToken: credential.value.accessToken,
          fetcher: runtimeFetch,
        })
      ).ok
    : false;
  const revoked = await revokeWhatsAppConnection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    providerConnectionId: account.providerConnectionId,
    now,
  });
  if (!revoked.ok) {
    return { ok: false, error: controlError(revoked.error.code, 409) };
  }
  for (const revokedAccount of revoked.value.accounts) {
    const connector = await whatsappConnector(
      env,
      authorized.organisationId,
      revokedAccount.integrationAccountId,
    );
    if (!connector.ok) continue;
    await connector.value.stub.disableWhatsAppProcessing({
      identity: connector.value.identity,
      now,
    });
  }
  return {
    ok: true,
    value: {
      ok: true,
      kind: "revoked",
      credential_generation: revoked.value.credentialGeneration,
      revoked_integration_account_ids: revoked.value.accounts.map(
        (revokedAccount) => revokedAccount.integrationAccountId,
      ),
      provider_removal: providerRemoval ? "removed" : "manual_action_required",
    },
  };
}

/**
 * The approval queue lists identifiers and lifecycle only. Bodies stay in the
 * Connector's encrypted envelope and are fetched by the single-proposal
 * preview, so the queue never becomes a durable copy of customer content.
 */
/**
 * Customer text reaches a person only under their grant on the number (Plan 83).
 * The refusal names the grant, so that the Portal can ask for it in place.
 */
async function whatsappTextReadable(
  authorized: AuthorizedOrganisationRequest,
  integrationAccountId: IntegrationAccountId,
): Promise<Response | null> {
  const authority = await mailControlAuthority(authorized);
  if (
    authority !== null &&
    (await authorizeWhatsAppSupportRead(
      authorized.executionScope,
      authority,
      integrationAccountId,
    ))
  )
    return null;
  const permission = await whatsappSupportReadPermission(
    authorized.executionScope,
    authorized.membership.personId,
    integrationAccountId,
  );
  return permission === null
    ? controlError("whatsapp_read_refused", 403)
    : permissionRequiredResponse(
        "whatsapp_read_permission_required",
        permission,
      );
}

export async function handleWhatsAppReplyQueue(
  request: Request,
  env: Env,
  organisationIdRaw: string,
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
  const proposals = await listWhatsAppReplyProposalProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: WHATSAPP_QUEUE_LIMIT,
  });
  return noStoreJson({
    ok: true,
    proposals: proposals.map((proposal) => ({
      proposal_id: proposal.proposalId,
      integration_account_id: proposal.integrationAccountId,
      case_id: proposal.caseId,
      customer_wa_id: proposal.customerWaId,
      version: proposal.currentVersion,
      lifecycle_kind: proposal.lifecycleKind,
      author: proposal.author,
      service_window_expires_at: proposal.serviceWindowExpiresAt,
      updated_at: proposal.updatedAt,
    })),
  });
}

export async function handleWhatsAppReply(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalIdRaw: string,
  action: WhatsAppReplyAction | null,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    action === null ? "viewer" : "admin",
    action !== null,
  );
  if (!authorized.ok) return authorized.response;
  const projection = await readWhatsAppReplyProposalProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    proposalId: proposalIdRaw,
  });
  if (projection === null) return controlError("whatsapp_reply_not_found", 404);
  const accountId = parseIntegrationAccountId(projection.integrationAccountId);
  if (!accountId.ok) return controlError("whatsapp_reply_not_found", 404);
  const connector = await whatsappConnector(
    env,
    authorized.organisationId,
    accountId.value,
  );
  if (!connector.ok) return controlError("whatsapp_connector_unavailable", 502);
  const now = Date.now();

  if (action === null) {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const readable = await whatsappTextReadable(
      authorized,
      accountId.value,
    );
    if (readable !== null) return readable;
    const preview = await connector.value.stub.previewWhatsAppProposal({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      now,
    });
    if (!preview.ok) return controlError(preview.error.code, 502);
    if (preview.value.kind === "expired") {
      const projected = await projectWhatsAppReplyProposal({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        integrationAccountId: accountId.value,
        proposalId: projection.proposalId,
        caseId: projection.caseId,
        customerWaId: projection.customerWaId,
        currentVersion: projection.currentVersion,
        lifecycleKind: "expired",
        author: projection.author,
        serviceWindowExpiresAt: projection.serviceWindowExpiresAt,
        now,
      });
      if (!projected.ok) return controlError(projected.error.code, 502);
    }
    if (preview.value.kind !== "current") {
      return noStoreJson({ ok: true, kind: preview.value.kind });
    }
    const current = preview.value.preview;
    return noStoreJson({
      ok: true,
      kind: "current",
      proposal: {
        proposal_id: current.proposalId,
        version: current.version,
        case_id: current.caseId,
        customer_wa_id: current.customerWaId,
        author: current.author,
        body: current.body,
        body_digest: current.bodyDigest,
        service_window_expires_at: current.serviceWindowExpiresAt,
        expires_at: current.expiresAt,
      },
    });
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("whatsapp_request_invalid", 422);
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
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/whatsapp-replies/${projection.proposalId}/${action}`,
    operation: `whatsapp_reply.${action}`,
  };
  const replayed = await replayGuard(authorized.executionScope, scope, boundary.value);
  if (replayed !== null) return replayed;
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const operator = authorized.authenticated.session.userId;
  let responseBody: JsonRecord;

  if (action === "approve") {
    if (
      !hasExactKeys(body.value, ["version", "bodyDigest"]) ||
      !isPositiveInteger(body.value.version) ||
      typeof body.value.bodyDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(body.value.bodyDigest)
    ) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const dispatched = await connector.value.stub.dispatchWhatsAppReply({
      origin: { kind: "operator" },
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      approvedVersion: body.value.version,
      approvedBodyDigest: body.value.bodyDigest,
      approvedBy: operator,
      now,
    });
    if (!dispatched.ok) return controlError(dispatched.error.code, 502);
    responseBody = { ok: true, result: dispatched.value };
  } else if (action === "reject") {
    if (Object.keys(body.value).length > 0) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const disposed = await connector.value.stub.disposeWhatsAppProposal({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      state: "rejected",
      actorUserId: operator,
      now,
    });
    if (!disposed.ok) return controlError(disposed.error.code, 502);
    responseBody = { ok: true, result: disposed.value };
  } else if (action === "edit") {
    if (
      !hasExactKeys(body.value, ["body"]) ||
      typeof body.value.body !== "string"
    ) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const edited = await connector.value.stub.editWhatsAppProposal({
      origin: { kind: "operator" },
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      body: body.value.body,
      maxReplyChars: WHATSAPP_MAX_REPLY_CHARS,
      now,
    });
    if (!edited.ok) return controlError(edited.error.code, 502);
    responseBody = { ok: true, result: edited.value };
  } else {
    const resolution = body.value.resolution;
    if (!hasExactKeys(body.value, ["resolution"]) || !isRecord(resolution)) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const parsed =
      resolution.kind === "not_delivered"
        ? { kind: "not_delivered" as const }
        : resolution.kind === "delivered" &&
            typeof resolution.whatsappMessageId === "string"
          ? {
              kind: "delivered" as const,
              whatsappMessageId: resolution.whatsappMessageId,
            }
          : null;
    if (parsed === null) return controlError("whatsapp_request_invalid", 422);
    const resolved =
      await connector.value.stub.resolveWhatsAppIndeterminateSend({
        identity: connector.value.identity,
        proposalId: projection.proposalId,
        resolution: parsed,
        now,
      });
    if (!resolved.ok) return controlError(resolved.error.code, 502);
    responseBody = { ok: true, result: resolved.value };
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({

    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok) return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

export async function handleWhatsAppCase(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  caseIdRaw: string,
  action: WhatsAppCaseAction | null,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    action === null ? "viewer" : "admin",
    action !== null,
  );
  if (!authorized.ok) return authorized.response;
  const conversationWindow = await readWhatsAppCaseConversationWindowByCaseId({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    caseId: caseIdRaw,
  });
  if (conversationWindow === null) return controlError("whatsapp_case_not_found", 404);
  const connector = await whatsappConnector(
    env,
    authorized.organisationId,
    conversationWindow.integrationAccountId,
  );
  if (!connector.ok) return controlError("whatsapp_connector_unavailable", 502);
  const now = Date.now();

  if (action === null) {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const readable = await whatsappTextReadable(
      authorized,
      conversationWindow.integrationAccountId,
    );
    if (readable !== null) return readable;
    const panel = await connector.value.stub.readWhatsAppCasePanel({
      identity: connector.value.identity,
      caseId: caseIdRaw,
      now,
    });
    if (!panel.ok) return controlError(panel.error.code, 502);
    return noStoreJson({ ok: true, case: panel.value });
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("whatsapp_request_invalid", 422);
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
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/whatsapp-cases/${caseIdRaw}/${action}`,
    operation: `whatsapp_case.${action.replaceAll("-", "_")}`,
  };
  const replayed = await replayGuard(authorized.executionScope, scope, boundary.value);
  if (replayed !== null) return replayed;
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const operator = authorized.authenticated.session.userId;
  let responseBody: JsonRecord;

  if (action === "take-over") {
    if (Object.keys(body.value).length > 0) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const taken = await connector.value.stub.takeOverWhatsAppCase({
      origin: { kind: "operator" },
      identity: connector.value.identity,
      caseId: caseIdRaw,
      operatorUserId: operator,
      now,
    });
    if (!taken.ok) return controlError(taken.error.code, 502);
    responseBody = { ok: true, result: taken.value };
  } else if (action === "return-to-agent") {
    if (Object.keys(body.value).length > 0) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const returned = await connector.value.stub.returnWhatsAppCaseToAgent({
      identity: connector.value.identity,
      caseId: caseIdRaw,
      now,
    });
    if (!returned.ok) return controlError(returned.error.code, 502);
    responseBody = { ok: true, result: returned.value };
  } else if (action === "close") {
    if (Object.keys(body.value).length > 0) {
      return controlError("whatsapp_request_invalid", 422);
    }
    const closed = await connector.value.stub.closeWhatsAppCase({
      identity: connector.value.identity,
      caseId: caseIdRaw,
      now,
    });
    if (!closed.ok) return controlError(closed.error.code, 502);
    responseBody = { ok: true, result: closed.value };
  } else {
    if (
      !hasExactKeys(body.value, ["body", "confirmed"]) ||
      typeof body.value.body !== "string" ||
      body.value.confirmed !== true
    ) {
      return controlError("whatsapp_request_invalid", 422);
    }
    if (
      conversationWindow.ownership.kind !== "human_owned" ||
      conversationWindow.ownership.ownerId !== operator
    ) {
      return controlError("whatsapp_case_not_owned", 409);
    }
    const composed = await connector.value.stub.composeWhatsAppHumanReply({
      origin: { kind: "operator" },
      identity: connector.value.identity,
      caseId: caseIdRaw,
      proposalId: `proposal_human_${crypto.randomUUID()}`,
      body: body.value.body,
      maxReplyChars: WHATSAPP_MAX_REPLY_CHARS,
      expiresAt: Math.min(
        now + WHATSAPP_HUMAN_REPLY_TTL_MS,
        conversationWindow.serviceWindowExpiresAt,
      ),
      now,
    });
    if (!composed.ok) return controlError(composed.error.code, 502);
    // The operator is the author and the sender, so this needs no second-person
    // approval — but it does need to actually go out. Composing alone would
    // leave a draft the operator was told had been sent.
    const sent = await connector.value.stub.dispatchWhatsAppReply({
      origin: { kind: "operator" },
      identity: connector.value.identity,
      proposalId: composed.value.proposalId,
      approvedVersion: composed.value.version,
      approvedBodyDigest: composed.value.bodyDigest,
      approvedBy: operator,
      now,
    });
    if (!sent.ok) return controlError(sent.error.code, 502);
    responseBody = { ok: true, result: sent.value };
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({

    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok) return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function replayGuard(
  execution: OrganisationExecutionScope,
  scope: ControlMutationReceiptScope,
  boundary: UnversionedControlMutationBoundary,
): Promise<Response | null> {
  const replay = await readControlMutationReplay({
    db: execution.database,
    scope,
    boundary,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  return replay.kind === "replay"
    ? controlJson(replay.receipt.responseBody, replay.receipt.responseStatus)
    : null;
}
