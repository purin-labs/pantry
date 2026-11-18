

import {
  NORMALIZED_CONFORMANCE_CASES,
  NORMALIZED_CONFORMANCE_EDGES,
  NORMALIZED_CONFORMANCE_LIFECYCLE_IDS,
  NORMALIZED_CONFORMANCE_ROWS,
  normalizedConformancePlanInput,
} from "@seams/commerce-query-sqlite/normalized-conformance";
import { parseCommerceGraphQuery } from "@seams/commerce-client";
import type { CommerceQueryPlan } from "@seams/commerce-contracts";
import { planCommerceGraphQuery } from "@seams/commerce-contracts/query-planner";
import { expect, it } from "vitest";

import { initializeCommerceEntityRelation, readValidatedPlan } from "../src/entity-plane/commerce-entity-relation.ts";
import { writeCommerceEntityRelationText } from "../src/entity-plane/relation-text.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const ORGANISATION_ID = "organisation_normalized_conformance";
const MERCHANT_ID = "merchant_normalized_parity";

it.each(NORMALIZED_CONFORMANCE_CASES)("returns the expected ids for the $name case", (conformanceCase) => {
  const database = createConformanceStore();
  try {
    const plan = lexiconPlan(
      conformanceCase.query,
      conformanceCase.sortableAttributeIds,
      conformanceCase.filterableAttributeIds,
    );
    const result = readValidatedPlan(database, MERCHANT_ID, plan);
    if (conformanceCase.expected.kind === "count") {
      expect(result).toEqual({ kind: "count", value: conformanceCase.expected.value });
      return;
    }
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") return;
    expect(result.rows.map((row) => row.entityId)).toEqual(conformanceCase.expected.ids);
  } finally {
    database.close();
  }
});

function createConformanceStore(): NodeCommerceDatabase {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    )
    .run(MERCHANT_ID, ORGANISATION_ID, NOW, NOW);
  for (const row of NORMALIZED_CONFORMANCE_ROWS)
    writeCommerceEntityRelationText(
      database,
      MERCHANT_ID,
      "system",
      row.entityType,
      row.entityId,
      1,
      new Date(row.updatedAt).toISOString(),
      row.displayName,
    );
  initializeCommerceEntityRelation(database);
  for (const [index, [sourceId, targetId]] of NORMALIZED_CONFORMANCE_EDGES.entries()) {
    const relationshipId = `system:order_shipment:${sourceId}:${targetId}`;
    database
      .prepare(
        `INSERT INTO commerce_relationship_relation (
         merchant_id, relationship_origin, relationship_id, relationship_revision,
         definition_origin, definition_id, definition_revision, sensitivity,
         source_origin, source_type_id, source_entity_id,
         target_origin, target_type_id, target_entity_id, payload_json, provenance_json
       ) VALUES (?, 'system', ?, ?, 'system', 'order_shipment', 1, 'internal', 'system', 'order', ?, 'system', 'shipment', ?, ?, '{}')`,
      )
      .run(
        MERCHANT_ID,
        relationshipId,
        index + 1,
        sourceId,
        targetId,
        JSON.stringify({ relationshipId, relationshipRevision: index + 1 }),
      );
  }
  for (const entityId of NORMALIZED_CONFORMANCE_LIFECYCLE_IDS)
    database
      .prepare(
        `INSERT INTO commerce_entity_attribute_relation_index (
         merchant_id, subject_kind, entity_origin, entity_type, entity_id,
         list_id, entry_id, entity_revision, attribute_id, definition_revision,
         value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
       ) VALUES (?, 'entity', 'system', 'order', ?, '', '', 1, 'lifecycle', 1, 'status', 'open', NULL, NULL, NULL)`,
      )
      .run(MERCHANT_ID, entityId);
  return database;
}

function lexiconPlan(
  query: unknown,
  sortableAttributeIds: readonly string[],
  filterableAttributeIds: readonly string[],
): CommerceQueryPlan {
  const input = normalizedConformancePlanInput(
    parseCommerceGraphQuery(query),
    { organisationId: ORGANISATION_ID, merchantId: MERCHANT_ID },
    sortableAttributeIds,
    filterableAttributeIds,
  );
  const planned = planCommerceGraphQuery(JSON.parse(JSON.stringify(input)));
  if (!planned.ok) throw new Error(`Lexicon planning failed: ${planned.error.code}`);
  const outcome = planned.value;
  if (outcome.kind !== "planned") throw new Error("Conformance query was not planned");
  return outcome.plan;
}
