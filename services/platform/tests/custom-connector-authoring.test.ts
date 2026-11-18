import { readFileSync } from "node:fs";
import { URL as NodeUrl } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readConnectorDocumentation,
  parseConnectorAuthoringOutput,
  type ConnectorDocumentation,
} from "../src/custom-connectors/authoring";
import { parseCustomConnectorDefinition } from "../src/custom-connectors/definition";
import { projectCustomConnectorResponse } from "../src/custom-connectors/execution";
import {
  basicApiKeyVaultSecret,
  basicApiKeyFromVault,
} from "../src/custom-connectors/basic-authentication";
import type { MessageLinkEgress } from "../src/messages/link-reader";
import type { JsonRecord } from "../src/control/http";
import { isRecord } from "@seams/std";
const documents: readonly ConnectorDocumentation[] = [
  {
    url: "https://docs.easypost.com/markdown/docs/users.md",
    sha256: "a".repeat(64),
    text: "GET https://api.easypost.com/v2/users returns the authenticated user. Only Production API keys work. GET https://api.easypost.com/v2/shipments lists shipments.",
    truncated: false,
  },
];

describe("AI connector authoring", function authoringSuite() {
  it("reads public docs with provenance and validates a generated EasyPost draft without trusting model-supplied references", async function draftsEasyPost() {
    const read = await readConnectorDocumentation(
      [documents[0]!.url],
      publicDocsEgress,
    );
    if (!read.ok) throw new Error(read.error.code);
    expect(read.value).toHaveLength(1);
    expect(read.value[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const draft = easyPostDefinition();
    draft.documentation = [
      { url: "https://unfetched.invalid", sha256: "b".repeat(64) },
    ];
    const parsed = await parseConnectorAuthoringOutput(
      JSON.stringify({ kind: "definition", document: draft }),
      read.value,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.documentation).toEqual(read.value.map(reference));
    expect(JSON.stringify(parsed.value)).not.toContain("unfetched.invalid");
  });

  it("refuses private docs, unsupported services, unsafe generated operations, and invented origins", async function refusesUnsafeDrafts() {
    expect((await readConnectorDocumentation(["https://docs.example.com/api"], privateDocsEgress)).ok).toBe(false);
    expect(
      await parseConnectorAuthoringOutput(
        '{"kind":"unsupported","reason":"No authenticated account identity is documented."}',
        documents,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "authoring_service_unsupported" },
    });
    const invented = easyPostDefinition();
    invented.origin = "https://other.example.com";
    expect(
      (
        await parseConnectorAuthoringOutput(
          JSON.stringify({ kind: "definition", document: invented }),
          documents,
        )
      ).ok,
    ).toBe(false);
    const sensitive = easyPostDefinition();
    const operations = sensitive.operations;
    if (
      !Array.isArray(operations) ||
      !isRecord(operations[1]) ||
      !isRecord(operations[1].transport)
    )
      throw new Error("fixture invalid");
    operations[1].transport.pathTemplate = "/v2/api_keys";
    expect(
      await parseConnectorAuthoringOutput(
        JSON.stringify({ kind: "definition", document: sensitive }),
        documents,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "authoring_service_unsupported" },
    });
  });

  it("projects reviewed EasyPost fields, preserves null tracking codes, and rejects missing or mistyped fields", async function projectsEasyPostResponses() {
    const parsed = await parseCustomConnectorDefinition(easyPostDefinition());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const operation = parsed.value.definition.operations.find(isShipmentRead);
    if (operation === undefined) throw new Error("shipment operation missing");
    const response = {
      shipments: [
        {
          id: "shp_123",
          status: "unknown",
          tracking_code: null,
          to_address: { street1: "Private street" },
          postage_label: null,
        },
      ],
      has_more: false,
    };
    expect(projectCustomConnectorResponse(bytes(response), operation)).toEqual({
      ok: true,
      value: [{ id: "shp_123", status: "unknown", tracking_code: null }],
    });
    expect(
      projectCustomConnectorResponse(
        bytes({ shipments: [{ id: "shp_123" }] }),
        operation,
      ).ok,
    ).toBe(false);
    expect(
      projectCustomConnectorResponse(
        bytes({
          shipments: [{ id: 123, status: "unknown", tracking_code: null }],
        }),
        operation,
      ).ok,
    ).toBe(false);
  });

  it("round-trips a Basic API key through an encrypted-vault header representation and rejects passwords", function basicAuthentication() {
    const secret = basicApiKeyVaultSecret("EZAK_fixture_123");
    if (secret === null) throw new Error("fixture key invalid");
    expect(basicApiKeyFromVault(secret)).toBe("EZAK_fixture_123");
    expect(basicApiKeyVaultSecret("username:password")).toBeNull();
    expect(basicApiKeyVaultSecret("key\nInjected:header")).toBeNull();
    expect(
      basicApiKeyFromVault({
        kind: "header",
        header: "Authorization",
        value: `Basic ${btoa("key:password")}`,
      }),
    ).toBeNull();
    expect(
      basicApiKeyFromVault({ kind: "bearer", value: "EZAK_fixture_123" }),
    ).toBeNull();
  });
});

function easyPostDefinition(): JsonRecord {
  const raw: unknown = JSON.parse(
    readFileSync(
      new NodeUrl(
        "./fixtures/custom-connectors/easypost-rest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!isRecord(raw)) throw new Error("invalid fixture");
  return raw;
}

function reference(document: ConnectorDocumentation): {
  url: string;
  sha256: string;
} {
  return { url: document.url, sha256: document.sha256 };
}

function isShipmentRead(operation: { readonly id: string }): boolean {
  return operation.id === "list_shipments";
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const publicDocsEgress: MessageLinkEgress = {
  resolve: resolvePublic,
  fetchValidated: fetchDocs,
};
const privateDocsEgress: MessageLinkEgress = {
  resolve: resolvePrivate,
  fetchValidated: rejectFetch,
};
async function resolvePublic(): Promise<readonly string[]> {
  return ["93.184.216.34"];
}
async function resolvePrivate(): Promise<readonly string[]> {
  return ["127.0.0.1"];
}
async function fetchDocs(): Promise<Response> {
  return new Response(documents[0]?.text, {
    headers: { "content-type": "text/markdown" },
  });
}
async function rejectFetch(): Promise<Response> {
  throw new Error("Private documentation must not be fetched");
}
