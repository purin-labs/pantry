import type { Result } from "../../result";
import type {
  FileResourceGrantTarget,
  FileResourceScope,
} from "@seams/contracts";
import { hasExactKeys, isNonBlankString, isRecord } from "@seams/std";

export type PlatformCapabilityDefinition = Readonly<{
  readonly kind: "platform_capability";
  readonly capabilityId: string;
  readonly capabilityVersion: number;
}>;

export type ProviderCapabilityDefinition = Readonly<{
  readonly kind: "provider_resource";
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly integrationAccountId: string;
  readonly resourceScope: string;
}>;

export type FileCapabilityDefinition = Readonly<FileResourceGrantTarget>;

export type CustomConnectorCapabilityDefinition = Readonly<{
  readonly kind: "custom_connector_operation";
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly integrationAccountId: string;
  readonly connectorId: string;
  readonly definitionRevision: number;
  readonly definitionDigest: string;
  readonly operationId: string;
}>;

export type CapabilityDefinition =
  | PlatformCapabilityDefinition
  | ProviderCapabilityDefinition
  | FileCapabilityDefinition
  | CustomConnectorCapabilityDefinition;

export type CapabilityKeyParseError =
  | { readonly code: "invalid_capability_key"; readonly value: string }
  | { readonly code: "invalid_capability_key_field"; readonly field: string };

export function encodeCapabilityKey(definition: CapabilityDefinition): string {
  switch (definition.kind) {
    case "platform_capability":
      return encodePlatformCapabilityKey(definition);
    case "provider_resource":
      return encodeProviderCapabilityKey(definition);
    case "file_resource":
      return encodeFileCapabilityKey(definition);
    case "custom_connector_operation":
      return encodeCustomConnectorCapabilityKey(definition);
  }
}

function encodeCustomConnectorCapabilityKey(
  definition: CustomConnectorCapabilityDefinition,
): string {
  return [
    "custom_connector",
    definition.capabilityId,
    String(definition.capabilityVersion),
    definition.integrationAccountId,
    definition.connectorId,
    String(definition.definitionRevision),
    definition.definitionDigest,
    definition.operationId,
  ].join(":");
}

export function encodeFileCapabilityKey(
  definition: FileCapabilityDefinition,
): string {
  return [
    "file",
    definition.capabilityId,
    String(definition.capabilityVersion),
    definition.integrationAccountId,
    encodeURIComponent(JSON.stringify(definition.scope)),
  ].join(":");
}

export function encodePlatformCapabilityKey(
  definition: PlatformCapabilityDefinition,
): string {
  return [
    "platform",
    definition.capabilityId,
    String(definition.capabilityVersion),
  ].join(":");
}

export function encodeProviderCapabilityKey(
  definition: ProviderCapabilityDefinition,
): string {
  return [
    "provider",
    definition.capabilityId,
    String(definition.capabilityVersion),
    definition.integrationAccountId,
    definition.resourceScope,
  ].join(":");
}

export function parseCapabilityKey(
  value: string,
): Result<CapabilityDefinition, CapabilityKeyParseError> {
  if (value.trim() !== value || value.length === 0) {
    return invalidKey(value);
  }
  const parts = value.split(":");
  const kind = parts[0];
  if (kind === "platform" && parts.length === 3) {
    const capabilityId = parts[1];
    const capabilityVersion = parseCapabilityVersion(parts[2]);
    if (
      capabilityId === undefined ||
      capabilityId.trim().length === 0 ||
      capabilityVersion === null
    ) {
      return invalidKey(value);
    }
    return {
      ok: true,
      value: { kind: "platform_capability", capabilityId, capabilityVersion },
    };
  }
  if (kind === "provider" && parts.length >= 5) {
    const capabilityId = parts[1];
    const capabilityVersion = parseCapabilityVersion(parts[2]);
    const integrationAccountId = parts[3];
    const resourceScope = parts.slice(4).join(":");
    if (
      capabilityId === undefined ||
      capabilityVersion === null ||
      integrationAccountId === undefined ||
      capabilityId.trim().length === 0 ||
      capabilityId.includes(":") ||
      integrationAccountId.trim().length === 0 ||
      integrationAccountId.includes(":") ||
      resourceScope.trim().length === 0
    ) {
      return invalidKey(value);
    }
    return {
      ok: true,
      value: {
        kind: "provider_resource",
        capabilityId,
        capabilityVersion,
        integrationAccountId,
        resourceScope,
      },
    };
  }
  if (kind === "file" && parts.length === 5) {
    const capabilityId = parts[1];
    const capabilityVersion = parseCapabilityVersion(parts[2]);
    const integrationAccountId = parts[3];
    const scope = parseEncodedFileScope(parts[4]);
    if (
      capabilityId === undefined ||
      capabilityVersion === null ||
      integrationAccountId === undefined ||
      scope === null ||
      capabilityId.trim().length === 0 ||
      capabilityId.includes(":") ||
      integrationAccountId.trim().length === 0 ||
      integrationAccountId.includes(":")
    ) {
      return invalidKey(value);
    }
    return {
      ok: true,
      value: {
        kind: "file_resource",
        capabilityId,
        capabilityVersion,
        integrationAccountId,
        scope,
      },
    };
  }
  if (kind === "custom_connector" && parts.length === 8) {
    const capabilityId = parts[1];
    const capabilityVersion = parseCapabilityVersion(parts[2]);
    const integrationAccountId = parts[3];
    const connectorId = parts[4];
    const definitionRevision = parseCapabilityVersion(parts[5]);
    const definitionDigest = parts[6];
    const operationId = parts[7];
    if (
      (capabilityId !== "custom_connector.read" &&
        capabilityId !== "custom_connector.write") ||
      capabilityVersion !== 1 ||
      integrationAccountId === undefined ||
      integrationAccountId.length === 0 ||
      connectorId === undefined ||
      connectorId.length === 0 ||
      definitionRevision === null ||
      definitionDigest === undefined ||
      !/^[0-9a-f]{64}$/u.test(definitionDigest) ||
      operationId === undefined ||
      !/^[a-z][a-z0-9_]{0,47}$/u.test(operationId)
    ) {
      return invalidKey(value);
    }
    return {
      ok: true,
      value: {
        kind: "custom_connector_operation",
        capabilityId,
        capabilityVersion,
        integrationAccountId,
        connectorId,
        definitionRevision,
        definitionDigest,
        operationId,
      },
    };
  }
  return invalidKey(value);
}

function parseEncodedFileScope(
  value: string | undefined,
): FileResourceScope | null {
  if (value === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
  return parseFileResourceScope(raw);
}

export function parseFileResourceScope(
  value: unknown,
): FileResourceScope | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "dropbox_folder":
      return hasExactKeys(value, ["kind", "providerFolderId", "pathDisplay"]) &&
        isNonBlankString(value.providerFolderId) &&
        isNonBlankString(value.pathDisplay)
        ? {
            kind: value.kind,
            providerFolderId: value.providerFolderId,
            pathDisplay: value.pathDisplay,
          }
        : null;
    case "dropbox_file":
      return hasExactKeys(value, ["kind", "providerFileId", "pathDisplay"]) &&
        isNonBlankString(value.providerFileId) &&
        isNonBlankString(value.pathDisplay)
        ? {
            kind: value.kind,
            providerFileId: value.providerFileId,
            pathDisplay: value.pathDisplay,
          }
        : null;
    case "gdrive_file":
      return hasExactKeys(value, ["kind", "providerFileId", "name"]) &&
        isNonBlankString(value.providerFileId) &&
        isNonBlankString(value.name)
        ? {
            kind: value.kind,
            providerFileId: value.providerFileId,
            name: value.name,
          }
        : null;
    default:
      return null;
  }
}

export function parseProviderCapabilityKey(
  value: string,
): Result<ProviderCapabilityDefinition, CapabilityKeyParseError> {
  const parsed = parseCapabilityKey(value);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.kind !== "provider_resource") return invalidKey(value);
  return { ok: true, value: parsed.value };
}

function parseCapabilityVersion(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalidKey(value: string): Result<never, CapabilityKeyParseError> {
  return { ok: false, error: { code: "invalid_capability_key", value } };
}
