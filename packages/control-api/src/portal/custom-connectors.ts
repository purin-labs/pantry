import type { Variant } from "@purin-labs/type-utils";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";
import type { ActionState } from "@purin-labs/contracts";

export type CustomConnectorSummary = Readonly<{
  connectorId: string;
  lifecycle: "draft" | "active" | "disabled";
  headRevision: number;
  name: string | null;
  description: string | null;
  origin: string | null;
  reviewState: "draft" | "validated" | "approved" | "rejected" | "retired";
  accountCount: number;
  accounts: readonly CustomConnectorAccountView[];
  createdAt: number;
  updatedAt: number;
}>;

export type CustomConnectorRevisionView = Readonly<{
  revision: number;
  reviewState: CustomConnectorSummary["reviewState"];
  authoringDigest: string;
  authoringDocument: Readonly<Record<string, unknown>>;
  definitionDigest: string | null;
  definition: Readonly<Record<string, unknown>> | null;
  validationFailure: Readonly<Record<string, unknown>> | null;
  rejectionReason: string | null;
}>;

export type CustomConnectorAccountView = Readonly<{
  integrationAccountId: string;
  displayName: string;
  lifecycle: "active" | "disabled";
  acceptedRevision: number;
  bindingRevision: number;
  credentialGeneration: number;
}>;

export type CustomConnectorSetupAttempt = Readonly<{
  attemptId: string;
  connectorId: string;
  connectorRevision: number;
  definitionDigest: string;
  lifecycle:
    | "awaiting_credential"
    | "credential_stored"
    | "testing"
    | "verified"
    | "committed"
    | "failed"
    | "cancelled"
    | "expired";
  attemptRevision: number;
  expiresAt: number;
  target:
    | Readonly<{
        kind: "new_account";
        environment: "production" | "development";
        integrationAccountId?: never;
        expectedBindingRevision?: never;
      }>
    | Readonly<{
        kind: "rotate_account" | "upgrade_account" | "resume_account";
        integrationAccountId: string;
        expectedBindingRevision: number;
        environment?: never;
      }>;
  verification: Readonly<{
    providerAccountId: string;
    displayName: string;
    testedAt: number;
  }> | null;
}>;

export type CustomConnectorMutationResult = Readonly<{
  configurationVersion: number;
  connectorId: string | null;
  revision: CustomConnectorRevisionView | null;
  attempt: CustomConnectorSetupAttempt | null;
  preview: unknown;
}>;

export type CustomConnectorJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CustomConnectorJsonValue[]
  | { readonly [key: string]: CustomConnectorJsonValue };

export type CustomConnectorWritePreview =
  | Readonly<{
      kind: "available";
      accountDisplayName: string;
      operationLabel: string;
      origin: string;
      method: "POST";
      path: string;
      fields: readonly Readonly<{
        path: string;
        value: CustomConnectorJsonValue;
      }>[];
    }>
  | Readonly<{
      kind: "unavailable";
      reason:
        "permission_required" | "definition_unavailable" | "input_invalid";
    }>;

export type CustomConnectorAction = Readonly<{
  nonce: string;
  state: ActionState;
  connectorId: string;
  integrationAccountId: string;
  operationId: string;
  effect: "external_record_create" | "external_record_update";
  /** The header of a provider idempotency key; null for a single attempt. */
  idempotencyHeader: string | null;
  providerEffectId: string;
  definitionRevision: number;
  definitionDigest: string;
  bindingRevision: number;
  credentialGeneration: number;
  resourceIdentity: Readonly<Record<string, unknown>>;
  canonicalInputDigest: string;
  proposedAt: number;
  updatedAt: number;
  providerResult: unknown;
  preview: CustomConnectorWritePreview;
}>;

export type ConnectorAuthoringResult =
  | {
      readonly kind: "ready";
      readonly document: Readonly<Record<string, unknown>>;
      readonly name: string;
      readonly description: string;
      readonly origin: string;
      readonly operations: readonly string[];
      readonly documentationUrls: readonly string[];
    }
  | { readonly kind: "unsupported"; readonly message: string };

export function parseAuthoredConnector(
  document: Readonly<Record<string, unknown>>,
): Variant<ConnectorAuthoringResult, "ready"> {
  if (
    typeof document.name !== "string" ||
    typeof document.description !== "string" ||
    typeof document.origin !== "string" ||
    !Array.isArray(document.operations) ||
    !Array.isArray(document.documentation)
  )
    throw new Error("The server returned an invalid connector draft.");
  const operations: string[] = [];
  for (const operation of document.operations) {
    if (!isRecord(operation) || typeof operation.description !== "string")
      throw new Error("The server returned an invalid connector operation.");
    operations.push(operation.description);
  }
  const documentationUrls: string[] = [];
  for (const source of document.documentation) {
    if (
      !isRecord(source) ||
      typeof source.url !== "string" ||
      new URL(source.url).protocol !== "https:"
    )
      throw new Error("The server returned an invalid documentation URL.");
    documentationUrls.push(source.url);
  }
  return {
    kind: "ready",
    document,
    name: document.name,
    description: document.description,
    origin: document.origin,
    operations,
    documentationUrls,
  };
}

export function parseMutationResult(
  raw: unknown,
): CustomConnectorMutationResult {
  if (!isRecord(raw) || !isPositiveInteger(raw.configurationVersion)) {
    throw new Error("The server returned an invalid connector update.");
  }
  return {
    configurationVersion: raw.configurationVersion,
    connectorId: typeof raw.connectorId === "string" ? raw.connectorId : null,
    revision: isRecord(raw.revision) ? parseRevision(raw.revision) : null,
    attempt: isRecord(raw.attempt) ? parseAttempt(raw.attempt) : null,
    preview: raw.preview,
  };
}

export function parseSummary(raw: unknown): CustomConnectorSummary {
  if (
    !isRecord(raw) ||
    typeof raw.connectorId !== "string" ||
    !isLifecycle(raw.lifecycle) ||
    !isPositiveInteger(raw.headRevision) ||
    !isNullableString(raw.name) ||
    !isNullableString(raw.description) ||
    !isNullableString(raw.origin) ||
    !isReviewState(raw.reviewState) ||
    !isNonNegativeInteger(raw.accountCount) ||
    !Array.isArray(raw.accounts) ||
    !isNonNegativeInteger(raw.createdAt) ||
    !isNonNegativeInteger(raw.updatedAt)
  ) {
    throw new Error("The server returned an invalid custom connector summary.");
  }
  return {
    connectorId: raw.connectorId,
    lifecycle: raw.lifecycle,
    headRevision: raw.headRevision,
    name: raw.name,
    description: raw.description,
    origin: raw.origin,
    reviewState: raw.reviewState,
    accountCount: raw.accountCount,
    accounts: raw.accounts.map(parseAccount),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function parseRevision(raw: unknown): CustomConnectorRevisionView {
  if (
    !isRecord(raw) ||
    !isPositiveInteger(raw.revision) ||
    !isReviewState(raw.reviewState) ||
    typeof raw.authoringDigest !== "string" ||
    !isRecord(raw.authoringDocument)
  ) {
    throw new Error("The server returned an invalid connector revision.");
  }
  return {
    revision: raw.revision,
    reviewState: raw.reviewState,
    authoringDigest: raw.authoringDigest,
    authoringDocument: raw.authoringDocument,
    definitionDigest:
      typeof raw.definitionDigest === "string" ? raw.definitionDigest : null,
    definition: isRecord(raw.definition) ? raw.definition : null,
    validationFailure: isRecord(raw.validationFailure)
      ? raw.validationFailure
      : null,
    rejectionReason:
      isRecord(raw.rejection) && typeof raw.rejection.reason === "string"
        ? raw.rejection.reason
        : null,
  };
}

export function parseAccount(raw: unknown): CustomConnectorAccountView {
  if (
    !isRecord(raw) ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.displayName !== "string" ||
    (raw.lifecycle !== "active" && raw.lifecycle !== "disabled") ||
    !isPositiveInteger(raw.acceptedRevision) ||
    !isPositiveInteger(raw.bindingRevision) ||
    !isPositiveInteger(raw.credentialGeneration)
  ) {
    throw new Error("The server returned an invalid connector account.");
  }
  return {
    integrationAccountId: raw.integrationAccountId,
    displayName: raw.displayName,
    lifecycle: raw.lifecycle,
    acceptedRevision: raw.acceptedRevision,
    bindingRevision: raw.bindingRevision,
    credentialGeneration: raw.credentialGeneration,
  };
}

export function parseAttempt(raw: unknown): CustomConnectorSetupAttempt {
  if (
    !isRecord(raw) ||
    typeof raw.attemptId !== "string" ||
    typeof raw.connectorId !== "string" ||
    !isPositiveInteger(raw.connectorRevision) ||
    typeof raw.definitionDigest !== "string" ||
    !isSetupLifecycle(raw.lifecycle) ||
    !isPositiveInteger(raw.attemptRevision) ||
    !isNonNegativeInteger(raw.expiresAt) ||
    !isRecord(raw.target)
  ) {
    throw new Error("The server returned an invalid connector setup.");
  }
  return {
    attemptId: raw.attemptId,
    connectorId: raw.connectorId,
    connectorRevision: raw.connectorRevision,
    definitionDigest: raw.definitionDigest,
    lifecycle: raw.lifecycle,
    attemptRevision: raw.attemptRevision,
    expiresAt: raw.expiresAt,
    target: parseSetupTarget(raw.target),
    verification: parseVerification(raw.verification),
  };
}

export function parseAction(raw: unknown): CustomConnectorAction {
  if (
    !isRecord(raw) ||
    typeof raw.nonce !== "string" ||
    !isActionState(raw.state) ||
    typeof raw.connectorId !== "string" ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.operationId !== "string" ||
    (raw.effect !== "external_record_create" &&
      raw.effect !== "external_record_update") ||
    typeof raw.providerEffectId !== "string" ||
    !isPositiveInteger(raw.definitionRevision) ||
    typeof raw.definitionDigest !== "string" ||
    !isPositiveInteger(raw.bindingRevision) ||
    !isPositiveInteger(raw.credentialGeneration) ||
    !isRecord(raw.resourceIdentity) ||
    typeof raw.canonicalInputDigest !== "string" ||
    !isNonNegativeInteger(raw.proposedAt) ||
    !isNonNegativeInteger(raw.updatedAt)
  ) {
    throw new Error("The server returned an invalid custom connector action.");
  }
  return {
    nonce: raw.nonce,
    state: raw.state,
    connectorId: raw.connectorId,
    integrationAccountId: raw.integrationAccountId,
    operationId: raw.operationId,
    effect: raw.effect,
    idempotencyHeader:
      isRecord(raw.retryPolicy) &&
      raw.retryPolicy.kind === "provider_idempotent" &&
      typeof raw.retryPolicy.header === "string"
        ? raw.retryPolicy.header
        : null,
    providerEffectId: raw.providerEffectId,
    definitionRevision: raw.definitionRevision,
    definitionDigest: raw.definitionDigest,
    bindingRevision: raw.bindingRevision,
    credentialGeneration: raw.credentialGeneration,
    resourceIdentity: raw.resourceIdentity,
    canonicalInputDigest: raw.canonicalInputDigest,
    proposedAt: raw.proposedAt,
    updatedAt: raw.updatedAt,
    providerResult: raw.providerResult,
    preview: parseWritePreview(raw.preview),
  };
}

function isActionState(
  value: unknown,
): value is CustomConnectorAction["state"] {
  return (
    value === "proposed" ||
    value === "approval_requested" ||
    value === "signed" ||
    value === "executing" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "rejected" ||
    value === "expired" ||
    value === "indeterminate"
  );
}

function parseVerification(
  raw: unknown,
): CustomConnectorSetupAttempt["verification"] {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw) ||
    typeof raw.providerAccountId !== "string" ||
    typeof raw.displayName !== "string" ||
    !isNonNegativeInteger(raw.testedAt)
  ) {
    throw new Error("The server returned invalid connector verification.");
  }
  return {
    providerAccountId: raw.providerAccountId,
    displayName: raw.displayName,
    testedAt: raw.testedAt,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isLifecycle(
  value: unknown,
): value is CustomConnectorSummary["lifecycle"] {
  return value === "draft" || value === "active" || value === "disabled";
}

function isReviewState(
  value: unknown,
): value is CustomConnectorSummary["reviewState"] {
  return (
    value === "draft" ||
    value === "validated" ||
    value === "approved" ||
    value === "rejected" ||
    value === "retired"
  );
}

function isSetupLifecycle(
  value: unknown,
): value is CustomConnectorSetupAttempt["lifecycle"] {
  return (
    value === "awaiting_credential" ||
    value === "credential_stored" ||
    value === "testing" ||
    value === "verified" ||
    value === "committed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function parseWritePreview(raw: unknown): CustomConnectorWritePreview {
  if (
    isRecord(raw) &&
    raw.kind === "unavailable" &&
    (raw.reason === "permission_required" ||
      raw.reason === "definition_unavailable" ||
      raw.reason === "input_invalid")
  ) {
    return { kind: "unavailable", reason: raw.reason };
  }
  if (
    !isRecord(raw) ||
    raw.kind !== "available" ||
    typeof raw.accountDisplayName !== "string" ||
    typeof raw.operationLabel !== "string" ||
    typeof raw.origin !== "string" ||
    raw.method !== "POST" ||
    typeof raw.path !== "string" ||
    !Array.isArray(raw.fields)
  ) {
    throw new Error("The server returned an invalid write preview.");
  }
  const fields: { path: string; value: CustomConnectorJsonValue }[] = [];
  for (const field of raw.fields) {
    if (
      !isRecord(field) ||
      typeof field.path !== "string" ||
      !isJsonValue(field.value, 0)
    ) {
      throw new Error("The server returned an invalid write preview field.");
    }
    fields.push({ path: field.path, value: field.value });
  }
  return {
    kind: "available",
    accountDisplayName: raw.accountDisplayName,
    operationLabel: raw.operationLabel,
    origin: raw.origin,
    method: "POST",
    path: raw.path,
    fields,
  };
}

function isJsonValue(
  value: unknown,
  depth: number,
): value is CustomConnectorJsonValue {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (const item of value) if (!isJsonValue(item, depth + 1)) return false;
    return true;
  }
  if (!isRecord(value)) return false;
  for (const item of Object.values(value))
    if (!isJsonValue(item, depth + 1)) return false;
  return true;
}

function parseSetupTarget(raw: unknown): CustomConnectorSetupAttempt["target"] {
  if (
    isRecord(raw) &&
    raw.kind === "new_account" &&
    (raw.environment === "production" || raw.environment === "development")
  ) {
    return { kind: "new_account", environment: raw.environment };
  }
  if (
    isRecord(raw) &&
    (raw.kind === "rotate_account" ||
      raw.kind === "upgrade_account" ||
      raw.kind === "resume_account") &&
    typeof raw.integrationAccountId === "string" &&
    isPositiveInteger(raw.expectedBindingRevision)
  ) {
    return {
      kind: raw.kind,
      integrationAccountId: raw.integrationAccountId,
      expectedBindingRevision: raw.expectedBindingRevision,
    };
  }
  throw new Error("The server returned an invalid connector setup target.");
}
