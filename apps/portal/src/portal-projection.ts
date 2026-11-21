import { ControlApiError } from "./control-client";
import type { CapabilityProfile, ControlRole, IntegrationAccount, ReadinessAssessment, SetupSelection } from "@purin-labs/control-api/portal/settings";
import type { SetupFormDefaults } from "./features/integrations/settings-types";
import type { Membership, OrganisationWorkspace, ReadinessBlocker } from "@purin-labs/control-api/portal/portal-types";
import { isPortalHandle } from "@purin-labs/control-api/portal/portal-projection";

const LAST_USED_WORKSPACE_STORAGE_PREFIX = "pantry.portal.last-used-workspace:";

export function isConfigurationConflict(error: unknown): boolean {
  return (
    error instanceof ControlApiError && error.kind === "configuration_conflict"
  );
}

export function selectPreferredWorkspace(
  workspaces: readonly [OrganisationWorkspace, ...OrganisationWorkspace[]],
  previouslyUsedWorkspaceHandle: string | null,
): OrganisationWorkspace {
  if (previouslyUsedWorkspaceHandle === null) {
    return workspaces[0];
  }
  return (
    workspaces.find(findWorkspaceByHandle(previouslyUsedWorkspaceHandle)) ??
    workspaces[0]
  );
}

export function readLastUsedWorkspaceHandle(
  organisationHandle: string,
): string | null {
  try {
    const stored = window.localStorage.getItem(
      lastUsedWorkspaceStorageKey(organisationHandle),
    );
    return isPortalHandle(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function rememberLastUsedWorkspace(
  organisationHandle: string,
  workspaceHandle: string,
): void {
  try {
    window.localStorage.setItem(
      lastUsedWorkspaceStorageKey(organisationHandle),
      workspaceHandle,
    );
  } catch {
    return;
  }
}

function lastUsedWorkspaceStorageKey(organisationHandle: string): string {
  return `${LAST_USED_WORKSPACE_STORAGE_PREFIX}${organisationHandle}`;
}

function connectedSlackAccounts(
  accounts: readonly IntegrationAccount[],
): readonly IntegrationAccount[] {
  const connected: IntegrationAccount[] = [];
  for (const account of accounts) {
    if (isConnectedSlackAccount(account)) {
      connected.push(account);
    }
  }
  return connected;
}

function isConnectedSlackAccount(account: IntegrationAccount): boolean {
  return (
    account.provider === "slack" &&
    account.lifecycle.kind !== "disabled" &&
    account.lifecycle.kind !== "revoked"
  );
}

export function setupFormDefaults(
  capabilityProfile: CapabilityProfile,
  selection: SetupSelection | null,
  accounts: readonly IntegrationAccount[],
): SetupFormDefaults {
  const slackAccounts = connectedSlackAccounts(accounts);
  const workspaceId =
    selection?.cueTarget?.workspaceId ??
    slackAccounts[0]?.providerAccountId ??
    "";
  const channelId = selection?.cueTarget?.channelId ?? "";
  const selectedCapabilityProfile =
    selection?.capabilityProfile ?? capabilityProfile;
  const cuePresetId = selection?.cuePresetId ?? "commerce_operator";
  return {
    key: [selectedCapabilityProfile, cuePresetId, workspaceId, channelId].join(
      ":",
    ),
    capabilityProfile: selectedCapabilityProfile,
    cuePresetId,
    workspaceId,
    channelId,
  };
}

export function findMembershipByOrganisationHandle(
  organisationHandle: string,
): (membership: Membership) => boolean {
  return function membershipMatches(membership: Membership): boolean {
    return membership.organisationHandle === organisationHandle;
  };
}

export function findWorkspaceByHandle(
  workspaceHandle: string,
): (workspace: OrganisationWorkspace) => boolean {
  return function workspaceMatches(workspace: OrganisationWorkspace): boolean {
    return workspace.workspaceHandle === workspaceHandle;
  };
}

export function canManageOrganisation(role: ControlRole): boolean {
  return role === "owner" || role === "admin";
}

/** The role whose payout reads an owner or admin may allow in place. */
export function payoutReadRole(role: ControlRole): "owner" | "admin" | null {
  return role === "owner" || role === "admin" ? role : null;
}

export function canOperateCommerce(role: ControlRole): boolean {
  return role === "owner" || role === "admin" || role === "operator";
}

export function portalError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Pantry could not complete this request.";
}

export function formatLifecycle(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    draft: "Draft",
    configuring: "Configuring",
    activating: "Activating",
    active: "Active",
    suspended: "Suspended",
    archived: "Archived",
    ready: "Ready",
    blocked: "Blocked",
    degraded: "Needs attention",
    reauth_required: "Reconnect required",
    activation_failed: "Activation failed",
    pending: "Pending",
    invited: "Invited",
    revoked: "Revoked",
    disabled: "Disabled",
    installed: "Installed",
  };
  return labels[value] ?? "Unknown status";
}

export function needsReadinessEvaluation(
  readiness: ReadinessAssessment | null,
): boolean {
  if (readiness === null) {
    return true;
  }
  return (
    readiness.kind === "blocked" &&
    readiness.blockers.some(isNotEvaluatedBlocker)
  );
}

function isNotEvaluatedBlocker(blocker: ReadinessBlocker): boolean {
  return blocker.code === "readiness_not_evaluated";
}
