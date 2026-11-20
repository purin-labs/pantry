// The queue message that reports one change in a connected mailbox.
// This file holds its type, its constructor and its parser.
// `ingress-queue.ts` calls the parser when it reads the event queue.

import type { JsonObject } from "../http";
import type { IntegrationAccountId, OrganisationId, RequestId } from "../ids";
import {
  readIntegrationAccountId,
  readOrganisationId,
  readRequestId,
  readRequiredNumber,
  readRequiredString,
  type IngressQueueMessageError,
} from "../queue-fields";
import type { Result } from "../result";

export type EmailChangeQueueMessage = {
  readonly type: "email.change.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly historyId: string;
  readonly notificationId: string;
};

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

export function parseEmailChangeQueuePayload(
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
