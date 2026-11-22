import type { RequestAuthority } from "@purin-labs/contracts";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { AccessGrant, GrantSubject } from "./types";
import {
  encodeCapabilityKey,
  type CapabilityDefinition,
  type FileCapabilityDefinition,
} from "./capability-key";
import { assertNever } from "@purin-labs/std";

export type ImmutableCapabilityDefinition = CapabilityDefinition;

export type EffectiveCapability = Readonly<{
  readonly definition: ImmutableCapabilityDefinition;
  readonly grantIds: readonly string[];
  readonly grantRevisions: readonly number[];
}>;

export type EffectiveGrantSet = Readonly<{
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly selectedGrants: readonly AccessGrant[];
  readonly capabilities: readonly EffectiveCapability[];
}>;

export type CompileEffectiveGrantsInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly grants: readonly AccessGrant[];
  readonly organisationAllowedTools: readonly string[];
}>;

export type EffectiveGrantCompileError =
  | { readonly code: "grant_organisation_mismatch"; readonly grantId: string }
  | { readonly code: "authority_organisation_mismatch" }
  | { readonly code: "invalid_membership_revision" }
  | { readonly code: "invalid_grant_selection"; readonly grantId: string }
  | {
      readonly code: "invalid_capability_definition";
      readonly capabilityId: string;
    }
  | { readonly code: "commerce_context_organisation_mismatch" };

export type SelectActiveGrantsInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly grants: readonly AccessGrant[];
}>;

export function selectActiveGrants(
  input: SelectActiveGrantsInput,
): Result<readonly AccessGrant[], EffectiveGrantCompileError> {
  if (input.authority.organisationId !== input.organisationId) {
    return { ok: false, error: { code: "authority_organisation_mismatch" } };
  }
  if (!hasValidMembershipRevision(input.authority)) {
    return { ok: false, error: { code: "invalid_membership_revision" } };
  }

  const selected: AccessGrant[] = [];
  for (const grant of input.grants) {
    if (grant.organisationId !== input.organisationId) {
      return {
        ok: false,
        error: { code: "grant_organisation_mismatch", grantId: grant.grantId },
      };
    }
    if (
      grant.lifecycle.kind === "active" &&
      grantAppliesToAuthority(grant.subject, input.authority)
    ) {
      selected.push(grant);
    }
  }
  selected.sort(compareGrantIds);
  return { ok: true, value: selected };
}

export function compileEffectiveGrantSet(
  input: CompileEffectiveGrantsInput,
): Result<EffectiveGrantSet, EffectiveGrantCompileError> {
  const selected = selectActiveGrants(input);
  if (!selected.ok) return selected;
  return compileSelectedGrantSet({
    organisationId: input.organisationId,
    authority: input.authority,
    selectedGrants: selected.value,
    organisationAllowedTools: input.organisationAllowedTools,
  });
}

export type CompileSelectedGrantSetInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly selectedGrants: readonly AccessGrant[];
  readonly organisationAllowedTools: readonly string[];
}>;

export function compileSelectedGrantSet(
  input: CompileSelectedGrantSetInput,
): Result<EffectiveGrantSet, EffectiveGrantCompileError> {
  if (input.authority.organisationId !== input.organisationId) {
    return { ok: false, error: { code: "authority_organisation_mismatch" } };
  }
  if (!hasValidMembershipRevision(input.authority)) {
    return { ok: false, error: { code: "invalid_membership_revision" } };
  }

  for (const grant of input.selectedGrants) {
    const refused = selectedGrantError(
      grant,
      input.organisationId,
      input.authority,
    );
    if (refused !== null) return { ok: false, error: refused };
  }

  const allowedTools = new Set(input.organisationAllowedTools);
  const definitionsByKey = new Map<string, ImmutableCapabilityDefinition>();
  for (const grant of input.selectedGrants) {
    const definition = grant.target;
    if (
      definition.kind === "commerce_read" ||
      definition.kind === "commerce_command"
    ) {
      continue;
    }
    if (!isValidDefinition(definition)) {
      return {
        ok: false,
        error: {
          code: "invalid_capability_definition",
          capabilityId: definition.capabilityId,
        },
      };
    }
    const definitionKey = encodeCapabilityKey(definition);
    if (
      allowedTools.has(definition.capabilityId) &&
      !definitionsByKey.has(definitionKey)
    ) {
      definitionsByKey.set(definitionKey, definition);
    }
  }
  const definitions = [...definitionsByKey.values()];

  const capabilities: EffectiveCapability[] = [];
  for (const definition of definitions) {
    const matchingGrants: AccessGrant[] = [];
    for (const grant of input.selectedGrants) {
      if (
        (grant.target.kind === "platform_capability" ||
          grant.target.kind === "provider_resource" ||
          grant.target.kind === "file_resource" ||
          grant.target.kind === "custom_connector_operation") &&
        encodeCapabilityKey(grant.target) === encodeCapabilityKey(definition)
      ) {
        matchingGrants.push(grant);
      }
    }
    if (matchingGrants.length > 0) {
      matchingGrants.sort(compareGrantIds);
      const grantIds: string[] = [];
      const grantRevisions: number[] = [];
      for (const grant of matchingGrants) {
        if (grant.lifecycle.kind !== "active") {
          continue;
        }
        grantIds.push(grant.grantId);
        grantRevisions.push(grant.lifecycle.revision);
      }
      capabilities.push({ definition, grantIds, grantRevisions });
    }
  }

  capabilities.sort(compareEffectiveCapabilities);
  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      authority: input.authority,
      selectedGrants: [...input.selectedGrants],
      capabilities,
    },
  };
}

/**
 * Why a selected grant may not be compiled for an authority: it is of another
 * Organisation, it is not active, or its subject is not the authority.
 */
export function selectedGrantError(
  grant: AccessGrant,
  organisationId: OrganisationId,
  authority: RequestAuthority,
): EffectiveGrantCompileError | null {
  if (grant.organisationId !== organisationId) {
    return { code: "grant_organisation_mismatch", grantId: grant.grantId };
  }
  if (
    grant.lifecycle.kind !== "active" ||
    !grantAppliesToAuthority(grant.subject, authority)
  ) {
    return { code: "invalid_grant_selection", grantId: grant.grantId };
  }
  return null;
}

function grantAppliesToAuthority(
  subject: GrantSubject,
  authority: RequestAuthority,
): boolean {
  switch (authority.kind) {
    case "direct_conversation":
    case "control":
      return (
        subjectMatchesOrganisationRole(subject, authority.role) ||
        (subject.kind === "person" &&
          subject.personId === authority.requesterPersonId)
      );
    case "shared_conversation":
      return (
        subjectMatchesOrganisationRole(subject, authority.role) ||
        (subject.kind === "conversation" &&
          subject.integrationAccountId === authority.integrationAccountId &&
          subject.conversationId === authority.conversationId)
      );
    case "workflow":
      return (
        subject.kind === "workflow" &&
        subject.workflowKind === "cue_subscription" &&
        subject.workflowId === authority.workflowId &&
        subject.workflowRevision === authority.workflowRevision
      );
    case "agent_mailbox":
      return (
        subject.kind === "agent_mailbox" &&
        subject.integrationAccountId === authority.integrationAccountId &&
        subject.mailboxBindingId === authority.mailboxBindingId &&
        subject.bindingRevision === authority.bindingRevision
      );
    case "whatsapp_support":
      return (
        subject.kind === "whatsapp_support" &&
        subject.integrationAccountId === authority.integrationAccountId &&
        subject.supportBindingId === authority.supportBindingId &&
        subject.bindingRevision === authority.bindingRevision
      );
    default:
      return assertNever(authority, "unhandled request authority");
  }
}

function subjectMatchesOrganisationRole(
  subject: GrantSubject,
  role: string,
): boolean {
  return subject.kind === "organisation_role" && subject.role === role;
}

export function hasValidMembershipRevision(
  authority: RequestAuthority,
): boolean {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
    case "control":
      return (
        Number.isSafeInteger(authority.membershipRevision) &&
        authority.membershipRevision > 0
      );
    case "workflow":
      return true;
    case "agent_mailbox":
      return (
        Number.isSafeInteger(authority.bindingRevision) &&
        authority.bindingRevision > 0 &&
        Number.isSafeInteger(authority.mailboxPolicyVersion) &&
        authority.mailboxPolicyVersion > 0
      );
    case "whatsapp_support":
      return (
        Number.isSafeInteger(authority.bindingRevision) &&
        authority.bindingRevision > 0 &&
        Number.isSafeInteger(authority.ingressPolicyVersion) &&
        authority.ingressPolicyVersion > 0
      );
    default:
      return assertNever(authority, "unhandled request authority");
  }
}

function isValidDefinition(definition: ImmutableCapabilityDefinition): boolean {
  if (
    definition.capabilityId.trim().length === 0 ||
    definition.capabilityId.includes(":") ||
    !Number.isSafeInteger(definition.capabilityVersion) ||
    definition.capabilityVersion < 1
  ) {
    return false;
  }
  if (definition.kind === "provider_resource") {
    return (
      definition.integrationAccountId.trim().length > 0 &&
      !definition.integrationAccountId.includes(":") &&
      definition.resourceScope.trim().length > 0
    );
  }
  if (definition.kind === "file_resource") {
    return (
      definition.capabilityId === "file.read" &&
      definition.integrationAccountId.trim().length > 0 &&
      !definition.integrationAccountId.includes(":") &&
      fileScopeIsValid(definition.scope)
    );
  }
  if (definition.kind === "custom_connector_operation") {
    return (
      (definition.capabilityId === "custom_connector.read" ||
        definition.capabilityId === "custom_connector.write") &&
      definition.capabilityVersion === 1 &&
      definition.integrationAccountId.trim().length > 0 &&
      !definition.integrationAccountId.includes(":") &&
      definition.connectorId.trim().length > 0 &&
      !definition.connectorId.includes(":") &&
      Number.isSafeInteger(definition.definitionRevision) &&
      definition.definitionRevision > 0 &&
      /^[0-9a-f]{64}$/u.test(definition.definitionDigest) &&
      /^[a-z][a-z0-9_]{0,47}$/u.test(definition.operationId)
    );
  }
  return definition.kind === "platform_capability";
}

function fileScopeIsValid(scope: FileCapabilityDefinition["scope"]): boolean {
  switch (scope.kind) {
    case "dropbox_folder":
      return (
        scope.providerFolderId.trim().length > 0 &&
        scope.pathDisplay.trim().length > 0
      );
    case "dropbox_file":
      return (
        scope.providerFileId.trim().length > 0 &&
        scope.pathDisplay.trim().length > 0
      );
    case "gdrive_file":
      return (
        scope.providerFileId.trim().length > 0 && scope.name.trim().length > 0
      );
  }
}

function compareGrantIds(left: AccessGrant, right: AccessGrant): number {
  return left.grantId.localeCompare(right.grantId);
}

function compareEffectiveCapabilities(
  left: EffectiveCapability,
  right: EffectiveCapability,
): number {
  return encodeCapabilityKey(left.definition).localeCompare(
    encodeCapabilityKey(right.definition),
  );
}
