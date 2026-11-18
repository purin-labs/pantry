import type {
  CommerceAuthorityContext,
  CommerceAuthorityScope,
  CommerceEntityAuthority,
  CommerceMutationTarget,
  RequestAuthority,
} from "@seams/contracts";

import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { AccessGrant, GrantSubject } from "./types";
import {
  encodeCapabilityKey,
  type CapabilityDefinition,
  type FileCapabilityDefinition,
  type PlatformCapabilityDefinition,
  type ProviderCapabilityDefinition,
} from "./capability-key";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type ImmutableCapabilityDefinition = CapabilityDefinition;
export type PlatformCapability = PlatformCapabilityDefinition;
export type ProviderCapability = ProviderCapabilityDefinition;
export type FileCapability = FileCapabilityDefinition;

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

export type CompileCommerceReadAuthoritiesInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly selectedGrants: readonly AccessGrant[];
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly context: CommerceAuthorityContext;
}>;

export type CompiledCommerceReadAuthority = Readonly<{
  readonly grantId: string;
  readonly grantRevision: number;
  readonly authority: Variant<CommerceEntityAuthority, "entity_read">;
}>;

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
    if (grant.organisationId !== input.organisationId) {
      return {
        ok: false,
        error: { code: "grant_organisation_mismatch", grantId: grant.grantId },
      };
    }
    if (
      grant.lifecycle.kind !== "active" ||
      !grantAppliesToAuthority(grant.subject, input.authority)
    ) {
      return {
        ok: false,
        error: { code: "invalid_grant_selection", grantId: grant.grantId },
      };
    }
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
 * Turns an explicit commerce read grant into the narrow authority consumed by
 * CommerceGraphReader. Responsibility scopes never enter this compiler.
 */
export function compileCommerceReadAuthorities(
  input: CompileCommerceReadAuthoritiesInput,
): Result<
  readonly CompiledCommerceReadAuthority[],
  EffectiveGrantCompileError
> {
  if (
    input.authority.organisationId !== input.organisationId ||
    input.context.organisationId !== input.organisationId
  ) {
    return {
      ok: false,
      error: { code: "commerce_context_organisation_mismatch" },
    };
  }
  if (!hasValidMembershipRevision(input.authority)) {
    return { ok: false, error: { code: "invalid_membership_revision" } };
  }
  if (
    input.capabilityId.trim().length === 0 ||
    !Number.isSafeInteger(input.capabilityVersion) ||
    input.capabilityVersion < 1
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_capability_definition",
        capabilityId: input.capabilityId,
      },
    };
  }

  const authorities: CompiledCommerceReadAuthority[] = [];
  for (const grant of input.selectedGrants) {
    if (grant.organisationId !== input.organisationId) {
      return {
        ok: false,
        error: { code: "grant_organisation_mismatch", grantId: grant.grantId },
      };
    }
    if (
      grant.lifecycle.kind !== "active" ||
      !grantAppliesToAuthority(grant.subject, input.authority)
    ) {
      return {
        ok: false,
        error: { code: "invalid_grant_selection", grantId: grant.grantId },
      };
    }
    if (grant.target.kind !== "commerce_read") continue;
    if (
      grant.target.capabilityId !== input.capabilityId ||
      grant.target.capabilityVersion !== input.capabilityVersion
    ) {
      continue;
    }
    authorities.push({
      grantId: grant.grantId,
      grantRevision: grant.lifecycle.revision,
      authority: {
        kind: "entity_read",
        context: input.context,
        scope: grant.target.scope,
      },
    });
  }
  return { ok: true, value: authorities };
}

export type CommerceCommandGrantMatchInput = Readonly<{
  readonly grant: AccessGrant;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly authority: CommerceEntityAuthority;
}>;

/** Matches command grants by capability, scope, resource class, and revision. */
export function commerceCommandGrantMatches(
  input: CommerceCommandGrantMatchInput,
): boolean {
  const target = input.grant.target;
  if (
    target.kind !== "commerce_command" ||
    target.capabilityId !== input.capabilityId ||
    target.capabilityVersion !== input.capabilityVersion ||
    input.grant.lifecycle.kind !== "active" ||
    !sameCommerceValue(target.scope, input.authority.scope)
  ) {
    return false;
  }
  return commandTargetMatches(target.target, input.authority);
}

/** Matches a command grant against the exact mutation target built at execution time. */
export function commerceCommandGrantMatchesTarget(
  input: Readonly<{
    readonly grant: AccessGrant;
    readonly capabilityId: string;
    readonly capabilityVersion: number;
    readonly scope: CommerceAuthorityScope;
    readonly target: CommerceMutationTarget;
  }>,
): boolean {
  const grantTarget = input.grant.target;
  return (
    grantTarget.kind === "commerce_command" &&
    grantTarget.capabilityId === input.capabilityId &&
    grantTarget.capabilityVersion === input.capabilityVersion &&
    input.grant.lifecycle.kind === "active" &&
    sameCommerceValue(grantTarget.scope, input.scope) &&
    sameCommerceValue(grantTarget.target, input.target)
  );
}

function commandTargetMatches(
  target: CommerceMutationTarget,
  authority: CommerceEntityAuthority,
): boolean {
  switch (authority.kind) {
    case "entity_read":
      return false;
    case "entity_command":
      return (
        target.kind === "custom_entity" &&
        target.revision === authority.target.expectedRevision &&
        sameCommerceValue(target.entityRef, authority.target.entityRef)
      );
    case "entity_create":
      return (
        target.kind === "custom_entity" &&
        target.entityRef.entityId === authority.target.entityId &&
        target.entityRef.typeId === authority.target.typeId
      );
    case "custom_entity_type_create":
      return (
        target.kind === "custom_entity_type" &&
        target.typeId === authority.target.typeId
      );
    case "custom_entity_type_publish":
      return (
        target.kind === "custom_entity_type" &&
        target.revision === authority.target.revision &&
        target.typeId === authority.target.typeId
      );
    case "relationship_command":
      return (
        target.kind === "custom_relationship" &&
        sameCommerceValue(target.relationship, authority.target.relationship)
      );
    case "relationship_create":
      return (
        target.kind === "custom_relationship" &&
        target.relationship.relationshipId ===
          authority.target.relationshipId &&
        sameCommerceValue(
          target.relationship.definition,
          authority.target.definition,
        )
      );
    case "relationship_replacement":
      return (
        target.kind === "custom_relationship" &&
        sameCommerceValue(target.relationship, authority.target.relationship)
      );
    case "custom_relationship_definition_create":
      return (
        target.kind === "custom_relationship_definition" &&
        target.definitionId === authority.target.definitionId
      );
    case "custom_relationship_definition_publish":
      return (
        target.kind === "custom_relationship_definition" &&
        target.revision === authority.target.revision &&
        target.definitionId === authority.target.definitionId
      );
    case "system_entity_extension_schema_create":
      return (
        target.kind === "system_entity_extension_schema" &&
        target.entityTypeId === authority.target.entityTypeId
      );
    case "system_entity_extension_schema_publish":
      return (
        target.kind === "system_entity_extension_schema" &&
        target.revision === authority.target.revision &&
        target.entityTypeId === authority.target.entityTypeId
      );
    case "commerce_list_command":
      return (
        target.kind === "commerce_list" &&
        target.revision === authority.target.expectedRevision &&
        target.listId === authority.target.listId
      );
    case "commerce_list_create":
      return (
        target.kind === "commerce_list" &&
        target.listId === authority.target.listId
      );
    case "commerce_list_entry_command":
      return (
        target.kind === "commerce_list_entry" &&
        target.revision === authority.target.expectedRevision &&
        sameCommerceValue(target.entry, authority.target.entry)
      );
    case "commerce_list_entry_create":
      return (
        target.kind === "commerce_list_entry" &&
        sameCommerceValue(target.entry, authority.target.entry)
      );
    case "saved_view_administration":
      return (
        target.kind === "saved_commerce_view" &&
        target.revision === authority.target.expectedRevision &&
        target.viewId === authority.target.viewId
      );
    case "saved_view_create":
      return (
        target.kind === "saved_commerce_view" &&
        target.viewId === authority.target.viewId
      );
    default:
      return assertNever(authority, "unhandled request authority");
  }
}

function sameCommerceValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameCommerceValue(value, right[index]))
    );
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return (
        rightEntry !== undefined &&
        key === rightEntry[0] &&
        sameCommerceValue(value, rightEntry[1])
      );
    })
  );
}

export function grantAppliesToAuthority(
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

function hasValidMembershipRevision(authority: RequestAuthority): boolean {
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
