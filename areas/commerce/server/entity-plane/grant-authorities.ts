// The commerce authorities of the access grants (Refactor 17): a commerce
// read grant becomes the read authority of the graph reader, and a command
// grant matches a commerce command. The grant model of the foundation holds
// the grants (authorization/access-grants/compiler.ts); commerce owns what a
// commerce grant permits.
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceAuthorityContext,
  CommerceAuthorityScope,
  CommerceEntityAuthority,
  CommerceMutationTarget,
} from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  hasValidMembershipRevision,
  selectedGrantError,
  type EffectiveGrantCompileError,
} from "@purin-labs/authority/authorization/access-grants/compiler";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

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
    const refused = selectedGrantError(
      grant,
      input.organisationId,
      input.authority,
    );
    if (refused !== null) return { ok: false, error: refused };
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
