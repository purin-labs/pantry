import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  SafeInteger as integer,
} from "@purin-labs/contract-schema";
import { attributeDefinitionWireSchema } from "./entity-wire.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "@purin-labs/contract-schema/sorted-unions";
import { assertNever, codePointCount, isRecord } from "@purin-labs/std";
import {
  attributeDefinitionScopeSchema,
  commerceSensitivitySchema,
  revisionSchema,
  parseAttributeScope,
  type AttributeValueAssignment,
} from "./entity-record.ts";
import {
  queryIdentitySchema,
  invalidShape,
  identityRefusal,
} from "./query-parts.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";

import { cursorRefusal } from "./cursor-values.ts";

const decimal = OpenObject({
  unscaled: integer,
  scale: Type.Integer({ minimum: 0, maximum: 255 }),
});
const option = OpenObject({
  id: queryIdentitySchema<"AttributeOptionId">(),
  label: Type.String(),
});
export const attributeDefinitionKindSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("short_text"),
    maxLength: Type.Integer({ minimum: 0, maximum: 65535 }),
  }),
  OpenObject({
    kind: Type.Literal("long_text"),
    maxLength: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
  }),
  OpenObject({
    kind: Type.Literal("integer"),
    minimum: Type.Union([integer, Type.Null()]),
    maximum: Type.Union([integer, Type.Null()]),
  }),
  OpenObject({
    kind: Type.Literal("decimal"),
    scale: Type.Integer({ minimum: 0, maximum: 255 }),
    minimum: Type.Union([decimal, Type.Null()]),
    maximum: Type.Union([decimal, Type.Null()]),
  }),
  OpenObject({ kind: Type.Literal("boolean") }),
  OpenObject({ kind: Type.Literal("date") }),
  OpenObject({ kind: Type.Literal("timestamp") }),
  OpenObject({ kind: Type.Literal("status"), options: Type.Array(option) }),
  OpenObject({
    kind: Type.Literal("choice"),
    options: Type.Array(option),
    allowsMultiple: Type.Boolean(),
  }),
  OpenObject({
    kind: Type.Literal("money"),
    allowedCurrencies: Type.Array(Type.String()),
  }),
  OpenObject({ kind: Type.Literal("merchant_operator_reference") }),
  OpenObject({ kind: Type.Literal("external_resource_reference") }),
]);
export const attributeDefinitionSchema = StrictObject({
  id: queryIdentitySchema<"AttributeDefinitionId">(),
  scope: attributeDefinitionScopeSchema,
  label: Type.String(),
  helpText: Type.Union([Type.String(), Type.Null()]),
  required: Type.Boolean(),
  sensitivity: commerceSensitivitySchema,
  kind: attributeDefinitionKindSchema,
  revision: revisionSchema<"AttributeDefinitionRevision">(),
});
export type AttributeDefinition = Static<typeof attributeDefinitionSchema>;

export function parseAttributeDefinition(
  input: unknown,
): ContractDecodeResult<AttributeDefinition> {
  const wire = parseContract(
    attributeDefinitionWireSchema,
    input,
    invalidShape,
  );
  if (!wire.ok) return wire;
  if (!isRecord(input)) return cursorRefusal("parse");
  const normalizedKind = normalizeKind(input.kind);
  const normalized = {
    ...input,
    helpText: input.helpText ?? null,
    kind: normalizedKind,
  };
  if (
    typeof input.id === "string" &&
    !Value.Check(trimmedIdentityTextSchema, input.id)
  )
    return identityRefusal("AttributeDefinitionId");
  if (input.revision === 0)
    return cursorRefusal("invalid_revision", {
      field: "AttributeDefinitionRevision",
    });
  if (typeof input.id !== "string") return cursorRefusal("parse");
  const scope = parseAttributeScope(input.scope, input.id);
  if (!scope.ok) return scope;
  const definition = wire.value;
  if (!Value.Check(trimmedIdentityTextSchema, definition.label))
    return cursorRefusal("invalid_text", {
      field: "attribute_definition.label",
    });
  if (
    definition.helpText != null &&
    definition.helpText !== "" &&
    !Value.Check(trimmedIdentityTextSchema, definition.helpText)
  )
    return cursorRefusal("invalid_text", {
      field: "attribute_definition.help_text",
    });
  const kind = definition.kind;
  switch (kind.kind) {
    case "short_text":
    case "long_text":
      if (kind.maxLength === 0) return invalidValue(`${kind.kind}.max_length`);
      break;
    case "decimal":
      if (kind.scale > 6) return invalidValue("decimal.scale");
      if (
        kind.minimum != null &&
        kind.maximum != null &&
        (kind.minimum.scale !== kind.maximum.scale ||
          kind.minimum.unscaled > kind.maximum.unscaled)
      )
        return invalidValue("decimal.bounds");
      break;
    case "status":
    case "choice": {
      if (kind.options.length === 0) return invalidValue("options");
      const seen = new Set<string>();
      for (const option of kind.options) {
        if (!Value.Check(trimmedIdentityTextSchema, option.id))
          return identityRefusal("attribute_option_id");
        if (!Value.Check(trimmedIdentityTextSchema, option.label))
          return cursorRefusal("invalid_text", {
            field: "attribute_option.label",
          });
        if (seen.has(option.id)) return cursorRefusal("duplicate_identity");
        seen.add(option.id);
      }
      break;
    }
    case "money":
      if (kind.allowedCurrencies.length === 0)
        return invalidValue("money.allowed_currencies");
      for (const currency of kind.allowedCurrencies)
        if (!/^[A-Z]{3}$/.test(currency))
          return invalidValue("money.allowed_currencies");
      break;
    case "integer":
    case "boolean":
    case "date":
    case "timestamp":
    case "merchant_operator_reference":
    case "external_resource_reference":
      break;
    default:
      return assertNever(kind);
  }
  const typed = parseContract(
    attributeDefinitionSchema,
    normalized,
    invalidShape,
  );
  if (!typed.ok) return typed;
  // Value.Clean removes fields that serde ignores inside definition kinds.
  const cleanKind = cleanValue(
    attributeDefinitionKindSchema,
    Value.Clone(typed.value.kind),
  );
  if (!Value.Check(attributeDefinitionKindSchema, cleanKind))
    return cursorRefusal("parse");
  return {
    ok: true,
    value: {
      id: typed.value.id,
      scope: scope.value,
      label: definition.label,
      helpText: typed.value.helpText,
      required: definition.required,
      sensitivity: definition.sensitivity,
      kind: cleanKind,
      revision: typed.value.revision,
    },
  };
}
function normalizeKind(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if (input.kind === "integer" || input.kind === "decimal")
    return {
      ...input,
      minimum: input.minimum ?? null,
      maximum: input.maximum ?? null,
    };
  return input;
}
export function invalidValue(attributeId: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_attribute_value", { attributeId });
}
export function definitionMismatch(
  attributeId: string,
): ContractDecodeResult<never> {
  return cursorRefusal("attribute_definition_mismatch", { attributeId });
}
function sameScope(
  left: AttributeDefinition["scope"],
  right: AttributeDefinition["scope"],
): boolean {
  if (left.kind !== right.kind || left.entityTypeId !== right.entityTypeId)
    return false;
  if (left.kind === "custom" && right.kind === "custom")
    return left.typeRevision === right.typeRevision;
  if (left.kind !== "custom" && right.kind !== "custom")
    return left.schemaRevision === right.schemaRevision;
  return false;
}
export function validateDefinedAttribute(
  assignment: AttributeValueAssignment,
  definition: AttributeDefinition,
): ContractDecodeResult<null> {
  if (
    !sameScope(assignment.scope, definition.scope) ||
    assignment.definitionRevision !== definition.revision ||
    assignment.sensitivity !== definition.sensitivity ||
    assignment.value.kind !== definition.kind.kind
  )
    return definitionMismatch(assignment.attributeId);
  const value = assignment.value;
  const kind = definition.kind;
  let valid = true;
  switch (kind.kind) {
    case "short_text":
    case "long_text":
      if (value.kind === "short_text" || value.kind === "long_text")
        valid = codePointCount(value.value) <= kind.maxLength;
      break;
    case "integer":
      if (value.kind === "integer")
        valid =
          (kind.minimum === null || value.value >= BigInt(kind.minimum)) &&
          (kind.maximum === null || value.value <= BigInt(kind.maximum));
      break;
    case "decimal":
      if (value.kind === "decimal")
        valid =
          value.value.scale === kind.scale &&
          (kind.minimum === null ||
            value.value.unscaled >= kind.minimum.unscaled) &&
          (kind.maximum === null ||
            value.value.unscaled <= kind.maximum.unscaled);
      break;
    case "status":
      if (value.kind === "status") valid = hasOption(kind.options, value.value);
      break;
    case "choice":
      if (value.kind === "choice") {
        valid = kind.allowsMultiple || value.values.length === 1;
        for (const id of value.values)
          if (!hasOption(kind.options, id)) valid = false;
      }
      break;
    case "money":
      if (value.kind === "money")
        valid = kind.allowedCurrencies.includes(value.value.currency);
      break;
    case "boolean":
    case "date":
    case "timestamp":
    case "merchant_operator_reference":
    case "external_resource_reference":
      break;
    default:
      return assertNever(kind);
  }
  return valid
    ? { ok: true, value: null }
    : invalidValue(assignment.attributeId);
}
function hasOption(options: { id: string }[], id: string): boolean {
  for (const option of options) if (option.id === id) return true;
  return false;
}
