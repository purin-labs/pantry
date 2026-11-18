import type { SurfaceKind } from "@seams/contracts";
import type { JsonObject } from "./http";
import {
  parseChannelId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseWorkspaceId,
  type ChannelId,
  type IntegrationAccountId,
  type OrganisationId,
  type WorkspaceId,
} from "./ids";
import type { Result } from "./result";
import { exhaustiveList } from "@seams/std";

export type InstallModel = "unlisted" | "marketplace" | "custom";

export type FieldError =
  | { code: "missing_field"; field: string }
  | { code: "invalid_field"; field: string };

const SURFACE_KINDS = exhaustiveList<SurfaceKind>()([
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "teams",
  "line-works",
  "gdrive",
  "dropbox",
]);
const INSTALL_MODELS = ["unlisted", "marketplace", "custom"] as const;

export function readStringField(
  body: JsonObject,
  field: string,
): Result<string, FieldError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: value.trim() };
}

export function readNumberField(
  body: JsonObject,
  field: string,
  fallback: number,
): Result<number, FieldError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: true, value: fallback };
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value };
}

export function readStringArrayField(
  body: JsonObject,
  field: string,
): Result<readonly string[], FieldError> {
  const value = body[field];

  if (value === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  if (!Array.isArray(value) || value.some(isNotNonEmptyString)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: value.map(trimString) };
}

export function parseSurfaceKind(raw: string): Result<SurfaceKind, FieldError> {
  if (!isAllowedString(raw, SURFACE_KINDS)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "surfaceKind" },
    };
  }

  return { ok: true, value: raw };
}

export function parseInstallModel(
  raw: string,
): Result<InstallModel, FieldError> {
  if (!isAllowedString(raw, INSTALL_MODELS)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "installModel" },
    };
  }

  return { ok: true, value: raw };
}

export function readOrganisationIdField(
  body: JsonObject,
): Result<OrganisationId, FieldError> {
  const raw = readStringField(body, "organisationId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseOrganisationId(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "organisationId" },
    };
  }

  return parsed;
}

export function readIntegrationAccountIdField(
  body: JsonObject,
): Result<IntegrationAccountId, FieldError> {
  const raw = readStringField(body, "integrationAccountId");

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

export function readWorkspaceIdField(
  body: JsonObject,
): Result<WorkspaceId, FieldError> {
  const raw = readStringField(body, "workspaceId");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseWorkspaceId(raw.value);

  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "workspaceId" },
    };
  }

  return parsed;
}

export function readChannelIdPath(raw: string): Result<ChannelId, FieldError> {
  const parsed = parseChannelId(raw);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "channelId" } };
  }

  return parsed;
}

function isAllowedString<TValue extends string>(
  value: string,
  allowed: readonly TValue[],
): value is TValue {
  for (const candidate of allowed) {
    if (candidate === value) {
      return true;
    }
  }

  return false;
}

function isNotNonEmptyString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function trimString(value: string): string {
  return value.trim();
}
