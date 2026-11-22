// The queue message that dispatches one window of an agent schedule.
// This file holds its type, its constructor and its parser.
// `ingress-queue.ts` calls the parser when it reads the event queue.

import type { JsonObject } from "@purin-labs/kernel/http";
import type { OrganisationId, RequestId } from "@purin-labs/kernel/ids";
import {
  readOrganisationId,
  readRequestId,
  readRequiredNumber,
  readRequiredString,
  type IngressQueueMessageError,
} from "@purin-labs/kernel/queue-fields";
import type { Result } from "@purin-labs/kernel/result";

export type AgentScheduleDispatchQueueMessage = {
  readonly type: "agent_schedule.dispatch.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly bindingId: string;
  readonly windowKey: string;
};

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

export function parseAgentScheduleDispatchQueuePayload(
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
