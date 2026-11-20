import {
  systemRelationshipDefinitionWireSchema,
  systemEntityRefWireSchema,
  customRelationshipDefinitionWireSchema,
  commerceEntityRefWireSchema,
  commerceEntityTypeWireSchema,
} from "./query-wire.ts";
import {
  systemRelationshipDefinitionRefSchema,
  customRelationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as rawRevision,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isRecord } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";

import { commerceSensitivitySchema, revisionSchema } from "./entity-record.ts";
import {
  commerceEntityTypeIdSchema,
  queryIdentitySchema,
  parseCommerceEntityTypeId,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";

import {
  commerceEntityRefSchema,
  systemCommerceEntityRefSchema,
  parseCommerceEntityRef,
  type CommerceEntityRef,
  type SystemCommerceEntityRef,
} from "./entity-reference.ts";

import {
  sourceProvenanceSchema,
  parseEntityProvenance,
} from "./entity-state.ts";
import { sourceProvenanceWireSchema } from "./entity-wire.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { cursorRefusal } from "./cursor-values.ts";

export const relationshipCardinalitySchema = Type.Enum([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
]);
export const relationshipDeletionBehaviorSchema = Type.Enum([
  "restrict",
  "detach",
  "cascade",
]);
const definitionId =
  systemRelationshipDefinitionRefSchema.properties.definitionId;
const definitionRevision = revisionSchema<"RelationshipDefinitionRevision">();
const customDefinitionId = queryIdentitySchema<"RelationshipDefinitionId">();
const definitionFields = {
  sourceLabel: Type.String(),
  inverseLabel: Type.String(),
  cardinality: relationshipCardinalitySchema,
  deletionBehavior: relationshipDeletionBehaviorSchema,
  sensitivity: commerceSensitivitySchema,
  revision: definitionRevision,
};
export const systemRelationshipDefinitionSchema = OpenObject({
  origin: Type.Literal("system"),
  definitionId,
  ...definitionFields,
});
export const customRelationshipDefinitionSchema = OpenObject({
  origin: Type.Literal("custom"),
  definitionId: customDefinitionId,
  sourceType: commerceEntityTypeIdSchema,
  targetType: commerceEntityTypeIdSchema,
  ...definitionFields,
});
export const relationshipDefinitionSchema = Type.Union([
  systemRelationshipDefinitionSchema,
  customRelationshipDefinitionSchema,
]);
export type RelationshipDefinition = StrictUnion<
  Static<typeof relationshipDefinitionSchema>
>;
export type RelationshipCardinality = Static<
  typeof relationshipCardinalitySchema
>;
export type RelationshipDeletionBehavior = Static<
  typeof relationshipDeletionBehaviorSchema
>;

const definitionWireFields = { ...definitionFields, revision: rawRevision };
export const systemRelationshipDefinitionRecordWireSchema = OpenObject({
  origin: Type.Literal("system"),
  definitionId,
  ...definitionWireFields,
});
export const customRelationshipDefinitionRecordWireSchema = OpenObject({
  origin: Type.Literal("custom"),
  definitionId: Type.String(),
  sourceType: commerceEntityTypeWireSchema,
  targetType: commerceEntityTypeWireSchema,
  ...definitionWireFields,
});
export const relationshipDefinitionRecordWireSchema = Type.Union([
  systemRelationshipDefinitionRecordWireSchema,
  customRelationshipDefinitionRecordWireSchema,
]);
const endpointTypes = {
  order_shipment: { source: "order", target: "shipment" },
  order_fulfillment: { source: "order", target: "fulfillment" },
  fulfillment_shipment: { source: "fulfillment", target: "shipment" },
  recipe_revision_production_batch: {
    source: "recipe_revision",
    target: "production_batch",
  },
  production_batch_recipe_revision: {
    source: "production_batch",
    target: "recipe_revision",
  },
  shipment_production_batch: { source: "shipment", target: "production_batch" },
} as const satisfies Record<
  Static<typeof definitionId>,
  {
    source: SystemCommerceEntityRef["typeId"];
    target: SystemCommerceEntityRef["typeId"];
  }
>;
export function parseRelationshipDefinition(
  input: unknown,
): ContractDecodeResult<RelationshipDefinition> {
  if (isRecord(input) && input.origin === "system") {
    for (const field of [
      "sourceType",
      "targetType",
      "source_type",
      "target_type",
    ])
      if (Object.hasOwn(input, field)) return cursorRefusal("parse");
  }
  const raw = parseContract(
    relationshipDefinitionRecordWireSchema,
    input,
    invalidShape,
  );
  if (!raw.ok) return raw;
  return parseRelationshipDefinitionRecord(raw.value);
}
function parseRelationshipDefinitionRecord(
  definition: Static<typeof relationshipDefinitionRecordWireSchema>,
): ContractDecodeResult<RelationshipDefinition> {
  if (definition.origin === "custom") {
    if (!Value.Check(customDefinitionId, definition.definitionId))
      return identityRefusal("RelationshipDefinitionId");
    const source = parseCommerceEntityTypeId(definition.sourceType);
    if (!source.ok) return source;
    const target = parseCommerceEntityTypeId(definition.targetType);
    if (!target.ok) return target;
  }
  if (definition.revision === 0)
    return invalidRevision("RelationshipDefinitionRevision");
  if (!Value.Check(trimmedIdentityTextSchema, definition.sourceLabel))
    return cursorRefusal("invalid_text", {
      field: "relationship.source_label",
    });
  if (!Value.Check(trimmedIdentityTextSchema, definition.inverseLabel))
    return cursorRefusal("invalid_text", {
      field: "relationship.inverse_label",
    });
  if (definition.origin === "system")
    return parseContract(
      systemRelationshipDefinitionSchema,
      {
        origin: definition.origin,
        definitionId: definition.definitionId,
        sourceLabel: definition.sourceLabel,
        inverseLabel: definition.inverseLabel,
        cardinality: definition.cardinality,
        deletionBehavior: definition.deletionBehavior,
        sensitivity: definition.sensitivity,
        revision: definition.revision,
      },
      invalidShape,
    );
  return parseContract(
    customRelationshipDefinitionSchema,
    {
      origin: definition.origin,
      definitionId: definition.definitionId,
      sourceType: {
        origin: definition.sourceType.origin,
        typeId: definition.sourceType.typeId,
      },
      targetType: {
        origin: definition.targetType.origin,
        typeId: definition.targetType.typeId,
      },
      sourceLabel: definition.sourceLabel,
      inverseLabel: definition.inverseLabel,
      cardinality: definition.cardinality,
      deletionBehavior: definition.deletionBehavior,
      sensitivity: definition.sensitivity,
      revision: definition.revision,
    },
    invalidShape,
  );
}
const relationshipId = queryIdentitySchema<"RelationshipId">();
const relationshipRevision = revisionSchema<"RelationshipRevision">();
export const systemRelationshipRefSchema = OpenObject({
  origin: Type.Literal("system"),
  relationshipId,
  definition: systemRelationshipDefinitionRefSchema,
  revision: relationshipRevision,
});
export const customRelationshipRefSchema = OpenObject({
  origin: Type.Literal("custom"),
  relationshipId,
  definition: customRelationshipDefinitionRefSchema,
  revision: relationshipRevision,
});
export const commerceRelationshipRefSchema = Type.Union([
  systemRelationshipRefSchema,
  customRelationshipRefSchema,
]);
export const systemCommerceRelationshipSchema = OpenObject({
  ...systemRelationshipRefSchema.properties,
  sensitivity: commerceSensitivitySchema,
  source: systemCommerceEntityRefSchema,
  target: systemCommerceEntityRefSchema,
  provenance: sourceProvenanceSchema,
});
export const customCommerceRelationshipSchema = OpenObject({
  ...customRelationshipRefSchema.properties,
  sensitivity: commerceSensitivitySchema,
  source: commerceEntityRefSchema,
  target: commerceEntityRefSchema,
});
export const commerceRelationshipSchema = Type.Union([
  systemCommerceRelationshipSchema,
  customCommerceRelationshipSchema,
]);
export type CommerceRelationshipRef = StrictUnion<
  Static<typeof commerceRelationshipRefSchema>
>;
export type CommerceRelationship = StrictUnion<
  Static<typeof commerceRelationshipSchema>
>;
export const commerceRelationshipWireSchema = Type.Union([
  OpenObject({
    origin: Type.Literal("system"),
    relationshipId: Type.String(),
    definition: systemRelationshipDefinitionWireSchema,
    sensitivity: commerceSensitivitySchema,
    source: systemEntityRefWireSchema,
    target: systemEntityRefWireSchema,
    revision: rawRevision,
    provenance: sourceProvenanceWireSchema,
  }),
  OpenObject({
    origin: Type.Literal("custom"),
    relationshipId: Type.String(),
    definition: customRelationshipDefinitionWireSchema,
    sensitivity: commerceSensitivitySchema,
    source: commerceEntityRefWireSchema,
    target: commerceEntityRefWireSchema,
    revision: rawRevision,
  }),
]);
type RelationshipValidation =
  { kind: "shape" } | { kind: "defined"; definition: RelationshipDefinition };
type RelationshipHeader = {
  wire: Static<typeof commerceRelationshipWireSchema>;
  source: CommerceEntityRef;
  target: CommerceEntityRef;
};
export function parseCommerceRelationshipShape(
  input: unknown,
): ContractDecodeResult<CommerceRelationship> {
  return parseRelationship(input, { kind: "shape" });
}
const relationshipRequestWire = StrictObject({
  relationship: Type.Unknown(),
  definition: Type.Unknown(),
});
function invalidRequest() {
  return {
    code: "invalid_request",
    reason: "invalid relationship request",
    details: null,
  };
}
export function parseCommerceRelationship(
  input: unknown,
): ContractDecodeResult<CommerceRelationship> {
  const request = parseContract(relationshipRequestWire, input, invalidRequest);
  if (!request.ok) return request;
  const definition = parseRelationshipDefinition(request.value.definition);
  if (!definition.ok) return definition;
  return parseRelationship(request.value.relationship, {
    kind: "defined",
    definition: definition.value,
  });
}
function parseRelationship(
  input: unknown,
  validation: RelationshipValidation,
): ContractDecodeResult<CommerceRelationship> {
  const parsed = parseContract(
    commerceRelationshipWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const header = parseRelationshipHeader(
    parsed.value,
    validation.kind === "shape"
      ? validation
      : { kind: "defined", origin: validation.definition.origin },
  );
  if (!header.ok) return header;
  return finishRelationship(header.value, validation);
}

/** Observations validate their relationship before the accompanying definition. */
export function parseObservedRelationship(
  relationship: Static<typeof commerceRelationshipWireSchema>,
  definition: Static<typeof relationshipDefinitionRecordWireSchema>,
): ContractDecodeResult<{
  relationship: CommerceRelationship;
  definition: RelationshipDefinition;
}> {
  const header = parseRelationshipHeader(relationship, {
    kind: "defined",
    origin: definition.origin,
  });
  if (!header.ok) return header;
  const parsedDefinition = parseRelationshipDefinitionRecord(definition);
  if (!parsedDefinition.ok) return parsedDefinition;
  const parsedRelationship = finishRelationship(header.value, {
    kind: "defined",
    definition: parsedDefinition.value,
  });
  if (!parsedRelationship.ok) return parsedRelationship;
  return {
    ok: true,
    value: {
      relationship: parsedRelationship.value,
      definition: parsedDefinition.value,
    },
  };
}

function parseRelationshipHeader(
  raw: Static<typeof commerceRelationshipWireSchema>,
  validation:
    | { kind: "shape" }
    | { kind: "defined"; origin: RelationshipDefinition["origin"] },
): ContractDecodeResult<RelationshipHeader> {
  if (validation.kind === "defined" && validation.origin !== raw.origin)
    return cursorRefusal("system_relationship_immutable");
  if (!Value.Check(relationshipId, raw.relationshipId))
    return identityRefusal("RelationshipId");
  if (validation.kind === "shape" || raw.origin === "custom") {
    const reference = parseRelationshipDefinitionRef(raw.definition);
    if (!reference.ok) return reference;
  }
  const source = parseCommerceEntityRef(raw.source);
  if (!source.ok) return source;
  const target = parseCommerceEntityRef(raw.target);
  if (!target.ok) return target;
  return {
    ok: true,
    value: { wire: raw, source: source.value, target: target.value },
  };
}

function finishRelationship(
  header: RelationshipHeader,
  validation: RelationshipValidation,
): ContractDecodeResult<CommerceRelationship> {
  const raw = header.wire;
  const source = header.source;
  const target = header.target;
  if (validation.kind === "shape" && raw.revision === 0)
    return invalidRevision("RelationshipRevision");
  if (sameEntity(source, target))
    return cursorRefusal("invalid_relationship_endpoint");
  if (validation.kind === "defined") {
    const definition = validation.definition;
    if (definition.origin === "system") {
      const expected = endpointTypes[definition.definitionId];
      if (
        source.origin !== "system" ||
        source.typeId !== expected.source ||
        target.origin !== "system" ||
        target.typeId !== expected.target
      )
        return cursorRefusal("invalid_relationship_endpoint");
    } else {
      if (
        source.origin !== definition.sourceType.origin ||
        source.typeId !== definition.sourceType.typeId ||
        target.origin !== definition.targetType.origin ||
        target.typeId !== definition.targetType.typeId
      )
        return cursorRefusal("invalid_relationship_endpoint");
    }
    if (
      raw.definition.definitionId !== definition.definitionId ||
      raw.definition.revision !== definition.revision ||
      raw.sensitivity !== definition.sensitivity
    )
      return cursorRefusal("relationship_definition_mismatch");
    if (raw.revision === 0) return invalidRevision("RelationshipRevision");
  } else if (raw.origin === "system") {
    const expected = endpointTypes[raw.definition.definitionId];
    if (source.typeId !== expected.source || target.typeId !== expected.target)
      return cursorRefusal("invalid_relationship_endpoint");
  }
  if (raw.origin === "system") {
    const provenance = parseEntityProvenance(raw.provenance);
    if (!provenance.ok) return provenance;
    const resourceType =
      source.typeId === "order" ? "commerce_order" : source.typeId;
    if (
      provenance.value.resourceId !== source.entityId ||
      provenance.value.resourceType !== resourceType
    )
      return cursorRefusal("provenance_identity_mismatch");
    return parseContract(
      systemCommerceRelationshipSchema,
      {
        origin: raw.origin,
        relationshipId: raw.relationshipId,
        definition: {
          origin: raw.definition.origin,
          definitionId: raw.definition.definitionId,
          revision: raw.definition.revision,
        },
        revision: raw.revision,
        sensitivity: raw.sensitivity,
        source,
        target,
        provenance: provenance.value,
      },
      invalidShape,
    );
  }
  return parseContract(
    customCommerceRelationshipSchema,
    {
      origin: raw.origin,
      relationshipId: raw.relationshipId,
      definition: {
        origin: raw.definition.origin,
        definitionId: raw.definition.definitionId,
        revision: raw.definition.revision,
      },
      revision: raw.revision,
      sensitivity: raw.sensitivity,
      source,
      target,
    },
    invalidShape,
  );
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}
function sameEntity(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

export type SystemCommerceRelationship = Static<
  typeof systemCommerceRelationshipSchema
>;
export type CustomCommerceRelationship = Static<
  typeof customCommerceRelationshipSchema
>;
export type SystemCommerceRelationshipRef = Static<
  typeof systemRelationshipRefSchema
>;
export type CustomCommerceRelationshipRef = Static<
  typeof customRelationshipRefSchema
>;
