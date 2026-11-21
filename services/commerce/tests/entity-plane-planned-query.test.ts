import { describe, expect, it } from "vitest";
import type {
  CommerceCursor,
  CommerceGraphQueryPlanRequest,
  CustomEntityTypeRevision,
} from "@purin-labs/commerce-contracts";
import { encodeCommerceCursor } from "@purin-labs/commerce-contracts/query-encoders";
import { decodeCommerceCursor } from "@purin-labs/commerce-contracts/cursor-payload";
import {
  parseCommerceCursorPayload,
  parseCommerceGraphQuery,
  parseCommerceGraphQueryPlanRequest,
} from "@purin-labs/commerce-client";

import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import { writeCustomEntity } from "../src/entity-plane/entities.ts";
import { writeCommerceEntityRelationText } from "../src/entity-plane/relation-text.ts";
import {
  parseCustomEntityTypeDraft,
  parseEntityRef,
  parsePositiveRevision,
} from "../src/entity-plane/parsers.ts";

const NOW = "2026-08-26T00:00:00.123Z";
const SIGNER = {
  keyId: "planned-query-test",
  publicKeyB64: "planned-query-test-public-key",
  sign: (payload: Uint8Array): string =>
    Buffer.from(payload).toString("base64url"),
};

describe("Commerce Lexicon-planned entity queries", () => {
  it("hydrates exact plans and returns a Lexicon cursor for retained pages", () => {
    const { database, service } = fixture();
    const request = pageRequest(null, 1);
    const first = service.executePlannedQuery(request);
    expect(first.kind).toBe("planned");
    if (first.kind !== "planned") return;
    expect(
      first.result.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["partner_a"]);
    expect(first.result.entities[0]?.displayName).toBe("A Partner");
    expect(first.hasMore).toBe(true);
    expect(first.result.nextCursor).toEqual(expect.any(String));

    const continuation = service.executePlannedQuery(
      pageRequest(first.result.nextCursor, 1),
    );
    expect(continuation.kind).toBe("planned");
    if (continuation.kind !== "planned") return;
    expect(
      continuation.result.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["partner_b"]);
    expect(continuation.result.nextCursor).toBeNull();

    const exact = service.executePlannedQuery(exactRequest());
    expect(exact.kind).toBe("planned");
    if (exact.kind !== "planned") return;
    expect(exact.result.entities).toHaveLength(1);
    expect(exact.result.entities[0]?.reference.entityId).toBe("partner_b");
    database.close();
  });

  it("returns typed stale and cursor-mismatch outcomes before SQLite execution", () => {
    const { database, service } = fixture();
    const stale = service.executePlannedQuery(
      parseCommerceGraphQueryPlanRequest({
        ...pageRequest(null, 1),
        watermark: { kind: "commerce_native", merchantRevision: 0 },
      }),
    );
    expect(stale).toEqual({
      kind: "cursor_stale",
      expected: { kind: "commerce_native", merchantRevision: 1 },
      received: { kind: "commerce_native", merchantRevision: 0 },
    });

    const first = service.executePlannedQuery(pageRequest(null, 1));
    expect(first.kind).toBe("planned");
    if (first.kind !== "planned" || first.result.nextCursor === null) return;
    const cursorPayload = decodeCursor(first.result.nextCursor);
    const fakeCursor = encodeCursor({
      ...cursorPayload,
      queryFingerprint: "f".repeat(64),
    });
    const mismatch = service.executePlannedQuery(pageRequest(fakeCursor, 1));
    expect(mismatch).toEqual({
      kind: "cursor_mismatch",
      reason: "query_fingerprint",
    });
    database.close();
  });

  it("rejects a caller capability profile that differs from the authoritative schema", () => {
    const { database, service } = fixture();
    const request = pageRequest(null, 1);
    if (request.capabilities.kind !== "commerce_custom")
      throw new Error("fixture capability is not custom");
    const result = service.executePlannedQuery(
      parseCommerceGraphQueryPlanRequest({
        ...request,
        capabilities: {
          ...request.capabilities,
          capability: {
            ...request.capabilities.capability,
            filterableAttributeIds: ["forged_attribute"],
          },
        },
      }),
    );
    expect(result).toEqual({ kind: "invalid" });
    database.close();
  });

  it("returns the authoritative capability profile and current watermark", () => {
    const { database, service } = fixture();
    const metadata = service.readCapabilityMetadata({
      organisationId: "organisation_planned",
      merchantId: "merchant_planned",
      query: parseCommerceGraphQuery({
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 25 },
      }),
    });
    expect(metadata).toMatchObject({
      kind: "capability_metadata",
      organisationId: "organisation_planned",
      merchantId: "merchant_planned",
      merchantRevision: 1,
      watermark: { kind: "commerce_native", merchantRevision: 1 },
      capabilities: {
        kind: "commerce_custom",
        entityTypeId: "trade_partner",
        publishedRevision: 1,
      },
      projection: {
        attributeIds: [],
        relationshipDefinitions: [],
        includeProvenance: true,
        includeFreshness: true,
      },
    });
    database.close();
  });

  it("materializes commerce_unicode_v1 display keys at the write boundary", () => {
    const { database, service } = fixture();
    const reference = parseEntityRef({
      origin: "custom",
      typeId: "trade_partner",
      entityId: "partner_unicode",
    });
    if (reference.origin !== "custom")
      throw new Error("fixture reference is not custom");
    writeCustomEntity(
      database,
      "merchant_planned",
      reference,
      parsePositiveRevision<CustomEntityTypeRevision>(
        1,
        "fixture.typeRevision",
      ),
      "ＡＢﬁ Straße",
      "internal",
      [],
      NOW,
    );
    expect(
      database
        .prepare(
          `SELECT entity.display_name, relation_index.display_name_folded
       FROM custom_entity AS entity
       JOIN commerce_entity_relation_index AS relation_index
         ON relation_index.merchant_id = entity.merchant_id
        AND relation_index.entity_origin = 'custom'
        AND relation_index.entity_type = entity.entity_type_id
        AND relation_index.entity_id = entity.entity_id
       WHERE entity.merchant_id = ? AND entity.entity_id = ?`,
        )
        .get("merchant_planned", "partner_unicode"),
    ).toEqual({
      display_name: "ＡＢﬁ Straße",
      display_name_folded: "abfi strasse",
    });
    const searched = service.executePlannedQuery(searchRequest("STRASSE"));
    expect(searched.kind).toBe("planned");
    if (searched.kind === "planned") {
      expect(
        searched.result.entities.map((entity) => entity.reference.entityId),
      ).toEqual(["partner_unicode"]);
    }
    database.close();
  });

  it("executes count with all through the shared normalized compiler", () => {
    const { database, service } = fixture();
    const counted = service.executePlannedQuery(countRequest());
    expect(counted.kind).toBe("planned");
    if (counted.kind === "planned") {
      expect(counted.result.entities).toEqual([]);
      expect(counted.result.aggregations).toEqual([
        { kind: "count", value: 2n },
      ]);
      expect(counted.result.nextCursor).toBeNull();
      expect(counted.hasMore).toBe(false);
    }
    database.close();
  });

  it("pages Commerce List membership and exact-hydrates entries and entities", () => {
    const { database, service } = fixture();
    const first = service.executePlannedQuery(listRequest(null, 1));
    expect(first.kind).toBe("planned");
    if (first.kind !== "planned") return;
    expect(first.result.listEntries.map((entry) => entry.entryId)).toEqual([
      "entry_a",
    ]);
    expect(
      first.result.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["partner_a"]);
    expect(first.result.nextCursor).toEqual(expect.any(String));

    const second = service.executePlannedQuery(
      listRequest(first.result.nextCursor, 1),
    );
    expect(second.kind).toBe("planned");
    if (second.kind === "planned") {
      expect(second.result.listEntries.map((entry) => entry.entryId)).toEqual([
        "entry_b",
      ]);
      expect(
        second.result.entities.map((entity) => entity.reference.entityId),
      ).toEqual(["partner_b"]);
      expect(second.result.nextCursor).toBeNull();
    }
    database.close();
  });

  it("counts Commerce List membership through the shared compiler", () => {
    const { database, service } = fixture();
    const counted = service.executePlannedQuery(listCountRequest());
    expect(counted.kind).toBe("planned");
    if (counted.kind === "planned") {
      expect(counted.result.aggregations).toEqual([
        { kind: "count", value: 2n },
      ]);
    }
    database.close();
  });
});

function fixture(): Readonly<{
  database: NodeCommerceDatabase;
  service: EntityPlaneService;
}> {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES ('merchant_planned', 'organisation_planned', 1, ?, ?)`,
    )
    .run(NOW, NOW);
  const type = parseCustomEntityTypeDraft({
    typeId: "trade_partner",
    label: "Trade partner",
    description: "Planned query fixture",
    attributes: [],
  });
  database
    .prepare(
      `INSERT INTO custom_entity_type (
       merchant_id, entity_type_id, revision, lifecycle_state,
       definition_json, created_at, updated_at
     ) VALUES ('merchant_planned', ?, 1, 'published', ?, ?, ?)`,
    )
    .run(type.typeId, JSON.stringify(type), NOW, NOW);
  database
    .prepare(
      `INSERT INTO custom_entity_type_head (
       merchant_id, entity_type_id, current_revision, published_revision,
       lifecycle_state, updated_at
     ) VALUES ('merchant_planned', ?, 1, 1, 'published', ?)`,
    )
    .run(type.typeId, NOW);
  for (const [entityId, displayName] of [
    ["partner_a", "A Partner"],
    ["partner_b", "B Partner"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO custom_entity (
         merchant_id, entity_id, entity_type_id, entity_type_revision,
         revision, lifecycle_state, display_name,
         sensitivity, created_at, updated_at
       ) VALUES ('merchant_planned', ?, ?, 1, 1, 'active', ?, 'internal', ?, ?)`,
      )
      .run(entityId, type.typeId, displayName, NOW, NOW);
    writeCommerceEntityRelationText(
      database,
      "merchant_planned",
      "custom",
      type.typeId,
      entityId,
      1,
      NOW,
      displayName,
    );
  }
  const list = {
    listId: "partner_list",
    entityTypeId: { origin: "custom", typeId: "trade_partner" },
    name: "Partners",
    membership: "unique_entity",
    entryAttributeDefinitions: [],
    publishedRevision: 1,
  };
  database
    .prepare(
      `INSERT INTO commerce_list (
       merchant_id, list_id, entity_type_id, revision, lifecycle_state,
       name, definition_json, created_at, updated_at
     ) VALUES ('merchant_planned', 'partner_list', ?, 1, 'published', 'Partners', ?, ?, ?)`,
    )
    .run("trade_partner", JSON.stringify(list), NOW, NOW);
  database
    .prepare(
      `INSERT INTO commerce_list_head (
       merchant_id, list_id, current_revision, published_revision, lifecycle_state, updated_at
     ) VALUES ('merchant_planned', 'partner_list', 1, 1, 'published', ?)`,
    )
    .run(NOW);
  for (const entityId of ["partner_a", "partner_b"] as const) {
    database
      .prepare(
        `INSERT INTO commerce_list_entry (
         merchant_id, entry_id, list_id, list_revision, entity_origin,
         entity_type_id, entity_id, revision, lifecycle_state,
         created_at, updated_at, updated_at_ms, membership_kind
       ) VALUES ('merchant_planned', ?, 'partner_list', 1, 'custom',
                 'trade_partner', ?, 1, 'active', ?, ?, ?, 'unique_entity')`,
      )
      .run(
        entityId === "partner_a" ? "entry_a" : "entry_b",
        entityId,
        NOW,
        NOW,
        Date.parse(NOW),
      );
  }
  return {
    database,
    service: new EntityPlaneService({
      database,
      now: () => NOW,
      signer: SIGNER,
    }),
  };
}

function pageRequest(
  cursor: string | null,
  limit: number,
): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    query: {
      kind: "entity_type_page",
      entityTypeId: { origin: "custom", typeId: "trade_partner" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit, cursor },
      traversal: { maxDepth: 0, resultLimit: 25 },
    },
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
    organisationId: "organisation_planned",
    merchantId: "merchant_planned",
    watermark: { kind: "commerce_native", merchantRevision: 1 },
    capabilities: {
      kind: "commerce_custom",
      entityTypeId: "trade_partner",
      publishedRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    },
  });
}

function exactRequest(): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    ...pageRequest(null, 1),
    query: {
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_b",
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    },
  });
}

function searchRequest(text: string): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    ...pageRequest(null, 10),
    query: {
      kind: "search",
      text,
      entityTypeId: { origin: "custom", typeId: "trade_partner" },
      pagination: { limit: 10, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 25 },
    },
  });
}

function countRequest(): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    ...pageRequest(null, 1),
    query: {
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
      },
      aggregation: { kind: "count" },
      filter: { kind: "all" },
    },
  });
}

function listRequest(
  cursor: string | null,
  limit: number,
): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    ...pageRequest(null, 1),
    query: {
      kind: "commerce_list_page",
      listId: "partner_list",
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit, cursor },
    },
    capabilities: {
      kind: "commerce_list",
      listId: "partner_list",
      listRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    },
  });
}

function listCountRequest(): CommerceGraphQueryPlanRequest {
  return parseCommerceGraphQueryPlanRequest({
    ...listRequest(null, 1),
    query: {
      kind: "aggregation",
      source: { kind: "commerce_list", listId: "partner_list" },
      aggregation: { kind: "count" },
      filter: { kind: "all" },
    },
  });
}

function decodeCursor(cursor: string) {
  const decoded = decodeCommerceCursor(cursor as CommerceCursor);
  if (!decoded.ok) throw new Error("Lexicon cursor decode failed");
  return decoded.value;
}

function encodeCursor(payload: unknown): string {
  return encodeCommerceCursor(
    parseCommerceCursorPayload(
      JSON.parse(JSON.stringify(payload, serializeWasmValue)),
    ),
  );
}

function serializeWasmValue(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || BigInt(number) !== value)
    throw new Error("Wasm integer exceeds safe range");
  return number;
}
