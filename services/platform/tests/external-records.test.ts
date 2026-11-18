import { describe, expect, it } from "vitest";

import {
  parseExternalRecordsRead,
  readExternalRecords,
  validateAirtableBaseAccess,
  validateExternalProviderToken,
} from "../src/external-records/records";
import { parseIntegrationProvider } from "../src/data/integration-account";

describe("external record providers", () => {
  it("normalizes a bounded Airtable record read", async () => {
    const parsed = parseExternalRecordsRead("airtable", {
      baseId: "appBase12345",
      tableId: "tblTable12345",
      viewId: "viwView12345",
      query: "match",
      limit: 1,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await readExternalRecords({
      credential: "pat",
      request: parsed.value,
      fetcher: async (request) => {
        const normalized = new Request(request);
        expect(normalized.headers.get("authorization")).toBe("Bearer pat");
        expect(
          new URL(normalized.url).searchParams.get("returnFieldsByFieldId"),
        ).toBe("true");
        return Response.json({
          records: [
            {
              id: "rec1",
              createdTime: "2026-08-21T00:00:00Z",
              fields: { fldName: "match item", nested: ["hidden"] },
            },
          ],
        });
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "external_records",
        provider: "airtable",
        items: [
          {
            id: "rec1",
            title: "match item",
            url: null,
            updatedAt: "2026-08-21T00:00:00Z",
            fields: { fldName: "match item" },
          },
        ],
        truncated: true,
      },
    });
  });

  it("pins Notion reads to the current API and strips raw properties", async () => {
    const parsed = parseExternalRecordsRead("notion", {
      query: "menu",
      limit: 2,
    });
    if (!parsed.ok) throw new Error(parsed.error.code);
    const result = await readExternalRecords({
      credential: "ntn",
      request: parsed.value,
      fetcher: async (request) => {
        const normalized = new Request(request);
        expect(normalized.headers.get("notion-version")).toBe("2026-03-11");
        expect(await normalized.json()).toEqual({
          query: "menu",
          page_size: 2,
        });
        return Response.json({
          results: [
            {
              object: "page",
              id: "page-1",
              url: "https://notion.so/page-1",
              last_edited_time: "2026-08-20T00:00:00Z",
              properties: {
                Name: { title: [{ plain_text: "Summer menu" }] },
                Secret: { rich_text: [{ plain_text: "excluded" }] },
              },
            },
          ],
          has_more: false,
        });
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "external_records",
        provider: "notion",
        items: [
          {
            id: "page-1",
            title: "Summer menu",
            url: "https://notion.so/page-1",
            updatedAt: "2026-08-20T00:00:00Z",
            fields: { object: "page" },
          },
        ],
        truncated: false,
      },
    });
  });

  it("validates provider identity without returning sensitive profile fields", async () => {
    const result = await validateExternalProviderToken({
      provider: "airtable",
      token: "pat",
      fetcher: async () =>
        Response.json({
          id: "usr123",
          email: "private@example.com",
          scopes: ["data.records:read"],
        }),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        provider: "airtable",
        providerAccountId: "usr123",
        displayName: "Airtable",
        grantedScopes: ["data.records:read"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });

  it("requires access to the configured Airtable base", async () => {
    const result = await validateAirtableBaseAccess({
      token: "pat",
      baseId: "appBase12345",
      fetcher: async (request) => {
        const normalized = new Request(request);
        expect(normalized.url).toContain("/v0/meta/bases/appBase12345/tables");
        return Response.json(
          { error: { type: "INVALID_PERMISSIONS" } },
          { status: 403 },
        );
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "external_records_access_denied" },
    });
  });

  it("rejects malformed resource identities at the boundary", () => {
    expect(parseIntegrationProvider("airtable")).toEqual({
      ok: true,
      value: "airtable",
    });
    expect(parseIntegrationProvider("notion")).toEqual({
      ok: true,
      value: "notion",
    });
    expect(
      parseExternalRecordsRead("airtable", {
        baseId: "../../etc",
        tableId: "tblTable12345",
        viewId: null,
        query: null,
        limit: 1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "external_records_input_invalid", field: "resource" },
    });
  });
});
