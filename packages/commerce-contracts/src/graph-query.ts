import {
  OpenObject,
  NonNegativeInteger,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import {
  commerceGraphQueryWireSchema,
  aggregationSourceWireSchema,
  aggregationWireSchema,
} from "./query-wire.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, codePointCount } from "@purin-labs/std";
import {
  selectorIdSchema,
  selectorRevisionSchema,
  type CommerceGraphQuery,
  type CommerceAggregation,
  type CommerceAggregationSource,
  type CommerceContextSelection,
  type PublishedCommerceSelector,
} from "./graph-query-schema.ts";
export { commerceGraphQuerySchema } from "./graph-query-schema.ts";
export type { CommerceGraphQuery } from "./graph-query-schema.ts";
import {
  type CommerceEntityRef,
  parseCommerceEntityRef,
} from "./entity-reference.ts";

import {
  parseCommerceFilter,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import { parseCommercePagination } from "./query-pagination.ts";

import { trimmedIdentityTextSchema } from "./identity-text.ts";
import {
  parseCommerceEntityTypeId,
  parseTraversal,
  parseSorts,
  parseFreshnessRequirement,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  attributeDefinitionIdSchema,
  invalidShape,
  queryRefusal,
  identityRefusal,
} from "./query-parts.ts";

export type ParsedGraphQueryKind = Static<
  typeof commerceGraphQueryWireSchema
>["kind"];

export function parseCommerceGraphQuery(
  input: unknown,
): ContractDecodeResult<CommerceGraphQuery> {
  const parsed = parseContract(
    commerceGraphQueryWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const query = parsed.value;
  switch (query.kind) {
    case "entity_by_ref": {
      const reference = parseCommerceEntityRef(query.reference);
      if (!reference.ok) return reference;
      const traversal = parseTraversal(query.traversal);
      if (!traversal.ok) return traversal;
      const filter = parseOptionalFilter(query.filter);
      if (!filter.ok) return filter;
      return {
        ok: true,
        value: {
          kind: query.kind,
          reference: reference.value,
          traversal: traversal.value,
          filter: filter.value,
        },
      };
    }
    case "entity_type_page": {
      const type = parseCommerceEntityTypeId(query.entityTypeId);
      if (!type.ok) return type;
      const filter = parseCommerceFilter(query.filter);
      if (!filter.ok) return filter;
      const sorts = parseSorts(query.sorts);
      if (!sorts.ok) return sorts;
      const pagination = parseCommercePagination(query.pagination);
      if (!pagination.ok) return pagination;
      const traversal = parseTraversal(query.traversal);
      if (!traversal.ok) return traversal;
      return {
        ok: true,
        value: {
          kind: query.kind,
          entityTypeId: type.value,
          filter: filter.value,
          sorts: sorts.value,
          pagination: pagination.value,
          traversal: traversal.value,
        },
      };
    }
    case "relationship_traversal": {
      const seeds = parseCommerceQuerySeeds(query.seeds);
      if (!seeds.ok) return seeds;
      const definition =
        query.relationshipDefinition === null ||
        query.relationshipDefinition === undefined
          ? { ok: true as const, value: null }
          : parseRelationshipDefinitionRef(query.relationshipDefinition);
      if (!definition.ok) return definition;
      const traversal = parseTraversal(query.traversal);
      if (!traversal.ok) return traversal;
      const filter = parseOptionalFilter(query.filter);
      if (!filter.ok) return filter;
      return {
        ok: true,
        value: {
          kind: query.kind,
          seeds: seeds.value,
          relationshipDefinition: definition.value,
          traversal: traversal.value,
          filter: filter.value,
        },
      };
    }
    case "commerce_list_page": {
      const id = query.listId;
      if (!Value.Check(commerceListIdSchema, id))
        return identityRefusal("CommerceListId");
      const filter = parseCommerceFilter(query.filter);
      if (!filter.ok) return filter;
      const sorts = parseSorts(query.sorts);
      if (!sorts.ok) return sorts;
      const pagination = parseCommercePagination(query.pagination);
      if (!pagination.ok) return pagination;
      return {
        ok: true,
        value: {
          kind: query.kind,
          listId: id,
          filter: filter.value,
          sorts: sorts.value,
          pagination: pagination.value,
        },
      };
    }
    case "saved_commerce_view": {
      const id = query.viewId;
      if (!Value.Check(savedCommerceViewIdSchema, id))
        return identityRefusal("SavedCommerceViewId");
      const pagination = parseCommercePagination(query.pagination);
      if (!pagination.ok) return pagination;
      return {
        ok: true,
        value: { kind: query.kind, viewId: id, pagination: pagination.value },
      };
    }
    case "search": {
      if (
        !Value.Check(trimmedIdentityTextSchema, query.text) ||
        codePointCount(query.text) > 256
      )
        return queryRefusal();
      const type =
        query.entityTypeId === null || query.entityTypeId === undefined
          ? { ok: true as const, value: null }
          : parseCommerceEntityTypeId(query.entityTypeId);
      if (!type.ok) return type;
      const pagination = parseCommercePagination(query.pagination);
      if (!pagination.ok) return pagination;
      const traversal = parseTraversal(query.traversal);
      if (!traversal.ok) return traversal;
      return {
        ok: true,
        value: {
          kind: query.kind,
          text: query.text,
          entityTypeId: type.value,
          pagination: pagination.value,
          traversal: traversal.value,
        },
      };
    }
    case "aggregation": {
      const source = parseCommerceAggregationSource(query.source);
      if (!source.ok) return source;
      const filter = parseCommerceFilter(query.filter);
      if (!filter.ok) return filter;
      const aggregation = parseCommerceAggregation(query.aggregation);
      if (!aggregation.ok) return aggregation;
      return {
        ok: true,
        value: {
          kind: query.kind,
          source: source.value,
          filter: filter.value,
          aggregation: aggregation.value,
        },
      };
    }
    case "commerce_context": {
      const traversal = parseTraversal(query.traversal);
      if (!traversal.ok) return traversal;
      const selection = parseCommerceContextSelection(query.selection);
      if (!selection.ok) return selection;
      if (query.allowedAttributeIds.length > 256) return queryRefusal();
      const allowedAttributeIds = [];
      const seen = new Set<string>();
      for (const id of query.allowedAttributeIds) {
        if (!Value.Check(attributeDefinitionIdSchema, id))
          return identityRefusal("AttributeDefinitionId");
        if (seen.has(id)) return queryRefusal();
        seen.add(id);
        allowedAttributeIds.push(id);
      }
      const freshness = parseFreshnessRequirement(query.freshnessRequirement);
      if (!freshness.ok) return freshness;
      return {
        ok: true,
        value: {
          kind: query.kind,
          selection: selection.value,
          traversal: traversal.value,
          allowedSensitivity: query.allowedSensitivity,
          allowedAttributeIds,
          freshnessRequirement: freshness.value,
        },
      };
    }
    default:
      return assertNever(query);
  }
}
function parseOptionalFilter(input: unknown) {
  if (input === undefined || input === null)
    return { ok: true as const, value: null };
  return parseCommerceFilter(input);
}
export function parseCommerceQuerySeeds(
  inputs: unknown[],
): ContractDecodeResult<CommerceEntityRef[]> {
  if (inputs.length === 0 || inputs.length > 64) return queryRefusal();
  const seeds: CommerceEntityRef[] = [];
  for (const input of inputs) {
    const seed = parseCommerceEntityRef(input);
    if (!seed.ok) return seed;
    seeds.push(seed.value);
  }
  return { ok: true, value: seeds };
}

export function parseCommerceAggregationSource(
  input: unknown,
): ContractDecodeResult<CommerceAggregationSource> {
  const parsed = parseContract(
    aggregationSourceWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  switch (parsed.value.kind) {
    case "entity_type": {
      const type = parseCommerceEntityTypeId(parsed.value.entityTypeId);
      if (!type.ok) return type;
      return {
        ok: true,
        value: { kind: "entity_type", entityTypeId: type.value },
      };
    }
    case "commerce_list": {
      const id = parsed.value.listId;
      if (!Value.Check(commerceListIdSchema, id))
        return identityRefusal("CommerceListId");
      return { ok: true, value: { kind: "commerce_list", listId: id } };
    }
    default:
      return assertNever(parsed.value);
  }
}

export function parseCommerceAggregation(
  input: unknown,
): ContractDecodeResult<CommerceAggregation> {
  const parsed = parseContract(aggregationWireSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const aggregation = parsed.value;
  if (aggregation.kind === "count")
    return { ok: true, value: { kind: "count" } };
  const id = aggregation.attributeId;
  if (!Value.Check(attributeDefinitionIdSchema, id))
    return identityRefusal("AttributeDefinitionId");
  if (aggregation.kind === "age_buckets") {
    if (
      aggregation.bucketDays.length === 0 ||
      aggregation.bucketDays.length > 16
    )
      return queryRefusal();
    let previous = 0;
    for (const day of aggregation.bucketDays) {
      if (day <= previous) return queryRefusal();
      previous = day;
    }
    return {
      ok: true,
      value: {
        kind: "age_buckets",
        attributeId: id,
        bucketDays: aggregation.bucketDays,
      },
    };
  }
  return { ok: true, value: { kind: aggregation.kind, attributeId: id } };
}
const selectorWire = OpenObject({
  selectorId: Type.String(),
  revision: NonNegativeInteger,
  query: commerceGraphQueryWireSchema,
});
const selectionWire = Type.Union([
  OpenObject({
    kind: Type.Literal("entity_seeds"),
    seeds: Type.Array(Type.Unknown()),
  }),
  OpenObject({
    kind: Type.Literal("selector"),
    selector: selectorWire,
  }),
]);
export function parseCommerceContextSelection(
  input: unknown,
): ContractDecodeResult<CommerceContextSelection> {
  const parsed = parseContract(selectionWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  switch (parsed.value.kind) {
    case "entity_seeds": {
      const seeds = parseCommerceQuerySeeds(parsed.value.seeds);
      if (!seeds.ok) return seeds;
      return { ok: true, value: { kind: "entity_seeds", seeds: seeds.value } };
    }
    case "selector": {
      const selector = parsePublishedCommerceSelector(parsed.value.selector);
      if (!selector.ok) return selector;
      return {
        ok: true,
        value: { kind: "selector", selector: selector.value },
      };
    }
    default:
      return assertNever(parsed.value);
  }
}

export function parsePublishedCommerceSelector(
  input: unknown,
): ContractDecodeResult<PublishedCommerceSelector> {
  const parsed = parseContract(selectorWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const selector = parsed.value;
  const id = selector.selectorId;
  if (!Value.Check(selectorIdSchema, id))
    return identityRefusal("PublishedCommerceSelectorId");
  const revision = selector.revision;
  if (!Value.Check(selectorRevisionSchema, revision))
    return contractRefusal({
      code: "invalid_revision",
      reason: "selector revision must be positive",
      details: { field: "PublishedCommerceSelectorRevision" },
    });
  const query = parseCommerceGraphQuery(selector.query);
  if (!query.ok) return query;
  if (query.value.kind === "commerce_context") return queryRefusal();
  return { ok: true, value: { selectorId: id, revision, query: query.value } };
}
