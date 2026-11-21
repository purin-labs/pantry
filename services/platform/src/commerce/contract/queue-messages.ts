// The queue messages of commerce: a provider delivery and an outbox reconcile.
// This file holds their types, their constructors and their parsers.
// `ingress-queue.ts` calls the parsers when it reads the event queue.

import type { JsonObject } from "../../http";
import type {
  IntegrationAccountId,
  OrganisationId,
  RequestId,
} from "../../ids";
import {
  isJsonArrayString,
  isJsonObjectString,
  readIntegrationAccountId,
  readOrganisationId,
  readRequestId,
  readRequiredNumber,
  readRequiredString,
  type IngressQueueMessageError,
} from "../../queue-fields";
import type { Result } from "../../result";

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

export type CommerceOutboxReconcileQueueMessage = {
  readonly type: "commerce.outbox_reconcile.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
};

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

export function createCommerceOutboxReconcileQueueMessage(
  input: Readonly<{
    requestId: RequestId;
    receivedAt: number;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): CommerceOutboxReconcileQueueMessage {
  return { type: "commerce.outbox_reconcile.v1", ...input };
}

export function parseCommerceEventQueuePayload(
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

export function parseCommerceOutboxReconcileQueuePayload(
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
      type: "commerce.outbox_reconcile.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
    },
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
