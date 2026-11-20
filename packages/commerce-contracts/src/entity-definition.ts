import { Type } from "typebox";
import {
  parseEntityHeader,
  parseAssignment,
  finishCommerceEntity,
  type CommerceEntity,
  type AttributeValueAssignment,
} from "./entity-record.ts";
import { attributeDefinitionWireSchema } from "./entity-wire.ts";
import {
  parseAttributeDefinition,
  validateDefinedAttribute,
  definitionMismatch,
  invalidValue,
  type AttributeDefinition,
} from "./attribute-definition.ts";
import { cursorRefusal } from "./cursor-values.ts";
import {
  parseContract,
  contractRefusal,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";

const definitionsWire = Type.Array(attributeDefinitionWireSchema);
function invalidRequest() {
  return {
    code: "invalid_request",
    reason: "invalid entity definitions",
    details: null,
  };
}
export function parseCommerceEntity(
  input: unknown,
  definitionsInput: unknown,
): ContractDecodeResult<CommerceEntity> {
  // Missing request members fail before Rust deserializes either nested value.
  if (input === undefined || definitionsInput === undefined)
    return contractRefusal(invalidRequest());
  // Rust deserializes every definition before it deserializes the entity.
  const rawDefinitions = parseContract(
    definitionsWire,
    definitionsInput,
    invalidRequest,
  );
  if (!rawDefinitions.ok) return rawDefinitions;
  const header = parseEntityHeader(input);
  if (!header.ok) return header;
  const entity = header.value;
  const definitions = new Map<string, AttributeDefinition>();
  for (const input of rawDefinitions.value) {
    const parsed = parseAttributeDefinition(input);
    if (!parsed.ok) return parsed;
    if (definitions.has(parsed.value.id))
      return cursorRefusal("duplicate_identity");
    definitions.set(parsed.value.id, parsed.value);
  }
  for (const definition of definitions.values()) {
    const scope = definition.scope;
    if (
      scope.entityTypeId !== entity.reference.typeId ||
      (scope.kind === "custom") !== (entity.reference.origin === "custom") ||
      (scope.kind === "custom" &&
        scope.typeRevision !==
          ("typeRevision" in entity.wire ? entity.wire.typeRevision : null))
    )
      return definitionMismatch(definition.id);
  }
  const attributes: AttributeValueAssignment[] = [];
  const present = new Set<string>();
  for (const raw of entity.wire.attributes) {
    if (present.has(raw.attributeId))
      return cursorRefusal("duplicate_identity");
    present.add(raw.attributeId);
    const scope = raw.scope;
    if (
      scope.entityTypeId !== entity.reference.typeId ||
      (scope.kind === "custom") !== (entity.reference.origin === "custom") ||
      (scope.kind === "custom" &&
        scope.typeRevision !==
          ("typeRevision" in entity.wire ? entity.wire.typeRevision : null))
    )
      return definitionMismatch(raw.attributeId);
    const definition = definitions.get(raw.attributeId);
    if (definition === undefined) return definitionMismatch(raw.attributeId);
    if (
      scope.kind !== definition.scope.kind ||
      scope.entityTypeId !== definition.scope.entityTypeId
    )
      return definitionMismatch(raw.attributeId);
    if (
      scope.kind === "custom" &&
      definition.scope.kind === "custom" &&
      scope.typeRevision !== definition.scope.typeRevision
    )
      return definitionMismatch(raw.attributeId);
    if (
      scope.kind !== "custom" &&
      definition.scope.kind !== "custom" &&
      scope.schemaRevision !== definition.scope.schemaRevision
    )
      return definitionMismatch(raw.attributeId);
    const parsed = parseAssignment(raw);
    if (!parsed.ok) return parsed;
    const validated = validateDefinedAttribute(parsed.value, definition);
    if (!validated.ok) return validated;
    attributes.push(parsed.value);
  }
  for (const definition of definitions.values()) {
    if (definition.required && !present.has(definition.id))
      return invalidValue(definition.id);
  }
  return finishCommerceEntity(entity, attributes);
}
