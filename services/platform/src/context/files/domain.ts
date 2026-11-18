import type {
  FileContextProvider,
  FileGrantSyncState,
  FileResourceScope,
  ProviderFileCursor,
  ProviderFileRevision,
} from "@seams/contracts";

import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import type { Result } from "../../result";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@seams/std";

export const FILE_PROJECTION_COMMAND_TYPE =
  "context.file_projection.v1" as const;
export const FILE_GRANT_MAX_FILES = 1_000;
export const FILE_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const FILE_EXTRACTED_TEXT_MAX_BYTES = 1024 * 1024;
export const FILE_DAILY_SOURCE_BYTE_BUDGET = 100 * 1024 * 1024;

export type FileProjectionCommand = Readonly<{
  readonly type: typeof FILE_PROJECTION_COMMAND_TYPE;
  readonly organisationId: OrganisationId;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: FileContextProvider;
  readonly providerFileId: string;
  readonly sourceSequence: number;
  readonly providerRevision: ProviderFileRevision;
  readonly visibilityKey: string;
}>;

export type FileContextParseError = Readonly<{
  readonly code: "invalid_file_context_field";
  readonly field: string;
}>;

export function createFileProjectionCommand(
  input: Omit<FileProjectionCommand, "type">,
): FileProjectionCommand {
  return { type: FILE_PROJECTION_COMMAND_TYPE, ...input };
}

export function parseFileProjectionCommand(
  raw: unknown,
): Result<FileProjectionCommand, FileContextParseError> {
  if (!isRecord(raw) || raw.type !== FILE_PROJECTION_COMMAND_TYPE) {
    return invalidFileContextField("type");
  }
  if (!nonEmptyString(raw.organisationId))
    return invalidFileContextField("organisationId");
  if (!nonEmptyString(raw.integrationAccountId)) {
    return invalidFileContextField("integrationAccountId");
  }
  const organisationId = parseOrganisationId(raw.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    raw.integrationAccountId,
  );
  const provider = parseFileContextProvider(raw.provider);
  const providerRevision = parseProviderFileRevision(raw.providerRevision);
  if (!organisationId.ok) return invalidFileContextField("organisationId");
  if (!integrationAccountId.ok)
    return invalidFileContextField("integrationAccountId");
  if (provider === null) return invalidFileContextField("provider");
  if (!nonEmptyString(raw.grantId)) return invalidFileContextField("grantId");
  if (!isPositiveInteger(raw.grantRevision))
    return invalidFileContextField("grantRevision");
  if (!nonEmptyString(raw.providerFileId))
    return invalidFileContextField("providerFileId");
  if (!isPositiveInteger(raw.sourceSequence))
    return invalidFileContextField("sourceSequence");
  if (
    providerRevision === null ||
    !revisionMatchesProvider(provider, providerRevision)
  ) {
    return invalidFileContextField("providerRevision");
  }
  if (!nonEmptyString(raw.visibilityKey))
    return invalidFileContextField("visibilityKey");
  return {
    ok: true,
    value: {
      type: FILE_PROJECTION_COMMAND_TYPE,
      organisationId: organisationId.value,
      grantId: raw.grantId,
      grantRevision: raw.grantRevision,
      integrationAccountId: integrationAccountId.value,
      provider,
      providerFileId: raw.providerFileId,
      sourceSequence: raw.sourceSequence,
      providerRevision,
      visibilityKey: raw.visibilityKey,
    },
  };
}

export function parseFileGrantSyncState(
  raw: unknown,
): FileGrantSyncState | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "pending":
      return isNonNegativeInteger(raw.nextRunAt)
        ? { kind: raw.kind, nextRunAt: raw.nextRunAt }
        : null;
    case "reconciling":
      return nonEmptyString(raw.leaseId) &&
        isNonNegativeInteger(raw.leaseExpiresAt) &&
        isNonNegativeInteger(raw.startedAt) &&
        raw.leaseExpiresAt > raw.startedAt
        ? {
            kind: raw.kind,
            leaseId: raw.leaseId,
            leaseExpiresAt: raw.leaseExpiresAt,
            startedAt: raw.startedAt,
          }
        : null;
    case "ready":
      return isNonNegativeInteger(raw.reconciledAt) &&
        isNonNegativeInteger(raw.nextRunAt) &&
        raw.nextRunAt >= raw.reconciledAt
        ? {
            kind: raw.kind,
            reconciledAt: raw.reconciledAt,
            nextRunAt: raw.nextRunAt,
          }
        : null;
    case "retry_wait":
      return isPositiveInteger(raw.attempt) &&
        nonEmptyString(raw.reason) &&
        isNonNegativeInteger(raw.nextRunAt)
        ? {
            kind: raw.kind,
            attempt: raw.attempt,
            reason: raw.reason,
            nextRunAt: raw.nextRunAt,
          }
        : null;
    case "capped":
      return isPositiveInteger(raw.observedFileCount) &&
        isPositiveInteger(raw.maxFileCount) &&
        raw.observedFileCount > raw.maxFileCount &&
        isNonNegativeInteger(raw.cappedAt)
        ? {
            kind: raw.kind,
            observedFileCount: raw.observedFileCount,
            maxFileCount: raw.maxFileCount,
            cappedAt: raw.cappedAt,
          }
        : null;
    default:
      return null;
  }
}

export function parseProviderFileRevision(
  raw: unknown,
): ProviderFileRevision | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "dropbox":
      return hasExactKeys(raw, ["kind", "rev"]) && nonEmptyString(raw.rev)
        ? { kind: raw.kind, rev: raw.rev }
        : null;
    case "gdrive":
      return hasExactKeys(raw, [
        "kind",
        "version",
        "modifiedTime",
        "headRevisionId",
      ]) &&
        nonEmptyString(raw.version) &&
        nonEmptyString(raw.modifiedTime) &&
        (raw.headRevisionId === null || nonEmptyString(raw.headRevisionId))
        ? {
            kind: raw.kind,
            version: raw.version,
            modifiedTime: raw.modifiedTime,
            headRevisionId: raw.headRevisionId,
          }
        : null;
    default:
      return null;
  }
}

export function parseProviderFileCursor(
  raw: unknown,
): ProviderFileCursor | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "dropbox":
      return hasExactKeys(raw, ["kind", "cursor"]) && nonEmptyString(raw.cursor)
        ? { kind: raw.kind, cursor: raw.cursor }
        : null;
    case "gdrive":
      return hasExactKeys(raw, ["kind", "pageToken"]) &&
        nonEmptyString(raw.pageToken)
        ? { kind: raw.kind, pageToken: raw.pageToken }
        : null;
    default:
      return null;
  }
}

export function fileResourceScopeKey(scope: FileResourceScope): string {
  switch (scope.kind) {
    case "dropbox_folder":
      return `dropbox_folder:${scope.providerFolderId}`;
    case "dropbox_file":
      return `dropbox_file:${scope.providerFileId}`;
    case "gdrive_file":
      return `gdrive_file:${scope.providerFileId}`;
  }
}

function parseFileContextProvider(value: unknown): FileContextProvider | null {
  return value === "dropbox" || value === "google_drive" ? value : null;
}

function revisionMatchesProvider(
  provider: FileContextProvider,
  revision: ProviderFileRevision,
): boolean {
  return (
    (provider === "dropbox" && revision.kind === "dropbox") ||
    (provider === "google_drive" && revision.kind === "gdrive")
  );
}

function nonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}

function invalidFileContextField(
  field: string,
): Result<never, FileContextParseError> {
  return { ok: false, error: { code: "invalid_file_context_field", field } };
}
