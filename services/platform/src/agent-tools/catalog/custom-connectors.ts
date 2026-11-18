import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { parseCapabilityKey } from "../../authorization/access-grants/capability-key";
import type {
  CustomConnectorCatalogEntry,
  CustomConnectorReadCatalogEntry,
  CustomConnectorWriteCatalogEntry,
  CustomConnectorScalarConstraint,
  CustomConnectorSchema,
} from "../../custom-connectors";
import { assertNever } from "@seams/std";
import type { JsonSchema } from "./selection";
import type { HarnessToolDefinition } from "./types";

export function findCustomConnectorOperation(
  entries: readonly CustomConnectorCatalogEntry[],
  name: string,
): CustomConnectorCatalogEntry | null {
  for (const entry of entries) {
    if (entry.toolName === name) {
      return entry;
    }
  }
  return null;
}

export function customConnectorToolDefinition(
  entry: CustomConnectorCatalogEntry,
): HarnessToolDefinition {
  return {
    type: "function",
    name: entry.toolName,
    description:
      entry.operation.effect.kind === "read"
        ? `Custom API read: ${entry.description}`
        : `Custom API write proposal requiring human approval: ${entry.description}`,
    strict: true,
    parameters: customConnectorSchemaToJsonSchema(entry.inputSchema),
  };
}

export function customConnectorSchemaToJsonSchema(
  schema: CustomConnectorSchema,
): JsonSchema {
  switch (schema.kind) {
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        properties[name] = customConnectorSchemaToJsonSchema(property);
      }
      return {
        type: nullableJsonSchemaType("object", schema.nullable),
        properties,
        required: Object.keys(schema.properties).sort(),
        additionalProperties: false,
      };
    }
    case "array":
      return {
        type: nullableJsonSchemaType("array", schema.nullable),
        items: customConnectorSchemaToJsonSchema(schema.items),
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      };
    case "string":
      return {
        type: nullableJsonSchemaType("string", schema.nullable),
        minLength: schema.minLength,
        maxLength: schema.maxLength,
        ...customConnectorConstraintJsonSchema(schema.constraint),
      };
    case "integer":
    case "number":
      return {
        type: nullableJsonSchemaType(schema.kind, schema.nullable),
        ...(schema.minimum === null ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === null ? {} : { maximum: schema.maximum }),
        ...customConnectorConstraintJsonSchema(schema.constraint),
      };
    case "boolean":
      return {
        type: nullableJsonSchemaType("boolean", schema.nullable),
        ...customConnectorConstraintJsonSchema(schema.constraint),
      };
    case "null":
      return { type: "null" };
    default:
      return assertNever(schema);
  }
}

export function nullableJsonSchemaType(
  type: "object" | "array" | "string" | "integer" | "number" | "boolean",
  nullable: boolean,
): string | readonly string[] {
  return nullable ? [type, "null"] : type;
}

export function customConnectorConstraintJsonSchema(
  constraint: CustomConnectorScalarConstraint,
): JsonSchema {
  switch (constraint.kind) {
    case "none":
      return {};
    case "enum":
      return { enum: constraint.values };
    case "const":
      return { const: constraint.value };
    default:
      return assertNever(constraint);
  }
}

export function customConnectorCatalogPin(
  entry: CustomConnectorCatalogEntry,
): Readonly<Record<string, unknown>> {
  return {
    toolName: entry.toolName,
    capabilityKey: entry.capabilityKey,
    bindingRevision: entry.bindingRevision,
    credentialGeneration: entry.credentialGeneration,
    definitionDigest: entry.definitionDigest,
    grantIds: entry.grantIds,
    grantRevisions: entry.grantRevisions,
  };
}

export function isReadEntry(
  entry: CustomConnectorCatalogEntry,
): entry is CustomConnectorReadCatalogEntry {
  return entry.operation.effect.kind === "read";
}

export function isWriteEntry(
  entry: CustomConnectorCatalogEntry,
): entry is CustomConnectorWriteCatalogEntry {
  return entry.operation.effect.kind !== "read";
}

export function customConnectorCapabilityFromKey(
  scope: string,
):
  | typeof CAPABILITY_KEYS.customConnectorRead
  | typeof CAPABILITY_KEYS.customConnectorWrite
  | null {
  const parsed = parseCapabilityKey(scope);
  if (parsed.ok && parsed.value.kind === "custom_connector_operation") {
    if (parsed.value.capabilityId === CAPABILITY_KEYS.customConnectorRead) {
      return CAPABILITY_KEYS.customConnectorRead;
    }
    if (parsed.value.capabilityId === CAPABILITY_KEYS.customConnectorWrite) {
      return CAPABILITY_KEYS.customConnectorWrite;
    }
  }
  return null;
}
