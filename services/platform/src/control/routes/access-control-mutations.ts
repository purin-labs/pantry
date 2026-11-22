import {
  isAgentPermissionListRead,
  type AgentPermissionListRead,
} from "@purin-labs/control-api";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type {
  AccessSubjectRef,
  AccessTargetRef,
  CapabilityDefinition,
  CapabilityMode,
  CapabilityRef,
} from "@purin-labs/contracts";
import {
  commerceAccessTargets,
  type CommerceGrantEntityTypeId,
} from "../../access-control/commerce-access-targets";

import {
  applyVersionedAccessDefaults,
  changeVersionedCapabilityPolicy,
  type AccessCapabilityMutationError,
} from "../../access-control/capability-mutations";
import {
  createVersionedAccessGrant,
  revokeVersionedAccessGrant,
  type AccessGrantMutationError,
  type AccessGrantMutationResult,
} from "../../access-control/grant-mutations";
import {
  resolveGrantSubjectReference,
  resolveGrantTargetReference,
} from "../../access-control/decision-explanation";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import type {
  AccessGrantTarget,
  FileResourceAccessGrantTarget,
} from "../../authorization/access-grants/types";
import { parseFileResourceScope } from "../../authorization/access-grants";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  SLACK_MESSAGE_RESOURCE_SCOPE,
} from "../../authorization/capability-catalogue";
import { fileGrantParts } from "../../authorization/access-grants/file-grant-parts";
import { parseActiveCapabilityId } from "../../data/capability-policy";
import {
  hashPortalSubject,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { resolveIntegrationAccount } from "../../data/integration-account";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import type { AccessControlParts } from "./access-control-explain";
import {
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
} from "../../custom-connectors/identity";
import type { Env } from "@purin-labs/kernel/env";
import {
  settleWorkspaceAiBudget,
  changeWorkspaceAiBudget,
  parseWorkspaceAiBudgetLimits,
  readWorkspaceAiBudget,
  WORKSPACE_AI_BUDGET_MAXIMUM,
} from "../../data/workspace-ai-budget";
import { readAccessControlOrganisationProjection } from "../../access-control/read-model";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { digestCanonical } from "../../policy";
import { compilePublishAndActivateOrganisationPolicy } from "../../policy-snapshot";
import type { Result } from "@purin-labs/kernel/result";
import { controlCausationId } from "../mutation";
import {
  controlMutationScope,
  parseMutationBoundary,
  resolveMutationUser,
} from "../admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import { readOnboardingRow } from "../../data/organisation-onboarding-row";

export type AccessControlMutationRoute =
  | Readonly<{ kind: "accessControlBudget"; organisationIdRaw: string }>
  | Readonly<{ kind: "accessControlGrantCreate"; organisationIdRaw: string }>
  | Readonly<{
      kind: "accessControlGrantRevoke";
      organisationIdRaw: string;
      grantId: string;
    }>
  | Readonly<{
      kind: "accessControlCapabilityChange";
      organisationIdRaw: string;
      capabilityId: string;
    }>
  | Readonly<{ kind: "accessControlDefaultsApply"; organisationIdRaw: string }>;

type CreateGrantRequest = Readonly<{
  expectedRevision: number;
  subjectRef: AccessSubjectRef;
  target: CreateGrantTargetSelection;
}>;

type CreateGrantTargetSelection = StrictUnion<
  | Readonly<{ kind: "platform"; capabilityRef: CapabilityRef }>
  | Readonly<{
      kind: "commerce_entity_type";
      capabilityRef: CapabilityRef;
      entityTypeId: CommerceGrantEntityTypeId;
    }>
  | Readonly<{
      kind: "commerce_list";
      capabilityRef: CapabilityRef;
      listId: AgentPermissionListRead;
    }>
  | Readonly<{
      kind: "existing_target";
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
    }>
  | Readonly<{
      kind: "published_commerce_target";
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
    }>
  | Readonly<{
      kind: "provider_resource";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      resourceRef: string;
    }>
  | Readonly<{
      kind: "file_resource";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      scope: FileResourceAccessGrantTarget["scope"];
    }>
  | Readonly<{
      kind: "custom_connector_operation";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      connectorId: string;
      definitionRevision: number;
      definitionDigest: string;
      operationId: string;
    }>
>;

type RevokeGrantRequest = Readonly<{
  expectedRevision: number;
  grantRevision: number;
  reason: string;
}>;

type ChangeCapabilityRequest = Readonly<{
  expectedRevision: number;
  capabilityRevision: number;
  capabilityVersion: number;
  mode: CapabilityMode;
}>;

type ApplyDefaultsRequest = Readonly<{ expectedRevision: number }>;

type PreparedMutation = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  boundary: UnversionedControlMutationBoundary;
  scope: ControlMutationReceiptScope;
  identity: ControlMutationIdentity;
}>;

export async function handleAccessControlMutationRoute(
  request: Request,
  env: Env,
  route: AccessControlMutationRoute,
  parts: AccessControlParts,
): Promise<Response> {
  if (route.kind === "accessControlBudget" && request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const budget = await readWorkspaceAiBudget(
      authorized.executionScope.database,
      authorized.organisationId,
    );
    if (!budget.ok) return controlError(budget.error, 503);
    return controlJson({
      ok: true,
      budget: budget.value,
      maximum: WORKSPACE_AI_BUDGET_MAXIMUM,
      canManage:
        authorized.membership.role === "owner" ||
        authorized.membership.role === "admin",
    });
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("access_control_mutation_invalid", 422);
  switch (route.kind) {
    case "accessControlBudget":
      return handleBudgetChange(request, env, route, body.value);
    case "accessControlGrantCreate":
      return handleGrantCreate(request, env, route, body.value, parts);
    case "accessControlGrantRevoke":
      return handleGrantRevoke(request, env, route, body.value);
    case "accessControlCapabilityChange":
      return handleCapabilityChange(request, env, route, body.value);
    case "accessControlDefaultsApply":
      return handleDefaultsApply(request, env, route, body.value);
    default:
      return assertNever(route);
  }
}

async function handleBudgetChange(
  request: Request,
  env: Env,
  route: Variant<AccessControlMutationRoute, "accessControlBudget">,
  raw: JsonRecord,
): Promise<Response> {
  const limits = parseWorkspaceAiBudgetLimits(raw.limits);
  if (
    !hasExactKeys(raw, ["expectedRevision", "limits"]) ||
    !isPositiveInteger(raw.expectedRevision) ||
    limits === null
  )
    return controlError("workspace_ai_budget_invalid", 422);
  const prepared = await prepareMutation({
    request,
    env,
    organisationIdRaw: route.organisationIdRaw,
    raw,
    path: routePath(route),
    operation: "access_control.budget.change",
  });
  if (!prepared.ok) return prepared.response;
  if (prepared.replay !== null) return prepared.replay;
  const mutation = prepared.value;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    mutation.authorized.organisationId,
  );
  if (!scope.ok) return controlError("workspace_ai_budget_unavailable", 503);
  const changed = await changeWorkspaceAiBudget({
    scope: scope.value,
    limits,
    expectedRevision: raw.expectedRevision,
    mutationReceiptId: mutation.identity.receiptId,
    now: mutation.identity.createdAt,
  });
  if (!changed.ok)
    return controlError(
      changed.error,
      changed.error === "workspace_ai_budget_conflict" ? 409 : 503,
    );
  const published = await publishCurrentPolicy(
    env,
    scope.value,
    mutation.identity.createdAt,
  );
  if (!published.ok) return controlError(published.error, 503);
  const organisation = await readAccessControlOrganisationProjection(
    scope.value.database,
    mutation.authorized.organisationId,
  );
  if (!organisation.ok) return controlError(organisation.error.code, 503);
  const environment = await readOnboardingRow(
    scope.value.database,
    mutation.authorized.organisationId,
  );
  if (
    environment?.environment !== "development" &&
    environment?.environment !== "production"
  )
    return controlError("workspace_ai_budget_unavailable", 503);
  const settled = await settleWorkspaceAiBudget({
    scope: scope.value,
    budget: changed.value,
    userId: mutation.scope.userId,
    boundary: mutation.boundary,
    identity: mutation.identity,
    environment: environment.environment,
    configurationVersion: organisation.value.configurationVersion,
    projectionRevision: organisation.value.projectionRevision,
  });
  return settled.ok
    ? controlJson(settled.value)
    : controlError(settled.error, 409);
}

async function handleGrantCreate(
  request: Request,
  env: Env,
  route: Variant<AccessControlMutationRoute, "accessControlGrantCreate">,
  raw: JsonRecord,
  parts: AccessControlParts,
): Promise<Response> {
  const parsed = parseCreateGrantRequest(raw);
  if (!parsed.ok) return controlError(parsed.error, 422);
  const prepared = await prepareMutation({
    request,
    env,
    organisationIdRaw: route.organisationIdRaw,
    raw,
    path: routePath(route),
    operation: "access_control.grant.create",
  });
  if (!prepared.ok) return prepared.response;
  if (prepared.replay !== null) return prepared.replay;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    prepared.value.authorized.organisationId,
  );
  if (!scope.ok) return controlError(scope.error.code, 409);
  const subject = await resolveGrantSubjectReference({
    db: scope.value.database,
    organisationId: prepared.value.authorized.organisationId,
    subjectRef: parsed.value.subjectRef,
  });
  if (!subject.ok) return controlError(subject.error, 409);
  const resolvedTarget = await resolveGrantTargetSelection(
    env,
    scope.value,
    parsed.value.target,
  );
  if (!resolvedTarget.ok) return controlError(resolvedTarget.error, 409);
  const target = await validateGrantTarget(
    parts,
    env,
    scope.value,
    resolvedTarget.value,
  );
  if (!target.ok)
    return controlError(
      target.error,
      target.error === "access_grant_target_unavailable" ? 409 : 422,
    );
  const mutation = prepared.value;
  const changed = await createVersionedAccessGrant({
    scope: scope.value,
    grantId: await deterministicGrantId(mutation.scope, mutation.boundary),
    expectedProjectionRevision: parsed.value.expectedRevision,
    subject: subject.value,
    target: target.value,
    actorUserId: mutation.scope.userId,
    identity: mutation.identity,
    boundary: mutation.boundary,
  });
  return accessGrantMutationResponse(changed);
}

async function handleGrantRevoke(
  request: Request,
  env: Env,
  route: Variant<AccessControlMutationRoute, "accessControlGrantRevoke">,
  raw: JsonRecord,
): Promise<Response> {
  const parsed = parseRevokeGrantRequest(raw);
  if (!parsed.ok || !boundedIdentifier(route.grantId)) {
    return controlError("access_control_grant_revoke_invalid", 422);
  }
  const prepared = await prepareMutation({
    request,
    env,
    organisationIdRaw: route.organisationIdRaw,
    raw,
    path: routePath(route),
    operation: "access_control.grant.revoke",
  });
  if (!prepared.ok) return prepared.response;
  if (prepared.replay !== null) return prepared.replay;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    prepared.value.authorized.organisationId,
  );
  if (!scope.ok) return controlError(scope.error.code, 409);
  const mutation = prepared.value;
  const changed = await revokeVersionedAccessGrant({
    scope: scope.value,
    grantId: route.grantId,
    expectedProjectionRevision: parsed.value.expectedRevision,
    expectedGrantRevision: parsed.value.grantRevision,
    reason: parsed.value.reason,
    actorUserId: mutation.scope.userId,
    identity: mutation.identity,
    boundary: mutation.boundary,
  });
  return accessGrantMutationResponse(changed);
}

async function handleCapabilityChange(
  request: Request,
  env: Env,
  route: Variant<AccessControlMutationRoute, "accessControlCapabilityChange">,
  raw: JsonRecord,
): Promise<Response> {
  const parsed = parseChangeCapabilityRequest(raw);
  const capabilityId = parseActiveCapabilityId(route.capabilityId);
  if (!parsed.ok || capabilityId === null) {
    return controlError("access_control_capability_change_invalid", 422);
  }
  const prepared = await prepareMutation({
    request,
    env,
    organisationIdRaw: route.organisationIdRaw,
    raw,
    path: routePath(route),
    operation: "access_control.capability.change",
  });
  if (!prepared.ok) return prepared.response;
  if (prepared.replay !== null) return prepared.replay;
  const mutation = prepared.value;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    mutation.authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const changed = await changeVersionedCapabilityPolicy({
    scope: execution.value,
    capabilityId,
    capabilityVersion: parsed.value.capabilityVersion,
    mode: parsed.value.mode,
    expectedProjectionRevision: parsed.value.expectedRevision,
    expectedCapabilityRevision: parsed.value.capabilityRevision,
    actorUserId: mutation.scope.userId,
    identity: mutation.identity,
    boundary: mutation.boundary,
  });
  if (!changed.ok) return accessCapabilityMutationErrorResponse(changed.error);
  const published = await publishCurrentPolicy(
    env,
    execution.value,
    mutation.identity.createdAt,
  );
  if (!published.ok) return controlError(published.error, 503);
  const responseBody = {
    ok: true,
    revision: changed.value.projectionRevision,
    configurationVersion: changed.value.configurationVersion,
    capability: changed.value.policy,
  };
  return controlJson(responseBody);
}

async function handleDefaultsApply(
  request: Request,
  env: Env,
  route: Variant<AccessControlMutationRoute, "accessControlDefaultsApply">,
  raw: JsonRecord,
): Promise<Response> {
  const parsed = parseApplyDefaultsRequest(raw);
  if (!parsed.ok) return controlError(parsed.error, 422);
  const prepared = await prepareMutation({
    request,
    env,
    organisationIdRaw: route.organisationIdRaw,
    raw,
    path: routePath(route),
    operation: "access_control.defaults.apply",
  });
  if (!prepared.ok) return prepared.response;
  if (prepared.replay !== null) return prepared.replay;
  const mutation = prepared.value;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    mutation.authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const changed = await applyVersionedAccessDefaults({
    scope: execution.value,
    expectedProjectionRevision: parsed.value.expectedRevision,
    actorUserId: mutation.scope.userId,
    identity: mutation.identity,
    boundary: mutation.boundary,
  });
  if (!changed.ok) return accessCapabilityMutationErrorResponse(changed.error);
  const published = await publishCurrentPolicy(
    env,
    execution.value,
    mutation.identity.createdAt,
  );
  if (!published.ok) return controlError(published.error, 503);
  const responseBody = {
    ok: true,
    revision: changed.value.projectionRevision,
    configurationVersion: changed.value.configurationVersion,
    defaults: {
      profile: "read_and_propose",
      profileVersion: 1,
      changed: changed.value.changed,
    },
  };
  return controlJson(responseBody);
}

async function prepareMutation(
  input: Readonly<{
    request: Request;
    env: Env;
    organisationIdRaw: string;
    raw: JsonRecord;
    path: string;
    operation: string;
  }>,
): Promise<
  | Readonly<{ ok: true; value: PreparedMutation; replay: null }>
  | Readonly<{
      ok: true;
      value?: never;
      replay: Response;
      authorized: AuthorizedOrganisationRequest;
    }>
  | Readonly<{ ok: false; response: Response }>
> {
  const authorized = await authorizeOrganisationRequest(
    input.request,
    input.env,
    input.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized;
  const boundary = await parseMutationBoundary(
    input.request,
    input.raw,
    "unversioned",
  );
  if (boundary instanceof Response) return { ok: false, response: boundary };
  const scope = controlMutationScope(authorized, input.path, input.operation);
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary,
  });
  if (replay.kind === "conflict") {
    return {
      ok: false,
      response: controlError("idempotency_key_conflict", 409),
    };
  }
  if (replay.kind === "replay") {
    return {
      ok: true,
      authorized,
      replay: controlJson(
        replay.receipt.responseBody,
        replay.receipt.responseStatus,
      ),
    };
  }
  const user = await resolveMutationUser(input.env, scope.userId);
  if (user instanceof Response) return { ok: false, response: user };
  const now = Date.now();
  const portalSubjectHash = await hashPortalSubject(user.issuer, user.subject);
  const identity = await deterministicMutationIdentity({
    scope,
    boundary,
    portalSubjectHash,
    causationId: controlCausationId(input.request),
    now,
  });
  return {
    ok: true,
    value: { authorized, boundary, scope, identity },
    replay: null,
  };
}

async function deterministicMutationIdentity(
  input: Readonly<{
    scope: ControlMutationReceiptScope;
    boundary: UnversionedControlMutationBoundary;
    portalSubjectHash: string;
    causationId: string;
    now: number;
  }>,
): Promise<ControlMutationIdentity> {
  const digest = await digestCanonical({
    kind: "access_control_mutation",
    scope: input.scope,
    idempotencyKey: input.boundary.idempotencyKey,
  });
  return {
    receiptId: `receipt_access_${digest.slice(0, 32)}`,
    auditEventId: `audit_access_${digest.slice(0, 32)}`,
    correlationId: `correlation_access_${digest.slice(0, 32)}`,
    causationId: input.causationId,
    portalSubjectHash: input.portalSubjectHash,
    createdAt: input.now,
  };
}

async function deterministicGrantId(
  scope: ControlMutationReceiptScope,
  boundary: UnversionedControlMutationBoundary,
): Promise<string> {
  const digest = await digestCanonical({
    kind: "access_grant",
    scope,
    idempotencyKey: boundary.idempotencyKey,
  });
  return `grant_${digest.slice(0, 32)}`;
}

async function resolveGrantTargetSelection(
  env: Env,
  scope: OrganisationExecutionScope,
  selection: CreateGrantTargetSelection,
): Promise<
  Result<
    AccessGrantTarget,
    "access_grant_target_invalid" | "access_grant_target_unavailable"
  >
> {
  const definition = capabilityDefinition(
    selection.capabilityRef.capabilityId,
    selection.capabilityRef.capabilityVersion,
  );
  if (definition === null)
    return { ok: false, error: "access_grant_target_invalid" };
  switch (selection.kind) {
    case "commerce_entity_type": {
      if (definition.target !== "commerce_read")
        return { ok: false, error: "access_grant_target_invalid" };
      const authority = await resolveOrganisationCommerceSystemAuthority({
        db: scope.database,
        organisationId: scope.organisationId,
      });
      if (!authority.ok || authority.value.provider !== "commerce") {
        return { ok: false, error: "access_grant_target_unavailable" };
      }
      return {
        ok: true,
        value: {
          kind: "commerce_read",
          capabilityId: definition.capabilityId,
          capabilityVersion: definition.capabilityVersion,
          scope: {
            kind: "entity_type",
            entityTypeId: selection.entityTypeId,
          },
        },
      };
    }
    case "commerce_list": {
      if (definition.target !== "commerce_read")
        return { ok: false, error: "access_grant_target_invalid" };
      const authority = await resolveOrganisationCommerceSystemAuthority({
        db: scope.database,
        organisationId: scope.organisationId,
      });
      if (!authority.ok || authority.value.provider !== "commerce")
        return { ok: false, error: "access_grant_target_unavailable" };
      const listId = commerceAccessTargets
        .use()
        .parseListReadId(selection.listId);
      if (listId === null)
        return { ok: false, error: "access_grant_target_invalid" };
      return {
        ok: true,
        value: {
          kind: "commerce_read",
          capabilityId: definition.capabilityId,
          capabilityVersion: definition.capabilityVersion,
          scope: { kind: "commerce_list", listId },
        },
      };
    }
    case "platform":
      return definition.target === "platform"
        ? {
            ok: true,
            value: {
              kind: "platform_capability",
              capabilityId: definition.capabilityId,
              capabilityVersion: definition.capabilityVersion,
            },
          }
        : { ok: false, error: "access_grant_target_invalid" };
    case "existing_target": {
      if (isPublishedCommerceListEntryPatch(definition)) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const target = await resolveGrantTargetReference({
        db: scope.database,
        organisationId: scope.organisationId,
        targetRef: selection.targetRef,
      });
      return target.ok &&
        target.value.capabilityId === definition.capabilityId &&
        target.value.capabilityVersion === definition.capabilityVersion
        ? target
        : { ok: false, error: "access_grant_target_unavailable" };
    }
    case "published_commerce_target": {
      if (
        definition.target !== "commerce_command" &&
        definition.target !== "provider_resource"
      ) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const target = await commerceAccessTargets.use().resolvePublishedTarget({
        env,
        organisationId: scope.organisationId,
        targetRef: selection.targetRef,
      });
      if (!target.ok)
        return { ok: false, error: "access_grant_target_unavailable" };
      if (
        isPublishedCommerceListEntryPatch(definition) &&
        definition.target === "commerce_command" &&
        target.value.kind === "list_entry"
      ) {
        return { ok: true, value: target.value.target };
      }
      return isCommerceActionPropose(definition) &&
        definition.target === "provider_resource"
        ? { ok: true, value: target.value.providerTarget }
        : { ok: false, error: "access_grant_target_invalid" };
    }
    case "provider_resource": {
      if (definition.target !== "provider_resource") {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const integrationAccountId = prefixedReferenceValue(
        selection.integrationRef,
        "integration:",
      );
      const resourceScope = prefixedReferenceValue(
        selection.resourceRef,
        "provider_resource:",
      );
      if (integrationAccountId === null || resourceScope === null) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      if (
        definition.capabilityId === CAPABILITY_KEYS.emailOperationalPropose &&
        resourceScope !== EMAIL_OPERATIONAL_RESOURCE_SCOPE
      ) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      if (
        (definition.capabilityId === CAPABILITY_KEYS.slackMessagePropose) !==
        (resourceScope === SLACK_MESSAGE_RESOURCE_SCOPE)
      ) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      if (isCommerceActionPropose(definition)) {
        const authority = await resolveOrganisationCommerceSystemAuthority({
          db: scope.database,
          organisationId: scope.organisationId,
        });
        if (!authority.ok)
          return { ok: false, error: "access_grant_target_unavailable" };
        // A Pantry Commerce proposal grant names one published record, or the
        // whole shop when an agent's permission request asks for it.
        if (
          (authority.value.provider === "commerce" &&
            resourceScope !== "*") ||
          authority.value.integrationAccountId !== integrationAccountId
        ) {
          return { ok: false, error: "access_grant_target_invalid" };
        }
      }
      return {
        ok: true,
        value: {
          kind: "provider_resource",
          capabilityId: definition.capabilityId,
          capabilityVersion: definition.capabilityVersion,
          integrationAccountId,
          resourceScope,
        },
      };
    }
    case "file_resource": {
      if (definition.target !== "file_resource") {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const integrationAccountId = prefixedReferenceValue(
        selection.integrationRef,
        "integration:",
      );
      return integrationAccountId === null
        ? { ok: false, error: "access_grant_target_invalid" }
        : {
            ok: true,
            value: {
              kind: "file_resource",
              capabilityId: definition.capabilityId,
              capabilityVersion: definition.capabilityVersion,
              integrationAccountId,
              scope: selection.scope,
            },
          };
    }
    case "custom_connector_operation": {
      if (definition.target !== "custom_connector_operation") {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const integrationAccountId = prefixedReferenceValue(
        selection.integrationRef,
        "integration:",
      );
      if (integrationAccountId === null) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      return {
        ok: true,
        value: {
          kind: "custom_connector_operation",
          capabilityId: definition.capabilityId,
          capabilityVersion: definition.capabilityVersion,
          integrationAccountId,
          connectorId: selection.connectorId,
          definitionRevision: selection.definitionRevision,
          definitionDigest: selection.definitionDigest,
          operationId: selection.operationId,
        },
      };
    }
    default:
      return assertNever(selection);
  }
}

function prefixedReferenceValue(
  reference: string,
  prefix: string,
): string | null {
  const value = reference.startsWith(prefix)
    ? reference.slice(prefix.length)
    : "";
  return boundedIdentifier(value) ? value : null;
}

function isPublishedCommerceListEntryPatch(
  definition: CapabilityDefinition,
): boolean {
  return (
    definition.capabilityId === "commerce.list_entry.patch" &&
    definition.capabilityVersion === 1
  );
}

function isCommerceActionPropose(definition: CapabilityDefinition): boolean {
  return (
    definition.capabilityId === CAPABILITY_KEYS.commerceActionPropose &&
    definition.capabilityVersion === 1
  );
}

async function validateGrantTarget(
  parts: AccessControlParts,
  env: Env,
  scope: OrganisationExecutionScope,
  target: AccessGrantTarget,
): Promise<
  Result<
    AccessGrantTarget,
    "access_grant_target_invalid" | "access_grant_target_unavailable"
  >
> {
  const organisationId = scope.organisationId;
  const definition = capabilityDefinition(
    target.capabilityId,
    target.capabilityVersion,
  );
  if (
    definition === null ||
    !targetMatchesDefinition(target.kind, definition.target)
  ) {
    return { ok: false, error: "access_grant_target_invalid" };
  }
  switch (target.kind) {
    case "platform_capability":
    case "commerce_read":
    case "commerce_command":
      return { ok: true, value: target };
    case "provider_resource": {
      if (isCommerceActionPropose(definition)) {
        const authority = await resolveOrganisationCommerceSystemAuthority({
          db: scope.database,
          organisationId,
        });
        if (
          authority.ok &&
          authority.value.provider === "commerce" &&
          authority.value.integrationAccountId === target.integrationAccountId
        ) {
          return { ok: true, value: target };
        }
      }
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok)
        return { ok: false, error: "access_grant_target_invalid" };
      const account = await resolveIntegrationAccount({
        db: scope.database,
        organisationId,
        integrationAccountId: integrationAccountId.value,
      });
      return account.ok && account.value.lifecycle.kind === "active"
        ? { ok: true, value: target }
        : { ok: false, error: "access_grant_target_unavailable" };
    }
    case "custom_connector_operation": {
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok) {
        return { ok: false, error: "access_grant_target_invalid" };
      }
      const account = await parts.customConnectorAccount({
        db: scope.database,
        organisationId,
        integrationAccountId: integrationAccountId.value,
      });
      if (!account.ok) {
        return { ok: false, error: "access_grant_target_unavailable" };
      }
      const binding = account.value.binding;
      if (
        account.value.source.connectorId !== target.connectorId ||
        binding.acceptedRevision !== target.definitionRevision ||
        binding.definitionDigest !== target.definitionDigest
      ) {
        return { ok: false, error: "access_grant_target_unavailable" };
      }
      const revision = await parts.customConnectorRevision({
        db: scope.database,
        organisationId,
        connectorId: account.value.source.connectorId,
        revision: binding.acceptedRevision,
      });
      if (!revision.ok || revision.value.reviewState !== "approved") {
        return { ok: false, error: "access_grant_target_unavailable" };
      }
      const operation = revision.value.definition.operations.find(
        operationMatchesTarget.bind(null, target.operationId),
      );
      const operationExists =
        operation !== undefined &&
        ((target.capabilityId === "custom_connector.read" &&
          operation.effect.kind === "read") ||
          (target.capabilityId === "custom_connector.write" &&
            operation.effect.kind !== "read"));
      return operationExists
        ? { ok: true, value: target }
        : { ok: false, error: "access_grant_target_unavailable" };
    }
    case "file_resource": {
      const validated = await fileGrantParts.use().validateFileGrantTarget({
        env,
        scope,
        target,
        now: Date.now(),
      });
      return validated.ok
        ? validated
        : { ok: false, error: "access_grant_target_unavailable" };
    }
    default:
      return assertNever(target);
  }
}

function parseCreateGrantRequest(
  raw: JsonRecord,
): Result<CreateGrantRequest, "access_control_grant_create_invalid"> {
  if (
    !hasExactKeys(raw, ["expectedRevision", "subjectRef", "target"]) ||
    !isPositiveInteger(raw.expectedRevision)
  ) {
    return { ok: false, error: "access_control_grant_create_invalid" };
  }
  const subjectRef = parseSubjectReference(raw.subjectRef);
  const target = parseCreateGrantTargetSelection(raw.target);
  return subjectRef !== null && target !== null
    ? {
        ok: true,
        value: { expectedRevision: raw.expectedRevision, subjectRef, target },
      }
    : { ok: false, error: "access_control_grant_create_invalid" };
}

function parseCreateGrantTargetSelection(
  value: unknown,
): CreateGrantTargetSelection | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const capabilityRef = parseCapabilityReference(value.capabilityRef);
  if (capabilityRef === null) return null;
  switch (value.kind) {
    case "commerce_entity_type": {
      if (!hasExactKeys(value, ["kind", "capabilityRef", "entityTypeId"]))
        return null;
      const entityTypeId = commerceAccessTargets
        .use()
        .parseEntityTypeId(value.entityTypeId);
      return entityTypeId === null
        ? null
        : { kind: "commerce_entity_type", capabilityRef, entityTypeId };
    }
    case "platform":
      return hasExactKeys(value, ["kind", "capabilityRef"])
        ? { kind: "platform", capabilityRef }
        : null;
    // Only the lists that an agent may ask to read; the Access page offers
    // no list reads.
    case "commerce_list":
      return hasExactKeys(value, ["kind", "capabilityRef", "listId"]) &&
        isAgentPermissionListRead(value.listId)
        ? { kind: "commerce_list", capabilityRef, listId: value.listId }
        : null;
    case "existing_target": {
      if (!hasExactKeys(value, ["kind", "capabilityRef", "targetRef"]))
        return null;
      const targetRef = parseTargetReference(value.targetRef);
      return targetRef === null
        ? null
        : { kind: "existing_target", capabilityRef, targetRef };
    }
    case "published_commerce_target": {
      if (!hasExactKeys(value, ["kind", "capabilityRef", "targetRef"]))
        return null;
      const targetRef = parseTargetReference(value.targetRef);
      return targetRef === null
        ? null
        : { kind: "published_commerce_target", capabilityRef, targetRef };
    }
    case "provider_resource":
      return hasExactKeys(value, [
        "kind",
        "capabilityRef",
        "integrationRef",
        "resourceRef",
      ]) &&
        boundedIdentifier(value.integrationRef) &&
        boundedIdentifier(value.resourceRef)
        ? {
            kind: "provider_resource",
            capabilityRef,
            integrationRef: value.integrationRef,
            resourceRef: value.resourceRef,
          }
        : null;
    case "file_resource": {
      if (
        !hasExactKeys(value, [
          "kind",
          "capabilityRef",
          "integrationRef",
          "scope",
        ]) ||
        !boundedIdentifier(value.integrationRef)
      )
        return null;
      const scope = parseFileResourceScope(value.scope);
      return scope === null
        ? null
        : {
            kind: "file_resource",
            capabilityRef,
            integrationRef: value.integrationRef,
            scope,
          };
    }
    case "custom_connector_operation": {
      if (
        !hasExactKeys(value, [
          "kind",
          "capabilityRef",
          "integrationRef",
          "connectorId",
          "definitionRevision",
          "definitionDigest",
          "operationId",
        ]) ||
        !boundedIdentifier(value.integrationRef) ||
        typeof value.operationId !== "string" ||
        !/^[a-z][a-z0-9_]{0,47}$/u.test(value.operationId)
      ) {
        return null;
      }
      const connectorId = parseCustomConnectorId(value.connectorId);
      const definitionRevision = parseCustomConnectorRevision(
        value.definitionRevision,
      );
      const definitionDigest = parseCustomConnectorDefinitionDigest(
        value.definitionDigest,
      );
      return connectorId.ok && definitionRevision.ok && definitionDigest.ok
        ? {
            kind: "custom_connector_operation",
            capabilityRef,
            integrationRef: value.integrationRef,
            connectorId: connectorId.value,
            definitionRevision: definitionRevision.value,
            definitionDigest: definitionDigest.value,
            operationId: value.operationId,
          }
        : null;
    }
    default:
      return null;
  }
}

function operationMatchesTarget(
  operationId: string,
  operation: Readonly<{
    readonly id: string;
    readonly effect: { readonly kind: string };
  }>,
): boolean {
  return operation.id === operationId && operation.effect.kind === "read";
}

function parseCapabilityReference(value: unknown): CapabilityRef | null {
  return isRecord(value) &&
    hasExactKeys(value, ["capabilityId", "capabilityVersion"]) &&
    boundedIdentifier(value.capabilityId) &&
    isPositiveInteger(value.capabilityVersion)
    ? {
        capabilityId: value.capabilityId,
        capabilityVersion: value.capabilityVersion,
      }
    : null;
}

function parseTargetReference(value: unknown): AccessTargetRef | null {
  return isRecord(value) &&
    hasExactKeys(value, ["targetRefId", "revision"]) &&
    typeof value.targetRefId === "string" &&
    /^target_[0-9a-f]{32}$/u.test(value.targetRefId) &&
    isPositiveInteger(value.revision)
    ? { targetRefId: value.targetRefId, revision: value.revision }
    : null;
}

function parseSubjectReference(value: unknown): AccessSubjectRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subjectRefId", "revision"]) ||
    typeof value.subjectRefId !== "string" ||
    !/^subject_[0-9a-f]{32}$/u.test(value.subjectRefId) ||
    !isPositiveInteger(value.revision)
  )
    return null;
  return { subjectRefId: value.subjectRefId, revision: value.revision };
}

function parseRevokeGrantRequest(
  raw: JsonRecord,
): Result<RevokeGrantRequest, "access_control_grant_revoke_invalid"> {
  return hasExactKeys(raw, ["expectedRevision", "grantRevision", "reason"]) &&
    isPositiveInteger(raw.expectedRevision) &&
    isPositiveInteger(raw.grantRevision) &&
    boundedReason(raw.reason)
    ? {
        ok: true,
        value: {
          expectedRevision: raw.expectedRevision,
          grantRevision: raw.grantRevision,
          reason: raw.reason,
        },
      }
    : { ok: false, error: "access_control_grant_revoke_invalid" };
}

function parseChangeCapabilityRequest(
  raw: JsonRecord,
): Result<ChangeCapabilityRequest, "access_control_capability_change_invalid"> {
  return hasExactKeys(raw, [
    "expectedRevision",
    "capabilityRevision",
    "capabilityVersion",
    "mode",
  ]) &&
    isPositiveInteger(raw.expectedRevision) &&
    isPositiveInteger(raw.capabilityRevision) &&
    isPositiveInteger(raw.capabilityVersion) &&
    isCapabilityMode(raw.mode)
    ? {
        ok: true,
        value: {
          expectedRevision: raw.expectedRevision,
          capabilityRevision: raw.capabilityRevision,
          capabilityVersion: raw.capabilityVersion,
          mode: raw.mode,
        },
      }
    : { ok: false, error: "access_control_capability_change_invalid" };
}

function parseApplyDefaultsRequest(
  raw: JsonRecord,
): Result<ApplyDefaultsRequest, "access_control_defaults_apply_invalid"> {
  return hasExactKeys(raw, ["expectedRevision"]) &&
    isPositiveInteger(raw.expectedRevision)
    ? { ok: true, value: { expectedRevision: raw.expectedRevision } }
    : { ok: false, error: "access_control_defaults_apply_invalid" };
}

async function publishCurrentPolicy(
  env: Env,
  scope: OrganisationExecutionScope,
  now: number,
): Promise<
  Result<true, "policy_activation_failed" | "policy_settlement_failed">
> {
  try {
    if (!(await scope.isActive()))
      return { ok: false, error: "policy_activation_failed" };
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env,
      organisationId: scope.organisationId,
      placement: scope.placement,
      now,
    });
    const published = await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: scope.database, kv: env.POLICY_KV },
      organisationId: scope.organisationId,
      organisation,
      now,
    });
    return published.ok
      ? { ok: true, value: true }
      : { ok: false, error: "policy_settlement_failed" };
  } catch {
    return { ok: false, error: "policy_activation_failed" };
  }
}

/** The answer of a grant that was created or revoked. */
function accessGrantMutationResponse(
  changed: Result<AccessGrantMutationResult, AccessGrantMutationError>,
): Response {
  if (!changed.ok) return accessGrantMutationErrorResponse(changed.error);
  return controlJson({
    ok: true,
    revision: changed.value.projectionRevision,
    configurationVersion: changed.value.configurationVersion,
    grant: changed.value.grant,
  });
}

function accessGrantMutationErrorResponse(
  error: AccessGrantMutationError,
): Response {
  switch (error.code) {
    case "access_control_revision_conflict":
    case "access_grant_revision_conflict":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        409,
      );
    case "access_grant_not_found":
      return controlError(error.code, 404);
    case "access_grant_invalid_transition":
      return controlError(error.code, 409);
    case "access_grant_mutation_failed":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}

function accessCapabilityMutationErrorResponse(
  error: AccessCapabilityMutationError,
): Response {
  switch (error.code) {
    case "access_control_revision_conflict":
    case "capability_policy_revision_conflict":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        409,
      );
    case "organisation_placement_conflict":
      return controlError(error.code, 409);
    case "capability_policy_not_found":
      return controlError(error.code, 404);
    case "capability_policy_mode_unsupported":
      return controlError(error.code, 422);
    case "access_capability_mutation_failed":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}

function capabilityDefinition(capabilityId: string, capabilityVersion: number) {
  for (const definition of CAPABILITY_CATALOGUE) {
    if (
      definition.capabilityId === capabilityId &&
      definition.capabilityVersion === capabilityVersion
    ) {
      return definition;
    }
  }
  return null;
}

function targetMatchesDefinition(
  kind: AccessGrantTarget["kind"],
  target: CapabilityDefinition["target"],
): boolean {
  switch (kind) {
    case "platform_capability":
      return target === "platform";
    case "provider_resource":
      return target === "provider_resource";
    case "file_resource":
      return target === "file_resource";
    case "custom_connector_operation":
      return target === "custom_connector_operation";
    case "commerce_read":
      return target === "commerce_read";
    case "commerce_command":
      return target === "commerce_command";
  }
}

function routePath(route: AccessControlMutationRoute): string {
  const base = `/v1/control/organisations/${route.organisationIdRaw}/access-control`;
  switch (route.kind) {
    case "accessControlBudget":
      return `${base}/ai-budget`;
    case "accessControlGrantCreate":
      return `${base}/grants`;
    case "accessControlGrantRevoke":
      return `${base}/grants/${route.grantId}/revoke`;
    case "accessControlCapabilityChange":
      return `${base}/capabilities/${route.capabilityId}`;
    case "accessControlDefaultsApply":
      return `${base}/defaults/apply`;
    default:
      return assertNever(route);
  }
}

function isCapabilityMode(value: unknown): value is CapabilityMode {
  return (
    value === "enabled" || value === "approval_required" || value === "disabled"
  );
}

function boundedReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 200
  );
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 256
  );
}
