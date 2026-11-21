import { timestampNanoseconds } from "@purin-labs/commerce-contracts/commerce-timestamp";
import { isSystemCommerceEntity } from "@purin-labs/commerce-contracts";
import type {
  CommerceCommandAuthorityContext,
  CommerceAuthorityScope,
  AttributeValueAssignment,
  CommerceEntity,
  CommerceEntityAuthority,
  CommerceEntityPlaneError,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceFilter,
  CommerceFreshness,
  CommerceGraphQuery,
  CommerceSensitivity,
  PantryCommerceReadAuthority,
  CommerceListEntryRef,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import { commerceBlotterSystemAttributeIds } from "../../actors/commerce-query-schema";
import { sameRelationshipDefinitionRef } from "@purin-labs/commerce-contracts/commerce-relationship-references";
import {
  parseCommerceCommandId,
  parseCommerceMerchantId,
  parseCommercePrincipalId,
  parseCommerceTimestamp,
  parsePublishedCommerceSelectorId,
  parsePublishedCommerceSelectorRevision,
} from "@purin-labs/commerce-client";
import type { Result } from "../../result";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  isCommerceSensitivity,
  sensitivityAtMost,
} from "../contract/sensitivity";

export type CommerceGraphReadAuthority = PantryCommerceReadAuthority;

type CommerceGraphAuthorityError = CommerceEntityPlaneError;

export function buildCommerceListEntryCommandAuthority(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    expiresAt: string;
    commandId: string;
    entry: CommerceListEntryRef;
  }>,
): Result<
  Variant<CommerceEntityAuthority, "commerce_list_entry_command">,
  CommerceGraphAuthorityError
> {
  try {
    return {
      ok: true,
      value: {
        kind: "commerce_list_entry_command",
        context: commandAuthorityContext(input),
        scope: { kind: "commerce_list_entry", entry: input.entry },
        target: { entry: input.entry, expectedRevision: input.entry.revision },
      },
    };
  } catch (error) {
    return authorityParseFailure(error);
  }
}

export function buildSavedViewAdministrationAuthority(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    expiresAt: string;
    commandId: string;
    viewId: SavedCommerceViewId;
    expectedRevision: SavedCommerceViewRevision;
  }>,
): Result<
  Variant<CommerceEntityAuthority, "saved_view_administration">,
  CommerceGraphAuthorityError
> {
  try {
    return {
      ok: true,
      value: {
        kind: "saved_view_administration",
        context: commandAuthorityContext(input),
        scope: { kind: "saved_view", viewId: input.viewId },
        target: {
          viewId: input.viewId,
          expectedRevision: input.expectedRevision,
        },
      },
    };
  } catch (error) {
    return authorityParseFailure(error);
  }
}

function commandAuthorityContext(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    expiresAt: string;
    commandId: string;
  }>,
): CommerceCommandAuthorityContext {
  return {
    organisationId: input.organisationId,
    merchantId: parseCommerceMerchantId(input.merchantId),
    principalId: parseCommercePrincipalId(input.principalId),
    sensitivityCeiling: "restricted",
    expiresAt: parseCommerceTimestamp(input.expiresAt),
    causation: {
      kind: "command",
      commandId: parseCommerceCommandId(input.commandId),
    },
  };
}

function authorityParseFailure(error: unknown): {
  ok: false;
  error: CommerceGraphAuthorityError;
} {
  return {
    ok: false,
    error: {
      code: "parse",
      reason: error instanceof Error ? error.message : String(error),
    },
  };
}

export function buildSavedSelectorCommerceReadAuthority(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    sensitivityCeiling: CommerceSensitivity;
    expiresAt: string;
    commandId: string;
    selectorId: string;
    selectorRevision: number;
    query: CommerceGraphQuery;
  }>,
): Result<CommerceGraphReadAuthority, CommerceGraphAuthorityError> {
  try {
    if (input.query.kind === "commerce_context") {
      throw new TypeError("A saved selector cannot contain a context request");
    }
    return {
      ok: true,
      value: {
        context: {
          organisationId: input.organisationId,
          merchantId: parseCommerceMerchantId(input.merchantId),
          principalId: parseCommercePrincipalId(input.principalId),
          sensitivityCeiling: input.sensitivityCeiling,
          expiresAt: parseCommerceTimestamp(input.expiresAt),
          causation: {
            kind: "command",
            commandId: parseCommerceCommandId(input.commandId),
          },
        },
        scope: {
          kind: "saved_selector",
          selector: {
            selectorId: parsePublishedCommerceSelectorId(input.selectorId),
            revision: parsePublishedCommerceSelectorRevision(
              input.selectorRevision,
            ),
            query: input.query,
          },
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "parse",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Checks the Pantry-minted read authority before a source adapter is touched.
 * Source adapters receive only the already validated authority context.
 */
export function enforceCommerceGraphReadAuthority(
  input: Readonly<{
    organisationId: string;
    query: CommerceGraphQuery;
    authority: CommerceGraphReadAuthority;
    now: string;
  }>,
): Result<CommerceGraphReadAuthority, CommerceGraphAuthorityError> {
  const context = input.authority.context;
  if (context.organisationId !== input.organisationId) {
    return denied("authority_out_of_scope");
  }
  const expiresAt = timestampNanoseconds(context.expiresAt);
  const now = timestampNanoseconds(input.now);
  if (expiresAt === null || now === null || expiresAt <= now) {
    return denied("authority_expired");
  }
  if (!scopeAllowsQuery(input.authority.scope, input.query)) {
    return denied("authority_out_of_scope");
  }
  if (
    input.query.kind === "commerce_context" &&
    !sensitivityAtMost(
      input.query.allowedSensitivity,
      context.sensitivityCeiling,
    )
  ) {
    return denied("sensitivity_denied");
  }
  if (
    input.query.kind === "aggregation" &&
    context.sensitivityCeiling !== "restricted" &&
    aggregationNeedsRestrictedCeiling(input.query)
  ) {
    return denied("sensitivity_denied");
  }
  return { ok: true, value: input.authority };
}

/**
 * Whether an aggregation may only be read under a restricted ceiling.
 *
 * The blanket rule existed because a result count cannot be filtered after
 * the fact the way entities and attribute values can: filterCommerceGraphSensitivity
 * has nothing to redact in a number. That reasoning holds wherever the count
 * could be larger than the population the same authority may enumerate — but
 * not for a plain count of system records over platform-declared attributes,
 * where the count is exactly the size of the page this authority may already
 * read row by row. Refusing that told a scheduled brief it could not know how
 * many orders were open while letting it list them.
 *
 * Everything else stays restricted, and anything unrecognised fails closed.
 */
function aggregationNeedsRestrictedCeiling(
  query: Variant<CommerceGraphQuery, "aggregation">,
): boolean {
  // A sum, a minimum, a grouped count: these report attribute VALUES, not a
  // population size, so they can carry what the ceiling hides.
  if (query.aggregation.kind !== "count") return true;
  // List entries carry their own attribute values and sensitivities.
  if (query.source.kind !== "entity_type") return true;
  // Custom entities carry a sensitivity of their own, so a count of them can
  // include rows this authority would not be shown.
  if (query.source.entityTypeId.origin !== "system") return true;
  return !filterUsesDeclaredSystemAttributesOnly(
    query.filter,
    query.source.entityTypeId.typeId,
  );
}

/**
 * Whether a filter narrows only by attributes the platform itself declares.
 *
 * A merchant's own extension attribute on a system type carries a sensitivity
 * this function cannot see, and counting by one would let a caller learn its
 * values a predicate at a time. Only the platform's own attributes — whose
 * sensitivity is fixed and no higher than internal — are safe to count by.
 */
function filterUsesDeclaredSystemAttributesOnly(
  filter: CommerceFilter,
  entityType: SystemCommerceEntityKind,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "any":
      return filter.filters.every((inner) =>
        filterUsesDeclaredSystemAttributesOnly(inner, entityType),
      );
    case "not":
      return filterUsesDeclaredSystemAttributesOnly(filter.filter, entityType);
    case "attribute":
      return commerceBlotterSystemAttributeIds(entityType).includes(
        String(filter.filter.attributeId),
      );
    // A relationship predicate reaches records of another type, and free text
    // matches whatever the search index holds; neither is bounded here.
    case "relationship":
    case "search":
      return false;
    default:
      return false;
  }
}

export function filterCommerceGraphSensitivity(
  result: import("@purin-labs/commerce-contracts").CommerceGraphQueryResult,
  authority: CommerceGraphReadAuthority,
  allowedAttributeIds?: readonly string[],
): import("@purin-labs/commerce-contracts").CommerceGraphQueryResult {
  const ceiling = authority.context.sensitivityCeiling;
  const allowed =
    allowedAttributeIds === undefined ? null : new Set(allowedAttributeIds);
  const visibleEntityKeys = new Set<string>();
  const entities = result.entities.flatMap((entity) => {
    if (!entitySensitivityVisible(entity, ceiling)) return [];
    visibleEntityKeys.add(entityKey(entity.reference));
    const attributes = entity.attributes.filter((assignment) => {
      if (allowed !== null && !allowed.has(assignment.attributeId))
        return false;
      return (
        assignmentBelongsToEntity(assignment, entity.reference) &&
        sensitivityAtMost(assignment.sensitivity, ceiling)
      );
    });
    return [{ ...entity, attributes }];
  });
  const relationships = result.relationships.filter((relationship) => {
    const sensitivity = relationshipSensitivity(relationship);
    return (
      sensitivity !== null &&
      sensitivityAtMost(sensitivity, ceiling) &&
      visibleEntityKeys.has(entityKey(relationship.source)) &&
      visibleEntityKeys.has(entityKey(relationship.target))
    );
  });
  const listEntries = result.listEntries.flatMap((entry) => {
    if (!visibleEntityKeys.has(entityKey(entry.entityRef))) return [];
    const attributeValues = entry.attributeValues.filter((assignment) => {
      if (allowed !== null && !allowed.has(assignment.attributeId))
        return false;
      return (
        assignmentBelongsToEntity(assignment, entry.entityRef) &&
        sensitivityAtMost(assignment.sensitivity, ceiling)
      );
    });
    return [{ ...entry, attributeValues }];
  });
  const visibleProvenance = new Set(entities.flatMap(entityProvenanceKeys));
  const visibleFreshness = new Set(entities.flatMap(entityFreshnessKeys));
  return {
    ...result,
    entities,
    relationships,
    listEntries,
    provenance: result.provenance.filter((entry) =>
      visibleProvenance.has(provenanceKey(entry)),
    ),
    freshness: result.freshness.filter((entry) =>
      visibleFreshness.has(freshnessKey(entry)),
    ),
  };
}

function entitySensitivityVisible(
  entity: CommerceEntity,
  ceiling: CommerceSensitivity,
): boolean {
  if (!("sensitivity" in entity)) return true;
  return (
    isCommerceSensitivity(entity.sensitivity) &&
    sensitivityAtMost(entity.sensitivity, ceiling)
  );
}

function entityKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function relationshipSensitivity(
  relationship: import("@purin-labs/commerce-contracts").CommerceRelationship,
): CommerceSensitivity | null {
  if (relationship.origin === "custom") {
    return relationship.definition.origin === "custom"
      ? relationship.sensitivity
      : null;
  }
  if (relationship.definition.origin !== "system") return null;
  const endpoints = systemRelationshipEndpoints(
    relationship.definition.definitionId,
  );
  if (
    endpoints === null ||
    relationship.source.origin !== "system" ||
    relationship.target.origin !== "system"
  ) {
    return null;
  }
  return relationship.source.typeId === endpoints.source &&
    relationship.target.typeId === endpoints.target
    ? relationship.sensitivity
    : null;
}

function assignmentBelongsToEntity(
  assignment: AttributeValueAssignment,
  reference: CommerceEntityRef,
): boolean {
  switch (assignment.scope.kind) {
    case "system":
    case "merchant_extension":
      return (
        reference.origin === "system" &&
        assignment.scope.entityTypeId === reference.typeId
      );
    case "custom":
      return (
        reference.origin === "custom" &&
        assignment.scope.entityTypeId === reference.typeId
      );
  }
}

function systemRelationshipEndpoints(
  value: string,
): Readonly<{ source: string; target: string }> | null {
  switch (value) {
    case "order_shipment":
      return { source: "order", target: "shipment" };
    case "order_fulfillment":
      return { source: "order", target: "fulfillment" };
    case "fulfillment_shipment":
      return { source: "fulfillment", target: "shipment" };
    case "recipe_revision_production_batch":
      return { source: "recipe_revision", target: "production_batch" };
    case "production_batch_recipe_revision":
      return { source: "production_batch", target: "recipe_revision" };
    case "shipment_production_batch":
      return { source: "shipment", target: "production_batch" };
    default:
      return null;
  }
}

function entityProvenanceKeys(entity: CommerceEntity): string[] {
  if (!isSystemCommerceEntity(entity)) return [];
  return [provenanceKey(entity.provenance)];
}
function entityFreshnessKeys(entity: CommerceEntity): string[] {
  if (!isSystemCommerceEntity(entity)) return [];
  return [freshnessKey(entity.freshness)];
}
function provenanceKey(
  value: import("@purin-labs/commerce-contracts").SourceProvenance,
): string {
  return `${value.organisationId}:${value.source}:${value.resourceType}:${value.resourceId}:${value.revision}`;
}

function freshnessKey(value: CommerceFreshness): string {
  switch (value.state) {
    case "current":
      return `current:${value.observedAt}`;
    case "stale":
      return `stale:${value.observedAt}:${value.staleSince}`;
    case "unavailable":
      return `unavailable:${value.reason}`;
    default:
      return assertNever(value);
  }
}

function sameEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function scopeAllowsQuery(
  scope: CommerceAuthorityScope,
  query: CommerceGraphQuery,
): boolean {
  switch (scope.kind) {
    case "saved_selector":
      return selectorAllowsQuery(scope.selector.query, query);
    case "entity":
      return queryReferencesEntity(query, scope.entityRef);
    case "entity_type":
      return queryReferencesEntityType(query, scope.entityTypeId);
    case "relationship_definition":
      return (
        query.kind === "relationship_traversal" &&
        query.relationshipDefinition !== null &&
        sameRelationshipDefinitionRef(
          query.relationshipDefinition,
          scope.relationshipDefinition,
        )
      );
    case "relationship":
      return false;
    case "commerce_list": {
      const list =
        query.kind === "commerce_context" &&
        query.selection.kind === "selector"
          ? query.selection.selector.query
          : query;
      return list.kind === "commerce_list_page" && list.listId === scope.listId;
    }
    case "commerce_list_entry":
      return false;
    case "saved_view":
      return (
        query.kind === "saved_commerce_view" && query.viewId === scope.viewId
      );
  }
}

function selectorAllowsQuery(
  selectorQuery: CommerceGraphQuery,
  query: CommerceGraphQuery,
): boolean {
  const requestedQuery =
    query.kind === "commerce_context" && query.selection.kind === "selector"
      ? query.selection.selector.query
      : query;
  return sameQuery(selectorQuery, requestedQuery);
}

function sameQuery(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameQuery(value, right[index]))
    );
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0,
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0,
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([leftKey, leftValue], index) => {
      const rightEntry = rightEntries[index];
      return (
        rightEntry !== undefined &&
        leftKey === rightEntry[0] &&
        sameQuery(leftValue, rightEntry[1])
      );
    })
  );
}

function queryReferencesEntity(
  query: CommerceGraphQuery,
  reference: CommerceEntityRef,
): boolean {
  switch (query.kind) {
    case "entity_by_ref":
      return sameEntityRef(query.reference, reference);
    case "relationship_traversal":
      return query.seeds.some((seed) => sameEntityRef(seed, reference));
    case "commerce_context":
      return (
        query.selection.kind === "entity_seeds" &&
        query.selection.seeds.some((seed) => sameEntityRef(seed, reference))
      );
    case "entity_type_page":
    case "commerce_list_page":
    case "saved_commerce_view":
    case "search":
    case "aggregation":
      return false;
  }
}

function queryReferencesEntityType(
  query: CommerceGraphQuery,
  entityType: CommerceEntityTypeId,
): boolean {
  switch (query.kind) {
    case "entity_type_page":
      return sameEntityTypeId(query.entityTypeId, entityType);
    case "search":
      return (
        query.entityTypeId !== null &&
        sameEntityTypeId(query.entityTypeId, entityType)
      );
    case "aggregation":
      return (
        query.source.kind === "entity_type" &&
        sameEntityTypeId(query.source.entityTypeId, entityType)
      );
    case "entity_by_ref":
      return sameEntityType(entityType, query.reference);
    case "relationship_traversal":
      return query.seeds.some((seed) => sameEntityType(entityType, seed));
    case "commerce_context":
      if (query.selection.kind !== "entity_seeds") {
        return queryReferencesEntityType(
          query.selection.selector.query,
          entityType,
        );
      }
      return query.selection.seeds.some((seed) =>
        sameEntityType(entityType, seed),
      );
    case "commerce_list_page":
    case "saved_commerce_view":
      return false;
  }
}

function sameEntityType(
  type: CommerceEntityTypeId,
  reference: CommerceEntityRef,
): boolean {
  return type.origin === reference.origin && type.typeId === reference.typeId;
}

function sameEntityTypeId(
  left: CommerceEntityTypeId,
  right: CommerceEntityTypeId,
): boolean {
  return left.origin === right.origin && left.typeId === right.typeId;
}

function denied(
  code: CommerceGraphAuthorityError["code"],
): Result<never, CommerceGraphAuthorityError> {
  switch (code) {
    case "authority_expired":
      return { ok: false, error: { code } };
    case "authority_out_of_scope":
      return { ok: false, error: { code } };
    case "sensitivity_denied":
      return { ok: false, error: { code } };
    default:
      return { ok: false, error: { code: "parse", reason: code } };
  }
}
