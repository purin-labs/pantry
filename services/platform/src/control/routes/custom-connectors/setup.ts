import { customConnectorFetchOf } from "../../../custom-connectors/egress";
import type { Env } from "@purin-labs/kernel/env";
import {
  attachCustomConnectorCandidateCredential,
  authorizeCustomConnectorSetupCommit,
  cancelCustomConnectorSetup,
  commitExistingCustomConnectorAccount,
  commitNewCustomConnectorAccount,
  createCustomConnectorIdentityTestExecutor,
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  parseCustomConnectorSetupAttemptId,
  resolveCustomConnectorSetupAttempt,
  startCustomConnectorSetup,
  testCustomConnectorCandidate,
  type CustomConnectorSetupAttemptId,
  type CustomConnectorSetupTarget,
} from "../../../custom-connectors";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import type { CustomConnectorControlRoute } from "../custom-connectors";
import {
  type MutationContext,
  beginMutation,
  completeMutation,
  customError,
} from "./mutation";

export async function handleStartSetup(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorSetupAttempts">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  if (!connectorId.ok) return customError("custom_connector_not_found");
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    !hasExactKeys(body.value, [
      "connectorRevision",
      "definitionDigest",
      "target",
    ])
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const revision = parseCustomConnectorRevision(body.value.connectorRevision);
  const digest = parseCustomConnectorDefinitionDigest(
    body.value.definitionDigest,
  );
  const target = parseSetupTarget(body.value.target);
  if (!revision.ok || !digest.ok || target === null) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "custom_connector.setup.start",
    `connectors/${connectorId.value}/setup-attempts`,
  );
  if (started instanceof Response) return started;
  const result = await startCustomConnectorSetup({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    connectorId: connectorId.value,
    connectorRevision: revision.value,
    definitionDigest: digest.value,
    target,
    createdByUserId: started.authorized.authenticated.session.userId,
    now: started.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    started,
    { kind: "custom_connector_setup_started", attempt: result.value },
    true,
  );
}

export async function handleReadSetup(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorSetupAttempt">,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  const attemptId = parseCustomConnectorSetupAttemptId(route.attemptIdRaw);
  if (!connectorId.ok || !attemptId.ok) {
    return customError("custom_connector_setup_not_found");
  }
  const result = await resolveCustomConnectorSetupAttempt({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
  });
  if (!result.ok || result.value.connectorId !== connectorId.value) {
    return customError("custom_connector_setup_not_found");
  }
  return controlJson({ kind: "custom_connector_setup", attempt: result.value });
}

export async function handleSetupAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorSetupAction">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  const attemptId = parseCustomConnectorSetupAttemptId(route.attemptIdRaw);
  if (!connectorId.ok || !attemptId.ok) {
    return customError("custom_connector_setup_not_found");
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("custom_connector_request_invalid", 422);
  const action = route.action;
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    `custom_connector.setup.${action}`,
    `connectors/${connectorId.value}/setup-attempts/${attemptId.value}/${action}`,
  );
  if (started instanceof Response) return started;
  const current = await resolveCustomConnectorSetupAttempt({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    attemptId: attemptId.value,
  });
  if (!current.ok || current.value.connectorId !== connectorId.value) {
    return customError("custom_connector_setup_not_found");
  }
  switch (action) {
    case "credential":
      return attachCredential(env, started, attemptId.value, body.value);
    case "test":
      return testCredential(env, started, attemptId.value, body.value);
    case "commit":
      return commitSetup(env, started, attemptId.value, body.value);
    case "cancel":
      return cancelSetup(env, started, attemptId.value, body.value);
    default:
      return assertNever(action);
  }
}

async function attachCredential(
  env: Env,
  context: MutationContext,
  attemptId: CustomConnectorSetupAttemptId,
  body: JsonRecord,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["credentialValue", "expectedAttemptRevision"]) ||
    typeof body.credentialValue !== "string" ||
    !isPositiveInteger(body.expectedAttemptRevision)
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await attachCustomConnectorCandidateCredential({
    db: context.authorized.executionScope.database,
    keys: env,
    organisationId: context.authorized.organisationId,
    attemptId,
    expectedAttemptRevision: body.expectedAttemptRevision,
    credentialValue: body.credentialValue,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_credential_attached", attempt: result.value },
    true,
  );
}

async function testCredential(
  env: Env,
  context: MutationContext,
  attemptId: CustomConnectorSetupAttemptId,
  body: JsonRecord,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["expectedAttemptRevision"]) ||
    !isPositiveInteger(body.expectedAttemptRevision)
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await testCustomConnectorCandidate({
    db: context.authorized.executionScope.database,
    keys: env,
    organisationId: context.authorized.organisationId,
    attemptId,
    expectedAttemptRevision: body.expectedAttemptRevision,
    executor: createCustomConnectorIdentityTestExecutor(
      customConnectorFetchOf(
        env.CUSTOM_CONNECTOR_FETCH,
        context.authorized.executionScope.placement,
      ),
    ),
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code, result.error);
  const storedBody = {
    kind: "custom_connector_test_verified",
    attempt: result.value.attempt,
  };
  return completeMutation(env, context, storedBody, true, {
    ...storedBody,
    preview: result.value.preview,
  });
}

async function commitSetup(
  env: Env,
  context: MutationContext,
  attemptId: CustomConnectorSetupAttemptId,
  body: JsonRecord,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["expectedAttemptRevision"]) ||
    !isPositiveInteger(body.expectedAttemptRevision)
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const authorization = await authorizeCustomConnectorSetupCommit({
    db: context.authorized.executionScope.database,
    keys: env,
    organisationId: context.authorized.organisationId,
    attemptId,
    expectedAttemptRevision: body.expectedAttemptRevision,
    now: context.mutationIdentity.createdAt,
  });
  if (!authorization.ok) return customError(authorization.error.code);
  const common = {
    db: context.authorized.executionScope.database,
    authorization: authorization.value,
    committedByUserId: context.authorized.authenticated.session.userId,
    expectedConfigurationVersion: context.boundary.expectedConfigurationVersion,
    now: context.mutationIdentity.createdAt,
  };
  const result =
    authorization.value.attempt.target.kind === "new_account"
      ? await commitNewCustomConnectorAccount(common)
      : await commitExistingCustomConnectorAccount(common);
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_setup_committed", account: result.value },
    false,
  );
}

async function cancelSetup(
  env: Env,
  context: MutationContext,
  attemptId: CustomConnectorSetupAttemptId,
  body: JsonRecord,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["expectedAttemptRevision"]) ||
    !isPositiveInteger(body.expectedAttemptRevision)
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await cancelCustomConnectorSetup({
    db: context.authorized.executionScope.database,
    organisationId: context.authorized.organisationId,
    attemptId,
    expectedAttemptRevision: body.expectedAttemptRevision,
    cancelledByUserId: context.authorized.authenticated.session.userId,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_setup_cancelled", attempt: result.value },
    true,
  );
}

function parseSetupTarget(raw: unknown): CustomConnectorSetupTarget | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "new_account") {
    return hasExactKeys(raw, ["environment", "kind"]) &&
      (raw.environment === "development" || raw.environment === "production")
      ? { kind: "new_account", environment: raw.environment }
      : null;
  }
  if (
    raw.kind !== "rotate_account" &&
    raw.kind !== "upgrade_account" &&
    raw.kind !== "resume_account"
  ) {
    return null;
  }
  if (
    !hasExactKeys(raw, [
      "expectedBindingRevision",
      "integrationAccountId",
      "kind",
    ]) ||
    !isPositiveInteger(raw.expectedBindingRevision)
  ) {
    return null;
  }
  if (typeof raw.integrationAccountId !== "string") return null;
  const accountId = parseIntegrationAccountId(raw.integrationAccountId);
  return accountId.ok
    ? {
        kind: raw.kind,
        integrationAccountId: accountId.value,
        expectedBindingRevision: raw.expectedBindingRevision,
      }
    : null;
}
