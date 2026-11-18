import type {
  AttributeDefinition,
  AttributeValue,
  AttributeValueAssignment,
  CommerceEntityPlaneError,
  CommerceEntityTypeId,
  CommerceList,
  ListEntryAttributeDefinition,
  ListEntryAttributeValue,
} from "@seams/commerce-contracts";

export function validateEntityAttributes(
  definitions: readonly AttributeDefinition[],
  values: readonly AttributeValueAssignment[],
): CommerceEntityPlaneError | undefined {
  const byId = new Map(
    definitions.map((definition) => [String(definition.id), definition]),
  );
  const seen = new Set<string>();
  for (const entry of values) {
    const attributeId = String(entry.attributeId);
    if (!seen.add(attributeId)) return { code: "duplicate_identity" };
    const definition = byId.get(attributeId);
    if (
      definition === undefined ||
      Number(definition.revision) !== Number(entry.definitionRevision)
    ) {
      return { code: "attribute_definition_mismatch", attributeId };
    }
    if (
      !sameAttributeScope(entry.scope, definition.scope) ||
      entry.sensitivity !== definition.sensitivity
    ) {
      return { code: "attribute_definition_mismatch", attributeId };
    }
    if (!valueMatchesDefinition(definition, entry.value)) {
      return { code: "invalid_attribute_value", attributeId };
    }
  }
  for (const definition of definitions) {
    if (definition.required && !seen.has(String(definition.id))) {
      return {
        code: "invalid_attribute_value",
        attributeId: String(definition.id),
      };
    }
  }
  return undefined;
}

export function validateListEntryAttributes(
  list: CommerceList,
  values: readonly ListEntryAttributeValue[],
): CommerceEntityPlaneError | undefined {
  const definitions = list.entryAttributeDefinitions;
  const byId = new Map(
    definitions.map((entry) => [String(entry.attributeId), entry.definition]),
  );
  const seen = new Set<string>();
  for (const entry of values) {
    const attributeId = String(entry.attributeId);
    if (!seen.add(attributeId)) return { code: "duplicate_identity" };
    const definition = byId.get(attributeId);
    if (
      definition === undefined ||
      Number(definition.revision) !== Number(entry.definitionRevision)
    ) {
      return { code: "attribute_definition_mismatch", attributeId };
    }
    if (
      !sameAttributeScope(entry.scope, definition.scope) ||
      entry.sensitivity !== definition.sensitivity
    ) {
      return { code: "attribute_definition_mismatch", attributeId };
    }
    if (!valueMatchesDefinition(definition, entry.value)) {
      return { code: "invalid_attribute_value", attributeId };
    }
  }
  for (const entry of definitions) {
    if (entry.definition.required && !seen.has(String(entry.attributeId))) {
      return {
        code: "invalid_attribute_value",
        attributeId: String(entry.attributeId),
      };
    }
  }
  return undefined;
}

export function listAttributeDefinitionMismatch(
  definitions: readonly ListEntryAttributeDefinition[],
  owner: CommerceEntityTypeId,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of definitions) {
    const attributeId = String(entry.attributeId);
    if (
      !seen.add(attributeId) ||
      entry.definition.id !== entry.attributeId ||
      !scopeMatchesEntityType(entry.definition.scope, owner)
    ) {
      return attributeId;
    }
  }
  return undefined;
}

function valueMatchesDefinition(
  definition: AttributeDefinition,
  value: AttributeValue,
): boolean {
  if (definition.kind.kind !== value.kind) return false;
  switch (definition.kind.kind) {
    case "short_text":
      return (
        value.kind === "short_text" &&
        value.value.length <= definition.kind.maxLength
      );
    case "long_text":
      return (
        value.kind === "long_text" &&
        value.value.length <= definition.kind.maxLength
      );
    case "integer":
      return (
        value.kind === "integer" &&
        integerWithin(
          Number(value.value),
          definition.kind.minimum,
          definition.kind.maximum,
        )
      );
    case "decimal":
      return (
        value.kind === "decimal" && value.value.scale === definition.kind.scale
      );
    case "boolean":
      return value.kind === "boolean";
    case "date":
      return value.kind === "date";
    case "timestamp":
      return value.kind === "timestamp";
    case "merchant_operator_reference":
      return value.kind === "merchant_operator_reference";
    case "external_resource_reference":
      return value.kind === "external_resource_reference";
    case "status":
      return (
        value.kind === "status" &&
        definition.kind.options.some((option) => option.id === value.value)
      );
    case "choice": {
      const options = definition.kind.options;
      return (
        value.kind === "choice" &&
        options !== undefined &&
        value.values.every((entry) =>
          options.some((option) => option.id === entry),
        ) &&
        (definition.kind.allowsMultiple || value.values.length === 1)
      );
    }
    case "money":
      return (
        value.kind === "money" &&
        (definition.kind.allowedCurrencies.length === 0 ||
          definition.kind.allowedCurrencies.includes(value.value.currency))
      );
  }
}

function sameAttributeScope(
  left: AttributeDefinition["scope"],
  right: AttributeDefinition["scope"],
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "system":
      return (
        right.kind === "system" &&
        left.entityTypeId === right.entityTypeId &&
        Number(left.schemaRevision) === Number(right.schemaRevision)
      );
    case "merchant_extension":
      return (
        right.kind === "merchant_extension" &&
        left.entityTypeId === right.entityTypeId &&
        Number(left.schemaRevision) === Number(right.schemaRevision)
      );
    case "custom":
      return (
        right.kind === "custom" &&
        left.entityTypeId === right.entityTypeId &&
        Number(left.typeRevision) === Number(right.typeRevision)
      );
  }
}

function scopeMatchesEntityType(
  scope: AttributeDefinition["scope"],
  owner: CommerceEntityTypeId,
): boolean {
  switch (scope.kind) {
    case "system":
    case "merchant_extension":
      return owner.origin === "system" && owner.typeId === scope.entityTypeId;
    case "custom":
      return owner.origin === "custom" && owner.typeId === scope.entityTypeId;
  }
}

function integerWithin(
  value: number,
  minimum: number | null,
  maximum: number | null,
): boolean {
  return (
    (minimum === null || value >= minimum) &&
    (maximum === null || value <= maximum)
  );
}
