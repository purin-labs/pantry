// The field readers that the queue message parsers share.
// Each reader takes one field from a parsed JSON object.
// Each reader returns the value or an `IngressQueueMessageError`.
// A reader that only one message owner uses lives in the file of that owner.

import { isRecord } from "@purin-labs/std";

import type { JsonObject } from "./http";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  parseRequestId,
  type IntegrationAccountId,
  type OrganisationId,
  type RequestId,
} from "./ids";
import type { Result } from "./result";

export type IngressQueueMessageError =
  | { code: "object_required" }
  | { code: "missing_field"; field: string }
  | { code: "invalid_field"; field: string };

export function readRequestId(
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

export function readOrganisationId(
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

export function readIntegrationAccountId(
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

export function isJsonObjectString(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

export function isJsonArrayString(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

export function readRequiredObject(
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

export function readRequiredNumber(
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

export function readRequiredString(
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
