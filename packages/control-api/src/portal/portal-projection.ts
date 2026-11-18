import { isUserId, type CuePresetId } from "../index.ts";
import type {
  FirstOperationalTask,
  OnboardingActivation,
  OnboardingCredentialHealth,
  OnboardingEventRecency,
  OnboardingNextAction,
  OnboardingProvider,
  OnboardingSelectedResource,
  OnboardingStepProjection,
  OnboardingWebhookHealth,
  OrganisationOnboardingLifecycle,
} from "@seams/contracts";
import type {
  ApprovalAuthenticationReport,
  CapabilityProfile,
  ControlRole,
  IntegrationAccount,
  ReadinessAssessment,
  SetupSelection,
  OrganisationInvitation,
  OrganisationMember,
} from "./settings.ts";
import type { Variant } from "@seams/type-utils";
import {
  assertNever,
  exhaustiveList,
  isNonEmptyString,
  isRecord,
  isString,
} from "@seams/std";
import { parseOrganisationEnvironment } from "./organisation-environment.ts";
import type {
  IntegrationLifecycleKind,
  Membership,
  OrganisationSummary,
  OrganisationWorkspace,
  ReadinessBlocker,
  User,
} from "./portal-types.ts";

export function parseUser(raw: Record<string, unknown>): User {
  if (
    !isUserId(raw.userId) ||
    typeof raw.email !== "string" ||
    typeof raw.displayName !== "string"
  ) {
    throw new Error("User response is invalid.");
  }
  return { userId: raw.userId, email: raw.email, displayName: raw.displayName };
}

export function parseMemberships(
  raw: readonly unknown[],
): readonly Membership[] {
  return raw.map(parseMembership);
}

function parseMembership(raw: unknown): Membership {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    !isPortalHandle(raw.organisationHandle) ||
    !isControlRole(raw.role) ||
    !Array.isArray(raw.workspaces)
  ) {
    throw new Error("Organisation membership response is invalid.");
  }
  const workspaces = raw.workspaces.map(parseOrganisationWorkspace);
  const [first, ...rest] = workspaces;
  if (first === undefined)
    throw new Error("Organisation membership has no workspaces.");
  return {
    organisationId: raw.organisationId,
    organisationHandle: raw.organisationHandle,
    role: raw.role,
    workspaces: [first, ...rest],
  };
}

function parseOrganisationWorkspace(raw: unknown): OrganisationWorkspace {
  if (
    !isRecord(raw) ||
    typeof raw.workspaceId !== "string" ||
    !isPortalHandle(raw.workspaceHandle) ||
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    typeof raw.createdAt !== "number" ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0
  ) {
    throw new Error("Organisation workspace response is invalid.");
  }
  return {
    workspaceId: raw.workspaceId,
    workspaceHandle: raw.workspaceHandle,
    name: raw.name,
    createdAt: raw.createdAt,
  };
}

export function isPortalHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

export function parseProjectedOrganisationSummary(
  raw: Record<string, unknown>,
): OrganisationSummary {
  if (
    typeof raw.organisation_id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.plan !== "string" ||
    !isRecord(raw.lifecycle) ||
    !isCapabilityProfile(raw.capability_profile)
  ) {
    throw new Error("Onboarding projection organisation is invalid.");
  }
  const lifecycle = parseProjectedOrganisationLifecycle(
    raw.lifecycle,
    raw.organisation_id,
  );
  return {
    organisationId: raw.organisation_id,
    name: raw.name,
    plan: raw.plan,
    lifecycle: lifecycle.kind,
    environment: lifecycle.environment,
    capabilityProfile: raw.capability_profile,
  };
}

export function parseProjectedIntegrationAccount(
  raw: unknown,
): IntegrationAccount {
  if (
    !isRecord(raw) ||
    typeof raw.integration_account_id !== "string" ||
    !isOnboardingProvider(raw.provider) ||
    typeof raw.provider_account_id !== "string" ||
    parseOrganisationEnvironment(raw.environment) === null ||
    typeof raw.account_kind !== "string" ||
    typeof raw.display_name !== "string" ||
    typeof raw.is_default_for_provider !== "boolean" ||
    !isRecord(raw.lifecycle) ||
    !Array.isArray(raw.capabilities) ||
    !raw.capabilities.every(isString) ||
    !Array.isArray(raw.scopes) ||
    !raw.scopes.every(isString) ||
    !Array.isArray(raw.selected_resources) ||
    !raw.selected_resources.every(isProjectedSelectedResource) ||
    !isProjectedCredentialHealth(raw.credential_health) ||
    !isProjectedWebhookHealth(raw.webhook_health) ||
    !isProjectedEventRecency(raw.event_recency)
  ) {
    throw new Error("Onboarding projection provider account is invalid.");
  }
  const lifecycle = parseProjectedAccountLifecycle(raw.lifecycle);
  const environment = parseOrganisationEnvironment(raw.environment);
  if (environment === null) {
    throw new Error("Onboarding projection provider environment is invalid.");
  }
  return {
    integrationAccountId: raw.integration_account_id,
    provider: raw.provider,
    environment,
    providerAccountId: raw.provider_account_id,
    accountKind: raw.account_kind,
    displayName: raw.display_name,
    lifecycle,
    isDefaultForProvider: raw.is_default_for_provider,
    capabilities: raw.capabilities,
    scopes: raw.scopes,
    selectedResources: raw.selected_resources,
    credentialHealth: raw.credential_health,
    webhookHealth: raw.webhook_health,
    eventRecency: raw.event_recency,
  };
}

const ONBOARDING_PROVIDERS = exhaustiveList<OnboardingProvider>()([
  "slack",
  "shopify",
  "square",
  "stripe",
  "discord",
  "google_drive",
  "dropbox",
  "airtable",
  "notion",
  "gmail",
  "whatsapp",
  "gmo_aozora",
  "wise",
]);

function isOnboardingProvider(value: unknown): value is OnboardingProvider {
  return ONBOARDING_PROVIDERS.some((provider) => provider === value);
}

function isProjectedSelectedResource(
  raw: unknown,
): raw is OnboardingSelectedResource {
  return (
    isRecord(raw) &&
    typeof raw.resource_kind === "string" &&
    typeof raw.canonical_resource_id === "string" &&
    typeof raw.display_label === "string"
  );
}

function isProjectedCredentialHealth(
  raw: unknown,
): raw is OnboardingCredentialHealth {
  return (
    isRecord(raw) &&
    (raw.kind === "healthy" ||
      raw.kind === "degraded" ||
      raw.kind === "missing")
  );
}

function isProjectedWebhookHealth(
  raw: unknown,
): raw is OnboardingWebhookHealth {
  return (
    isRecord(raw) &&
    (raw.kind === "healthy" ||
      raw.kind === "degraded" ||
      raw.kind === "missing" ||
      raw.kind === "disabled")
  );
}

function isProjectedEventRecency(raw: unknown): raw is OnboardingEventRecency {
  if (!isRecord(raw)) {
    return false;
  }
  if (raw.kind === "unavailable") {
    return true;
  }
  return raw.kind === "available" && typeof raw.at === "number";
}

function parseProjectedOrganisationLifecycle(
  raw: Record<string, unknown>,
  organisationId: string,
): OrganisationOnboardingLifecycle {
  const environment = parseOrganisationEnvironment(raw.environment);
  if (raw.organisation_id !== organisationId || environment === null) {
    throw new Error("Onboarding projection lifecycle identity is invalid.");
  }
  switch (raw.kind) {
    case "configuring":
      if (typeof raw.configuration_version !== "number") {
        throw new Error("Configuring onboarding lifecycle is invalid.");
      }
      return {
        kind: raw.kind,
        organisation_id: organisationId,
        configuration_version: raw.configuration_version,
        environment,
      };
    case "activating":
      if (
        typeof raw.activation_attempt_id !== "string" ||
        typeof raw.readiness_version !== "number"
      ) {
        throw new Error("Activating onboarding lifecycle is invalid.");
      }
      return {
        kind: raw.kind,
        organisation_id: organisationId,
        activation_attempt_id: raw.activation_attempt_id,
        readiness_version: raw.readiness_version,
        environment,
      };
    case "active":
      if (
        typeof raw.activation_receipt_id !== "string" ||
        typeof raw.activated_at !== "number"
      ) {
        throw new Error("Active onboarding lifecycle is invalid.");
      }
      return {
        kind: raw.kind,
        organisation_id: organisationId,
        activation_receipt_id: raw.activation_receipt_id,
        activated_at: raw.activated_at,
        environment,
      };
    case "archived":
      if (
        typeof raw.archived_at !== "number" ||
        typeof raw.purge_after !== "number"
      ) {
        throw new Error("Archived onboarding lifecycle is invalid.");
      }
      return {
        kind: raw.kind,
        organisation_id: organisationId,
        archived_at: raw.archived_at,
        purge_after: raw.purge_after,
        environment,
      };
    default:
      throw new Error("Onboarding projection lifecycle is invalid.");
  }
}

function parseProjectedAccountLifecycle(
  raw: Record<string, unknown>,
): IntegrationAccount["lifecycle"] {
  if (!isIntegrationLifecycleKind(raw.kind)) {
    throw new Error("Onboarding projection provider lifecycle is invalid.");
  }
  switch (raw.kind) {
    case "connecting":
    case "pending_activation":
    case "active":
      return { kind: raw.kind };
    case "degraded":
    case "reauth_required":
      if (typeof raw.reason_code !== "string") {
        throw new Error(
          "Onboarding projection provider repair state is invalid.",
        );
      }
      return { kind: raw.kind, reasonCode: raw.reason_code };
    case "disabled":
      if (
        typeof raw.disabled_by_user_id !== "string" ||
        typeof raw.disabled_at !== "number"
      ) {
        throw new Error(
          "Onboarding projection disabled provider state is invalid.",
        );
      }
      return { kind: raw.kind };
    case "revoked":
      if (typeof raw.revoked_at !== "number") {
        throw new Error(
          "Onboarding projection revoked provider state is invalid.",
        );
      }
      return { kind: raw.kind };
    default:
      return assertNever(raw.kind, "Unexpected portal state");
  }
}

export function parseOrganisationMember(raw: unknown): OrganisationMember {
  if (
    !isRecord(raw) ||
    raw.kind !== "active" ||
    typeof raw.userId !== "string" ||
    typeof raw.personId !== "string" ||
    !isControlRole(raw.role) ||
    typeof raw.email !== "string" ||
    typeof raw.displayName !== "string" ||
    typeof raw.createdAt !== "number"
  ) {
    throw new Error("Organisation member response is invalid.");
  }
  return {
    kind: "active",
    userId: raw.userId,
    personId: raw.personId,
    role: raw.role,
    email: raw.email,
    displayName: raw.displayName,
    createdAt: raw.createdAt,
  };
}

export function parseOrganisationInvitation(
  raw: unknown,
): OrganisationInvitation {
  if (
    !isRecord(raw) ||
    raw.kind !== "pending" ||
    !isNonEmptyString(raw.organisationInvitationId) ||
    !isNonEmptyString(raw.invitedEmail) ||
    !isAssignableControlRole(raw.role) ||
    typeof raw.createdAt !== "number" ||
    typeof raw.expiresAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    !Number.isFinite(raw.expiresAt)
  ) {
    throw new Error("Organisation invitation response is invalid.");
  }
  return {
    kind: "pending",
    organisationInvitationId: raw.organisationInvitationId,
    invitedEmail: raw.invitedEmail,
    role: raw.role,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };
}

function isIntegrationLifecycleKind(
  raw: unknown,
): raw is IntegrationLifecycleKind {
  return (
    raw === "connecting" ||
    raw === "pending_activation" ||
    raw === "active" ||
    raw === "degraded" ||
    raw === "reauth_required" ||
    raw === "disabled" ||
    raw === "revoked"
  );
}

export function parseReadiness(
  raw: Record<string, unknown>,
): ReadinessAssessment {
  if (
    raw.kind === "ready" &&
    typeof raw.readinessVersion === "number" &&
    typeof raw.readinessHash === "string"
  ) {
    return {
      kind: "ready",
      readinessVersion: raw.readinessVersion,
      readinessHash: raw.readinessHash,
      approvalAuthentication: parseApprovalAuthenticationReports(
        raw.approvalAuthentication,
      ),
    };
  }
  if (raw.kind === "blocked" && Array.isArray(raw.blockers)) {
    return {
      kind: "blocked",
      blockers: raw.blockers.map(parseBlocker),
      approvalAuthentication: parseApprovalAuthenticationReports(
        raw.approvalAuthentication,
      ),
    };
  }
  throw new Error("Readiness response is invalid.");
}

function parseApprovalAuthenticationReports(
  raw: unknown,
): readonly ApprovalAuthenticationReport[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const reports: ApprovalAuthenticationReport[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const actionClass = record.action_class ?? record.actionClass;
    if (
      typeof actionClass !== "string" ||
      typeof record.branch !== "string" ||
      typeof record.ready !== "boolean"
    ) {
      continue;
    }
    reports.push({
      actionClass,
      branch: record.branch,
      ready: record.ready,
      reason: typeof record.reason === "string" ? record.reason : null,
    });
  }
  return reports;
}

export function parseProjectedReadiness(
  raw: Record<string, unknown>,
): ReadinessAssessment {
  if (
    raw.kind === "ready" &&
    typeof raw.readiness_version === "number" &&
    typeof raw.readiness_hash === "string"
  ) {
    return {
      kind: "ready",
      readinessVersion: raw.readiness_version,
      readinessHash: raw.readiness_hash,
      approvalAuthentication: parseApprovalAuthenticationReports(
        raw.approval_authentication,
      ),
    };
  }
  if (raw.kind === "blocked" && Array.isArray(raw.blockers)) {
    return {
      kind: "blocked",
      blockers: raw.blockers.map(parseProjectedBlocker),
      approvalAuthentication: parseApprovalAuthenticationReports(
        raw.approval_authentication,
      ),
    };
  }
  throw new Error("Onboarding projection readiness is invalid.");
}

export function parseProjectedSteps(
  raw: unknown,
): readonly OnboardingStepProjection[] {
  if (!Array.isArray(raw)) {
    throw new Error("Onboarding projection steps are invalid.");
  }
  return raw.map(parseProjectedStep);
}

function parseProjectedStep(raw: unknown): OnboardingStepProjection {
  if (!isRecord(raw) || typeof raw.step !== "string") {
    throw new Error("Onboarding projection step is invalid.");
  }
  const step = parseStepName(raw.step);
  switch (raw.kind) {
    case "unavailable":
      return typeof raw.reason_code === "string"
        ? { kind: raw.kind, step, reason_code: raw.reason_code }
        : invalidProjectionStep();
    case "available":
      return typeof raw.action === "string"
        ? { kind: raw.kind, step, action: parseActionCode(raw.action) }
        : invalidProjectionStep();
    case "in_progress":
      return typeof raw.attempt_id === "string" &&
        typeof raw.started_at === "number"
        ? {
            kind: raw.kind,
            step,
            attempt_id: raw.attempt_id,
            started_at: raw.started_at,
          }
        : invalidProjectionStep();
    case "action_required":
      return typeof raw.reason_code === "string" &&
        typeof raw.action === "string"
        ? {
            kind: raw.kind,
            step,
            reason_code: raw.reason_code,
            action: parseActionCode(raw.action),
          }
        : invalidProjectionStep();
    case "complete":
      return typeof raw.completed_at === "number" &&
        typeof raw.receipt_id === "string"
        ? {
            kind: raw.kind,
            step,
            completed_at: raw.completed_at,
            receipt_id: raw.receipt_id,
          }
        : invalidProjectionStep();
    default:
      return invalidProjectionStep();
  }
}

function invalidProjectionStep(): never {
  throw new Error("Onboarding projection step state is invalid.");
}

export function parseProjectedActivation(
  raw: Record<string, unknown>,
): OnboardingActivation {
  switch (raw.kind) {
    case "idle":
      return typeof raw.organisation_id === "string"
        ? { kind: raw.kind, organisation_id: raw.organisation_id }
        : invalidProjectionActivation();
    case "running":
      return typeof raw.activation_attempt_id === "string" &&
        typeof raw.phase === "string" &&
        typeof raw.started_at === "number"
        ? {
            kind: raw.kind,
            activation_attempt_id: raw.activation_attempt_id,
            phase: parseActivationPhase(raw.phase),
            started_at: raw.started_at,
          }
        : invalidProjectionActivation();
    case "succeeded":
      return typeof raw.activation_attempt_id === "string" &&
        typeof raw.activation_receipt_id === "string" &&
        typeof raw.activated_at === "number"
        ? {
            kind: raw.kind,
            activation_attempt_id: raw.activation_attempt_id,
            activation_receipt_id: raw.activation_receipt_id,
            activated_at: raw.activated_at,
          }
        : invalidProjectionActivation();
    case "failed_retryable":
      return typeof raw.activation_attempt_id === "string" &&
        typeof raw.phase === "string" &&
        typeof raw.reason_code === "string" &&
        typeof raw.retry_after_ms === "number"
        ? {
            kind: raw.kind,
            activation_attempt_id: raw.activation_attempt_id,
            phase: parseActivationPhase(raw.phase),
            reason_code: raw.reason_code,
            retry_after_ms: raw.retry_after_ms,
          }
        : invalidProjectionActivation();
    case "failed_terminal":
      return typeof raw.activation_attempt_id === "string" &&
        typeof raw.phase === "string" &&
        typeof raw.reason_code === "string"
        ? {
            kind: raw.kind,
            activation_attempt_id: raw.activation_attempt_id,
            phase: parseActivationPhase(raw.phase),
            reason_code: raw.reason_code,
          }
        : invalidProjectionActivation();
    default:
      return invalidProjectionActivation();
  }
}

function invalidProjectionActivation(): never {
  throw new Error("Onboarding projection activation is invalid.");
}

export function parseProjectedNextAction(
  raw: Record<string, unknown>,
): OnboardingNextAction {
  switch (raw.kind) {
    case "wait":
      return typeof raw.action_code === "string" &&
        typeof raw.label === "string" &&
        typeof raw.retry_after_ms === "number"
        ? {
            kind: raw.kind,
            action_code: parseActionCode(raw.action_code),
            label: raw.label,
            retry_after_ms: raw.retry_after_ms,
          }
        : invalidProjectionNextAction();
    case "done":
      return typeof raw.action_code === "string" &&
        typeof raw.label === "string"
        ? {
            kind: raw.kind,
            action_code: parseActionCode(raw.action_code),
            label: raw.label,
          }
        : invalidProjectionNextAction();
    case "perform":
      if (
        typeof raw.action_code !== "string" ||
        typeof raw.label !== "string" ||
        typeof raw.route !== "string" ||
        typeof raw.presentation !== "string" ||
        typeof raw.retry_safety !== "string"
      ) {
        return invalidProjectionNextAction();
      }
      return {
        kind: raw.kind,
        action_code: parseActionCode(raw.action_code),
        label: raw.label,
        route: raw.route,
        presentation: parsePresentation(raw.presentation),
        retry_safety: parseRetrySafety(raw.retry_safety),
      };
    case "repair":
      if (
        typeof raw.action_code !== "string" ||
        typeof raw.label !== "string" ||
        typeof raw.route !== "string" ||
        typeof raw.presentation !== "string" ||
        typeof raw.retry_safety !== "string" ||
        typeof raw.reason_code !== "string"
      ) {
        return invalidProjectionNextAction();
      }
      return {
        kind: raw.kind,
        action_code: parseActionCode(raw.action_code),
        label: raw.label,
        route: raw.route,
        presentation: parsePresentation(raw.presentation),
        retry_safety: parseRetrySafety(raw.retry_safety),
        reason_code: raw.reason_code,
      };
    default:
      return invalidProjectionNextAction();
  }
}

function invalidProjectionNextAction(): never {
  throw new Error("Onboarding projection next action is invalid.");
}

export function parseProjectedFirstTask(
  raw: unknown,
): FirstOperationalTask | null {
  if (raw === null) {
    return null;
  }
  if (
    !isRecord(raw) ||
    typeof raw.kind !== "string" ||
    typeof raw.organisation_id !== "string"
  ) {
    throw new Error("Onboarding projection first task is invalid.");
  }
  if (
    raw.kind !== "observe_recent_commerce" ||
    typeof raw.destination_id !== "string" ||
    typeof raw.commerce_system_revision !== "number" ||
    !Number.isSafeInteger(raw.commerce_system_revision) ||
    raw.commerce_system_revision < 1
  ) {
    return invalidProjectionFirstTask();
  }
  return {
    kind: raw.kind,
    organisation_id: raw.organisation_id,
    commerce_system_revision: raw.commerce_system_revision,
    destination_id: raw.destination_id,
  };
}

function invalidProjectionFirstTask(): never {
  throw new Error("Onboarding projection first task is invalid.");
}

function parseStepName(raw: string): OnboardingStepProjection["step"] {
  switch (raw) {
    case "workspace":
    case "inference":
    case "commerce":
    case "conversations":
    case "operating_profile":
    case "review_activation":
      return raw;
    default:
      throw new Error("Onboarding projection step name is invalid.");
  }
}

function parseActionCode(raw: string): OnboardingNextAction["action_code"] {
  switch (raw) {
    case "connect_slack":
    case "choose_inference":
    case "connect_commerce":
    case "save_operating_profile":
    case "activate_organisation":
    case "retry_activation":
    case "restore_organisation":
    case "onboarding_complete":
      return raw;
    default:
      throw new Error("Onboarding projection action code is invalid.");
  }
}

function parseActivationPhase(
  raw: string,
): Variant<OnboardingActivation, "running">["phase"] {
  switch (raw) {
    case "validating":
    case "assigning_runtime":
    case "publishing_policy":
    case "publishing_cues":
    case "enabling_connections":
    case "finalizing":
      return raw;
    default:
      throw new Error("Onboarding projection activation phase is invalid.");
  }
}

function parsePresentation(raw: string): "same_page" | "popup" {
  if (raw === "same_page" || raw === "popup") {
    return raw;
  }
  throw new Error("Onboarding projection presentation is invalid.");
}

function parseRetrySafety(raw: string): "safe" | "requires_confirmation" {
  if (raw === "safe" || raw === "requires_confirmation") {
    return raw;
  }
  throw new Error("Onboarding projection retry safety is invalid.");
}

function parseBlocker(raw: unknown): ReadinessBlocker {
  if (!isRecord(raw) || typeof raw.code !== "string") {
    throw new Error("Readiness blocker is invalid.");
  }
  return {
    code: raw.code,
    integrationAccountId:
      typeof raw.integrationAccountId === "string"
        ? raw.integrationAccountId
        : null,
  };
}

function parseProjectedBlocker(raw: unknown): ReadinessBlocker {
  if (!isRecord(raw) || typeof raw.code !== "string") {
    throw new Error("Onboarding projection readiness blocker is invalid.");
  }
  return {
    code: raw.code,
    integrationAccountId:
      typeof raw.integration_account_id === "string"
        ? raw.integration_account_id
        : null,
  };
}

export function parseProjectedOperatingProfile(
  raw: unknown,
  capabilityProfile: CapabilityProfile,
): SetupSelection | null {
  if (isRecord(raw) && raw.kind === "unconfigured") {
    return null;
  }
  if (
    !isRecord(raw) ||
    raw.kind !== "configured" ||
    raw.policy_template_id !== "commerce_operator" ||
    raw.capability_profile !== capabilityProfile ||
    !isCuePresetId(raw.cue_preset_id) ||
    !isRecord(raw.cue_target)
  ) {
    throw new Error("Onboarding projection operating profile is invalid.");
  }
  if (
    raw.cue_target.kind !== "slack" ||
    typeof raw.cue_target.workspace_id !== "string" ||
    typeof raw.cue_target.channel_id !== "string"
  ) {
    throw new Error(
      "Active operating profile is missing its Slack destination.",
    );
  }
  return {
    policyTemplateId: raw.policy_template_id,
    capabilityProfile,
    cuePresetId: raw.cue_preset_id,
    cueTarget: {
      workspaceId: raw.cue_target.workspace_id,
      channelId: raw.cue_target.channel_id,
    },
  };
}

function isControlRole(raw: unknown): raw is ControlRole {
  return (
    raw === "owner" || raw === "admin" || raw === "operator" || raw === "viewer"
  );
}

function isAssignableControlRole(
  raw: unknown,
): raw is Exclude<ControlRole, "owner"> {
  return raw === "admin" || raw === "operator" || raw === "viewer";
}

function isCapabilityProfile(raw: unknown): raw is CapabilityProfile {
  return raw === "read_and_propose" || raw === "approved_provider_writes";
}

function isCuePresetId(raw: unknown): raw is CuePresetId {
  return (
    raw === "observe_commerce" ||
    raw === "commerce_operator" ||
    raw === "proactive_triage"
  );
}
