export { parseUserId, newUserId, type UserId } from "@seams/control-api/ids";
import type { Result } from "./result";

declare const organisationIdBrand: unique symbol;
declare const organisationHandleBrand: unique symbol;
declare const workspaceHandleBrand: unique symbol;
declare const workspaceIdBrand: unique symbol;
declare const channelIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const sandboxIdBrand: unique symbol;
declare const threadKeyBrand: unique symbol;
declare const threadIdBrand: unique symbol;
declare const blockIdBrand: unique symbol;
declare const requestIdBrand: unique symbol;
declare const controlSessionIdBrand: unique symbol;
declare const personIdBrand: unique symbol;
declare const providerConnectionIdBrand: unique symbol;
declare const integrationAccountIdBrand: unique symbol;
declare const providerWebhookIdBrand: unique symbol;
declare const setupSnapshotIdBrand: unique symbol;
declare const activationAttemptIdBrand: unique symbol;
declare const activationReceiptIdBrand: unique symbol;
declare const providerConnectionAttemptIdBrand: unique symbol;
declare const providerStateIdBrand: unique symbol;
declare const providerProvisioningAttemptIdBrand: unique symbol;
declare const connectorIdBrand: unique symbol;
declare const caseIdBrand: unique symbol;
declare const assignmentIdBrand: unique symbol;
declare const codexAuthorizationAttemptIdBrand: unique symbol;
declare const slackAppIdBrand: unique symbol;
declare const slackInstallationIdBrand: unique symbol;
declare const slackOrganisationConnectionIdBrand: unique symbol;

export type OrganisationId = string & {
  readonly [organisationIdBrand]: "OrganisationId";
};
export type OrganisationHandle = string & {
  readonly [organisationHandleBrand]: "OrganisationHandle";
};
export type WorkspaceHandle = string & {
  readonly [workspaceHandleBrand]: "WorkspaceHandle";
};
export type WorkspaceId = string & {
  readonly [workspaceIdBrand]: "WorkspaceId";
};
export type ChannelId = string & { readonly [channelIdBrand]: "ChannelId" };
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type SandboxId = string & { readonly [sandboxIdBrand]: "SandboxId" };
export type ThreadKey = string & { readonly [threadKeyBrand]: "ThreadKey" };
export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };
export type BlockId = string & { readonly [blockIdBrand]: "BlockId" };
export type RequestId = string & { readonly [requestIdBrand]: "RequestId" };
export type ControlSessionId = string & {
  readonly [controlSessionIdBrand]: "ControlSessionId";
};
export type PersonId = string & { readonly [personIdBrand]: "PersonId" };
export type ProviderConnectionId = string & {
  readonly [providerConnectionIdBrand]: "ProviderConnectionId";
};
export type IntegrationAccountId = string & {
  readonly [integrationAccountIdBrand]: "IntegrationAccountId";
};
export type ProviderWebhookId = string & {
  readonly [providerWebhookIdBrand]: "ProviderWebhookId";
};
export type SetupSnapshotId = string & {
  readonly [setupSnapshotIdBrand]: "SetupSnapshotId";
};
export type ActivationAttemptId = string & {
  readonly [activationAttemptIdBrand]: "ActivationAttemptId";
};
export type ActivationReceiptId = string & {
  readonly [activationReceiptIdBrand]: "ActivationReceiptId";
};
export type ProviderConnectionAttemptId = string & {
  readonly [providerConnectionAttemptIdBrand]: "ProviderConnectionAttemptId";
};
export type ProviderStateId = string & {
  readonly [providerStateIdBrand]: "ProviderStateId";
};
export type ProviderProvisioningAttemptId = string & {
  readonly [providerProvisioningAttemptIdBrand]: "ProviderProvisioningAttemptId";
};
export type ConnectorId = string & {
  readonly [connectorIdBrand]: "ConnectorId";
};
export type CaseId = string & { readonly [caseIdBrand]: "CaseId" };
export type AssignmentId = string & {
  readonly [assignmentIdBrand]: "AssignmentId";
};
export type CodexAuthorizationAttemptId = string & {
  readonly [codexAuthorizationAttemptIdBrand]: "CodexAuthorizationAttemptId";
};
export type SlackAppId = string & { readonly [slackAppIdBrand]: "SlackAppId" };
export type SlackInstallationId = string & {
  readonly [slackInstallationIdBrand]: "SlackInstallationId";
};
export type SlackOrganisationConnectionId = string & {
  readonly [slackOrganisationConnectionIdBrand]: "SlackOrganisationConnectionId";
};

export type IdParseError =
  { code: "empty" } | { code: "invalid"; value: string };

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const PORTAL_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PORTAL_HANDLE_MAX_CHARS = 63;
const THREAD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

export function parseOrganisationId(
  raw: string,
): Result<OrganisationId, IdParseError> {
  const value = raw.trim();

  const parsed = parseStableId(value);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value as OrganisationId };
}

// An organisation identifier is a kind prefix and a unique part. An
// Organisation carried over from before the Organisation rename keeps its
// earlier prefix, so names derived from the identifier take the unique part
// and never assume the prefix.
export function organisationIdUniquePart(
  organisationId: OrganisationId,
): string {
  return organisationId.slice(organisationId.indexOf("_") + 1);
}

export function parseOrganisationHandle(
  raw: string,
): Result<OrganisationHandle, IdParseError> {
  const parsed = parsePortalHandle(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value as OrganisationHandle }
    : parsed;
}

export function parseWorkspaceHandle(
  raw: string,
): Result<WorkspaceHandle, IdParseError> {
  const parsed = parsePortalHandle(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value as WorkspaceHandle }
    : parsed;
}

export function parseWorkspaceId(
  raw: string,
): Result<WorkspaceId, IdParseError> {
  const value = raw.trim();

  const parsed = parseStableId(value);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value as WorkspaceId };
}

export function parseChannelId(raw: string): Result<ChannelId, IdParseError> {
  const value = raw.trim();

  const parsed = parseStableId(value);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value as ChannelId };
}

export function parseSessionId(raw: string): Result<SessionId, IdParseError> {
  const value = raw.trim();

  const parsed = parseStableId(value);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value as SessionId };
}

export function parseConnectorId(
  raw: string,
): Result<ConnectorId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok ? { ok: true, value: parsed.value as ConnectorId } : parsed;
}

export function parseCaseId(raw: string): Result<CaseId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok ? { ok: true, value: parsed.value as CaseId } : parsed;
}

export function parseAssignmentId(
  raw: string,
): Result<AssignmentId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok ? { ok: true, value: parsed.value as AssignmentId } : parsed;
}

export function parseCodexAuthorizationAttemptId(
  raw: string,
): Result<CodexAuthorizationAttemptId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as CodexAuthorizationAttemptId }
    : parsed;
}

export function parseSlackAppId(raw: string): Result<SlackAppId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok ? { ok: true, value: parsed.value as SlackAppId } : parsed;
}

export function parseSlackInstallationId(
  raw: string,
): Result<SlackInstallationId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as SlackInstallationId }
    : parsed;
}

export function parseSlackOrganisationConnectionId(
  raw: string,
): Result<SlackOrganisationConnectionId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as SlackOrganisationConnectionId }
    : parsed;
}

export function parseThreadKey(raw: string): Result<ThreadKey, IdParseError> {
  const value = raw.trim();

  if (value.length === 0) {
    return { ok: false, error: { code: "empty" } };
  }

  if (!THREAD_KEY_PATTERN.test(value)) {
    return { ok: false, error: { code: "invalid", value } };
  }

  return { ok: true, value: value as ThreadKey };
}

export function parseThreadId(raw: string): Result<ThreadId, IdParseError> {
  const value = raw.trim();
  const parsed = parseStableId(value);

  return parsed.ok ? { ok: true, value: parsed.value as ThreadId } : parsed;
}

export function parseBlockId(raw: string): Result<BlockId, IdParseError> {
  const value = raw.trim();
  const parsed = parseStableId(value);

  return parsed.ok ? { ok: true, value: parsed.value as BlockId } : parsed;
}

export function parseRequestId(raw: string): Result<RequestId, IdParseError> {
  const value = raw.trim();

  const parsed = parseStableId(value);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value as RequestId };
}

export function parseControlSessionId(
  raw: string,
): Result<ControlSessionId, IdParseError> {
  const parsed = parseStableId(raw.trim());

  return parsed.ok
    ? { ok: true, value: parsed.value as ControlSessionId }
    : parsed;
}

export function parsePersonId(raw: string): Result<PersonId, IdParseError> {
  const parsed = parseStableId(raw.trim());

  return parsed.ok ? { ok: true, value: parsed.value as PersonId } : parsed;
}

export function parseProviderConnectionId(
  raw: string,
): Result<ProviderConnectionId, IdParseError> {
  const parsed = parseStableId(raw.trim());

  return parsed.ok
    ? { ok: true, value: parsed.value as ProviderConnectionId }
    : parsed;
}

export function parseIntegrationAccountId(
  raw: string,
): Result<IntegrationAccountId, IdParseError> {
  const parsed = parseStableId(raw.trim());

  return parsed.ok
    ? { ok: true, value: parsed.value as IntegrationAccountId }
    : parsed;
}

export function parseProviderWebhookId(
  raw: string,
): Result<ProviderWebhookId, IdParseError> {
  const parsed = parseStableId(raw.trim());

  return parsed.ok
    ? { ok: true, value: parsed.value as ProviderWebhookId }
    : parsed;
}

export function parseSetupSnapshotId(
  raw: string,
): Result<SetupSnapshotId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as SetupSnapshotId }
    : parsed;
}

export function parseActivationAttemptId(
  raw: string,
): Result<ActivationAttemptId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as ActivationAttemptId }
    : parsed;
}

export function parseActivationReceiptId(
  raw: string,
): Result<ActivationReceiptId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as ActivationReceiptId }
    : parsed;
}

export function parseProviderConnectionAttemptId(
  raw: string,
): Result<ProviderConnectionAttemptId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as ProviderConnectionAttemptId }
    : parsed;
}

export function parseProviderStateId(
  raw: string,
): Result<ProviderStateId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as ProviderStateId }
    : parsed;
}

export function parseProviderProvisioningAttemptId(
  raw: string,
): Result<ProviderProvisioningAttemptId, IdParseError> {
  const parsed = parseStableId(raw.trim());
  return parsed.ok
    ? { ok: true, value: parsed.value as ProviderProvisioningAttemptId }
    : parsed;
}

export function newControlSessionId(): ControlSessionId {
  return parseGeneratedId(parseControlSessionId, "control_session");
}

export function newOrganisationId(): OrganisationId {
  return parseGeneratedId(parseOrganisationId, "organisation");
}

export function newWorkspaceId(): WorkspaceId {
  return parseGeneratedId(parseWorkspaceId, "workspace");
}

export function newPersonId(): PersonId {
  return parseGeneratedId(parsePersonId, "person");
}

export function newProviderConnectionId(): ProviderConnectionId {
  return parseGeneratedId(parseProviderConnectionId, "provider_connection");
}

export function newIntegrationAccountId(): IntegrationAccountId {
  return parseGeneratedId(parseIntegrationAccountId, "integration_account");
}

export function newProviderWebhookId(): ProviderWebhookId {
  return parseGeneratedId(parseProviderWebhookId, "provider_webhook");
}

export function newSlackInstallationId(): SlackInstallationId {
  return parseGeneratedId(parseSlackInstallationId, "slack_installation");
}

export function newSlackOrganisationConnectionId(): SlackOrganisationConnectionId {
  return parseGeneratedId(
    parseSlackOrganisationConnectionId,
    "slack_organisation_connection",
  );
}

export function newSetupSnapshotId(): SetupSnapshotId {
  return parseGeneratedId(parseSetupSnapshotId, "setup_snapshot");
}

export function newActivationAttemptId(): ActivationAttemptId {
  return parseGeneratedId(parseActivationAttemptId, "activation_attempt");
}

export function newActivationReceiptId(): ActivationReceiptId {
  return parseGeneratedId(parseActivationReceiptId, "activation_receipt");
}

export function newProviderConnectionAttemptId(): ProviderConnectionAttemptId {
  return parseGeneratedId(parseProviderConnectionAttemptId, "provider_attempt");
}

export function newProviderStateId(): ProviderStateId {
  return parseGeneratedId(parseProviderStateId, "provider_state");
}

export function newProviderProvisioningAttemptId(): ProviderProvisioningAttemptId {
  return parseGeneratedId(
    parseProviderProvisioningAttemptId,
    "provisioning_attempt",
  );
}

export function newCodexAuthorizationAttemptId(): CodexAuthorizationAttemptId {
  return parseGeneratedId(
    parseCodexAuthorizationAttemptId,
    "codex_authorization",
  );
}

export function newRequestId(): RequestId {
  return crypto.randomUUID() as RequestId;
}

export function canonicalThreadKey(threadId: ThreadId): ThreadKey {
  const parsed = parseThreadKey(`thread:${threadId}`);

  if (!parsed.ok) {
    throw new Error("canonical thread key invariant failed");
  }

  return parsed.value;
}

export function threadIdFromCanonicalThreadKey(
  threadKey: ThreadKey,
): Result<ThreadId, IdParseError> {
  const prefix = "thread:";

  return threadKey.startsWith(prefix)
    ? parseThreadId(threadKey.slice(prefix.length))
    : { ok: false, error: { code: "invalid", value: threadKey } };
}

export function sandboxObjectName(sandboxId: SandboxId): string {
  return `sandbox:${sandboxId}`;
}

export function poolObjectName(regionBucket: string): string {
  return `pool:${regionBucket}`;
}

function parseStableId(value: string): Result<string, IdParseError> {
  if (value.length === 0) {
    return { ok: false, error: { code: "empty" } };
  }

  if (!STABLE_ID_PATTERN.test(value)) {
    return { ok: false, error: { code: "invalid", value } };
  }

  return { ok: true, value };
}

function parsePortalHandle(raw: string): Result<string, IdParseError> {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: { code: "empty" } };
  }
  if (
    value.length > PORTAL_HANDLE_MAX_CHARS ||
    !PORTAL_HANDLE_PATTERN.test(value)
  ) {
    return { ok: false, error: { code: "invalid", value } };
  }
  return { ok: true, value };
}

function parseGeneratedId<TValue>(
  parser: (raw: string) => Result<TValue, IdParseError>,
  prefix: string,
): TValue {
  const parsed = parser(`${prefix}_${crypto.randomUUID()}`);

  if (!parsed.ok) {
    throw new Error(`generated ${prefix} id invariant failed`);
  }

  return parsed.value;
}
