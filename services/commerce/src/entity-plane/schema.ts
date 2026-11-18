import type { CommerceDatabase } from "../database.ts";
import { initializeCommerceEntityRelation } from "./commerce-entity-relation.ts";
import { initializeCommerceAttributeRelation } from "./commerce-attribute-relation.ts";
import { initializeCommerceRelationshipRelation } from "./commerce-relationship-relation.ts";

const COMMERCE_LIST_ENTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_list_entry (
  merchant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  list_revision INTEGER NOT NULL CHECK (list_revision > 0),
  membership_kind TEXT NOT NULL CHECK (membership_kind IN ('unique_entity', 'repeatable_entity')),
  entity_origin TEXT NOT NULL CHECK (entity_origin IN ('system', 'custom')),
  entity_type_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (merchant_id, entry_id),
  FOREIGN KEY (merchant_id, list_id, list_revision, membership_kind)
    REFERENCES commerce_list (merchant_id, list_id, revision, membership_kind) ON DELETE RESTRICT
) STRICT;
`;

/**
 * Entity-plane state is a sidecar to the typed aggregate tables. The tables
 * below intentionally contain no copied order, inventory, payment, or
 * shipment state.
 */
// One merchant revision can hold several changes: a plugin installation
// publishes each of its entity types at the installation's revision (Plan 77
// step 4). Schema 76 removed the rule of one change for each revision.
export const ENTITY_PLANE_CHANGE_SCHEMA = `CREATE TABLE IF NOT EXISTS entity_plane_change (
  merchant_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  merchant_revision INTEGER NOT NULL CHECK (merchant_revision > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN (
    'entity_type', 'entity', 'extension_value', 'relationship_definition',
    'custom_relationship', 'commerce_list', 'commerce_list_entry', 'saved_view'
  )),
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, change_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS entity_plane_change_revision_idx
  ON entity_plane_change (merchant_id, merchant_revision);`;

const ENTITY_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_entity_type (
  merchant_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, entity_type_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS custom_entity_type_head (
  merchant_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, entity_type_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, entity_type_id, current_revision)
    REFERENCES custom_entity_type (merchant_id, entity_type_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, entity_type_id, published_revision)
    REFERENCES custom_entity_type (merchant_id, entity_type_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS entity_attribute_definition (
  merchant_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  entity_type_revision INTEGER NOT NULL CHECK (entity_type_revision > 0),
  attribute_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  PRIMARY KEY (merchant_id, entity_type_id, entity_type_revision, attribute_id),
  FOREIGN KEY (merchant_id, entity_type_id, entity_type_revision)
    REFERENCES custom_entity_type (merchant_id, entity_type_id, revision) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS system_entity_extension_schema (
  merchant_id TEXT NOT NULL,
  system_entity_type_id TEXT NOT NULL,
  extension_schema_revision INTEGER NOT NULL CHECK (extension_schema_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, system_entity_type_id, extension_schema_revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS system_entity_extension_schema_head (
  merchant_id TEXT NOT NULL,
  system_entity_type_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, system_entity_type_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, system_entity_type_id, current_revision)
    REFERENCES system_entity_extension_schema (merchant_id, system_entity_type_id, extension_schema_revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, system_entity_type_id, published_revision)
    REFERENCES system_entity_extension_schema (merchant_id, system_entity_type_id, extension_schema_revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS system_entity_extension_attribute_definition (
  merchant_id TEXT NOT NULL,
  system_entity_type_id TEXT NOT NULL,
  extension_schema_revision INTEGER NOT NULL CHECK (extension_schema_revision > 0),
  attribute_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  PRIMARY KEY (merchant_id, system_entity_type_id, extension_schema_revision, attribute_id),
  FOREIGN KEY (merchant_id, system_entity_type_id, extension_schema_revision)
    REFERENCES system_entity_extension_schema (merchant_id, system_entity_type_id, extension_schema_revision) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS system_entity_extension_value (
  merchant_id TEXT NOT NULL,
  system_entity_type_id TEXT NOT NULL,
  system_entity_id TEXT NOT NULL,
  extension_schema_revision INTEGER NOT NULL CHECK (extension_schema_revision > 0),
  attribute_id TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN (
    'short_text', 'long_text', 'integer', 'decimal', 'boolean', 'date',
    'timestamp', 'status', 'choice', 'money', 'merchant_operator_reference',
    'external_resource_reference'
  )),
  short_text_value TEXT,
  long_text_value TEXT,
  integer_value INTEGER,
  decimal_value TEXT,
  boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
  date_value TEXT,
  timestamp_value TEXT,
  status_value TEXT,
  choice_value TEXT,
  money_amount_minor INTEGER,
  money_currency TEXT,
  merchant_operator_reference_value TEXT,
  external_resource_reference_value TEXT,
  PRIMARY KEY (
    merchant_id, system_entity_type_id, system_entity_id,
    extension_schema_revision, attribute_id
  ),
  FOREIGN KEY (merchant_id, system_entity_type_id, extension_schema_revision)
    REFERENCES system_entity_extension_schema (merchant_id, system_entity_type_id, extension_schema_revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, system_entity_type_id, extension_schema_revision, attribute_id)
    REFERENCES system_entity_extension_attribute_definition (merchant_id, system_entity_type_id, extension_schema_revision, attribute_id) ON DELETE RESTRICT,
  CHECK (
    (value_kind = 'short_text' AND short_text_value IS NOT NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'long_text' AND short_text_value IS NULL AND long_text_value IS NOT NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'integer' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NOT NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'decimal' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NOT NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'boolean' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NOT NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'date' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NOT NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'timestamp' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NOT NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'status' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NOT NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'choice' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NOT NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'money' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NOT NULL AND money_currency IS NOT NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'merchant_operator_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NOT NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'external_resource_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS custom_entity (
  merchant_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  entity_type_revision INTEGER NOT NULL CHECK (entity_type_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
  display_name TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, entity_id),
  FOREIGN KEY (merchant_id, entity_type_id, entity_type_revision)
    REFERENCES custom_entity_type (merchant_id, entity_type_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS custom_entity_attribute_value (
  merchant_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL CHECK (entity_revision > 0),
  attribute_id TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN (
    'short_text', 'long_text', 'integer', 'decimal', 'boolean', 'date',
    'timestamp', 'status', 'choice', 'money', 'merchant_operator_reference',
    'external_resource_reference'
  )),
  short_text_value TEXT,
  long_text_value TEXT,
  integer_value INTEGER,
  decimal_value TEXT,
  boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
  date_value TEXT,
  timestamp_value TEXT,
  status_value TEXT,
  choice_value TEXT,
  money_amount_minor INTEGER,
  money_currency TEXT,
  merchant_operator_reference_value TEXT,
  external_resource_reference_value TEXT,
  PRIMARY KEY (merchant_id, entity_id, entity_revision, attribute_id),
  FOREIGN KEY (merchant_id, entity_id)
    REFERENCES custom_entity (merchant_id, entity_id) ON DELETE CASCADE,
  CHECK (
    (value_kind = 'short_text' AND short_text_value IS NOT NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'long_text' AND short_text_value IS NULL AND long_text_value IS NOT NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'integer' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NOT NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'decimal' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NOT NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'boolean' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NOT NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'date' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NOT NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'timestamp' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NOT NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'status' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NOT NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'choice' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NOT NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'money' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NOT NULL AND money_currency IS NOT NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'merchant_operator_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NOT NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'external_resource_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS relationship_definition (
  merchant_id TEXT NOT NULL,
  relationship_definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  origin TEXT NOT NULL CHECK (origin IN ('system', 'custom')),
  source_type_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  cardinality TEXT NOT NULL CHECK (cardinality IN ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many')),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, relationship_definition_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  CHECK (origin = 'custom')
) STRICT;

CREATE TABLE IF NOT EXISTS relationship_definition_head (
  merchant_id TEXT NOT NULL,
  relationship_definition_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, relationship_definition_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, relationship_definition_id, current_revision)
    REFERENCES relationship_definition (merchant_id, relationship_definition_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, relationship_definition_id, published_revision)
    REFERENCES relationship_definition (merchant_id, relationship_definition_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_relationship (
  merchant_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  relationship_definition_id TEXT NOT NULL,
  relationship_definition_revision INTEGER NOT NULL CHECK (relationship_definition_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'deleted')),
  source_origin TEXT NOT NULL CHECK (source_origin IN ('system', 'custom')),
  source_type_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_origin TEXT NOT NULL CHECK (target_origin IN ('system', 'custom')),
  target_type_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, relationship_id),
  FOREIGN KEY (merchant_id, relationship_definition_id, relationship_definition_revision)
    REFERENCES relationship_definition (merchant_id, relationship_definition_id, revision) ON DELETE RESTRICT,
  CHECK (source_origin = 'custom' OR target_origin = 'custom')
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_list (
  merchant_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  membership_kind TEXT GENERATED ALWAYS AS (json_extract(definition_json, '$.membership')) VIRTUAL NOT NULL
    CHECK (membership_kind IN ('unique_entity', 'repeatable_entity')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, list_id, revision),
  UNIQUE (merchant_id, list_id, revision, membership_kind),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_list_head (
  merchant_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, list_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, list_id, current_revision)
    REFERENCES commerce_list (merchant_id, list_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, list_id, published_revision)
    REFERENCES commerce_list (merchant_id, list_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_list_entry_attribute_definition (
  merchant_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  list_revision INTEGER NOT NULL CHECK (list_revision > 0),
  attribute_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  PRIMARY KEY (merchant_id, list_id, list_revision, attribute_id),
  FOREIGN KEY (merchant_id, list_id, list_revision)
    REFERENCES commerce_list (merchant_id, list_id, revision) ON DELETE CASCADE
) STRICT;

${COMMERCE_LIST_ENTRY_SCHEMA}

CREATE TABLE IF NOT EXISTS commerce_list_entry_attribute_value (
  merchant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
  attribute_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  value_kind TEXT NOT NULL CHECK (value_kind IN (
    'short_text', 'long_text', 'integer', 'decimal', 'boolean', 'date',
    'timestamp', 'status', 'choice', 'money', 'merchant_operator_reference',
    'external_resource_reference'
  )),
  short_text_value TEXT,
  long_text_value TEXT,
  integer_value INTEGER,
  decimal_value TEXT,
  boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
  date_value TEXT,
  timestamp_value TEXT,
  status_value TEXT,
  choice_value TEXT,
  money_amount_minor INTEGER,
  money_currency TEXT,
  merchant_operator_reference_value TEXT,
  external_resource_reference_value TEXT,
  PRIMARY KEY (merchant_id, entry_id, entry_revision, attribute_id),
  FOREIGN KEY (merchant_id, entry_id)
    REFERENCES commerce_list_entry (merchant_id, entry_id) ON DELETE CASCADE,
  CHECK (
    (value_kind = 'short_text' AND short_text_value IS NOT NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'long_text' AND short_text_value IS NULL AND long_text_value IS NOT NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'integer' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NOT NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'decimal' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NOT NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'boolean' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NOT NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'date' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NOT NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'timestamp' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NOT NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'status' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NOT NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'choice' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NOT NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'money' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NOT NULL AND money_currency IS NOT NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'merchant_operator_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NOT NULL AND external_resource_reference_value IS NULL) OR
    (value_kind = 'external_resource_reference' AND short_text_value IS NULL AND long_text_value IS NULL AND integer_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND timestamp_value IS NULL AND status_value IS NULL AND choice_value IS NULL AND money_amount_minor IS NULL AND money_currency IS NULL AND merchant_operator_reference_value IS NULL AND external_resource_reference_value IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS saved_commerce_view (
  merchant_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('entity_type', 'commerce_list')),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  presentation_kind TEXT NOT NULL CHECK (presentation_kind IN ('table', 'board')),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, view_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS saved_commerce_view_head (
  merchant_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft', 'published', 'archived')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, view_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, view_id, current_revision)
    REFERENCES saved_commerce_view (merchant_id, view_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, view_id, published_revision)
    REFERENCES saved_commerce_view (merchant_id, view_id, revision) ON DELETE RESTRICT
) STRICT;

${ENTITY_PLANE_CHANGE_SCHEMA}

CREATE INDEX IF NOT EXISTS custom_entity_type_merchant_state_idx
  ON custom_entity_type_head (merchant_id, lifecycle_state, entity_type_id);
CREATE INDEX IF NOT EXISTS entity_attribute_definition_type_idx
  ON entity_attribute_definition (merchant_id, entity_type_id, entity_type_revision);
CREATE INDEX IF NOT EXISTS system_entity_extension_ref_idx
  ON system_entity_extension_value (merchant_id, system_entity_type_id, system_entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS system_entity_extension_schema_published_idx
  ON system_entity_extension_schema_head (merchant_id, system_entity_type_id)
  WHERE lifecycle_state = 'published';
CREATE INDEX IF NOT EXISTS system_entity_extension_attribute_definition_idx
  ON system_entity_extension_attribute_definition (merchant_id, system_entity_type_id, extension_schema_revision);
CREATE INDEX IF NOT EXISTS custom_entity_type_idx
  ON custom_entity (merchant_id, entity_type_id, lifecycle_state, entity_id);
CREATE INDEX IF NOT EXISTS custom_entity_attribute_idx
  ON custom_entity_attribute_value (merchant_id, entity_id, entity_revision);
CREATE INDEX IF NOT EXISTS relationship_definition_endpoint_idx
  ON relationship_definition_head (merchant_id, relationship_definition_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS commerce_relationship_source_idx
  ON commerce_relationship (merchant_id, source_origin, source_type_id, source_entity_id);
CREATE INDEX IF NOT EXISTS commerce_relationship_target_idx
  ON commerce_relationship (merchant_id, target_origin, target_type_id, target_entity_id);
CREATE INDEX IF NOT EXISTS commerce_list_entity_type_idx
  ON commerce_list_head (merchant_id, list_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS commerce_list_entry_list_idx
  ON commerce_list_entry (merchant_id, list_id, lifecycle_state, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_list_entry_active_entity_idx
  ON commerce_list_entry (merchant_id, list_id, entity_origin, entity_type_id, entity_id)
  WHERE lifecycle_state = 'active' AND membership_kind = 'unique_entity';
CREATE INDEX IF NOT EXISTS commerce_list_entry_presentation_idx
  ON commerce_list_entry (merchant_id, list_id, updated_at_ms DESC, entity_id)
  WHERE lifecycle_state = 'active';
CREATE INDEX IF NOT EXISTS commerce_list_entry_entity_idx
  ON commerce_list_entry (merchant_id, entity_origin, entity_type_id, entity_id);
CREATE INDEX IF NOT EXISTS saved_commerce_view_source_idx
  ON saved_commerce_view_head (merchant_id, view_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS entity_plane_change_cursor_idx
  ON entity_plane_change (merchant_id, merchant_revision);
`;

export function initializeEntityPlaneSchema(
  database: CommerceDatabase,
): void {
  database.exec(ENTITY_PLANE_SCHEMA);
  initializeCommerceEntityRelation(database);
  initializeCommerceAttributeRelation(database);
  initializeCommerceRelationshipRelation(database);
}
