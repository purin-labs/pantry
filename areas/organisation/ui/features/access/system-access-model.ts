import type { AccessControlAvailability } from "@purin-labs/control-api";

import {
  providerLabel,
  providerPresentation,
} from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import type {
  AccessControlCapabilityView,
  AccessControlGrantView,
  AccessControlSubjectView,
  AccessControlView,
} from "@purin-labs/control-api/portal/access-models";

/**
 * The strongest thing a recipient can do in one system, derived from its
 * active grants and the current mode of each granted action. The level is a
 * reading aid only: the grants stay the unit that is created and revoked.
 */
export type AccessLevel =
  "change" | "change_with_approval" | "prepare" | "view" | "paused";

export type SystemRecipient = Readonly<{
  subject: AccessControlSubjectView;
  level: AccessLevel;
  grants: readonly AccessControlGrantView[];
}>;

type AccessSystemKind = "integration" | "commerce" | "workspace";

export type AccessSystem = Readonly<{
  key: string;
  kind: AccessSystemKind;
  label: string;
  detail: string;
  provider: string | null;
  availability: AccessControlAvailability;
  recipients: readonly SystemRecipient[];
  revokedGrants: readonly AccessControlGrantView[];
  /** Labels of this system's actions that need an approval for each use. */
  approvalActions: readonly string[];
}>;

export type SystemFilter = "all" | "not_shared" | "can_change";

type SystemDraft = {
  key: string;
  kind: AccessSystemKind;
  label: string;
  provider: string | null;
  availability: AccessControlAvailability;
  scopes: Set<string>;
  recipients: Map<
    string,
    { subject: AccessControlSubjectView; grants: AccessControlGrantView[] }
  >;
  revokedGrants: AccessControlGrantView[];
};

const COMMERCE_KEY = "commerce";
const WORKSPACE_KEY = "workspace";

/**
 * Groups every loaded grant under the system it reaches. A connected account
 * that an action can use is listed also when nobody has a grant on it, so a
 * system that is connected but closed is visible.
 */
export function buildAccessSystems(
  view: AccessControlView,
): readonly AccessSystem[] {
  const drafts = new Map<string, SystemDraft>();
  const accounts = new Map<
    string,
    AccessControlView["integrationResources"][number]
  >();
  const providers = actionProviders(view.capabilities);
  for (const account of view.integrationResources) {
    accounts.set(account.integrationAccountId, account);
    if (!providers.has(account.provider)) continue;
    drafts.set(
      integrationKey(account.integrationAccountId),
      integrationDraft(account),
    );
  }
  for (const grant of view.grants.items) {
    const draft = draftForGrant(drafts, accounts, grant);
    if (grant.resource.kind !== "platform")
      draft.scopes.add(grant.resource.label);
    if (grant.lifecycle.kind !== "active") {
      draft.revokedGrants.push(grant);
      continue;
    }
    const recipient = draft.recipients.get(grant.subject.subjectRefId);
    if (recipient === undefined) {
      draft.recipients.set(grant.subject.subjectRefId, {
        subject: grant.subject,
        grants: [grant],
      });
    } else {
      recipient.grants.push(grant);
    }
  }
  const modes = capabilityModes(view.capabilities);
  const systems: AccessSystem[] = [];
  for (const draft of drafts.values())
    systems.push(finishSystem(draft, modes, view.capabilities));
  return systems.sort(compareSystems);
}

export function levelLabel(level: AccessLevel): string {
  switch (level) {
    case "change":
      return "Can change";
    case "change_with_approval":
      return "Can change, asks first";
    case "prepare":
      return "Can prepare changes";
    case "view":
      return "Can view";
    case "paused":
      return "Paused";
  }
}

function recipientsWhoCanChange(system: AccessSystem): number {
  let count = 0;
  for (const recipient of system.recipients) {
    if (
      recipient.level === "change" ||
      recipient.level === "change_with_approval"
    )
      count += 1;
  }
  return count;
}

export function matchesSystem(
  terms: readonly string[],
  filter: SystemFilter,
  system: AccessSystem,
): boolean {
  if (filter === "not_shared" && system.recipients.length > 0) return false;
  if (filter === "can_change" && recipientsWhoCanChange(system) === 0)
    return false;
  if (terms.length === 0) return true;
  const text = systemSearchText(system);
  for (const term of terms) {
    if (!text.includes(term)) return false;
  }
  return true;
}

/** The actions an operator can grant for one system, in catalogue order. */
export function capabilityBelongsToSystem(
  system: Pick<AccessSystem, "kind" | "provider">,
  capability: AccessControlCapabilityView,
): boolean {
  const dependency = capability.definition.providerDependency;
  switch (system.kind) {
    case "integration":
      if (system.provider === null) return false;
      if (dependency.kind === "provider")
        return includesName(dependency.providers, system.provider);
      return (
        dependency.kind === "commerce_system" &&
        includesName(dependency.systems, system.provider)
      );
    case "commerce":
      return dependency.kind === "commerce_system";
    case "workspace":
      return (
        dependency.kind === "none" &&
        capability.definition.target === "platform"
      );
  }
}

/** The search text that narrows the action list to one system's actions. */
export function systemActionSearch(
  system: Pick<AccessSystem, "kind" | "provider">,
): string {
  switch (system.kind) {
    case "integration":
      return system.provider === null ||
        providerPresentation(system.provider) === null
        ? ""
        : providerLabel(system.provider);
    case "commerce":
      return "commerce";
    case "workspace":
      return "Purin Pantry";
  }
}

function integrationKey(integrationAccountId: string): string {
  return `integration:${integrationAccountId}`;
}

function integrationDraft(
  account: AccessControlView["integrationResources"][number],
): SystemDraft {
  return {
    key: integrationKey(account.integrationAccountId),
    kind: "integration",
    label: account.displayName,
    provider: account.provider,
    availability: account.availability,
    scopes: new Set(),
    recipients: new Map(),
    revokedGrants: [],
  };
}

function draftForGrant(
  drafts: Map<string, SystemDraft>,
  accounts: ReadonlyMap<
    string,
    AccessControlView["integrationResources"][number]
  >,
  grant: AccessControlGrantView,
): SystemDraft {
  const accountId = grant.resource.integrationAccountId;
  const key =
    accountId !== null
      ? integrationKey(accountId)
      : grant.resource.kind === "platform"
        ? WORKSPACE_KEY
        : grant.resource.kind === "commerce_scope"
          ? COMMERCE_KEY
          : grant.resource.targetRefId;
  const existing = drafts.get(key);
  if (existing !== undefined) return existing;
  const account = accountId === null ? undefined : accounts.get(accountId);
  const draft: SystemDraft =
    account !== undefined
      ? integrationDraft(account)
      : {
          key,
          kind:
            key === WORKSPACE_KEY
              ? "workspace"
              : key === COMMERCE_KEY
                ? "commerce"
                : "integration",
          label:
            key === WORKSPACE_KEY
              ? "Purin Pantry workspace"
              : key === COMMERCE_KEY
                ? "Commerce records"
                : grant.resource.label,
          provider: null,
          availability: "available",
          scopes: new Set(),
          recipients: new Map(),
          revokedGrants: [],
        };
  drafts.set(key, draft);
  return draft;
}

function finishSystem(
  draft: SystemDraft,
  modes: ReadonlyMap<string, AccessControlCapabilityView["mode"]>,
  capabilities: readonly AccessControlCapabilityView[],
): AccessSystem {
  const recipients: SystemRecipient[] = [];
  for (const recipient of draft.recipients.values()) {
    recipients.push({
      subject: recipient.subject,
      level: recipientLevel(recipient.grants, modes),
      grants: recipient.grants,
    });
  }
  const approvalActions: string[] = [];
  for (const capability of capabilities) {
    if (
      capability.mode === "approval_required" &&
      capability.availability !== "unavailable" &&
      capabilityBelongsToSystem(draft, capability)
    )
      approvalActions.push(capability.definition.label);
  }
  return {
    key: draft.key,
    kind: draft.kind,
    label: draft.label,
    detail: systemDetail(draft),
    provider: draft.provider,
    availability: draft.availability,
    recipients,
    revokedGrants: draft.revokedGrants,
    approvalActions,
  };
}

/** The exact scopes that are shared; a closed account shows its provider. */
function systemDetail(draft: SystemDraft): string {
  const scopes = Array.from(draft.scopes);
  if (scopes.length > 0) {
    const shown = scopes.slice(0, 2).join(", ");
    return scopes.length > 2 ? `${shown} and ${scopes.length - 2} more` : shown;
  }
  switch (draft.kind) {
    case "integration":
      return draft.provider === null ? "" : providerLabel(draft.provider);
    case "commerce":
      return "";
    case "workspace":
      return "Built in";
  }
}

function recipientLevel(
  grants: readonly AccessControlGrantView[],
  modes: ReadonlyMap<string, AccessControlCapabilityView["mode"]>,
): AccessLevel {
  let level: AccessLevel = "paused";
  for (const grant of grants) {
    const mode =
      modes.get(
        capabilityKey(
          grant.capability.capabilityId,
          grant.capability.capabilityVersion,
        ),
      ) ?? "enabled";
    if (mode === "disabled") continue;
    const granted = grantLevel(grant.capability.risk, mode);
    if (LEVEL_RANK[granted] > LEVEL_RANK[level]) level = granted;
  }
  return level;
}

const LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  paused: 0,
  view: 1,
  prepare: 2,
  change_with_approval: 3,
  change: 4,
};

function grantLevel(
  risk: AccessControlGrantView["capability"]["risk"],
  mode: Exclude<AccessControlCapabilityView["mode"], "disabled">,
): AccessLevel {
  switch (risk) {
    case "read":
      return "view";
    case "propose":
      return "prepare";
    case "external_effect":
      return mode === "approval_required" ? "change_with_approval" : "change";
  }
}

function capabilityModes(
  capabilities: readonly AccessControlCapabilityView[],
): ReadonlyMap<string, AccessControlCapabilityView["mode"]> {
  const modes = new Map<string, AccessControlCapabilityView["mode"]>();
  for (const capability of capabilities) {
    modes.set(
      capabilityKey(
        capability.definition.capabilityId,
        capability.definition.capabilityVersion,
      ),
      capability.mode,
    );
  }
  return modes;
}

function capabilityKey(
  capabilityId: string,
  capabilityVersion: number,
): string {
  return `${capabilityId}@${capabilityVersion}`;
}

function actionProviders(
  capabilities: readonly AccessControlCapabilityView[],
): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const capability of capabilities) {
    const dependency = capability.definition.providerDependency;
    if (dependency.kind !== "provider") continue;
    for (const provider of dependency.providers) providers.add(provider);
  }
  return providers;
}

function includesName(names: readonly string[], name: string): boolean {
  for (const entry of names) {
    if (entry === name) return true;
  }
  return false;
}

const KIND_RANK: Readonly<Record<AccessSystemKind, number>> = {
  integration: 0,
  commerce: 1,
  workspace: 2,
};

function compareSystems(left: AccessSystem, right: AccessSystem): number {
  return KIND_RANK[left.kind] - KIND_RANK[right.kind];
}

function systemSearchText(system: AccessSystem): string {
  const parts: string[] = [system.label, system.detail];
  for (const recipient of system.recipients) {
    parts.push(recipient.subject.label, levelLabel(recipient.level));
    for (const grant of recipient.grants)
      parts.push(grant.capability.label, grant.resource.label);
  }
  for (const grant of system.revokedGrants)
    parts.push(grant.subject.label, grant.capability.label);
  return parts.join(" ").toLowerCase();
}
