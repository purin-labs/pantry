import { runtimeFetch } from "../runtime-fetch";
import type { Result } from "../result";
import { hasExactKeys, isRecord } from "@seams/std";

const NOTION_API_VERSION = "2026-03-11";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const AIRTABLE_ID_PATTERN = /^(?:app|tbl|viw)[A-Za-z0-9]{8,32}$/u;

export type ExternalRecordsProvider = "airtable" | "notion";

export async function discoverAirtableBases(
  credential: string,
  fetcher: typeof fetch,
): Promise<
  Result<
    readonly Readonly<{ scope: string; label: string }>[],
    ExternalRecordsError
  >
> {
  const response = await safeFetch(
    fetcher,
    new Request("https://api.airtable.com/v0/meta/bases", {
      headers: { authorization: `Bearer ${credential}` },
      redirect: "manual",
    }),
  );
  if (!response.ok) return response;
  const body = await boundedJson(response.value);
  if (!body.ok || !isRecord(body.value) || !Array.isArray(body.value.bases)) {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  const bases: { scope: string; label: string }[] = [];
  for (const base of body.value.bases) {
    if (!isRecord(base) || typeof base.name !== "string") continue;
    const baseId = externalId(base.id, "app");
    if (baseId !== null)
      bases.push({ scope: `base:${baseId}`, label: base.name });
  }
  return { ok: true, value: bases };
}

type AirtableRecordsRead = Readonly<{
  kind: "airtable_records";
  baseId: string;
  tableId: string;
  viewId: string | null;
  query: string | null;
  limit: number;
}>;

type NotionSearchRead = Readonly<{
  kind: "notion_search";
  query: string | null;
  limit: number;
}>;

type ExternalRecordsRead = AirtableRecordsRead | NotionSearchRead;

type ExternalRecordSummary = Readonly<{
  id: string;
  title: string;
  url: string | null;
  updatedAt: string | null;
  fields: Readonly<Record<string, string | number | boolean | null>>;
}>;

type ExternalRecordsResult = Readonly<{
  kind: "external_records";
  provider: ExternalRecordsProvider;
  items: readonly ExternalRecordSummary[];
  truncated: boolean;
}>;

type ExternalProviderIdentity = Readonly<{
  provider: ExternalRecordsProvider;
  providerAccountId: string;
  displayName: string;
  grantedScopes: readonly string[];
}>;

export type ExternalRecordsError =
  | { readonly code: "external_records_input_invalid"; readonly field: string }
  | { readonly code: "external_records_credential_invalid" }
  | { readonly code: "external_records_access_denied" }
  | { readonly code: "external_records_rate_limited" }
  | { readonly code: "external_records_unavailable" }
  | { readonly code: "external_records_response_invalid" };

export function parseExternalRecordsRead(
  provider: ExternalRecordsProvider,
  raw: unknown,
): Result<ExternalRecordsRead, ExternalRecordsError> {
  if (!isRecord(raw)) return invalidInput("input");
  const limit = positiveBoundedInteger(raw.limit, 20);
  const query = nullableBoundedString(raw.query, 128);
  if (limit === null) return invalidInput("limit");
  if (query === undefined) return invalidInput("query");
  switch (provider) {
    case "airtable": {
      if (
        !hasExactKeys(raw, ["baseId", "tableId", "viewId", "query", "limit"])
      ) {
        return invalidInput("input");
      }
      const baseId = externalId(raw.baseId, "app");
      const tableId = externalId(raw.tableId, "tbl");
      const viewId = nullableExternalId(raw.viewId, "viw");
      return baseId === null || tableId === null || viewId === undefined
        ? invalidInput("resource")
        : {
            ok: true,
            value: {
              kind: "airtable_records",
              baseId,
              tableId,
              viewId,
              query,
              limit,
            },
          };
    }
    case "notion":
      return hasExactKeys(raw, ["query", "limit"])
        ? { ok: true, value: { kind: "notion_search", query, limit } }
        : invalidInput("input");
  }
}

export async function validateExternalProviderToken(
  input: Readonly<{
    provider: ExternalRecordsProvider;
    token: string;
    fetcher?: typeof fetch;
  }>,
): Promise<Result<ExternalProviderIdentity, ExternalRecordsError>> {
  if (input.token.trim().length === 0)
    return {
      ok: false,
      error: { code: "external_records_credential_invalid" },
    };
  const fetcher = input.fetcher ?? runtimeFetch;
  const request =
    input.provider === "airtable"
      ? new Request("https://api.airtable.com/v0/meta/whoami", {
          headers: { authorization: `Bearer ${input.token}` },
        })
      : notionRequest("https://api.notion.com/v1/users/me", input.token);
  const response = await safeFetch(fetcher, request);
  if (!response.ok) return response;
  const body = await boundedJson(response.value);
  if (!body.ok || !isRecord(body.value) || typeof body.value.id !== "string") {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  if (input.provider === "airtable") {
    const scopes = stringArray(body.value.scopes);
    return {
      ok: true,
      value: {
        provider: "airtable",
        providerAccountId: body.value.id,
        displayName: "Airtable",
        grantedScopes: scopes,
      },
    };
  }
  const name =
    typeof body.value.name === "string" && body.value.name.trim().length > 0
      ? body.value.name.trim()
      : "Notion";
  return {
    ok: true,
    value: {
      provider: "notion",
      providerAccountId: body.value.id,
      displayName: name,
      grantedScopes: ["content.read"],
    },
  };
}

export async function validateAirtableBaseAccess(
  input: Readonly<{
    token: string;
    baseId: string;
    fetcher?: typeof fetch;
  }>,
): Promise<Result<null, ExternalRecordsError>> {
  if (externalId(input.baseId, "app") === null) return invalidInput("baseId");
  const fetcher = input.fetcher ?? runtimeFetch;
  const response = await safeFetch(
    fetcher,
    new Request(
      `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(input.baseId)}/tables`,
      { headers: { authorization: `Bearer ${input.token}` } },
    ),
  );
  if (!response.ok) return response;
  const body = await boundedJson(response.value);
  return body.ok && isRecord(body.value) && Array.isArray(body.value.tables)
    ? { ok: true, value: null }
    : { ok: false, error: { code: "external_records_response_invalid" } };
}

export async function readExternalRecords(
  input: Readonly<{
    credential: string;
    request: ExternalRecordsRead;
    fetcher?: typeof fetch;
  }>,
): Promise<Result<ExternalRecordsResult, ExternalRecordsError>> {
  const fetcher = input.fetcher ?? runtimeFetch;
  return input.request.kind === "airtable_records"
    ? readAirtableRecords(fetcher, input.credential, input.request)
    : readNotionSearch(fetcher, input.credential, input.request);
}

async function readAirtableRecords(
  fetcher: typeof fetch,
  credential: string,
  input: AirtableRecordsRead,
): Promise<Result<ExternalRecordsResult, ExternalRecordsError>> {
  const url = new URL(
    `https://api.airtable.com/v0/${encodeURIComponent(input.baseId)}/${encodeURIComponent(input.tableId)}`,
  );
  url.searchParams.set(
    "pageSize",
    String(Math.min(100, Math.max(input.limit * 4, input.limit))),
  );
  url.searchParams.set("returnFieldsByFieldId", "true");
  if (input.viewId !== null) url.searchParams.set("view", input.viewId);
  const response = await safeFetch(
    fetcher,
    new Request(url, {
      headers: { authorization: `Bearer ${credential}` },
    }),
  );
  if (!response.ok) return response;
  const body = await boundedJson(response.value);
  if (!body.ok || !isRecord(body.value) || !Array.isArray(body.value.records)) {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  const normalized: ExternalRecordSummary[] = [];
  for (const raw of body.value.records) {
    const record = airtableRecord(raw);
    if (record === null || !matchesRecord(record, input.query)) continue;
    normalized.push(record);
    if (normalized.length === input.limit) break;
  }
  return {
    ok: true,
    value: {
      kind: "external_records",
      provider: "airtable",
      items: normalized,
      truncated:
        typeof body.value.offset === "string" ||
        normalized.length === input.limit,
    },
  };
}

async function readNotionSearch(
  fetcher: typeof fetch,
  credential: string,
  input: NotionSearchRead,
): Promise<Result<ExternalRecordsResult, ExternalRecordsError>> {
  const response = await safeFetch(
    fetcher,
    notionRequest("https://api.notion.com/v1/search", credential, {
      method: "POST",
      body: JSON.stringify({
        query: input.query ?? undefined,
        page_size: input.limit,
      }),
    }),
  );
  if (!response.ok) return response;
  const body = await boundedJson(response.value);
  if (!body.ok || !isRecord(body.value) || !Array.isArray(body.value.results)) {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  const items: ExternalRecordSummary[] = [];
  for (const raw of body.value.results) {
    const record = notionRecord(raw);
    if (record === null) continue;
    items.push(record);
  }
  return {
    ok: true,
    value: {
      kind: "external_records",
      provider: "notion",
      items,
      truncated: body.value.has_more === true,
    },
  };
}

function notionRequest(
  url: string,
  token: string,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "notion-version": NOTION_API_VERSION,
    },
  });
}

async function safeFetch(
  fetcher: typeof fetch,
  request: Request,
): Promise<Result<Response, ExternalRecordsError>> {
  let response: Response;
  try {
    response = await fetcher(request);
  } catch {
    return { ok: false, error: { code: "external_records_unavailable" } };
  }
  if (response.ok) return { ok: true, value: response };
  if (response.status === 401)
    return {
      ok: false,
      error: { code: "external_records_credential_invalid" },
    };
  if (response.status === 403 || response.status === 404) {
    return { ok: false, error: { code: "external_records_access_denied" } };
  }
  if (response.status === 429)
    return { ok: false, error: { code: "external_records_rate_limited" } };
  return { ok: false, error: { code: "external_records_unavailable" } };
}

async function boundedJson(
  response: Response,
): Promise<Result<unknown, ExternalRecordsError>> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: { code: "external_records_response_invalid" } };
  }
}

function airtableRecord(raw: unknown): ExternalRecordSummary | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.fields))
    return null;
  const fields = scalarFields(raw.fields);
  return {
    id: raw.id,
    title: firstScalar(fields) ?? raw.id,
    url: null,
    updatedAt: typeof raw.createdTime === "string" ? raw.createdTime : null,
    fields,
  };
}

function notionRecord(raw: unknown): ExternalRecordSummary | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    (raw.object !== "page" &&
      raw.object !== "data_source" &&
      raw.object !== "database")
  )
    return null;
  return {
    id: raw.id,
    title: notionTitle(raw) ?? raw.id,
    url: typeof raw.url === "string" ? raw.url : null,
    updatedAt:
      typeof raw.last_edited_time === "string" ? raw.last_edited_time : null,
    fields: { object: raw.object },
  };
}

function notionTitle(raw: Readonly<Record<string, unknown>>): string | null {
  if (Array.isArray(raw.title)) return richText(raw.title);
  if (!isRecord(raw.properties)) return null;
  for (const property of Object.values(raw.properties)) {
    if (isRecord(property) && Array.isArray(property.title)) {
      const title = richText(property.title);
      if (title !== null) return title;
    }
  }
  return null;
}

function richText(raw: readonly unknown[]): string | null {
  const value = raw
    .map((item) =>
      isRecord(item) && typeof item.plain_text === "string"
        ? item.plain_text
        : "",
    )
    .join("")
    .trim();
  return value.length > 0 ? value.slice(0, 512) : null;
}

function scalarFields(
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | null>> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 40)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = typeof value === "string" ? value.slice(0, 1024) : value;
    }
  }
  return result;
}

function matchesRecord(
  record: ExternalRecordSummary,
  query: string | null,
): boolean {
  if (query === null) return true;
  const needle = query.toLocaleLowerCase();
  return (
    record.title.toLocaleLowerCase().includes(needle) ||
    Object.values(record.fields).some((value) =>
      String(value).toLocaleLowerCase().includes(needle),
    )
  );
}

function firstScalar(
  fields: Readonly<Record<string, string | number | boolean | null>>,
): string | null {
  for (const value of Object.values(fields)) {
    if (typeof value === "string" && value.trim().length > 0)
      return value.slice(0, 512);
  }
  return null;
}

function externalId(
  raw: unknown,
  prefix: "app" | "tbl" | "viw",
): string | null {
  return typeof raw === "string" &&
    raw.startsWith(prefix) &&
    AIRTABLE_ID_PATTERN.test(raw)
    ? raw
    : null;
}

function nullableExternalId(
  raw: unknown,
  prefix: "viw",
): string | null | undefined {
  return raw === null ? null : (externalId(raw, prefix) ?? undefined);
}

function nullableBoundedString(
  raw: unknown,
  max: number,
): string | null | undefined {
  return raw === null
    ? null
    : typeof raw === "string" && raw.length <= max && raw.trim() === raw
      ? raw
      : undefined;
}

function positiveBoundedInteger(raw: unknown, max: number): number | null {
  return typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw >= 1 &&
    raw <= max
    ? raw
    : null;
}

function stringArray(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

function invalidInput(field: string): Result<never, ExternalRecordsError> {
  return {
    ok: false,
    error: { code: "external_records_input_invalid", field },
  };
}
