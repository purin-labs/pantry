import {
  PositiveInteger,
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "@purin-labs/contract-schema";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever, codePointCount, isRecord } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  attributeValueSchema,
  parseAttributeValue,
} from "./attribute-value.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";

const attributeId = Type.Unsafe<
  string & { readonly __brand: "AttributeDefinitionId" }
>(trimmedIdentityTextSchema);
const revision = Type.Unsafe<
  number & { readonly __brand: "RelationshipDefinitionRevision" }
>(PositiveInteger);
export const systemRelationshipDefinitionRefSchema = OpenObject({
  origin: Type.Literal("system"),
  definitionId: Type.Enum([
    "order_shipment",
    "order_fulfillment",
    "fulfillment_shipment",
    "recipe_revision_production_batch",
    "production_batch_recipe_revision",
    "shipment_production_batch",
  ]),
  revision,
});
export const customRelationshipDefinitionRefSchema = OpenObject({
  origin: Type.Literal("custom"),
  definitionId: Type.Unsafe<
    string & { readonly __brand: "RelationshipDefinitionId" }
  >(trimmedIdentityTextSchema),
  revision,
});
export const relationshipDefinitionRefSchema = Type.Union([
  systemRelationshipDefinitionRefSchema,
  customRelationshipDefinitionRefSchema,
]);
function valueComparisonSchema<Operator extends string>(operator: Operator) {
  return OpenObject({
    operator: Type.Literal(operator),
    attributeId,
    value: attributeValueSchema,
  });
}
export const attributeFilterSchema = Type.Union([
  valueComparisonSchema("equals"),
  valueComparisonSchema("not_equals"),
  valueComparisonSchema("less_than"),
  valueComparisonSchema("less_than_or_equal"),
  valueComparisonSchema("greater_than"),
  valueComparisonSchema("greater_than_or_equal"),
  valueComparisonSchema("contains"),
  OpenObject({ operator: Type.Literal("is_empty"), attributeId }),
  OpenObject({ operator: Type.Literal("is_not_empty"), attributeId }),
]);
export const relationshipFilterSchema = OpenObject({
  relationshipDefinition: relationshipDefinitionRefSchema,
  operator: Type.Enum(["exists", "missing"]),
});
export const commerceFilterSchema = Type.Cyclic(
  {
    Filter: Type.Union([
      OpenObject({ kind: Type.Literal("all") }),
      OpenObject({
        kind: Type.Literal("entity"),
        reference: commerceEntityRefSchema,
      }),
      OpenObject({
        kind: Type.Literal("any"),
        filters: Type.Array(Type.Ref("Filter")),
      }),
      OpenObject({ kind: Type.Literal("not"), filter: Type.Ref("Filter") }),
      OpenObject({
        kind: Type.Literal("attribute"),
        filter: attributeFilterSchema,
      }),
      OpenObject({
        kind: Type.Literal("relationship"),
        filter: relationshipFilterSchema,
      }),
      OpenObject({ kind: Type.Literal("search"), text: Type.String() }),
    ]),
  },
  "Filter",
);
// TypeBox 1.3.27 widens cyclic references to any after two levels. Restore
// the recursive edges; all leaf fields still come from the schema.
type FilterLeaf = Exclude<
  StaticDecode<typeof commerceFilterSchema>,
  { kind: "any" | "not" }
>;
type RecursiveFilter =
  | FilterLeaf
  | { kind: "any"; filters: RecursiveFilter[] }
  | { kind: "not"; filter: RecursiveFilter };
export type CommerceFilter = StrictUnion<RecursiveFilter>;
const nodeSchema = Type.Union([
  OpenObject({ kind: Type.Literal("all") }),
  OpenObject({ kind: Type.Literal("entity"), reference: Type.Unknown() }),
  OpenObject({
    kind: Type.Literal("any"),
    filters: Type.Array(Type.Unknown()),
  }),
  OpenObject({ kind: Type.Literal("not"), filter: Type.Unknown() }),
  OpenObject({ kind: Type.Literal("attribute"), filter: Type.Unknown() }),
  OpenObject({ kind: Type.Literal("relationship"), filter: Type.Unknown() }),
  OpenObject({ kind: Type.Literal("search"), text: Type.String() }),
]);
export function parseCommerceFilter(
  input: unknown,
): ContractDecodeResult<CommerceFilter> {
  return parseNode(input, 0, { nodes: 0 });
}
function parseNode(
  input: unknown,
  depth: number,
  budget: { nodes: number },
): ContractDecodeResult<CommerceFilter> {
  if (depth > 8 || budget.nodes >= 64) return invalidQuery();
  budget.nodes++;
  const parsed = parseContract(nodeSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const node = parsed.value;
  switch (node.kind) {
    case "all":
      return { ok: true, value: { kind: "all" } };
    case "entity": {
      const reference = parseCommerceEntityRef(node.reference);
      if (!reference.ok) return reference;
      return {
        ok: true,
        value: { kind: "entity", reference: reference.value },
      };
    }
    case "any": {
      if (node.filters.length === 0 || node.filters.length > 16)
        return invalidQuery();
      const filters: CommerceFilter[] = [];
      for (const child of node.filters) {
        const result = parseNode(child, depth + 1, budget);
        if (!result.ok) return result;
        filters.push(result.value);
      }
      return { ok: true, value: { kind: "any", filters } };
    }
    case "not": {
      const child = parseNode(node.filter, depth + 1, budget);
      if (!child.ok) return child;
      return { ok: true, value: { kind: "not", filter: child.value } };
    }
    case "search":
      if (
        !Value.Check(trimmedIdentityTextSchema, node.text) ||
        codePointCount(node.text) > 256
      )
        return invalidQuery();
      return { ok: true, value: { kind: "search", text: node.text } };
    case "attribute": {
      const filter = parseContract(
        attributeFilterSchema,
        node.filter,
        rejectAttributeFilter.bind(null, node.filter),
      );
      if (!filter.ok) return filter;
      switch (filter.value.operator) {
        case "is_empty":
        case "is_not_empty":
          return {
            ok: true,
            value: {
              kind: "attribute",
              filter: {
                operator: filter.value.operator,
                attributeId: filter.value.attributeId,
              },
            },
          };
        default: {
          const value = parseAttributeValue(filter.value.value);
          if (!value.ok) return value;
          return {
            ok: true,
            value: {
              kind: "attribute",
              filter: {
                operator: filter.value.operator,
                attributeId: filter.value.attributeId,
                value: value.value,
              },
            },
          };
        }
      }
    }
    case "relationship": {
      const filter = parseContract(
        relationshipFilterSchema,
        node.filter,
        rejectRelationshipFilter.bind(null, node.filter),
      );
      if (!filter.ok) return filter;
      const definition = filter.value.relationshipDefinition;
      switch (definition.origin) {
        case "system":
          return {
            ok: true,
            value: {
              kind: "relationship",
              filter: {
                operator: filter.value.operator,
                relationshipDefinition: {
                  origin: "system",
                  definitionId: definition.definitionId,
                  revision: definition.revision,
                },
              },
            },
          };
        case "custom":
          return {
            ok: true,
            value: {
              kind: "relationship",
              filter: {
                operator: filter.value.operator,
                relationshipDefinition: {
                  origin: "custom",
                  definitionId: definition.definitionId,
                  revision: definition.revision,
                },
              },
            },
          };
        default:
          return assertNever(definition);
      }
    }
    default:
      return assertNever(node);
  }
}
function invalidShape(): ContractRejection {
  return {
    code: "parse",
    reason: "invalid commerce filter shape",
    details: null,
  };
}
function invalidQuery(): ContractDecodeResult<never> {
  return contractRefusal({
    code: "invalid_query",
    reason: "commerce filter exceeds its limits",
    details: null,
  });
}

function rejectAttributeFilter(input: unknown): ContractRejection {
  if (!isRecord(input)) return invalidShape();
  if (
    typeof input.attributeId === "string" &&
    !Value.Check(trimmedIdentityTextSchema, input.attributeId)
  ) {
    return {
      code: "invalid_identity",
      reason: "invalid attribute identity",
      details: { field: "AttributeDefinitionId" },
    };
  }
  if (Object.hasOwn(input, "value")) {
    const parsed = parseAttributeValue(input.value);
    if (!parsed.ok)
      return {
        code: parsed.error.code,
        reason: parsed.error.reason,
        details: parsed.error.details,
      };
  }
  return invalidShape();
}

function rejectRelationshipFilter(input: unknown): ContractRejection {
  if (!isRecord(input) || !isRecord(input.relationshipDefinition))
    return invalidShape();
  const definition = input.relationshipDefinition;
  if (
    definition.origin === "custom" &&
    typeof definition.definitionId === "string" &&
    !Value.Check(trimmedIdentityTextSchema, definition.definitionId)
  ) {
    return {
      code: "invalid_identity",
      reason: "invalid relationship identity",
      details: { field: "RelationshipDefinitionId" },
    };
  }
  const shape = {
    origin: definition.origin,
    definitionId: definition.definitionId,
    revision: 1,
  };
  if (
    Value.Check(relationshipDefinitionRefSchema, shape) &&
    definition.revision === 0
  ) {
    return {
      code: "invalid_revision",
      reason: "relationship revision must be positive",
      details: { field: "RelationshipDefinitionRevision" },
    };
  }
  return invalidShape();
}

export function parseRelationshipDefinitionRef(input: unknown) {
  const parsed = parseContract(
    relationshipDefinitionRefSchema,
    input,
    rejectRelationshipFilter.bind(null, { relationshipDefinition: input }),
  );
  if (!parsed.ok) return parsed;
  const definition = parsed.value;
  switch (definition.origin) {
    case "system":
      return {
        ok: true as const,
        value: {
          origin: definition.origin,
          definitionId: definition.definitionId,
          revision: definition.revision,
        },
      };
    case "custom":
      return {
        ok: true as const,
        value: {
          origin: definition.origin,
          definitionId: definition.definitionId,
          revision: definition.revision,
        },
      };
    default:
      return assertNever(definition);
  }
}
