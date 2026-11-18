import type { RequestAuthority } from "@seams/contracts";

import type { JsonObject } from "./http";
import { parsePersonId, type PersonId } from "./data/person-authz";
import { parseUserId, type UserId } from "./ids";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  parseAssignmentId,
  parseCaseId,
  parseChannelId,
  parseRequestId,
  parseSessionId,
  parseSlackAppId,
  parseConnectorId,
  parseThreadKey,
  parseWorkspaceId,
  type IntegrationAccountId,
  type AssignmentId,
  type CaseId,
  type ConnectorId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "./ids";
import type { Result } from "./result";
import type { ContextProjectionCommand } from "./context/projection";
import { parseContextProjectionCommand } from "./context/projection";
import {
  FILE_PROJECTION_COMMAND_TYPE,
  parseFileProjectionCommand,
  type FileProjectionCommand,
} from "./context/files";
import { parseStoredRequestAuthority } from "./request-authority";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "./placement";
import {
  parseSlackEventId,
  parseSlackMessageTrigger,
  parseSlackUserId,
  type SlackMessageEvent,
} from "./slack/events";
import type { Variant } from "@seams/type-utils";
import { isRecord } from "@seams/std";

export type SlackCaseEventEnvelope = {
  requestId: RequestId;
  receivedAt: number;
  event: SlackMessageEvent;
};

export type SlackCaseCommand = SlackCaseEventEnvelope & {
  type: "slack.case_command.v1";
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  principalId: PersonId;
  /**
   * The Pantry control identity linked to the verified Slack account.
   *
   * Carried so a configuration confirmation is attributed to the account that
   * sent it rather than anything the message claims about itself. Null for a
   * message admitted before this field existed: it still gets its agent turn,
   * and simply cannot settle a configuration change.
   */
  userId: UserId | null;
  requestAuthority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation"
  >;
  target: {
    caseId: CaseId;
    connectorId: ConnectorId;
    sessionId: SessionId;
    assignmentId: AssignmentId;
    placement: OrganisationPlacement;
  };
};

export type CommerceDeliveryQueueMessage = {
  type: "commerce.delivery.v1";
  requestId: RequestId;
  receivedAt: number;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  labRunId: string | null;
  canonicalDeliveryJson: string;
  canonicalCueFactsJson: string;
};

export type ShopifyCommerceRefreshQueueMessage = {
  readonly type: "shopify.commerce_refresh.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly target: {
    readonly kind: "order";
    readonly orderGid: string;
  };
};

export type CommerceOutboxReconcileQueueMessage = {
  readonly type: "underclerk.outbox_reconcile.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
};

export type AgentScheduleDispatchQueueMessage = {
  readonly type: "agent_schedule.dispatch.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly bindingId: string;
  readonly windowKey: string;
};

export type EmailChangeQueueMessage = {
  readonly type: "email.change.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly historyId: string;
  readonly notificationId: string;
};

export type IngressQueueMessage =
  | CommerceDeliveryQueueMessage
  | ShopifyCommerceRefreshQueueMessage
  | CommerceOutboxReconcileQueueMessage
  | AgentScheduleDispatchQueueMessage
  | EmailChangeQueueMessage
  | FileProjectionCommand
  | ContextProjectionCommand;

export type IngressQueueMessageError =
  | { code: "object_required" }
  | { code: "missing_field"; field: string }
  | { code: "invalid_field"; field: string };

function readOptionalUserId(
  body: JsonObject,
): Result<UserId | null, IngressQueueMessageError> {
  const raw = body.userId;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: { code: "invalid_field", field: "userId" },
    };
  }
  const parsed = parseUserId(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : {
        ok: false,
        error: { code: "invalid_field", field: "userId" },
      };
}

export function createSlackCaseCommand(input: {
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly principalId: PersonId;
  readonly userId: UserId | null;
  readonly requestAuthority: SlackCaseCommand["requestAuthority"];
  readonly event: SlackMessageEvent;
  readonly target: SlackCaseCommand["target"];
}): SlackCaseCommand {
  return { type: "slack.case_command.v1", ...input };
}

export function createCommerceDeliveryQueueMessage(input: {
  requestId: RequestId;
  receivedAt: number;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  labRunId: string | null;
  canonicalDeliveryJson: string;
  canonicalCueFactsJson: string;
}): CommerceDeliveryQueueMessage {
  return {
    type: "commerce.delivery.v1",
    requestId: input.requestId,
    receivedAt: input.receivedAt,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    labRunId: input.labRunId,
    canonicalDeliveryJson: input.canonicalDeliveryJson,
    canonicalCueFactsJson: input.canonicalCueFactsJson,
  };
}

export function createShopifyCommerceRefreshQueueMessage(input: {
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly target: ShopifyCommerceRefreshQueueMessage["target"];
}): ShopifyCommerceRefreshQueueMessage {
  return { type: "shopify.commerce_refresh.v1", ...input };
}

export function createCommerceOutboxReconcileQueueMessage(
  input: Readonly<{
    requestId: RequestId;
    receivedAt: number;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): CommerceOutboxReconcileQueueMessage {
  return { type: "underclerk.outbox_reconcile.v1", ...input };
}

export function createAgentScheduleDispatchQueueMessage(
  input: Readonly<{
    requestId: RequestId;
    receivedAt: number;
    organisationId: OrganisationId;
    bindingId: string;
    windowKey: string;
  }>,
): AgentScheduleDispatchQueueMessage {
  return { type: "agent_schedule.dispatch.v1", ...input };
}

export function createEmailChangeQueueMessage(
  input: Readonly<{
    requestId: RequestId;
    receivedAt: number;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    historyId: string;
    notificationId: string;
  }>,
): EmailChangeQueueMessage {
  return { type: "email.change.v1", ...input };
}

export function parseIngressQueueMessage(
  body: unknown,
): Result<IngressQueueMessage, IngressQueueMessageError> {
  if (!isRecord(body)) {
    return { ok: false, error: { code: "object_required" } };
  }

  const messageType = readRequiredString(body, "type");

  if (!messageType.ok) {
    return messageType;
  }

  switch (messageType.value) {
    case "commerce.delivery.v1":
      return parseCommerceEventQueuePayload(body);
    case "shopify.commerce_refresh.v1":
      return parseShopifyCommerceRefreshQueuePayload(body);
    case "underclerk.outbox_reconcile.v1":
      return parseCommerceOutboxReconcileQueuePayload(body);
    case "agent_schedule.dispatch.v1":
      return parseAgentScheduleDispatchQueuePayload(body);
    case "email.change.v1":
      return parseEmailChangeQueuePayload(body);
    case "context.projection.v1":
      return parseContextProjectionQueuePayload(body);
    case FILE_PROJECTION_COMMAND_TYPE:
      return parseFileProjectionQueuePayload(body);
    default:
      return { ok: false, error: { code: "invalid_field", field: "type" } };
  }
}

function parseFileProjectionQueuePayload(
  body: JsonObject,
): Result<FileProjectionCommand, IngressQueueMessageError> {
  const parsed = parseFileProjectionCommand(body);
  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "invalid_field", field: parsed.error.field },
      };
}

export function parseSlackCaseCommand(
  body: unknown,
): Result<SlackCaseCommand, IngressQueueMessageError> {
  if (!isRecord(body)) return { ok: false, error: { code: "object_required" } };
  const type = readRequiredString(body, "type");
  if (!type.ok) return type;
  if (type.value !== "slack.case_command.v1") {
    return { ok: false, error: { code: "invalid_field", field: "type" } };
  }
  const parsed = parseSlackCaseEventEnvelope(body);
  if (!parsed.ok) return parsed;
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = readIntegrationAccountId(body);
  if (!integrationAccountId.ok) return integrationAccountId;
  const principalIdRaw = readRequiredString(body, "principalId");
  if (!principalIdRaw.ok) return principalIdRaw;
  const principalId = parsePersonId(principalIdRaw.value);
  if (principalId === null)
    return {
      ok: false,
      error: { code: "invalid_field", field: "principalId" },
    };
  // Absent on a message admitted before this field existed. Present but
  // malformed is corruption, not an old record, and is refused.
  const userId = readOptionalUserId(body);
  if (!userId.ok) return userId;
  const target = parseSlackCaseTarget(body);
  if (!target.ok) return target;
  const authority = parseSlackCaseCommandAuthority({
    raw: body.requestAuthority,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    principalId,
    connectorId: target.value.connectorId,
    channelId: parsed.value.event.channelId,
  });
  if (!authority.ok) return authority;
  return {
    ok: true,
    value: {
      type: "slack.case_command.v1",
      requestId: parsed.value.requestId,
      receivedAt: parsed.value.receivedAt,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      principalId,
      userId: userId.value,
      requestAuthority: authority.value,
      event: parsed.value.event,
      target: target.value,
    },
  };
}

/** Parse the request identity and Slack event that Case work carries. */
export function parseSlackCaseEventEnvelope(
  body: unknown,
): Result<SlackCaseEventEnvelope, IngressQueueMessageError> {
  if (!isRecord(body)) return { ok: false, error: { code: "object_required" } };
  const parsed = parseSlackCaseCommandPayload(body);
  if (!parsed.ok) return parsed;
  if (
    parsed.value.event.trigger !== "mention" &&
    parsed.value.event.trigger !== "message"
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.trigger" },
    };
  }
  return parsed;
}

function parseContextProjectionQueuePayload(
  body: JsonObject,
): Result<ContextProjectionCommand, IngressQueueMessageError> {
  const parsed = parseContextProjectionCommand(body);
  if (!parsed.ok) {
    return parsed.error.code === "object_required"
      ? parsed
      : {
          ok: false,
          error: { code: "invalid_field", field: parsed.error.field },
        };
  }
  const organisationId = parseOrganisationId(parsed.value.organisationId);
  const caseId =
    parsed.value.source.kind === "case_entry"
      ? parseCaseId(parsed.value.source.caseId)
      : null;
  return organisationId.ok && caseId?.ok
    ? { ok: true, value: parsed.value }
    : {
        ok: false,
        error: {
          code: "invalid_field",
          field: organisationId.ok ? "source.caseId" : "organisationId",
        },
      };
}

function parseSlackCaseCommandAuthority(
  input: Readonly<{
    raw: unknown;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    principalId: PersonId;
    connectorId: ConnectorId;
    channelId: string;
  }>,
): Result<SlackCaseCommand["requestAuthority"], IngressQueueMessageError> {
  const expectedKind = slackConversationAuthorityKind(input.channelId);
  if (expectedKind === null) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.channelId" },
    };
  }
  const parsed = parseStoredRequestAuthority(input.raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "requestAuthority" },
    };
  }
  const authority = parsed.value.requestAuthority;
  if (
    (authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation") ||
    authority.kind !== expectedKind ||
    authority.organisationId !== input.organisationId ||
    authority.requesterPersonId !== input.principalId ||
    !isSlackCommandRole(authority.role) ||
    authority.connectorId !== input.connectorId ||
    authority.integrationAccountId !== input.integrationAccountId ||
    authority.conversationId !== input.channelId
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "requestAuthority" },
    };
  }
  return { ok: true, value: authority };
}

function isSlackCommandRole(role: string): boolean {
  return role === "owner" || role === "admin" || role === "operator";
}

export function slackConversationAuthorityKind(
  channelId: string,
): SlackCaseCommand["requestAuthority"]["kind"] | null {
  if (channelId.startsWith("D")) return "direct_conversation";
  if (channelId.startsWith("C") || channelId.startsWith("G"))
    return "shared_conversation";
  return null;
}

function parseSlackCaseTarget(
  body: JsonObject,
): Result<SlackCaseCommand["target"], IngressQueueMessageError> {
  const target = readRequiredObject(body, "target");
  if (!target.ok) return target;
  const caseIdRaw = readRequiredString(target.value, "caseId");
  const connectorId = readRequiredString(target.value, "connectorId");
  const sessionIdRaw = readRequiredString(target.value, "sessionId");
  const assignmentId = readRequiredString(target.value, "assignmentId");
  if (
    !caseIdRaw.ok ||
    !connectorId.ok ||
    !sessionIdRaw.ok ||
    !assignmentId.ok
  ) {
    return { ok: false, error: { code: "invalid_field", field: "target" } };
  }
  const caseId = parseCaseId(caseIdRaw.value);
  const connectorIdValue = parseConnectorId(connectorId.value);
  const sessionId = parseSessionId(sessionIdRaw.value);
  const assignmentIdValue = parseAssignmentId(assignmentId.value);
  const placement = parseOrganisationPlacement(
    target.value.placement,
    "target.placement",
  );
  return caseId.ok &&
    connectorIdValue.ok &&
    sessionId.ok &&
    assignmentIdValue.ok &&
    placement.ok
    ? {
        ok: true,
        value: {
          caseId: caseId.value,
          connectorId: connectorIdValue.value,
          sessionId: sessionId.value,
          assignmentId: assignmentIdValue.value,
          placement: placement.value,
        },
      }
    : { ok: false, error: { code: "invalid_field", field: "target" } };
}

function parseCommerceOutboxReconcileQueuePayload(
  body: JsonObject,
): Result<CommerceOutboxReconcileQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);
  if (!requestId.ok) return requestId;
  const receivedAt = readRequiredNumber(body, "receivedAt");
  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = readIntegrationAccountId(body);
  if (!integrationAccountId.ok) return integrationAccountId;
  return {
    ok: true,
    value: {
      type: "underclerk.outbox_reconcile.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
    },
  };
}

function parseEmailChangeQueuePayload(
  body: JsonObject,
): Result<EmailChangeQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);
  if (!requestId.ok) return requestId;
  const receivedAt = readRequiredNumber(body, "receivedAt");
  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = readIntegrationAccountId(body);
  if (!integrationAccountId.ok) return integrationAccountId;
  const historyId = readRequiredString(body, "historyId");
  if (!historyId.ok || !/^[0-9]+$/u.test(historyId.value)) {
    return { ok: false, error: { code: "invalid_field", field: "historyId" } };
  }
  const notificationId = readRequiredString(body, "notificationId");
  if (!notificationId.ok || notificationId.value.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "notificationId" },
    };
  }
  return {
    ok: true,
    value: {
      type: "email.change.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      historyId: historyId.value,
      notificationId: notificationId.value,
    },
  };
}

function parseAgentScheduleDispatchQueuePayload(
  body: JsonObject,
): Result<AgentScheduleDispatchQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);
  if (!requestId.ok) return requestId;
  const receivedAt = readRequiredNumber(body, "receivedAt");
  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const bindingId = readRequiredString(body, "bindingId");
  if (!bindingId.ok || bindingId.value.length > 200) {
    return { ok: false, error: { code: "invalid_field", field: "bindingId" } };
  }
  const windowKey = readRequiredString(body, "windowKey");
  if (!windowKey.ok || windowKey.value.length > 200) {
    return { ok: false, error: { code: "invalid_field", field: "windowKey" } };
  }
  return {
    ok: true,
    value: {
      type: "agent_schedule.dispatch.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      bindingId: bindingId.value,
      windowKey: windowKey.value,
    },
  };
}

function parseShopifyCommerceRefreshQueuePayload(
  body: JsonObject,
): Result<ShopifyCommerceRefreshQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);
  if (!requestId.ok) return requestId;
  const receivedAt = readRequiredNumber(body, "receivedAt");
  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = readIntegrationAccountId(body);
  if (!integrationAccountId.ok) return integrationAccountId;
  const shopDomain = readRequiredString(body, "shopDomain");
  if (
    !shopDomain.ok ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/iu.test(shopDomain.value)
  ) {
    return { ok: false, error: { code: "invalid_field", field: "shopDomain" } };
  }
  const webhookId = readRequiredString(body, "webhookId");
  if (!webhookId.ok || webhookId.value.length > 256) {
    return { ok: false, error: { code: "invalid_field", field: "webhookId" } };
  }
  if (
    !isRecord(body.target) ||
    body.target.kind !== "order" ||
    typeof body.target.orderGid !== "string" ||
    !/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(body.target.orderGid)
  ) {
    return { ok: false, error: { code: "invalid_field", field: "target" } };
  }
  return {
    ok: true,
    value: {
      type: "shopify.commerce_refresh.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      shopDomain: shopDomain.value,
      webhookId: webhookId.value,
      target: { kind: "order", orderGid: body.target.orderGid },
    },
  };
}

function parseCommerceEventQueuePayload(
  body: JsonObject,
): Result<CommerceDeliveryQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);

  if (!requestId.ok) {
    return requestId;
  }

  const receivedAt = readRequiredNumber(body, "receivedAt");

  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }

  const organisationId = readOrganisationId(body);

  if (!organisationId.ok) {
    return organisationId;
  }

  const integrationAccountId = readIntegrationAccountId(body);

  if (!integrationAccountId.ok) {
    return integrationAccountId;
  }

  const labRunId = readNullableRunId(body);

  if (!labRunId.ok) {
    return labRunId;
  }

  const canonicalDeliveryJson = readRequiredString(
    body,
    "canonicalDeliveryJson",
  );

  if (
    !canonicalDeliveryJson.ok ||
    canonicalDeliveryJson.value.length === 0 ||
    canonicalDeliveryJson.value.length > 1_000_000 ||
    !isJsonObjectString(canonicalDeliveryJson.value)
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "canonicalDeliveryJson" },
    };
  }

  const canonicalCueFactsJson = readRequiredString(
    body,
    "canonicalCueFactsJson",
  );

  if (
    !canonicalCueFactsJson.ok ||
    canonicalCueFactsJson.value.length === 0 ||
    canonicalCueFactsJson.value.length > 100_000 ||
    !isJsonArrayString(canonicalCueFactsJson.value)
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "canonicalCueFactsJson" },
    };
  }

  return {
    ok: true,
    value: {
      type: "commerce.delivery.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      labRunId: labRunId.value,
      canonicalDeliveryJson: canonicalDeliveryJson.value,
      canonicalCueFactsJson: canonicalCueFactsJson.value,
    },
  };
}

function parseSlackCaseCommandPayload(
  body: JsonObject,
): Result<SlackCaseEventEnvelope, IngressQueueMessageError> {
  const requestId = readRequestId(body);

  if (!requestId.ok) {
    return requestId;
  }

  const receivedAt = readRequiredNumber(body, "receivedAt");

  if (!receivedAt.ok) {
    return receivedAt;
  }

  const eventBody = readRequiredObject(body, "event");

  if (!eventBody.ok) {
    return eventBody;
  }

  const event = parseQueuedSlackMessageEvent(eventBody.value);

  if (!event.ok) {
    return event;
  }

  return {
    ok: true,
    value: {
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      event: event.value,
    },
  };
}

function parseQueuedSlackMessageEvent(
  body: JsonObject,
): Result<SlackMessageEvent, IngressQueueMessageError> {
  const surfaceKind = readRequiredString(body, "surfaceKind");

  if (!surfaceKind.ok) {
    return surfaceKind;
  }

  if (surfaceKind.value !== "slack") {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.surfaceKind" },
    };
  }

  const appIdRaw = readRequiredString(body, "appId");
  if (!appIdRaw.ok) return appIdRaw;
  const appId = parseSlackAppId(appIdRaw.value);
  if (!appId.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.appId" },
    };
  }

  const trigger = readSlackTrigger(body);

  if (!trigger.ok) {
    return trigger;
  }

  const workspaceId = readWorkspaceId(body);

  if (!workspaceId.ok) {
    return workspaceId;
  }

  const channelId = readChannelId(body);

  if (!channelId.ok) {
    return channelId;
  }

  const sessionId = readSessionId(body);

  if (!sessionId.ok) {
    return sessionId;
  }

  const threadKey = readThreadKey(body);

  if (!threadKey.ok) {
    return threadKey;
  }

  const eventId = readSlackEventIdField(body);

  if (!eventId.ok) {
    return eventId;
  }

  const eventTs = readRequiredString(body, "eventTs");

  if (!eventTs.ok) {
    return eventTs;
  }

  const messageTs = readRequiredString(body, "messageTs");

  if (!messageTs.ok) {
    return messageTs;
  }

  const threadTs = readRequiredString(body, "threadTs");

  if (!threadTs.ok) {
    return threadTs;
  }

  const authorRaw = readRequiredString(body, "author");

  if (!authorRaw.ok) {
    return authorRaw;
  }

  const author = parseSlackUserId(authorRaw.value, "author");

  if (!author.ok) {
    return author;
  }

  const authored = readQueuedSlackAuthoredParts(body);

  if (!authored.ok) {
    return authored;
  }

  const files = readQueuedSlackFiles(body);

  if (!files.ok) {
    return files;
  }

  return {
    ok: true,
    value: {
      surfaceKind: "slack",
      appId: appId.value,
      trigger: trigger.value,
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      sessionId: sessionId.value,
      threadKey: threadKey.value,
      eventId: eventId.value,
      eventTs: eventTs.value,
      messageTs: messageTs.value,
      threadTs: threadTs.value,
      author: author.value,
      authored: authored.value,
      files: files.value,
    },
  };
}

function readQueuedSlackAuthoredParts(
  body: JsonObject,
): Result<SlackMessageEvent["authored"], IngressQueueMessageError> {
  if (!Array.isArray(body.authored)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.authored" },
    };
  }

  const parts: SlackMessageEvent["authored"][number][] = [];

  for (let index = 0; index < body.authored.length; index += 1) {
    const raw = body.authored[index];
    const field = `event.authored.${index}`;

    if (!isRecord(raw)) {
      return { ok: false, error: { code: "invalid_field", field } };
    }

    if (raw.kind === "text") {
      if (typeof raw.text !== "string" || raw.text.length === 0) {
        return { ok: false, error: { code: "invalid_field", field } };
      }

      parts.push({ kind: "text", text: raw.text });
      continue;
    }

    if (raw.kind === "link") {
      if (
        typeof raw.url !== "string" ||
        raw.url.length === 0 ||
        !(
          raw.label === null ||
          (typeof raw.label === "string" && raw.label.length > 0)
        )
      ) {
        return { ok: false, error: { code: "invalid_field", field } };
      }

      parts.push({ kind: "link", url: raw.url, label: raw.label });
      continue;
    }

    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: parts };
}

function readQueuedSlackFiles(
  body: JsonObject,
): Result<SlackMessageEvent["files"], IngressQueueMessageError> {
  if (!Array.isArray(body.files)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.files" },
    };
  }

  const files: SlackMessageEvent["files"][number][] = [];

  for (let index = 0; index < body.files.length; index += 1) {
    const raw = body.files[index];
    const field = `event.files.${index}`;

    if (!isRecord(raw)) {
      return { ok: false, error: { code: "invalid_field", field } };
    }

    // Only the placeholder shapes carry their identity at the top level; a
    // hosted candidate nests it inside its metadata.
    if (raw.kind === "needs_info" || raw.kind === "remote_link") {
      if (typeof raw.fileId !== "string" || raw.fileId.length === 0) {
        return { ok: false, error: { code: "invalid_field", field } };
      }

      if (raw.kind === "needs_info") {
        files.push({ kind: "needs_info", fileId: raw.fileId });
        continue;
      }

      if (
        typeof raw.url !== "string" ||
        raw.url.length === 0 ||
        typeof raw.label !== "string" ||
        raw.label.length === 0
      ) {
        return { ok: false, error: { code: "invalid_field", field } };
      }

      files.push({
        kind: "remote_link",
        fileId: raw.fileId,
        url: raw.url,
        label: raw.label,
      });
      continue;
    }

    if (raw.kind !== "hosted" || !isRecord(raw.file)) {
      return { ok: false, error: { code: "invalid_field", field } };
    }

    const file = raw.file;

    if (
      typeof file.fileId !== "string" ||
      file.fileId.length === 0 ||
      typeof file.displayName !== "string" ||
      file.displayName.length === 0 ||
      typeof file.declaredMediaType !== "string" ||
      file.declaredMediaType.length === 0 ||
      !Number.isSafeInteger(file.declaredByteLength) ||
      Number(file.declaredByteLength) <= 0 ||
      Number(file.declaredByteLength) > 0xffff_ffff ||
      typeof file.revision !== "string" ||
      file.revision.length === 0
    ) {
      return { ok: false, error: { code: "invalid_field", field } };
    }

    files.push({
      kind: "hosted",
      file: {
        fileId: file.fileId,
        displayName: file.displayName,
        declaredMediaType: file.declaredMediaType,
        declaredByteLength: Number(file.declaredByteLength),
        revision: file.revision,
      },
    });
  }

  return { ok: true, value: files };
}

function readRequestId(
  body: JsonObject,
): Result<RequestId, IngressQueueMessageError> {
  const raw = readRequiredString(body, "requestId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseRequestId(raw.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "requestId" } };
  }

  return parsed;
}

function readOrganisationId(
  body: JsonObject,
): Result<OrganisationId, IngressQueueMessageError> {
  const raw = readRequiredString(body, "organisationId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseOrganisationId(raw.value);

  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field: "organisationId" } };
}

function readIntegrationAccountId(
  body: JsonObject,
): Result<IntegrationAccountId, IngressQueueMessageError> {
  const raw = readRequiredString(body, "integrationAccountId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseIntegrationAccountId(raw.value);

  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "invalid_field", field: "integrationAccountId" },
      };
}

function readNullableRunId(
  body: JsonObject,
): Result<string | null, IngressQueueMessageError> {
  if (!Object.hasOwn(body, "labRunId")) {
    return { ok: false, error: { code: "missing_field", field: "labRunId" } };
  }

  const value = body.labRunId;

  if (value === null) {
    return { ok: true, value: null };
  }

  return typeof value === "string" && value.length >= 8 && value.length <= 160
    ? { ok: true, value }
    : { ok: false, error: { code: "invalid_field", field: "labRunId" } };
}

function isJsonObjectString(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

function isJsonArrayString(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function readSlackTrigger(
  body: JsonObject,
): Result<SlackMessageEvent["trigger"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "trigger");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseSlackMessageTrigger(raw.value, "event.trigger");

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: parsed.error.code, field: parsed.error.field },
    };
  }

  return parsed;
}

function readWorkspaceId(
  body: JsonObject,
): Result<SlackMessageEvent["workspaceId"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "workspaceId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseWorkspaceId(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.workspaceId" },
    };
  }

  return parsed;
}

function readChannelId(
  body: JsonObject,
): Result<SlackMessageEvent["channelId"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "channelId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseChannelId(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.channelId" },
    };
  }

  return parsed;
}

function readSessionId(
  body: JsonObject,
): Result<SlackMessageEvent["sessionId"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "sessionId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseSessionId(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.sessionId" },
    };
  }

  return parsed;
}

function readThreadKey(
  body: JsonObject,
): Result<SlackMessageEvent["threadKey"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "threadKey");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseThreadKey(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.threadKey" },
    };
  }

  return parsed;
}

function readSlackEventIdField(
  body: JsonObject,
): Result<SlackMessageEvent["eventId"], IngressQueueMessageError> {
  const raw = readRequiredString(body, "eventId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseSlackEventId(raw.value, "event.eventId");

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: parsed.error.code, field: parsed.error.field },
    };
  }

  return parsed;
}

function readRequiredObject(
  body: JsonObject,
  field: string,
): Result<JsonObject, IngressQueueMessageError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (!isRecord(value)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value };
}

function readRequiredNumber(
  body: JsonObject,
  field: string,
): Result<number, IngressQueueMessageError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value };
}

function readRequiredString(
  body: JsonObject,
  field: string,
): Result<string, IngressQueueMessageError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: value.trim() };
}
