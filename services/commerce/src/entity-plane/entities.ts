import type {
  AttributeDefinition,
  AttributeValue,
  AttributeValueAssignment,
  CommerceEntity,
  CommerceEntityRevision,
  CommerceEntityType,
  CommerceEntityTypeId,
  CommerceFreshness,
  CommerceResourceType,
  CommerceSensitivity,
  CustomCommerceEntity,
  CustomCommerceEntityId,
  CustomCommerceEntityRef,
  CustomCommerceEntityTypeId,
  CustomEntityTypeRevision,
  SourceProvenance,
  SystemCommerceEntityRef,
  SystemSchemaRevision,
  MerchantExtensionSchemaRevision,
  CustomCommerceEntityTypeDraft,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  parseAttributeAssignment,
  parseAttributeDefinition,
  parseAttributeValue,
  parseCustomEntityTypeDraft,
  parseEntityRef,
  parsePositiveRevision,
  parseSourceProvenance,
  parseSensitivity,
  parseSystemEntityRef,
} from "./parsers.ts";
import {
  deleteCommerceEntityRelationText,
  writeCommerceEntityRelationText,
} from "./relation-text.ts";
import {
  canonicalSystemAttributeDefinitions,
  readCommerceCanonicalSystemAttributeAssignments,
} from "./commerce-attribute-relation.ts";
import { validateCommerceEntityWithLexicon } from "./lexicon.ts";
import {
  FOOD_SERVICE_ENTITY_ROWS,
  FOOD_SERVICE_ENTITY_TYPES,
  foodServiceLatestRevision,
} from "../plugins/food-service/index.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import { isRecord, parseJson } from "@purin-labs/std";

type SystemKind = SystemCommerceEntityRef["typeId"];
type EntityState = "active" | "archived";
type SystemEntity = VariantBy<
  CommerceEntity,
  "reference",
  SystemCommerceEntityRef
>;
type SystemExtension = VariantBy<
  CommerceEntityType,
  "origin",
  "system"
>["merchantExtension"];

type MerchantRow = Readonly<{ organisationId: string; revision: number }>;
type CustomEntityTypeRow = Readonly<{
  entityTypeId: string;
  revision: number;
  lifecycleState: "draft" | "published" | "archived";
  publishedRevision: number | null;
  definitionJson: string;
}>;
type CustomEntityRow = Readonly<{
  entityId: string;
  entityTypeId: string;
  entityTypeRevision: number;
  revision: number;
  lifecycleState: EntityState;
  displayName: string;
  sensitivity: CommerceSensitivity;
  createdAt: string;
  updatedAt: string;
}>;
export type StoredAttributeRow = Readonly<{
  attributeId: string;
  valueKind: AttributeValue["kind"];
  shortTextValue: string | null;
  longTextValue: string | null;
  integerValue: number | null;
  decimalValue: string | null;
  booleanValue: number | null;
  dateValue: string | null;
  timestampValue: string | null;
  statusValue: string | null;
  choiceValue: string | null;
  moneyAmountMinor: number | null;
  moneyCurrency: string | null;
  merchantOperatorReferenceValue: string | null;
  externalResourceReferenceValue: string | null;
}>;
type CanonicalEntityRow = Readonly<{
  entityId: string;
  revision: number;
  displayName: string | null;
  occurredAt: string | null;
  payloadJson: string | null;
}>;
type CommerceEntityDefinition = Readonly<{
  typeId: SystemKind;
  table: string;
  idColumn: string;
  displayColumn: string | null;
  occurredColumn: string;
  payloadColumn: string | null;
  resourceKind: string | null;
  resourceType: CommerceResourceType;
}>;

const SYSTEM_ENTITY_DEFINITIONS: readonly CommerceEntityDefinition[] = [
  definition(
    "location",
    "location",
    "resource_id",
    "name",
    "occurred_at",
    null,
    null,
    "location",
  ),
  definition(
    "sales_channel",
    "sales_channel",
    "resource_id",
    "name",
    "occurred_at",
    null,
    null,
    "sales_channel",
  ),
  definition(
    "product",
    "product",
    "resource_id",
    "title",
    "occurred_at",
    null,
    null,
    "product",
  ),
  definition(
    "sellable_variant",
    "sellable_variant",
    "resource_id",
    "title",
    "occurred_at",
    "definition_json",
    null,
    "sellable_variant",
  ),
  definition(
    "offer",
    "offer",
    "resource_id",
    null,
    "occurred_at",
    "availability_json",
    null,
    "offer",
  ),
  definition(
    "inventory_item",
    "inventory_item",
    "inventory_item_id",
    "name",
    "occurred_at",
    null,
    null,
    "inventory_item",
  ),
  definition(
    "inventory_position",
    "inventory_position",
    "inventory_position_id",
    null,
    "observed_at",
    null,
    null,
    "inventory_position",
  ),
  definition(
    "inventory_movement",
    "stock_movement",
    "movement_id",
    null,
    "occurred_at",
    null,
    null,
    "inventory_movement",
  ),
  definition(
    "inventory_lot",
    "stock_lot",
    "lot_id",
    "lot_code",
    "occurred_at",
    null,
    null,
    "inventory_lot",
  ),
  definition(
    "order",
    "commerce_order",
    "resource_id",
    null,
    "occurred_at",
    "order_snapshot_json",
    null,
    "commerce_order",
  ),
  definition(
    "payment",
    "payment",
    "resource_id",
    null,
    "occurred_at",
    "payment_snapshot_json",
    null,
    "payment",
  ),
  definition(
    "fulfillment",
    "fulfillment",
    "resource_id",
    null,
    "occurred_at",
    "fulfillment_snapshot_json",
    null,
    "fulfillment",
  ),
  definition(
    "shipment",
    "shipment",
    "resource_id",
    null,
    "occurred_at",
    "shipment_snapshot_json",
    null,
    "shipment",
  ),
  // The food-service plugin's types (Plan 77 step 6).
  ...FOOD_SERVICE_ENTITY_TYPES.map((typeId) =>
    definition(
      typeId,
      FOOD_SERVICE_ENTITY_ROWS.table,
      FOOD_SERVICE_ENTITY_ROWS.idColumn,
      null,
      FOOD_SERVICE_ENTITY_ROWS.occurredAt,
      FOOD_SERVICE_ENTITY_ROWS.payloadColumn,
      typeId,
      typeId,
    ),
  ),
];

export function readMerchant(
  database: CommerceDatabase,
  merchantId: string,
): MerchantRow | undefined {
  return database
    .prepare(
      `SELECT external_reference AS organisationId, revision
     FROM merchant WHERE merchant_id = ?`,
    )
    .get<MerchantRow>(merchantId);
}

export function isSystemEntityType(value: string): value is SystemKind {
  return SYSTEM_ENTITY_DEFINITIONS.some((entry) => entry.typeId === value);
}

export function listSystemEntityTypeIds(): readonly SystemKind[] {
  return SYSTEM_ENTITY_DEFINITIONS.map((entry) => entry.typeId);
}

export function listEntityTypes(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceEntityTypeId[] {
  const system = listSystemEntityTypeIds().map((typeId) => ({
    origin: "system" as const,
    typeId,
  }));
  const custom = listCustomEntityTypes(database, merchantId).map((entry) => ({
    origin: "custom" as const,
    typeId: entry.definition.typeId,
  }));
  return [...system, ...custom];
}

export function entityTypeExists(
  database: CommerceDatabase,
  merchantId: string,
  typeId: CommerceEntityTypeId,
): boolean {
  if (typeId.origin === "system") return isSystemEntityType(typeId.typeId);
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM custom_entity_type_head
     WHERE merchant_id = ? AND entity_type_id = ? AND published_revision IS NOT NULL`,
      )
      .get<{ present: number }>(merchantId, typeId.typeId) !== undefined
  );
}

export function systemEntityType(
  database: CommerceDatabase,
  merchantId: string,
  typeId: SystemKind,
): CommerceEntityType {
  const extension = readPublishedSystemExtensionSchema(
    database,
    merchantId,
    typeId,
  );
  const merchantExtension: SystemExtension =
    extension === undefined
      ? { state: "absent" }
      : { state: "published", revision: extension.revision };
  return {
    origin: "system",
    typeId,
    lexiconSchemaRevision: parsePositiveRevision<SystemSchemaRevision>(
      1,
      "systemEntityType.lexiconSchemaRevision",
    ),
    merchantExtension,
  };
}

export function readSystemEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
  _merchantRevision: number,
): CommerceEntity | undefined {
  const definition = definitionFor(reference.typeId);
  const row = readCanonicalRow(
    database,
    merchantId,
    definition,
    reference.entityId,
  );
  return row === undefined
    ? undefined
    : projectSystemEntity(database, merchantId, definition, row);
}

export function readSystemEntityExtension(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
): Readonly<{
  extension: SystemExtension;
  attributes: readonly AttributeValueAssignment[];
}> {
  const context = readSystemEntityAttributeContext(
    database,
    merchantId,
    reference,
  );
  return { extension: context.extension, attributes: context.attributes };
}

export function createSystemExtensionSchema(
  database: CommerceDatabase,
  merchantId: string,
  typeId: SystemKind,
  revision: number,
  definitions: readonly AttributeDefinition[],
  now: string,
): void {
  const current = database
    .prepare(
      `SELECT current_revision AS revision, lifecycle_state AS lifecycleState
     FROM system_entity_extension_schema_head
     WHERE merchant_id = ? AND system_entity_type_id = ?`,
    )
    .get<
      Readonly<{
        revision: number;
        lifecycleState: "draft" | "published" | "archived";
      }>
    >(merchantId, typeId);
  if (current !== undefined) {
    if (current.lifecycleState === "draft")
      throw new Error("System extension schema already has a draft revision");
    if (revision !== current.revision + 1)
      throw new Error(
        "System extension schema revision must advance exactly once",
      );
  } else if (revision !== 1) {
    throw new Error("System extension schema must start at revision 1");
  }
  const schema = database
    .prepare(
      `INSERT INTO system_entity_extension_schema (
       merchant_id, system_entity_type_id, extension_schema_revision,
       lifecycle_state, created_at, updated_at
     ) VALUES (?, ?, ?, 'draft', ?, ?)`,
    )
    .run(merchantId, typeId, revision, now, now);
  if (schema.changes !== 1)
    throw new Error("System extension schema revision was not written");
  const head = database
    .prepare(
      `INSERT INTO system_entity_extension_schema_head (
       merchant_id, system_entity_type_id, current_revision, published_revision,
       lifecycle_state, updated_at
     ) VALUES (?, ?, ?, NULL, 'draft', ?)
     ON CONFLICT (merchant_id, system_entity_type_id) DO UPDATE SET
       current_revision = excluded.current_revision,
       lifecycle_state = 'draft',
       updated_at = excluded.updated_at`,
    )
    .run(merchantId, typeId, revision, now);
  if (head.changes !== 1)
    throw new Error("System extension schema draft was not written");
  for (const definition of definitions) {
    const attribute = database
      .prepare(
        `INSERT INTO system_entity_extension_attribute_definition (
         merchant_id, system_entity_type_id, extension_schema_revision,
         attribute_id, definition_json
       ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        typeId,
        revision,
        definition.id,
        JSON.stringify(definition),
      );
    if (attribute.changes !== 1)
      throw new Error("System extension attribute definition was not written");
  }
}

export function publishSystemExtensionSchema(
  database: CommerceDatabase,
  merchantId: string,
  typeId: SystemKind,
  expectedRevision: number,
  now: string,
): void {
  const head = database
    .prepare(
      `UPDATE system_entity_extension_schema_head
     SET published_revision = current_revision, lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND system_entity_type_id = ? AND current_revision = ?
       AND EXISTS (
         SELECT 1 FROM system_entity_extension_schema
         WHERE merchant_id = ? AND system_entity_type_id = ?
           AND extension_schema_revision = ? AND lifecycle_state = 'draft'
       )`,
    )
    .run(
      now,
      merchantId,
      typeId,
      expectedRevision,
      merchantId,
      typeId,
      expectedRevision,
    );
  if (head.changes !== 1)
    throw new Error("System extension schema publication revision conflict");
  const schema = database
    .prepare(
      `UPDATE system_entity_extension_schema SET lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND system_entity_type_id = ?
       AND extension_schema_revision = ? AND lifecycle_state = 'draft'`,
    )
    .run(now, merchantId, typeId, expectedRevision);
  if (schema.changes !== 1)
    throw new Error("System extension schema publication revision conflict");
}

export function listCustomEntityTypes(
  database: CommerceDatabase,
  merchantId: string,
): readonly CustomEntityTypeRecord[] {
  const rows = database
    .prepare(
      `SELECT type.entity_type_id AS entityTypeId, type.revision,
            head.lifecycle_state AS lifecycleState,
            head.published_revision AS publishedRevision,
            type.definition_json AS definitionJson
     FROM custom_entity_type AS type
     JOIN custom_entity_type_head AS head
       ON head.merchant_id = type.merchant_id
      AND head.entity_type_id = type.entity_type_id
      AND head.published_revision = type.revision
     WHERE type.merchant_id = ? AND head.lifecycle_state = 'published'
     ORDER BY type.entity_type_id`,
    )
    .all<CustomEntityTypeRow>(merchantId);
  return rows.map(parseCustomEntityTypeRow);
}

type CustomEntityTypeRecord = Readonly<{
  definition: ReturnType<typeof parseCustomEntityTypeDraft>;
  revision: number;
  lifecycle: "draft" | "published" | "archived";
}>;

export function readCustomEntityType(
  database: CommerceDatabase,
  merchantId: string,
  typeId: CustomCommerceEntityTypeId,
): CustomEntityTypeRecord | undefined {
  const row = database
    .prepare(
      `SELECT type.entity_type_id AS entityTypeId, type.revision,
            head.lifecycle_state AS lifecycleState,
            head.published_revision AS publishedRevision,
            type.definition_json AS definitionJson
     FROM custom_entity_type AS type
     JOIN custom_entity_type_head AS head
       ON head.merchant_id = type.merchant_id
      AND head.entity_type_id = type.entity_type_id
      AND head.current_revision = type.revision
     WHERE type.merchant_id = ? AND type.entity_type_id = ?`,
    )
    .get<CustomEntityTypeRow>(merchantId, typeId);
  return row === undefined ? undefined : parseCustomEntityTypeRow(row);
}

export function readCustomEntityTypeRevision(
  database: CommerceDatabase,
  merchantId: string,
  typeId: CustomCommerceEntityTypeId,
  revision: number,
): CustomEntityTypeRecord | undefined {
  const row = database
    .prepare(
      `SELECT type.entity_type_id AS entityTypeId, type.revision,
            CASE WHEN head.published_revision = type.revision THEN 'published' ELSE type.lifecycle_state END AS lifecycleState,
            head.published_revision AS publishedRevision,
            type.definition_json AS definitionJson
     FROM custom_entity_type AS type
     JOIN custom_entity_type_head AS head
       ON head.merchant_id = type.merchant_id AND head.entity_type_id = type.entity_type_id
     WHERE type.merchant_id = ? AND type.entity_type_id = ? AND type.revision = ?`,
    )
    .get<CustomEntityTypeRow>(merchantId, typeId, revision);
  return row === undefined ? undefined : parseCustomEntityTypeRow(row);
}

export function readCustomEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CustomCommerceEntityRef,
  _merchantRevision: number,
): CommerceEntity | undefined {
  const row = database
    .prepare(
      `SELECT entity_id AS entityId, entity_type_id AS entityTypeId,
            entity_type_revision AS entityTypeRevision, revision,
            lifecycle_state AS lifecycleState, display_name AS displayName,
            sensitivity,
            created_at AS createdAt, updated_at AS updatedAt
     FROM custom_entity WHERE merchant_id = ? AND entity_id = ? AND entity_type_id = ?`,
    )
    .get<CustomEntityRow>(merchantId, reference.entityId, reference.typeId);
  if (row === undefined) return undefined;
  const type = readCustomEntityTypeRevision(
    database,
    merchantId,
    parseCustomTypeId(row.entityTypeId),
    row.entityTypeRevision,
  );
  if (type === undefined || type.lifecycle === "draft") return undefined;
  const values = database
    .prepare(
      `SELECT attribute_id AS attributeId, value_kind AS valueKind,
            short_text_value AS shortTextValue, long_text_value AS longTextValue,
            integer_value AS integerValue, decimal_value AS decimalValue,
            boolean_value AS booleanValue, date_value AS dateValue,
            timestamp_value AS timestampValue, status_value AS statusValue,
            choice_value AS choiceValue, money_amount_minor AS moneyAmountMinor,
            money_currency AS moneyCurrency,
            merchant_operator_reference_value AS merchantOperatorReferenceValue,
            external_resource_reference_value AS externalResourceReferenceValue
     FROM custom_entity_attribute_value
     WHERE merchant_id = ? AND entity_id = ? AND entity_revision = ?
     ORDER BY attribute_id`,
    )
    .all<StoredAttributeRow>(merchantId, row.entityId, row.revision);
  const entity: CustomCommerceEntity = {
    reference,
    revision: parsePositiveRevision<CommerceEntityRevision>(
      row.revision,
      "customEntity.revision",
    ),
    displayName: row.displayName,
    attributes: values.map((stored) =>
      attributeAssignmentFromStored(stored, type.definition.attributes),
    ),
    typeRevision: parsePositiveRevision<CustomEntityTypeRevision>(
      row.entityTypeRevision,
      "customEntity.typeRevision",
    ),
    state:
      row.lifecycleState === "active"
        ? { state: "active" }
        : { state: "archived", archivedAt: row.updatedAt },
    sensitivity: parseSensitivity(row.sensitivity, "customEntity.sensitivity"),
  };
  validateCommerceEntityWithLexicon(entity, type.definition.attributes);
  return entity;
}

export function writeCustomEntityType(
  database: CommerceDatabase,
  merchantId: string,
  definition: CustomCommerceEntityTypeDraft,
  now: string,
): void {
  const current = database
    .prepare(
      `SELECT COALESCE(MAX(revision), 0) AS revision
     FROM custom_entity_type WHERE merchant_id = ? AND entity_type_id = ?`,
    )
    .get<Readonly<{ revision: number }>>(merchantId, definition.typeId);
  const revision = Number(definition.revision);
  if (revision !== Number(current?.revision ?? 0) + 1)
    throw new Error("Custom entity type revision must advance exactly once");
  database
    .prepare(
      `INSERT INTO custom_entity_type (
       merchant_id, entity_type_id, revision, lifecycle_state,
       definition_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    )
    .run(
      merchantId,
      definition.typeId,
      revision,
      JSON.stringify(definition),
      now,
      now,
    );
  const head = database
    .prepare(
      `INSERT INTO custom_entity_type_head (
       merchant_id, entity_type_id, current_revision, published_revision, lifecycle_state, updated_at
     ) VALUES (?, ?, ?, NULL, 'draft', ?)
     ON CONFLICT (merchant_id, entity_type_id) DO UPDATE SET
       current_revision = excluded.current_revision,
       lifecycle_state = 'draft',
       updated_at = excluded.updated_at`,
    )
    .run(merchantId, definition.typeId, revision, now);
  if (head.changes !== 1)
    throw new Error("Custom entity type head was not written");
  for (const attribute of definition.attributes)
    insertAttributeDefinition(
      database,
      merchantId,
      definition.typeId,
      revision,
      attribute,
    );
}

export function publishCustomEntityType(
  database: CommerceDatabase,
  merchantId: string,
  typeId: CustomCommerceEntityTypeId,
  expectedRevision: number,
  now: string,
): void {
  const result = database
    .prepare(
      `UPDATE custom_entity_type_head
     SET published_revision = current_revision, lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND entity_type_id = ? AND current_revision = ?
       AND EXISTS (
         SELECT 1 FROM custom_entity_type
         WHERE merchant_id = ? AND entity_type_id = ? AND revision = ? AND lifecycle_state = 'draft'
       )`,
    )
    .run(
      now,
      merchantId,
      typeId,
      expectedRevision,
      merchantId,
      typeId,
      expectedRevision,
    );
  if (result.changes !== 1)
    throw new Error("Custom entity type publication revision conflict");
  const published = database
    .prepare(
      `UPDATE custom_entity_type SET lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND entity_type_id = ? AND revision = ? AND lifecycle_state = 'draft'`,
    )
    .run(now, merchantId, typeId, expectedRevision);
  if (published.changes !== 1)
    throw new Error("Custom entity type publication revision conflict");
}

export function writeCustomEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CustomCommerceEntityRef,
  typeRevision: CustomEntityTypeRevision,
  displayName: string,
  sensitivity: CommerceSensitivity,
  values: readonly AttributeValueAssignment[],
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO custom_entity (
       merchant_id, entity_id, entity_type_id, entity_type_revision,
       revision, lifecycle_state, display_name,
       sensitivity, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      reference.entityId,
      reference.typeId,
      typeRevision,
      displayName,
      sensitivity,
      now,
      now,
    );
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "custom",
    reference.typeId,
    reference.entityId,
    1,
    now,
    displayName,
  );
  writeEntityAttributeValues(
    database,
    merchantId,
    reference.entityId,
    1,
    values,
  );
}

export function updateCustomEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CustomCommerceEntityRef,
  expectedRevision: number,
  displayName: string | null,
  values: readonly AttributeValueAssignment[],
  now: string,
): number {
  const nextRevision = expectedRevision + 1;
  const result = database
    .prepare(
      `UPDATE custom_entity
     SET revision = ?, display_name = COALESCE(?, display_name), updated_at = ?
     WHERE merchant_id = ? AND entity_id = ? AND entity_type_id = ? AND revision = ? AND lifecycle_state = 'active'`,
    )
    .run(
      nextRevision,
      displayName,
      now,
      merchantId,
      reference.entityId,
      reference.typeId,
      expectedRevision,
    );
  if (result.changes !== 1)
    throw new Error(
      "Custom entity changed while committing entity-plane command",
    );
  if (displayName !== null) {
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "custom",
      reference.typeId,
      reference.entityId,
      nextRevision,
      now,
      displayName,
    );
  } else {
    const currentDisplayName = database
      .prepare(
        `SELECT display_name AS displayName FROM custom_entity
       WHERE merchant_id = ? AND entity_id = ? AND entity_type_id = ?`,
      )
      .get<Readonly<{ displayName: string }>>(
        merchantId,
        reference.entityId,
        reference.typeId,
      )?.displayName;
    if (currentDisplayName === undefined)
      throw new Error("Updated custom entity is missing its display name");
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "custom",
      reference.typeId,
      reference.entityId,
      nextRevision,
      now,
      currentDisplayName,
    );
  }
  writeEntityAttributeValues(
    database,
    merchantId,
    reference.entityId,
    nextRevision,
    values,
  );
  return nextRevision;
}

export function archiveCustomEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CustomCommerceEntityRef,
  expectedRevision: number,
  archivedAt: string,
): number {
  const nextRevision = expectedRevision + 1;
  const result = database
    .prepare(
      `UPDATE custom_entity
     SET revision = ?, lifecycle_state = 'archived', updated_at = ?
     WHERE merchant_id = ? AND entity_id = ? AND entity_type_id = ? AND revision = ? AND lifecycle_state = 'active'`,
    )
    .run(
      nextRevision,
      archivedAt,
      merchantId,
      reference.entityId,
      reference.typeId,
      expectedRevision,
    );
  if (result.changes !== 1)
    throw new Error(
      "Custom entity changed while committing entity-plane command",
    );
  database
    .prepare(
      `INSERT INTO custom_entity_attribute_value (
        merchant_id, entity_id, entity_revision, attribute_id, value_kind,
        short_text_value, long_text_value, integer_value, decimal_value,
        boolean_value, date_value, timestamp_value, status_value, choice_value,
        money_amount_minor, money_currency, merchant_operator_reference_value,
        external_resource_reference_value
      ) SELECT merchant_id, entity_id, ?, attribute_id, value_kind,
        short_text_value, long_text_value, integer_value, decimal_value,
        boolean_value, date_value, timestamp_value, status_value, choice_value,
        money_amount_minor, money_currency, merchant_operator_reference_value,
        external_resource_reference_value
      FROM custom_entity_attribute_value
      WHERE merchant_id = ? AND entity_id = ? AND entity_revision = ?`,
    )
    .run(nextRevision, merchantId, reference.entityId, expectedRevision);
  deleteCommerceEntityRelationText(
    database,
    merchantId,
    "custom",
    reference.typeId,
    reference.entityId,
  );
  return nextRevision;
}

export function readEntityMutationRow(
  database: CommerceDatabase,
  merchantId: string,
  reference: CustomCommerceEntityRef,
):
  | Readonly<{
      revision: number;
      entityTypeRevision: number;
      lifecycleState: EntityState;
    }>
  | undefined {
  return database
    .prepare(
      `SELECT revision, entity_type_revision AS entityTypeRevision, lifecycle_state AS lifecycleState
     FROM custom_entity WHERE merchant_id = ? AND entity_id = ? AND entity_type_id = ?`,
    )
    .get<
      Readonly<{
        revision: number;
        entityTypeRevision: number;
        lifecycleState: EntityState;
      }>
    >(merchantId, reference.entityId, reference.typeId);
}

function readCanonicalRow(
  database: CommerceDatabase,
  merchantId: string,
  definition: CommerceEntityDefinition,
  entityId: string,
): CanonicalEntityRow | undefined {
  const id = definition.idColumn;
  const payload = definition.payloadColumn ?? "NULL";
  const revision = canonicalRevisionExpression(definition);
  const resourceFilter =
    definition.resourceKind === null
      ? ""
      : ` AND resource_kind = ? AND ${foodServiceLatestRevision(definition.table)}`;
  const values =
    definition.resourceKind === null
      ? [merchantId, entityId]
      : [merchantId, entityId, definition.resourceKind];
  return database
    .prepare(
      `SELECT ${id} AS entityId, ${revision} AS revision, ${definition.displayColumn ?? "NULL"} AS displayName,
            ${definition.occurredColumn} AS occurredAt, ${payload} AS payloadJson
     FROM ${definition.table}
     WHERE merchant_id = ? AND ${id} = ?${resourceFilter}`,
    )
    .get<CanonicalEntityRow>(...values);
}

function projectSystemEntity(
  database: CommerceDatabase,
  merchantId: string,
  definition: CommerceEntityDefinition,
  row: CanonicalEntityRow,
): CommerceEntity {
  const reference = parseSystemEntityRef(definition.typeId, row.entityId);
  const payload =
    row.payloadJson === null ? null : parseJsonObject(row.payloadJson);
  const occurredAt = parseCanonicalTimestamp(
    row.occurredAt,
    definition.typeId,
    row.entityId,
  );
  const provenance = systemProvenance(
    database,
    merchantId,
    definition.resourceType,
    row,
    occurredAt,
  );
  const attributeContext = readSystemEntityAttributeContext(
    database,
    merchantId,
    reference,
  );
  const entity: SystemEntity = {
    reference,
    revision: parsePositiveRevision<CommerceEntityRevision>(
      row.revision,
      "systemEntity.revision",
    ),
    displayName:
      row.displayName ?? displayNameFromPayload(row.entityId, payload),
    attributes: [
      ...readCommerceCanonicalSystemAttributeAssignments(
        database,
        merchantId,
        reference,
      ),
      ...attributeContext.attributes,
    ],
    provenance,
    freshness: currentFreshness(provenance.observedAt),
  };
  validateCommerceEntityWithLexicon(entity, attributeContext.definitions);
  return entity;
}

type SystemEntityAttributeContext = Readonly<{
  extension: SystemExtension;
  definitions: readonly AttributeDefinition[];
  attributes: readonly AttributeValueAssignment[];
}>;

function readSystemEntityAttributeContext(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
): SystemEntityAttributeContext {
  const schema = readPublishedSystemExtensionSchema(
    database,
    merchantId,
    reference.typeId,
  );
  if (schema === undefined) {
    return {
      extension: { state: "absent" },
      definitions: canonicalSystemAttributeDefinitions(reference.typeId),
      attributes: [],
    };
  }
  return {
    extension: { state: "published", revision: schema.revision },
    definitions: [
      ...canonicalSystemAttributeDefinitions(reference.typeId),
      ...schema.definitions,
    ],
    attributes: readSystemExtensionValues(
      database,
      merchantId,
      reference,
      schema,
    ),
  };
}

type PublishedSystemExtensionSchema = Readonly<{
  revision: MerchantExtensionSchemaRevision;
  definitions: readonly AttributeDefinition[];
}>;

function readSystemExtensionValues(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
  schema: PublishedSystemExtensionSchema,
): AttributeValueAssignment[] {
  const definitions = new Map(
    schema.definitions.map((definition) => [String(definition.id), definition]),
  );
  const rows = database
    .prepare(
      `SELECT attribute_id AS attributeId, extension_schema_revision AS extensionSchemaRevision,
            value_kind AS valueKind, short_text_value AS shortTextValue,
            long_text_value AS longTextValue, integer_value AS integerValue,
            decimal_value AS decimalValue, boolean_value AS booleanValue,
            date_value AS dateValue, timestamp_value AS timestampValue,
            status_value AS statusValue, choice_value AS choiceValue,
            money_amount_minor AS moneyAmountMinor, money_currency AS moneyCurrency,
            merchant_operator_reference_value AS merchantOperatorReferenceValue,
            external_resource_reference_value AS externalResourceReferenceValue
     FROM system_entity_extension_value
     WHERE merchant_id = ? AND system_entity_type_id = ? AND system_entity_id = ?
       AND extension_schema_revision = ?
     ORDER BY attribute_id`,
    )
    .all<StoredExtensionRow>(
      merchantId,
      reference.typeId,
      reference.entityId,
      schema.revision,
    );
  return rows.map((row) => {
    const definition = definitions.get(row.attributeId);
    if (definition === undefined)
      throw new Error(
        `Stored system extension value is not in the published schema: ${row.attributeId}`,
      );
    return parseAttributeAssignment({
      attributeId: row.attributeId,
      scope: definition.scope,
      definitionRevision: row.extensionSchemaRevision,
      sensitivity: definition.sensitivity,
      value: storedValue(row),
    });
  });
}

function readPublishedSystemExtensionSchema(
  database: CommerceDatabase,
  merchantId: string,
  typeId: SystemKind,
): PublishedSystemExtensionSchema | undefined {
  const row = database
    .prepare(
      `SELECT extension_schema_revision AS extensionSchemaRevision
     FROM system_entity_extension_schema AS schema
     JOIN system_entity_extension_schema_head AS head
       ON head.merchant_id = schema.merchant_id
      AND head.system_entity_type_id = schema.system_entity_type_id
      AND head.published_revision = schema.extension_schema_revision
     WHERE schema.merchant_id = ? AND schema.system_entity_type_id = ?
       AND head.lifecycle_state = 'published'`,
    )
    .get<StoredExtensionSchemaRow>(merchantId, typeId);
  if (row === undefined) return undefined;
  const revision = parsePositiveRevision<MerchantExtensionSchemaRevision>(
    row.extensionSchemaRevision,
    "systemEntityType.merchantExtension.revision",
  );
  const definitions = database
    .prepare(
      `SELECT attribute_id AS attributeId, definition_json AS definitionJson
     FROM system_entity_extension_attribute_definition
     WHERE merchant_id = ? AND system_entity_type_id = ? AND extension_schema_revision = ?
     ORDER BY attribute_id`,
    )
    .all<StoredExtensionDefinitionRow>(merchantId, typeId, revision)
    .map((definitionRow) => {
      const definition = parseAttributeDefinition(
        parseJson(definitionRow.definitionJson),
      );
      if (
        definition.scope.kind !== "merchant_extension" ||
        definition.scope.entityTypeId !== typeId ||
        Number(definition.scope.schemaRevision) !== Number(revision) ||
        String(definition.id) !== definitionRow.attributeId ||
        Number(definition.revision) !== Number(revision)
      )
        throw new Error("Stored system extension definition identity mismatch");
      return definition;
    });
  return { revision, definitions };
}

type StoredExtensionRow = StoredAttributeRow &
  Readonly<{ extensionSchemaRevision: number }>;

type StoredExtensionSchemaRow = Readonly<{ extensionSchemaRevision: number }>;
type StoredExtensionDefinitionRow = Readonly<{
  attributeId: string;
  definitionJson: string;
}>;

function systemProvenance(
  database: CommerceDatabase,
  merchantId: string,
  resourceType: CommerceResourceType,
  row: CanonicalEntityRow,
  occurredAt: string,
): SourceProvenance {
  const merchant = readMerchant(database, merchantId);
  if (merchant === undefined)
    throw new Error(`Merchant not found: ${merchantId}`);
  return parseSourceProvenance(
    {
      organisationId: merchant.organisationId,
      integrationAccountId: "commerce",
      source: "commerce",
      resourceType,
      resourceId: row.entityId,
      revision: row.revision,
      occurredAt,
      observedAt: occurredAt,
    },
    "systemEntity.provenance",
  );
}

function currentFreshness(observedAt: string): CommerceFreshness {
  return { state: "current", observedAt };
}

function parseCanonicalTimestamp(
  value: string | null,
  typeId: SystemKind,
  entityId: string,
): string {
  if (value === null || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `System entity ${typeId}:${entityId} is missing a valid occurredAt timestamp`,
    );
  }
  return value;
}

function parseCustomEntityTypeRow(
  row: CustomEntityTypeRow,
): CustomEntityTypeRecord {
  const definition = parseCustomEntityTypeDraft(parseJson(row.definitionJson));
  if (definition.typeId !== row.entityTypeId)
    throw new Error("Stored custom entity type identity mismatch");
  return { definition, revision: row.revision, lifecycle: row.lifecycleState };
}

function insertAttributeDefinition(
  database: CommerceDatabase,
  merchantId: string,
  typeId: CustomCommerceEntityTypeId,
  typeRevision: number,
  definition: AttributeDefinition,
): void {
  database
    .prepare(
      `INSERT INTO entity_attribute_definition (
       merchant_id, entity_type_id, entity_type_revision, attribute_id, definition_json
     ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      typeId,
      typeRevision,
      definition.id,
      JSON.stringify(definition),
    );
}

function writeEntityAttributeValues(
  database: CommerceDatabase,
  merchantId: string,
  entityId: CustomCommerceEntityId,
  entityRevision: number,
  values: readonly AttributeValueAssignment[],
): void {
  for (const entry of values) {
    const storage = storageFields(entry.value);
    database
      .prepare(
        `INSERT INTO custom_entity_attribute_value (
         merchant_id, entity_id, entity_revision, attribute_id, value_kind,
         short_text_value, long_text_value, integer_value, decimal_value,
         boolean_value, date_value, timestamp_value, status_value, choice_value,
         money_amount_minor, money_currency,
         merchant_operator_reference_value, external_resource_reference_value
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        entityId,
        entityRevision,
        entry.attributeId,
        entry.value.kind,
        storage.shortText,
        storage.longText,
        storage.integer,
        storage.decimal,
        storage.boolean,
        storage.date,
        storage.timestamp,
        storage.status,
        storage.choice,
        storage.moneyAmountMinor,
        storage.moneyCurrency,
        storage.merchantOperatorReference,
        storage.externalResourceReference,
      );
  }
}

function attributeAssignmentFromStored(
  row: StoredAttributeRow,
  definitions: readonly AttributeDefinition[],
): AttributeValueAssignment {
  const definition = definitions.find((entry) => entry.id === row.attributeId);
  if (definition === undefined)
    throw new Error(
      `Stored attribute is not in the published schema: ${row.attributeId}`,
    );
  return {
    attributeId: definition.id,
    scope: definition.scope,
    definitionRevision: definition.revision,
    sensitivity: definition.sensitivity,
    value: parseAttributeValue(storedValue(row)),
  };
}

export function storedValue(row: StoredAttributeRow): unknown {
  switch (row.valueKind) {
    case "short_text":
      return {
        kind: row.valueKind,
        value: required(row.shortTextValue, row.valueKind),
      };
    case "long_text":
      return {
        kind: row.valueKind,
        value: required(row.longTextValue, row.valueKind),
      };
    case "integer":
      return {
        kind: row.valueKind,
        value: required(row.integerValue, row.valueKind),
      };
    case "decimal":
      return {
        kind: row.valueKind,
        value: parseJson(required(row.decimalValue, row.valueKind)),
      };
    case "boolean":
      return {
        kind: row.valueKind,
        value: required(row.booleanValue, row.valueKind) === 1,
      };
    case "date":
      return {
        kind: row.valueKind,
        value: required(row.dateValue, row.valueKind),
      };
    case "timestamp":
      return {
        kind: row.valueKind,
        value: required(row.timestampValue, row.valueKind),
      };
    case "status":
      return {
        kind: row.valueKind,
        value: required(row.statusValue, row.valueKind),
      };
    case "choice":
      return {
        kind: row.valueKind,
        values: parseJson(required(row.choiceValue, row.valueKind)),
      };
    case "money":
      return {
        kind: row.valueKind,
        value: {
          amountMinor: required(row.moneyAmountMinor, row.valueKind),
          currency: required(row.moneyCurrency, row.valueKind),
        },
      };
    case "merchant_operator_reference":
      return {
        kind: row.valueKind,
        value: parseJson(
          required(row.merchantOperatorReferenceValue, row.valueKind),
        ),
      };
    case "external_resource_reference":
      return {
        kind: row.valueKind,
        value: parseJson(
          required(row.externalResourceReferenceValue, row.valueKind),
        ),
      };
  }
}

type StoredFields = Readonly<{
  shortText: string | null;
  longText: string | null;
  integer: number | null;
  decimal: string | null;
  boolean: number | null;
  date: string | null;
  timestamp: string | null;
  status: string | null;
  choice: string | null;
  moneyAmountMinor: number | null;
  moneyCurrency: string | null;
  merchantOperatorReference: string | null;
  externalResourceReference: string | null;
}>;

export function storageFields(value: AttributeValue): StoredFields {
  return {
    shortText: value.kind === "short_text" ? value.value : null,
    longText: value.kind === "long_text" ? value.value : null,
    integer: value.kind === "integer" ? Number(value.value) : null,
    decimal: value.kind === "decimal" ? JSON.stringify(value.value) : null,
    boolean: value.kind === "boolean" ? (value.value ? 1 : 0) : null,
    date: value.kind === "date" ? value.value : null,
    timestamp: value.kind === "timestamp" ? value.value : null,
    status: value.kind === "status" ? value.value : null,
    choice: value.kind === "choice" ? JSON.stringify(value.values) : null,
    moneyAmountMinor: value.kind === "money" ? value.value.amountMinor : null,
    moneyCurrency: value.kind === "money" ? value.value.currency : null,
    merchantOperatorReference:
      value.kind === "merchant_operator_reference"
        ? JSON.stringify(value.value)
        : null,
    externalResourceReference:
      value.kind === "external_resource_reference"
        ? JSON.stringify(value.value)
        : null,
  };
}

function definition(
  typeId: SystemKind,
  table: string,
  idColumn: string,
  displayColumn: string | null,
  occurredColumn: string,
  payloadColumn: string | null,
  resourceKind: string | null,
  resourceType: CommerceResourceType,
): CommerceEntityDefinition {
  return {
    typeId,
    table,
    idColumn,
    displayColumn,
    occurredColumn,
    payloadColumn,
    resourceKind,
    resourceType,
  };
}

function definitionFor(typeId: SystemKind): CommerceEntityDefinition {
  const result = SYSTEM_ENTITY_DEFINITIONS.find(
    (entry) => entry.typeId === typeId,
  );
  if (result === undefined)
    throw new Error(`System entity type is unavailable: ${typeId}`);
  return result;
}

function canonicalRevisionExpression(
  definition: CommerceEntityDefinition,
): string {
  return definition.table === "stock_movement" ? "1" : "revision";
}

function parseCustomTypeId(value: string): CustomCommerceEntityTypeId {
  const reference = parseEntityRef({
    origin: "custom",
    typeId: value,
    entityId: "placeholder",
  });
  if (reference.origin !== "custom")
    throw new Error("custom entity type identity is invalid");
  return reference.typeId;
}

function displayNameFromPayload(
  entityId: string,
  payload: BoundaryObject | null,
): string {
  const candidates = [
    payload?.name,
    payload?.title,
    payload?.code,
    payload?.sku,
  ];
  const displayName = candidates.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return displayName ?? entityId;
}

type BoundaryObject = { readonly [key: string]: unknown };

function parseJsonObject(value: string): BoundaryObject {
  const parsed = parseJson(value);
  if (!isRecord(parsed))
    throw new Error("Stored resource payload must be an object");
  return parsed;
}

function required<T>(value: T | null, kind: string): T {
  if (value === null)
    throw new Error(`Stored ${kind} attribute is missing its value`);
  return value;
}
