/**
 * The frozen DDL of the Commerce projection and Commerce query schemas, as the
 * retired steps left it: commerce_projection version 16 and commerce_query
 * version 5. Every live actor is at these versions, because production storage
 * started empty on 2026-10-09 (Refactor 10, step 2, D3). A schema change adds
 * a new step after the baseline; it does not edit this text.
 */
export const COMMERCE_PROJECTION_SCHEMA_V16: readonly string[] = [
  `CREATE TABLE commerce_projection (
      organisation_id TEXT NOT NULL,
      projection_kind TEXT NOT NULL CHECK (
        projection_kind IN (
          'product', 'sellable_variant', 'inventory_item', 'location',
          'sales_channel', 'offer', 'inventory_position', 'inventory_movement',
          'inventory_lot', 'commerce_order',
          'payment', 'fulfillment', 'shipment',
          'menu', 'modifier_group_revision', 'recipe_revision',
          'preparation_station', 'preparation_ticket', 'production_batch',
          'stock_policy'
        )
      ),
      canonical_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      lifecycle TEXT NOT NULL,
      projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      lab_run_id TEXT, validated_at INTEGER CHECK (validated_at IS NULL OR validated_at >= 0),
      PRIMARY KEY (organisation_id, projection_kind, canonical_id)
    )`,
  `CREATE TABLE commerce_event_receipt (
      organisation_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      projection_kind TEXT NOT NULL,
      canonical_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      disposition TEXT NOT NULL CHECK (
        disposition IN ('applied', 'duplicate', 'out_of_order')
      ),
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      occurred_at TEXT NOT NULL,
      processed_at INTEGER NOT NULL CHECK (processed_at >= 0),
      last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= processed_at),
      delivery_count INTEGER NOT NULL CHECK (delivery_count >= 1),
      lab_run_id TEXT, provider_delivery_id TEXT, observation_index INTEGER NOT NULL DEFAULT 0, commerce_system_kind TEXT NOT NULL DEFAULT 'historical' CHECK (commerce_system_kind IN ('historical', 'lab', 'satyr_commerce', 'shopify')), commerce_system_revision INTEGER CHECK (commerce_system_revision IS NULL OR commerce_system_revision >= 1),
      PRIMARY KEY (organisation_id, event_id)
    )`,
  `CREATE TABLE commerce_cue_outbox (
      organisation_id TEXT NOT NULL,
      native_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      fact_json TEXT NOT NULL CHECK (json_valid(fact_json)),
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      enqueued_at INTEGER,
      lab_run_id TEXT,
      PRIMARY KEY (organisation_id, native_id)
    )`,
  `CREATE TABLE commerce_lab_state (
      organisation_id TEXT PRIMARY KEY,
      lab_namespace TEXT NOT NULL CHECK (lab_namespace GLOB 'lab_*'),
      catalog_version TEXT NOT NULL,
      seeded_at INTEGER NOT NULL CHECK (seeded_at >= 0),
      reset_at INTEGER
    )`,
  `CREATE TABLE commerce_delivery_receipt (
      organisation_id TEXT NOT NULL,
      provider_delivery_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      delivery_json TEXT NOT NULL CHECK (json_valid(delivery_json)),
      processed_at INTEGER NOT NULL CHECK (processed_at >= 0),
      last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= processed_at),
      delivery_count INTEGER NOT NULL CHECK (delivery_count >= 1),
      lab_run_id TEXT, commerce_system_kind TEXT NOT NULL DEFAULT 'historical' CHECK (commerce_system_kind IN ('historical', 'lab', 'satyr_commerce', 'shopify')), commerce_system_revision INTEGER CHECK (commerce_system_revision IS NULL OR commerce_system_revision >= 1),
      PRIMARY KEY (organisation_id, provider_delivery_id)
    )`,
  `CREATE TABLE commerce_projection_tombstone (
      organisation_id TEXT NOT NULL,
      projection_kind TEXT NOT NULL CHECK (
      projection_kind IN (
          'product', 'sellable_variant', 'inventory_item', 'location',
          'sales_channel', 'offer', 'inventory_position', 'inventory_movement',
          'inventory_lot', 'commerce_order',
          'payment', 'fulfillment', 'shipment',
          'menu', 'modifier_group_revision', 'recipe_revision',
          'preparation_station', 'preparation_ticket', 'production_batch',
          'stock_policy'
      )
      ),
      canonical_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      lab_run_id TEXT,
      PRIMARY KEY (organisation_id, projection_kind, canonical_id)
    )`,
  `CREATE TABLE commerce_projection_watermark (
      organisation_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      accepted_projection_sequence INTEGER NOT NULL
        CHECK (accepted_projection_sequence >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (organisation_id, integration_account_id)
    ) STRICT`,
  `CREATE TABLE commerce_projection_relation_text (
      organisation_id TEXT NOT NULL,
      projection_kind TEXT NOT NULL,
      canonical_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      display_name_folded TEXT NOT NULL,
      search_text_folded TEXT NOT NULL,
      PRIMARY KEY (organisation_id, projection_kind, canonical_id)
    ) STRICT`,
  `CREATE INDEX commerce_event_receipt_run
    ON commerce_event_receipt (organisation_id, lab_run_id, processed_at)`,
  `CREATE INDEX commerce_cue_outbox_pending
    ON commerce_cue_outbox (organisation_id, state, created_at)`,
  `CREATE INDEX commerce_projection_updated_at
    ON commerce_projection (organisation_id, updated_at DESC, canonical_id)`,
  `CREATE INDEX commerce_observation_receipt_delivery
    ON commerce_event_receipt (
      organisation_id, provider_delivery_id, observation_index
    )`,
  `CREATE INDEX commerce_projection_tombstone_updated_at
    ON commerce_projection_tombstone (organisation_id, updated_at DESC, canonical_id)`,
  `CREATE INDEX commerce_projection_relation_text_display
    ON commerce_projection_relation_text (
      integration_account_id, display_name_folded, canonical_id
    )`,
  `CREATE INDEX commerce_projection_relation_text_search
    ON commerce_projection_relation_text (
      integration_account_id, search_text_folded, canonical_id
    )`,
];

export const COMMERCE_QUERY_SCHEMA_V5: readonly string[] = [
  `CREATE TABLE commerce_relationship_relation_index (
      merchant_id TEXT NOT NULL,
      relationship_origin TEXT NOT NULL CHECK (relationship_origin = 'system'),
      relationship_id TEXT NOT NULL,
      relationship_revision INTEGER NOT NULL CHECK (relationship_revision > 0),
      definition_origin TEXT NOT NULL CHECK (definition_origin = 'system'),
      definition_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
      source_origin TEXT NOT NULL CHECK (source_origin = 'system'),
      source_type_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_origin TEXT NOT NULL CHECK (target_origin = 'system'),
      target_type_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      PRIMARY KEY (merchant_id, relationship_origin, relationship_id)
    ) STRICT`,
  `CREATE TABLE commerce_entity_attribute_relation_index (
      merchant_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entity', 'list_entry')),
      entity_origin TEXT NOT NULL CHECK (entity_origin = 'system'),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      entity_revision INTEGER NOT NULL CHECK (entity_revision > 0),
      attribute_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
      value_kind TEXT NOT NULL,
      comparable_text TEXT,
      comparable_integer INTEGER,
      comparable_real REAL,
      comparable_boolean INTEGER CHECK (comparable_boolean IS NULL OR comparable_boolean IN (0, 1)),
      PRIMARY KEY (
        merchant_id, subject_kind, entity_origin, entity_type, entity_id,
        list_id, entry_id, entity_revision, attribute_id
      )
    ) STRICT`,
  `CREATE INDEX commerce_projection_entity_scan
    ON commerce_projection (
      integration_account_id, canonical_id
    )`,
  `CREATE INDEX commerce_projection_entity_presentation
    ON commerce_projection (
      integration_account_id, updated_at DESC, canonical_id
    )`,
  `CREATE INDEX commerce_relationship_relation_source
    ON commerce_relationship_relation_index (
      merchant_id, definition_origin, definition_id, definition_revision,
      source_origin, source_type_id, source_entity_id
    )`,
  `CREATE INDEX commerce_relationship_relation_target
    ON commerce_relationship_relation_index (
      merchant_id, definition_origin, definition_id, definition_revision,
      target_origin, target_type_id, target_entity_id
    )`,
  `CREATE INDEX commerce_entity_attribute_relation_filter_idx
    ON commerce_entity_attribute_relation_index (
      merchant_id, subject_kind, entity_origin, entity_type, entity_id,
      list_id, entry_id, attribute_id, value_kind,
      comparable_text, comparable_integer, comparable_real, comparable_boolean
    )`,
  `CREATE INDEX commerce_entity_attribute_relation_order_idx
    ON commerce_entity_attribute_relation_index (
      merchant_id, subject_kind, entity_origin, entity_type,
      attribute_id, comparable_text, comparable_integer, comparable_real,
      comparable_boolean, entity_id
    )`,
  `CREATE VIEW commerce_entity AS
    SELECT commerce_projection.integration_account_id AS merchant_id,
           'system' AS entity_origin,
           CASE commerce_projection.projection_kind
             WHEN 'commerce_order' THEN 'order'
             ELSE commerce_projection.projection_kind
           END AS entity_type,
           commerce_projection.canonical_id AS entity_id,
           commerce_projection.revision,
           commerce_projection.updated_at,
           CAST(COALESCE(
             json_extract(commerce_projection.projection_json, '$.projection.title'),
             json_extract(commerce_projection.projection_json, '$.projection.name'),
             commerce_projection.canonical_id
           ) AS TEXT) AS display_name,
           relation_text.display_name_folded,
           relation_text.search_text_folded,
           commerce_projection.projection_json AS payload_json
      FROM commerce_projection
      LEFT JOIN commerce_projection_relation_text AS relation_text
        ON relation_text.organisation_id = commerce_projection.organisation_id
       AND relation_text.projection_kind = commerce_projection.projection_kind
       AND relation_text.canonical_id = commerce_projection.canonical_id`,
  `CREATE VIEW commerce_relationship_relation (
      merchant_id, relationship_origin, relationship_id, relationship_revision,
      definition_origin, definition_id, definition_revision, sensitivity,
      source_origin, source_type_id, source_entity_id,
      target_origin, target_type_id, target_entity_id, payload_json, provenance_json
    ) AS
    SELECT merchant_id, relationship_origin, relationship_id, relationship_revision,
           definition_origin, definition_id, definition_revision, sensitivity,
           source_origin, source_type_id, source_entity_id,
           target_origin, target_type_id, target_entity_id, payload_json, provenance_json
      FROM commerce_relationship_relation_index`,
  `CREATE VIEW commerce_entity_attribute_relation (
      merchant_id, subject_kind, entity_origin, entity_type, entity_id,
      list_id, entry_id, entity_revision, attribute_id, definition_revision,
      value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
    ) AS
    SELECT merchant_id, subject_kind, entity_origin, entity_type, entity_id,
           list_id, entry_id, entity_revision, attribute_id, definition_revision,
           value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
      FROM commerce_entity_attribute_relation_index`,
];

export function execSchemaStatements(
  sql: SqlStorage,
  statements: readonly string[],
): void {
  for (const statement of statements) sql.exec(statement);
}
