import { systemRelationshipDefinitionRefSchema } from "./query-filter.ts";
import {
  systemEntityTypeIdSchema,
  traversalWire,
  sortWire,
  freshnessWire,
} from "./query-parts.ts";
import { OpenObject, NonNegativeInteger as revision } from "./schema.ts";
import { Type } from "typebox";

import { attributeValueWireSchema } from "./entity-wire.ts";

// JSON structure is checked before any domain rule, as in serde deserialization.

const systemType = systemEntityTypeIdSchema.properties.typeId;
const entityType = Type.Union([
  OpenObject({ origin: Type.Literal("system"), typeId: systemType }),
  OpenObject({ origin: Type.Literal("custom"), typeId: Type.String() }),
]);
export const systemEntityRefWireSchema = OpenObject({
  origin: Type.Literal("system"),
  typeId: systemType,
  entityId: Type.String(),
});
export const customEntityRefWireSchema = OpenObject({
  origin: Type.Literal("custom"),
  typeId: Type.String(),
  entityId: Type.String(),
});
const reference = Type.Union([
  systemEntityRefWireSchema,
  customEntityRefWireSchema,
]);
export const systemRelationshipDefinitionWireSchema = OpenObject({
  origin: Type.Literal("system"),
  definitionId: systemRelationshipDefinitionRefSchema.properties.definitionId,
  revision,
});
export const customRelationshipDefinitionWireSchema = OpenObject({
  origin: Type.Literal("custom"),
  definitionId: Type.String(),
  revision,
});
export const relationshipDefinitionWireSchema = Type.Union([
  systemRelationshipDefinitionWireSchema,
  customRelationshipDefinitionWireSchema,
]);
const attributeFilter = Type.Union([
  OpenObject({
    operator: Type.Enum([
      "equals",
      "not_equals",
      "less_than",
      "less_than_or_equal",
      "greater_than",
      "greater_than_or_equal",
      "contains",
    ]),
    attributeId: Type.String(),
    value: attributeValueWireSchema,
  }),
  OpenObject({
    operator: Type.Enum(["is_empty", "is_not_empty"]),
    attributeId: Type.String(),
  }),
]);
export const commerceFilterWireSchema = Type.Cyclic(
  {
    Filter: Type.Union([
      OpenObject({ kind: Type.Literal("all") }),
      OpenObject({ kind: Type.Literal("entity"), reference }),
      OpenObject({ kind: Type.Literal("search"), text: Type.String() }),
      OpenObject({
        kind: Type.Literal("any"),
        filters: Type.Array(Type.Ref("Filter")),
      }),
      OpenObject({ kind: Type.Literal("not"), filter: Type.Ref("Filter") }),
      OpenObject({ kind: Type.Literal("attribute"), filter: attributeFilter }),
      OpenObject({
        kind: Type.Literal("relationship"),
        filter: OpenObject({
          relationshipDefinition: relationshipDefinitionWireSchema,
          operator: Type.Enum(["exists", "missing"]),
        }),
      }),
    ]),
  },
  "Filter",
);
const optionalFilter = Type.Optional(
  Type.Union([commerceFilterWireSchema, Type.Null()]),
);
const pagination = OpenObject({
  limit: Type.Integer({ minimum: 0, maximum: 65535 }),
  cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const sorts = Type.Array(sortWire);
export const aggregationSourceWireSchema = Type.Union([
  OpenObject({ kind: Type.Literal("entity_type"), entityTypeId: entityType }),
  OpenObject({ kind: Type.Literal("commerce_list"), listId: Type.String() }),
]);
export const aggregationWireSchema = Type.Union([
  OpenObject({ kind: Type.Literal("count") }),
  OpenObject({
    kind: Type.Enum([
      "grouped_count",
      "sum",
      "minimum",
      "maximum",
      "oldest_due_date",
    ]),
    attributeId: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("age_buckets"),
    attributeId: Type.String(),
    bucketDays: Type.Array(Type.Integer({ minimum: 0, maximum: 65535 })),
  }),
]);
export const commerceGraphQueryWireSchema = Type.Cyclic(
  {
    Query: Type.Union([
      OpenObject({
        kind: Type.Literal("entity_by_ref"),
        reference,
        traversal: traversalWire,
        filter: optionalFilter,
      }),
      OpenObject({
        kind: Type.Literal("entity_type_page"),
        entityTypeId: entityType,
        filter: commerceFilterWireSchema,
        sorts,
        pagination,
        traversal: traversalWire,
      }),
      OpenObject({
        kind: Type.Literal("relationship_traversal"),
        seeds: Type.Array(reference),
        relationshipDefinition: Type.Optional(
          Type.Union([relationshipDefinitionWireSchema, Type.Null()]),
        ),
        traversal: traversalWire,
        filter: optionalFilter,
      }),
      OpenObject({
        kind: Type.Literal("commerce_list_page"),
        listId: Type.String(),
        filter: commerceFilterWireSchema,
        sorts,
        pagination,
      }),
      OpenObject({
        kind: Type.Literal("saved_commerce_view"),
        viewId: Type.String(),
        pagination,
      }),
      OpenObject({
        kind: Type.Literal("search"),
        text: Type.String(),
        entityTypeId: Type.Optional(Type.Union([entityType, Type.Null()])),
        pagination,
        traversal: traversalWire,
      }),
      OpenObject({
        kind: Type.Literal("aggregation"),
        source: aggregationSourceWireSchema,
        filter: commerceFilterWireSchema,
        aggregation: aggregationWireSchema,
      }),
      OpenObject({
        kind: Type.Literal("underclerk_context"),
        selection: Type.Union([
          OpenObject({
            kind: Type.Literal("entity_seeds"),
            seeds: Type.Array(reference),
          }),
          OpenObject({
            kind: Type.Literal("selector"),
            selector: OpenObject({
              selectorId: Type.String(),
              revision,
              query: Type.Ref("Query"),
            }),
          }),
        ]),
        traversal: traversalWire,
        allowedSensitivity: Type.Enum([
          "public",
          "internal",
          "confidential",
          "restricted",
        ]),
        allowedAttributeIds: Type.Array(Type.String()),
        freshnessRequirement: freshnessWire,
      }),
    ]),
  },
  "Query",
);

export {
  entityType as commerceEntityTypeWireSchema,
  reference as commerceEntityRefWireSchema,
};
