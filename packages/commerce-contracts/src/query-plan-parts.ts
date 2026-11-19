import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
} from "./schema.ts";
import { relationshipDefinitionWireSchema } from "./query-wire.ts";
import { Type, type Static, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever, codePointCount } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import {
  attributeDefinitionIdSchema,
  identityRefusal,
  invalidShape,
  parseSorts,
  queryRefusal,
} from "./query-parts.ts";
import {
  relationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
  attributeFilterSchema,
  relationshipFilterSchema,
  parseCommerceFilter,
  type CommerceFilter,
} from "./query-filter.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceSortSchema,
  parseCommerceEffectiveOrdering,
  type CommerceEffectiveOrdering,
} from "./query-ordering.ts";
import { cursorRefusal } from "./cursor-values.ts";
import { normalizeCommerceUnicodeV1 } from "./unicode.ts";

export const commerceQuerySemanticsV1Schema = OpenObject({
  semanticsVersion: Type.Literal("v1"),
  orderingVersion: Type.Literal("v1"),
  textNormalization: Type.Literal("commerce_unicode_v1"),
  nullPlacement: Type.Literal("last"),
});
export type CommerceQuerySemanticsV1 = Static<
  typeof commerceQuerySemanticsV1Schema
>;
export function parseCommerceQuerySemantics(
  input: unknown,
): ContractDecodeResult<CommerceQuerySemanticsV1> {
  const parsed = parseContract(
    commerceQuerySemanticsV1Schema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
  };
}
export const commerceQueryProjectionSchema = OpenObject({
  attributeIds: Type.Array(attributeDefinitionIdSchema, {
    maxItems: 64,
    uniqueItems: true,
  }),
  relationshipDefinitions: Type.Array(relationshipDefinitionRefSchema, {
    maxItems: 16,
    uniqueItems: true,
  }),
  includeProvenance: Type.Boolean(),
  includeFreshness: Type.Boolean(),
});
export type CommerceQueryProjection = Static<
  typeof commerceQueryProjectionSchema
>;
export const projectionWire = OpenObject({
  attributeIds: Type.Array(Type.String()),
  relationshipDefinitions: Type.Array(relationshipDefinitionWireSchema),
  includeProvenance: Type.Boolean(),
  includeFreshness: Type.Boolean(),
});
export function parseCommerceQueryProjection(
  input: unknown,
): ContractDecodeResult<CommerceQueryProjection> {
  const parsed = parseContract(projectionWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const projection = parsed.value;
  if (
    projection.attributeIds.length > 64 ||
    projection.relationshipDefinitions.length > 16
  )
    return queryRefusal();
  const attributeIds: CommerceQueryProjection["attributeIds"] = [];
  const seenAttributes = new Set<string>();
  for (const id of projection.attributeIds) {
    if (!Value.Check(attributeDefinitionIdSchema, id))
      return identityRefusal("AttributeDefinitionId");
    if (seenAttributes.has(id)) return cursorRefusal("duplicate_identity");
    seenAttributes.add(id);
    attributeIds.push(id);
  }
  const relationshipDefinitions: CommerceQueryProjection["relationshipDefinitions"] =
    [];
  const seenRelationships = new Set<string>();
  for (const input of projection.relationshipDefinitions) {
    const relationship = parseRelationshipDefinitionRef(input);
    if (!relationship.ok) return relationship;
    const key = JSON.stringify([
      relationship.value.origin,
      relationship.value.definitionId,
      relationship.value.revision,
    ]);
    if (seenRelationships.has(key)) return cursorRefusal("duplicate_identity");
    seenRelationships.add(key);
    relationshipDefinitions.push(relationship.value);
  }
  return {
    ok: true,
    value: {
      attributeIds,
      relationshipDefinitions,
      includeProvenance: projection.includeProvenance,
      includeFreshness: projection.includeFreshness,
    },
  };
}
export const commerceOrderingIntentSchema = Type.Union([
  OpenObject({ kind: Type.Literal("scan") }),
  OpenObject({
    kind: Type.Literal("presentation"),
    requestedSorts: Type.Array(commerceSortSchema, { maxItems: 8 }),
  }),
]);
export type CommerceOrderingIntent = StrictUnion<
  Static<typeof commerceOrderingIntentSchema>
>;
const intentWire = Type.Union([
  OpenObject({ kind: Type.Literal("scan") }),
  OpenObject({
    kind: Type.Literal("presentation"),
    requestedSorts: Type.Array(Type.Unknown()),
  }),
]);
export function effectiveCommerceOrdering(
  input: unknown,
): ContractDecodeResult<CommerceEffectiveOrdering> {
  const parsed = parseContract(intentWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "scan")
    return {
      ok: true,
      value: { leadingKeys: [], tieBreaker: { kind: "entity_id_ascending" } },
    };
  const sorts = parseSorts(parsed.value.requestedSorts);
  if (!sorts.ok) return sorts;
  const leadingKeys: CommerceEffectiveOrdering["leadingKeys"] = [];
  if (sorts.value.length === 0)
    leadingKeys.push({
      field: { kind: "updated_at" },
      direction: "descending",
      nulls: "last",
    });
  for (const sort of sorts.value)
    leadingKeys.push({
      field: sort.field,
      direction: sort.direction,
      nulls: "last",
    });
  return parseCommerceEffectiveOrdering({
    leadingKeys,
    tieBreaker: { kind: "entity_id_ascending" },
  });
}
export const commerceNormalizedPredicateSchema = Type.Cyclic(
  {
    Predicate: Type.Union([
      OpenObject({ kind: Type.Literal("all") }),
      OpenObject({
        kind: Type.Literal("entity"),
        reference: commerceEntityRefSchema,
      }),
      OpenObject({
        kind: Type.Literal("search"),
        foldedText: Type.String({ minLength: 1, maxLength: 256 }),
      }),
      OpenObject({
        kind: Type.Literal("any"),
        predicates: Type.Array(Type.Ref("Predicate"), {
          minItems: 1,
          maxItems: 16,
        }),
      }),
      OpenObject({
        kind: Type.Literal("not"),
        predicate: Type.Ref("Predicate"),
      }),
      OpenObject({
        kind: Type.Literal("attribute"),
        filter: attributeFilterSchema,
      }),
      OpenObject({
        kind: Type.Literal("relationship"),
        filter: relationshipFilterSchema,
      }),
    ]),
  },
  "Predicate",
);
type PredicateLeaf = Exclude<
  StaticDecode<typeof commerceNormalizedPredicateSchema>,
  { kind: "any" | "not" }
>;
type RecursivePredicate =
  | PredicateLeaf
  | { kind: "any"; predicates: RecursivePredicate[] }
  | { kind: "not"; predicate: RecursivePredicate };
export type CommerceNormalizedPredicate = StrictUnion<RecursivePredicate>;
const predicateWire = Type.Union([
  OpenObject({ kind: Type.Literal("all") }),
  OpenObject({ kind: Type.Literal("entity"), reference: Type.Unknown() }),
  OpenObject({ kind: Type.Literal("search"), foldedText: Type.String() }),
  OpenObject({
    kind: Type.Literal("any"),
    predicates: Type.Array(Type.Unknown()),
  }),
  OpenObject({ kind: Type.Literal("not"), predicate: Type.Unknown() }),
  OpenObject({
    kind: Type.Enum(["attribute", "relationship"]),
    filter: Type.Unknown(),
  }),
]);
export function parseCommerceNormalizedPredicate(
  input: unknown,
): ContractDecodeResult<CommerceNormalizedPredicate> {
  const parsed = parseContract(predicateWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const predicate = parsed.value;
  switch (predicate.kind) {
    case "all":
      return { ok: true, value: { kind: "all" } };
    case "entity": {
      const reference = parseCommerceEntityRef(predicate.reference);
      if (!reference.ok) return reference;
      return {
        ok: true,
        value: { kind: "entity", reference: reference.value },
      };
    }
    case "search":
      if (
        predicate.foldedText.length === 0 ||
        codePointCount(predicate.foldedText) > 256
      )
        return queryRefusal();
      return {
        ok: true,
        value: { kind: "search", foldedText: predicate.foldedText },
      };
    case "any": {
      if (predicate.predicates.length === 0 || predicate.predicates.length > 16)
        return queryRefusal();
      const predicates: CommerceNormalizedPredicate[] = [];
      for (const input of predicate.predicates) {
        const child = parseCommerceNormalizedPredicate(input);
        if (!child.ok) return child;
        predicates.push(child.value);
      }
      return { ok: true, value: { kind: "any", predicates } };
    }
    case "not": {
      const child = parseCommerceNormalizedPredicate(predicate.predicate);
      if (!child.ok) return child;
      return { ok: true, value: { kind: "not", predicate: child.value } };
    }
    case "attribute":
    case "relationship": {
      const filter = parseCommerceFilter(predicate);
      if (!filter.ok) return filter;
      if (
        filter.value.kind === "attribute" ||
        filter.value.kind === "relationship"
      )
        return { ok: true, value: filter.value };
      return queryRefusal();
    }
    default:
      return assertNever(predicate);
  }
}
/** The query boundary has already checked filter depth and node budgets. */
export function normalizeCommercePredicate(
  filter: CommerceFilter,
): CommerceNormalizedPredicate {
  switch (filter.kind) {
    case "all":
      return { kind: "all" };
    case "entity":
      return { kind: "entity", reference: filter.reference };
    case "search":
      return {
        kind: "search",
        foldedText: normalizeCommerceUnicodeV1(filter.text),
      };
    case "any":
      return {
        kind: "any",
        predicates: filter.filters.map(normalizeCommercePredicate),
      };
    case "not":
      return {
        kind: "not",
        predicate: normalizeCommercePredicate(filter.filter),
      };
    case "attribute":
      return { kind: "attribute", filter: filter.filter };
    case "relationship":
      return { kind: "relationship", filter: filter.filter };
    default:
      return assertNever(filter);
  }
}
