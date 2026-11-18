import { afterEach, expect, it, vi } from "vitest";
import {
  parseAirtableReadArgs,
  parseAirtableWriteArgs,
  airtableBaseScope,
} from "../src/actors/airtable-tool-input";
import { callAirtableApi } from "../src/integrations/airtable-api";

afterEach(restoreFetch);
it(
  "creates a table through a base-scoped request without exposing provider secrets",
  createsTable,
);
it(
  "rejects external hosts, normalized paths and non-base endpoints",
  rejectsEscapingPaths,
);

function restoreFetch(): void {
  vi.unstubAllGlobals();
}

async function createsTable(): Promise<void> {
  const parsed = parseAirtableWriteArgs([
    {
      requestJson: JSON.stringify({
        kind: "request",
        integrationAccountId: "ia_airtable",
        method: "POST",
        path: "/v0/meta/bases/appBase12345/tables",
        body: {
          name: "Test",
          fields: [{ name: "Name", type: "singleLineText" }],
        },
      }),
    },
  ]);
  expect(airtableBaseScope(parsed)).toBe("base:appBase12345");
  vi.stubGlobal("fetch", tableResponse);
  expect(await callAirtableApi("private-test-token", parsed.request)).toEqual({
    id: "tblNew12345",
  });
}

async function tableResponse(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  expect(request.url).toBe(
    "https://api.airtable.com/v0/meta/bases/appBase12345/tables",
  );
  expect(request.method).toBe("POST");
  expect(request.redirect).toBe("manual");
  expect(request.headers.get("authorization")).toBe(
    "Bearer private-test-token",
  );
  expect(await request.json()).toEqual({
    name: "Test",
    fields: [{ name: "Name", type: "singleLineText" }],
  });
  return Response.json({
    id: "tblNew12345",
    macSecretBase64: "private-webhook-secret",
  });
}

function rejectsEscapingPaths(): void {
  for (const path of [
    "https://example.com",
    "/v0/meta/bases",
    "/v0/appBase12345/../appOther12345",
    "/v0/appBase12345/%2e%2e/appOther12345",
  ]) {
    expect(parseRead.bind(null, path)).toThrow();
  }
}

function parseRead(path: string): void {
  parseAirtableReadArgs([
    {
      requestJson: JSON.stringify({
        kind: "request",
        integrationAccountId: "ia_airtable",
        method: "GET",
        path,
        body: null,
      }),
    },
  ]);
}
