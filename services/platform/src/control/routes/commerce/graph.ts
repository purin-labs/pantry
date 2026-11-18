import { pantryCommerceAccess } from "../../../commerce/app-access";
import { ensureCaseProject } from "../../../projects/case-project";
import type { OrganisationPlacementBindings } from "../../../organisation-execution-scope";
import { controlActionMutationExecution } from "../../../actors/action-mutation-execution";
import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import type { Result } from "../../../result";
import type {
  CommerceGraphQuery,
  RequestAuthority,
} from "@seams/contracts";
import {
  parseCommerceCommandId,
  CommerceEntityPlaneClient,
} from "@seams/commerce-client";
import {
  resolveActiveCaseActor,
  resolveActiveCaseActorAtPlacement,
  requireActiveOrganisationActor,
} from "../../../actors/actor-router";
import type { ActionLedgerEntry } from "../../../actors/action-ledger";
import type { CaseSnapshot } from "../../../actors/case/types";
import type { OrganisationDO } from "../../../actors/organisation";
import { authorizeCapabilityUse } from "../../../authorization/access-grants/turn-authority";
import { authorizeCommerceEntityPlaneCommand } from "../../../commerce/entity-plane/execution";
import { readCommerceActivity } from "../../../commerce/entity-plane/activity";
import {
  buildCommerceListEntryCommandAuthority,
  buildSavedViewAdministrationAuthority,
} from "../../../commerce/entity-plane/authority";
import {
  patchPublishedCommerceListEntry,
  type CommerceListEntryPatchError,
} from "../../../commerce/entity-plane/list-entry-mutations";
import { proposalFromCommand } from "../../../commerce/entity-plane/proposals";
import { CAPABILITY_KEYS } from "../../../authorization/capability-catalogue";
import {
  commerceActivityErrorStatus,
  commerceGraphErrorStatus,
  commerceGraphResponseBody,
  parseCommerceActivityRouteBody,
  parseCommerceBoardPresenceRouteBody,
  parseCommerceGraphChangesRequest,
  parseCommerceGraphRouteBody,
  parseCommerceListEntryPatchRouteBody,
  parseSavedCommerceViewPresentationPatchRouteBody,
  type CommerceListEntryPatchCommand,
} from "../../../commerce/entity-plane/routes";
import {
  publishSavedCommerceViewPresentation,
  type SavedCommerceViewPresentationPatchError,
} from "../../../commerce/entity-plane/saved-view-mutations";
import {
  readActiveOrganisationMembershipRevision,
  resolveUser,
  type ActiveControlSession,
  type ActiveOrganisationMembership,
  type User,
} from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  parseCommerceExportPresetPublishRequest,
  publishCommerceExportPreset,
  type CommerceExportPresetError,
} from "../../../data/export-preset";
import { resolveOrganisationCommerceMerchantBinding } from "../../../data/commerce-merchant-binding";
import { prepareTurnAuthority } from "../../../context/turn-context";
import { createCommerceOutboxReconcileQueueMessage } from "../../../ingress-queue";
import {
  newRequestId,
  parseCaseId,
  parseSessionId,
  type CaseId,
  type IntegrationAccountId,
  type SessionId,
  type OrganisationId,
} from "../../../ids";
import {
  compilePublishAndActivateOrganisationPolicy,
  loadOrganisationPolicyOrDefaultDeny,
  readCurrentOrganisationPolicySnapshot,
} from "../../../policy-snapshot";
import {
  advanceInformationFlowContext,
  createCurrentSourceFlowLabel,
  digestCanonical,
  flowBindingForContext,
  InformationFlowContext,
  ObservationEvidence,
  type SerializedFlowBinding,
} from "../../../policy";
import { buildControlAuthority } from "../../../request-authority";
import { resolveOrganisationModelRoute } from "../../../models/route";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "../../http";
import { controlCausationId } from "../../mutation";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import {
  commerceGraphControlAuthority,
  controlCommerceSensitivityCeiling,
  openControlCommerceGraph,
} from "../../commerce-graph";
import { readOrganisationEnvironment } from "../../organisation-runtime";
import { assertNever } from "@seams/std";
import {
  capabilitySwitchedOffRefusal,
  commerceActionLedgerError,
} from "./support";

export async function handleCommerceExportPreset(
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
  if (!body.ok) return controlError("commerce_export_preset_invalid", 422);
  const parsed = parseCommerceExportPresetPublishRequest(body.value);
  if (!parsed.ok) return controlError(parsed.error.code, 422);
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
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/export-preset`,
    operation: "commerce_export_preset.publish",
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
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return controlError("underclerk_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return controlError("underclerk_unavailable", 503);
  }
  const now = Date.now();
  const mutationIdentity = newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(
      identity.issuer,
      identity.subject,
    ),
    causationId: controlCausationId(request),
    now,
  });
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const published = await publishCommerceExportPreset({
    scope: execution.value,
    environment,
    merchantId: binding.value.merchantId,
    request: parsed.value,
    expectedConfigurationVersion: boundary.value.expectedConfigurationVersion,
    controlMutation: {
      scope,
      boundary: boundary.value,
      identity: mutationIdentity,
    },
    client,
  });
  if (!published.ok) return commerceExportPresetErrorResponse(published.error);
  let organisation: DurableObjectStub<OrganisationDO>;
  try {
    organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now,
    });
  } catch {
    return controlError("policy_activation_failed", 503);
  }
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: authorized.executionScope.database, kv: env.POLICY_KV },
    organisationId: authorized.organisationId,
    organisation,
    now,
  });
  if (!policy.ok) return controlError(policy.error.code, 503);
  const responseBody = { ok: true, publication: published.value };
  return controlJson(responseBody);
}

export function commerceExportPresetErrorResponse(
  error: CommerceExportPresetError,
): Response {
  switch (error.code) {
    case "commerce_export_preset_invalid":
      return controlError(error.code, 422);
    case "commerce_export_preset_organisation_not_found":
      return controlError(error.code, 404);
    case "organisation_placement_conflict":
    case "commerce_export_preset_configuration_conflict":
    case "commerce_export_preset_owner_conflict":
    case "commerce_export_preset_drift":
      return controlError(error.code, 409);
    case "commerce_export_preset_underclerk_mismatch":
      return controlError(error.code, 502);
    case "commerce_export_preset_underclerk_unavailable":
    case "commerce_export_preset_persistence_failed":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}

export async function handleCommerceGraph(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("invalid_query", 422);
  // A page that needs several results sends its queries together. Each one
  // is parsed, authorized and answered as if it had arrived alone.
  const together = "queries" in body.value ? body.value.queries : undefined;
  if (
    together !== undefined &&
    (!Array.isArray(together) ||
      together.length === 0 ||
      together.length > COMMERCE_GRAPH_QUERIES_TOGETHER)
  )
    return controlError("invalid_query", 422);
  const queries: CommerceGraphQuery[] = [];
  for (const one of together === undefined
    ? [body.value]
    : together.map(asGraphRouteBody)) {
    const query = parseCommerceGraphRouteBody(one);
    if (!query.ok)
      return controlError(
        query.error.code,
        commerceGraphErrorStatus(query.error),
      );
    queries.push(query.value);
  }
  const graph = await openControlCommerceGraph(env, authorized);
  if (!graph.ok) return controlError(graph.error.code, graph.error.status);
  const { reader, merchantId } = graph.value;
  const now = Date.now();
  const answers = await Promise.all(
    queries.map(async function answerGraphQuery(query) {
      const authority = commerceGraphControlAuthority({
        organisationId: authorized.organisationId,
        merchantId,
        principalId: authorized.authenticated.session.userId,
        sensitivityCeiling: controlCommerceSensitivityCeiling(authorized),
        query,
        now,
      });
      if (!authority.ok) return authority;
      return reader.query({
        query,
        authority: authority.value,
        now: new Date(now).toISOString(),
      });
    }),
  );
  if (together !== undefined)
    return controlJson({
      ok: true,
      results: answers.map((answer) =>
        answer.ok
          ? commerceGraphResponseBody(answer.value)
          : { ok: false, error: { code: answer.error.code } },
      ),
    });
  const [result] = answers;
  if (result === undefined) return controlError("invalid_query", 422);
  return result.ok
    ? controlJson(commerceGraphResponseBody(result.value))
    : controlError(result.error.code, commerceGraphErrorStatus(result.error));
}

/** How many graph queries one request may send together. */
export const COMMERCE_GRAPH_QUERIES_TOGETHER = 8;

export function asGraphRouteBody(query: unknown): { readonly query: unknown } {
  return { query };
}

export async function handleCommerceGraphChanges(
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
  const url = new URL(request.url);
  const parsed = parseCommerceGraphChangesRequest(url.searchParams);
  if (!parsed.ok)
    return controlError(
      parsed.error.code,
      commerceGraphErrorStatus(parsed.error),
    );
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return controlError("underclerk_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return controlError("underclerk_unavailable", 503);
  }
  const changes = await client.changes(
    binding.value.merchantId,
    parsed.value.after,
    parsed.value.limit,
  );
  return changes.ok
    ? controlJson({ ok: true, changes: changes.value })
    : controlError("underclerk_unavailable", 503);
}

export async function handleCommerceBoardPresence(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  let organisation: Awaited<ReturnType<typeof requireActiveOrganisationActor>>;
  try {
    organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
  } catch {
    return controlError("organisation_actor_unavailable", 503);
  }
  if (request.method === "GET") {
    const resourceKey = new URL(request.url).searchParams.get("resource");
    const parsed = parseCommerceBoardPresenceRouteBody({
      resourceKey,
      selection: { kind: "none" },
      dragPreview: { kind: "idle" },
    });
    if (!parsed.ok) return controlError("commerce_board_presence_invalid", 422);
    const read = await organisation.readCommerceBoardPresence({
      organisationId: authorized.organisationId,
      resourceKey: parsed.value.resourceKey,
      now: Date.now(),
    });
    return read.ok
      ? controlJson({ ok: true, presence: read.value })
      : controlError(read.error.code, 409);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("commerce_board_presence_invalid", 422);
  const parsed = parseCommerceBoardPresenceRouteBody(body.value);
  if (!parsed.ok) return controlError("commerce_board_presence_invalid", 422);
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const updated = await organisation.updateCommerceBoardPresence({
    organisationId: authorized.organisationId,
    userId: identity.userId,
    displayName: identity.displayName,
    resourceKey: parsed.value.resourceKey,
    selection: parsed.value.selection,
    dragPreview: parsed.value.dragPreview,
    now: Date.now(),
  });
  return updated.ok
    ? controlJson({ ok: true, presence: updated.value })
    : controlError(updated.error.code, 409);
}

export async function handleCommerceListEntryPatch(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  entryIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("commerce_list_entry_patch_invalid", 422);
  const command = parseCommerceListEntryPatchRouteBody(body.value, entryIdRaw);
  if (!command.ok)
    return controlError("commerce_list_entry_patch_invalid", 422);
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
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/list-entries/${entryIdRaw}/patch`,
    operation: "commerce.list_entry.patch",
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

  const policy = await readCurrentOrganisationPolicySnapshot(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (
    !policy.ok ||
    !policy.value.authz.allowedTools.includes("commerce.list_entry.patch") ||
    policy.value.authz.deniedTools.includes("commerce.list_entry.patch")
  ) {
    return capabilitySwitchedOffRefusal(
      authorized.executionScope,
      CAPABILITY_KEYS.commerceListEntryPatch,
      "commerce_list_entry_patch",
    );
  }
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  if (
    policy.value.authz.approvalRequired.includes("commerce.list_entry.patch")
  ) {
    const requested = await requestCommerceListEntryPatchApproval({
      env,
      execution: authorized.executionScope,
      membership: authorized.membership,
      session: authorized.authenticated.session,
      identity,
      boundary: boundary.value,
      command: command.value,
      integrationAccountId: binding.value.integrationAccountId,
      now: Date.now(),
    });
    if (!requested.ok) return requested.error;
    const recordedMutationReceipt = await recordCommerceMutationReceipt({
      authorized,
      identity,
      scope,
      boundary: boundary.value,
      request,
      responseBody: requested.value,
      responseStatus: 202,
      now: requested.value.requestedAt,
    });
    if (!recordedMutationReceipt.ok)
      return controlError(recordedMutationReceipt.error.code, 409);
    return controlJson(requested.value, 202);
  }
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return controlError("underclerk_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return controlError("underclerk_unavailable", 503);
  }
  let commandId: ReturnType<typeof parseCommerceCommandId>;
  try {
    commandId = parseCommerceCommandId(boundary.value.idempotencyKey);
  } catch {
    return controlError("commerce_list_entry_patch_invalid", 422);
  }
  const commandNow = Date.now();
  const authority = buildCommerceListEntryCommandAuthority({
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    principalId: identity.userId,
    expiresAt: commerceEntityCommandAuthorityExpiry(commandNow),
    commandId,
    entry: command.value.command.target.entry,
  });
  if (!authority.ok)
    return controlError("commerce_list_entry_patch_invalid", 422);
  const patched = await patchPublishedCommerceListEntry({
    client,
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    commandId,
    authority: authority.value,
    command: command.value,
  });
  if (!patched.ok) return commerceListEntryPatchErrorResponse(patched.error);

  const now = commandNow;
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: authorized.organisationId,
        integrationAccountId: binding.value.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return controlError("underclerk_projection_refresh_unavailable", 503);
  }
  const responseBody = { ok: true, receipt: patched.value };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

export type CommerceListEntryPatchApprovalResponse = Readonly<{
  ok: true;
  effect: "approval_requested";
  action: Readonly<{
    nonce: ActionLedgerEntry["action"]["nonce"];
    caseId: ActionLedgerEntry["caseId"];
    proposalId: string;
    state: "approval_requested";
    verb: "commerce.list_entry.patch";
    resourceKey: string;
  }>;
  approval: Readonly<{
    kind: "required";
    next: "approve_action";
  }>;
  requestedAt: number;
}>;

export async function requestCommerceListEntryPatchApproval(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    membership: ActiveOrganisationMembership;
    session: ActiveControlSession;
    identity: User;
    boundary: UnversionedControlMutationBoundary;
    command: CommerceListEntryPatchCommand;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): Promise<Result<CommerceListEntryPatchApprovalResponse, Response>> {
  const proposal = proposalFromCommand(input.command);
  if (proposal === null || proposal.kind !== "patch_commerce_list_entry") {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_invalid", 422),
    };
  }
  const actionDigest = await digestCanonical({
    boundary: input.boundary,
    command: input.command,
  });
  const actionIdentity = actionDigest.slice(0, 32);
  const caseId = parseCaseId(`case_list_entry_patch_${actionIdentity}`);
  const sessionId = parseSessionId(input.session.controlSessionId);
  if (!caseId.ok || !sessionId.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_identity_invalid", 500),
    };
  }
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: input.execution.database,
    organisationId: input.execution.organisationId,
  });
  if (membershipRevision === null) {
    return {
      ok: false,
      error: controlError(
        "commerce_list_entry_patch_authority_unavailable",
        503,
      ),
    };
  }
  const requestAuthority = buildControlAuthority({
    organisationId: input.execution.organisationId,
    requesterPersonId: input.membership.personId,
    userId: input.session.userId,
    membershipRevision,
    role: input.membership.role,
  }).requestAuthority;
  const modelRoute = await resolveOrganisationModelRoute({
    env: input.env,
    organisationId: input.execution.organisationId,
    now: input.now,
  });
  if (!modelRoute.ok) {
    return {
      ok: false,
      error: controlError(
        "commerce_list_entry_patch_authority_unavailable",
        503,
      ),
    };
  }
  const loadedPolicy = await loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: input.execution.database, kv: input.env.POLICY_KV },
    organisationId: input.execution.organisationId,
    now: input.now,
  });
  const turnAuthority = await prepareTurnAuthority({
    db: input.execution.database,
    accountAccess: input.execution.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: input.session.controlSessionId },
    action: "execute",
    organisationId: input.execution.organisationId,
    requestAuthority,
    policy: { version: loadedPolicy.snapshot.version },
  });
  if (!turnAuthority.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_forbidden", 403),
    };
  }
  const resourceKey = commerceListEntryPatchResourceKey(input.command);
  const providerAuthority = await authorizeCapabilityUse({
    db: input.execution.database,
    accountAccess: input.execution.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: input.session.controlSessionId },
    action: "execute",
    organisationId: input.execution.organisationId,
    authority: requestAuthority,
    authorityPartition: turnAuthority.value.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "provider_resource",
          capabilityId: "commerce.action.propose",
          capabilityVersion: 1,
          integrationAccountId: input.integrationAccountId,
          resourceScope: resourceKey,
        },
      ],
    },
  });
  if (!providerAuthority.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_forbidden", 403),
    };
  }
  const commandAuthority = await authorizeCommerceEntityPlaneCommand({
    db: input.execution.database,
    organisationId: input.execution.organisationId,
    authority: requestAuthority,
    proposal,
  });
  if (!commandAuthority.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_forbidden", 403),
    };
  }
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: input.execution.organisationId,
    now: input.now,
  });
  const caseActor = await resolveActiveCaseActorAtPlacement({
    placement: input.execution.placement,
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.execution.organisationId,
    caseId: caseId.value,
    now: input.now,
  });
  if (!caseActor.ok) {
    return {
      ok: false,
      error: controlError("commerce_action_case_unavailable", 503),
    };
  }
  const placed = await ensureCaseProject({
    scope: input.execution,
    caseId: caseId.value,
    origin: "commerce_approval",
    now: input.now,
  });
  if (!placed.ok)
    return { ok: false, error: controlError(placed.error.code, 409) };
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: input.execution.organisationId, caseId: caseId.value },
    purpose: "approve commerce list entry patch",
    workspaceRevision: `commerce:${input.integrationAccountId}`,
    lifecycle: { kind: "open", openedAt: input.now },
  });
  if (!ensured.ok) {
    return {
      ok: false,
      error: controlError("commerce_action_case_unavailable", 409),
    };
  }
  const proposalId = `proposal_list_entry_patch_${actionIdentity}`;
  const flowBinding = await createMerchantEntityPlaneFlowBinding({
    execution: input.execution,
    requestAuthority,
    authorityPartitionDigest: turnAuthority.value.authorityPartition.digest,
    sessionId: sessionId.value,
    caseId: caseId.value,
    proposalId,
    sourceRevision: 1,
    content: proposal,
    observedAt: input.now,
  });
  if (!flowBinding.ok) return flowBinding;
  const actionExecution = await controlActionMutationExecution(
    input.env,
    input.execution.organisationId,
    input.session,
  );
  if (!actionExecution.ok)
    return { ok: false, error: controlError(actionExecution.error.code, 409) };
  const accepted = await caseActor.value.acceptCommerceEntityPlaneProposal({
    execution: actionExecution.value,
    proposal: {
      kind: "entity_plane",
      proposalId,
      caseId: caseId.value,
      basedOnRevision: 0,
      requestAuthority,
      proposal,
      origin: {
        kind: "merchant_control",
        userId: input.identity.userId,
        controlSessionId: input.session.controlSessionId,
      },
    },
    acceptedAt: input.now,
    flowBinding: flowBinding.value,
  });
  if (!accepted.ok) {
    return {
      ok: false,
      error: controlError("commerce_action_case_proposal_rejected", 409),
    };
  }

  const proposed = await organisation.proposeAction({
    execution: actionExecution.value,
    organisationId: input.execution.organisationId,
    integrationAccountId: input.integrationAccountId,
    requestAuthority,
    authorityPartition: turnAuthority.value.authorityPartition,
    authority: { kind: "integration_account" },
    caseId: caseId.value,
    proposalId,
    sessionId: sessionId.value,
    threadId: caseId.value,
    draft: {
      host: "satyr.commerce",
      verb: "commerce.list_entry.patch",
      path: commerceListEntryPatchActionPath(input.command),
      argsHash: actionDigest,
      amount: null,
      resourceKey,
    },
    flowBinding: accepted.value.flowBinding,
    exp: input.now + 15 * 60_000,
    now: input.now,
  });
  if (!proposed.ok) {
    return { ok: false, error: commerceActionLedgerError(proposed.error) };
  }
  const waiting = await caseActor.value.waitForCommerceApproval({
    execution: actionExecution.value,
    caseId: caseId.value,
    proposalId,
    actionNonce: proposed.value.action.nonce.value,
    expectedCaseRevision: accepted.value.revision,
    requestedAt: input.now,
  });
  if (!waiting.ok) {
    return {
      ok: false,
      error: controlError("commerce_action_case_approval_wait_failed", 409),
    };
  }
  const requested = await organisation.requestActionApproval({
    execution: actionExecution.value,
    organisationId: input.execution.organisationId,
    nonce: proposed.value.action.nonce.value,
    now: input.now,
  });
  if (!requested.ok) {
    return { ok: false, error: commerceActionLedgerError(requested.error) };
  }
  if (requested.value.state !== "approval_requested") {
    return {
      ok: false,
      error: controlError("commerce_action_case_approval_wait_failed", 409),
    };
  }
  return {
    ok: true,
    value: {
      ok: true,
      effect: "approval_requested",
      action: {
        nonce: requested.value.action.nonce,
        caseId: requested.value.caseId,
        proposalId: requested.value.proposalId,
        state: requested.value.state,
        verb: "commerce.list_entry.patch",
        resourceKey: requested.value.action.resourceKey,
      },
      approval: { kind: "required", next: "approve_action" },
      requestedAt: input.now,
    },
  };
}

export function commerceListEntryPatchResourceKey(
  command: CommerceListEntryPatchCommand,
): string {
  const entry = command.command.target.entry;
  return `commerce:list_entry:${String(entry.listId)}:${String(entry.entryId)}:${Number(entry.revision)}`;
}

export function commerceListEntryPatchActionPath(
  command: CommerceListEntryPatchCommand,
): string {
  const entry = command.command.target.entry;
  const query = new URLSearchParams({
    list_id: String(entry.listId),
    expected_revision: String(entry.revision),
    expected_list_revision: String(command.command.expectedListRevision),
  });
  return `/list-entries/${encodeURIComponent(String(entry.entryId))}/patch?${query.toString()}`;
}

export async function createMerchantEntityPlaneFlowBinding(
  input: Readonly<{
    execution: OrganisationExecutionScope;
    requestAuthority: RequestAuthority;
    authorityPartitionDigest: string;
    sessionId: SessionId;
    caseId: CaseId;
    proposalId: string;
    sourceRevision: number;
    content: unknown;
    observedAt: number;
  }>,
): Promise<Result<SerializedFlowBinding, Response>> {
  const label = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db: input.execution.database,
    authority: input.requestAuthority,
  });
  if (!label.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_flow_unavailable", 503),
    };
  }
  const context = await InformationFlowContext.create({
    organisationId: input.requestAuthority.organisationId,
    sessionId: input.sessionId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  if (!context.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_flow_unavailable", 503),
    };
  }
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "case_entry",
      caseId: input.caseId,
      entryId: `commerce_proposal:${input.proposalId}`,
    },
    sourceRevision: input.sourceRevision,
    contentDigest: await digestCanonical(input.content),
    inputLabel: label.value,
    observedAt: input.observedAt,
  });
  if (!evidence.ok) {
    return {
      ok: false,
      error: controlError("commerce_list_entry_patch_flow_unavailable", 503),
    };
  }
  const advanced = await advanceInformationFlowContext({
    context: context.value,
    observation: evidence.value,
    inputLabel: label.value,
  });
  return advanced.ok
    ? {
        ok: true,
        value: flowBindingForContext(
          advanced.value.context,
          `merchant:${input.proposalId}`,
        ).toJSON(),
      }
    : {
        ok: false,
        error: controlError("commerce_list_entry_patch_flow_unavailable", 503),
      };
}

export function commerceListEntryPatchErrorResponse(
  error: CommerceListEntryPatchError,
): Response {
  switch (error.code) {
    case "invalid_reference":
      return controlError("commerce_list_entry_patch_invalid", 422);
    case "not_published":
      return controlError("commerce_list_entry_not_found", 404);
    case "revision_conflict":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        409,
      );
    case "organisation_mismatch":
    case "merchant_mismatch":
      return controlError("commerce_list_entry_patch_forbidden", 403);
    case "command_rejected":
      return error.error.code === "revision_conflict"
        ? controlJson(
            {
              ok: false,
              error: error.error.code,
              expected: Number(error.error.expected),
              actual: Number(error.error.received),
            },
            409,
          )
        : controlJson(
            { ok: false, error: error.error.code },
            commerceGraphErrorStatus(error.error),
          );
    case "receipt_mismatch":
    case "unavailable":
      return controlError("underclerk_unavailable", 503);
    default:
      return assertNever(error);
  }
}

export async function handleCommerceSavedViewPresentationPatch(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  viewIdRaw: string,
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
  if (!body.ok) return controlError("commerce_saved_view_patch_invalid", 422);
  const patch = parseSavedCommerceViewPresentationPatchRouteBody(
    body.value,
    viewIdRaw,
  );
  if (!patch.ok) return controlError("commerce_saved_view_patch_invalid", 422);
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
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/saved-views/${viewIdRaw}/presentation`,
    operation: "commerce.saved_view.presentation.publish",
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

  const policy = await readCurrentOrganisationPolicySnapshot(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (
    !policy.ok ||
    !policy.value.authz.allowedTools.includes("commerce.saved_view.publish") ||
    policy.value.authz.deniedTools.includes("commerce.saved_view.publish")
  ) {
    return capabilitySwitchedOffRefusal(
      authorized.executionScope,
      CAPABILITY_KEYS.commerceSavedViewPublish,
      "commerce_saved_view_patch",
    );
  }
  if (
    policy.value.authz.approvalRequired.includes("commerce.saved_view.publish")
  ) {
    return controlError("commerce_saved_view_patch_approval_required", 409);
  }
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return controlError("underclerk_unavailable", 503);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
  } catch {
    return controlError("underclerk_unavailable", 503);
  }
  let commandId: ReturnType<typeof parseCommerceCommandId>;
  try {
    commandId = parseCommerceCommandId(boundary.value.idempotencyKey);
  } catch {
    return controlError("commerce_saved_view_patch_invalid", 422);
  }
  const commandNow = Date.now();
  const authority = buildSavedViewAdministrationAuthority({
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    principalId: identity.userId,
    expiresAt: commerceEntityCommandAuthorityExpiry(commandNow),
    commandId,
    viewId: patch.value.viewId,
    expectedRevision: patch.value.expectedRevision,
  });
  if (!authority.ok)
    return controlError("commerce_saved_view_patch_invalid", 422);
  const published = await publishSavedCommerceViewPresentation({
    client,
    organisationId: authorized.organisationId,
    merchantId: binding.value.merchantId,
    commandId,
    authority: authority.value,
    patch: patch.value,
  });
  if (!published.ok)
    return commerceSavedViewPresentationPatchErrorResponse(published.error);

  const responseBody = { ok: true, receipt: published.value };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now: commandNow,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

export function commerceEntityCommandAuthorityExpiry(now: number): string {
  return new Date(now + 60_000).toISOString();
}

export function commerceSavedViewPresentationPatchErrorResponse(
  error: SavedCommerceViewPresentationPatchError,
): Response {
  switch (error.code) {
    case "invalid_reference":
      return controlError("commerce_saved_view_patch_invalid", 422);
    case "not_published":
      return controlError("commerce_saved_view_not_found", 404);
    case "organisation_mismatch":
    case "merchant_mismatch":
      return controlError("commerce_saved_view_patch_forbidden", 403);
    case "revision_conflict":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: Number(error.expected),
          actual: Number(error.actual),
        },
        409,
      );
    case "command_rejected":
      return error.error.code === "revision_conflict"
        ? controlJson(
            {
              ok: false,
              error: error.error.code,
              expected: Number(error.error.expected),
              actual: Number(error.error.received),
            },
            409,
          )
        : controlJson(
            { ok: false, error: error.error.code },
            commerceGraphErrorStatus(error.error),
          );
    case "receipt_mismatch":
    case "unavailable":
      return controlError("underclerk_unavailable", 503);
    default:
      return assertNever(error);
  }
}

export async function handleCommerceGraphActivity(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("invalid_query", 422);
  const parsed = parseCommerceActivityRouteBody(body.value);
  if (!parsed.ok)
    return controlError(
      parsed.error.code,
      commerceActivityErrorStatus(parsed.error),
    );
  let organisation: Awaited<ReturnType<typeof requireActiveOrganisationActor>>;
  try {
    organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
  } catch {
    return controlError("activity_source_unavailable", 503);
  }
  const now = Date.now();
  const result = await readCommerceActivity({
    ...parsed.value,
    organisationId: authorized.organisationId,
    organisation,
    caseReader: {
      read: readCaseSnapshotForCommerceActivity.bind(null, {
        env,
        organisationId: authorized.organisationId,
        now,
      }),
    },
  });
  return result.ok
    ? controlJson({ ok: true, ...result.value })
    : controlError(
        result.error.code,
        commerceActivityErrorStatus(result.error),
      );
}

export async function readCaseSnapshotForCommerceActivity(
  input: Readonly<{
    env: OrganisationPlacementBindings & Pick<Env, "CASE">;
    organisationId: OrganisationId;
    now: number;
  }>,
  caseId: string,
): Promise<CaseSnapshot | null> {
  const parsedCaseId = parseCaseId(caseId);
  if (!parsedCaseId.ok) return null;
  const actor = await resolveActiveCaseActor({
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.organisationId,
    caseId: parsedCaseId.value,
    now: input.now,
  });
  if (!actor.ok) return null;
  const snapshot = await actor.value.inspect();
  return snapshot.ok ? snapshot.value : null;
}
