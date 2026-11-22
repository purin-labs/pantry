import type { Env } from "@purin-labs/kernel/env";
import {
  approveCustomConnectorRevision,
  CUSTOM_CONNECTOR_REJECTION_REASON_MAX_LENGTH,
  createCustomConnectorDraft,
  createCustomConnectorRevision,
  disableCustomConnector,
  listCustomConnectorSummaries,
  parseCustomConnectorAuthoringDigest,
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  prepareCustomConnectorDraftDocument,
  rejectCustomConnectorRevision,
  removeCustomConnector,
  resolveCustomConnectorDetail,
  resumeCustomConnector,
  retireCustomConnectorRevision,
  validateCustomConnectorRevision,
  type CustomConnectorApprovalReview,
  type CustomConnectorId,
  type CustomConnectorRevision,
} from "../../../custom-connectors";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, hasExactKeys, isRecord } from "@purin-labs/std";
import {
  type CustomConnectorControlRoute,
  parseRevisionSegment,
} from "../custom-connectors";
import {
  type MutationContext,
  beginMutation,
  completeMutation,
  customError,
} from "./mutation";

export async function handleList(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const catalog = await listCustomConnectorSummaries({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  return catalog.ok
    ? controlJson({ kind: "custom_connector_catalog", items: catalog.value })
    : customError(catalog.error.code);
}

export async function handleDetail(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnector">,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  if (!connectorId.ok) return customError("custom_connector_not_found");
  const detail = await resolveCustomConnectorDetail({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    connectorId: connectorId.value,
  });
  return detail.ok
    ? controlJson({ kind: "custom_connector_detail", ...detail.value })
    : customError(detail.error.code);
}

export async function handleCreate(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || !hasExactKeys(body.value, ["document"])) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const started = await beginMutation(
    request,
    env,
    organisationIdRaw,
    body.value,
    "custom_connector.create",
    "collection",
  );
  if (started instanceof Response) return started;
  const document = await prepareCustomConnectorDraftDocument(
    body.value.document,
  );
  if (!document.ok) return controlError(document.error.code, 422);
  const revision = await createCustomConnectorDraft({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    createdByUserId: started.authorized.authenticated.session.userId,
    document: document.value,
    now: started.mutationIdentity.createdAt,
  });
  return completeMutation(
    env,
    started,
    {
      kind: "custom_connector_created",
      connectorId: revision.connectorId,
      revision,
    },
    true,
  );
}

export async function handleCreateRevision(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorRevisions">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  if (!connectorId.ok) return customError("custom_connector_not_found");
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    !hasExactKeys(body.value, ["document", "expectedHeadRevision"])
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const expected = parseCustomConnectorRevision(
    body.value.expectedHeadRevision,
  );
  const document = await prepareCustomConnectorDraftDocument(
    body.value.document,
  );
  if (!expected.ok || !document.ok) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    "custom_connector.revision.create",
    `connectors/${connectorId.value}/revisions`,
  );
  if (started instanceof Response) return started;
  const created = await createCustomConnectorRevision({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    connectorId: connectorId.value,
    expectedHeadRevision: expected.value,
    createdByUserId: started.authorized.authenticated.session.userId,
    document: document.value,
    now: started.mutationIdentity.createdAt,
  });
  if (!created.ok) return customError(created.error.code);
  return completeMutation(
    env,
    started,
    {
      kind: "custom_connector_revision_created",
      revision: created.value,
    },
    true,
  );
}

export async function handleRevisionAction(
  request: Request,
  env: Env,
  route: Variant<CustomConnectorControlRoute, "customConnectorRevisionAction">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  const revision = parseRevisionSegment(route.revisionRaw);
  if (!connectorId.ok || !revision.ok) {
    return customError("custom_connector_revision_not_found");
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("custom_connector_request_invalid", 422);
  const action = route.action;
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    `custom_connector.revision.${action}`,
    `connectors/${connectorId.value}/revisions/${revision.value}/${action}`,
  );
  if (started instanceof Response) return started;
  switch (action) {
    case "validate":
      return validateRevision(
        env,
        started,
        connectorId.value,
        revision.value,
        body.value,
      );
    case "approve":
      return approveRevision(
        env,
        started,
        connectorId.value,
        revision.value,
        body.value,
      );
    case "reject":
      return rejectRevision(
        env,
        started,
        connectorId.value,
        revision.value,
        body.value,
      );
    case "retire":
      return retireRevision(
        env,
        started,
        connectorId.value,
        revision.value,
        body.value,
      );
    default:
      return assertNever(action);
  }
}

async function validateRevision(
  env: Env,
  context: MutationContext,
  connectorId: CustomConnectorId,
  revision: CustomConnectorRevision,
  body: JsonRecord,
): Promise<Response> {
  if (!hasExactKeys(body, ["authoringDigest"])) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const digest = parseCustomConnectorAuthoringDigest(body.authoringDigest);
  if (!digest.ok) return controlError("custom_connector_request_invalid", 422);
  const result = await validateCustomConnectorRevision({
    db: context.authorized.executionScope.database,
    organisationId: context.authorized.organisationId,
    connectorId,
    revision,
    authoringDigest: digest.value,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code, result.error);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_revision_validated", revision: result.value },
    true,
  );
}

async function approveRevision(
  env: Env,
  context: MutationContext,
  connectorId: CustomConnectorId,
  revision: CustomConnectorRevision,
  body: JsonRecord,
): Promise<Response> {
  if (!hasExactKeys(body, ["definitionDigest", "review"])) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const digest = parseCustomConnectorDefinitionDigest(body.definitionDigest);
  const review = parseApprovalReview(body.review);
  if (!digest.ok || review === null) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await approveCustomConnectorRevision({
    db: context.authorized.executionScope.database,
    organisationId: context.authorized.organisationId,
    connectorId,
    revision,
    definitionDigest: digest.value,
    approvedByUserId: context.authorized.authenticated.session.userId,
    review,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_revision_approved", revision: result.value },
    true,
  );
}

async function rejectRevision(
  env: Env,
  context: MutationContext,
  connectorId: CustomConnectorId,
  revision: CustomConnectorRevision,
  body: JsonRecord,
): Promise<Response> {
  if (!hasExactKeys(body, ["definitionDigest", "reason"])) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const digest = parseCustomConnectorDefinitionDigest(body.definitionDigest);
  const reason =
    typeof body.reason === "string" ? body.reason.trim() : undefined;
  if (
    !digest.ok ||
    reason === undefined ||
    reason.length === 0 ||
    reason.length > CUSTOM_CONNECTOR_REJECTION_REASON_MAX_LENGTH
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await rejectCustomConnectorRevision({
    db: context.authorized.executionScope.database,
    organisationId: context.authorized.organisationId,
    connectorId,
    revision,
    definitionDigest: digest.value,
    rejectedByUserId: context.authorized.authenticated.session.userId,
    reason,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_revision_rejected", revision: result.value },
    true,
  );
}

async function retireRevision(
  env: Env,
  context: MutationContext,
  connectorId: CustomConnectorId,
  revision: CustomConnectorRevision,
  body: JsonRecord,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["affectedIntegrationAccountIds", "definitionDigest"])
  ) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const digest = parseCustomConnectorDefinitionDigest(body.definitionDigest);
  const affected = parseStringArray(body.affectedIntegrationAccountIds);
  if (!digest.ok || affected === null) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const result = await retireCustomConnectorRevision({
    db: context.authorized.executionScope.database,
    organisationId: context.authorized.organisationId,
    connectorId,
    revision,
    definitionDigest: digest.value,
    affectedIntegrationAccountIds: affected,
    retiredByUserId: context.authorized.authenticated.session.userId,
    now: context.mutationIdentity.createdAt,
  });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    context,
    { kind: "custom_connector_revision_retired", revision: result.value },
    true,
  );
}

export async function handleConnectorLifecycle(
  request: Request,
  env: Env,
  route:
    | Variant<CustomConnectorControlRoute, "customConnector">
    | Variant<CustomConnectorControlRoute, "customConnectorAction">,
  action: "disable" | "resume" | "remove",
): Promise<Response> {
  if (
    (action === "remove" && request.method !== "DELETE") ||
    (action !== "remove" && request.method !== "POST")
  ) {
    return controlError("method_not_allowed", 405);
  }
  const connectorId = parseCustomConnectorId(route.connectorIdRaw);
  if (!connectorId.ok) return customError("custom_connector_not_found");
  const body = await readJsonRecord(request);
  if (!body.ok || !hasExactKeys(body.value, ["expectedHeadRevision"])) {
    return controlError("custom_connector_request_invalid", 422);
  }
  const revision = parseCustomConnectorRevision(
    body.value.expectedHeadRevision,
  );
  if (!revision.ok)
    return controlError("custom_connector_request_invalid", 422);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    body.value,
    `custom_connector.${action}`,
    `connectors/${connectorId.value}/${action}`,
  );
  if (started instanceof Response) return started;
  const base = {
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    connectorId: connectorId.value,
    expectedHeadRevision: revision.value,
    now: started.mutationIdentity.createdAt,
  };
  const result =
    action === "disable"
      ? await disableCustomConnector({
          ...base,
          disabledByUserId: started.authorized.authenticated.session.userId,
        })
      : action === "resume"
        ? await resumeCustomConnector(base)
        : await removeCustomConnector({ ...base, keys: env });
  if (!result.ok) return customError(result.error.code);
  return completeMutation(
    env,
    started,
    {
      kind: `custom_connector_${action}d`,
      connectorId: connectorId.value,
      lifecycle: result.value.lifecycle,
    },
    true,
  );
}

function parseApprovalReview(
  raw: unknown,
): CustomConnectorApprovalReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["effects", "origin"]) ||
    typeof raw.origin !== "string" ||
    !Array.isArray(raw.effects)
  ) {
    return null;
  }
  const effects: { operationId: string; effect: "read" }[] = [];
  for (const effect of raw.effects) {
    if (
      !isRecord(effect) ||
      !hasExactKeys(effect, ["effect", "operationId"]) ||
      effect.effect !== "read" ||
      typeof effect.operationId !== "string"
    ) {
      return null;
    }
    effects.push({ operationId: effect.operationId, effect: "read" });
  }
  return { origin: raw.origin, effects };
}

function parseStringArray(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const value of raw) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      values.includes(value)
    ) {
      return null;
    }
    values.push(value);
  }
  return values;
}
