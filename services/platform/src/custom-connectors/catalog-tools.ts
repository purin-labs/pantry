import { assertNever } from "@purin-labs/std";
import type { TurnTool } from "../agent-tools/catalog/tool-registry";
import { jsonSchema } from "../agent-tools/define-tool";
import { defineIntegrationTool } from "../agent-tools/integrations/services";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import type {
  CustomConnectorScalarConstraint,
  CustomConnectorSchema,
} from "./definition";
import type {
  CustomConnectorCatalogEntry,
  CustomConnectorReadCatalogEntry,
  CustomConnectorWriteCatalogEntry,
} from "./grants";

type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * The catalog tool of one custom connector operation, for a turn whose
 * grants select it. A read claims the read capability and returns the
 * response; any other operation claims the write capability and stages a
 * proposal that a person approves. The pin names the revisions that the
 * definition came from, so a changed binding changes the catalog digest.
 */
export function customConnectorTurnTool(
  entry: CustomConnectorCatalogEntry,
): TurnTool {
  const parameters = customConnectorSchemaToJsonSchema(entry.inputSchema);
  const common = {
    name: entry.toolName,
    input: jsonSchema(parameters),
    parameters,
    // The connector checks the input against the operation's own schema.
    decodeOnly: true,
    decode: (input: unknown) => input,
    // The outcome of a repeated call is not proven.
    rerun: { kind: "none" },
  } as const;
  const tool = isReadEntry(entry)
    ? defineIntegrationTool({
        ...common,
        description: `Custom API read: ${entry.description}`,
        effect: "read",
        selection: {
          kind: "capability",
          capability: CAPABILITY_KEYS.customConnectorRead,
        },
        unavailable: "Custom connector reading is unavailable",
        handler: ({ readCustomConnector }) =>
          readCustomConnector === undefined
            ? undefined
            : (input, call) =>
                readCustomConnector(entry, input, `direct_tool:${call.callId}`),
      })
    : writeProposalTool(entry, common);
  return {
    tool,
    pin: {
      toolName: entry.toolName,
      capabilityKey: entry.capabilityKey,
      bindingRevision: entry.bindingRevision,
      credentialGeneration: entry.credentialGeneration,
      definitionDigest: entry.definitionDigest,
      grantIds: entry.grantIds,
      grantRevisions: entry.grantRevisions,
    },
  };
}

function writeProposalTool(
  entry: CustomConnectorCatalogEntry,
  common: Readonly<{
    name: string;
    input: ReturnType<typeof jsonSchema>;
    parameters: JsonSchema;
    decodeOnly: true;
    decode: (input: unknown) => unknown;
    rerun: { readonly kind: "none" };
  }>,
) {
  if (!isWriteEntry(entry)) {
    throw new Error(`${entry.toolName} is not a write operation`);
  }
  return defineIntegrationTool({
    ...common,
    description: `Custom API write proposal requiring human approval: ${entry.description}`,
    effect: "proposal",
    selection: {
      kind: "capability",
      capability: CAPABILITY_KEYS.customConnectorWrite,
    },
    unavailable: "Custom connector write proposals are unavailable",
    handler: ({ proposeCustomConnectorWrite }) =>
      proposeCustomConnectorWrite === undefined
        ? undefined
        : (input, call) =>
            proposeCustomConnectorWrite(
              entry,
              input,
              `direct_tool:${call.callId}`,
            ),
  });
}

function isWriteEntry(
  entry: CustomConnectorCatalogEntry,
): entry is CustomConnectorWriteCatalogEntry {
  return entry.operation.effect.kind !== "read";
}

function isReadEntry(
  entry: CustomConnectorCatalogEntry,
): entry is CustomConnectorReadCatalogEntry {
  return entry.operation.effect.kind === "read";
}

function customConnectorSchemaToJsonSchema(
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

function nullableJsonSchemaType(
  type: "object" | "array" | "string" | "integer" | "number" | "boolean",
  nullable: boolean,
): string | readonly string[] {
  return nullable ? [type, "null"] : type;
}

function customConnectorConstraintJsonSchema(
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
