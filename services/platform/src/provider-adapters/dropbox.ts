import type { ProviderFileRevision } from "@purin-labs/contracts";

import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";
import {
  isNonBlankString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";

const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_API_URL = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_URL = "https://content.dropboxapi.com/2";

export const DROPBOX_REQUIRED_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.content.read",
] as const;

type DropboxProtocolConfiguration = Readonly<{
  readonly clientId: string;
  readonly clientSecret: string;
}>;

type DropboxOAuthTokens = Readonly<{
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly accountId: string;
  readonly scopes: readonly string[];
}>;

type DropboxAccountIdentity = Readonly<{
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly homeNamespaceId: string;
}>;

export type DropboxFileMetadata = Readonly<{
  readonly kind: "file";
  readonly providerFileId: string;
  readonly name: string;
  readonly pathDisplay: string;
  readonly revision: Variant<ProviderFileRevision, "dropbox">;
  readonly contentHash: string | null;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly downloadable: boolean;
  readonly serverModified: string;
}>;

export type DropboxFolderMetadata = Readonly<{
  readonly kind: "folder";
  readonly providerFolderId: string;
  readonly name: string;
  readonly pathDisplay: string;
}>;

export type DropboxListEntry = DropboxFileMetadata | DropboxFolderMetadata;

type DropboxFolderPage = Readonly<{
  readonly entries: readonly DropboxListEntry[];
  readonly changeCount: number;
  readonly cursor: string;
  readonly hasMore: boolean;
}>;

type DropboxBoundedContent = Readonly<{
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly metadata: DropboxFileMetadata;
}>;

export type DropboxProtocolError =
  | Readonly<{
      readonly code: "dropbox_transport_unavailable";
      readonly retryable: true;
    }>
  | Readonly<{
      readonly code: "dropbox_http_rejected";
      readonly status: number;
      readonly retryable: boolean;
    }>
  | Readonly<{
      readonly code: "dropbox_response_invalid";
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "dropbox_content_too_large";
      readonly maximumBytes: number;
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "dropbox_cursor_reset";
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "dropbox_revision_changed";
      readonly retryable: true;
    }>;

export function createDropboxAuthorizationUrl(
  input: Readonly<{
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly pkceChallenge: string;
  }>,
): string {
  const url = new URL(DROPBOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("scope", DROPBOX_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeDropboxAuthorizationCode(
  input: Readonly<{
    readonly configuration: DropboxProtocolConfiguration;
    readonly code: string;
    readonly redirectUri: string;
    readonly pkceVerifier: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxOAuthTokens, DropboxProtocolError>> {
  const body = new URLSearchParams();
  body.set("code", input.code);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.pkceVerifier);
  const response = await fetchDropbox(input.fetcher, DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuthorization(input.configuration),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) return response;
  if (!response.value.ok) return httpError(response.value.status);
  return parseDropboxTokens(await readJson(response.value));
}

export async function refreshDropboxAccessToken(
  input: Readonly<{
    readonly configuration: DropboxProtocolConfiguration;
    readonly refreshToken: string;
    readonly accountId: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxOAuthTokens, DropboxProtocolError>> {
  const body = new URLSearchParams();
  body.set("refresh_token", input.refreshToken);
  body.set("grant_type", "refresh_token");
  const response = await fetchDropbox(input.fetcher, DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuthorization(input.configuration),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) return response;
  if (!response.value.ok) return httpError(response.value.status);
  const parsed = parseDropboxRefreshTokens(
    await readJson(response.value),
    input.refreshToken,
    input.accountId,
  );
  return parsed;
}

export async function readDropboxAccount(
  input: Readonly<{
    readonly accessToken: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxAccountIdentity, DropboxProtocolError>> {
  const response = await callDropboxRpc(
    input.fetcher,
    `${DROPBOX_API_URL}/users/get_current_account`,
    input.accessToken,
    null,
    {},
  );
  if (!response.ok) return response;
  return parseDropboxAccount(await readJson(response.value));
}

export async function listDropboxFolder(
  input: Readonly<{
    readonly accessToken: string;
    readonly path: string;
    readonly cursor: string | null;
    readonly recursive: boolean;
    readonly limit: number;
    readonly pathRootNamespaceId: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxFolderPage, DropboxProtocolError>> {
  const endpoint =
    input.cursor === null
      ? `${DROPBOX_API_URL}/files/list_folder`
      : `${DROPBOX_API_URL}/files/list_folder/continue`;
  const payload =
    input.cursor === null
      ? {
          path: input.path,
          recursive: input.recursive,
          include_deleted: true,
          include_non_downloadable_files: true,
          limit: input.limit,
        }
      : { cursor: input.cursor };
  const response = await callDropboxRpc(
    input.fetcher,
    endpoint,
    input.accessToken,
    input.pathRootNamespaceId,
    payload,
  );
  if (!response.ok) return response;
  if (response.value.status === 409) {
    const errorBody = await readJson(response.value);
    return dropboxBodyRequiresCursorReset(errorBody)
      ? { ok: false, error: { code: "dropbox_cursor_reset", retryable: false } }
      : httpError(response.value.status);
  }
  if (!response.value.ok) return httpError(response.value.status);
  return parseDropboxFolderPage(await readJson(response.value));
}

export async function readDropboxMetadata(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly pathRootNamespaceId: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxListEntry, DropboxProtocolError>> {
  const response = await callDropboxRpc(
    input.fetcher,
    `${DROPBOX_API_URL}/files/get_metadata`,
    input.accessToken,
    input.pathRootNamespaceId,
    { path: input.providerFileId, include_deleted: false },
  );
  if (!response.ok) return response;
  if (!response.value.ok) return httpError(response.value.status);
  const entry = parseDropboxListEntry(await readJson(response.value));
  return entry === null ? invalidDropboxResponse() : { ok: true, value: entry };
}

export async function downloadDropboxFile(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly expectedRevision: string;
    readonly pathRootNamespaceId: string;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxBoundedContent, DropboxProtocolError>> {
  return readDropboxContent({
    ...input,
    endpoint: `${DROPBOX_CONTENT_URL}/files/download`,
    argument: { path: `rev:${input.expectedRevision}` },
    resultKind: "file_metadata",
  });
}

export async function exportDropboxFile(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly exportFormat: string;
    readonly pathRootNamespaceId: string;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxBoundedContent, DropboxProtocolError>> {
  return readDropboxContent({
    ...input,
    expectedRevision: null,
    endpoint: `${DROPBOX_CONTENT_URL}/files/export`,
    argument: { path: input.providerFileId, export_format: input.exportFormat },
    resultKind: "export_result",
  });
}

export async function revokeDropboxToken(
  input: Readonly<{
    readonly accessToken: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<"removed", DropboxProtocolError>> {
  const response = await callDropboxRpc(
    input.fetcher,
    `${DROPBOX_API_URL}/auth/token/revoke`,
    input.accessToken,
    null,
    {},
  );
  if (!response.ok) return response;
  return response.value.ok
    ? { ok: true, value: "removed" }
    : httpError(response.value.status);
}

export async function verifyDropboxWebhookSignature(
  input: Readonly<{
    readonly appSecret: string;
    readonly rawBody: string;
    readonly signatureHex: string;
  }>,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(input.signatureHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexBytes(input.signatureHex),
    new TextEncoder().encode(input.rawBody),
  );
}

export function dropboxDeepLink(pathDisplay: string): string {
  const url = new URL("https://www.dropbox.com/home");
  url.pathname = `/home${pathDisplay.startsWith("/") ? pathDisplay : `/${pathDisplay}`}`;
  return url.toString();
}

async function readDropboxContent(
  input: Readonly<{
    readonly accessToken: string;
    readonly endpoint: string;
    readonly argument: Readonly<Record<string, unknown>>;
    readonly resultKind: "file_metadata" | "export_result";
    readonly expectedRevision: string | null;
    readonly pathRootNamespaceId: string;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<DropboxBoundedContent, DropboxProtocolError>> {
  const headers = new Headers({
    authorization: `Bearer ${input.accessToken}`,
    "dropbox-api-arg": JSON.stringify(input.argument),
  });
  headers.set(
    "dropbox-api-path-root",
    pathRootHeader(input.pathRootNamespaceId),
  );
  const response = await fetchDropbox(input.fetcher, input.endpoint, {
    method: "POST",
    headers,
  });
  if (!response.ok) return response;
  if (!response.value.ok) return httpError(response.value.status);
  const metadataHeader = response.value.headers.get("dropbox-api-result");
  if (metadataHeader === null) return invalidDropboxResponse();
  const metadata = parseJsonOrNull(metadataHeader);
  const file = parseDropboxContentMetadata(metadata, input.resultKind);
  if (file === null) return invalidDropboxResponse();
  if (
    input.expectedRevision !== null &&
    file.revision.rev !== input.expectedRevision
  ) {
    return {
      ok: false,
      error: { code: "dropbox_revision_changed", retryable: true },
    };
  }
  const bytes = await readBoundedBytes(response.value, input.maximumBytes);
  if (!bytes.ok) return bytes;
  return {
    ok: true,
    value: {
      bytes: bytes.value,
      mediaType: response.value.headers.get("content-type") ?? file.mediaType,
      metadata: file,
    },
  };
}

async function callDropboxRpc(
  fetcher: typeof fetch,
  endpoint: string,
  accessToken: string,
  pathRootNamespaceId: string | null,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<Response, DropboxProtocolError>> {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  });
  if (pathRootNamespaceId !== null) {
    headers.set("dropbox-api-path-root", pathRootHeader(pathRootNamespaceId));
  }
  return fetchDropbox(fetcher, endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function fetchDropbox(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Result<Response, DropboxProtocolError>> {
  try {
    return { ok: true, value: await fetcher(input, init) };
  } catch {
    return {
      ok: false,
      error: { code: "dropbox_transport_unavailable", retryable: true },
    };
  }
}

function parseDropboxTokens(
  raw: unknown,
): Result<DropboxOAuthTokens, DropboxProtocolError> {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.access_token) ||
    !isNonBlankString(raw.refresh_token) ||
    !isPositiveInteger(raw.expires_in) ||
    !isNonBlankString(raw.account_id) ||
    !isNonBlankString(raw.scope)
  ) {
    return invalidDropboxResponse();
  }
  const scopes = exactDropboxScopes(raw.scope);
  if (scopes === null) return invalidDropboxResponse();
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresInSeconds: raw.expires_in,
      accountId: raw.account_id,
      scopes,
    },
  };
}

function parseDropboxRefreshTokens(
  raw: unknown,
  refreshToken: string,
  accountId: string,
): Result<DropboxOAuthTokens, DropboxProtocolError> {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.access_token) ||
    !isPositiveInteger(raw.expires_in)
  ) {
    return invalidDropboxResponse();
  }
  const scopes =
    raw.scope === undefined
      ? DROPBOX_REQUIRED_SCOPES
      : isNonBlankString(raw.scope)
        ? exactDropboxScopes(raw.scope)
        : null;
  if (scopes === null) return invalidDropboxResponse();
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      refreshToken,
      expiresInSeconds: raw.expires_in,
      accountId,
      scopes,
    },
  };
}

function parseDropboxAccount(
  raw: unknown,
): Result<DropboxAccountIdentity, DropboxProtocolError> {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.account_id) ||
    !isNonBlankString(raw.email) ||
    !isRecord(raw.name) ||
    !isNonBlankString(raw.name.display_name) ||
    !isRecord(raw.root_info) ||
    !isNonBlankString(raw.root_info.home_namespace_id)
  ) {
    return invalidDropboxResponse();
  }
  return {
    ok: true,
    value: {
      accountId: raw.account_id,
      email: raw.email,
      displayName: raw.name.display_name,
      homeNamespaceId: raw.root_info.home_namespace_id,
    },
  };
}

function parseDropboxFolderPage(
  raw: unknown,
): Result<DropboxFolderPage, DropboxProtocolError> {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.entries) ||
    !isNonBlankString(raw.cursor) ||
    typeof raw.has_more !== "boolean"
  ) {
    return invalidDropboxResponse();
  }
  const entries: DropboxListEntry[] = [];
  for (const value of raw.entries) {
    if (!isRecord(value) || value[".tag"] === "deleted") continue;
    const entry = parseDropboxListEntry(value);
    if (entry === null) return invalidDropboxResponse();
    entries.push(entry);
  }
  return {
    ok: true,
    value: {
      entries,
      changeCount: raw.entries.length,
      cursor: raw.cursor,
      hasMore: raw.has_more,
    },
  };
}

function parseDropboxListEntry(raw: unknown): DropboxListEntry | null {
  if (!isRecord(raw)) return null;
  if (raw[".tag"] === "file") return parseDropboxFileMetadata(raw);
  if (
    raw[".tag"] !== "folder" ||
    !isNonBlankString(raw.id) ||
    !isNonBlankString(raw.name) ||
    !isNonBlankString(raw.path_display)
  ) {
    return null;
  }
  return {
    kind: "folder",
    providerFolderId: raw.id,
    name: raw.name,
    pathDisplay: raw.path_display,
  };
}

function parseDropboxFileMetadata(raw: unknown): DropboxFileMetadata | null {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.id) ||
    !isNonBlankString(raw.name) ||
    !isNonBlankString(raw.path_display) ||
    !isNonBlankString(raw.rev) ||
    !isNonBlankString(raw.server_modified) ||
    !isNonNegativeInteger(raw.size) ||
    typeof raw.is_downloadable !== "boolean" ||
    (raw.content_hash !== undefined &&
      raw.content_hash !== null &&
      !isNonBlankString(raw.content_hash))
  ) {
    return null;
  }
  return {
    kind: "file",
    providerFileId: raw.id,
    name: raw.name,
    pathDisplay: raw.path_display,
    revision: { kind: "dropbox", rev: raw.rev },
    contentHash: typeof raw.content_hash === "string" ? raw.content_hash : null,
    byteLength: raw.size,
    mediaType: mediaTypeForDropboxName(raw.name),
    downloadable: raw.is_downloadable,
    serverModified: raw.server_modified,
  };
}

function parseDropboxContentMetadata(
  raw: unknown,
  resultKind: "file_metadata" | "export_result",
): DropboxFileMetadata | null {
  switch (resultKind) {
    case "file_metadata":
      return parseDropboxFileMetadata(raw);
    case "export_result":
      return isRecord(raw) ? parseDropboxFileMetadata(raw.file_metadata) : null;
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Result<Uint8Array, DropboxProtocolError>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    return tooLarge(maximumBytes);
  }
  if (response.body === null) return invalidDropboxResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      return tooLarge(maximumBytes);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

function basicAuthorization(
  configuration: DropboxProtocolConfiguration,
): string {
  return `Basic ${btoa(`${configuration.clientId}:${configuration.clientSecret}`)}`;
}

function pathRootHeader(namespaceId: string): string {
  return JSON.stringify({ ".tag": "namespace_id", namespace_id: namespaceId });
}

function normalizedScopes(value: string): readonly string[] {
  return value.split(/\s+/u).filter(isNonBlankString).sort();
}

function exactDropboxScopes(value: string): readonly string[] | null {
  const scopes = normalizedScopes(value);
  const required = new Set<string>(DROPBOX_REQUIRED_SCOPES);
  return scopes.length === required.size &&
    scopes.every(required.has.bind(required))
    ? scopes
    : null;
}

function mediaTypeForDropboxName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return "text/markdown";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function dropboxBodyRequiresCursorReset(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    (raw.error_summary === "reset/" ||
      (isRecord(raw.error) && raw.error[".tag"] === "reset"))
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function httpError(status: number): Result<never, DropboxProtocolError> {
  return {
    ok: false,
    error: {
      code: "dropbox_http_rejected",
      status,
      retryable:
        status === 408 || status === 425 || status === 429 || status >= 500,
    },
  };
}

function invalidDropboxResponse(): Result<never, DropboxProtocolError> {
  return {
    ok: false,
    error: { code: "dropbox_response_invalid", retryable: false },
  };
}

function tooLarge(maximumBytes: number): Result<never, DropboxProtocolError> {
  return {
    ok: false,
    error: {
      code: "dropbox_content_too_large",
      maximumBytes,
      retryable: false,
    },
  };
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
