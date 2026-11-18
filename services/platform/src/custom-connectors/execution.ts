import type { OrganisationDatabase } from "../database-handles";
import type { AccountPlatformAccess } from "../account-platform/access";
import { decideCurrentAuthorityFlowSink } from "../chat/information-flow";
import type { CommerceSensitivity, RequestAuthority } from "@seams/contracts";

import type { EffectiveGrantSet } from "../authorization/access-grants";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import type { VaultHandle, VaultSecret } from "../credential-vault/domain";
import { parseVaultHandle } from "../credential-vault/domain";
import { resolveVaultHandle } from "../credential-vault/service";
import { readAccessGrant } from "../data/access-grants";
import { encodeCapabilityKey } from "../authorization/access-grants";
import {
  executeReviewedConnectorOperation,
  type ReviewedConnectorOperationRequest,
} from "./mcp";
import {
  executeCustomConnectorTransport,
  type CustomConnectorAuthentication,
  type CustomConnectorFetchNamespace,
  type CustomConnectorTransportError,
} from "./egress";
import {
  createCurrentSourceFlowLabel,
  type FlowBinding,
  type FlowLabel,
} from "../policy/information-flow";
import type { Result } from "../result";
import {
  customConnectorValueMatchesSchema,
  type CustomConnectorOperation,
  type CustomConnectorValueBinding,
  type JsonObject,
  type JsonValue,
} from "./definition";
import {
  compileCustomConnectorReadCatalog,
  type CustomConnectorCatalogEntry,
  type CustomConnectorReadCatalogEntry,
} from "./grants";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";

const authorizedReadBrand: unique symbol = Symbol(
  "AuthorizedCustomConnectorRead",
);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

export type AuthorizedCustomConnectorRead = Readonly<{
  readonly [authorizedReadBrand]: "AuthorizedCustomConnectorRead";
  readonly entry: CustomConnectorReadCatalogEntry;
  readonly arguments: JsonObject;
  readonly executionId: string;
  readonly leaseId: string;
  readonly deadlineAtUnixMs: number;
  readonly flowBindingDigest: string;
  readonly flowDecisionDigest: string;
}>;

type CustomConnectorReadResult = Readonly<{
  readonly data: JsonValue;
  readonly classification: CommerceSensitivity;
  readonly sourceLabel: FlowLabel;
}>;

type CustomConnectorReadError =
  | { readonly code: "custom_connector_read_invalid"; readonly field: string }
  | { readonly code: "custom_connector_read_stale" }
  | { readonly code: "custom_connector_flow_denied" }
  | { readonly code: "custom_connector_credential_unavailable" }
  | { readonly code: "custom_connector_credential_rejected" }
  | { readonly code: "custom_connector_response_contract_changed" }
  | {
      readonly code: "custom_connector_response_status";
      readonly status: number;
    }
  | { readonly code: "custom_connector_result_too_large" }
  | { readonly code: "custom_connector_source_policy_unavailable" }
  | {
      readonly code: "custom_connector_transport_failed";
      readonly reason: CustomConnectorTransportError["code"];
    };

type CustomConnectorReadTransport = typeof executeCustomConnectorTransport;

export async function authorizeCustomConnectorRead(input: {
  readonly db: OrganisationDatabase;
  readonly accountAccess: AccountPlatformAccess;
  readonly effectiveGrants: EffectiveGrantSet;
  readonly acceptedEntry: CustomConnectorReadCatalogEntry;
  readonly rawArguments: unknown;
  readonly flowBinding: FlowBinding;
  readonly destinationAuthority: RequestAuthority;
  readonly execution: Readonly<{
    readonly executionId: string;
    readonly leaseId: string;
    readonly deadlineAtUnixMs: number;
  }>;
  readonly cursorSigningKey: string;
  readonly now: number;
}): Promise<Result<AuthorizedCustomConnectorRead, CustomConnectorReadError>> {
  const current = await resolveAcceptedEntry({
    db: input.db,
    effectiveGrants: input.effectiveGrants,
    acceptedEntry: input.acceptedEntry,
  });
  if (!current.ok) return current;
  if (
    input.flowBinding.organisationId !== current.value.organisationId ||
    input.destinationAuthority.organisationId !== current.value.organisationId
  ) {
    return invalidRead("authority.organisationId");
  }
  const executionError = invalidExecution(input.execution, input.now);
  if (executionError !== null) return invalidRead(executionError);
  if (input.cursorSigningKey.length < 32)
    return invalidRead("cursorSigningKey");
  const argumentsResult = await parseInvocationArguments({
    raw: input.rawArguments,
    entry: current.value,
    signingKey: input.cursorSigningKey,
    now: input.now,
  });
  if (!argumentsResult.ok) return argumentsResult;
  const flowDecision = await decideCurrentAuthorityFlowSink(
    input.db,
    input.accountAccess,
    {
      binding: input.flowBinding,
      sink: {
        kind: "tool_effect",
        destinationAuthority: input.destinationAuthority,
        capabilityId: "custom_connector.read",
        integrationAccountId: current.value.integrationAccountId,
        resourceScope: customConnectorResourceScope(current.value),
        approvalSatisfied: false,
      },
    },
  );
  if (flowDecision.kind !== "allow") {
    return { ok: false, error: { code: "custom_connector_flow_denied" } };
  }
  const resultSource = await readCurrentResultSourceLabel(
    input.db,
    current.value,
  );
  if (!resultSource.ok) return resultSource;
  return {
    ok: true,
    value: {
      [authorizedReadBrand]: "AuthorizedCustomConnectorRead",
      entry: current.value,
      arguments: argumentsResult.value,
      executionId: input.execution.executionId,
      leaseId: input.execution.leaseId,
      deadlineAtUnixMs: input.execution.deadlineAtUnixMs,
      flowBindingDigest: flowDecision.flowBindingDigest,
      flowDecisionDigest: flowDecision.decisionDigest,
    },
  };
}

export async function executeAuthorizedCustomConnectorRead(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly namespace: CustomConnectorFetchNamespace;
  readonly authorization: AuthorizedCustomConnectorRead;
  readonly effectiveGrants: EffectiveGrantSet;
  readonly cursorSigningKey: string;
  readonly now: number;
  readonly transport?: CustomConnectorReadTransport;
  readonly isExecutionActive: () => Promise<boolean>;
}): Promise<Result<CustomConnectorReadResult, CustomConnectorReadError>> {
  const current = await resolveAcceptedEntry({
    db: input.db,
    effectiveGrants: input.effectiveGrants,
    acceptedEntry: input.authorization.entry,
  });
  if (
    !current.ok ||
    current.value.capabilityKey !== input.authorization.entry.capabilityKey
  ) {
    return { ok: false, error: { code: "custom_connector_read_stale" } };
  }
  const currentSource = await readCurrentResultSourceLabel(
    input.db,
    current.value,
  );
  if (!currentSource.ok) return currentSource;
  if (input.authorization.deadlineAtUnixMs <= input.now) {
    return invalidRead("execution.deadlineAtUnixMs");
  }
  const credentialBinding = await resolveCurrentCustomConnectorCredential({
    db: input.db,
    entry: current.value,
  });
  if (!credentialBinding.ok) return credentialBinding;
  const credential = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: current.value.organisationId,
    handle: credentialBinding.value,
  });
  if (!credential.ok) {
    return {
      ok: false,
      error: { code: "custom_connector_credential_unavailable" },
    };
  }
  const authentication = resolveCustomConnectorAuthentication(
    current.value,
    credential.value,
    input.now,
  );
  if (!authentication.ok) return authentication;
  const request = buildCustomConnectorOperationRequest(
    current.value,
    input.authorization.arguments,
  );
  if (!request.ok) return request;
  const transport = input.transport ?? executeCustomConnectorTransport;
  const response = await executeReviewedConnectorOperation({
    namespace: input.namespace,
    transport,
    attemptTimeoutMs: current.value.limits.attemptTimeoutMs,
    authorizeCall: authorizeCurrentRead.bind(null, input),
    request: {
      organisationId: current.value.organisationId,
      authentication: authentication.value,
      operation: request.value,
      deadlineAtUnixMs: input.authorization.deadlineAtUnixMs,
      maxWireBytes: current.value.limits.wireBytes,
      maxDecodedBytes: current.value.limits.decodedBytes,
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "custom_connector_transport_failed",
        reason: response.error.code,
      },
    };
  }
  if (!(await input.isExecutionActive()))
    return { ok: false, error: { code: "custom_connector_read_stale" } };
  if (
    !current.value.operation.response.successStatuses.includes(
      response.value.status,
    )
  ) {
    return {
      ok: false,
      error: {
        code: "custom_connector_response_status",
        status: response.value.status,
      },
    };
  }
  if (!isCustomConnectorJsonContentType(response.value.contentType)) {
    return {
      ok: false,
      error: { code: "custom_connector_response_contract_changed" },
    };
  }
  const projected = projectCustomConnectorResponse(
    response.value.body,
    current.value.operation,
  );
  if (!projected.ok) return projected;
  const accepted = await resolveAcceptedEntry({
    db: input.db,
    effectiveGrants: input.effectiveGrants,
    acceptedEntry: current.value,
  });
  if (!accepted.ok) {
    return { ok: false, error: { code: "custom_connector_read_stale" } };
  }
  const protectedResult = await protectNextCursor({
    value: projected.value,
    entry: accepted.value,
    signingKey: input.cursorSigningKey,
    now: input.now,
  });
  if (!protectedResult.ok) return protectedResult;
  if (
    TEXT_ENCODER.encode(JSON.stringify(protectedResult.value)).byteLength >
    accepted.value.limits.modelResultBytes
  ) {
    return { ok: false, error: { code: "custom_connector_result_too_large" } };
  }
  const sourceLabel = await readCurrentResultSourceLabel(
    input.db,
    accepted.value,
  );
  if (!(await input.isExecutionActive()))
    return { ok: false, error: { code: "custom_connector_read_stale" } };
  return sourceLabel.ok
    ? {
        ok: true,
        value: {
          data: protectedResult.value,
          classification: accepted.value.operation.response.classification,
          sourceLabel: sourceLabel.value,
        },
      }
    : sourceLabel;
}

async function authorizeCurrentRead(
  input: Parameters<typeof executeAuthorizedCustomConnectorRead>[0],
): Promise<boolean> {
  if (
    !(await input.isExecutionActive()) ||
    input.authorization.deadlineAtUnixMs <= Date.now()
  )
    return false;
  const current = await resolveAcceptedEntry({
    db: input.db,
    effectiveGrants: input.effectiveGrants,
    acceptedEntry: input.authorization.entry,
  });
  if (!current.ok) return false;
  const source = await readCurrentResultSourceLabel(input.db, current.value);
  if (!source.ok) return false;
  for (const [index, grantId] of current.value.grantIds.entries()) {
    const grant = await readAccessGrant({
      db: input.db,
      organisationId: current.value.organisationId,
      grantId,
    });
    if (
      grant.ok &&
      grant.value.lifecycle.kind === "active" &&
      grant.value.lifecycle.revision === current.value.grantRevisions[index] &&
      grant.value.target.kind === "custom_connector_operation" &&
      encodeCapabilityKey(grant.value.target) === current.value.capabilityKey
    )
      return (
        (await input.isExecutionActive()) &&
        input.authorization.deadlineAtUnixMs > Date.now()
      );
  }
  return false;
}

async function readCurrentResultSourceLabel(
  db: OrganisationDatabase,
  entry: ExecutableCatalogEntry,
): Promise<Result<FlowLabel, CustomConnectorReadError>> {
  const sourceLabel = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db,
    organisationId: entry.organisationId,
    integrationAccountId: entry.integrationAccountId,
    capabilityId: "custom_connector.read",
    resourceScope: customConnectorResourceScope(entry),
    grantIds: entry.grantIds,
  });
  return sourceLabel.ok
    ? sourceLabel
    : {
        ok: false,
        error: { code: "custom_connector_source_policy_unavailable" },
      };
}

export function customConnectorResourceScope(
  entry: CustomConnectorReadCatalogEntry,
): string {
  return [
    "custom_connector",
    entry.connectorId,
    String(entry.definitionRevision),
    entry.definitionDigest,
    entry.operation.id,
  ].join(":");
}

type ExecutableCatalogEntry = CustomConnectorReadCatalogEntry;

async function resolveAcceptedEntry(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly effectiveGrants: EffectiveGrantSet;
  readonly acceptedEntry: CustomConnectorReadCatalogEntry;
}): Promise<Result<ExecutableCatalogEntry, CustomConnectorReadError>> {
  const catalog = await compileCustomConnectorReadCatalog({
    db: input.db,
    effectiveGrants: input.effectiveGrants,
  });
  if (!catalog.ok) {
    return { ok: false, error: { code: "custom_connector_read_stale" } };
  }
  for (const entry of catalog.value) {
    if (sameEntry(entry, input.acceptedEntry)) {
      return { ok: true, value: entry };
    }
  }
  return { ok: false, error: { code: "custom_connector_read_stale" } };
}

function sameEntry(
  current: CustomConnectorReadCatalogEntry,
  accepted: CustomConnectorReadCatalogEntry,
): boolean {
  return (
    current.toolName === accepted.toolName &&
    current.capabilityKey === accepted.capabilityKey &&
    current.bindingRevision === accepted.bindingRevision &&
    current.credentialGeneration === accepted.credentialGeneration &&
    current.definitionDigest === accepted.definitionDigest
  );
}

function invalidExecution(
  execution: Readonly<{
    readonly executionId: string;
    readonly leaseId: string;
    readonly deadlineAtUnixMs: number;
  }>,
  now: number,
): string | null {
  if (execution.executionId.length === 0) return "execution.executionId";
  if (execution.leaseId.length === 0) return "execution.leaseId";
  return !Number.isSafeInteger(execution.deadlineAtUnixMs) ||
    execution.deadlineAtUnixMs <= now
    ? "execution.deadlineAtUnixMs"
    : null;
}

async function parseInvocationArguments(input: {
  readonly raw: unknown;
  readonly entry: ExecutableCatalogEntry;
  readonly signingKey: string;
  readonly now: number;
}): Promise<Result<JsonObject, CustomConnectorReadError>> {
  const normalized = normalizeJsonObject(input.raw);
  if (normalized === null) return invalidRead("arguments");
  const serialized = JSON.stringify(normalized);
  if (
    TEXT_ENCODER.encode(serialized).byteLength >
    input.entry.limits.argumentBytes
  ) {
    return invalidRead("arguments");
  }
  const decoded = await decodeInputCursor({
    arguments: normalized,
    entry: input.entry,
    signingKey: input.signingKey,
    now: input.now,
  });
  if (!decoded.ok) return decoded;
  return customConnectorValueMatchesSchema(
    decoded.value,
    input.entry.inputSchema,
  )
    ? { ok: true, value: decoded.value }
    : invalidRead("arguments");
}

function normalizeJsonObject(raw: unknown): JsonObject | null {
  const normalized = normalizeJsonValue(raw);
  if (!isRecord(normalized)) return null;
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!isJsonValue(value)) return null;
    result[key] = value;
  }
  return result;
}

export async function resolveCurrentCustomConnectorCredential(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly entry: CustomConnectorCatalogEntry;
}): Promise<Result<VaultHandle, CustomConnectorReadError>> {
  const row = await input.db
    .prepare(
      `SELECT generation.credential_ref AS credentialRef
       FROM custom_connector_account_binding AS binding
       JOIN integration_account AS account
         ON account.organisation_id = binding.organisation_id
        AND account.integration_account_id = binding.integration_account_id
        AND account.lifecycle = 'active' AND account.source_kind = 'custom_api'
       JOIN provider_connection AS connection
         ON connection.organisation_id = account.organisation_id
        AND connection.provider_connection_id = account.provider_connection_id
        AND connection.lifecycle = 'active' AND connection.source_kind = 'custom_api'
        AND connection.credential_generation = binding.credential_generation
       JOIN provider_credential_generation AS generation
         ON generation.organisation_id = connection.organisation_id
        AND generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.credential_ref = connection.credential_ref
        AND generation.lifecycle = 'active'
       WHERE binding.organisation_id = ? AND binding.integration_account_id = ?
         AND binding.connector_id = ? AND binding.accepted_revision = ?
         AND binding.accepted_definition_digest = ?
         AND binding.binding_revision = ? AND binding.credential_generation = ?
         AND binding.lifecycle = 'active'
       LIMIT 1`,
    )
    .bind(
      input.entry.organisationId,
      input.entry.integrationAccountId,
      input.entry.connectorId,
      input.entry.definitionRevision,
      input.entry.definitionDigest,
      input.entry.bindingRevision,
      input.entry.credentialGeneration,
    )
    .first<{ credentialRef: unknown }>();
  if (typeof row?.credentialRef !== "string") {
    return {
      ok: false,
      error: { code: "custom_connector_credential_unavailable" },
    };
  }
  const handle = parseVaultHandle(row.credentialRef);
  return handle.ok
    ? handle
    : { ok: false, error: { code: "custom_connector_credential_unavailable" } };
}

export function resolveCustomConnectorAuthentication(
  entry: CustomConnectorCatalogEntry,
  secret: VaultSecret,
  now: number,
): Result<CustomConnectorAuthentication, CustomConnectorReadError> {
  if (entry.authentication.kind === "basic_api_key") {
    const value = basicApiKeyFromVault(secret);
    return value === null
      ? { ok: false, error: { code: "custom_connector_credential_rejected" } }
      : { ok: true, value: { kind: "basic_api_key", value } };
  }
  if (entry.authentication.kind === "bearer") {
    if (secret.kind === "bearer") {
      return { ok: true, value: { kind: "bearer", value: secret.value } };
    }
    if (secret.kind === "expiring_bearer" && secret.expiresAt > now) {
      return { ok: true, value: { kind: "bearer", value: secret.value } };
    }
    return {
      ok: false,
      error: { code: "custom_connector_credential_rejected" },
    };
  }
  return secret.kind === "header" && secret.header === entry.authentication.name
    ? {
        ok: true,
        value: {
          kind: "header",
          name: entry.authentication.name,
          value: secret.value,
        },
      }
    : { ok: false, error: { code: "custom_connector_credential_rejected" } };
}

export function buildCustomConnectorOperationRequest(
  entry: Pick<CustomConnectorCatalogEntry, "operation" | "origin" | "limits">,
  argumentsValue: JsonObject,
): Result<ReviewedConnectorOperationRequest, CustomConnectorReadError> {
  const transport = entry.operation.transport;
  if (transport.kind === "mcp") {
    const url = new URL(transport.endpointPath, entry.origin);
    if (url.origin !== entry.origin) return invalidRead("operation.origin");
    return {
      ok: true,
      value: {
        kind: "mcp",
        url,
        toolName: transport.toolName,
        arguments: argumentsValue,
      },
    };
  }
  let path = transport.pathTemplate;
  for (const [name, binding] of Object.entries(transport.pathBindings)) {
    const value = bindingValue(binding, argumentsValue);
    if (value === undefined || typeof value === "object") {
      return invalidRead(`arguments.${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(path, entry.origin);
  if (url.origin !== entry.origin) return invalidRead("operation.origin");
  for (const [name, binding] of Object.entries(transport.queryBindings)) {
    const value = bindingValue(binding, argumentsValue);
    if (value === undefined || value === null) continue;
    if (typeof value === "object") return invalidRead(`arguments.${name}`);
    url.searchParams.set(name, String(value));
  }
  if (transport.kind === "get") {
    return { ok: true, value: { kind: "get", url } };
  }
  const body: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(transport.bodyBindings)) {
    const value = bindingValue(binding, argumentsValue);
    if (value !== undefined) body[name] = value;
  }
  const bodyBytes = TEXT_ENCODER.encode(JSON.stringify(body));
  return bodyBytes.byteLength <= entry.limits.bodyBytes
    ? { ok: true, value: { kind: "post_json", url, body: bodyBytes } }
    : invalidRead("arguments");
}

function bindingValue(
  binding: CustomConnectorValueBinding,
  argumentsValue: JsonObject,
): JsonValue | undefined {
  return binding.kind === "constant"
    ? binding.value
    : argumentsValue[binding.field];
}

export function projectCustomConnectorResponse(
  bytes: Uint8Array,
  operation: CustomConnectorOperation,
): Result<JsonValue, CustomConnectorReadError> {
  let raw: unknown;
  try {
    raw = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    return {
      ok: false,
      error: { code: "custom_connector_response_contract_changed" },
    };
  }
  const projected = readJsonPointer(raw, operation.response.resultPointer);
  const normalized = projectReviewedResponse(
    projected,
    operation.response.outputSchema,
  );
  return normalized.ok
    ? normalized
    : {
        ok: false,
        error: { code: "custom_connector_response_contract_changed" },
      };
}

export function isCustomConnectorJsonContentType(
  contentType: string | null,
): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
}

function normalizeJsonValue(raw: unknown): JsonValue | null {
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(raw));
    return isJsonValue(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function isJsonValue(raw: unknown): raw is JsonValue {
  if (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "boolean" ||
    (typeof raw === "number" && Number.isFinite(raw))
  ) {
    return true;
  }
  if (Array.isArray(raw)) {
    for (const value of raw) if (!isJsonValue(value)) return false;
    return true;
  }
  if (!isRecord(raw)) return false;
  for (const value of Object.values(raw)) if (!isJsonValue(value)) return false;
  return true;
}

function readJsonPointer(raw: unknown, pointer: string): unknown {
  if (pointer.length === 0) return raw;
  let current = raw;
  for (const encoded of pointer.slice(1).split("/")) {
    if (!isRecord(current)) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[segment];
  }
  return current;
}

async function protectNextCursor(input: {
  readonly value: JsonValue;
  readonly entry: ExecutableCatalogEntry;
  readonly signingKey: string;
  readonly now: number;
}): Promise<Result<JsonValue, CustomConnectorReadError>> {
  const pagination = input.entry.operation.pagination;
  if (pagination.kind === "none") return { ok: true, value: input.value };
  const cursor = readJsonPointer(input.value, pagination.nextCursorPointer);
  if (cursor === null) return { ok: true, value: input.value };
  if (typeof cursor !== "string") {
    return {
      ok: false,
      error: { code: "custom_connector_response_contract_changed" },
    };
  }
  const token = await encodeCursor({
    signingKey: input.signingKey,
    payload: {
      organisationId: input.entry.organisationId,
      integrationAccountId: input.entry.integrationAccountId,
      connectorId: input.entry.connectorId,
      definitionRevision: input.entry.definitionRevision,
      definitionDigest: input.entry.definitionDigest,
      bindingRevision: input.entry.bindingRevision,
      credentialGeneration: input.entry.credentialGeneration,
      operationId: input.entry.operation.id,
      cursor,
      expiresAt: input.now + CUSTOM_CONNECTOR_LIMITS.cursorLifetimeMs,
    },
  });
  const replaced = replaceJsonPointer(
    input.value,
    pagination.nextCursorPointer,
    token,
  );
  return replaced === null
    ? {
        ok: false,
        error: { code: "custom_connector_response_contract_changed" },
      }
    : { ok: true, value: replaced };
}

async function decodeInputCursor(input: {
  readonly arguments: JsonObject;
  readonly entry: ExecutableCatalogEntry;
  readonly signingKey: string;
  readonly now: number;
}): Promise<Result<JsonObject, CustomConnectorReadError>> {
  const pagination = input.entry.operation.pagination;
  if (pagination.kind === "none") return { ok: true, value: input.arguments };
  const supplied = input.arguments[pagination.cursorInput];
  if (supplied === undefined || supplied === null) {
    return { ok: true, value: input.arguments };
  }
  if (typeof supplied !== "string")
    return invalidRead(`arguments.${pagination.cursorInput}`);
  const decoded = await decodeCursor(supplied, input.signingKey);
  if (
    decoded === null ||
    decoded.expiresAt <= input.now ||
    !cursorMatchesEntry(decoded, input.entry)
  ) {
    return invalidRead(`arguments.${pagination.cursorInput}`);
  }
  return {
    ok: true,
    value: { ...input.arguments, [pagination.cursorInput]: decoded.cursor },
  };
}

type CursorPayload = Readonly<{
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly connectorId: string;
  readonly definitionRevision: number;
  readonly definitionDigest: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
  readonly operationId: string;
  readonly cursor: string;
  readonly expiresAt: number;
}>;

function cursorMatchesEntry(
  cursor: CursorPayload,
  entry: ExecutableCatalogEntry,
): boolean {
  return (
    cursor.organisationId === entry.organisationId &&
    cursor.integrationAccountId === entry.integrationAccountId &&
    cursor.connectorId === entry.connectorId &&
    cursor.definitionRevision === entry.definitionRevision &&
    cursor.definitionDigest === entry.definitionDigest &&
    cursor.bindingRevision === entry.bindingRevision &&
    cursor.credentialGeneration === entry.credentialGeneration &&
    cursor.operationId === entry.operation.id
  );
}

async function encodeCursor(input: {
  readonly signingKey: string;
  readonly payload: CursorPayload;
}): Promise<string> {
  const body = encodeBase64Url(
    TEXT_ENCODER.encode(JSON.stringify(input.payload)),
  );
  const signature = await signCursor(body, input.signingKey);
  return `cc1.${body}.${signature}`;
}

async function decodeCursor(
  token: string,
  signingKey: string,
): Promise<CursorPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "cc1") return null;
  const body = parts[1];
  const signature = parts[2];
  if (body === undefined || signature === undefined) return null;
  if (!(await verifyCursorSignature(body, signature, signingKey))) return null;
  try {
    const raw: unknown = JSON.parse(TEXT_DECODER.decode(decodeBase64Url(body)));
    return parseCursorPayload(raw);
  } catch {
    return null;
  }
}

function parseCursorPayload(raw: unknown): CursorPayload | null {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.connectorId !== "string" ||
    !isSafeInteger(raw.definitionRevision) ||
    !isSha256Hex(raw.definitionDigest) ||
    !isSafeInteger(raw.bindingRevision) ||
    !isSafeInteger(raw.credentialGeneration) ||
    typeof raw.operationId !== "string" ||
    typeof raw.cursor !== "string" ||
    !isSafeInteger(raw.expiresAt)
  ) {
    return null;
  }
  return {
    organisationId: raw.organisationId,
    integrationAccountId: raw.integrationAccountId,
    connectorId: raw.connectorId,
    definitionRevision: raw.definitionRevision,
    definitionDigest: raw.definitionDigest,
    bindingRevision: raw.bindingRevision,
    credentialGeneration: raw.credentialGeneration,
    operationId: raw.operationId,
    cursor: raw.cursor,
    expiresAt: raw.expiresAt,
  };
}

async function signCursor(body: string, signingKey: string): Promise<string> {
  const key = await importCursorKey(signingKey, ["sign"]);
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(body)),
    ),
  );
}

async function verifyCursorSignature(
  body: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await importCursorKey(signingKey, ["verify"]);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      TEXT_ENCODER.encode(body),
    );
  } catch {
    return false;
  }
}

function importCursorKey(
  signingKey: string,
  usages: ("sign" | "verify")[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function replaceJsonPointer(
  value: JsonValue,
  pointer: string,
  replacement: string,
): JsonValue | null {
  if (pointer.length === 0) return replacement;
  const segments = pointer.slice(1).split("/").map(decodePointerSegment);
  return replaceJsonValueAtPath(value, segments, replacement);
}

function replaceJsonValueAtPath(
  value: JsonValue,
  segments: readonly string[],
  replacement: string,
): JsonValue | null {
  const key = segments[0];
  if (key === undefined) return replacement;
  if (!isRecord(value)) return null;
  const child = value[key];
  if (child === undefined) return null;
  const replaced = replaceJsonValueAtPath(
    child,
    segments.slice(1),
    replacement,
  );
  if (replaced === null) return null;
  const result: Record<string, JsonValue> = {};
  for (const [property, propertyValue] of Object.entries(value)) {
    if (!isJsonValue(propertyValue)) return null;
    result[property] = property === key ? replaced : propertyValue;
  }
  return result;
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function invalidRead(field: string): Result<never, CustomConnectorReadError> {
  return { ok: false, error: { code: "custom_connector_read_invalid", field } };
}
import { basicApiKeyFromVault } from "./basic-authentication";
import { projectReviewedResponse } from "./response-projection";
import { encodeBase64Url, isRecord, isSha256Hex } from "@seams/std";
