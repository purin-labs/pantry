// The real-store corpus of Platform's entity-plane parity test: four orders,
// three shipments and two production batches as system entities, the export
// coordination preset, a restricted order extension value, two custom
// entities, two custom relationships and three export list entries. The rows
// are written directly, as the parity test always did, because no public
// route creates hand-made relation rows with exact ids and timestamps.
import { NORMALIZED_CONFORMANCE_ROWS } from "@purin-labs/commerce-query-sqlite/normalized-conformance";
import { parseRelationshipId } from "@purin-labs/commerce-client";
import type { CustomEntityTypeRevision } from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../../src/database.ts";
import { initializeCommerceEntityRelation } from "../../src/entity-plane/commerce-entity-relation.ts";
import { refreshCommerceRelationshipRelation } from "../../src/entity-plane/commerce-relationship-relation.ts";
import {
  createSystemExtensionSchema,
  publishSystemExtensionSchema,
  writeCustomEntity,
} from "../../src/entity-plane/entities.ts";
import {
  parseAttributeAssignment,
  parseAttributeDefinition,
  parseEntityRef,
  parsePositiveRevision,
} from "../../src/entity-plane/parsers.ts";
import { EXPORT_COORDINATION_PRESET } from "../../src/entity-plane/presets.ts";
import { writeCommerceEntityRelationText } from "../../src/entity-plane/relation-text.ts";
import { writeRelationship } from "../../src/entity-plane/relationships.ts";
import { EntityPlaneService } from "../../src/entity-plane/service.ts";

export function seedEntityPlaneParityCorpus(
  database: CommerceDatabase,
  scope: Readonly<{ organisationId: string; merchantId: string; now: () => string }>,
): Readonly<{ merchantRevision: number; entityCounts: readonly Readonly<{ entityType: string; count: number }>[] }> {
  const now = scope.now();
  seedSystemRecords(database, scope.merchantId, scope.organisationId, now);
  const service = new EntityPlaneService({
    database,
    now: scope.now,
    signer: { keyId: "parity", publicKeyB64: "parity", sign: () => "parity" },
  });
  service.seedExportCoordinationPreset(scope.merchantId);
  seedEntityPlaneRecords(database, service, scope.merchantId, now);
  const merchant = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get<{ revision: number }>(scope.merchantId);
  if (merchant === undefined) throw new Error("Parity merchant is missing after seeding");
  return {
    merchantRevision: merchant.revision,
    entityCounts: database
      .prepare(
        `SELECT entity_type AS entityType, COUNT(*) AS count
         FROM commerce_entity
         WHERE merchant_id = ? AND entity_origin = 'system'
         GROUP BY entity_type
         ORDER BY entity_type`,
      )
      .all<Readonly<{ entityType: string; count: number }>>(scope.merchantId),
  };
}

function seedSystemRecords(
  database: CommerceDatabase,
  merchantId: string,
  organisationId: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    )
    .run(merchantId, organisationId, now, now);
  database
    .prepare(
      `INSERT INTO sales_channel (merchant_id, resource_id, revision, name, kind, lifecycle_state, lifecycle_json, occurred_at)
     VALUES (?, 'parity_sales', 1, 'Parity', 'online', 'active', '{}', ?)`,
    )
    .run(merchantId, now);
  for (const row of NORMALIZED_CONFORMANCE_ROWS.filter(
    (entry) => entry.entityType === "order",
  )) {
    database
      .prepare(
        `INSERT INTO commerce_order (
         merchant_id, resource_id, revision, sales_channel_id, origin_kind,
         buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, 'parity_sales', 'online', 'guest', ?, ?, ?)`,
      )
      .run(
        merchantId,
        row.entityId,
        row.entityId === "order_missing_attribute" ? "cancelled" : "confirmed",
        JSON.stringify({ title: row.displayName }),
        new Date(row.updatedAt).toISOString(),
      );
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "system",
      "order",
      row.entityId,
      1,
      new Date(row.updatedAt).toISOString(),
      row.displayName,
    );
  }
  database
    .prepare(
      `INSERT INTO location (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, 'parity_location', 1, 'Parity', 'warehouse', 'active', '{}', ?)`,
    )
    .run(merchantId, now);
  const actualShipments = [
    ["shipment_export", "order_export", "fulfillment_export"],
    ["shipment_two", "order_tie_b", "fulfillment_two"],
    ["shipment_three", "order_tie_a", "fulfillment_three"],
  ] as const;
  for (const [shipmentId, orderId, fulfillmentId] of actualShipments) {
    const shipmentDisplayName = NORMALIZED_CONFORMANCE_ROWS.find(
      (row) => row.entityId === shipmentId,
    )?.displayName;
    if (shipmentDisplayName === undefined)
      throw new Error(`missing actual shipment display name ${shipmentId}`);
    database
      .prepare(
        `INSERT INTO fulfillment (
         merchant_id, resource_id, revision, order_id, location_id,
         fulfillment_kind, lifecycle_state, fulfillment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'parity_location', 'shipping', 'requested', ?, ?)`,
      )
      .run(
        merchantId,
        fulfillmentId,
        orderId,
        JSON.stringify({ id: fulfillmentId, state: "requested" }),
        now,
      );
    database
      .prepare(
        `INSERT INTO shipment (
         merchant_id, resource_id, revision, order_id, fulfillment_id,
         lifecycle_state, shipment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, ?, 'in_transit', ?, ?)`,
      )
      .run(
        merchantId,
        shipmentId,
        orderId,
        fulfillmentId,
        JSON.stringify({
          id: shipmentId,
          name: shipmentDisplayName,
          state: "in_transit",
        }),
        now,
      );
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "system",
      "shipment",
      shipmentId,
      1,
      now,
      shipmentDisplayName,
    );
  }
  for (const [batchId, shipmentId] of [
    ["production_batch_export", "shipment_export"],
    ["production_batch_two", "shipment_two"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO food_service_resource (
         merchant_id, resource_kind, resource_id, revision,
         lifecycle_state, resource_json
       ) VALUES (?, 'production_batch', ?, 1, 'active', ?)`,
      )
      .run(
        merchantId,
        batchId,
        JSON.stringify({
          id: batchId,
          name: `Production batch ${batchId}`,
          demand: { kind: "shipment", shipmentId },
          occurredAt: now,
        }),
      );
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "system",
      "production_batch",
      batchId,
      1,
      now,
      `Production batch ${batchId}`,
    );
  }
  initializeCommerceEntityRelation(database);
}

function seedEntityPlaneRecords(
  database: CommerceDatabase,
  service: EntityPlaneService,
  merchantId: string,
  now: string,
): void {
  const restrictedDefinition = parseAttributeDefinition({
    id: "ext_restricted_note",
    scope: {
      kind: "merchant_extension",
      entityTypeId: "order",
      schemaRevision: 1,
    },
    label: "Restricted note",
    helpText: null,
    required: false,
    sensitivity: "restricted",
    kind: { kind: "short_text", maxLength: 100 },
    revision: 1,
  });
  createSystemExtensionSchema(
    database,
    merchantId,
    "order",
    1,
    [restrictedDefinition],
    now,
  );
  publishSystemExtensionSchema(database, merchantId, "order", 1, now);
  database
    .prepare(
      `INSERT INTO system_entity_extension_value (
       merchant_id, system_entity_type_id, system_entity_id,
       extension_schema_revision, attribute_id, value_kind, short_text_value
     ) VALUES (?, 'order', 'order_missing_attribute', 1, 'ext_restricted_note', 'short_text', 'private parity note')`,
    )
    .run(merchantId);
  const tradePartner = parseEntityRef({
    origin: "custom",
    typeId: "trade_partner",
    entityId: "trade_partner_東京",
  });
  const exportDocument = parseEntityRef({
    origin: "custom",
    typeId: "export_document",
    entityId: "export_document_é",
  });
  if (tradePartner.origin !== "custom" || exportDocument.origin !== "custom")
    throw new Error("actual parity custom references did not parse");
  writeCustomEntity(
    database,
    merchantId,
    tradePartner,
    parsePositiveRevision<CustomEntityTypeRevision>(
      1,
      "tradePartner.typeRevision",
    ),
    "東京 Trade Partner",
    "internal",
    [
      parseAttributeAssignment({
        attributeId: "legal_name",
        scope: {
          kind: "custom",
          entityTypeId: "trade_partner",
          typeRevision: 1,
        },
        definitionRevision: 1,
        sensitivity: "internal",
        value: { kind: "short_text", value: "東京 Trade Partner" },
      }),
    ],
    now,
  );
  writeCustomEntity(
    database,
    merchantId,
    exportDocument,
    parsePositiveRevision<CustomEntityTypeRevision>(
      1,
      "exportDocument.typeRevision",
    ),
    "Export document é",
    "internal",
    [
      parseAttributeAssignment({
        attributeId: "document_number",
        scope: {
          kind: "custom",
          entityTypeId: "export_document",
          typeRevision: 1,
        },
        definitionRevision: 1,
        sensitivity: "internal",
        value: { kind: "short_text", value: "DOC-É" },
      }),
      parseAttributeAssignment({
        attributeId: "document_type",
        scope: {
          kind: "custom",
          entityTypeId: "export_document",
          typeRevision: 1,
        },
        definitionRevision: 1,
        sensitivity: "internal",
        value: { kind: "status", value: "commercial_invoice" },
      }),
    ],
    now,
  );
  const definitions = service.listRelationshipDefinitions(merchantId);
  const tradeDefinition = definitions.find(
    (definition) =>
      definition.origin === "custom" &&
      definition.definitionId === "trade_partner_order",
  );
  const documentDefinition = definitions.find(
    (definition) =>
      definition.origin === "custom" &&
      definition.definitionId === "shipment_export_document",
  );
  if (
    tradeDefinition === undefined ||
    tradeDefinition.origin !== "custom" ||
    documentDefinition === undefined ||
    documentDefinition.origin !== "custom"
  )
    throw new Error("actual parity relationship definitions are missing");
  writeRelationship(
    database,
    merchantId,
    parseRelationshipId("trade_partner_orders"),
    tradeDefinition,
    tradePartner,
    parseEntityRef({
      origin: "system",
      typeId: "order",
      entityId: "order_export",
    }),
    now,
  );
  writeRelationship(
    database,
    merchantId,
    parseRelationshipId("shipment_export_document"),
    documentDefinition,
    parseEntityRef({
      origin: "system",
      typeId: "shipment",
      entityId: "shipment_export",
    }),
    exportDocument,
    now,
  );
  const exportList = EXPORT_COORDINATION_PRESET.lists.find(
    (list) => list.listId === "export_coordination",
  );
  if (exportList === undefined)
    throw new Error("actual parity export list is missing");
  for (const [entryId, entityId, dueAt] of [
    ["entry_shipment_export", "shipment_export", "2026-08-25T00:00:00.000Z"],
    ["entry_shipment_two", "shipment_two", "2026-08-26T00:00:00.000Z"],
    ["entry_shipment_three", "shipment_three", "2026-08-27T00:00:00.000Z"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO commerce_list_entry (
         merchant_id, entry_id, list_id, list_revision, membership_kind,
         entity_origin, entity_type_id, entity_id, revision,
         lifecycle_state, created_at, updated_at, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'unique_entity', 'system', 'shipment', ?, 1, 'active', ?, ?, ?)`,
      )
      .run(
        merchantId,
        entryId,
        exportList.listId,
        exportList.publishedRevision,
        entityId,
        now,
        now,
        Date.parse(now),
      );
    const values: readonly [string, string, string | number][] = [
      ["stage", "status", "in_transit"],
      [
        "owner",
        "merchant_operator_reference",
        JSON.stringify({
          principalId: "operator_parity",
          displayName: "Parity operator",
        }),
      ],
      ["due_at", "timestamp", dueAt],
      ["priority", "status", "normal"],
      ["exception_reason", "long_text", "No exception"],
    ];
    for (const [attributeId, valueKind, value] of values) {
      database
        .prepare(
          `INSERT INTO commerce_list_entry_attribute_value (
           merchant_id, entry_id, entry_revision, attribute_id,
           definition_revision, value_kind,
           short_text_value, long_text_value, integer_value, decimal_value,
           boolean_value, date_value, timestamp_value, status_value, choice_value,
           money_amount_minor, money_currency,
           merchant_operator_reference_value, external_resource_reference_value
         ) VALUES (?, ?, 1, ?, 1, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(
          merchantId,
          entryId,
          attributeId,
          valueKind,
          valueKind === "long_text" ? value : null,
          valueKind === "timestamp" ? value : null,
          valueKind === "status" ? value : null,
          valueKind === "merchant_operator_reference" ? value : null,
        );
    }
  }
  refreshCommerceRelationshipRelation(database, merchantId);
}
