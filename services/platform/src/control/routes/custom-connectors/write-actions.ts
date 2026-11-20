import type { DecidePendingDecision } from "../../decide-pending-decision";
import { acceptedExecutionAuthority } from "../../../organisation-access/access";
import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import { controlActionMutationExecution } from "../../../actors/action-mutation-execution";
import { decideCurrentAuthorityFlowSink } from "../../../chat/information-flow";
import { customConnectorFetchOf } from "../../../custom-connectors/egress";
import type { Env, OrganisationActorStub } from "../../../env";
import { requireActiveOrganisationActor } from "../../../actors/actor-router";
import {
  approvalActionBindingMatches,
  digestApprovalAction,
  type ApprovalEvidence,
} from "../../../approval-authentication";
import { authorizeCapabilityUse } from "../../../authorization/access-grants/turn-authority";
import {
  consumeGoogleApprovalCeremony,
  verifyGoogleApprovalGrant,
} from "../../oidc";
import {
  executeApprovedCustomConnectorWrite,
  resolveApprovedCustomConnectorWrite,
  resolveCustomConnectorWritePreview,
} from "../../../custom-connectors";
import {
  authorizeOrganisationControl,
  type User,
} from "../../../data/control-plane";
import type {
  UnversionedControlMutationBoundary,
  ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import { FlowBinding } from "../../../policy/information-flow";
import {
  controlMutationScope,
  parseMutationBoundary,
  replayControlMutation,
  resolveMutationUser,
} from "../../admission/control-mutation";
import {
  authorizeOrganisationRequest,
  authenticateControlMutation,
  APPROVAL_GRANT_COOKIE,
  parseCookies,
  type AuthorizedOrganisationRequest,
} from "../../authorization";
import { googleConfig } from "../../google-oidc-config";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import type { Variant } from "@purin-labs/type-utils";
import { hasExactKeys } from "@purin-labs/std";
import type { CustomConnectorControlRoute } from "../custom-connectors";
import { customError, requireAdminRole } from "./mutation";
import {
  customActionMatchesConnector,
  customConnectorActionRecord,
} from "../../../custom-connectors/write-action-record";

export async function handleCustomConnectorWriteAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorWriteAction">,
  decide: DecidePendingDecision,
): Promise<Response> {
  if (!isActionNonce(route.actionNonceRaw)) {
    return controlError("custom_connector_action_not_found", 404);
  }
  if (route.action === "read") {
    return readCustomConnectorWriteAction(request, env, route);
  }
  if (route.action === "approval") {
    return decide(
      { request, organisationIdRaw: route.organisationIdRaw },
      {
        kind: "governed_action",
        surface: "custom_connector",
        connectorIdRaw: route.connectorIdRaw,
        id: route.actionNonceRaw,
        answer: "allow",
      },
    );
  }
  if (route.action === "execute" || route.action === "retry") {
    return executeCustomConnectorWriteAction(request, env, route);
  }
  return reconcileCustomConnectorWriteAction(request, env, route);
}

async function readCustomConnectorWriteAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorWriteAction">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: authorized.organisationId,
    nonce: route.actionNonceRaw,
    now: Date.now(),
  });
  return action.ok &&
    customActionMatchesConnector(action.value, route.connectorIdRaw)
    ? controlJson({
        ok: true,
        action: await customConnectorActionRecord(
          authorized.executionScope.database,
          action.value,
          authorized.membership.role,
        ),
      })
    : controlError("custom_connector_action_not_found", 404);
}

/**
 * Records the approval of one write of a custom connector. The caller
 * checked that the id has the form of an action nonce.
 */
export async function approveCustomConnectorWriteAction(
  request: Request,
  env: Env,
  route: Readonly<{
    organisationIdRaw: string;
    connectorIdRaw: string;
    actionNonceRaw: string;
  }>,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const context = await prepareWriteMutation(request, env, route, "approval");
  if (!context.ok) return context.response;
  const now = Date.now();
  if (now - context.authorized.authenticated.session.createdAt > 10 * 60_000) {
    return controlError("approval_step_up_required", 401);
  }
  const config = googleConfig(env);
  const grantRaw = parseCookies(request.headers.get("cookie")).get(
    APPROVAL_GRANT_COOKIE,
  );
  if (config === null) return controlError("google_oidc_unconfigured", 503);
  if (grantRaw === undefined)
    return controlError("approval_step_up_required", 401);
  const grant = await verifyGoogleApprovalGrant({
    raw: grantRaw,
    clientSecret: config.clientSecret,
    now,
  });
  if (
    !grant.ok ||
    grant.value.userId !== context.authorized.authenticated.session.userId ||
    grant.value.challenge.expiresAt <= now ||
    grant.value.challenge.organisationId !==
      context.authorized.organisationId ||
    grant.value.challenge.actionNonce !== route.actionNonceRaw
  ) {
    return controlError("approval_step_up_required", 401);
  }
  const existing = await context.organisation.getAction({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    now,
  });
  if (
    !existing.ok ||
    !customActionMatchesConnector(existing.value, route.connectorIdRaw)
  ) {
    return controlError("custom_connector_action_not_found", 404);
  }
  const digest = await digestApprovalAction(existing.value.action);
  if (
    !approvalActionBindingMatches(
      grant.value.challenge,
      existing.value.action,
      digest,
    )
  ) {
    return controlError("approval_step_up_required", 409);
  }
  const replayed = await replayWriteMutation(request, env, context);
  if (replayed !== null) return replayed;
  if (
    existing.value.state === "proposed" ||
    existing.value.state === "approval_requested"
  ) {
    const authority = existing.value.action.authority;
    if (authority.kind !== "custom_connector") {
      return controlError("custom_connector_action_not_found", 404);
    }
    const current = await resolveApprovedCustomConnectorWrite({
      db: context.executionScope.database,
      organisationId: context.authorized.organisationId,
      integrationAccountId: existing.value.action.integrationAccountId,
      authority,
    });
    if (!current.ok) return customError(current.error.code, current.error);
    const preview = await resolveCustomConnectorWritePreview({
      db: context.executionScope.database,
      organisationId: context.authorized.organisationId,
      integrationAccountId: existing.value.action.integrationAccountId,
      authority,
    });
    if (preview.kind !== "available") {
      return controlError("custom_connector_write_review_unavailable", 409);
    }
    const consumed = await consumeGoogleApprovalCeremony({
      db: env.DB,
      stateHash: grant.value.stateHash,
      challenge: grant.value.challenge,
    });
    if (!consumed) return controlError("approval_step_up_required", 401);
    const actionExecution = await controlActionMutationExecution(
      env,
      context.authorized.organisationId,
      context.authorized.authenticated.session,
    );
    if (!actionExecution.ok)
      return controlError(actionExecution.error.code, 409);
    const requested = await context.organisation.requestActionApproval({
      execution: actionExecution.value,
      organisationId: context.authorized.organisationId,
      nonce: route.actionNonceRaw,
      now,
    });
    if (!requested.ok) return customActionLedgerError(requested.error.code);
  }
  const approval: ApprovalEvidence = {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: context.identity.userId,
      personId: context.authorized.membership.personId,
      role: requireAdminRole(context.authorized.membership.role),
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId:
        context.authorized.authenticated.session.controlSessionId,
      authenticatedAt: context.authorized.authenticated.session.createdAt,
      challenge: grant.value.challenge,
    },
  };
  if (!(await authorizeWriteMutation(request, env, context)))
    return controlError("custom_connector_write_forbidden", 403);
  const signed = await context.organisation.signAction({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    approval,
    now,
  });
  if (!signed.ok) return customActionLedgerError(signed.error.code);
  const responseBody = {
    ok: true,
    action: await customConnectorActionRecord(
      context.executionScope.database,
      signed.value,
      context.authorized.membership.role,
    ),
  };
  return answerWriteAction(request, env, context, responseBody, now);
}

async function executeCustomConnectorWriteAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorWriteAction">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  // A retry resends an indeterminate write. Only a provider_idempotent write
  // can be retried: the provider applies one write for its key.
  const operation = route.action === "retry" ? "retry" : "execute";
  const context = await prepareWriteMutation(request, env, route, operation);
  if (!context.ok) return context.response;
  const replayed = await replayWriteMutation(request, env, context);
  if (replayed !== null) return replayed;
  const now = Date.now();
  const existing = await context.organisation.getAction({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    now,
  });
  if (
    !existing.ok ||
    !customActionMatchesConnector(existing.value, route.connectorIdRaw)
  ) {
    return controlError("custom_connector_action_not_found", 404);
  }
  if (
    existing.value.state === "confirmed" ||
    existing.value.state === "failed"
  ) {
    const responseBody = {
      ok: true,
      action: await customConnectorActionRecord(
        context.executionScope.database,
        existing.value,
        context.authorized.membership.role,
      ),
    };
    return answerWriteAction(request, env, context, responseBody, now);
  }
  if (existing.value.state === "indeterminate" && operation === "execute") {
    if (!(await authorizeWriteMutation(request, env, context)))
      return controlError("custom_connector_write_forbidden", 403);
    return controlJson(
      {
        ok: false,
        error: "custom_connector_effect_indeterminate",
        action: await customConnectorActionRecord(
          context.executionScope.database,
          existing.value,
          context.authorized.membership.role,
        ),
      },
      202,
    );
  }
  if (
    existing.value.state !==
    (operation === "execute" ? "signed" : "indeterminate")
  ) {
    return controlError("custom_connector_action_state_conflict", 409);
  }
  const authority = existing.value.action.authority;
  if (authority.kind !== "custom_connector") {
    return controlError("custom_connector_action_not_found", 404);
  }
  if (
    operation === "retry" &&
    authority.retryPolicy.kind !== "provider_idempotent"
  ) {
    return controlError("custom_connector_retry_unsupported", 409);
  }
  const exactCapability = {
    kind: "custom_connector_operation" as const,
    capabilityId: "custom_connector.write",
    capabilityVersion: 1,
    integrationAccountId: existing.value.action.integrationAccountId,
    connectorId: authority.connectorId,
    definitionRevision: authority.definitionRevision,
    definitionDigest: authority.definitionDigest,
    operationId: authority.operationId,
  };
  const authorized = await authorizeCapabilityUse({
    db: context.executionScope.database,
    accountAccess: context.executionScope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      existing.value.action.sessionId,
      existing.value.action.nonce.value,
    ),
    action: "execute",
    organisationId: context.authorized.organisationId,
    authority: existing.value.action.requestAuthority,
    authorityPartition: existing.value.action.authorityPartition,
    request: { capabilities: [exactCapability] },
  });
  if (!authorized.ok)
    return controlError("custom_connector_write_forbidden", 403);
  const binding = await FlowBinding.restore(existing.value.action.flowBinding);
  if (!binding.ok)
    return controlError("custom_connector_write_flow_unavailable", 503);
  const flow = await decideCurrentAuthorityFlowSink(
    context.executionScope.database,
    context.executionScope.accountAccess,
    {
      binding: binding.value,
      sink: {
        kind: "tool_effect",
        destinationAuthority: existing.value.action.requestAuthority,
        capabilityId: "custom_connector.write",
        integrationAccountId: existing.value.action.integrationAccountId,
        resourceScope: existing.value.action.resourceKey,
        approvalSatisfied: true,
      },
    },
  );
  if (flow.kind !== "allow")
    return controlError("custom_connector_write_flow_denied", 403);
  const entry = await resolveApprovedCustomConnectorWrite({
    db: context.executionScope.database,
    organisationId: context.authorized.organisationId,
    integrationAccountId: existing.value.action.integrationAccountId,
    authority,
  });
  if (!entry.ok) return customError(entry.error.code, entry.error);
  if (!(await authorizeWriteMutation(request, env, context)))
    return controlError("custom_connector_write_forbidden", 403);
  const begun =
    operation === "execute"
      ? await context.organisation.beginActionExecution({
          organisationId: context.authorized.organisationId,
          nonce: route.actionNonceRaw,
          now,
        })
      : await context.organisation.retryIndeterminateActionExecution({
          organisationId: context.authorized.organisationId,
          nonce: route.actionNonceRaw,
          now,
          evidence: {
            kind: "provider_idempotent_replay",
            integrationAccountId: existing.value.action.integrationAccountId,
            idempotencyKey: existing.value.idempotencyKey,
            observedAt: now,
          },
        });
  if (!begun.ok || begun.value.state !== "executing") {
    return customActionLedgerError(
      begun.ok ? "invalid_action_transition" : begun.error.code,
    );
  }
  const execution = await executeApprovedCustomConnectorWrite({
    db: context.executionScope.database,
    keys: env,
    namespace: customConnectorFetchOf(
      env.CUSTOM_CONNECTOR_FETCH,
      context.executionScope.placement,
    ),
    entry: entry.value,
    authority,
    idempotencyKey: existing.value.idempotencyKey,
    deadlineAtUnixMs: now + entry.value.limits.invocationTimeoutMs,
    now,
    authorizeCall: authorizeRemoteConnectorWrite.bind(
      null,
      request,
      env,
      context,
      {
        db: context.executionScope.database,
        accountAccess: context.executionScope.accountAccess,
        userAuthority: acceptedExecutionAuthority(
          existing.value.action.sessionId,
          existing.value.action.nonce.value,
        ),
        action: "execute",
        organisationId: context.authorized.organisationId,
        authority: existing.value.action.requestAuthority,
        authorityPartition: existing.value.action.authorityPartition,
        request: { capabilities: [exactCapability] },
      },
    ),
  });
  const outcome =
    execution.kind === "confirmed"
      ? "confirmed"
      : execution.kind === "failed_before_send"
        ? "failed"
        : "indeterminate";
  const providerResult = JSON.stringify(
    execution.kind === "confirmed" ? execution.receipt : execution,
  );
  const completed = await context.organisation.completeActionExecution({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    executionLeaseId: begun.value.executionLease.leaseId,
    outcome,
    providerResult,
    now: Date.now(),
  });
  if (!completed.ok) return customActionLedgerError(completed.error.code);
  const responseBody = {
    ok: completed.value.state === "confirmed",
    action: await customConnectorActionRecord(
      context.executionScope.database,
      completed.value,
      context.authorized.membership.role,
    ),
  };
  return answerWriteAction(
    request,
    env,
    context,
    responseBody,
    Date.now(),
    completed.value.state === "indeterminate" ? 202 : 200,
  );
}

async function reconcileCustomConnectorWriteAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorWriteAction">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const context = await prepareWriteMutation(
    request,
    env,
    route,
    "reconcile",
    true,
  );
  if (!context.ok) return context.response;
  const body = context.body;
  if (
    !hasExactKeys(body, [
      "definitionDigest",
      "evidence",
      "expectedState",
      "outcome",
      "providerEffectId",
    ]) ||
    body.expectedState !== "indeterminate" ||
    (body.outcome !== "confirmed" &&
      body.outcome !== "failed" &&
      body.outcome !== "indeterminate") ||
    typeof body.evidence !== "string" ||
    body.evidence.length === 0 ||
    body.evidence.length > 2_000 ||
    typeof body.definitionDigest !== "string" ||
    typeof body.providerEffectId !== "string"
  ) {
    return controlError("custom_connector_reconciliation_invalid", 422);
  }
  const now = Date.now();
  const existing = await context.organisation.getAction({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    now,
  });
  if (
    !existing.ok ||
    !customActionMatchesConnector(existing.value, route.connectorIdRaw) ||
    existing.value.action.authority.kind !== "custom_connector"
  ) {
    return controlError("custom_connector_action_not_found", 404);
  }
  const authority = existing.value.action.authority;
  if (
    authority.definitionDigest !== body.definitionDigest ||
    authority.providerEffectId !== body.providerEffectId ||
    existing.value.state !== "indeterminate"
  ) {
    return controlError("custom_connector_action_state_conflict", 409);
  }
  const providerResult = JSON.stringify({
    kind: "custom_connector_reconciliation",
    outcome: body.outcome,
    evidence: body.evidence,
    providerEffectId: authority.providerEffectId,
    definitionDigest: authority.definitionDigest,
    reconciledBy: context.identity.userId,
    reconciledAt: now,
  });
  if (!(await authorizeWriteMutation(request, env, context)))
    return controlError("custom_connector_write_forbidden", 403);
  const reconciled = await context.organisation.reconcileActionExecution({
    organisationId: context.authorized.organisationId,
    nonce: route.actionNonceRaw,
    outcome: body.outcome,
    providerResult,
    now,
  });
  if (!reconciled.ok) return customActionLedgerError(reconciled.error.code);
  const responseBody = {
    ok: true,
    action: await customConnectorActionRecord(
      context.executionScope.database,
      reconciled.value,
      context.authorized.membership.role,
    ),
  };
  return answerWriteAction(request, env, context, responseBody, now);
}

/** The answer of an earlier attempt, to a caller who may still write. */
function replayWriteMutation(
  request: Request,
  env: Env,
  context: WriteMutationContext,
): Promise<Response | null> {
  return replayControlMutation({
    db: context.executionScope.database,
    scope: context.scope,
    boundary: context.boundary,
    replay: async (receipt) =>
      (await authorizeWriteMutation(request, env, context))
        ? controlJson(receipt.responseBody, receipt.responseStatus)
        : controlError("custom_connector_write_forbidden", 403),
  });
}

type WriteMutationContext = Readonly<{
  executionScope: OrganisationExecutionScope;
  authorized: AuthorizedOrganisationRequest;
  identity: User;
  organisation: OrganisationActorStub;
  boundary: UnversionedControlMutationBoundary;
  scope: ControlMutationReceiptScope;
  body: JsonRecord;
}>;

async function prepareWriteMutation(
  request: Request,
  env: Env,
  route: Readonly<{
    organisationIdRaw: string;
    connectorIdRaw: string;
    actionNonceRaw: string;
  }>,
  operation: "approval" | "execute" | "retry" | "reconcile",
  retainBody = false,
): Promise<
  | ({ readonly ok: true } & WriteMutationContext)
  | { readonly ok: false; readonly response: Response }
> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized;
  const body = await readJsonRecord(request);
  if (!body.ok || (!retainBody && Object.keys(body.value).length !== 0)) {
    return {
      ok: false,
      response: controlError("custom_connector_action_invalid", 422),
    };
  }
  const boundary = await parseMutationBoundary(
    request,
    body.value,
    "unversioned",
  );
  if (boundary instanceof Response) return { ok: false, response: boundary };
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return { ok: false, response: identity };
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  return {
    ok: true,
    executionScope: authorized.executionScope,
    authorized,
    identity,
    organisation,
    boundary,
    body: body.value,
    scope: controlMutationScope(
      authorized,
      `/v1/control/organisations/${authorized.organisationId}/custom-connectors/${route.connectorIdRaw}/actions/${route.actionNonceRaw}/${operation}`,
      `custom_connector.action.${operation}`,
    ),
  };
}

/**
 * Records the receipt of a write action's answer, then gives the answer to a
 * caller who may still write.
 */
async function answerWriteAction(
  request: Request,
  env: Env,
  context: WriteMutationContext,
  responseBody: Readonly<Record<string, unknown>>,
  now: number,
  status?: number,
): Promise<Response> {
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized: context.authorized,
    identity: context.identity,
    scope: context.scope,
    boundary: context.boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  if (!(await authorizeWriteMutation(request, env, context)))
    return controlError("custom_connector_write_forbidden", 403);
  return controlJson(responseBody, status);
}

function customActionLedgerError(code: string): Response {
  if (code === "action_not_found")
    return controlError("custom_connector_action_not_found", 404);
  if (code === "action_expired")
    return controlError("custom_connector_action_expired", 409);
  if (code === "resource_busy")
    return controlError("custom_connector_action_busy", 409);
  return controlError(`custom_connector_${code}`, 409);
}

function isActionNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

async function authorizeWriteMutation(
  request: Request,
  env: Env,
  context: WriteMutationContext,
): Promise<boolean> {
  if (!(await context.executionScope.isActive())) return false;
  const current = await authenticateControlMutation(request, env);
  if (
    !current.ok ||
    current.value.session.controlSessionId !==
      context.authorized.authenticated.session.controlSessionId ||
    current.value.session.userId !==
      context.authorized.authenticated.session.userId
  )
    return false;
  const authority = await authorizeOrganisationControl({
    db: context.executionScope.database,
    accountAccess: context.executionScope.accountAccess,
    action: "execute",
    session: current.value.session,
    organisationId: context.executionScope.organisationId,
    requiredRole: "admin",
  });
  return authority.ok && (await context.executionScope.isActive());
}

async function authorizeRemoteConnectorWrite(
  request: Request,
  env: Env,
  context: WriteMutationContext,
  input: Parameters<typeof authorizeCapabilityUse>[0],
): Promise<boolean> {
  if (!(await authorizeWriteMutation(request, env, context))) return false;
  return (
    (await authorizeCapabilityUse(input)).ok &&
    (await authorizeWriteMutation(request, env, context))
  );
}
