// The event queue of the Platform Worker.
// This file holds the union of its messages.
// `parseIngressQueueMessage` reads the type and calls the parser of its owner.
// Each message type, its constructor and its parser live with the owner module.

import { isRecord } from "@purin-labs/std";

import {
  parseCommerceEventQueuePayload,
  parseCommerceOutboxReconcileQueuePayload,
  type CommerceDeliveryQueueMessage,
  type CommerceOutboxReconcileQueueMessage,
} from "./commerce/queue-messages";
import {
  FILE_PROJECTION_COMMAND_TYPE,
  parseFileProjectionCommand,
  type FileProjectionCommand,
} from "./context/files";
import type { ContextProjectionCommand } from "./context/projection";
import { parseContextProjectionCommand } from "./context/projection";
import type { JsonObject } from "./http";
import { parseCaseId, parseOrganisationId } from "./ids";
import {
  parseEmailChangeQueuePayload,
  type EmailChangeQueueMessage,
} from "./mail/queue-messages";
import {
  readRequiredString,
  type IngressQueueMessageError,
} from "./queue-fields";
import type { Result } from "./result";
import {
  parseAgentScheduleDispatchQueuePayload,
  type AgentScheduleDispatchQueueMessage,
} from "./schedules/queue-messages";
import {
  parseShopifyCommerceRefreshQueuePayload,
  type ShopifyCommerceRefreshQueueMessage,
} from "./shopify/queue-messages";

export type IngressQueueMessage =
  | CommerceDeliveryQueueMessage
  | ShopifyCommerceRefreshQueueMessage
  | CommerceOutboxReconcileQueueMessage
  | AgentScheduleDispatchQueueMessage
  | EmailChangeQueueMessage
  | FileProjectionCommand
  | ContextProjectionCommand;

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

declare module "./env" {
  interface Env {
    EVENT_Q: Queue<IngressQueueMessage>;
  }
}
