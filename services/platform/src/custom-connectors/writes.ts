import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import type { CustomConnectorActionAuthority } from "../actors/action-ledger";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import { resolveVaultHandle } from "../credential-vault/service";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  executeCustomConnectorTransport,
  type CustomConnectorFetchNamespace,
} from "./egress";
import { digestCanonical, serializeCanonical } from "../policy";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveCustomConnectorAccount } from "./accounts";
import {
  customConnectorValueMatchesSchema,
  type JsonObject,
  type JsonValue,
} from "./definition";
import {
  buildCustomConnectorOperationRequest,
  isCustomConnectorJsonContentType,
  projectCustomConnectorResponse,
  resolveCurrentCustomConnectorCredential,
  resolveCustomConnectorAuthentication,
} from "./execution";
import type { CustomConnectorWriteCatalogEntry } from "./grants";
import {
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
} from "@purin-labs/connections/custom-connectors/identity";
import { resolveCustomConnectorRevision } from "./revisions";
import { assertNever, isRecord, sha256Hex } from "@purin-labs/std";
import { executeReviewedConnectorOperation } from "./mcp";

type CustomConnectorWriteReceipt = Readonly<{
  readonly kind: "custom_connector_write_receipt";
  readonly providerEffectId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectorId: string;
  readonly definitionRevision: number;
  readonly definitionDigest: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
  readonly operationId: string;
  readonly effect: "external_record_create" | "external_record_update";
  readonly status: number;
  readonly result: JsonValue;
  readonly confirmedAt: number;
}>;

type CustomConnectorWriteExecution =
  | Readonly<{
      readonly kind: "confirmed";
      readonly receipt: CustomConnectorWriteReceipt;
    }>
  | Readonly<{
      readonly kind: "failed_before_send";
      readonly reason: string;
    }>
  | Readonly<{
      readonly kind: "indeterminate";
      readonly reason: string;
    }>;

type CustomConnectorWriteError =
  | Readonly<{ readonly code: "custom_connector_write_stale" }>
  | Readonly<{
      readonly code: "custom_connector_write_invalid";
      readonly field: string;
    }>;

type CustomConnectorWritePreview =
  | Readonly<{
      kind: "available";
      accountDisplayName: string;
      operationLabel: string;
      origin: string;
      method: "POST";
      path: string;
      fields: readonly Readonly<{ path: string; value: JsonValue }>[];
    }>
  | Readonly<{
      kind: "unavailable";
      reason:
        "permission_required" | "definition_unavailable" | "input_invalid";
    }>;

export async function resolveCustomConnectorWritePreview(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly authority: CustomConnectorActionAuthority;
}): Promise<CustomConnectorWritePreview> {
  const connectorId = parseCustomConnectorId(input.authority.connectorId);
  const revision = parseCustomConnectorRevision(
    input.authority.definitionRevision,
  );
  if (!connectorId.ok || !revision.ok) {
    return { kind: "unavailable", reason: "definition_unavailable" };
  }
  const resolved = await resolveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: connectorId.value,
    revision: revision.value,
  });
  if (
    !resolved.ok ||
    (resolved.value.reviewState !== "approved" &&
      resolved.value.reviewState !== "retired") ||
    resolved.value.definitionDigest !== input.authority.definitionDigest
  ) {
    return { kind: "unavailable", reason: "definition_unavailable" };
  }
  const account = await input.db
    .prepare(
      `SELECT account.display_name AS displayName
     FROM integration_account AS account
     JOIN custom_connector_account_binding AS binding
       ON binding.organisation_id = account.organisation_id
      AND binding.integration_account_id = account.integration_account_id
     WHERE account.organisation_id = ? AND account.integration_account_id = ?
       AND binding.connector_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId, connectorId.value)
    .first<{ displayName: unknown }>();
  if (account === null || typeof account.displayName !== "string") {
    return { kind: "unavailable", reason: "definition_unavailable" };
  }
  const definition = resolved.value.definition;
  const operation = definition.operations.find(
    operationMatches.bind(null, input.authority.operationId),
  );
  if (
    operation === undefined ||
    !isWriteOperation(operation) ||
    operation.effect.kind !== input.authority.effect ||
    (await digestCanonical(operation.response)) !==
      input.authority.outputContractDigest
  ) {
    return { kind: "unavailable", reason: "definition_unavailable" };
  }
  if (
    new TextEncoder().encode(input.authority.canonicalInputJson).byteLength >
    definition.limits.argumentBytes
  ) {
    return { kind: "unavailable", reason: "input_invalid" };
  }
  const argumentsValue = parseCanonicalInput(
    input.authority.canonicalInputJson,
  );
  if (
    argumentsValue === null ||
    (await digestCanonical(argumentsValue)) !==
      input.authority.canonicalInputDigest ||
    !customConnectorValueMatchesSchema(argumentsValue, operation.inputSchema)
  ) {
    return { kind: "unavailable", reason: "input_invalid" };
  }
  // Preview and execution share request binding, including reviewed constants.
  const request = buildCustomConnectorOperationRequest(
    { operation, origin: definition.origin, limits: definition.limits },
    argumentsValue,
  );
  if (
    !request.ok ||
    (request.value.kind !== "post_json" && request.value.kind !== "mcp")
  ) {
    return { kind: "unavailable", reason: "input_invalid" };
  }
  const body =
    request.value.kind === "mcp"
      ? request.value.arguments
      : parseCanonicalInput(new TextDecoder().decode(request.value.body));
  if (body === null) return { kind: "unavailable", reason: "input_invalid" };
  const fields: { path: string; value: JsonValue }[] = [];
  if (request.value.kind === "mcp")
    fields.push({ path: "tool", value: request.value.toolName });
  for (const [key, value] of request.value.url.searchParams) {
    fields.push({ path: `query.${key}`, value });
  }
  for (const [key, value] of Object.entries(body)) {
    fields.push({ path: `body.${key}`, value });
  }
  return {
    kind: "available",
    accountDisplayName: account.displayName,
    operationLabel: operation.description,
    origin: definition.origin,
    method: "POST",
    path: request.value.url.pathname,
    fields,
  };
}

export async function buildCustomConnectorWriteAuthority(input: {
  readonly entry: CustomConnectorWriteCatalogEntry;
  readonly rawArguments: unknown;
  readonly providerEffectId: string;
}): Promise<Result<CustomConnectorActionAuthority, CustomConnectorWriteError>> {
  const argumentsValue = normalizeJsonObject(input.rawArguments);
  if (
    argumentsValue === null ||
    !customConnectorValueMatchesSchema(argumentsValue, input.entry.inputSchema)
  ) {
    return invalidWrite("arguments");
  }
  if (
    input.providerEffectId.length === 0 ||
    input.providerEffectId.length > 256
  ) {
    return invalidWrite("providerEffectId");
  }
  const canonicalInputJson = serializeCanonical(argumentsValue);
  const canonicalInputDigest = await digestCanonical(argumentsValue);
  const outputContractDigest = await digestCanonical(
    input.entry.operation.response,
  );
  const effect = input.entry.operation.effect;
  const resourceIdentity =
    effect.kind === "external_record_create"
      ? ({ kind: "new_record" } as const)
      : resourceIdentityFromInput(argumentsValue, effect.resourceIdentityInput);
  if (resourceIdentity === null) {
    return invalidWrite(`arguments.${effect.resourceIdentityInput}`);
  }
  return {
    ok: true,
    value: {
      kind: "custom_connector",
      connectorId: input.entry.connectorId,
      definitionRevision: input.entry.definitionRevision,
      definitionDigest: input.entry.definitionDigest,
      bindingRevision: input.entry.bindingRevision,
      credentialGeneration: input.entry.credentialGeneration,
      operationId: input.entry.operation.id,
      effect: effect.kind,
      retryPolicy: effect.retryPolicy,
      canonicalInputJson,
      canonicalInputDigest,
      outputContractDigest,
      resourceIdentity,
      providerEffectId: input.providerEffectId,
    },
  };
}

export async function resolveApprovedCustomConnectorWrite(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly authority: CustomConnectorActionAuthority;
}): Promise<
  Result<CustomConnectorWriteCatalogEntry, CustomConnectorWriteError>
> {
  const connectorId = parseCustomConnectorId(input.authority.connectorId);
  const revision = parseCustomConnectorRevision(
    input.authority.definitionRevision,
  );
  const digest = parseCustomConnectorDefinitionDigest(
    input.authority.definitionDigest,
  );
  if (!connectorId.ok || !revision.ok || !digest.ok) {
    return { ok: false, error: { code: "custom_connector_write_stale" } };
  }
  const account = await resolveActiveCustomConnectorAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (
    !account.ok ||
    account.value.source.connectorId !== connectorId.value ||
    account.value.binding.acceptedRevision !== revision.value ||
    account.value.binding.definitionDigest !== digest.value ||
    account.value.binding.bindingRevision !== input.authority.bindingRevision ||
    account.value.binding.credentialGeneration !==
      input.authority.credentialGeneration
  ) {
    return { ok: false, error: { code: "custom_connector_write_stale" } };
  }
  const resolved = await resolveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: connectorId.value,
    revision: revision.value,
  });
  if (!resolved.ok || resolved.value.reviewState !== "approved") {
    return { ok: false, error: { code: "custom_connector_write_stale" } };
  }
  const operation = resolved.value.definition.operations.find(
    operationMatches.bind(null, input.authority.operationId),
  );
  if (
    operation === undefined ||
    !isWriteOperation(operation) ||
    operation.effect.kind !== input.authority.effect ||
    (await digestCanonical(operation.response)) !==
      input.authority.outputContractDigest
  ) {
    return { ok: false, error: { code: "custom_connector_write_stale" } };
  }
  const argumentsValue = parseCanonicalInput(
    input.authority.canonicalInputJson,
  );
  if (
    argumentsValue === null ||
    (await digestCanonical(argumentsValue)) !==
      input.authority.canonicalInputDigest ||
    !customConnectorValueMatchesSchema(argumentsValue, operation.inputSchema)
  ) {
    return invalidWrite("canonicalInput");
  }
  return {
    ok: true,
    value: {
      toolName: `effect_${input.authority.providerEffectId}`,
      description: operation.description,
      origin: resolved.value.definition.origin,
      authentication: resolved.value.definition.authentication,
      limits: resolved.value.definition.limits,
      inputSchema: operation.inputSchema,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      connectorId: connectorId.value,
      definitionRevision: revision.value,
      definitionDigest: digest.value,
      bindingRevision: account.value.binding.bindingRevision,
      credentialGeneration: account.value.binding.credentialGeneration,
      operation,
      capabilityKey: [
        "custom_connector",
        "custom_connector.write",
        "1",
        input.integrationAccountId,
        connectorId.value,
        String(revision.value),
        digest.value,
        operation.id,
      ].join(":"),
      grantIds: [],
      grantRevisions: [],
    },
  };
}

export async function executeApprovedCustomConnectorWrite(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly namespace: CustomConnectorFetchNamespace;
  readonly entry: CustomConnectorWriteCatalogEntry;
  readonly authority: CustomConnectorActionAuthority;
  /** The action's ledger key. A provider_idempotent write sends its hash. */
  readonly idempotencyKey: string;
  readonly deadlineAtUnixMs: number;
  readonly now: number;
  readonly authorizeCall: () => Promise<boolean>;
}): Promise<CustomConnectorWriteExecution> {
  const credentialBinding = await resolveCurrentCustomConnectorCredential({
    db: input.db,
    entry: input.entry,
  });
  if (!credentialBinding.ok) {
    return { kind: "failed_before_send", reason: credentialBinding.error.code };
  }
  const credential = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.entry.organisationId,
    handle: credentialBinding.value,
  });
  if (!credential.ok) {
    return { kind: "failed_before_send", reason: credential.error.code };
  }
  const authentication = resolveCustomConnectorAuthentication(
    input.entry,
    credential.value,
    input.now,
  );
  if (!authentication.ok) {
    return { kind: "failed_before_send", reason: authentication.error.code };
  }
  const argumentsValue = parseCanonicalInput(
    input.authority.canonicalInputJson,
  );
  if (argumentsValue === null) {
    return { kind: "failed_before_send", reason: "canonical_input_invalid" };
  }
  const request = buildCustomConnectorOperationRequest(
    input.entry,
    argumentsValue,
  );
  if (!request.ok) {
    return { kind: "failed_before_send", reason: request.error.code };
  }
  const response = await executeReviewedConnectorOperation({
    namespace: input.namespace,
    transport: executeCustomConnectorTransport,
    attemptTimeoutMs: input.entry.limits.attemptTimeoutMs,
    authorizeCall: authorizeCurrentWrite.bind(null, input),
    request: {
      organisationId: input.entry.organisationId,
      authentication: authentication.value,
      operation: request.value,
      ...(input.authority.retryPolicy.kind === "provider_idempotent"
        ? {
            idempotency: {
              header: input.authority.retryPolicy.header,
              // Stable for the action; it names no internal account.
              key: `pantry-${await sha256Hex(input.idempotencyKey)}`,
            },
          }
        : {}),
      deadlineAtUnixMs: input.deadlineAtUnixMs,
      maxWireBytes: input.entry.limits.wireBytes,
      maxDecodedBytes: input.entry.limits.decodedBytes,
    },
  });
  if (!response.ok) {
    switch (response.error.kind) {
      case "not_dispatched":
        return { kind: "failed_before_send", reason: response.error.code };
      case "dispatch_started":
        return { kind: "indeterminate", reason: response.error.code };
      default:
        return assertNever(response.error);
    }
  }
  if (
    !input.entry.operation.response.successStatuses.includes(
      response.value.status,
    ) ||
    !isCustomConnectorJsonContentType(response.value.contentType)
  ) {
    return {
      kind: "indeterminate",
      reason: `response_status_${response.value.status}`,
    };
  }
  const projected = projectCustomConnectorResponse(
    response.value.body,
    input.entry.operation,
  );
  if (!projected.ok) {
    return { kind: "indeterminate", reason: projected.error.code };
  }
  return {
    kind: "confirmed",
    receipt: {
      kind: "custom_connector_write_receipt",
      providerEffectId: input.authority.providerEffectId,
      organisationId: input.entry.organisationId,
      integrationAccountId: input.entry.integrationAccountId,
      connectorId: input.entry.connectorId,
      definitionRevision: input.entry.definitionRevision,
      definitionDigest: input.entry.definitionDigest,
      bindingRevision: input.entry.bindingRevision,
      credentialGeneration: input.entry.credentialGeneration,
      operationId: input.entry.operation.id,
      effect: input.entry.operation.effect.kind,
      status: response.value.status,
      result: projected.value,
      confirmedAt: input.now,
    },
  };
}

function resourceIdentityFromInput(
  argumentsValue: JsonObject,
  inputName: string,
): CustomConnectorActionAuthority["resourceIdentity"] | null {
  const value = argumentsValue[inputName];
  return (typeof value === "string" || typeof value === "number") &&
    String(value).length > 0 &&
    String(value).length <= 256
    ? { kind: "existing_record", value: String(value) }
    : null;
}

function parseCanonicalInput(value: string): JsonObject | null {
  try {
    return normalizeJsonObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeJsonObject(raw: unknown): JsonObject | null {
  if (!isRecord(raw)) return null;
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(raw));
    return isJsonObject(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function isJsonObject(raw: unknown): raw is JsonObject {
  if (!isRecord(raw)) return false;
  return Object.values(raw).every(isJsonValue);
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
  if (Array.isArray(raw)) return raw.every(isJsonValue);
  return isJsonObject(raw);
}

async function authorizeCurrentWrite(
  input: Parameters<typeof executeApprovedCustomConnectorWrite>[0],
): Promise<boolean> {
  if (input.deadlineAtUnixMs <= Date.now()) return false;
  const entry = await resolveApprovedCustomConnectorWrite({
    db: input.db,
    organisationId: input.entry.organisationId,
    integrationAccountId: input.entry.integrationAccountId,
    authority: input.authority,
  });
  return (
    entry.ok &&
    (await input.authorizeCall()) &&
    input.deadlineAtUnixMs > Date.now()
  );
}

function operationMatches(
  operationId: string,
  operation: { id: string },
): boolean {
  return operation.id === operationId;
}

function isWriteOperation(
  operation:
    | CustomConnectorWriteCatalogEntry["operation"]
    | {
        readonly effect: { readonly kind: string };
      },
): operation is CustomConnectorWriteCatalogEntry["operation"] {
  return operation.effect.kind !== "read";
}

function invalidWrite(field: string): Result<never, CustomConnectorWriteError> {
  return {
    ok: false,
    error: { code: "custom_connector_write_invalid", field },
  };
}
