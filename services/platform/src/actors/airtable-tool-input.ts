import { parseIntegrationAccountId, type IntegrationAccountId } from "../ids";
import { isRecord } from "@purin-labs/std";

export type AirtableReadRequest = Readonly<{
  baseId: string;
  url: string;
  method: "GET";
  body: null;
}>;

export type AirtableWriteRequest = Readonly<{
  baseId: string;
  url: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body: string | null;
}>;

export type AirtableAccountRequest = Readonly<{
  integrationAccountId: IntegrationAccountId;
  request: AirtableReadRequest | AirtableWriteRequest;
}>;

export type AirtableReadInput =
  | Readonly<{ kind: "discover" }>
  | Readonly<{
      kind: "request";
      integrationAccountId: IntegrationAccountId;
      request: AirtableReadRequest;
    }>;

export type AirtableWriteInput = Readonly<{
  kind: "request";
  integrationAccountId: IntegrationAccountId;
  request: AirtableWriteRequest;
}>;

export function parseAirtableReadArgs(
  args: readonly unknown[],
): AirtableReadInput {
  const raw = parseEnvelope(args);
  if (raw.kind === "discover" && Object.keys(raw).length === 1) {
    return { kind: "discover" };
  }

  const input = parseRequest(raw);
  if (input.request.method !== "GET") {
    throw new Error("Airtable read requires GET");
  }

  return {
    kind: "request",
    integrationAccountId: input.integrationAccountId,
    request: {
      baseId: input.request.baseId,
      url: input.request.url,
      method: "GET",
      body: null,
    },
  };
}

export function parseAirtableWriteArgs(
  args: readonly unknown[],
): AirtableWriteInput {
  const input = parseRequest(parseEnvelope(args));
  if (input.request.method === "GET") {
    throw new Error("Use airtable_api_read for GET");
  }

  return {
    kind: "request",
    integrationAccountId: input.integrationAccountId,
    request: {
      baseId: input.request.baseId,
      url: input.request.url,
      method: input.request.method,
      body: input.request.body,
    },
  };
}

function parseEnvelope(args: readonly unknown[]): Record<string, unknown> {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof raw.requestJson !== "string" ||
    raw.requestJson.length > 100_000
  ) {
    throw new Error("Invalid Airtable arguments");
  }

  let request: unknown;
  try {
    request = JSON.parse(raw.requestJson);
  } catch {
    throw new Error("Invalid Airtable request");
  }

  if (!isRecord(request)) {
    throw new Error("Invalid Airtable request");
  }

  return request;
}

function parseRequest(raw: Record<string, unknown>): AirtableAccountRequest {
  if (
    raw.kind !== "request" ||
    Object.keys(raw).length !== 5 ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.path !== "string" ||
    !("body" in raw)
  ) {
    throw new Error(
      "Expected kind, integrationAccountId, method, path and body",
    );
  }

  const account = parseIntegrationAccountId(raw.integrationAccountId);
  if (
    !account.ok ||
    !raw.path.startsWith("/v0/") ||
    raw.path.length > 8000 ||
    /[\\#\r\n]/u.test(raw.path)
  ) {
    throw new Error("Invalid Airtable account or path");
  }

  const url = new URL(raw.path, "https://api.airtable.com");
  if (
    url.origin !== "https://api.airtable.com" ||
    url.pathname !== raw.path.split("?")[0] ||
    /%(?:2f|5c|2e)/iu.test(url.pathname)
  ) {
    throw new Error("Invalid Airtable path");
  }

  const match =
    /^\/v0\/(?:meta\/bases\/|bases\/)?(app[A-Za-z0-9]{8,32})(?:\/|$)/u.exec(
      url.pathname,
    );
  if (!match?.[1]) {
    throw new Error("Use a base-scoped Airtable API path");
  }

  const body = raw.body === null ? null : JSON.stringify(raw.body);
  switch (raw.method) {
    case "GET":
      if (body !== null) {
        throw new Error("GET body must be null");
      }

      return {
        integrationAccountId: account.value,
        request: { baseId: match[1], url: url.href, method: "GET", body: null },
      };
    case "POST":
    case "PATCH":
    case "PUT":
    case "DELETE":
      return {
        integrationAccountId: account.value,
        request: { baseId: match[1], url: url.href, method: raw.method, body },
      };
    default:
      throw new Error("Unsupported Airtable method");
  }
}

export function airtableBaseScope(input: AirtableAccountRequest): string {
  return `base:${input.request.baseId}`;
}
