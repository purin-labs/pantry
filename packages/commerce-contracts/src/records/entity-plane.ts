// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  attributeDefinitionRevisionSchema,
  commerceEntityRevisionSchema,
  commerceListEntryIdSchema,
  commerceListEntryRevisionSchema,
  commerceListRevisionSchema,
  customCommerceEntityIdSchema,
  customCommerceEntityTypeIdSchema,
  customEntityTypeRevisionSchema,
  merchantExtensionSchemaRevisionSchema,
  relationshipIdSchema,
  relationshipRevisionSchema,
  resourceIdSchema,
  type RelationshipDefinitionId,
  type RelationshipDefinitionRevision,
  type RelationshipId,
  type RelationshipRevision,
} from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceSourceSchema, commerceTimestampSchema } from "./provenance.ts";
import { attributeDefinitionKindSchema } from "../attribute-definition.ts";
import {
  OpenObject,
  PositiveInteger,
  SafeInteger,
  StrictObject,
  recordParser,
} from "../schema.ts";
import { normalizedTextSchema } from "./fields.ts";
import { commerceListEntryRefSchema } from "../authority-scope.ts";
import {
  customCommerceEntityTypeDraftSchema,
  systemEntityExtensionSchemaDraftSchema,
} from "../entity-commands.ts";
import {
  attributeDefinitionScopeSchema,
  commerceSensitivitySchema,
} from "../entity-record.ts";
import {
  commerceEntityRefSchema,
  customCommerceEntityRefSchema,
  systemCommerceEntityRefSchema,
} from "../entity-reference.ts";
import {
  commerceFreshnessSchema,
  customCommerceEntityStateSchema,
  sourceProvenanceSchema,
} from "../entity-state.ts";
import {
  commerceAggregationSchema,
  commerceAggregationSourceSchema,
} from "../graph-query-schema.ts";
import {
  customRelationshipDefinitionRefSchema,
  relationshipDefinitionRefSchema,
  relationshipFilterSchema,
  systemRelationshipDefinitionRefSchema,
} from "../query-filter.ts";
import { commerceTraversalLimitsSchema } from "../query-limits.ts";
import { commerceSortSchema } from "../query-ordering.ts";
import { commercePaginationSchema } from "../query-pagination.ts";
import {
  attributeDefinitionIdSchema,
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
} from "../query-parts.ts";
import {
  customCommerceRelationshipCommandTargetSchema,
  customCommerceRelationshipCreateTargetSchema,
  customCommerceRelationshipDefinitionCommandTargetSchema,
  customCommerceRelationshipDefinitionDraftSchema,
  customCommerceRelationshipReplacementTargetSchema,
} from "../relationship-commands.ts";

export const archiveCustomEntityCommandSchema = OpenObject({
  entityRef: customCommerceEntityRefSchema,
  expectedRevision: commerceEntityRevisionSchema,
  archivedAt: commerceTimestampSchema,
});
export type ArchiveCustomEntityCommand = Static<
  typeof archiveCustomEntityCommandSchema
>;

export const decimalValueSchema = OpenObject({
  unscaled: SafeInteger,
  scale: SafeInteger,
});
export type DecimalValue = Static<typeof decimalValueSchema>;

export const commerceDateSchema = Type.String();
export type CommerceDate = Static<typeof commerceDateSchema>;

export const attributeOptionIdSchema = Type.Unsafe<
  string & { readonly __brand: "AttributeOptionId" }
>(Type.String());
export type AttributeOptionId = Static<typeof attributeOptionIdSchema>;

export const commercePrincipalIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommercePrincipalId" }
>(Type.String());
export type CommercePrincipalId = Static<typeof commercePrincipalIdSchema>;

export const merchantOperatorReferenceSchema = OpenObject({
  principalId: commercePrincipalIdSchema,
  displayName: Type.String(),
});
export type MerchantOperatorReference = Static<
  typeof merchantOperatorReferenceSchema
>;

export const externalResourceReferenceSchema = OpenObject({
  source: commerceSourceSchema,
  resourceId: resourceIdSchema,
  label: Type.Union([Type.String(), Type.Null()]),
});
export type ExternalResourceReference = Static<
  typeof externalResourceReferenceSchema
>;

export const attributeValueSchema = Type.Union([
  OpenObject({ kind: Type.Literal("short_text"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("long_text"), value: Type.String() }),
  OpenObject({
    kind: Type.Literal("integer"),
    value: Type.Unsafe<bigint>(SafeInteger),
  }),
  OpenObject({ kind: Type.Literal("decimal"), value: decimalValueSchema }),
  OpenObject({ kind: Type.Literal("boolean"), value: Type.Boolean() }),
  OpenObject({ kind: Type.Literal("date"), value: commerceDateSchema }),
  OpenObject({
    kind: Type.Literal("timestamp"),
    value: commerceTimestampSchema,
  }),
  OpenObject({ kind: Type.Literal("status"), value: attributeOptionIdSchema }),
  OpenObject({
    kind: Type.Literal("choice"),
    values: Type.Array(attributeOptionIdSchema),
  }),
  OpenObject({ kind: Type.Literal("money"), value: moneySchema }),
  OpenObject({
    kind: Type.Literal("merchant_operator_reference"),
    value: merchantOperatorReferenceSchema,
  }),
  OpenObject({
    kind: Type.Literal("external_resource_reference"),
    value: externalResourceReferenceSchema,
  }),
]);
export type AttributeValue = Static<typeof attributeValueSchema>;

export const attributeFilterSchema = Type.Union([
  OpenObject({
    operator: Type.Literal("equals"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("not_equals"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("less_than"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("less_than_or_equal"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("greater_than"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("greater_than_or_equal"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("contains"),
    attributeId: attributeDefinitionIdSchema,
    value: attributeValueSchema,
  }),
  OpenObject({
    operator: Type.Literal("is_empty"),
    attributeId: attributeDefinitionIdSchema,
  }),
  OpenObject({
    operator: Type.Literal("is_not_empty"),
    attributeId: attributeDefinitionIdSchema,
  }),
]);
export type AttributeFilter = Static<typeof attributeFilterSchema>;

export const attributeOptionSchema = OpenObject({
  id: attributeOptionIdSchema,
  label: Type.String(),
});
export type AttributeOption = Static<typeof attributeOptionSchema>;

export const attributeValueAssignmentSchema = StrictObject({
  attributeId: attributeDefinitionIdSchema,
  scope: attributeDefinitionScopeSchema,
  definitionRevision: attributeDefinitionRevisionSchema,
  sensitivity: commerceSensitivitySchema,
  value: attributeValueSchema,
});
export type AttributeValueAssignment = Static<
  typeof attributeValueAssignmentSchema
>;

export const attributeValueKindSchema = Type.Union([
  Type.Literal("short_text"),
  Type.Literal("long_text"),
  Type.Literal("integer"),
  Type.Literal("decimal"),
  Type.Literal("boolean"),
  Type.Literal("date"),
  Type.Literal("timestamp"),
  Type.Literal("status"),
  Type.Literal("choice"),
  Type.Literal("money"),
  Type.Literal("merchant_operator_reference"),
  Type.Literal("external_resource_reference"),
]);
export type AttributeValueKind = Static<typeof attributeValueKindSchema>;

// A recursive schema has no equal static type, so the type is written out.
export type CommerceFilter =
  | { kind: "all" }
  | { kind: "entity"; reference: Static<typeof commerceEntityRefSchema> }
  | { kind: "any"; filters: Array<CommerceFilter> }
  | { kind: "not"; filter: CommerceFilter }
  | { kind: "attribute"; filter: AttributeFilter }
  | { kind: "relationship"; filter: Static<typeof relationshipFilterSchema> }
  | { kind: "search"; text: string };
export const commerceFilterSchema = Type.Unsafe<CommerceFilter>(
  Type.Cyclic(
    {
      CommerceFilter: Type.Union([
        OpenObject({ kind: Type.Literal("all") }),
        OpenObject({
          kind: Type.Literal("entity"),
          reference: commerceEntityRefSchema,
        }),
        OpenObject({
          kind: Type.Literal("any"),
          filters: Type.Array(Type.Ref("CommerceFilter")),
        }),
        OpenObject({
          kind: Type.Literal("not"),
          filter: Type.Ref("CommerceFilter"),
        }),
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
    "CommerceFilter",
  ),
);

export const commerceAggregationQuerySchema = OpenObject({
  source: commerceAggregationSourceSchema,
  filter: commerceFilterSchema,
  aggregation: commerceAggregationSchema,
});
export type CommerceAggregationQuery = Static<
  typeof commerceAggregationQuerySchema
>;

export const commerceCausationIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceCausationId" }
>(Type.String());
export type CommerceCausationId = Static<typeof commerceCausationIdSchema>;

export const customEntityOriginSchema = Type.Literal("custom");
export type CustomEntityOrigin = Static<typeof customEntityOriginSchema>;

export const customCommerceRelationshipRefSchema = OpenObject({
  origin: customEntityOriginSchema,
  relationshipId: relationshipIdSchema,
  definition: customRelationshipDefinitionRefSchema,
  revision: relationshipRevisionSchema,
});
export type CustomCommerceRelationshipRef = Static<
  typeof customCommerceRelationshipRefSchema
>;

export const listEntryAttributeValueSchema = StrictObject({
  attributeId: attributeDefinitionIdSchema,
  scope: attributeDefinitionScopeSchema,
  definitionRevision: attributeDefinitionRevisionSchema,
  sensitivity: commerceSensitivitySchema,
  value: attributeValueSchema,
});
export type ListEntryAttributeValue = Static<
  typeof listEntryAttributeValueSchema
>;

export const commerceListEntryCommandTargetSchema = OpenObject({
  entry: commerceListEntryRefSchema,
  expectedRevision: commerceListEntryRevisionSchema,
});
export type CommerceListEntryCommandTarget = Static<
  typeof commerceListEntryCommandTargetSchema
>;

/**
 * The mutation intents that can be proposed by a Case. This union deliberately
 * contains only entity-plane mutations that carry an exact resource reference
 * and the revision the command is based on.
 */
export const commerceEntityPlaneProposalSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("patch_custom_entity"),
    entityRef: customCommerceEntityRefSchema,
    typeRevision: customEntityTypeRevisionSchema,
    expectedRevision: commerceEntityRevisionSchema,
    attributes: Type.Array(attributeValueAssignmentSchema),
    displayName: Type.Union([Type.String(), Type.Null()]),
  }),
  StrictObject({
    kind: Type.Literal("create_custom_relationship"),
    relationshipId: relationshipIdSchema,
    definition: customRelationshipDefinitionRefSchema,
    source: commerceEntityRefSchema,
    target: commerceEntityRefSchema,
  }),
  StrictObject({
    kind: Type.Literal("delete_custom_relationship"),
    relationship: customCommerceRelationshipRefSchema,
  }),
  StrictObject({
    kind: Type.Literal("replace_custom_relationship"),
    relationship: customCommerceRelationshipRefSchema,
    replacementTarget: commerceEntityRefSchema,
  }),
  StrictObject({
    kind: Type.Literal("add_commerce_list_entry"),
    entryId: commerceListEntryIdSchema,
    listId: commerceListIdSchema,
    expectedListRevision: commerceListRevisionSchema,
    entityRef: commerceEntityRefSchema,
    attributeValues: Type.Array(listEntryAttributeValueSchema),
    revision: commerceListEntryRevisionSchema,
  }),
  StrictObject({
    kind: Type.Literal("patch_commerce_list_entry"),
    entry: commerceListEntryCommandTargetSchema,
    expectedListRevision: commerceListRevisionSchema,
    attributeValues: Type.Array(listEntryAttributeValueSchema),
  }),
  StrictObject({
    kind: Type.Literal("remove_commerce_list_entry"),
    entry: commerceListEntryCommandTargetSchema,
  }),
]);
export type CommerceEntityPlaneProposal = Static<
  typeof commerceEntityPlaneProposalSchema
>;

export const commerceListPageQuerySchema = OpenObject({
  listId: commerceListIdSchema,
  filter: commerceFilterSchema,
  sorts: Type.Array(commerceSortSchema),
  pagination: commercePaginationSchema,
});
export type CommerceListPageQuery = Static<typeof commerceListPageQuerySchema>;

export const commerceSearchQuerySchema = OpenObject({
  text: Type.String(),
  entityTypeId: Type.Union([commerceEntityTypeIdSchema, Type.Null()]),
  pagination: commercePaginationSchema,
  traversal: commerceTraversalLimitsSchema,
});
export type CommerceSearchQuery = Static<typeof commerceSearchQuerySchema>;

export const commerceTextNormalizationVersionSchema = Type.Literal(
  "commerce_unicode_v1",
);
export type CommerceTextNormalizationVersion = Static<
  typeof commerceTextNormalizationVersionSchema
>;

export const createCustomEntityCommandSchema = StrictObject({
  entityId: customCommerceEntityIdSchema,
  typeId: customCommerceEntityTypeIdSchema,
  typeRevision: customEntityTypeRevisionSchema,
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
  sensitivity: commerceSensitivitySchema,
});
export type CreateCustomEntityCommand = Static<
  typeof createCustomEntityCommandSchema
>;

export const createCustomEntityTypeCommandSchema = StrictObject({
  draft: customCommerceEntityTypeDraftSchema,
});
export type CreateCustomEntityTypeCommand = Static<
  typeof createCustomEntityTypeCommandSchema
>;

export const createCustomRelationshipCommandSchema = OpenObject({
  target: customCommerceRelationshipCreateTargetSchema,
});
export type CreateCustomRelationshipCommand = Static<
  typeof createCustomRelationshipCommandSchema
>;

export const createCustomRelationshipDefinitionCommandSchema = StrictObject({
  draft: customCommerceRelationshipDefinitionDraftSchema,
});
export type CreateCustomRelationshipDefinitionCommand = Static<
  typeof createCustomRelationshipDefinitionCommandSchema
>;

export const createSystemEntityExtensionSchemaCommandSchema = StrictObject({
  draft: systemEntityExtensionSchemaDraftSchema,
});
export type CreateSystemEntityExtensionSchemaCommand = Static<
  typeof createSystemEntityExtensionSchemaCommandSchema
>;

export const customCommerceEntitySchema = OpenObject({
  reference: customCommerceEntityRefSchema,
  revision: commerceEntityRevisionSchema,
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
  typeRevision: customEntityTypeRevisionSchema,
  state: customCommerceEntityStateSchema,
  sensitivity: commerceSensitivitySchema,
});
export type CustomCommerceEntity = Static<typeof customCommerceEntitySchema>;

export const customCommerceEntityTypeCommandTargetSchema = StrictObject({
  typeId: customCommerceEntityTypeIdSchema,
  revision: customEntityTypeRevisionSchema,
});
export type CustomCommerceEntityTypeCommandTarget = Static<
  typeof customCommerceEntityTypeCommandTargetSchema
>;

export const deleteCustomRelationshipCommandSchema = OpenObject({
  target: customCommerceRelationshipCommandTargetSchema,
});
export type DeleteCustomRelationshipCommand = Static<
  typeof deleteCustomRelationshipCommandSchema
>;

export const entityByRefQuerySchema = OpenObject({
  reference: commerceEntityRefSchema,
  traversal: commerceTraversalLimitsSchema,
  filter: Type.Union([commerceFilterSchema, Type.Null()]),
});
export type EntityByRefQuery = Static<typeof entityByRefQuerySchema>;

export const entityTypePageQuerySchema = OpenObject({
  entityTypeId: commerceEntityTypeIdSchema,
  filter: commerceFilterSchema,
  sorts: Type.Array(commerceSortSchema),
  pagination: commercePaginationSchema,
  traversal: commerceTraversalLimitsSchema,
});
export type EntityTypePageQuery = Static<typeof entityTypePageQuerySchema>;

export const patchCustomEntityCommandSchema = StrictObject({
  entityRef: customCommerceEntityRefSchema,
  typeRevision: customEntityTypeRevisionSchema,
  expectedRevision: commerceEntityRevisionSchema,
  attributes: Type.Array(attributeValueAssignmentSchema),
  displayName: Type.Union([Type.String(), Type.Null()]),
});
export type PatchCustomEntityCommand = Static<
  typeof patchCustomEntityCommandSchema
>;

export const publishCustomEntityTypeCommandSchema = StrictObject({
  target: customCommerceEntityTypeCommandTargetSchema,
});
export type PublishCustomEntityTypeCommand = Static<
  typeof publishCustomEntityTypeCommandSchema
>;

export const publishCustomRelationshipDefinitionCommandSchema = StrictObject({
  target: customCommerceRelationshipDefinitionCommandTargetSchema,
});
export type PublishCustomRelationshipDefinitionCommand = Static<
  typeof publishCustomRelationshipDefinitionCommandSchema
>;

export const systemCommerceEntityKindSchema = Type.Union([
  Type.Literal("location"),
  Type.Literal("product"),
  Type.Literal("sellable_variant"),
  Type.Literal("offer"),
  Type.Literal("inventory_item"),
  Type.Literal("stock_policy"),
  Type.Literal("menu"),
  Type.Literal("recipe_revision"),
  Type.Literal("preparation_ticket"),
  Type.Literal("production_batch"),
  Type.Literal("order"),
  Type.Literal("payment"),
  Type.Literal("fulfillment"),
  Type.Literal("shipment"),
  Type.Literal("sales_channel"),
  Type.Literal("inventory_position"),
  Type.Literal("inventory_movement"),
  Type.Literal("inventory_lot"),
  Type.Literal("inventory_consumption_plan"),
  Type.Literal("inventory_consumption_requirement"),
  Type.Literal("modifier_group_revision"),
  Type.Literal("preparation_station"),
]);
export type SystemCommerceEntityKind = Static<
  typeof systemCommerceEntityKindSchema
>;

export const systemEntityExtensionSchemaCommandTargetSchema = StrictObject({
  entityTypeId: systemCommerceEntityKindSchema,
  revision: merchantExtensionSchemaRevisionSchema,
});
export type SystemEntityExtensionSchemaCommandTarget = Static<
  typeof systemEntityExtensionSchemaCommandTargetSchema
>;

export const publishSystemEntityExtensionSchemaCommandSchema = StrictObject({
  target: systemEntityExtensionSchemaCommandTargetSchema,
});
export type PublishSystemEntityExtensionSchemaCommand = Static<
  typeof publishSystemEntityExtensionSchemaCommandSchema
>;

export const relationshipFilterOperatorSchema = Type.Union([
  Type.Literal("exists"),
  Type.Literal("missing"),
]);
export type RelationshipFilterOperator = Static<
  typeof relationshipFilterOperatorSchema
>;

export const relationshipTraversalQuerySchema = OpenObject({
  seeds: Type.Array(commerceEntityRefSchema),
  relationshipDefinition: Type.Union([
    relationshipDefinitionRefSchema,
    Type.Null(),
  ]),
  traversal: commerceTraversalLimitsSchema,
  filter: Type.Union([commerceFilterSchema, Type.Null()]),
});
export type RelationshipTraversalQuery = Static<
  typeof relationshipTraversalQuerySchema
>;

export const replaceCustomRelationshipCommandSchema = OpenObject({
  target: customCommerceRelationshipReplacementTargetSchema,
});
export type ReplaceCustomRelationshipCommand = Static<
  typeof replaceCustomRelationshipCommandSchema
>;

export const savedCommerceViewQuerySchema = OpenObject({
  viewId: savedCommerceViewIdSchema,
  pagination: commercePaginationSchema,
});
export type SavedCommerceViewQuery = Static<
  typeof savedCommerceViewQuerySchema
>;

export const systemCommerceEntitySchema = OpenObject({
  reference: systemCommerceEntityRefSchema,
  revision: commerceEntityRevisionSchema,
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
  provenance: sourceProvenanceSchema,
  freshness: commerceFreshnessSchema,
});
export type SystemCommerceEntity = Static<typeof systemCommerceEntitySchema>;

export const systemEntityOriginSchema = Type.Literal("system");
export type SystemEntityOrigin = Static<typeof systemEntityOriginSchema>;

export const systemRelationshipDefinitionKindSchema = Type.Union([
  Type.Literal("order_shipment"),
  Type.Literal("order_fulfillment"),
  Type.Literal("fulfillment_shipment"),
  Type.Literal("recipe_revision_production_batch"),
  Type.Literal("production_batch_recipe_revision"),
  Type.Literal("shipment_production_batch"),
]);
export type SystemRelationshipDefinitionKind = Static<
  typeof systemRelationshipDefinitionKindSchema
>;

// Exact schemas that the Step 1 modules already define.
export type AttributeDefinitionKind = Static<
  typeof attributeDefinitionKindSchema
>;
export type AttributeDefinitionScope = Static<
  typeof attributeDefinitionScopeSchema
>;
export type CommerceSensitivity = Static<typeof commerceSensitivitySchema>;
export type CustomRelationshipDefinitionRef = Static<
  typeof customRelationshipDefinitionRefSchema
>;
export type RelationshipDefinitionRef = Static<
  typeof relationshipDefinitionRefSchema
>;
export type RelationshipFilter = Static<typeof relationshipFilterSchema>;
export type SystemRelationshipDefinitionRef = Static<
  typeof systemRelationshipDefinitionRefSchema
>;

/**
 * The client reader of a custom relationship reference
 * (`parseCustomCommerceRelationshipRef`): no unknown key, normalized text and
 * positive revisions. The origin comes from the definition; the reader does not
 * read the reference's own `origin`.
 */
const wireCustomRelationshipDefinitionRefSchema = StrictObject({
  origin: Type.Literal("custom"),
  definitionId: normalizedTextSchema,
  revision: PositiveInteger,
});

export const wireCustomCommerceRelationshipRefSchema = Type.Unsafe<
  Static<typeof customCommerceRelationshipRefSchema>
>(
  Type.Codec(
    StrictObject({
      origin: Type.Optional(Type.Unknown()),
      relationshipId: normalizedTextSchema,
      definition: wireCustomRelationshipDefinitionRefSchema,
      revision: PositiveInteger,
    }),
  )
    .Decode(customRelationshipRef)
    .Encode(sameRelationshipRef),
);

type WireCustomRelationshipRef = Readonly<{
  relationshipId: string;
  definition: Readonly<{ definitionId: string; revision: number }>;
  revision: number;
}>;

function customRelationshipRef(
  reference: WireCustomRelationshipRef,
): CustomCommerceRelationshipRef {
  return {
    origin: "custom",
    relationshipId: reference.relationshipId as RelationshipId,
    definition: {
      origin: "custom",
      definitionId: reference.definition
        .definitionId as RelationshipDefinitionId,
      revision: reference.definition.revision as RelationshipDefinitionRevision,
    },
    revision: reference.revision as RelationshipRevision,
  };
}

function sameRelationshipRef(
  reference: CustomCommerceRelationshipRef,
): CustomCommerceRelationshipRef {
  return reference;
}

// Parsers of the records above (Plan 78 step 2).
export const parseWireCustomCommerceRelationshipRef = recordParser(
  wireCustomCommerceRelationshipRefSchema,
);
export const parseCommerceEntityRevision = recordParser(
  commerceEntityRevisionSchema,
);
export const parseArchiveCustomEntityCommand = recordParser(
  archiveCustomEntityCommandSchema,
);
export const parseAttributeDefinitionRevision = recordParser(
  attributeDefinitionRevisionSchema,
);
export const parseDecimalValue = recordParser(decimalValueSchema);
export const parseAttributeOptionId = recordParser(attributeOptionIdSchema);
export const parseCommercePrincipalId = recordParser(commercePrincipalIdSchema);
export const parseMerchantOperatorReference = recordParser(
  merchantOperatorReferenceSchema,
);
export const parseExternalResourceReference = recordParser(
  externalResourceReferenceSchema,
);
export const parseAttributeValue = recordParser(attributeValueSchema);
export const parseAttributeFilter = recordParser(attributeFilterSchema);
export const parseAttributeOption = recordParser(attributeOptionSchema);
export const parseAttributeValueAssignment = recordParser(
  attributeValueAssignmentSchema,
);
export const parseAttributeValueKind = recordParser(attributeValueKindSchema);
export const parseCommerceFilter = recordParser(commerceFilterSchema);
export const parseCommerceAggregationQuery = recordParser(
  commerceAggregationQuerySchema,
);
export const parseCommerceCausationId = recordParser(commerceCausationIdSchema);
export const parseCustomEntityTypeRevision = recordParser(
  customEntityTypeRevisionSchema,
);
export const parseRelationshipRevision = recordParser(
  relationshipRevisionSchema,
);
export const parseCustomCommerceRelationshipRef = recordParser(
  customCommerceRelationshipRefSchema,
);
export const parseCommerceListRevision = recordParser(
  commerceListRevisionSchema,
);
export const parseListEntryAttributeValue = recordParser(
  listEntryAttributeValueSchema,
);
export const parseCommerceListEntryRevision = recordParser(
  commerceListEntryRevisionSchema,
);
export const parseCommerceListEntryCommandTarget = recordParser(
  commerceListEntryCommandTargetSchema,
);
export const parseCommerceEntityPlaneProposal = recordParser(
  commerceEntityPlaneProposalSchema,
);
export const parseCommerceListPageQuery = recordParser(
  commerceListPageQuerySchema,
);
export const parseCommerceSearchQuery = recordParser(commerceSearchQuerySchema);
export const parseCustomCommerceEntityId = recordParser(
  customCommerceEntityIdSchema,
);
export const parseCustomCommerceEntityTypeId = recordParser(
  customCommerceEntityTypeIdSchema,
);
export const parseCreateCustomEntityCommand = recordParser(
  createCustomEntityCommandSchema,
);
export const parseCreateCustomEntityTypeCommand = recordParser(
  createCustomEntityTypeCommandSchema,
);
export const parseCreateCustomRelationshipCommand = recordParser(
  createCustomRelationshipCommandSchema,
);
export const parseCreateCustomRelationshipDefinitionCommand = recordParser(
  createCustomRelationshipDefinitionCommandSchema,
);
export const parseCreateSystemEntityExtensionSchemaCommand = recordParser(
  createSystemEntityExtensionSchemaCommandSchema,
);
export const parseCustomCommerceEntity = recordParser(
  customCommerceEntitySchema,
);
export const parseCustomCommerceEntityTypeCommandTarget = recordParser(
  customCommerceEntityTypeCommandTargetSchema,
);
export const parseDeleteCustomRelationshipCommand = recordParser(
  deleteCustomRelationshipCommandSchema,
);
export const parseEntityByRefQuery = recordParser(entityByRefQuerySchema);
export const parseEntityTypePageQuery = recordParser(entityTypePageQuerySchema);
export const parseMerchantExtensionSchemaRevision = recordParser(
  merchantExtensionSchemaRevisionSchema,
);
export const parsePatchCustomEntityCommand = recordParser(
  patchCustomEntityCommandSchema,
);
export const parsePublishCustomEntityTypeCommand = recordParser(
  publishCustomEntityTypeCommandSchema,
);
export const parsePublishCustomRelationshipDefinitionCommand = recordParser(
  publishCustomRelationshipDefinitionCommandSchema,
);
export const parseSystemCommerceEntityKind = recordParser(
  systemCommerceEntityKindSchema,
);
export const parseSystemEntityExtensionSchemaCommandTarget = recordParser(
  systemEntityExtensionSchemaCommandTargetSchema,
);
export const parsePublishSystemEntityExtensionSchemaCommand = recordParser(
  publishSystemEntityExtensionSchemaCommandSchema,
);
export const parseRelationshipFilterOperator = recordParser(
  relationshipFilterOperatorSchema,
);
export const parseRelationshipTraversalQuery = recordParser(
  relationshipTraversalQuerySchema,
);
export const parseReplaceCustomRelationshipCommand = recordParser(
  replaceCustomRelationshipCommandSchema,
);
export const parseSavedCommerceViewQuery = recordParser(
  savedCommerceViewQuerySchema,
);
export const parseSystemCommerceEntity = recordParser(
  systemCommerceEntitySchema,
);
export const parseSystemRelationshipDefinitionKind = recordParser(
  systemRelationshipDefinitionKindSchema,
);
