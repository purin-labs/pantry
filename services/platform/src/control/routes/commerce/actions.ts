import type { OrganisationDatabase } from "../../../database-handles";
import { ensureCaseProject } from "../../../projects/case-project";
import { controlActionMutationExecution } from "../../../actors/action-mutation-execution";
import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import type { Result } from "../../../result";
import type {
  CaseBinding,
  CommerceSource,
} from "@seams/contracts";
import {
  resolveActiveCaseActor,
  requireActiveOrganisationActor,
} from "../../../actors/actor-router";
import type { CaseDO } from "../../../actors/case";
import type { OrganisationDO } from "../../../actors/organisation";
import {
  approvalActionBindingMatches,
  digestApprovalAction,
  type ApprovalEvidence,
  type MerchantActionRejectionEvidence,
} from "../../../approval-authentication";
import { authorizeCapabilityUse } from "../../../authorization/access-grants/turn-authority";
import type { ProviderCapabilityDefinition } from "../../../authorization/access-grants/capability-key";
import {
  buildCommerceActionDraft,
  buildSupplierPayoutActionDraft,
  buildCommerceCancellationActionDraft,
  commerceActionExpectedRevision,
  commerceActionMutationDigest,
  commerceProjectionRevision,
  commerceTrackingAttachmentTargetMatches,
  isCommerceActionNonce as isActionNonce,
  parseCommerceActionPath,
  parseCommerceActionRequest,
  type CommerceActionError,
  type CommerceActionRequest,
} from "../../../commerce/action-model";
import { listPublishedCommerceTargets } from "../../../commerce/entity-plane/published-resources";
import type { PermissionRequired } from "@seams/control-api";
import { CAPABILITY_KEYS } from "../../../authorization/capability-catalogue";
import {
  permissionRequiredResponse,
  personPermission,
} from "../../permission-required";
import {
  consumeGoogleApprovalCeremony,
  verifyGoogleApprovalGrant,
} from "../../oidc";
import {
  readActiveOrganisationMembershipRevision,
  resolveUser,
  type ActiveOrganisationMembership,
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
  resolveOrganisationCommerceMerchantBinding,
  resolveCommerceMerchantBinding,
} from "../../../data/commerce-merchant-binding";
import { buildOnboardingProjection } from "../../../data/onboarding-projection";
import { resolveConfiguredSlackInstallationIdentity } from "../../../slack/installation-identity";
import {
  bindUnboundSetupChannel,
  prepareSlackRoutingAuditEvent,
  resolveActiveSlackDestinationConnection,
} from "../../../slack/organisation-routing";
import { resolveOrganisationCommerceSystemAuthority } from "../../../data/organisation-commerce-system";
import {
  previewMerchantPluginAction,
  type CommerceProviderExecutionError,
} from "../../../commerce/provider-execution";
import { prepareTurnAuthority } from "../../../context/turn-context";
import {
  parseCaseId,
  parseChannelId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseSessionId,
  parseWorkspaceId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../../ids";
import { loadOrganisationPolicyOrDefaultDeny } from "../../../policy-snapshot";
import { buildControlAuthority } from "../../../request-authority";
import { resolveOrganisationModelRoute } from "../../../models/route";
import {
  resolveCommerceCancellationAuthority,
  commerceCanonicalResourceId,
  commerceProviderResourceId,
} from "../../../commerce/provider";
import { createCommerceClient } from "../../../commerce/outbox-worker";
import {
  authorizeOrganisationRequest,
  APPROVAL_GRANT_COOKIE,
  parseCookies,
  type AuthorizedOrganisationRequest,
} from "../../authorization";
import { readSupplierPayout } from "../../../data/supplier-payout-store";
import { readSealedPayoutPlan } from "../../../data/supplier-payout-plan";
import { readSupplierPayoutAttempt } from "../../../data/supplier-payout-attempt";
import { readSupplierDestinationRevision } from "../../../data/supplier-payable-store";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "../../http";
import { googleConfig } from "../../google-oidc-config";
import { controlCausationId } from "../../mutation";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { readOrganisationEnvironment } from "../../organisation-runtime";
import { executeApprovedSupplierPayout } from "../supplier-payout-execution";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import {
  type CommerceActionFailure,
  acceptAndDeliverCommerceOutcome,
  commerceActionProjectionTarget,
  commerceActionRecord,
  executeCommerceAction,
} from "../../../commerce/actions";
import { commerceActionLedgerError } from "./support";

export const APPROVAL_STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export function commerceActionProviderSupported(
  source: CommerceSource,
  kind: CommerceActionRequest["kind"],
): boolean {
  if (source === "lab") return true;
  if (source === "shopify") return kind === "cancel_order";
  if (source === "underclerk") {
    return (
      kind === "update_product_description" ||
      kind === "publish_catalog_listing" ||
      kind === "cancel_order" ||
      kind === "attach_tracking" ||
      kind === "adjust_offer_price"
    );
  }
  return false;
}

export function controlCommerceActionCapability(
  integrationAccountId: IntegrationAccountId,
  resourceScope: string,
): ProviderCapabilityDefinition {
  return {
    kind: "provider_resource",
    capabilityId: "commerce.action.propose",
    capabilityVersion: 1,
    integrationAccountId,
    resourceScope,
  };
}

/**
 * The refusals that the propose prompt can resolve: a missing grant, or the
 * capability switched off for the organisation, which the policy reports as a
 * capability outside its allowed tools.
 */
export function proposePermissionMayBeOffered(
  error: Readonly<{ code: string; detail?: string }>,
  required: ProviderCapabilityDefinition,
): boolean {
  return (
    error.code === "capability_not_granted" ||
    (error.code === "organisation_policy_superseded" &&
      error.detail === required.capabilityId)
  );
}

/**
 * What this person needs to propose this action: the propose capability
 * switched on, and the grant on the published commerce target of the same
 * resource. An order, offer or fulfillment has no published target, so its
 * prompt can only switch the capability on. Null when nothing that a prompt
 * can change would admit the proposal.
 */
export async function commerceActionPermission(
  env: Env,
  scope: OrganisationExecutionScope,
  personId: string,
  required: ProviderCapabilityDefinition,
  refusal: Readonly<{ code: string }>,
): Promise<PermissionRequired | null> {
  const targets = await listPublishedCommerceTargets({
    env,
    organisationId: scope.organisationId,
  });
  const target = targets.ok
    ? targets.value.find(
        (candidate) =>
          candidate.providerTarget.kind === "provider_resource" &&
          candidate.providerTarget.capabilityId === required.capabilityId &&
          candidate.providerTarget.integrationAccountId ===
            required.integrationAccountId &&
          candidate.providerTarget.resourceScope === required.resourceScope,
      )
    : undefined;
  if (target === undefined && refusal.code === "capability_not_granted")
    return null;
  return personPermission(
    scope,
    CAPABILITY_KEYS.commerceActionPropose,
    target === undefined
      ? null
      : {
          personId,
          target: {
            kind: "published_commerce_target",
            capabilityRef: {
              capabilityId: required.capabilityId,
              capabilityVersion: required.capabilityVersion,
            },
            targetRef: target.targetRef,
          },
        },
  );
}

/**
 * The Orders page reads an Commerce order from Commerce, so it names the
 * order by Commerce's own id. The local projection and the provider call
 * name it by its canonical id.
 */
export async function withCanonicalOrderId(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    body.kind !== "cancel_order" ||
    typeof body.resourceId !== "string" ||
    body.resourceId.startsWith("underclerk:")
  )
    return body;
  const environment = await readOrganisationEnvironment(db, organisationId);
  if (environment === null) return body;
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db,
    organisationId,
    environment,
  });
  return binding.ok
    ? {
        ...body,
        resourceId: commerceCanonicalResourceId(
          binding.value.merchantId,
          body.resourceId,
        ),
      }
    : body;
}

export async function handleCommerceActions(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  actionNonceRaw: string | null,
): Promise<Response> {
  const requiredRole: "admin" | "viewer" =
    request.method === "GET" ? "viewer" : "admin";
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    requiredRole,
    request.method !== "GET",
  );
  if (!authorized.ok) return authorized.response;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  if (request.method === "GET") {
    if (actionNonceRaw === null || !isActionNonce(actionNonceRaw))
      return controlError("commerce_action_not_found", 404);
    const action = await organisation.getAction({
      organisationId: authorized.organisationId,
      nonce: actionNonceRaw,
      now: Date.now(),
    });
    return action.ok
      ? controlJson({ ok: true, action: commerceActionRecord(action.value) })
      : commerceActionLedgerError(action.error);
  }
  if (request.method !== "POST" || actionNonceRaw !== null)
    return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("commerce_action_invalid", 422);
  const parsed = parseCommerceActionRequest(
    await withCanonicalOrderId(
      authorized.executionScope.database,
      authorized.organisationId,
      body.value,
    ),
  );
  if (!parsed.ok) return commerceActionErrorResponse(parsed.error);
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
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/actions`,
    operation: "commerce.action.propose",
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
  const target = commerceActionProjectionTarget(parsed.value);
  if (target === null) {
    if (
      parsed.value.kind !== "submit_supplier_payout" &&
      parsed.value.kind !== "resume_supplier_payout_funding"
    ) {
      return commerceActionErrorResponse({
        code: "commerce_action_path_invalid",
      });
    }
    return proposePayoutAction({
      request,
      env,
      authorized,
      organisation,
      identity,
      scope,
      boundary: boundary.value,
      action: parsed.value,
      now: Date.now(),
    });
  }
  const current = await organisation.readCurrentCommerceProjection({
    organisationId: authorized.organisationId,
    kind: target.kind,
    canonicalId: target.resourceId,
  });
  if (!current.ok) return commerceActionProjectionError(current.error.code);
  if (current.value === null)
    return commerceActionErrorResponse({
      code: "commerce_action_projection_missing",
    });
  if (
    !commerceActionProviderSupported(
      current.value.projection.provenance.source,
      parsed.value.kind,
    )
  ) {
    return commerceActionErrorResponse({
      code: "commerce_action_provider_unsupported",
    });
  }
  const expectedRevision = commerceActionExpectedRevision(parsed.value);
  const actualRevision = commerceProjectionRevision(current.value);
  if (actualRevision !== expectedRevision) {
    return commerceActionErrorResponse({
      code: "commerce_action_revision_stale",
      expected: expectedRevision,
      actual: actualRevision,
    });
  }
  if (parsed.value.kind === "publish_catalog_listing") {
    const required = [
      {
        kind: "product" as const,
        id: parsed.value.productId,
        revision: parsed.value.productRevision,
      },
      {
        kind: "sellable_variant" as const,
        id: parsed.value.variantId,
        revision: parsed.value.variantRevision,
      },
      {
        kind: "offer" as const,
        id: parsed.value.offerId,
        revision: parsed.value.offerRevision,
      },
      {
        kind: "sales_channel" as const,
        id: parsed.value.salesChannelId,
        revision: parsed.value.salesChannelRevision,
      },
    ];
    for (const requirement of required) {
      const related = await organisation.readCurrentCommerceProjection({
        organisationId: authorized.organisationId,
        kind: requirement.kind,
        canonicalId: requirement.id,
      });
      if (
        !related.ok ||
        related.value === null ||
        related.value.projection.provenance.revision !== requirement.revision ||
        related.value.projection.provenance.integrationAccountId !==
          current.value.projection.provenance.integrationAccountId
      ) {
        return commerceActionErrorResponse({
          code: "commerce_action_revision_stale",
          expected: requirement.revision,
          actual:
            related.ok && related.value !== null
              ? commerceProjectionRevision(related.value)
              : 0,
        });
      }
    }
  }
  if (parsed.value.kind === "attach_tracking") {
    if (current.value.kind !== "fulfillment") {
      return commerceActionErrorResponse({
        code: "commerce_action_projection_kind_mismatch",
      });
    }
    const shipment = await organisation.readCurrentCommerceProjection({
      organisationId: authorized.organisationId,
      kind: "shipment",
      canonicalId: parsed.value.shipmentId,
    });
    if (
      !shipment.ok ||
      shipment.value === null ||
      shipment.value.kind !== "shipment" ||
      !commerceTrackingAttachmentTargetMatches({
        fulfillment: current.value,
        shipment: shipment.value,
        request: parsed.value,
      })
    ) {
      return commerceActionErrorResponse({
        code: "commerce_action_revision_stale",
        expected: parsed.value.shipmentRevision,
        actual:
          shipment.ok && shipment.value !== null
            ? commerceProjectionRevision(shipment.value)
            : 0,
      });
    }
  }
  const digest = await commerceActionMutationDigest(boundary.value);
  const sessionId = parseSessionId(
    authorized.authenticated.session.controlSessionId,
  );
  if (!sessionId.ok)
    return controlError("commerce_action_identity_invalid", 500);
  const caseId = parseCaseId(`case_merchant_action_${digest}`);
  if (!caseId.ok) return controlError("commerce_action_identity_invalid", 500);
  const proposalId = `proposal_merchant_action_${digest}`;
  const integrationAccountId = parseIntegrationAccountId(
    current.value.projection.provenance.integrationAccountId,
  );
  if (!integrationAccountId.ok)
    return controlError("commerce_action_projection_invalid", 500);
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !==
      current.value.projection.provenance.source ||
    commerceAuthority.value.integrationAccountId !== integrationAccountId.value
  ) {
    return controlError("commerce_action_authority_rebase_required", 409);
  }
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (membershipRevision === null)
    return controlError("commerce_action_authority_unavailable", 503);
  const requestAuthority = buildControlAuthority({
    organisationId: authorized.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: authorized.authenticated.session.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  const now = Date.now();
  let draft: Awaited<ReturnType<typeof buildCommerceActionDraft>>;
  if (
    parsed.value.kind === "cancel_order" &&
    current.value.projection.provenance.source === "underclerk"
  ) {
    if (current.value.kind !== "commerce_order") {
      return commerceActionErrorResponse({
        code: "commerce_action_projection_kind_mismatch",
      });
    }
    const binding = await resolveCommerceMerchantBinding({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: integrationAccountId.value,
    });
    if (!binding.ok) {
      return controlError(
        binding.error.code === "underclerk_binding_not_found"
          ? "underclerk_binding_missing"
          : "underclerk_binding_mismatch",
        503,
      );
    }
    if (
      commerceAuthority.value.provider !== "underclerk" ||
      commerceAuthority.value.commerceSystem.kind !== "satyr_commerce" ||
      binding.value.organisationId !== authorized.organisationId ||
      binding.value.integrationAccountId !== integrationAccountId.value ||
      binding.value.bindingId !==
        commerceAuthority.value.commerceSystem.bindingId ||
      binding.value.merchantId !==
        commerceAuthority.value.commerceSystem.merchantId
    ) {
      return controlError("underclerk_binding_mismatch", 503);
    }
    const client = createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(authorized.organisationId),
      actor: String(authorized.membership.personId),
    });
    if (client === null) return controlError("underclerk_unavailable", 503);
    const orderId = commerceProviderResourceId(
      binding.value.merchantId,
      parsed.value.resourceId,
    );
    if (orderId === null)
      return controlError("commerce_action_projection_invalid", 500);
    const authority = await resolveCommerceCancellationAuthority({
      client,
      organisationId: authorized.organisationId,
      merchantId: binding.value.merchantId,
      orderId,
      orderRevision: commerceProjectionRevision(current.value),
      requestedAt: new Date(now).toISOString(),
    });
    if (!authority.ok) {
      return authority.error.code === "underclerk_unavailable"
        ? controlError("underclerk_unavailable", 503)
        : controlError("commerce_action_invalid", 422);
    }
    draft = await buildCommerceCancellationActionDraft({
      request: parsed.value,
      authority: authority.value,
      current: current.value,
    });
  } else {
    draft = await buildCommerceActionDraft({
      organisationId: authorized.organisationId,
      integrationAccountId: integrationAccountId.value,
      sessionId: sessionId.value,
      threadId: caseId.value,
      request: parsed.value,
      current: current.value,
      exp: now + 15 * 60_000,
      now,
    });
  }
  if (!draft.ok) return commerceActionErrorResponse(draft.error);
  const modelRoute = await resolveOrganisationModelRoute({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  if (!modelRoute.ok)
    return controlError("commerce_action_authority_unavailable", 503);
  const loadedPolicy = await loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: authorized.executionScope.database, kv: env.POLICY_KV },
    organisationId: authorized.organisationId,
    now,
  });
  const turnAuthority = await prepareTurnAuthority({
    db: authorized.executionScope.database,
    accountAccess: authorized.executionScope.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: authorized.authenticated.session.controlSessionId },
    action: "execute",
    organisationId: authorized.organisationId,
    requestAuthority,
    policy: { version: loadedPolicy.snapshot.version },
  });
  if (!turnAuthority.ok) return controlError("commerce_action_forbidden", 403);
  const requiredCapability = controlCommerceActionCapability(
    integrationAccountId.value,
    draft.value.resourceKey,
  );
  const actionAuthority = await authorizeCapabilityUse({
    db: authorized.executionScope.database,
    accountAccess: authorized.executionScope.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: authorized.authenticated.session.controlSessionId },
    action: "execute",
    organisationId: authorized.organisationId,
    authority: requestAuthority,
    authorityPartition: turnAuthority.value.authorityPartition,
    request: { capabilities: [requiredCapability] },
  });
  if (!actionAuthority.ok) {
    // A person who only lacks the propose permission can be given it here,
    // for this product, through the same Access mutations as the Access page.
    // While the organisation keeps the capability switched off, the policy
    // admits no tool for it, and the prompt offers to switch it on as well.
    const permission = proposePermissionMayBeOffered(
      actionAuthority.error,
      requiredCapability,
    )
      ? await commerceActionPermission(
          env,
          authorized.executionScope,
          authorized.membership.personId,
          requiredCapability,
          actionAuthority.error,
        )
      : null;
    return permission === null ||
      (actionAuthority.error.code === "organisation_policy_superseded" &&
        permission.mode !== "disabled")
      ? controlError("commerce_action_forbidden", 403)
      : permissionRequiredResponse(
          "commerce_action_permission_required",
          permission,
        );
  }
  const caseActor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: authorized.organisationId,
    caseId: caseId.value,
    now,
  });
  if (!caseActor.ok)
    return controlError("commerce_action_case_unavailable", 503);
  const placed = await ensureCaseProject({
    scope: authorized.executionScope,
    caseId: caseId.value,
    origin: "commerce_approval",
    now,
  });
  if (!placed.ok) return controlError(placed.error.code, 409);
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: authorized.organisationId, caseId: caseId.value },
    purpose: "merchant commerce action",
    workspaceRevision: `commerce:${integrationAccountId.value}`,
    lifecycle: { kind: "open", openedAt: now },
  });
  if (!ensured.ok) return controlError("commerce_action_case_unavailable", 409);
  const bound = await attachMerchantActionDestination({
    env,
    execution: authorized.executionScope,
    membership: authorized.membership,
    caseId: caseId.value,
    caseActor: caseActor.value,
    mutationIdentity: newControlMutationIdentity({
      portalSubjectHash: await hashPortalSubject(
        identity.issuer,
        identity.subject,
      ),
      causationId: controlCausationId(request),
      now,
    }),
  });
  if (!bound.ok) return controlError(bound.error.code, 409);
  const inspected = await caseActor.value.inspect();
  if (inspected.ok !== true)
    return controlError("commerce_action_case_unavailable", 409);
  const actionExecution = await controlActionMutationExecution(
    env,
    authorized.organisationId,
    authorized.authenticated.session,
  );
  if (!actionExecution.ok) return controlError(actionExecution.error.code, 409);
  const caseProposal = await caseActor.value.acceptCommerceProposal({
    execution: actionExecution.value,
    authorityPartition: turnAuthority.value.authorityPartition,
    proposal: {
      proposalId,
      caseId: caseId.value,
      basedOnRevision: inspected.value.revision,
      requestAuthority,
      action: parsed.value,
      authority: {
        kind: "commerce_system",
        system: commerceAuthority.value.commerceSystem.kind,
        revision: commerceAuthority.value.commerceSystem.revision,
        integrationAccountId: commerceAuthority.value.integrationAccountId,
      },
      provenance: current.value.projection.provenance,
      origin: {
        kind: "merchant_control",
        userId: authorized.authenticated.session.userId,
        controlSessionId: authorized.authenticated.session.controlSessionId,
      },
    },
    acceptedAt: now,
  });
  if (!caseProposal.ok)
    return controlError("commerce_action_case_proposal_rejected", 409);

  const proposed = await organisation.proposeAction({
    execution: actionExecution.value,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    requestAuthority,
    authorityPartition: turnAuthority.value.authorityPartition,
    authority: {
      kind: "commerce_system",
      system: commerceAuthority.value.commerceSystem.kind,
      revision: commerceAuthority.value.commerceSystem.revision,
    },
    caseId: caseId.value,
    proposalId,
    sessionId: sessionId.value,
    threadId: caseId.value,
    draft: draft.value,
    flowBinding: caseProposal.value.flowBinding,
    exp: now + 15 * 60_000,
    now,
  });
  if (!proposed.ok) return commerceActionLedgerError(proposed.error);
  const waiting = await caseActor.value.waitForCommerceApproval({
    execution: actionExecution.value,
    caseId: caseId.value,
    proposalId,
    actionNonce: proposed.value.action.nonce.value,
    expectedCaseRevision: caseProposal.value.revision,
    requestedAt: now,
  });
  if (!waiting.ok)
    return controlError("commerce_action_case_approval_wait_failed", 409);
  const responseBody = {
    ok: true,
    action: commerceActionRecord(proposed.value),
    case: {
      caseId: caseId.value,
      proposalId,
      revision: waiting.value.revision,
    },
    state: proposed.value.state,
    source_revision: expectedRevision,
    approval: { kind: "required" as const, next: "request_approval" as const },
  };
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

export async function proposePayoutAction(
  input: Readonly<{
    request: Request;
    env: Env;
    authorized: AuthorizedOrganisationRequest;
    organisation: DurableObjectStub<OrganisationDO>;
    identity: Readonly<{
      issuer: string;
      subject: string;
      userId: string;
    }>;
    scope: ControlMutationReceiptScope;
    boundary: UnversionedControlMutationBoundary;
    action: Variant<
      CommerceActionRequest,
      "submit_supplier_payout" | "resume_supplier_payout_funding"
    >;
    now: number;
  }>,
): Promise<Response> {
  const {
    request,
    env,
    authorized,
    organisation,
    identity,
    scope,
    boundary,
    action,
    now,
  } = input;
  const payout = await readSupplierPayout(
    authorized.executionScope.database,
    authorized.organisationId,
    action.payoutId,
  );
  if (payout === undefined)
    return controlError("supplier_payout_not_found", 404);
  if (
    payout.revision !== action.expectedPayoutRevision ||
    payout.approvalDigest !== action.approvalDigest
  ) {
    return controlError("supplier_payout_approval_stale", 409);
  }
  const plan = readSealedPayoutPlan(payout, authorized.organisationId);
  if (
    plan === null ||
    Date.parse(plan.seal.executionDeadline) <= now ||
    (plan.kind === "wise" && Date.parse(plan.rateExpiresAt) <= now)
  ) {
    return controlError("supplier_payout_plan_expired", 409);
  }
  if (action.kind === "submit_supplier_payout") {
    if (payout.stateKind !== "approved")
      return controlError("supplier_payout_not_approved", 409);
  } else {
    const attempt = await readSupplierPayoutAttempt(
      authorized.executionScope.database,
      authorized.organisationId,
      action.attemptId,
    );
    if (
      plan.kind !== "wise" ||
      payout.stateKind !== "provider_action_required" ||
      attempt === undefined ||
      attempt.payoutId !== payout.payoutId ||
      attempt.approvalDigest !== payout.approvalDigest ||
      attempt.requestIdentity !== plan.seal.idempotencyKey ||
      attempt.providerTransferId !== action.providerTransferId ||
      attempt.fundingOperationId !== null
    ) {
      return controlError("supplier_payout_funding_identity_mismatch", 409);
    }
  }
  const integrationAccountId = parseIntegrationAccountId(
    payout.integrationAccountId,
  );
  const sessionId = parseSessionId(
    authorized.authenticated.session.controlSessionId,
  );
  const digest = await commerceActionMutationDigest(boundary);
  const caseId = parseCaseId(`case_merchant_action_${digest}`);
  if (!integrationAccountId.ok || !sessionId.ok || !caseId.ok)
    return controlError("commerce_action_identity_invalid", 500);
  const proposalId = `proposal_merchant_action_${digest}`;
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (membershipRevision === null)
    return controlError("commerce_action_authority_unavailable", 503);
  const requestAuthority = buildControlAuthority({
    organisationId: authorized.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: identity.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  const modelRoute = await resolveOrganisationModelRoute({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  if (!modelRoute.ok)
    return controlError("commerce_action_authority_unavailable", 503);
  const loaded = await loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: authorized.executionScope.database, kv: env.POLICY_KV },
    organisationId: authorized.organisationId,
    now,
  });
  const turn = await prepareTurnAuthority({
    db: authorized.executionScope.database,
    accountAccess: authorized.executionScope.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: authorized.authenticated.session.controlSessionId },
    action: "execute",
    organisationId: authorized.organisationId,
    requestAuthority,
    policy: { version: loaded.snapshot.version },
  });
  if (!turn.ok) return controlError("commerce_action_forbidden", 403);
  const draft = await buildSupplierPayoutActionDraft(action);
  if (!draft.ok) return commerceActionErrorResponse(draft.error);
  const capability = controlCommerceActionCapability(
    integrationAccountId.value,
    draft.value.resourceKey,
  );
  const allowed = await authorizeCapabilityUse({
    db: authorized.executionScope.database,
    accountAccess: authorized.executionScope.accountAccess,
    userAuthority: { kind: "authenticated_session", nativeSessionId: authorized.authenticated.session.controlSessionId },
    action: "execute",
    organisationId: authorized.organisationId,
    authority: requestAuthority,
    authorityPartition: turn.value.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!allowed.ok) return controlError("commerce_action_forbidden", 403);
  const resolved = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: authorized.organisationId,
    caseId: caseId.value,
    now,
  });
  if (!resolved.ok)
    return controlError("commerce_action_case_unavailable", 503);
  const actor = resolved.value;
  const placed = await ensureCaseProject({
    scope: authorized.executionScope,
    caseId: caseId.value,
    origin: "commerce_approval",
    now,
  });
  if (!placed.ok) return controlError(placed.error.code, 409);
  const ensured = await actor.ensure({
    identity: { organisationId: authorized.organisationId, caseId: caseId.value },
    purpose: "supplier payout approval",
    workspaceRevision: `payout:${payout.payoutId}:${payout.revision}`,
    lifecycle: { kind: "open", openedAt: now },
  });
  if (!ensured.ok) return controlError("commerce_action_case_unavailable", 409);
  const bound = await attachMerchantActionDestination({
    env,
    execution: authorized.executionScope,
    membership: authorized.membership,
    caseId: caseId.value,
    caseActor: actor,
    mutationIdentity: newControlMutationIdentity({
      portalSubjectHash: await hashPortalSubject(
        identity.issuer,
        identity.subject,
      ),
      causationId: controlCausationId(request),
      now,
    }),
  });
  if (!bound.ok) return controlError(bound.error.code, 409);
  const inspected = await actor.inspect();
  if (!inspected.ok)
    return controlError("commerce_action_case_unavailable", 409);
  const actionExecution = await controlActionMutationExecution(
    env,
    authorized.organisationId,
    authorized.authenticated.session,
  );
  if (!actionExecution.ok) return controlError(actionExecution.error.code, 409);
  const accepted = await actor.acceptCommerceProposal({
    execution: actionExecution.value,
    authorityPartition: turn.value.authorityPartition,
    proposal: {
      proposalId,
      caseId: caseId.value,
      basedOnRevision: inspected.value.revision,
      requestAuthority,
      action,
      authority: {
        kind: "integration_account",
        integrationAccountId: integrationAccountId.value,
      },
      provenance: null,
      origin: {
        kind: "merchant_control",
        userId: identity.userId,
        controlSessionId: sessionId.value,
      },
    },
    acceptedAt: now,
  });
  if (!accepted.ok)
    return controlError("commerce_action_case_proposal_rejected", 409);

  const proposed = await organisation.proposeAction({
    execution: actionExecution.value,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    requestAuthority,
    authorityPartition: turn.value.authorityPartition,
    authority: { kind: "integration_account" },
    caseId: caseId.value,
    proposalId,
    sessionId: sessionId.value,
    threadId: caseId.value,
    draft: draft.value,
    flowBinding: accepted.value.flowBinding,
    exp: Math.min(now + 15 * 60_000, Date.parse(plan.seal.executionDeadline)),
    now,
  });
  if (!proposed.ok) return commerceActionLedgerError(proposed.error);
  const waiting = await actor.waitForCommerceApproval({
    execution: actionExecution.value,
    caseId: caseId.value,
    proposalId,
    actionNonce: proposed.value.action.nonce.value,
    expectedCaseRevision: accepted.value.revision,
    requestedAt: now,
  });
  if (!waiting.ok)
    return controlError("commerce_action_case_approval_wait_failed", 409);
  const responseBody = {
    ok: true,
    action: commerceActionRecord(proposed.value),
    case: {
      caseId: caseId.value,
      proposalId,
      revision: waiting.value.revision,
    },
    state: proposed.value.state,
    source_revision: payout.revision,
    approval: { kind: "required", next: "request_approval" },
  };
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

export async function attachMerchantActionDestination(input: {
  readonly env: Env;
  readonly execution: OrganisationExecutionScope;
  readonly membership: ActiveOrganisationMembership;
  readonly caseId: CaseId;
  readonly caseActor: DurableObjectStub<CaseDO>;
  readonly mutationIdentity: Readonly<{ auditEventId: string; receiptId: string }>;
}): Promise<
  Result<
    { readonly kind: "attached" | "already_attached" },
    { readonly code: string }
  >
> {
  const projection = await buildOnboardingProjection({
    db: input.execution.database,
    organisationId: input.execution.organisationId,
    membership: input.membership,
    now: Date.now(),
  });
  if (
    projection === null ||
    projection.operating_profile.kind !== "configured" ||
    projection.operating_profile.cue_target.kind !== "slack"
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_destination_unavailable" },
    };
  }
  const workspaceId = parseWorkspaceId(
    projection.operating_profile.cue_target.workspace_id,
  );
  const channelId = parseChannelId(
    projection.operating_profile.cue_target.channel_id,
  );
  if (!workspaceId.ok || !channelId.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_destination_invalid" },
    };
  }
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: input.env.SATYR_DEPLOYMENT_PROFILE,
    appId: input.env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_connector_unavailable" },
    };
  }
  const destination = {
    environment: installationIdentity.value.environment,
    appId: installationIdentity.value.appId,
    organisationId: input.execution.organisationId,
    workspaceId: workspaceId.value,
    channelId: channelId.value,
  };
  let connection = await resolveActiveSlackDestinationConnection(
    input.env,
    destination,
  );
  if (!connection.ok) {
    // A workspace that saved its setup before setup saves bound the channel
    // has no binding for it. The admin who sends binds it, as a setup save
    // would; a channel that another active connection holds stays refused.
    const bound = await bindUnboundSetupChannel(input.env, {
      ...destination,
      userId: input.membership.userId,
      changedAt: Date.now(),
    });
    if (bound.ok) {
      await prepareSlackRoutingAuditEvent(input.env.DB, {
        change: bound.value.change,
        revision: bound.value.channelDefault.revision,
        nextConnectionId: bound.value.channelDefault.connectionId,
        mutationIdentity: input.mutationIdentity,
      }).run();
      connection = await resolveActiveSlackDestinationConnection(
        input.env,
        destination,
      );
    }
  }
  if (!connection.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_connector_unavailable" },
    };
  }
  const connectorId = parseConnectorId(
    `connector_slack_${connection.value.integrationAccountId}`,
  );
  if (!connectorId.ok) {
    return { ok: false, error: { code: "commerce_action_connector_invalid" } };
  }
  const binding: CaseBinding = {
    bindingId: `binding_${input.caseId}`,
    caseId: input.caseId,
    connectorId: connectorId.value,
    address: {
      kind: "slack_channel",
      workspaceId: workspaceId.value,
      channelId: channelId.value,
    },
  };
  const attached = await input.caseActor.attachBinding(binding);
  return attached.ok
    ? { ok: true, value: { kind: attached.value.kind } }
    : { ok: false, error: { code: attached.error.code } };
}

export async function handleCommerceActionApproval(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  actionNonceRaw: string,
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
  if (!isActionNonce(actionNonceRaw))
    return controlError("commerce_action_not_found", 404);
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0)
    return controlError("commerce_action_approval_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  const now = Date.now();
  if (
    now - authorized.authenticated.session.createdAt >
    APPROVAL_STEP_UP_MAX_AGE_MS
  ) {
    return controlError("approval_step_up_required", 401);
  }
  const config = googleConfig(env);
  if (config === null) {
    return controlError("google_oidc_unconfigured", 503);
  }
  const grantRaw = parseCookies(request.headers.get("cookie")).get(
    APPROVAL_GRANT_COOKIE,
  );
  if (grantRaw === undefined) {
    return controlError("approval_step_up_required", 401);
  }
  const grant = await verifyGoogleApprovalGrant({
    raw: grantRaw,
    clientSecret: config.clientSecret,
    now,
  });
  if (
    !grant.ok ||
    grant.value.userId !== authorized.authenticated.session.userId ||
    grant.value.challenge.expiresAt <= now ||
    grant.value.challenge.issuedAt > now ||
    grant.value.challenge.organisationId !== authorized.organisationId ||
    grant.value.challenge.actionNonce !== actionNonceRaw
  ) {
    return controlError("approval_step_up_required", 401);
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  const existing = await organisation.getAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    now,
  });
  if (!existing.ok) return commerceActionLedgerError(existing.error);
  const actionDigest = await digestApprovalAction(existing.value.action);
  const payoutPath = parseCommerceActionPath(existing.value.action);
  if (
    payoutPath.ok &&
    (payoutPath.value.kind === "submit_supplier_payout" ||
      payoutPath.value.kind === "resume_supplier_payout_funding")
  ) {
    const payout = await readSupplierPayout(
      authorized.executionScope.database,
      authorized.organisationId,
      payoutPath.value.payoutId,
    );
    if (
      payout === undefined ||
      payout.revision !== payoutPath.value.expectedPayoutRevision ||
      payout.approvalDigest !== payoutPath.value.approvalDigest
    )
      return controlError("supplier_payout_approval_stale", 409);
    const destination = await readSupplierDestinationRevision(
      authorized.executionScope.database,
      authorized.organisationId,
      payout.destinationRevisionId,
    );
    if (
      destination === undefined ||
      destination.state !== "active" ||
      destination.proposedBy === identity.userId
    ) {
      return controlError("supplier_payout_approver_forbidden", 403);
    }
  }
  if (
    !approvalActionBindingMatches(
      grant.value.challenge,
      existing.value.action,
      actionDigest,
    )
  ) {
    return controlError("approval_step_up_required", 409);
  }
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/actions/${actionNonceRaw}/approval`,
    operation: "commerce.action.approval",
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
  const approval: ApprovalEvidence = {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: identity.userId,
      personId: authorized.membership.personId,
      role: requireApprovalControlRole(authorized.membership.role),
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: authorized.authenticated.session.controlSessionId,
      authenticatedAt: authorized.authenticated.session.createdAt,
      challenge: grant.value.challenge,
    },
  };
  if (
    existing.value.state === "proposed" ||
    existing.value.state === "approval_requested"
  ) {
    const consumed = await consumeGoogleApprovalCeremony({
      db: env.DB,
      stateHash: grant.value.stateHash,
      challenge: grant.value.challenge,
    });
    if (!consumed) return controlError("approval_step_up_required", 401);
    const actionExecution = await controlActionMutationExecution(
      env,
      authorized.organisationId,
      authorized.authenticated.session,
    );
    if (!actionExecution.ok)
      return controlError(actionExecution.error.code, 409);
    const requested = await organisation.requestActionApproval({
      execution: actionExecution.value,
      organisationId: authorized.organisationId,
      nonce: actionNonceRaw,
      now,
    });
    if (!requested.ok) return commerceActionLedgerError(requested.error);
  }
  const signed = await organisation.signAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    approval,
    now,
  });
  if (!signed.ok) return commerceActionLedgerError(signed.error);
  const caseActor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: authorized.organisationId,
    caseId: signed.value.caseId,
    now,
  });
  if (!caseActor.ok)
    return controlError("commerce_action_case_unavailable", 503);
  const resolved = await caseActor.value.syncCommerceApprovalWait({
    caseId: signed.value.caseId,
    actionNonce: actionNonceRaw,
  });
  if (!resolved.ok)
    return controlError("commerce_action_case_approval_resolution_failed", 409);
  const responseBody = {
    ok: true,
    action: commerceActionRecord(signed.value),
    state: signed.value.state,
    approval: {
      kind: approval.authentication.kind,
      authenticated_at: authorized.authenticated.session.createdAt,
    },
    case: { caseId: signed.value.caseId, revision: resolved.value.revision },
  };
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

export async function handleCommerceActionRejection(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  actionNonceRaw: string,
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
  if (!isActionNonce(actionNonceRaw))
    return controlError("commerce_action_not_found", 404);
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    Object.keys(body.value).length !== 1 ||
    body.value.reason !== "merchant_declined"
  ) {
    return controlError("commerce_action_rejection_invalid", 422);
  }
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
  const now = Date.now();
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  const existing = await organisation.getAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    now,
  });
  if (!existing.ok) return commerceActionLedgerError(existing.error);
  const actionDigest = await digestApprovalAction(existing.value.action);
  const rejection: MerchantActionRejectionEvidence =
    existing.value.state === "rejected"
      ? existing.value.rejection
      : {
          kind: "merchant_rejection",
          principal: {
            kind: "app_user",
            userId: identity.userId,
            personId: authorized.membership.personId,
            role: requireApprovalControlRole(authorized.membership.role),
          },
          authentication: {
            kind: "control_session",
            controlSessionId: authorized.authenticated.session.controlSessionId,
            authenticatedAt: now,
          },
          decision: {
            kind: "rejected",
            reason: "merchant_declined",
            action: {
              organisationId: authorized.organisationId,
              actionNonce: actionNonceRaw,
              actionDigest,
            },
          },
        };
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/actions/${actionNonceRaw}/rejection`,
    operation: "commerce.action.rejection",
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
  const rejected = await organisation.rejectAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    rejection,
    now,
  });
  if (!rejected.ok) return commerceActionLedgerError(rejected.error);
  if (rejected.value.state !== "rejected") {
    return commerceActionLedgerError({ code: "invalid_action_transition" });
  }
  const caseActor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: authorized.organisationId,
    caseId: rejected.value.caseId,
    now,
  });
  if (!caseActor.ok)
    return controlError("commerce_action_case_unavailable", 503);
  const resolved = await caseActor.value.syncCommerceApprovalWait({
    caseId: rejected.value.caseId,
    actionNonce: actionNonceRaw,
  });
  if (!resolved.ok)
    return controlError("commerce_action_case_approval_resolution_failed", 409);
  const caseOutcome = await acceptAndDeliverCommerceOutcome({
    kind: "merchant_rejection",
    env,
    entry: rejected.value,
    rejection,
    now,
  });
  if (!caseOutcome.ok) return controlError(caseOutcome.error.code, 503);
  if (caseOutcome.value.kind === "pending") {
    return controlJson(
      {
        ok: false,
        error: "commerce_case_delivery_pending",
        retry_at: caseOutcome.value.retryAt,
      },
      202,
    );
  }
  const responseBody = {
    ok: true,
    action: commerceActionRecord(rejected.value),
    state: rejected.value.state,
    decision: { kind: "rejected" as const, reason: rejection.decision.reason },
    case: {
      caseId: rejected.value.caseId,
      revision: caseOutcome.value.caseRevision,
    },
    case_output: caseOutcome.value,
  };
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

export function requireApprovalControlRole(
  role: ActiveOrganisationMembership["role"],
): "owner" | "admin" {
  switch (role) {
    case "owner":
    case "admin":
      return role;
    case "operator":
    case "viewer":
      throw new Error("approval role invariant failed");
    default:
      return assertNever(role);
  }
}

/**
 * The live preview on a plugin's approval card: the proposed checkout
 * functions over the merchant's recent checkouts, read again each time the
 * card opens. Only the members who may approve can run it, and only while
 * the action waits for a decision.
 */
export async function handleCommerceActionPluginPreview(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  actionNonceRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  if (!isActionNonce(actionNonceRaw))
    return controlError("commerce_action_not_found", 404);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    now: Date.now(),
  });
  if (!action.ok) return commerceActionLedgerError(action.error);
  if (
    action.value.state !== "proposed" &&
    action.value.state !== "approval_requested"
  )
    return controlError("commerce_action_not_awaiting_decision", 409);
  const preview = await previewMerchantPluginAction({
    env,
    scope: authorized.executionScope,
    action: action.value,
  });
  return preview.ok
    ? controlJson({ ok: true, preview: preview.value })
    : commerceProviderExecutionErrorResponse(preview.error);
}

export async function handleCommerceActionExecution(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  actionNonceRaw: string,
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
  if (!isActionNonce(actionNonceRaw))
    return controlError("commerce_action_not_found", 404);
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0)
    return controlError("commerce_action_execution_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/actions/${actionNonceRaw}/execute`,
    operation: "commerce.action.execute",
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
  const now = Date.now();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  const existing = await organisation.getAction({
    organisationId: authorized.organisationId,
    nonce: actionNonceRaw,
    now,
  });
  if (!existing.ok) return commerceActionLedgerError(existing.error);
  const preflightPath = parseCommerceActionPath(existing.value.action);
  if (
    preflightPath.ok &&
    (preflightPath.value.kind === "submit_supplier_payout" ||
      preflightPath.value.kind === "resume_supplier_payout_funding")
  ) {
    if (
      existing.value.state === "confirmed" ||
      existing.value.state === "failed"
    )
      return new Response(existing.value.providerResult, {
        status: existing.value.state === "confirmed" ? 200 : 409,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    // Money leaving the merchant is not a change to a commerce projection, so
    // none of the projection-shaped preflight applies. The payout's own store
    // is the authority: the revision the approval bound, the digest it was
    // approved against, and whether the rail is certified for this amount.
    const begun = await organisation.beginActionExecution({
      organisationId: authorized.organisationId,
      nonce: actionNonceRaw,
      now,
    });
    if (!begun.ok) return commerceActionLedgerError(begun.error);
    if (begun.value.state !== "executing") {
      return commerceActionLedgerError({ code: "invalid_action_transition" });
    }
    const response = await executeApprovedSupplierPayout({
      request,
      env,
      authorized,
      identity,
      scope,
      boundary: boundary.value,
      organisation,
      action: existing.value,
      actionNonce: actionNonceRaw,
      path: preflightPath.value,
      now,
    });
    const providerResult = await response.clone().text();
    const completed = await organisation.completeActionExecution({
      organisationId: authorized.organisationId,
      nonce: actionNonceRaw,
      now,
      executionLeaseId: begun.value.executionLease.leaseId,
      outcome: response.ok ? "confirmed" : "failed",
      providerResult,
    });
    return completed.ok ? response : commerceActionLedgerError(completed.error);
  }
  const executed = await executeCommerceAction({
    env,
    executionScope: authorized.executionScope,
    organisation,
    action: existing.value,
    actionNonce: actionNonceRaw,
    now,
  });
  if (!executed.ok) return commerceActionFailureResponse(executed.error);
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody: executed.value.body,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(executed.value.body);
}

/** The HTTP answer for a commerce action that did not finish. */
export function commerceActionFailureResponse(failure: CommerceActionFailure): Response {
  switch (failure.kind) {
    case "case_unavailable":
      return controlError("commerce_action_case_unavailable", 503);
    case "proposal_unavailable":
      return controlError("commerce_entity_plane_proposal_unavailable", 409);
    case "capability_inactive":
      return controlError("commerce_action_capability_inactive", 409);
    case "reconciliation_pending":
      return controlJson(
        {
          ok: false,
          error: "commerce_action_reconciliation_pending",
          action: failure.action,
        },
        202,
      );
    case "action":
      return commerceActionErrorResponse(failure.error);
    case "entity_plane":
      return commerceEntityPlaneExecutionErrorResponse(failure.error);
    case "projection":
      return commerceActionProjectionError(failure.code);
    case "provider":
      return commerceProviderExecutionErrorResponse(failure.error);
    case "ledger":
      return commerceActionLedgerError(failure.error);
  }
}

export function commerceActionErrorResponse(error: CommerceActionError): Response {
  switch (error.code) {
    case "commerce_action_invalid":
    case "commerce_action_path_invalid":
      return controlError(error.code, 422);
    case "commerce_action_projection_missing":
      return controlError(error.code, 404);
    case "commerce_action_projection_kind_mismatch":
    case "commerce_action_provider_unsupported":
      return controlError(error.code, 409);
    case "commerce_action_authority_rebase_required":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expectedRevision,
          actual: error.actualRevision,
        },
        409,
      );
    case "commerce_action_revision_stale":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        409,
      );
    case "commerce_action_event_invalid":
      return controlError(error.code, 422);
  }
}

export function commerceProviderExecutionErrorResponse(
  error: CommerceProviderExecutionError,
): Response {
  switch (error.code) {
    case "commerce_action_authority_superseded":
    case "commerce_action_capability_inactive":
    case "commerce_action_order_has_prepared_lines":
      return controlError(error.code, 409);
    case "commerce_action_flow_binding_invalid":
    case "commerce_action_flow_denied":
      return controlError(error.code, 403);
    case "commerce_action_provider_indeterminate":
      return controlError(error.code, 503);
    case "commerce_action_provider_execution_failed":
      return controlError(error.code, 502);
    default:
      return commerceActionErrorResponse(error);
  }
}

export function commerceEntityPlaneExecutionErrorResponse(error: {
  readonly code: string;
}): Response {
  switch (error.code) {
    case "commerce_entity_plane_authority_invalid":
    case "commerce_entity_plane_flow_binding_invalid":
    case "commerce_entity_plane_flow_denied":
      return controlError(error.code, 403);
    case "commerce_entity_plane_proposal_missing":
    case "commerce_entity_plane_proposal_conflict":
      return controlError(error.code, 409);
    case "commerce_entity_plane_binding_missing":
    case "commerce_entity_plane_underclerk_unavailable":
    case "commerce_entity_plane_command_invalid":
      return controlError(error.code, 503);
    case "commerce_entity_plane_command_rejected":
    case "commerce_entity_plane_receipt_invalid":
    case "commerce_entity_plane_action_failed":
      return controlError(error.code, 502);
    default:
      return controlError("commerce_entity_plane_execution_failed", 502);
  }
}

export function commerceActionProjectionError(code: string): Response {
  return controlError(code, code === "commerce_projection_corrupt" ? 500 : 409);
}
