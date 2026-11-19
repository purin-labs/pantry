import type { ProviderFileRevision } from "@purin-labs/contracts";

import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";
import { isNonBlankString, isPositiveInteger, isRecord } from "@purin-labs/std";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const DRIVE_FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "size",
  "version",
  "modifiedTime",
  "headRevisionId",
  "trashed",
  "webViewLink",
  "parents",
].join(",");

export const GOOGLE_DRIVE_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
] as const;

type GoogleDriveProtocolConfiguration = Readonly<{
  readonly clientId: string;
  readonly clientSecret: string;
}>;

type GoogleDriveOAuthTokens = Readonly<{
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
}>;

type GoogleDriveIdentity = Readonly<{
  readonly permissionId: string;
  readonly email: string;
  readonly displayName: string;
}>;

export type GoogleDriveFileMetadata = Readonly<{
  readonly providerFileId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number | null;
  readonly revision: Variant<ProviderFileRevision, "gdrive">;
  readonly trashed: boolean;
  readonly webViewLink: string;
  readonly parentIds: readonly string[];
}>;

export type GoogleDriveChange =
  | Readonly<{
      readonly kind: "removed";
      readonly providerFileId: string;
    }>
  | Readonly<{
      readonly kind: "file";
      readonly file: GoogleDriveFileMetadata;
    }>;

type GoogleDriveChangePage = Readonly<{
  readonly changes: readonly GoogleDriveChange[];
  readonly nextPageToken: string | null;
  readonly newStartPageToken: string | null;
}>;

type GoogleDriveBoundedContent = Readonly<{
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly metadata: GoogleDriveFileMetadata;
}>;

export type GoogleDriveProtocolError =
  | Readonly<{
      readonly code: "gdrive_transport_unavailable";
      readonly retryable: true;
    }>
  | Readonly<{
      readonly code: "gdrive_http_rejected";
      readonly status: number;
      readonly retryable: boolean;
    }>
  | Readonly<{
      readonly code: "gdrive_response_invalid";
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "gdrive_content_too_large";
      readonly maximumBytes: number;
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "gdrive_file_unavailable";
      readonly retryable: false;
    }>
  | Readonly<{
      readonly code: "gdrive_revision_changed";
      readonly retryable: true;
    }>;

export function createGoogleDriveAuthorizationUrl(
  input: Readonly<{
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly pkceChallenge: string;
  }>,
): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_DRIVE_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoogleDriveAuthorizationCode(
  input: Readonly<{
    readonly configuration: GoogleDriveProtocolConfiguration;
    readonly code: string;
    readonly redirectUri: string;
    readonly pkceVerifier: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveOAuthTokens, GoogleDriveProtocolError>> {
  const body = new URLSearchParams();
  body.set("client_id", input.configuration.clientId);
  body.set("client_secret", input.configuration.clientSecret);
  body.set("code", input.code);
  body.set("code_verifier", input.pkceVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", input.redirectUri);
  const response = await fetchGoogleDrive(input.fetcher, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return response;
  if (!response.value.ok) return driveHttpError(response.value.status);
  return parseGoogleDriveTokens(await readJson(response.value));
}

export async function refreshGoogleDriveAccessToken(
  input: Readonly<{
    readonly configuration: GoogleDriveProtocolConfiguration;
    readonly refreshToken: string;
    readonly scopes: readonly string[];
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveOAuthTokens, GoogleDriveProtocolError>> {
  const body = new URLSearchParams();
  body.set("client_id", input.configuration.clientId);
  body.set("client_secret", input.configuration.clientSecret);
  body.set("refresh_token", input.refreshToken);
  body.set("grant_type", "refresh_token");
  const response = await fetchGoogleDrive(input.fetcher, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return response;
  if (!response.value.ok) return driveHttpError(response.value.status);
  return parseGoogleDriveRefreshTokens(
    await readJson(response.value),
    input.refreshToken,
    input.scopes,
  );
}

export async function readGoogleDriveIdentity(
  input: Readonly<{
    readonly accessToken: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveIdentity, GoogleDriveProtocolError>> {
  const url = new URL(`${DRIVE_API_URL}/about`);
  url.searchParams.set("fields", "user(displayName,emailAddress,permissionId)");
  const response = await callGoogleDrive(input.fetcher, url, input.accessToken);
  if (!response.ok) return response;
  const raw = await readJson(response.value);
  if (
    !isRecord(raw) ||
    !isRecord(raw.user) ||
    !isNonBlankString(raw.user.permissionId) ||
    !isNonBlankString(raw.user.emailAddress) ||
    !isNonBlankString(raw.user.displayName)
  ) {
    return invalidDriveResponse();
  }
  return {
    ok: true,
    value: {
      permissionId: raw.user.permissionId,
      email: raw.user.emailAddress,
      displayName: raw.user.displayName,
    },
  };
}

export async function readGoogleDriveFileMetadata(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveFileMetadata, GoogleDriveProtocolError>> {
  const url = new URL(
    `${DRIVE_API_URL}/files/${encodeURIComponent(input.providerFileId)}`,
  );
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const response = await callGoogleDrive(input.fetcher, url, input.accessToken);
  if (!response.ok) return response;
  const metadata = parseGoogleDriveFileMetadata(await readJson(response.value));
  return metadata === null
    ? invalidDriveResponse()
    : { ok: true, value: metadata };
}

export async function readGoogleDriveStartPageToken(
  input: Readonly<{
    readonly accessToken: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<string, GoogleDriveProtocolError>> {
  const url = new URL(`${DRIVE_API_URL}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  const response = await callGoogleDrive(input.fetcher, url, input.accessToken);
  if (!response.ok) return response;
  const raw = await readJson(response.value);
  return isRecord(raw) && isNonBlankString(raw.startPageToken)
    ? { ok: true, value: raw.startPageToken }
    : invalidDriveResponse();
}

export async function listGoogleDriveChanges(
  input: Readonly<{
    readonly accessToken: string;
    readonly pageToken: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveChangePage, GoogleDriveProtocolError>> {
  const url = new URL(`${DRIVE_API_URL}/changes`);
  url.searchParams.set("pageToken", input.pageToken);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    `changes(fileId,removed,file(${DRIVE_FILE_FIELDS})),nextPageToken,newStartPageToken`,
  );
  const response = await callGoogleDrive(input.fetcher, url, input.accessToken);
  if (!response.ok) return response;
  return parseGoogleDriveChangePage(await readJson(response.value));
}

export async function downloadGoogleDriveFile(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly expectedRevision: Variant<ProviderFileRevision, "gdrive">;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveBoundedContent, GoogleDriveProtocolError>> {
  return readStableGoogleDriveContent({
    ...input,
    contentUrl: googleDriveMediaUrl(input.providerFileId),
  });
}

export async function exportGoogleDriveFile(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly expectedRevision: Variant<ProviderFileRevision, "gdrive">;
    readonly exportMediaType: string;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveBoundedContent, GoogleDriveProtocolError>> {
  const contentUrl = new URL(
    `${DRIVE_API_URL}/files/${encodeURIComponent(input.providerFileId)}/export`,
  );
  contentUrl.searchParams.set("mimeType", input.exportMediaType);
  return readStableGoogleDriveContent({ ...input, contentUrl });
}

export async function revokeGoogleDriveToken(
  input: Readonly<{
    readonly token: string;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<"removed", GoogleDriveProtocolError>> {
  const url = new URL(GOOGLE_REVOKE_URL);
  url.searchParams.set("token", input.token);
  const response = await fetchGoogleDrive(input.fetcher, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) return response;
  return response.value.ok
    ? { ok: true, value: "removed" }
    : driveHttpError(response.value.status);
}

export function googleDriveDeepLink(providerFileId: string): string {
  const url = new URL("https://drive.google.com/open");
  url.searchParams.set("id", providerFileId);
  return url.toString();
}

export function googleDriveExportMediaType(
  providerMediaType: string,
): string | null {
  switch (providerMediaType) {
    case "application/vnd.google-apps.document":
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    default:
      return null;
  }
}

async function readStableGoogleDriveContent(
  input: Readonly<{
    readonly accessToken: string;
    readonly providerFileId: string;
    readonly expectedRevision: Variant<ProviderFileRevision, "gdrive">;
    readonly contentUrl: URL;
    readonly maximumBytes: number;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<GoogleDriveBoundedContent, GoogleDriveProtocolError>> {
  const before = await readGoogleDriveFileMetadata(input);
  if (!before.ok) return before;
  if (before.value.trashed) return driveFileUnavailable();
  if (!sameGoogleDriveRevision(before.value.revision, input.expectedRevision)) {
    return driveRevisionChanged();
  }
  const response = await callGoogleDrive(
    input.fetcher,
    input.contentUrl,
    input.accessToken,
  );
  if (!response.ok) return response;
  const bytes = await readBoundedDriveBytes(response.value, input.maximumBytes);
  if (!bytes.ok) return bytes;
  const after = await readGoogleDriveFileMetadata(input);
  if (!after.ok) return after;
  if (after.value.trashed) return driveFileUnavailable();
  if (
    !sameGoogleDriveRevision(before.value.revision, after.value.revision) ||
    !sameGoogleDriveRevision(after.value.revision, input.expectedRevision)
  ) {
    return driveRevisionChanged();
  }
  return {
    ok: true,
    value: {
      bytes: bytes.value,
      mediaType:
        response.value.headers.get("content-type") ?? before.value.mediaType,
      metadata: after.value,
    },
  };
}

function googleDriveMediaUrl(providerFileId: string): URL {
  const url = new URL(
    `${DRIVE_API_URL}/files/${encodeURIComponent(providerFileId)}`,
  );
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

async function callGoogleDrive(
  fetcher: typeof fetch,
  url: URL,
  accessToken: string,
): Promise<Result<Response, GoogleDriveProtocolError>> {
  const response = await fetchGoogleDrive(fetcher, url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return response;
  return response.value.ok ? response : driveHttpError(response.value.status);
}

async function fetchGoogleDrive(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Result<Response, GoogleDriveProtocolError>> {
  try {
    return { ok: true, value: await fetcher(input, init) };
  } catch {
    return {
      ok: false,
      error: { code: "gdrive_transport_unavailable", retryable: true },
    };
  }
}

function parseGoogleDriveTokens(
  raw: unknown,
): Result<GoogleDriveOAuthTokens, GoogleDriveProtocolError> {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.access_token) ||
    !isNonBlankString(raw.refresh_token) ||
    !isPositiveInteger(raw.expires_in) ||
    !isNonBlankString(raw.scope)
  ) {
    return invalidDriveResponse();
  }
  const scopes = exactGoogleDriveScopes(normalizedScopes(raw.scope));
  if (scopes === null) return invalidDriveResponse();
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresInSeconds: raw.expires_in,
      scopes,
    },
  };
}

function parseGoogleDriveRefreshTokens(
  raw: unknown,
  refreshToken: string,
  scopes: readonly string[],
): Result<GoogleDriveOAuthTokens, GoogleDriveProtocolError> {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.access_token) ||
    !isPositiveInteger(raw.expires_in)
  ) {
    return invalidDriveResponse();
  }
  const exactScopes = exactGoogleDriveScopes(scopes);
  if (exactScopes === null) return invalidDriveResponse();
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      refreshToken,
      expiresInSeconds: raw.expires_in,
      scopes: exactScopes,
    },
  };
}

function parseGoogleDriveFileMetadata(
  raw: unknown,
): GoogleDriveFileMetadata | null {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.id) ||
    !isNonBlankString(raw.name) ||
    !isNonBlankString(raw.mimeType) ||
    !isNonBlankString(raw.version) ||
    !isNonBlankString(raw.modifiedTime) ||
    typeof raw.trashed !== "boolean" ||
    !isNonBlankString(raw.webViewLink) ||
    !optionalString(raw.headRevisionId) ||
    !optionalNonNegativeIntegerString(raw.size) ||
    !optionalStringArray(raw.parents)
  ) {
    return null;
  }
  return {
    providerFileId: raw.id,
    name: raw.name,
    mediaType: raw.mimeType,
    byteLength: typeof raw.size === "string" ? Number(raw.size) : null,
    revision: {
      kind: "gdrive",
      version: raw.version,
      modifiedTime: raw.modifiedTime,
      headRevisionId:
        typeof raw.headRevisionId === "string" ? raw.headRevisionId : null,
    },
    trashed: raw.trashed,
    webViewLink: googleDriveDeepLink(raw.id),
    parentIds: Array.isArray(raw.parents) ? raw.parents : [],
  };
}

function parseGoogleDriveChangePage(
  raw: unknown,
): Result<GoogleDriveChangePage, GoogleDriveProtocolError> {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.changes) ||
    !optionalNonEmptyString(raw.nextPageToken) ||
    !optionalNonEmptyString(raw.newStartPageToken)
  ) {
    return invalidDriveResponse();
  }
  const changes: GoogleDriveChange[] = [];
  for (const rawChange of raw.changes) {
    if (
      !isRecord(rawChange) ||
      !isNonBlankString(rawChange.fileId) ||
      typeof rawChange.removed !== "boolean"
    ) {
      return invalidDriveResponse();
    }
    if (rawChange.removed) {
      changes.push({ kind: "removed", providerFileId: rawChange.fileId });
      continue;
    }
    const file = parseGoogleDriveFileMetadata(rawChange.file);
    if (file === null || file.providerFileId !== rawChange.fileId)
      return invalidDriveResponse();
    changes.push({ kind: "file", file });
  }
  return {
    ok: true,
    value: {
      changes,
      nextPageToken:
        typeof raw.nextPageToken === "string" ? raw.nextPageToken : null,
      newStartPageToken:
        typeof raw.newStartPageToken === "string"
          ? raw.newStartPageToken
          : null,
    },
  };
}

async function readBoundedDriveBytes(
  response: Response,
  maximumBytes: number,
): Promise<Result<Uint8Array, GoogleDriveProtocolError>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    return driveContentTooLarge(maximumBytes);
  }
  if (response.body === null) return invalidDriveResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      return driveContentTooLarge(maximumBytes);
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

function sameGoogleDriveRevision(
  left: Variant<ProviderFileRevision, "gdrive">,
  right: Variant<ProviderFileRevision, "gdrive">,
): boolean {
  return (
    left.version === right.version &&
    left.modifiedTime === right.modifiedTime &&
    left.headRevisionId === right.headRevisionId
  );
}

function normalizedScopes(value: string): readonly string[] {
  return value.split(/\s+/u).filter(isNonBlankString).sort();
}

function exactGoogleDriveScopes(
  value: readonly string[],
): readonly string[] | null {
  const scopes = [...value].sort();
  const required = new Set<string>(GOOGLE_DRIVE_REQUIRED_SCOPES);
  return scopes.length === required.size &&
    scopes.every(required.has.bind(required))
    ? scopes
    : null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || isNonBlankString(value);
}

function optionalStringArray(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isNonBlankString(entry)) return false;
  }
  return true;
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonBlankString(value);
}

function optionalNonNegativeIntegerString(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value))
    return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function driveHttpError(
  status: number,
): Result<never, GoogleDriveProtocolError> {
  return {
    ok: false,
    error: {
      code: "gdrive_http_rejected",
      status,
      retryable:
        status === 408 || status === 425 || status === 429 || status >= 500,
    },
  };
}

function invalidDriveResponse(): Result<never, GoogleDriveProtocolError> {
  return {
    ok: false,
    error: { code: "gdrive_response_invalid", retryable: false },
  };
}

function driveRevisionChanged(): Result<never, GoogleDriveProtocolError> {
  return {
    ok: false,
    error: { code: "gdrive_revision_changed", retryable: true },
  };
}

function driveFileUnavailable(): Result<never, GoogleDriveProtocolError> {
  return {
    ok: false,
    error: { code: "gdrive_file_unavailable", retryable: false },
  };
}

function driveContentTooLarge(
  maximumBytes: number,
): Result<never, GoogleDriveProtocolError> {
  return {
    ok: false,
    error: { code: "gdrive_content_too_large", maximumBytes, retryable: false },
  };
}
