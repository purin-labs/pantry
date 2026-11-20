import { describe, expect, it } from "vitest";
import type {
  CommerceCursorBoundary,
  CommerceQueryPlan,
} from "@purin-labs/commerce-contracts";
import { compileCommerceQuerySql } from "@purin-labs/commerce-query-sqlite";
import { planCommerceGraphQuery } from "@purin-labs/commerce-contracts/query-planner";
import { encodeCommerceCursor } from "@purin-labs/commerce-contracts/query-encoders";
import { parseCommerceCursorPayload } from "@purin-labs/commerce-contracts/cursor-payload";
import type { ContractDecodeResult } from "@purin-labs/contract-schema";
import { parseCommerceQueryPlanOutcome } from "@purin-labs/commerce-client";

import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import {
  initializeCommerceEntityRelation,
  readValidatedPlan,
} from "../src/entity-plane/commerce-entity-relation.ts";
import { refreshCommerceAttributeRelation } from "../src/entity-plane/commerce-attribute-relation.ts";
import { parseCustomEntityTypeDraft } from "../src/entity-plane/parsers.ts";
import { writeCommerceEntityRelationText } from "../src/entity-plane/relation-text.ts";

const NOW = "2026-08-26T00:00:00.123Z";

describe("Underclerk commerce_entity relation", () => {
  it("materializes canonical lifecycle and low-stock attributes for system entities", () => {
    const database = new NodeCommerceDatabase(":memory:");
    initializeCommerceSchema(database, NOW);
    database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
      )
      .run("merchant_attributes", "organisation_attributes", NOW, NOW);
    database
      .prepare(
        `INSERT INTO sales_channel (
         merchant_id, resource_id, revision, name, kind,
         lifecycle_state, lifecycle_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'online', 'active', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "channel_attributes",
        "Online",
        '{"state":"active"}',
        NOW,
      );
    database
      .prepare(
        `INSERT INTO location (
         merchant_id, resource_id, revision, name, kind,
         lifecycle_state, lifecycle_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'warehouse', 'active', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "location_attributes",
        "Warehouse",
        '{"state":"active"}',
        NOW,
      );
    database
      .prepare(
        `INSERT INTO commerce_order (
         merchant_id, resource_id, revision, sales_channel_id, origin_kind,
         buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'online', 'guest', 'confirmed', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "order_attributes",
        "channel_attributes",
        '{"membership":"unique_entity"}',
        NOW,
      );
    database
      .prepare(
        `INSERT INTO payment (
         merchant_id, resource_id, revision, order_id, amount_minor,
         currency, lifecycle_state, payment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, 100, 'JPY', 'failed', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "payment_attributes",
        "order_attributes",
        JSON.stringify({
          id: "payment_attributes",
          revision: 1,
          orderId: "order_attributes",
          amount: { amountMinor: 100, currency: "JPY" },
          lifecycle: {
            state: "failed",
            failedAt: NOW,
            reason: "Card declined",
          },
          occurredAt: NOW,
        }),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO fulfillment (
         merchant_id, resource_id, revision, order_id, location_id,
         fulfillment_kind, lifecycle_state, fulfillment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, ?, 'shipping', 'requested', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "fulfillment_attributes",
        "order_attributes",
        "location_attributes",
        '{"membership":"unique_entity"}',
        NOW,
      );
    database
      .prepare(
        `INSERT INTO shipment (
         merchant_id, resource_id, revision, order_id, fulfillment_id,
         lifecycle_state, shipment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, ?, 'delivery_exception', ?, ?)`,
      )
      .run(
        "merchant_attributes",
        "shipment_attributes",
        "order_attributes",
        "fulfillment_attributes",
        '{"membership":"unique_entity"}',
        NOW,
      );
    database
      .prepare(
        `INSERT INTO inventory_item (
         merchant_id, inventory_item_id, revision, merchant_code, name,
         base_unit, category, tracking_kind, expiry_policy, lifecycle, occurred_at
       ) VALUES (?, ?, 1, 'ITEM', 'Item', 'gram', 'ingredient', 'aggregate', NULL, 'active', ?)`,
      )
      .run("merchant_attributes", "item_attributes", NOW);
    database
      .prepare(
        `INSERT INTO inventory_position (
         merchant_id, inventory_position_id, inventory_item_id, location_id,
         revision, balance_kind, on_hand_amount, allocated_amount, available_amount,
         quantity_scale, quantity_unit, observed_at
       ) VALUES (?, ?, ?, ?, 1, 'accounted', 5, 0, 5, 0, 'gram', ?)`,
      )
      .run(
        "merchant_attributes",
        "position_attributes",
        "item_attributes",
        "location_attributes",
        NOW,
      );
    const stockPolicy = JSON.stringify({
      provenance: {
        organisationId: "organisation_attributes",
        integrationAccountId: "underclerk",
        source: "underclerk",
        resourceType: "stock_policy",
        resourceId: "stock_policy_attributes",
        revision: 1,
        occurredAt: NOW,
        observedAt: NOW,
      },
      stockPolicyId: "stock_policy_attributes",
      inventoryItemId: "item_attributes",
      locationId: "location_attributes",
      revision: 1,
      replenishment: {
        kind: "threshold",
        reorderPoint: { amount: 10, scale: 0, unit: "gram" },
        targetQuantity: { amount: 20, scale: 0, unit: "gram" },
      },
      lifecycle: "active",
    });
    database
      .prepare(
        `INSERT INTO food_service_resource (
         merchant_id, resource_kind, resource_id, revision,
         lifecycle_state, resource_json
       ) VALUES (?, 'stock_policy', ?, 1, 'active', ?)`,
      )
      .run("merchant_attributes", "stock_policy_attributes", stockPolicy);
    for (const row of [
      ["order", "order_attributes", "Order"],
      ["payment", "payment_attributes", "Payment"],
      ["fulfillment", "fulfillment_attributes", "Fulfillment"],
      ["shipment", "shipment_attributes", "Shipment"],
      ["stock_policy", "stock_policy_attributes", "Stock policy"],
    ] as const) {
      writeCommerceEntityRelationText(
        database,
        "merchant_attributes",
        "system",
        row[0],
        row[1],
        1,
        NOW,
        row[2],
      );
    }
    initializeCommerceEntityRelation(database);
    refreshCommerceAttributeRelation(database, "merchant_attributes");
    const attributes = database
      .prepare(
        `SELECT entity_type AS entityType, entity_id AS entityId,
              attribute_id AS attributeId, value_kind AS valueKind,
              comparable_text AS comparableText, comparable_boolean AS comparableBoolean
         FROM commerce_entity_attribute_relation
        WHERE merchant_id = ?
        ORDER BY entity_type, entity_id, attribute_id`,
      )
      .all<
        Readonly<{
          entityType: string;
          entityId: string;
          attributeId: string;
          valueKind: string;
          comparableText: string | null;
          comparableBoolean: number | null;
        }>
      >("merchant_attributes");
    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "order",
          entityId: "order_attributes",
          attributeId: "lifecycle",
          valueKind: "status",
          comparableText: "confirmed",
        }),
        expect.objectContaining({
          entityType: "payment",
          entityId: "payment_attributes",
          attributeId: "lifecycle",
          valueKind: "status",
          comparableText: "failed",
        }),
        expect.objectContaining({
          entityType: "shipment",
          entityId: "shipment_attributes",
          attributeId: "lifecycle",
          valueKind: "status",
          comparableText: "delivery_exception",
        }),
        expect.objectContaining({
          entityType: "stock_policy",
          entityId: "stock_policy_attributes",
          attributeId: "lifecycle",
          valueKind: "status",
          comparableText: "active",
        }),
        expect.objectContaining({
          entityType: "stock_policy",
          entityId: "stock_policy_attributes",
          attributeId: "low_stock",
          valueKind: "boolean",
          comparableBoolean: 1,
        }),
      ]),
    );
    const lowStockPlan = lexiconPlan(
      {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "stock_policy" },
        filter: {
          kind: "attribute",
          filter: {
            operator: "equals",
            attributeId: "low_stock",
            value: { kind: "boolean", value: true },
          },
        },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 10 },
      },
      { source: "system", systemEntityKind: "stock_policy" },
    );
    const lowStock = readValidatedPlan(
      database,
      "merchant_attributes",
      lowStockPlan,
    );
    expect(lowStock.kind).toBe("rows");
    if (lowStock.kind === "rows")
      expect(lowStock.rows.map((row) => row.entityId)).toEqual([
        "stock_policy_attributes",
      ]);
    database.close();
  });

  it("returns canonical and custom values with truthful page metadata", () => {
    const database = new NodeCommerceDatabase(":memory:");
    initializeCommerceSchema(database, NOW);
    database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
      )
      .run("merchant_relation", "organisation_relation", NOW, NOW);
    database
      .prepare(
        `INSERT INTO location (
         merchant_id, resource_id, revision, name, kind, lifecycle_state,
         lifecycle_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'store', 'active', ?, ?)`,
      )
      .run("merchant_relation", "location_relation", "Main Store", "{}", NOW);
    writeCommerceEntityRelationText(
      database,
      "merchant_relation",
      "system",
      "location",
      "location_relation",
      1,
      NOW,
      "Main Store",
    );

    const type = parseCustomEntityTypeDraft({
      typeId: "trade_partner",
      label: "Trade partner",
      description: "Relation test type",
      attributes: [],
    });
    database
      .prepare(
        `INSERT INTO custom_entity_type (
         merchant_id, entity_type_id, revision, lifecycle_state,
         definition_json, created_at, updated_at
       ) VALUES (?, ?, 1, 'published', ?, ?, ?)`,
      )
      .run("merchant_relation", type.typeId, JSON.stringify(type), NOW, NOW);
    database
      .prepare(
        `INSERT INTO custom_entity_type_head (
         merchant_id, entity_type_id, current_revision, published_revision,
         lifecycle_state, updated_at
       ) VALUES (?, ?, 1, 1, 'published', ?)`,
      )
      .run("merchant_relation", type.typeId, NOW);
    database
      .prepare(
        `INSERT INTO custom_entity (
         merchant_id, entity_id, entity_type_id, entity_type_revision,
         revision, lifecycle_state, display_name,
         sensitivity, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, 'active', ?, 'internal', ?, ?)`,
      )
      .run(
        "merchant_relation",
        "partner_relation",
        type.typeId,
        "Relation Partner",
        NOW,
        NOW,
      );
    writeCommerceEntityRelationText(
      database,
      "merchant_relation",
      "custom",
      type.typeId,
      "partner_relation",
      1,
      NOW,
      "Relation Partner",
    );
    database
      .prepare(
        `INSERT INTO custom_entity (
         merchant_id, entity_id, entity_type_id, entity_type_revision,
         revision, lifecycle_state, display_name,
         sensitivity, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, 'active', ?, 'internal', ?, ?)`,
      )
      .run(
        "merchant_relation",
        "partner_a",
        type.typeId,
        "A Partner",
        NOW,
        NOW,
      );
    writeCommerceEntityRelationText(
      database,
      "merchant_relation",
      "custom",
      type.typeId,
      "partner_a",
      1,
      NOW,
      "A Partner",
    );
    database
      .prepare(
        `INSERT INTO custom_entity (
         merchant_id, entity_id, entity_type_id, entity_type_revision,
         revision, lifecycle_state, display_name,
         sensitivity, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, 'active', ?, 'internal', ?, ?)`,
      )
      .run(
        "merchant_relation",
        "partner_b",
        type.typeId,
        "B Partner",
        NOW,
        NOW,
      );
    writeCommerceEntityRelationText(
      database,
      "merchant_relation",
      "custom",
      type.typeId,
      "partner_b",
      1,
      NOW,
      "B Partner",
    );
    initializeCommerceEntityRelation(database);

    const exactRows = database
      .prepare(
        `SELECT merchant_id, entity_origin, entity_type, entity_id, revision,
              updated_at, display_name, display_name_folded, payload_json
       FROM commerce_entity
       WHERE merchant_id = ? AND entity_type = ?
       ORDER BY updated_at, entity_id`,
      )
      .all<Readonly<Record<string, unknown>>>(
        "merchant_relation",
        "trade_partner",
      );
    expect(exactRows.map((row) => row.entity_id)).toEqual([
      "partner_a",
      "partner_b",
      "partner_relation",
    ]);
    expect(exactRows.every((row) => row.updated_at === Date.parse(NOW))).toBe(
      true,
    );
    const systemPlan = lexiconPlan(
      {
        kind: "entity_by_ref",
        reference: wasmEntityReference(
          "system",
          "location",
          "location_relation",
        ),
        traversal: { maxDepth: 0, resultLimit: 1 },
      },
      { source: "system", systemEntityKind: "location" },
    );
    const system = runCompiled(database, "merchant_relation", systemPlan);
    expect(system.rows).toEqual([
      expect.objectContaining({
        merchant_id: "merchant_relation",
        entity_origin: "system",
        entity_type: "location",
        entity_id: "location_relation",
        display_name: "Main Store",
        payload_json: null,
      }),
    ]);
    expect(system.rows[0]?.updated_at).toBe(Date.parse(NOW));
    expect(
      explainDetails(database, system.sql, system.bindings),
    ).not.toContainEqual(expect.stringContaining("TEMP B-TREE"));

    const customPlan = lexiconPlan(
      {
        kind: "entity_by_ref",
        reference: wasmEntityReference(
          "custom",
          type.typeId,
          "partner_relation",
        ),
        traversal: { maxDepth: 0, resultLimit: 1 },
      },
      { source: "custom", customEntityTypeId: type.typeId },
    );
    const custom = runCompiled(database, "merchant_relation", customPlan);
    expect(custom.rows).toEqual([
      expect.objectContaining({
        merchant_id: "merchant_relation",
        entity_origin: "custom",
        entity_type: "trade_partner",
        entity_id: "partner_relation",
        display_name: "Relation Partner",
        payload_json: null,
      }),
    ]);
    expect(
      explainDetails(database, custom.sql, custom.bindings),
    ).not.toContainEqual(expect.stringContaining("TEMP B-TREE"));

    const firstPagePlan = lexiconPlan(
      {
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: type.typeId },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 2, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 25 },
      },
      { source: "custom", customEntityTypeId: type.typeId },
    );
    expect(firstPagePlan.effectiveOrdering.leadingKeys).toEqual([
      {
        direction: "descending",
        field: { kind: "updated_at" },
        nulls: "last",
      },
    ]);
    expect(systemPlan.effectiveOrdering.leadingKeys).toEqual([]);

    const firstPage = readValidatedPlan(
      database,
      "merchant_relation",
      firstPagePlan,
    );
    expect(firstPage.kind).toBe("rows");
    if (firstPage.kind !== "rows") return;
    expect(firstPage.rows.map((row) => row.entityId)).toEqual([
      "partner_a",
      "partner_b",
    ]);
    expect(firstPage.execution).toMatchObject({
      kind: "page",
      requestedLimit: 2,
      fetchedRowCount: 3,
      retainedRowCount: 2,
      hasMore: true,
    });
    expect(
      firstPage.execution.kind === "page"
        ? firstPage.execution.nextBoundary
        : null,
    ).toEqual({
      entityRef: {
        origin: "custom",
        typeId: type.typeId,
        entityId: "partner_b",
      },
      orderingValues: [{ kind: "integer", value: BigInt(Date.parse(NOW)) }],
    });
    const pageCompiled = compileCommerceQuerySql({
      ownerId: "merchant_relation",
      plan: firstPagePlan,
    });
    if (pageCompiled.kind !== "compiled")
      throw new Error("custom page plan did not compile");
    expect(
      explainDetails(
        database,
        pageCompiled.statement.sql,
        pageCompiled.statement.bindings.map(toNumberBinding),
      ),
    ).toContainEqual(
      expect.stringContaining(
        "commerce_entity_relation_index_presentation_idx",
      ),
    );

    const continuationCursor = lexiconCursor(
      firstPagePlan,
      firstPage.execution.nextBoundary,
    );
    const continuationPlan = lexiconPlan(
      {
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: type.typeId },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 2, cursor: continuationCursor },
        traversal: { maxDepth: 0, resultLimit: 25 },
      },
      { source: "custom", customEntityTypeId: type.typeId },
    );
    const continuation = readValidatedPlan(
      database,
      "merchant_relation",
      continuationPlan,
    );
    expect(continuation.kind).toBe("rows");
    if (continuation.kind !== "rows") return;
    expect(continuation.rows.map((row) => row.entityId)).toEqual([
      "partner_relation",
    ]);
    expect(continuation.execution).toMatchObject({
      kind: "page",
      fetchedRowCount: 1,
      retainedRowCount: 1,
      hasMore: false,
      nextBoundary: null,
    });

    const finalReference = continuation.rows[0]?.reference;
    if (finalReference === undefined)
      throw new Error("continuation did not return the final relation row");
    const emptyCursor = lexiconCursor(firstPagePlan, {
      entityRef: finalReference,
      orderingValues: [{ kind: "integer", value: BigInt(Date.parse(NOW)) }],
    });
    const emptyPlan = lexiconPlan(
      {
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: type.typeId },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 2, cursor: emptyCursor },
        traversal: { maxDepth: 0, resultLimit: 25 },
      },
      { source: "custom", customEntityTypeId: type.typeId },
    );
    const empty = readValidatedPlan(database, "merchant_relation", emptyPlan);
    expect(empty).toEqual({
      kind: "rows",
      rows: [],
      execution: expect.objectContaining({
        kind: "page",
        requestedLimit: 2,
        fetchedRowCount: 0,
        retainedRowCount: 0,
        hasMore: false,
        nextBoundary: null,
      }),
    });
    database.close();
  });

  it("executes Commerce List relationship membership predicates for pages and counts", () => {
    const database = new NodeCommerceDatabase(":memory:");
    initializeCommerceSchema(database, NOW);
    database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
      )
      .run(
        "merchant_list_relationship",
        "organisation_list_relationship",
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO commerce_list (
         merchant_id, list_id, entity_type_id, revision, lifecycle_state,
         name, definition_json, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'published', ?, ?, ?, ?)`,
      )
      .run(
        "merchant_list_relationship",
        "export_coordination",
        "order",
        "Export coordination",
        '{"membership":"unique_entity"}',
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO commerce_list_head (
         merchant_id, list_id, current_revision, published_revision,
         lifecycle_state, updated_at
       ) VALUES (?, ?, 1, 1, 'published', ?)`,
      )
      .run("merchant_list_relationship", "export_coordination", NOW);
    const updatedAt = Date.parse(NOW);
    for (const [entryId, entityId] of [
      ["entry_order_1", "order_1"],
      ["entry_order_2", "order_2"],
    ] as const) {
      database
        .prepare(
          `INSERT INTO commerce_list_entry (
           merchant_id, entry_id, list_id, list_revision, entity_origin,
           entity_type_id, entity_id, revision, lifecycle_state, created_at,
           updated_at, updated_at_ms, membership_kind
       ) VALUES (?, ?, ?, 1, 'system', 'order', ?, 1, 'active', ?, ?, ?, 'unique_entity')`,
        )
        .run(
          "merchant_list_relationship",
          entryId,
          "export_coordination",
          entityId,
          NOW,
          NOW,
          updatedAt,
        );
    }
    database
      .prepare(
        `INSERT INTO commerce_relationship_relation (
         merchant_id, relationship_origin, relationship_id, relationship_revision,
         definition_origin, definition_id, definition_revision, sensitivity,
         source_origin, source_type_id, source_entity_id,
         target_origin, target_type_id, target_entity_id, payload_json, provenance_json
       ) VALUES (?, 'system', ?, 1, 'system', 'order_shipment', 1, 'internal',
                 'system', 'order', ?, 'system', 'shipment', 'shipment_1', '{}', '{}')`,
      )
      .run(
        "merchant_list_relationship",
        "system:order_shipment:order_1:shipment_1",
        "order_1",
      );
    initializeCommerceEntityRelation(database);

    const filter = {
      kind: "relationship" as const,
      filter: {
        operator: "exists" as const,
        relationshipDefinition: {
          origin: "system" as const,
          definitionId: "order_shipment",
          revision: 1,
        },
      },
    };
    const pagePlan = lexiconPlan(
      {
        kind: "commerce_list_page",
        listId: "export_coordination",
        filter,
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
      { source: "list" },
    );
    const page = readValidatedPlan(
      database,
      "merchant_list_relationship",
      pagePlan,
    );
    expect(page.kind).toBe("list_rows");
    if (page.kind === "list_rows")
      expect(page.rows.map((row) => row.entityId)).toEqual(["order_1"]);

    const countPlan = lexiconPlan(
      {
        kind: "aggregation",
        source: { kind: "commerce_list", listId: "export_coordination" },
        aggregation: { kind: "count" },
        filter,
      },
      { source: "list" },
    );
    expect(
      readValidatedPlan(database, "merchant_list_relationship", countPlan),
    ).toEqual({ kind: "count", value: 1 });
    database.close();
  });
});

type LexiconPlanOptions =
  | Readonly<{
      source: "system";
      systemEntityKind:
        | "location"
        | "order"
        | "payment"
        | "fulfillment"
        | "shipment"
        | "stock_policy";
      customEntityTypeId?: never;
    }>
  | Readonly<{
      source: "custom";
      customEntityTypeId: string;
      systemEntityKind?: never;
    }>
  | Readonly<{
      source: "list";
      systemEntityKind?: never;
      customEntityTypeId?: never;
    }>;

function lexiconPlan(
  query: unknown,
  options: LexiconPlanOptions,
): CommerceQueryPlan {
  const capabilities =
    options.source === "custom"
      ? {
          kind: "underclerk_custom",
          entityTypeId: options.customEntityTypeId,
          publishedRevision: 1,
          capability: {
            filterableAttributeIds: [],
            sortableAttributeIds: [],
            aggregation: { kind: "count_only" },
          },
        }
      : options.source === "list"
        ? {
            kind: "commerce_list",
            listId: "export_coordination",
            listRevision: 1,
            capability: {
              filterableAttributeIds: [],
              sortableAttributeIds: [],
              aggregation: { kind: "count_only" },
            },
          }
        : {
            kind: "system_mapped",
            systemEntityKind: options.systemEntityKind,
            systemSchemaRevision: 1,
            capability: {
              filterableAttributeIds: ["lifecycle", "low_stock"],
              sortableAttributeIds: ["lifecycle"],
              aggregation: { kind: "count_only" },
            },
          };
  const response = plannedValue(
    planCommerceGraphQuery(
      jsonValue(
        JSON.stringify({
          query,
          semantics: {
            semanticsVersion: "v1",
            orderingVersion: "v1",
            textNormalization: "commerce_unicode_v1",
            nullPlacement: "last",
          },
          projection: {
            attributeIds: [],
            relationshipDefinitions: [],
            includeProvenance: false,
            includeFreshness: false,
          },
          organisationId: "organisation_relation",
          merchantId: "merchant_relation",
          watermark: { kind: "underclerk_native", merchantRevision: 1 },
          capabilities,
        }),
      ),
    ),
  );
  const outcome = parseCommerceQueryPlanOutcome(response.value);
  if (outcome.kind !== "planned")
    throw new Error(`Lexicon planner did not produce a plan: ${outcome.kind}`);
  return outcome.plan;
}

function lexiconCursor(
  plan: CommerceQueryPlan,
  boundary: CommerceCursorBoundary | null,
): string {
  if (boundary === null)
    throw new Error("cursor boundary is required for a continuation");
  const response = cursorValue(
    encodedCursor(
      jsonValue(
        JSON.stringify(
          {
            organisationId: "organisation_relation",
            merchantId: "merchant_relation",
            queryFingerprint: plan.queryFingerprint,
            semanticsVersion: plan.semanticsVersion,
            orderingVersion: plan.orderingVersion,
            effectiveOrdering: plan.effectiveOrdering,
            boundary,
            watermark: plan.watermark,
          },
          serializeWasmValue,
        ),
      ),
    ),
  );
  if (typeof response.value !== "string")
    throw new Error("Lexicon cursor encoder did not return a cursor");
  return response.value;
}

function wasmEntityReference(
  origin: "system" | "custom",
  typeId: string,
  entityId: string,
): Record<string, unknown> {
  return { origin, typeId, entityId };
}

function jsonValue(text: string): unknown {
  return JSON.parse(text);
}

function plannedValue(result: ContractDecodeResult<unknown>): {
  value: unknown;
} {
  if (!result.ok)
    throw new Error(`Lexicon planner refused: ${result.error.code}`);
  return { value: result.value };
}

function encodedCursor(payload: unknown): string {
  const parsed = parseCommerceCursorPayload(payload);
  if (!parsed.ok)
    throw new Error(`Lexicon cursor payload refused: ${parsed.error.code}`);
  return encodeCommerceCursor(parsed.value);
}

function cursorValue(cursor: string): { value: unknown } {
  return { value: cursor };
}

function toNumberBinding(
  value: string | number | bigint | null,
): string | number | null {
  return typeof value === "bigint" ? Number(value) : value;
}

function serializeWasmValue(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || BigInt(number) !== value)
    throw new Error("Wasm JSON integer exceeds the safe range");
  return number;
}

type CompiledRows = Readonly<{
  sql: string;
  bindings: readonly (string | number | null)[];
  rows: readonly Readonly<Record<string, unknown>>[];
}>;

function runCompiled(
  database: NodeCommerceDatabase,
  ownerId: string,
  plan: CommerceQueryPlan,
): CompiledRows {
  const result = compileCommerceQuerySql({ ownerId, plan });
  if (result.kind !== "compiled")
    throw new Error(`compiler unexpectedly returned ${result.capability.kind}`);
  const bindings = result.statement.bindings.map((value) =>
    typeof value === "bigint" ? Number(value) : value,
  );
  return {
    sql: result.statement.sql,
    bindings,
    rows: database
      .prepare(result.statement.sql)
      .all<Record<string, unknown>>(...bindings),
  };
}

function explainDetails(
  database: NodeCommerceDatabase,
  sql: string,
  bindings: readonly (string | number | null)[],
): readonly string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all<Readonly<{ detail: string }>>(...bindings)
    .map((row) => row.detail);
}
