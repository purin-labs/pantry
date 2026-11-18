import type {
  DropboxResourcePage,
  GoogleDrivePickerConfig,
} from "./access-models.ts";
import { hasExactKeys, isRecord } from "@seams/std";
import type { FileResourceDiscoveryEntry } from "../index.ts";

export function parseDropboxResourcePage(raw: unknown): DropboxResourcePage {
  const response = record(raw, "Dropbox resource response");
  const page = record(response.page, "Dropbox resource page");
  if (
    !hasExactKeys(response, ["ok", "page"]) ||
    response.ok !== true ||
    !hasExactKeys(page, ["provider", "entries", "nextCursor"]) ||
    page.provider !== "dropbox" ||
    !Array.isArray(page.entries) ||
    (page.nextCursor !== null && !bounded(page.nextCursor, 8_192))
  ) {
    throw new Error("Dropbox resource response is invalid.");
  }
  return {
    provider: "dropbox",
    entries: page.entries.map(parseDropboxResourceChoice),
    nextCursor: page.nextCursor,
  };
}

export function parseGoogleDrivePickerConfig(
  raw: unknown,
): GoogleDrivePickerConfig {
  const response = record(raw, "Google Drive Picker response");
  const config = record(response.config, "Google Drive Picker configuration");
  if (
    !hasExactKeys(response, ["ok", "config"]) ||
    response.ok !== true ||
    !hasExactKeys(config, [
      "clientId",
      "apiKey",
      "appId",
      "expectedPermissionId",
      "scope",
    ]) ||
    !bounded(config.clientId, 512) ||
    !bounded(config.apiKey, 512) ||
    !bounded(config.appId, 256) ||
    !bounded(config.expectedPermissionId, 512) ||
    config.scope !== "https://www.googleapis.com/auth/drive.file"
  ) {
    throw new Error("Google Drive Picker configuration is invalid.");
  }
  return {
    clientId: config.clientId,
    apiKey: config.apiKey,
    appId: config.appId,
    expectedPermissionId: config.expectedPermissionId,
    scope: config.scope,
  };
}

function parseDropboxResourceChoice(raw: unknown): FileResourceDiscoveryEntry {
  const entry = record(raw, "Dropbox resource");
  if (!bounded(entry.name, 512) || !bounded(entry.pathDisplay, 2_048)) {
    throw new Error("Dropbox resource is invalid.");
  }
  switch (entry.kind) {
    case "dropbox_folder":
      if (
        hasExactKeys(entry, [
          "kind",
          "providerFolderId",
          "name",
          "pathDisplay",
        ]) &&
        bounded(entry.providerFolderId, 256)
      ) {
        return {
          kind: entry.kind,
          providerFolderId: entry.providerFolderId,
          name: entry.name,
          pathDisplay: entry.pathDisplay,
        };
      }
      break;
    case "dropbox_file":
      if (
        hasExactKeys(entry, [
          "kind",
          "providerFileId",
          "name",
          "pathDisplay",
        ]) &&
        bounded(entry.providerFileId, 256)
      ) {
        return {
          kind: entry.kind,
          providerFileId: entry.providerFileId,
          name: entry.name,
          pathDisplay: entry.pathDisplay,
        };
      }
      break;
  }
  throw new Error("Dropbox resource identity is invalid.");
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}
