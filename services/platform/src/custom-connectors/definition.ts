import type { CommerceSensitivity } from "@purin-labs/commerce-contracts";
import type { JsonRecord } from "@purin-labs/control/worker/http";
import {
  digestCanonical,
  serializeCanonical,
} from "@purin-labs/authority/policy/information-flow/digest";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseCustomConnectorDefinitionDigest,
  type CustomConnectorDefinitionDigest,
} from "@purin-labs/connections/custom-connectors/identity";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";
import {
  assertNever,
  isNonNegativeInteger,
  isRecord,
  isSha256Hex,
} from "@purin-labs/std";
import { isCommerceSensitivity } from "../commerce/contract/sensitivity";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type CustomConnectorAuthentication =
  | { readonly kind: "bearer"; readonly name?: never }
  | { readonly kind: "basic_api_key"; readonly name?: never }
  | { readonly kind: "header"; readonly name: string };

export type CustomConnectorSchema =
  | CustomConnectorObjectSchema
  | CustomConnectorArraySchema
  | CustomConnectorStringSchema
  | CustomConnectorNumberSchema
  | CustomConnectorBooleanSchema
  | CustomConnectorNullSchema;

export type CustomConnectorObjectSchema = {
  readonly kind: "object";
  readonly nullable: boolean;
  readonly properties: Readonly<Record<string, CustomConnectorSchema>>;
  readonly required: readonly string[];
};

type CustomConnectorArraySchema = {
  readonly kind: "array";
  readonly nullable: boolean;
  readonly items: CustomConnectorSchema;
  readonly minItems: number;
  readonly maxItems: number;
};

type CustomConnectorStringSchema = {
  readonly kind: "string";
  readonly nullable: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly constraint: CustomConnectorScalarConstraint;
};

type CustomConnectorNumberSchema = {
  readonly kind: "integer" | "number";
  readonly nullable: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly constraint: CustomConnectorScalarConstraint;
};

type CustomConnectorBooleanSchema = {
  readonly kind: "boolean";
  readonly nullable: boolean;
  readonly constraint: CustomConnectorScalarConstraint;
};

export type CustomConnectorScalarConstraint =
  | { readonly kind: "none"; readonly values?: never; readonly value?: never }
  | {
      readonly kind: "enum";
      readonly values: readonly JsonPrimitive[];
      readonly value?: never;
    }
  | {
      readonly kind: "const";
      readonly value: JsonPrimitive;
      readonly values?: never;
    };

type CustomConnectorNullSchema = {
  readonly kind: "null";
};

export type CustomConnectorValueBinding =
  | { readonly kind: "input"; readonly field: string; readonly value?: never }
  | {
      readonly kind: "constant";
      readonly value: JsonValue;
      readonly field?: never;
    };

export type CustomConnectorRestTransport =
  | {
      readonly kind: "get";
      readonly pathTemplate: string;
      readonly pathBindings: Readonly<
        Record<string, CustomConnectorValueBinding>
      >;
      readonly queryBindings: Readonly<
        Record<string, CustomConnectorValueBinding>
      >;
      readonly bodyBindings?: never;
    }
  | {
      readonly kind: "post_json";
      readonly pathTemplate: string;
      readonly pathBindings: Readonly<
        Record<string, CustomConnectorValueBinding>
      >;
      readonly queryBindings: Readonly<
        Record<string, CustomConnectorValueBinding>
      >;
      readonly bodyBindings: Readonly<
        Record<string, CustomConnectorValueBinding>
      >;
    };

export type CustomConnectorMcpTransport = {
  readonly kind: "mcp";
  readonly endpointPath: string;
  readonly toolName: string;
  readonly pathTemplate?: never;
  readonly pathBindings?: never;
  readonly queryBindings?: never;
  readonly bodyBindings?: never;
};

type CustomConnectorOperationTransport =
  CustomConnectorRestTransport | CustomConnectorMcpTransport;

type CustomConnectorPagination =
  | {
      readonly kind: "none";
      readonly cursorInput?: never;
      readonly nextCursorPointer?: never;
    }
  | {
      readonly kind: "cursor";
      readonly cursorInput: string;
      readonly nextCursorPointer: string;
    };

/**
 * `single_attempt` sends a write once. `provider_idempotent` sends a stable
 * key in the named header, so an administrator can retry a write whose
 * outcome is unknown; the service must apply one write for each key.
 */
type CustomConnectorWriteRetryPolicy =
  | Readonly<{ readonly kind: "single_attempt"; readonly header?: never }>
  | Readonly<{ readonly kind: "provider_idempotent"; readonly header: string }>;

type CustomConnectorOperationEffect =
  | Readonly<{
      readonly kind: "read";
      readonly retryPolicy?: never;
      readonly resourceIdentityInput?: never;
    }>
  | Readonly<{
      readonly kind: "external_record_create";
      readonly retryPolicy: CustomConnectorWriteRetryPolicy;
      readonly resourceIdentityInput?: never;
    }>
  | Readonly<{
      readonly kind: "external_record_update";
      readonly retryPolicy: CustomConnectorWriteRetryPolicy;
      readonly resourceIdentityInput: string;
    }>;

type CustomConnectorResponse = {
  readonly successStatuses: readonly number[];
  readonly resultPointer: string;
  readonly outputSchema: CustomConnectorSchema;
  readonly classification: CommerceSensitivity;
};

export type CustomConnectorOperation = {
  readonly id: string;
  readonly description: string;
  readonly effect: CustomConnectorOperationEffect;
  readonly inputSchema: CustomConnectorObjectSchema;
  readonly transport: CustomConnectorOperationTransport;
  readonly response: CustomConnectorResponse;
  readonly pagination: CustomConnectorPagination;
};

export type CustomConnectorDefinitionLimits = {
  readonly argumentBytes: number;
  readonly bodyBytes: number;
  readonly wireBytes: number;
  readonly decodedBytes: number;
  readonly modelResultBytes: number;
  readonly attemptTimeoutMs: number;
  readonly invocationTimeoutMs: number;
};

type MutableCustomConnectorDefinitionLimits = {
  -readonly [
    Key in keyof CustomConnectorDefinitionLimits
  ]: CustomConnectorDefinitionLimits[Key];
};

export type CustomConnectorDefinitionV1 = {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly authentication: CustomConnectorAuthentication;
  readonly documentation: readonly {
    readonly url: string;
    readonly sha256: string;
  }[];
  readonly operations: readonly CustomConnectorOperation[];
  readonly identity: {
    readonly operationId: string;
    readonly arguments: JsonObject;
    readonly accountIdPointer: string;
    readonly displayNamePointer: string;
  };
  readonly limits: CustomConnectorDefinitionLimits;
};

export type ParsedCustomConnectorDefinition = {
  readonly definition: CustomConnectorDefinitionV1;
  readonly canonicalJson: string;
  readonly digest: CustomConnectorDefinitionDigest;
};

export type CustomConnectorDefinitionError =
  | {
      readonly code: "definition_too_large";
      readonly maxBytes: number;
    }
  | {
      readonly code: "definition_invalid";
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly code: "unsupported_contract";
      readonly field: string;
      readonly reason: string;
    };

type SchemaType =
  "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

const OPERATION_ID = /^[a-z][a-z0-9_]{0,47}$/u;
const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const PATH_PARAMETER = /^\{([A-Za-z][A-Za-z0-9_]{0,47})\}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const RESERVED_OPERATION_IDS = new Set([
  "connect",
  "disconnect",
  "remove",
  "rotate",
  "test",
]);
const FORBIDDEN_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

export async function parseCustomConnectorDefinition(
  raw: unknown,
): Promise<
  Result<ParsedCustomConnectorDefinition, CustomConnectorDefinitionError>
> {
  const rawSize = serializedByteLength(raw);

  if (rawSize === null) {
    return invalid("$", "must be a JSON value");
  }

  if (rawSize > CUSTOM_CONNECTOR_LIMITS.definitionBytes) {
    return {
      ok: false,
      error: {
        code: "definition_too_large",
        maxBytes: CUSTOM_CONNECTOR_LIMITS.definitionBytes,
      },
    };
  }

  if (!isRecord(raw)) {
    return invalid("$", "must be an object");
  }

  const keys = exactKeys(raw, [
    "authentication",
    "description",
    "documentation",
    "identity",
    "limits",
    "name",
    "operations",
    "origin",
    "schemaVersion",
  ]);

  if (!keys.ok) return keys;
  if (raw.schemaVersion !== 1) {
    return unsupported("schemaVersion", "only schema version 1 is supported");
  }

  const name = parsePlainText(
    raw.name,
    "name",
    CUSTOM_CONNECTOR_LIMITS.nameCharacters,
  );
  if (!name.ok) return name;
  const description = parsePlainText(
    raw.description,
    "description",
    CUSTOM_CONNECTOR_LIMITS.descriptionCharacters,
  );
  if (!description.ok) return description;
  const origin = parseOrigin(raw.origin);
  if (!origin.ok) return origin;
  const authentication = parseAuthentication(raw.authentication);
  if (!authentication.ok) return authentication;
  const documentation = parseDocumentation(raw.documentation);
  if (!documentation.ok) return documentation;
  const operations = parseOperations(raw.operations);
  if (!operations.ok) return operations;
  const idempotencyError = idempotencyHeaderError(
    authentication.value,
    operations.value,
  );
  if (idempotencyError !== null) return { ok: false, error: idempotencyError };
  const identity = parseIdentity(raw.identity, operations.value);
  if (!identity.ok) return identity;
  const limits = parseLimits(raw.limits);
  if (!limits.ok) return limits;

  const definition: CustomConnectorDefinitionV1 = {
    schemaVersion: 1,
    name: name.value,
    description: description.value,
    origin: origin.value,
    authentication: authentication.value,
    documentation: documentation.value,
    operations: operations.value,
    identity: identity.value,
    limits: limits.value,
  };
  const canonicalJson = serializeCanonical(definition);
  const digest = parseCustomConnectorDefinitionDigest(
    await digestCanonical(definition),
  );

  if (!digest.ok) {
    throw new Error("SHA-256 implementation returned an invalid digest");
  }

  return {
    ok: true,
    value: {
      definition,
      canonicalJson,
      digest: digest.value,
    },
  };
}

function parseAuthentication(
  raw: unknown,
): Result<CustomConnectorAuthentication, CustomConnectorDefinitionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid("authentication", "must declare an authentication kind");
  }

  switch (raw.kind) {
    case "bearer":
    case "basic_api_key": {
      const keys = exactKeys(raw, ["kind"], "authentication");
      return keys.ok ? { ok: true, value: { kind: raw.kind } } : keys;
    }
    case "header": {
      const keys = exactKeys(raw, ["kind", "name"], "authentication");
      if (!keys.ok) return keys;
      if (typeof raw.name !== "string" || !HEADER_NAME.test(raw.name)) {
        return invalid(
          "authentication.name",
          "must be a valid HTTP header name",
        );
      }
      const lowerName = raw.name.toLowerCase();
      if (isForbiddenHeader(lowerName)) {
        return unsupported(
          "authentication.name",
          "header cannot control routing, framing, cookies, or transport",
        );
      }
      return { ok: true, value: { kind: "header", name: lowerName } };
    }
    default:
      return unsupported(
        "authentication.kind",
        "authentication kind is unsupported",
      );
  }
}

function isForbiddenHeader(lowerName: string): boolean {
  return (
    FORBIDDEN_HEADERS.has(lowerName) ||
    lowerName.startsWith("proxy-") ||
    lowerName.startsWith("x-forwarded-") ||
    lowerName.startsWith("cf-")
  );
}

function parseDocumentation(
  raw: unknown,
): Result<
  CustomConnectorDefinitionV1["documentation"],
  CustomConnectorDefinitionError
> {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.documentationReferences
  ) {
    return invalid("documentation", "must contain a bounded nonempty list");
  }

  const parsed: Array<{ readonly url: string; readonly sha256: string }> = [];
  const urls = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const field = `documentation[${index}]`;
    if (!isRecord(item)) return invalid(field, "must be an object");
    const keys = exactKeys(item, ["sha256", "url"], field);
    if (!keys.ok) return keys;
    const url = parseDocumentationUrl(item.url, `${field}.url`);
    if (!url.ok) return url;
    if (!isSha256Hex(item.sha256)) {
      return invalid(`${field}.sha256`, "must be a lowercase SHA-256 digest");
    }
    if (urls.has(url.value)) {
      return invalid(`${field}.url`, "documentation URL is duplicated");
    }
    urls.add(url.value);
    parsed.push({ url: url.value, sha256: item.sha256 });
  }

  parsed.sort(compareDocumentation);
  return { ok: true, value: parsed };
}

function compareDocumentation(
  left: { readonly url: string },
  right: { readonly url: string },
): number {
  return left.url.localeCompare(right.url);
}

function parseOperations(
  raw: unknown,
): Result<readonly CustomConnectorOperation[], CustomConnectorDefinitionError> {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.operations
  ) {
    return invalid("operations", "must contain 1 to 20 operations");
  }

  const parsed: CustomConnectorOperation[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const operation = parseOperation(raw[index], index);
    if (!operation.ok) return operation;
    if (ids.has(operation.value.id)) {
      return invalid(`operations[${index}].id`, "operation ID is duplicated");
    }
    ids.add(operation.value.id);
    parsed.push(operation.value);
  }

  parsed.sort(compareOperations);
  return { ok: true, value: parsed };
}

function compareOperations(
  left: CustomConnectorOperation,
  right: CustomConnectorOperation,
): number {
  return left.id.localeCompare(right.id);
}

function parseOperation(
  raw: unknown,
  index: number,
): Result<CustomConnectorOperation, CustomConnectorDefinitionError> {
  const field = `operations[${index}]`;
  if (!isRecord(raw)) return invalid(field, "must be an object");
  const keys = exactKeys(
    raw,
    [
      "description",
      "effect",
      "id",
      "inputSchema",
      "pagination",
      "response",
      "transport",
    ],
    field,
  );
  if (!keys.ok) return keys;
  if (
    typeof raw.id !== "string" ||
    !OPERATION_ID.test(raw.id) ||
    RESERVED_OPERATION_IDS.has(raw.id)
  ) {
    return invalid(`${field}.id`, "must be a non-reserved operation ID");
  }
  const description = parsePlainText(
    raw.description,
    `${field}.description`,
    CUSTOM_CONNECTOR_LIMITS.descriptionCharacters,
  );
  if (!description.ok) return description;
  const effect = parseOperationEffect(
    raw.effect,
    raw.inputSchema,
    `${field}.effect`,
  );
  if (!effect.ok) return effect;
  const inputSchema = parseSchema(raw.inputSchema, `${field}.inputSchema`, 1);
  if (!inputSchema.ok) return inputSchema;
  if (inputSchema.value.kind !== "object" || inputSchema.value.nullable) {
    return invalid(
      `${field}.inputSchema`,
      "operation input must be a non-null object",
    );
  }
  const strictSchemaError = strictToolInputSchemaError(
    inputSchema.value,
    `${field}.inputSchema`,
  );
  if (strictSchemaError !== null) {
    return invalid(
      strictSchemaError,
      "optional tool input properties must accept null",
    );
  }
  const transport = parseTransport(
    raw.transport,
    inputSchema.value,
    `${field}.transport`,
  );
  if (!transport.ok) return transport;
  const response = parseResponse(raw.response, `${field}.response`);
  if (!response.ok) return response;
  const pagination = parsePagination(
    raw.pagination,
    inputSchema.value,
    response.value.outputSchema,
    `${field}.pagination`,
  );
  if (!pagination.ok) return pagination;

  return {
    ok: true,
    value: {
      id: raw.id,
      description: description.value,
      effect: effect.value,
      inputSchema: inputSchema.value,
      transport: transport.value,
      response: response.value,
      pagination: pagination.value,
    },
  };
}

function strictToolInputSchemaError(
  schema: CustomConnectorSchema,
  field: string,
): string | null {
  switch (schema.kind) {
    case "object": {
      const required = new Set(schema.required);
      for (const [name, property] of Object.entries(schema.properties)) {
        const propertyField = `${field}.properties.${name}`;
        if (
          !required.has(name) &&
          !customConnectorValueMatchesSchema(null, property)
        ) {
          return propertyField;
        }
        const nested = strictToolInputSchemaError(property, propertyField);
        if (nested !== null) return nested;
      }
      return null;
    }
    case "array":
      return strictToolInputSchemaError(schema.items, `${field}.items`);
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "null":
      return null;
    default:
      return assertNever(schema);
  }
}

function parseOperationEffect(
  raw: unknown,
  rawInputSchema: unknown,
  field: string,
): Result<CustomConnectorOperationEffect, CustomConnectorDefinitionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid(field, "must declare an operation effect");
  }
  switch (raw.kind) {
    case "read": {
      const keys = exactKeys(raw, ["kind"], field);
      return keys.ok ? { ok: true, value: { kind: "read" } } : keys;
    }
    case "external_record_create": {
      const keys = exactKeys(raw, ["kind", "retryPolicy"], field);
      if (!keys.ok) return keys;
      const retryPolicy = parseWriteRetryPolicy(
        raw.retryPolicy,
        `${field}.retryPolicy`,
      );
      return retryPolicy.ok
        ? {
            ok: true,
            value: {
              kind: "external_record_create",
              retryPolicy: retryPolicy.value,
            },
          }
        : retryPolicy;
    }
    case "external_record_update": {
      const keys = exactKeys(
        raw,
        ["kind", "resourceIdentityInput", "retryPolicy"],
        field,
      );
      if (!keys.ok) return keys;
      if (
        typeof raw.resourceIdentityInput !== "string" ||
        !PROPERTY_NAME.test(raw.resourceIdentityInput) ||
        !isRecord(rawInputSchema) ||
        !isRecord(rawInputSchema.properties) ||
        rawInputSchema.properties[raw.resourceIdentityInput] === undefined
      ) {
        return invalid(
          `${field}.resourceIdentityInput`,
          "must name a declared input property",
        );
      }
      const retryPolicy = parseWriteRetryPolicy(
        raw.retryPolicy,
        `${field}.retryPolicy`,
      );
      return retryPolicy.ok
        ? {
            ok: true,
            value: {
              kind: "external_record_update",
              retryPolicy: retryPolicy.value,
              resourceIdentityInput: raw.resourceIdentityInput,
            },
          }
        : retryPolicy;
    }
    default:
      return unsupported(field, "operation effect is unsupported");
  }
}

function parseWriteRetryPolicy(
  raw: unknown,
  field: string,
): Result<CustomConnectorWriteRetryPolicy, CustomConnectorDefinitionError> {
  if (!isRecord(raw)) return invalid(field, "must declare a retry policy");
  switch (raw.kind) {
    case "single_attempt": {
      const keys = exactKeys(raw, ["kind"], field);
      return keys.ok ? { ok: true, value: { kind: "single_attempt" } } : keys;
    }
    case "provider_idempotent": {
      const keys = exactKeys(raw, ["kind", "header"], field);
      if (!keys.ok) return keys;
      if (
        typeof raw.header !== "string" ||
        raw.header.length > 64 ||
        !HEADER_NAME.test(raw.header)
      ) {
        return invalid(`${field}.header`, "must be a valid HTTP header name");
      }
      const header = raw.header.toLowerCase();
      if (isForbiddenHeader(header) || header === "authorization") {
        return unsupported(
          `${field}.header`,
          "header cannot carry credentials or control routing, framing, cookies, or transport",
        );
      }
      return { ok: true, value: { kind: "provider_idempotent", header } };
    }
    default:
      return unsupported(field, "retry policy is unsupported");
  }
}

/**
 * An idempotency key travels in its own header of a REST request. It cannot
 * share the header of the credential.
 */
function idempotencyHeaderError(
  authentication: CustomConnectorAuthentication,
  operations: readonly CustomConnectorOperation[],
): CustomConnectorDefinitionError | null {
  for (const [index, operation] of operations.entries()) {
    const policy =
      operation.effect.kind === "read" ? null : operation.effect.retryPolicy;
    if (policy?.kind !== "provider_idempotent") continue;
    const field = `operations[${index}].effect.retryPolicy`;
    if (operation.transport.kind === "mcp") {
      return {
        code: "unsupported_contract",
        field,
        reason: "provider idempotency needs a REST operation",
      };
    }
    if (
      authentication.kind === "header" &&
      authentication.name === policy.header
    ) {
      return {
        code: "unsupported_contract",
        field: `${field}.header`,
        reason: "header cannot be the authentication header",
      };
    }
  }
  return null;
}

function parseTransport(
  raw: unknown,
  inputSchema: CustomConnectorObjectSchema,
  field: string,
): Result<CustomConnectorOperationTransport, CustomConnectorDefinitionError> {
  if (isRecord(raw) && raw.kind === "mcp") {
    const keys = exactKeys(raw, ["kind", "endpointPath", "toolName"], field);
    if (!keys.ok) return keys;
    const path = parsePathTemplate(raw.endpointPath, `${field}.endpointPath`);
    if (!path.ok) return path;
    if (path.value.placeholders.length !== 0)
      return invalid(`${field}.endpointPath`, "must be a fixed endpoint path");
    if (
      typeof raw.toolName !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(raw.toolName)
    )
      return invalid(`${field}.toolName`, "must be a bounded MCP tool name");
    return {
      ok: true,
      value: {
        kind: "mcp",
        endpointPath: path.value.pathTemplate,
        toolName: raw.toolName,
      },
    };
  }
  if (!isRecord(raw) || raw.kind !== "rest") {
    return unsupported(`${field}.kind`, "transport must be REST or MCP");
  }
  const keys = exactKeys(
    raw,
    [
      "bodyBindings",
      "kind",
      "method",
      "pathBindings",
      "pathTemplate",
      "queryBindings",
    ],
    field,
  );
  if (!keys.ok) return keys;
  const path = parsePathTemplate(raw.pathTemplate, `${field}.pathTemplate`);
  if (!path.ok) return path;
  const pathBindings = parseBindings(
    raw.pathBindings,
    inputSchema,
    `${field}.pathBindings`,
    "path",
  );
  if (!pathBindings.ok) return pathBindings;
  const placeholders = path.value.placeholders;
  const bindingNames = Object.keys(pathBindings.value).sort();
  if (!sameStrings(placeholders, bindingNames)) {
    return invalid(
      `${field}.pathBindings`,
      "bindings must exactly match path placeholders",
    );
  }
  const queryBindings = parseBindings(
    raw.queryBindings,
    inputSchema,
    `${field}.queryBindings`,
    "query",
  );
  if (!queryBindings.ok) return queryBindings;

  if (raw.method === "GET") {
    if (raw.bodyBindings !== null) {
      return invalid(
        `${field}.bodyBindings`,
        "GET requires null body bindings",
      );
    }
    return {
      ok: true,
      value: {
        kind: "get",
        pathTemplate: path.value.pathTemplate,
        pathBindings: pathBindings.value,
        queryBindings: queryBindings.value,
      },
    };
  }

  if (raw.method === "POST") {
    const bodyBindings = parseBindings(
      raw.bodyBindings,
      inputSchema,
      `${field}.bodyBindings`,
      "body",
    );
    if (!bodyBindings.ok) return bodyBindings;
    return {
      ok: true,
      value: {
        kind: "post_json",
        pathTemplate: path.value.pathTemplate,
        pathBindings: pathBindings.value,
        queryBindings: queryBindings.value,
        bodyBindings: bodyBindings.value,
      },
    };
  }

  return unsupported(`${field}.method`, "only GET and POST are supported");
}

function parseBindings(
  raw: unknown,
  inputSchema: CustomConnectorObjectSchema,
  field: string,
  location: "path" | "query" | "body",
): Result<
  Readonly<Record<string, CustomConnectorValueBinding>>,
  CustomConnectorDefinitionError
> {
  if (!isRecord(raw)) return invalid(field, "must be an object");
  if (Object.keys(raw).length > CUSTOM_CONNECTOR_LIMITS.schemaProperties) {
    return invalid(field, "contains too many bindings");
  }
  const parsed: Record<string, CustomConnectorValueBinding> = {};
  const caseInsensitiveNames = new Set<string>();

  for (const name of Object.keys(raw).sort()) {
    if (!BINDING_NAME.test(name)) {
      return invalid(`${field}.${name}`, "binding name is invalid");
    }
    const lowerName = name.toLowerCase();
    if (location === "query" && caseInsensitiveNames.has(lowerName)) {
      return invalid(`${field}.${name}`, "query binding is ambiguous by case");
    }
    caseInsensitiveNames.add(lowerName);
    const binding = parseBinding(
      raw[name],
      inputSchema,
      `${field}.${name}`,
      location,
    );
    if (!binding.ok) return binding;
    parsed[name] = binding.value;
  }

  return { ok: true, value: parsed };
}

function parseBinding(
  raw: unknown,
  inputSchema: CustomConnectorObjectSchema,
  field: string,
  location: "path" | "query" | "body",
): Result<CustomConnectorValueBinding, CustomConnectorDefinitionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid(field, "must declare a binding kind");
  }
  if (raw.kind === "input") {
    const keys = exactKeys(raw, ["field", "kind"], field);
    if (!keys.ok) return keys;
    if (
      typeof raw.field !== "string" ||
      inputSchema.properties[raw.field] === undefined
    ) {
      return invalid(`${field}.field`, "must name a declared input property");
    }
    const schema = inputSchema.properties[raw.field];
    if (
      location !== "body" &&
      (schema === undefined || !isScalarSchema(schema))
    ) {
      return invalid(`${field}.field`, "path and query inputs must be scalar");
    }
    return { ok: true, value: { kind: "input", field: raw.field } };
  }
  if (raw.kind === "constant") {
    const keys = exactKeys(raw, ["kind", "value"], field);
    if (!keys.ok) return keys;
    const value = parseJsonValue(raw.value, `${field}.value`, 1);
    if (!value.ok) return value;
    if (location !== "body" && !isJsonPrimitive(value.value)) {
      return invalid(
        `${field}.value`,
        "path and query constants must be scalar",
      );
    }
    return { ok: true, value: { kind: "constant", value: value.value } };
  }
  return unsupported(`${field}.kind`, "binding kind is unsupported");
}

function parseResponse(
  raw: unknown,
  field: string,
): Result<CustomConnectorResponse, CustomConnectorDefinitionError> {
  if (!isRecord(raw)) return invalid(field, "must be an object");
  const keys = exactKeys(
    raw,
    ["classification", "outputSchema", "resultPointer", "successStatuses"],
    field,
  );
  if (!keys.ok) return keys;
  const statuses = parseSuccessStatuses(
    raw.successStatuses,
    `${field}.successStatuses`,
  );
  if (!statuses.ok) return statuses;
  const pointer = parseJsonPointer(raw.resultPointer, `${field}.resultPointer`);
  if (!pointer.ok) return pointer;
  const outputSchema = parseSchema(
    raw.outputSchema,
    `${field}.outputSchema`,
    1,
  );
  if (!outputSchema.ok) return outputSchema;
  if (!isCommerceSensitivity(raw.classification)) {
    return invalid(`${field}.classification`, "classification is invalid");
  }
  return {
    ok: true,
    value: {
      successStatuses: statuses.value,
      resultPointer: pointer.value,
      outputSchema: outputSchema.value,
      classification: raw.classification,
    },
  };
}

function parseSuccessStatuses(
  raw: unknown,
  field: string,
): Result<readonly number[], CustomConnectorDefinitionError> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
    return invalid(field, "must contain 1 to 10 HTTP success statuses");
  }
  const unique = new Set<number>();
  for (const status of raw) {
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 299
    ) {
      return invalid(field, "must contain only 2xx integer statuses");
    }
    if (unique.has(status)) return invalid(field, "status is duplicated");
    unique.add(status);
  }
  return { ok: true, value: Array.from(unique).sort(compareNumbers) };
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function parsePagination(
  raw: unknown,
  inputSchema: CustomConnectorObjectSchema,
  outputSchema: CustomConnectorSchema,
  field: string,
): Result<CustomConnectorPagination, CustomConnectorDefinitionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid(field, "must declare a pagination kind");
  }
  if (raw.kind === "none") {
    const keys = exactKeys(raw, ["kind"], field);
    return keys.ok ? { ok: true, value: { kind: "none" } } : keys;
  }
  if (raw.kind === "cursor") {
    const keys = exactKeys(
      raw,
      ["cursorInput", "kind", "nextCursorPointer"],
      field,
    );
    if (!keys.ok) return keys;
    if (typeof raw.cursorInput !== "string") {
      return invalid(
        `${field}.cursorInput`,
        "must name a string input property",
      );
    }
    const cursorSchema = inputSchema.properties[raw.cursorInput];
    if (cursorSchema?.kind !== "string") {
      return invalid(
        `${field}.cursorInput`,
        "must name a string input property",
      );
    }
    if (inputSchema.required.includes(raw.cursorInput)) {
      return invalid(`${field}.cursorInput`, "cursor input must be optional");
    }
    const pointer = parseJsonPointer(
      raw.nextCursorPointer,
      `${field}.nextCursorPointer`,
    );
    if (!pointer.ok) return pointer;
    const nextCursorSchema = resolveSchemaPointer(outputSchema, pointer.value);
    if (nextCursorSchema?.kind !== "string") {
      return invalid(
        `${field}.nextCursorPointer`,
        "must select a string in the projected response schema",
      );
    }
    return {
      ok: true,
      value: {
        kind: "cursor",
        cursorInput: raw.cursorInput,
        nextCursorPointer: pointer.value,
      },
    };
  }
  return unsupported(`${field}.kind`, "pagination kind is unsupported");
}

function parseIdentity(
  raw: unknown,
  operations: readonly CustomConnectorOperation[],
): Result<
  CustomConnectorDefinitionV1["identity"],
  CustomConnectorDefinitionError
> {
  if (!isRecord(raw)) return invalid("identity", "must be an object");
  const keys = exactKeys(
    raw,
    ["accountIdPointer", "arguments", "displayNamePointer", "operationId"],
    "identity",
  );
  if (!keys.ok) return keys;
  if (typeof raw.operationId !== "string") {
    return invalid("identity.operationId", "must name a declared operation");
  }
  const operation = findOperation(operations, raw.operationId);
  if (operation === null) {
    return invalid("identity.operationId", "must name a declared operation");
  }
  const argumentsResult = parseIdentityArguments(
    raw.arguments,
    operation.inputSchema,
  );
  if (!argumentsResult.ok) return argumentsResult;
  const accountIdPointer = parseJsonPointer(
    raw.accountIdPointer,
    "identity.accountIdPointer",
  );
  if (!accountIdPointer.ok) return accountIdPointer;
  const displayNamePointer = parseJsonPointer(
    raw.displayNamePointer,
    "identity.displayNamePointer",
  );
  if (!displayNamePointer.ok) return displayNamePointer;
  const accountIdSchema = resolveSchemaPointer(
    operation.response.outputSchema,
    accountIdPointer.value,
  );
  if (
    accountIdSchema?.kind !== "string" &&
    accountIdSchema?.kind !== "integer"
  ) {
    return invalid(
      "identity.accountIdPointer",
      "must select a string or integer in the projected response schema",
    );
  }
  const displayNameSchema = resolveSchemaPointer(
    operation.response.outputSchema,
    displayNamePointer.value,
  );
  if (displayNameSchema?.kind !== "string") {
    return invalid(
      "identity.displayNamePointer",
      "must select a string in the projected response schema",
    );
  }
  return {
    ok: true,
    value: {
      operationId: raw.operationId,
      arguments: argumentsResult.value,
      accountIdPointer: accountIdPointer.value,
      displayNamePointer: displayNamePointer.value,
    },
  };
}

function findOperation(
  operations: readonly CustomConnectorOperation[],
  operationId: string,
): CustomConnectorOperation | null {
  for (const operation of operations) {
    if (operation.id === operationId) return operation;
  }
  return null;
}

function parseIdentityArguments(
  raw: unknown,
  inputSchema: CustomConnectorObjectSchema,
): Result<JsonObject, CustomConnectorDefinitionError> {
  if (!isRecord(raw)) return invalid("identity.arguments", "must be an object");
  const parsed: Record<string, JsonValue> = {};
  for (const field of Object.keys(raw).sort()) {
    const schema = inputSchema.properties[field];
    if (schema === undefined) {
      return invalid(
        `identity.arguments.${field}`,
        "is not a declared input property",
      );
    }
    const value = parseJsonValue(raw[field], `identity.arguments.${field}`, 1);
    if (!value.ok) return value;
    if (!customConnectorValueMatchesSchema(value.value, schema)) {
      return invalid(
        `identity.arguments.${field}`,
        "does not match its input schema",
      );
    }
    parsed[field] = value.value;
  }
  for (const required of inputSchema.required) {
    if (!Object.hasOwn(parsed, required)) {
      return invalid(
        `identity.arguments.${required}`,
        "required probe argument is missing",
      );
    }
  }
  return { ok: true, value: parsed };
}

function parseLimits(
  raw: unknown,
): Result<CustomConnectorDefinitionLimits, CustomConnectorDefinitionError> {
  if (!isRecord(raw)) return invalid("limits", "must be an object");
  const keys = exactKeysSubset(
    raw,
    [
      "argumentBytes",
      "attemptTimeoutMs",
      "bodyBytes",
      "decodedBytes",
      "invocationTimeoutMs",
      "modelResultBytes",
      "wireBytes",
    ],
    "limits",
  );
  if (!keys.ok) return keys;
  const values: MutableCustomConnectorDefinitionLimits = {
    argumentBytes: CUSTOM_CONNECTOR_LIMITS.argumentBytes,
    bodyBytes: CUSTOM_CONNECTOR_LIMITS.bodyBytes,
    wireBytes: CUSTOM_CONNECTOR_LIMITS.wireBytes,
    decodedBytes: CUSTOM_CONNECTOR_LIMITS.decodedBytes,
    modelResultBytes: CUSTOM_CONNECTOR_LIMITS.modelResultBytes,
    attemptTimeoutMs: CUSTOM_CONNECTOR_LIMITS.attemptTimeoutMs,
    invocationTimeoutMs: CUSTOM_CONNECTOR_LIMITS.invocationTimeoutMs,
  };
  const ceilings: Record<keyof CustomConnectorDefinitionLimits, number> = {
    argumentBytes: CUSTOM_CONNECTOR_LIMITS.argumentBytes,
    bodyBytes: CUSTOM_CONNECTOR_LIMITS.bodyBytes,
    wireBytes: CUSTOM_CONNECTOR_LIMITS.wireBytes,
    decodedBytes: CUSTOM_CONNECTOR_LIMITS.decodedBytes,
    modelResultBytes: CUSTOM_CONNECTOR_LIMITS.modelResultBytes,
    attemptTimeoutMs: CUSTOM_CONNECTOR_LIMITS.attemptTimeoutMs,
    invocationTimeoutMs: CUSTOM_CONNECTOR_LIMITS.invocationTimeoutMs,
  };
  for (const key of Object.keys(raw)) {
    if (!isLimitKey(key))
      return invalid(`limits.${key}`, "limit is unsupported");
    const value = raw[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > ceilings[key]
    ) {
      return invalid(
        `limits.${key}`,
        "must be a positive integer at or below the platform ceiling",
      );
    }
    values[key] = value;
  }
  if (values.attemptTimeoutMs > values.invocationTimeoutMs) {
    return invalid(
      "limits.attemptTimeoutMs",
      "cannot exceed invocation timeout",
    );
  }
  return { ok: true, value: values };
}

function isLimitKey(
  value: string,
): value is keyof CustomConnectorDefinitionLimits {
  return (
    value === "argumentBytes" ||
    value === "bodyBytes" ||
    value === "wireBytes" ||
    value === "decodedBytes" ||
    value === "modelResultBytes" ||
    value === "attemptTimeoutMs" ||
    value === "invocationTimeoutMs"
  );
}

function parseSchema(
  raw: unknown,
  field: string,
  depth: number,
): Result<CustomConnectorSchema, CustomConnectorDefinitionError> {
  if (depth > CUSTOM_CONNECTOR_LIMITS.schemaDepth) {
    return invalid(field, "schema exceeds maximum depth");
  }
  if (!isRecord(raw)) return invalid(field, "must be a schema object");
  const type = parseSchemaType(raw.type, `${field}.type`);
  if (!type.ok) return type;
  switch (type.value.base) {
    case "object":
      return parseObjectSchema(raw, field, depth, type.value.nullable);
    case "array":
      return parseArraySchema(raw, field, depth, type.value.nullable);
    case "string":
      return parseStringSchema(raw, field, type.value.nullable);
    case "integer":
    case "number":
      return parseNumberSchema(
        raw,
        field,
        type.value.base,
        type.value.nullable,
      );
    case "boolean":
      return parseBooleanSchema(raw, field, type.value.nullable);
    case "null": {
      const keys = exactKeys(raw, ["type"], field);
      return keys.ok ? { ok: true, value: { kind: "null" } } : keys;
    }
    default:
      return assertNever(type.value.base);
  }
}

function parseSchemaType(
  raw: unknown,
  field: string,
): Result<
  { readonly base: SchemaType; readonly nullable: boolean },
  CustomConnectorDefinitionError
> {
  if (isSchemaType(raw))
    return { ok: true, value: { base: raw, nullable: false } };
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    raw[0] !== raw[1] &&
    (raw[0] === "null" || raw[1] === "null")
  ) {
    const base = raw[0] === "null" ? raw[1] : raw[0];
    if (isSchemaType(base) && base !== "null") {
      return { ok: true, value: { base, nullable: true } };
    }
  }
  return unsupported(field, "schema type is unsupported");
}

function isSchemaType(raw: unknown): raw is SchemaType {
  return (
    raw === "object" ||
    raw === "array" ||
    raw === "string" ||
    raw === "integer" ||
    raw === "number" ||
    raw === "boolean" ||
    raw === "null"
  );
}

function parseObjectSchema(
  raw: JsonRecord,
  field: string,
  depth: number,
  nullable: boolean,
): Result<CustomConnectorObjectSchema, CustomConnectorDefinitionError> {
  const keys = exactKeys(
    raw,
    ["additionalProperties", "properties", "required", "type"],
    field,
  );
  if (!keys.ok) return keys;
  if (raw.additionalProperties !== false || !isRecord(raw.properties)) {
    return invalid(field, "objects must declare closed properties");
  }
  const propertyNames = Object.keys(raw.properties).sort();
  if (propertyNames.length > CUSTOM_CONNECTOR_LIMITS.schemaProperties) {
    return invalid(`${field}.properties`, "contains too many properties");
  }
  const properties: Record<string, CustomConnectorSchema> = {};
  for (const name of propertyNames) {
    if (!PROPERTY_NAME.test(name)) {
      return invalid(`${field}.properties.${name}`, "property name is invalid");
    }
    const schema = parseSchema(
      raw.properties[name],
      `${field}.properties.${name}`,
      depth + 1,
    );
    if (!schema.ok) return schema;
    properties[name] = schema.value;
  }
  if (!Array.isArray(raw.required)) {
    return invalid(`${field}.required`, "must be an array");
  }
  const required = new Set<string>();
  for (const name of raw.required) {
    if (
      typeof name !== "string" ||
      properties[name] === undefined ||
      required.has(name)
    ) {
      return invalid(
        `${field}.required`,
        "must contain unique declared property names",
      );
    }
    required.add(name);
  }
  return {
    ok: true,
    value: {
      kind: "object",
      nullable,
      properties,
      required: Array.from(required).sort(),
    },
  };
}

function parseArraySchema(
  raw: JsonRecord,
  field: string,
  depth: number,
  nullable: boolean,
): Result<CustomConnectorArraySchema, CustomConnectorDefinitionError> {
  const keys = exactKeys(raw, ["items", "maxItems", "minItems", "type"], field);
  if (!keys.ok) return keys;
  if (
    !isNonNegativeInteger(raw.minItems) ||
    !isNonNegativeInteger(raw.maxItems) ||
    raw.maxItems > CUSTOM_CONNECTOR_LIMITS.arrayItems ||
    raw.minItems > raw.maxItems
  ) {
    return invalid(field, "array bounds are invalid");
  }
  const items = parseSchema(raw.items, `${field}.items`, depth + 1);
  if (!items.ok) return items;
  return {
    ok: true,
    value: {
      kind: "array",
      nullable,
      items: items.value,
      minItems: raw.minItems,
      maxItems: raw.maxItems,
    },
  };
}

function parseStringSchema(
  raw: JsonRecord,
  field: string,
  nullable: boolean,
): Result<CustomConnectorStringSchema, CustomConnectorDefinitionError> {
  const keys = exactKeysSubset(
    raw,
    ["const", "enum", "maxLength", "minLength", "type"],
    field,
  );
  if (!keys.ok) return keys;
  if (
    !Object.hasOwn(raw, "minLength") ||
    !Object.hasOwn(raw, "maxLength") ||
    !isNonNegativeInteger(raw.minLength) ||
    !isNonNegativeInteger(raw.maxLength) ||
    raw.maxLength > CUSTOM_CONNECTOR_LIMITS.stringCharacters ||
    raw.minLength > raw.maxLength
  ) {
    return invalid(field, "string bounds are invalid");
  }
  const constraint = parseScalarConstraint(raw, field, "string", nullable);
  if (!constraint.ok) return constraint;
  return {
    ok: true,
    value: {
      kind: "string",
      nullable,
      minLength: raw.minLength,
      maxLength: raw.maxLength,
      constraint: constraint.value,
    },
  };
}

function parseNumberSchema(
  raw: JsonRecord,
  field: string,
  kind: "integer" | "number",
  nullable: boolean,
): Result<CustomConnectorNumberSchema, CustomConnectorDefinitionError> {
  const keys = exactKeysSubset(
    raw,
    ["const", "enum", "maximum", "minimum", "type"],
    field,
  );
  if (!keys.ok) return keys;
  const minimum = raw.minimum === undefined ? null : raw.minimum;
  const maximum = raw.maximum === undefined ? null : raw.maximum;
  if (
    (minimum !== null && !isFiniteNumber(minimum)) ||
    (maximum !== null && !isFiniteNumber(maximum)) ||
    (minimum !== null && maximum !== null && minimum > maximum)
  ) {
    return invalid(field, "numeric bounds are invalid");
  }
  const constraint = parseScalarConstraint(raw, field, kind, nullable);
  if (!constraint.ok) return constraint;
  return {
    ok: true,
    value: {
      kind,
      nullable,
      minimum,
      maximum,
      constraint: constraint.value,
    },
  };
}

function parseBooleanSchema(
  raw: JsonRecord,
  field: string,
  nullable: boolean,
): Result<CustomConnectorBooleanSchema, CustomConnectorDefinitionError> {
  const keys = exactKeysSubset(raw, ["const", "enum", "type"], field);
  if (!keys.ok) return keys;
  const constraint = parseScalarConstraint(raw, field, "boolean", nullable);
  if (!constraint.ok) return constraint;
  return {
    ok: true,
    value: {
      kind: "boolean",
      nullable,
      constraint: constraint.value,
    },
  };
}

function parseScalarConstraint(
  raw: JsonRecord,
  field: string,
  kind: "string" | "integer" | "number" | "boolean",
  nullable: boolean,
): Result<CustomConnectorScalarConstraint, CustomConnectorDefinitionError> {
  if (Object.hasOwn(raw, "enum") && Object.hasOwn(raw, "const")) {
    return invalid(field, "enum and const cannot be combined");
  }
  if (Object.hasOwn(raw, "enum")) {
    if (
      !Array.isArray(raw.enum) ||
      raw.enum.length === 0 ||
      raw.enum.length > CUSTOM_CONNECTOR_LIMITS.enumValues
    ) {
      return invalid(`${field}.enum`, "must be a bounded nonempty array");
    }
    const values: JsonPrimitive[] = [];
    const seen = new Set<string>();
    for (const value of raw.enum) {
      if (
        !isJsonPrimitive(value) ||
        !scalarMatchesKind(value, kind, nullable)
      ) {
        return invalid(
          `${field}.enum`,
          "contains a value outside the schema type",
        );
      }
      const key = JSON.stringify(value);
      if (seen.has(key))
        return invalid(`${field}.enum`, "contains a duplicate value");
      seen.add(key);
      values.push(value);
    }
    values.sort(compareJsonPrimitives);
    return { ok: true, value: { kind: "enum", values } };
  }
  if (Object.hasOwn(raw, "const")) {
    if (
      !isJsonPrimitive(raw.const) ||
      !scalarMatchesKind(raw.const, kind, nullable)
    ) {
      return invalid(`${field}.const`, "does not match the schema type");
    }
    return { ok: true, value: { kind: "const", value: raw.const } };
  }
  return { ok: true, value: { kind: "none" } };
}

function compareJsonPrimitives(
  left: JsonPrimitive,
  right: JsonPrimitive,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function scalarMatchesKind(
  value: JsonPrimitive,
  kind: "string" | "integer" | "number" | "boolean",
  nullable: boolean,
): boolean {
  if (value === null) return nullable;
  if (kind === "string") return typeof value === "string";
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === "number" && Number.isFinite(value);
}

export function customConnectorValueMatchesSchema(
  value: JsonValue,
  schema: CustomConnectorSchema,
): boolean {
  if (value === null) return nullMatchesSchema(schema);
  switch (schema.kind) {
    case "null":
      return false;
    case "string":
      return (
        typeof value === "string" &&
        value.length >= schema.minLength &&
        value.length <= schema.maxLength &&
        scalarConstraintMatches(value, schema.constraint)
      );
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        numberWithinBounds(value, schema) &&
        scalarConstraintMatches(value, schema.constraint)
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        numberWithinBounds(value, schema) &&
        scalarConstraintMatches(value, schema.constraint)
      );
    case "boolean":
      return (
        typeof value === "boolean" &&
        scalarConstraintMatches(value, schema.constraint)
      );
    case "array":
      return arrayMatchesSchema(value, schema);
    case "object":
      return objectMatchesSchema(value, schema);
    default:
      return assertNever(schema);
  }
}

function nullMatchesSchema(schema: CustomConnectorSchema): boolean {
  switch (schema.kind) {
    case "null":
      return true;
    case "object":
    case "array":
      return schema.nullable;
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return (
        schema.nullable && scalarConstraintMatches(null, schema.constraint)
      );
    default:
      return assertNever(schema);
  }
}

function scalarConstraintMatches(
  value: JsonPrimitive,
  constraint: CustomConnectorScalarConstraint,
): boolean {
  switch (constraint.kind) {
    case "none":
      return true;
    case "const":
      return Object.is(value, constraint.value);
    case "enum":
      for (const allowed of constraint.values) {
        if (Object.is(value, allowed)) return true;
      }
      return false;
    default:
      return assertNever(constraint);
  }
}

function arrayMatchesSchema(
  value: JsonValue,
  schema: CustomConnectorArraySchema,
): boolean {
  if (
    !Array.isArray(value) ||
    value.length < schema.minItems ||
    value.length > schema.maxItems
  ) {
    return false;
  }
  for (const item of value) {
    if (!customConnectorValueMatchesSchema(item, schema.items)) return false;
  }
  return true;
}

function objectMatchesSchema(
  value: JsonValue,
  schema: CustomConnectorObjectSchema,
): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    const propertySchema = schema.properties[key];
    const propertyValue = value[key];
    if (
      propertySchema === undefined ||
      propertyValue === undefined ||
      !customConnectorValueMatchesSchema(propertyValue, propertySchema)
    ) {
      return false;
    }
  }
  for (const required of schema.required) {
    if (!Object.hasOwn(value, required)) return false;
  }
  return true;
}

function numberWithinBounds(
  value: number,
  schema: CustomConnectorNumberSchema,
): boolean {
  return (
    (schema.minimum === null || value >= schema.minimum) &&
    (schema.maximum === null || value <= schema.maximum)
  );
}

function parseOrigin(
  raw: unknown,
): Result<string, CustomConnectorDefinitionError> {
  if (
    typeof raw !== "string" ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.urlCharacters
  ) {
    return invalid("origin", "must be a bounded canonical HTTPS origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid("origin", "must be a canonical HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.origin !== raw
  ) {
    return invalid("origin", "must be a canonical HTTPS origin on port 443");
  }
  return { ok: true, value: raw };
}

function parseDocumentationUrl(
  raw: unknown,
  field: string,
): Result<string, CustomConnectorDefinitionError> {
  if (
    typeof raw !== "string" ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.urlCharacters
  ) {
    return invalid(field, "must be a bounded HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(field, "must be an HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return invalid(field, "must be an HTTPS URL without credentials");
  }
  return { ok: true, value: parsed.toString() };
}

function parsePathTemplate(
  raw: unknown,
  field: string,
): Result<
  { readonly pathTemplate: string; readonly placeholders: readonly string[] },
  CustomConnectorDefinitionError
> {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.pathCharacters ||
    !raw.startsWith("/") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("\\")
  ) {
    return invalid(
      field,
      "must be a bounded absolute path without query or fragment",
    );
  }
  const placeholders = new Set<string>();
  const segments = raw.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.length === 0) {
      if (raw === "/" && index === 1) continue;
      return invalid(field, "cannot contain empty path segments");
    }
    const match = PATH_PARAMETER.exec(segment);
    if (match !== null) {
      const name = match[1];
      if (name === undefined || placeholders.has(name)) {
        return invalid(field, "path placeholders must be unique");
      }
      placeholders.add(name);
      continue;
    }
    if (segment.includes("{") || segment.includes("}")) {
      return invalid(
        field,
        "placeholder must occupy one complete path segment",
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalid(field, "contains a malformed escape");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return invalid(field, "contains a forbidden path segment");
    }
  }
  return {
    ok: true,
    value: { pathTemplate: raw, placeholders: Array.from(placeholders).sort() },
  };
}

function parseJsonPointer(
  raw: unknown,
  field: string,
): Result<string, CustomConnectorDefinitionError> {
  if (
    typeof raw !== "string" ||
    raw.length > CUSTOM_CONNECTOR_LIMITS.pointerCharacters ||
    (raw.length > 0 && !raw.startsWith("/")) ||
    /~(?:[^01]|$)/u.test(raw)
  ) {
    return invalid(field, "must be an RFC 6901 JSON Pointer");
  }
  return { ok: true, value: raw };
}

function resolveSchemaPointer(
  schema: CustomConnectorSchema,
  pointer: string,
): CustomConnectorSchema | null {
  if (pointer.length === 0) return schema;
  let current = schema;
  const segments = pointer.slice(1).split("/");
  for (const encodedSegment of segments) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current.kind !== "object") return null;
    const next = current.properties[segment];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

function parsePlainText(
  raw: unknown,
  field: string,
  maxCharacters: number,
): Result<string, CustomConnectorDefinitionError> {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > maxCharacters ||
    raw !== raw.trim() ||
    CONTROL_CHARACTER.test(raw)
  ) {
    return invalid(field, "must be bounded trimmed plain text");
  }
  return { ok: true, value: raw };
}

function parseJsonValue(
  raw: unknown,
  field: string,
  depth: number,
): Result<JsonValue, CustomConnectorDefinitionError> {
  if (depth > CUSTOM_CONNECTOR_LIMITS.schemaDepth) {
    return invalid(field, "JSON value exceeds maximum depth");
  }
  if (isJsonPrimitive(raw)) {
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      return invalid(field, "number must be finite");
    }
    return { ok: true, value: raw };
  }
  if (Array.isArray(raw)) {
    if (raw.length > CUSTOM_CONNECTOR_LIMITS.arrayItems) {
      return invalid(field, "array contains too many items");
    }
    const parsed: JsonValue[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const item = parseJsonValue(raw[index], `${field}[${index}]`, depth + 1);
      if (!item.ok) return item;
      parsed.push(item.value);
    }
    return { ok: true, value: parsed };
  }
  if (isRecord(raw)) {
    const keys = Object.keys(raw).sort();
    if (keys.length > CUSTOM_CONNECTOR_LIMITS.schemaProperties) {
      return invalid(field, "object contains too many properties");
    }
    const parsed: Record<string, JsonValue> = {};
    for (const key of keys) {
      const value = parseJsonValue(raw[key], `${field}.${key}`, depth + 1);
      if (!value.ok) return value;
      parsed[key] = value.value;
    }
    return { ok: true, value: parsed };
  }
  return invalid(field, "must be a JSON value");
}

function serializedByteLength(raw: unknown): number | null {
  try {
    const serialized = JSON.stringify(raw);
    return serialized === undefined
      ? null
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function exactKeys(
  raw: JsonRecord,
  allowed: readonly string[],
  field = "$",
): Result<true, CustomConnectorDefinitionError> {
  if (Object.keys(raw).length !== allowed.length) {
    return invalid(field, "contains missing or unknown fields");
  }
  return exactKeysSubset(raw, allowed, field);
}

function exactKeysSubset(
  raw: JsonRecord,
  allowed: readonly string[],
  field: string,
): Result<true, CustomConnectorDefinitionError> {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key))
      return invalid(`${field}.${key}`, "field is unsupported");
  }
  return { ok: true, value: true };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isJsonPrimitive(raw: unknown): raw is JsonPrimitive {
  return (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  );
}

function isScalarSchema(schema: CustomConnectorSchema): boolean {
  return (
    schema.kind === "string" ||
    schema.kind === "integer" ||
    schema.kind === "number" ||
    schema.kind === "boolean"
  );
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

function invalid(
  field: string,
  reason: string,
): Result<never, CustomConnectorDefinitionError> {
  return { ok: false, error: { code: "definition_invalid", field, reason } };
}

function unsupported(
  field: string,
  reason: string,
): Result<never, CustomConnectorDefinitionError> {
  return { ok: false, error: { code: "unsupported_contract", field, reason } };
}
