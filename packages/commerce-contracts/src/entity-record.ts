import {
  systemCommerceEntityRefSchema,
  customCommerceEntityRefSchema,
  type CommerceEntityRef,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import {
  systemEntityTypeIdSchema,
  queryIdentitySchema,
  invalidShape,
  identityRefusal,
} from "./query-parts.ts";
import {
  PositiveInteger,
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
} from "./schema.ts";
import {
  entityWireSchema,
  type AttributeAssignmentWire,
  type EntityWire,
} from "./entity-wire.ts";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever, isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import {
  attributeValueSchema,
  parseAttributeValue,
} from "./attribute-value.ts";

import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { cursorRefusal } from "./cursor-values.ts";
import {
  commerceFreshnessSchema,
  customCommerceEntityStateSchema,
  sourceProvenanceSchema,
  parseCommerceFreshness,
  parseCustomCommerceEntityState,
  parseEntityProvenance,
} from "./entity-state.ts";

export function revisionSchema<Brand extends string>() {
  return Type.Unsafe<number & { readonly __brand: Brand }>(PositiveInteger);
}
export const commerceSensitivitySchema = Type.Enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export const attributeDefinitionScopeSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("system"),
    entityTypeId: systemEntityTypeIdSchema.properties.typeId,
    schemaRevision: revisionSchema<"SystemSchemaRevision">(),
  }),
  OpenObject({
    kind: Type.Literal("merchant_extension"),
    entityTypeId: systemEntityTypeIdSchema.properties.typeId,
    schemaRevision: revisionSchema<"MerchantExtensionSchemaRevision">(),
  }),
  OpenObject({
    kind: Type.Literal("custom"),
    entityTypeId: queryIdentitySchema<"CustomCommerceEntityTypeId">(),
    typeRevision: revisionSchema<"CustomEntityTypeRevision">(),
  }),
]);
export const attributeValueAssignmentSchema = StrictObject({
  attributeId: queryIdentitySchema<"AttributeDefinitionId">(),
  scope: attributeDefinitionScopeSchema,
  definitionRevision: revisionSchema<"AttributeDefinitionRevision">(),
  sensitivity: commerceSensitivitySchema,
  value: attributeValueSchema,
});
export type AttributeValueAssignment = StaticDecode<
  typeof attributeValueAssignmentSchema
>;
export function parseAssignment(
  item: AttributeAssignmentWire,
): ContractDecodeResult<AttributeValueAssignment> {
  const attributeId = item.attributeId;
  if (
    !Value.Check(
      attributeValueAssignmentSchema.properties.attributeId,
      attributeId,
    )
  )
    return identityRefusal("AttributeDefinitionId");
  const parsedScope = parseAttributeScope(item.scope, attributeId);
  if (!parsedScope.ok) return parsedScope;
  const scope = parsedScope.value;
  const definitionRevision = item.definitionRevision;
  if (
    !Value.Check(
      attributeValueAssignmentSchema.properties.definitionRevision,
      definitionRevision,
    )
  )
    return invalidRevision("AttributeDefinitionRevision");
  const value = parseAttributeValue(item.value);
  if (!value.ok) return value;
  return {
    ok: true,
    value: {
      attributeId,
      scope,
      definitionRevision,
      sensitivity: item.sensitivity,
      value: value.value,
    },
  };
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}
const common = {
  revision: revisionSchema<"CommerceEntityRevision">(),
  displayName: Type.String(),
  attributes: Type.Array(attributeValueAssignmentSchema),
};
const systemCommerceEntitySchema = OpenObject({
  reference: systemCommerceEntityRefSchema,
  ...common,
  provenance: sourceProvenanceSchema,
  freshness: commerceFreshnessSchema,
});
const customCommerceEntitySchema = OpenObject({
  reference: customCommerceEntityRefSchema,
  ...common,
  typeRevision: revisionSchema<"CustomEntityTypeRevision">(),
  state: customCommerceEntityStateSchema,
  sensitivity: commerceSensitivitySchema,
});
export const commerceEntitySchema = Type.Union([
  systemCommerceEntitySchema,
  customCommerceEntitySchema,
]);
export type CommerceEntity = StrictUnion<
  StaticDecode<typeof commerceEntitySchema>
>;
export function isCustomCommerceEntity(
  entity: CommerceEntity,
): entity is Extract<CommerceEntity, { reference: { origin: "custom" } }> {
  return entity.reference.origin === "custom";
}
export function isSystemCommerceEntity(
  entity: CommerceEntity,
): entity is Extract<CommerceEntity, { reference: { origin: "system" } }> {
  return entity.reference.origin === "system";
}
type EntityHeader =
  | {
      kind: "system";
      wire: Extract<EntityWire, { reference: { origin: "system" } }>;
      reference: Extract<CommerceEntityRef, { origin: "system" }>;
    }
  | {
      kind: "custom";
      wire: Extract<EntityWire, { reference: { origin: "custom" } }>;
      reference: Extract<CommerceEntityRef, { origin: "custom" }>;
    };
export function parseEntityHeader(
  input: unknown,
): ContractDecodeResult<EntityHeader> {
  const raw = parseContract(entityWireSchema, input, invalidShape);
  if (!raw.ok) return raw;
  const reference = parseCommerceEntityRef(raw.value.reference);
  if (!reference.ok) return reference;
  if (raw.value.revision === 0)
    return invalidRevision("CommerceEntityRevision");
  if ("typeRevision" in raw.value && raw.value.typeRevision === 0)
    return invalidRevision("CustomEntityTypeRevision");
  if (!Value.Check(trimmedIdentityTextSchema, raw.value.displayName))
    return cursorRefusal("invalid_text", { field: "entity.display_name" });
  if (reference.value.origin === "system" && "provenance" in raw.value)
    return {
      ok: true,
      value: { kind: "system", wire: raw.value, reference: reference.value },
    };
  if (reference.value.origin === "custom" && "state" in raw.value)
    return {
      ok: true,
      value: { kind: "custom", wire: raw.value, reference: reference.value },
    };
  return cursorRefusal("parse");
}
export function parseCommerceEntityShape(
  input: unknown,
): ContractDecodeResult<CommerceEntity> {
  const header = parseEntityHeader(input);
  if (!header.ok) return header;
  const raw = header.value.wire;
  const reference = header.value.reference;
  const attributes: AttributeValueAssignment[] = [];
  const ids = new Set<string>();
  for (const value of raw.attributes) {
    const parsed = parseAssignment(value);
    if (!parsed.ok) return parsed;
    const attribute = parsed.value;
    if (ids.has(attribute.attributeId))
      return cursorRefusal("duplicate_identity");
    ids.add(attribute.attributeId);
    const scope = attribute.scope;
    if (
      scope.entityTypeId !== reference.typeId ||
      (scope.kind === "custom") !== (reference.origin === "custom") ||
      (scope.kind === "custom" &&
        scope.typeRevision !==
          ("typeRevision" in raw ? raw.typeRevision : null))
    )
      return cursorRefusal("attribute_definition_mismatch", {
        attributeId: attribute.attributeId,
      });
    attributes.push(attribute);
  }
  return finishCommerceEntity(header.value, attributes);
}

export function finishCommerceEntity(
  header: EntityHeader,
  attributes: AttributeValueAssignment[],
): ContractDecodeResult<CommerceEntity> {
  const raw = header.wire;
  const reference = header.reference;
  if (reference.origin === "system" && "provenance" in raw) {
    const provenance = parseEntityProvenance(raw.provenance);
    if (!provenance.ok) return provenance;
    const resourceType =
      reference.typeId === "order" ? "commerce_order" : reference.typeId;
    if (
      provenance.value.resourceType !== resourceType ||
      provenance.value.resourceId !== reference.entityId
    )
      return cursorRefusal("provenance_identity_mismatch");
    const freshness = parseCommerceFreshness(raw.freshness);
    if (!freshness.ok) return freshness;
    const revision = parseContract(common.revision, raw.revision, invalidShape);
    if (!revision.ok) return revision;
    return {
      ok: true,
      value: {
        reference: reference,
        revision: revision.value,
        displayName: raw.displayName,
        attributes,
        provenance: provenance.value,
        freshness: freshness.value,
      },
    };
  }
  if (reference.origin !== "custom" || !("state" in raw))
    return cursorRefusal("parse");
  const state = parseCustomCommerceEntityState(raw.state);
  if (!state.ok) return state;
  const revision = parseContract(common.revision, raw.revision, invalidShape);
  if (!revision.ok) return revision;
  const typeRevision = parseContract(
    customCommerceEntitySchema.properties.typeRevision,
    raw.typeRevision,
    invalidShape,
  );
  if (!typeRevision.ok) return typeRevision;
  return {
    ok: true,
    value: {
      reference: reference,
      revision: revision.value,
      displayName: raw.displayName,
      attributes,
      typeRevision: typeRevision.value,
      state: state.value,
      sensitivity: raw.sensitivity,
    },
  };
}

function normalizeScope(
  scope: AttributeValueAssignment["scope"],
): AttributeValueAssignment["scope"] {
  switch (scope.kind) {
    case "custom":
      return {
        kind: "custom",
        entityTypeId: scope.entityTypeId,
        typeRevision: scope.typeRevision,
      };
    case "system":
      return {
        kind: "system",
        entityTypeId: scope.entityTypeId,
        schemaRevision: scope.schemaRevision,
      };
    case "merchant_extension":
      return {
        kind: "merchant_extension",
        entityTypeId: scope.entityTypeId,
        schemaRevision: scope.schemaRevision,
      };
    default:
      return assertNever(scope);
  }
}

export function parseAttributeScope(
  input: unknown,
  attributeId: string,
): ContractDecodeResult<AttributeValueAssignment["scope"]> {
  if (
    isRecord(input) &&
    input.kind === "custom" &&
    typeof input.entityTypeId === "string" &&
    !Value.Check(trimmedIdentityTextSchema, input.entityTypeId)
  )
    return identityRefusal("CustomCommerceEntityTypeId");
  if (isRecord(input)) {
    if (input.kind === "custom" && input.typeRevision === 0)
      return invalidRevision("CustomEntityTypeRevision");
    if (input.kind === "system" && input.schemaRevision === 0)
      return invalidRevision("SystemSchemaRevision");
    if (input.kind === "merchant_extension" && input.schemaRevision === 0)
      return invalidRevision("MerchantExtensionSchemaRevision");
  }
  const parsedScope = parseContract(
    attributeDefinitionScopeSchema,
    input,
    invalidShape,
  );
  if (!parsedScope.ok) return parsedScope;
  const scope = parsedScope.value;
  if (scope.kind !== "custom") {
    if (scope.kind === "system" && attributeId.startsWith("ext_"))
      return cursorRefusal("invalid_attribute_namespace", {
        attributeId: attributeId,
      });
    if (scope.kind === "merchant_extension" && !attributeId.startsWith("ext_"))
      return cursorRefusal("system_attribute_shadowing", {
        attributeId: attributeId,
      });
  }
  return { ok: true, value: normalizeScope(scope) };
}
