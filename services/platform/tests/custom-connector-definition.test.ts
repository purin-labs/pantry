import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeUrl } from "node:url";

import { describe, expect, it } from "vitest";

import type { JsonRecord } from "@purin-labs/control/worker/http";
import {
  buildCustomConnectorRevisionIdentity,
  parseCustomConnectorDefinition,
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
} from "../src/custom-connectors";
import { isRecord } from "@purin-labs/std";

describe("custom connector definition v1", function definitionSuite() {
  it("accepts two unrelated REST definitions through the same parser", async function acceptsRestDefinitions() {
    const github = await parseCustomConnectorDefinition(
      fixture("github-rest.json"),
    );
    const inventory = await parseCustomConnectorDefinition(
      fixture("inventory-rest.json"),
    );

    expect(github.ok).toBe(true);
    expect(inventory.ok).toBe(true);
    if (!github.ok || !inventory.ok) return;

    expect(github.value.definition.operations).toHaveLength(2);
    expect(inventory.value.definition.operations).toHaveLength(2);
    expect(github.value.definition.operations[0]?.transport.kind).toBe("get");
    expect(inventory.value.definition.operations[1]?.transport.kind).toBe(
      "post_json",
    );
    expect(github.value.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(inventory.value.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("canonicalizes unordered definition collections before digesting", async function canonicalizesDefinition() {
    const original = fixture("github-rest.json");
    const reordered = fixture("github-rest.json");
    reordered.operations = [...arrayField(reordered, "operations")].reverse();
    reordered.documentation = [
      ...arrayField(reordered, "documentation"),
    ].reverse();
    const operation = recordAt(arrayField(reordered, "operations"), 0);
    const inputSchema = recordField(operation, "inputSchema");
    inputSchema.required = [...arrayField(inputSchema, "required")].reverse();

    const first = await parseCustomConnectorDefinition(original);
    const second = await parseCustomConnectorDefinition(reordered);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.canonicalJson).toBe(first.value.canonicalJson);
    expect(second.value.digest).toBe(first.value.digest);
  });

  it("rejects GraphQL and write effects without a supported retry policy", async function validatesSupportedBranches() {
    const graphql = fixture("github-rest.json");
    const graphqlOperation = recordAt(arrayField(graphql, "operations"), 0);
    recordField(graphqlOperation, "transport").kind = "graphql";

    const write = fixture("inventory-rest.json");
    const writeOperation = recordAt(arrayField(write, "operations"), 1);
    writeOperation.effect = {
      kind: "external_record_create",
      retryPolicy: { kind: "single_attempt" },
    };

    await expect(parseCustomConnectorDefinition(graphql)).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_contract",
        field: "operations[0].transport.kind",
        reason: "transport must be REST or MCP",
      },
    });
    const parsedWrite = await parseCustomConnectorDefinition(write);
    expect(parsedWrite).toMatchObject({
      ok: true,
      value: {
        definition: {
          operations: expect.arrayContaining([
            expect.objectContaining({
              id: writeOperation.id,
              effect: {
                kind: "external_record_create",
                retryPolicy: { kind: "single_attempt" },
              },
            }),
          ]),
        },
      },
    });

    const unsafeRetry = fixture("inventory-rest.json");
    const unsafeOperation = recordAt(arrayField(unsafeRetry, "operations"), 1);
    unsafeOperation.effect = {
      kind: "external_record_create",
      retryPolicy: { kind: "automatic" },
    };
    await expect(parseCustomConnectorDefinition(unsafeRetry)).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_contract",
        field: "operations[1].effect.retryPolicy",
        reason: "retry policy is unsupported",
      },
    });
  });

  it("requires omitted tool inputs to accept an explicit null", async function requiresNullableOptionalToolInputs() {
    const definition = fixture("inventory-rest.json");
    const operation = recordAt(arrayField(definition, "operations"), 1);
    const inputSchema = recordField(operation, "inputSchema");
    const properties = recordField(inputSchema, "properties");
    properties.cursor = {
      type: "string",
      minLength: 1,
      maxLength: 256,
    };

    await expect(parseCustomConnectorDefinition(definition)).resolves.toEqual({
      ok: false,
      error: {
        code: "definition_invalid",
        field: "operations[1].inputSchema.properties.cursor",
        reason: "optional tool input properties must accept null",
      },
    });
  });

  it("rejects undeclared path inputs and encoded separators", async function rejectsUnsafePaths() {
    const unbound = fixture("inventory-rest.json");
    const unboundOperation = recordAt(arrayField(unbound, "operations"), 0);
    recordField(unboundOperation, "transport").pathTemplate =
      "/v1/accounts/{account_id}";

    const escaped = fixture("inventory-rest.json");
    const escapedOperation = recordAt(arrayField(escaped, "operations"), 0);
    recordField(escapedOperation, "transport").pathTemplate =
      "/v1/accounts/%2fadmin";

    const unboundResult = await parseCustomConnectorDefinition(unbound);
    const escapedResult = await parseCustomConnectorDefinition(escaped);

    expect(unboundResult).toMatchObject({
      ok: false,
      error: {
        code: "definition_invalid",
        field: expect.stringContaining("pathBindings"),
      },
    });
    expect(escapedResult).toMatchObject({
      ok: false,
      error: {
        code: "definition_invalid",
        field: expect.stringContaining("pathTemplate"),
      },
    });
  });

  it("rejects unsupported schema keywords and higher platform limits", async function rejectsExpandedAuthority() {
    const schemaKeyword = fixture("inventory-rest.json");
    const operation = recordAt(arrayField(schemaKeyword, "operations"), 1);
    const inputSchema = recordField(operation, "inputSchema");
    const querySchema = recordField(
      recordField(inputSchema, "properties"),
      "query",
    );
    querySchema.pattern = ".*";

    const highLimit = fixture("inventory-rest.json");
    recordField(highLimit, "limits").wireBytes = 1024 * 1024 + 1;

    const schemaResult = await parseCustomConnectorDefinition(schemaKeyword);
    const limitResult = await parseCustomConnectorDefinition(highLimit);

    expect(schemaResult).toMatchObject({
      ok: false,
      error: {
        code: "definition_invalid",
        field: expect.stringContaining("pattern"),
      },
    });
    expect(limitResult).toEqual({
      ok: false,
      error: {
        code: "definition_invalid",
        field: "limits.wireBytes",
        reason: "must be a positive integer at or below the platform ceiling",
      },
    });
  });

  it("requires identity and cursor pointers to select declared response fields", async function rejectsInvalidResponsePointers() {
    const identity = fixture("inventory-rest.json");
    recordField(identity, "identity").displayNamePointer = "/missing";

    const pagination = fixture("inventory-rest.json");
    const searchOperation = recordAt(arrayField(pagination, "operations"), 1);
    recordField(searchOperation, "pagination").nextCursorPointer = "/products";

    const identityResult = await parseCustomConnectorDefinition(identity);
    const paginationResult = await parseCustomConnectorDefinition(pagination);

    expect(identityResult).toMatchObject({
      ok: false,
      error: {
        code: "definition_invalid",
        field: "identity.displayNamePointer",
      },
    });
    expect(paginationResult).toMatchObject({
      ok: false,
      error: {
        code: "definition_invalid",
        field: "operations[1].pagination.nextCursorPointer",
      },
    });
  });
});

describe("custom connector revision identity", function identitySuite() {
  it("builds revision identity only from parsed components", function buildsIdentity() {
    const connectorId = parseCustomConnectorId("custom_connector_inventory_01");
    const revision = parseCustomConnectorRevision(3);
    const digest = parseCustomConnectorDefinitionDigest("a".repeat(64));

    expect(connectorId.ok).toBe(true);
    expect(revision.ok).toBe(true);
    expect(digest.ok).toBe(true);
    if (!connectorId.ok || !revision.ok || !digest.ok) return;

    expect(
      buildCustomConnectorRevisionIdentity({
        connectorId: connectorId.value,
        revision: revision.value,
        definitionDigest: digest.value,
      }),
    ).toEqual({
      connectorId: "custom_connector_inventory_01",
      revision: 3,
      definitionDigest: "a".repeat(64),
    });
  });

  it("rejects raw or malformed revision components", function rejectsMalformedIdentity() {
    expect(parseCustomConnectorId("inventory_01")).toMatchObject({ ok: false });
    expect(parseCustomConnectorRevision(0)).toMatchObject({ ok: false });
    expect(parseCustomConnectorRevision(1.5)).toMatchObject({ ok: false });
    expect(parseCustomConnectorDefinitionDigest("ABC")).toMatchObject({
      ok: false,
    });
  });
});

function fixture(name: string): JsonRecord {
  const url = new NodeUrl(
    `./fixtures/custom-connectors/${name}`,
    import.meta.url,
  );
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  if (!isRecord(raw)) throw new Error(`fixture ${name} must be an object`);
  return raw;
}

function arrayField(record: JsonRecord, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function recordField(record: JsonRecord, field: string): JsonRecord {
  const value = record[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function recordAt(values: unknown[], index: number): JsonRecord {
  const value = values[index];
  if (!isRecord(value)) throw new Error(`${index} must be an object`);
  return value;
}
