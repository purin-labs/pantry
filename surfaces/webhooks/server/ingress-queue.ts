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
} from "@purin-labs/area-commerce-contract/server/queue-messages";
import {
  FILE_PROJECTION_COMMAND_TYPE,
  parseFileProjectionCommand,
  type FileProjectionCommand,
} from "@purin-labs/agent/context/files/index";
import type { ContextProjectionCommand } from "@purin-labs/agent/context/projection/index";
import { parseContextProjectionCommand } from "@purin-labs/agent/context/projection/index";
import type { JsonObject } from "@purin-labs/kernel/http";
import { parseCaseId, parseOrganisationId } from "@purin-labs/kernel/ids";
import {
  parseEmailChangeQueuePayload,
  type EmailChangeQueueMessage,
} from "@purin-labs/surface-email/server/mail/queue-messages";
import {
  readRequiredString,
  type IngressQueueMessageError,
} from "@purin-labs/kernel/queue-fields";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseAgentScheduleDispatchQueuePayload,
  type AgentScheduleDispatchQueueMessage,
} from "@purin-labs/agent/schedules/queue-messages";
import {
  providerModules,
  type ProviderQueueMessage,
  type ProviderQueueWork,
} from "@purin-labs/area-integrations/server/contract/provider-modules";

export type IngressQueueMessage =
  | CommerceDeliveryQueueMessage
  | ProviderQueueMessage
  | CommerceOutboxReconcileQueueMessage
  | AgentScheduleDispatchQueueMessage
  | EmailChangeQueueMessage
  | FileProjectionCommand
  | ContextProjectionCommand;

/**
 * A message of the event queue, read. A message of a provider module comes
 * with its handler from the module.
 */
export type ParsedIngressQueueMessage =
  Exclude<IngressQueueMessage, ProviderQueueMessage> | ProviderQueueWork;

export function parseIngressQueueMessage(
  body: unknown,
): Result<ParsedIngressQueueMessage, IngressQueueMessageError> {
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
    case "commerce.outbox_reconcile.v1":
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
      return parseProviderQueueMessage(messageType.value, body);
  }
}

/** A message of a provider module, which the module reads. */
function parseProviderQueueMessage(
  type: string,
  body: JsonObject,
): Result<ProviderQueueWork, IngressQueueMessageError> {
  for (const module of Object.values(providerModules.use())) {
    const parsed = module.queueMessages.parse(type, body);
    if (parsed !== null) return parsed;
  }
  return { ok: false, error: { code: "invalid_field", field: "type" } };
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

declare module "@purin-labs/kernel/env" {
  interface Env {
    EVENT_Q: Queue<IngressQueueMessage>;
  }
}
