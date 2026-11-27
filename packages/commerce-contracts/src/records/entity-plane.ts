// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  attributeDefinitionRevisionSchema,
  commerceEntityRevisionSchema,
  commerceListEntryIdSchema,
  commerceListEntryRevisionSchema,
  commerceListRevisionSchema,
  customEntityTypeRevisionSchema,
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
} from "@purin-labs/contract-schema";
import { normalizedTextSchema } from "./fields.ts";
import { commerceListEntryRefSchema } from "../authority-scope.ts";
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
  customRelationshipDefinitionRefSchema,
  relationshipDefinitionRefSchema,
  relationshipFilterSchema,
  systemRelationshipDefinitionRefSchema,
} from "../query-filter.ts";
import {
  attributeDefinitionIdSchema,
  commerceListIdSchema,
} from "../query-parts.ts";

const decimalValueSchema = OpenObject({
  unscaled: SafeInteger,
  scale: SafeInteger,
});

const commerceDateSchema = Type.String();

const attributeOptionIdSchema = Type.Unsafe<
  string & { readonly __brand: "AttributeOptionId" }
>(Type.String());
export type AttributeOptionId = Static<typeof attributeOptionIdSchema>;

const commercePrincipalIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommercePrincipalId" }
>(Type.String());
export type CommercePrincipalId = Static<typeof commercePrincipalIdSchema>;

const merchantOperatorReferenceSchema = OpenObject({
  principalId: commercePrincipalIdSchema,
  displayName: Type.String(),
});

const externalResourceReferenceSchema = OpenObject({
  source: commerceSourceSchema,
  resourceId: resourceIdSchema,
  label: Type.Union([Type.String(), Type.Null()]),
});
export type ExternalResourceReference = Static<
  typeof externalResourceReferenceSchema
>;

const attributeValueSchema = Type.Union([
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

const attributeFilterSchema = Type.Union([
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

const attributeOptionSchema = OpenObject({
  id: attributeOptionIdSchema,
  label: Type.String(),
});
export type AttributeOption = Static<typeof attributeOptionSchema>;

const attributeValueAssignmentSchema = StrictObject({
  attributeId: attributeDefinitionIdSchema,
  scope: attributeDefinitionScopeSchema,
  definitionRevision: attributeDefinitionRevisionSchema,
  sensitivity: commerceSensitivitySchema,
  value: attributeValueSchema,
});

const customEntityOriginSchema = Type.Literal("custom");

const customCommerceRelationshipRefSchema = OpenObject({
  origin: customEntityOriginSchema,
  relationshipId: relationshipIdSchema,
  definition: customRelationshipDefinitionRefSchema,
  revision: relationshipRevisionSchema,
});
type CustomCommerceRelationshipRef = Static<
  typeof customCommerceRelationshipRefSchema
>;

const listEntryAttributeValueSchema = StrictObject({
  attributeId: attributeDefinitionIdSchema,
  scope: attributeDefinitionScopeSchema,
  definitionRevision: attributeDefinitionRevisionSchema,
  sensitivity: commerceSensitivitySchema,
  value: attributeValueSchema,
});

const commerceListEntryCommandTargetSchema = OpenObject({
  entry: commerceListEntryRefSchema,
  expectedRevision: commerceListEntryRevisionSchema,
});

/**
 * The mutation intents that can be proposed by a Case. This union deliberately
 * contains only entity-plane mutations that carry an exact resource reference
 * and the revision the command is based on.
 */
const commerceEntityPlaneProposalSchema = Type.Union([
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

const customCommerceEntitySchema = OpenObject({
  reference: customCommerceEntityRefSchema,
  revision: commerceEntityRevisionSchema,
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
  typeRevision: customEntityTypeRevisionSchema,
  state: customCommerceEntityStateSchema,
  sensitivity: commerceSensitivitySchema,
});
export type CustomCommerceEntity = Static<typeof customCommerceEntitySchema>;

const systemCommerceEntityKindSchema = Type.Union([
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

const systemCommerceEntitySchema = OpenObject({
  reference: systemCommerceEntityRefSchema,
  revision: commerceEntityRevisionSchema,
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
  provenance: sourceProvenanceSchema,
  freshness: commerceFreshnessSchema,
});
export type SystemCommerceEntity = Static<typeof systemCommerceEntitySchema>;

const systemRelationshipDefinitionKindSchema = Type.Union([
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

const wireCustomCommerceRelationshipRefSchema = Type.Unsafe<
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
export const parseListEntryAttributeValue = recordParser(
  listEntryAttributeValueSchema,
);
