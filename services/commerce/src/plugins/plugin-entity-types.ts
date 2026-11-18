// Entity types that a merchant plugin adds (Plan 77 step 4). The installation
// creates and publishes each type in the entity plane, in the same commit, and
// records the plugin as its owner. Staff and agents add records through the
// entity plane; the plugin's functions read the active ones as `records`. A
// later version with other attributes publishes the type's next revision, and
// each record keeps the revision that it was written at. Removing the plugin
// keeps the type and its records.
import type { CommercePluginEntityTypeV1 } from "@seams/commerce-client";
import type {
  CustomCommerceEntityTypeDraft,
  CustomCommerceEntityTypeId,
} from "@seams/commerce-contracts";

import type { CommerceDatabase } from "../database.ts";
import {
  publishCustomEntityType,
  readCustomEntityType,
  writeCustomEntityType,
} from "../entity-plane/entities.ts";
import { parseCustomEntityTypeDraft } from "../entity-plane/parsers.ts";

/** The records of one type that a function reads, at most. */
const RECORDS_PER_TYPE = 200;

const ATTRIBUTE_KINDS = {
  short_text: { kind: "short_text", maxLength: 300 },
  integer: { kind: "integer", minimum: null, maximum: null },
  boolean: { kind: "boolean" },
  date: { kind: "date" },
  timestamp: { kind: "timestamp" },
} as const;

/** A type to publish at the installation, at its next revision. */
type PluginEntityTypeWrite = Readonly<{
  draft: CustomCommerceEntityTypeDraft;
}>;

/**
 * The type revisions that an installation publishes, or the invalid field.
 * A type that the merchant or another plugin made is refused; a type that
 * has not changed is not published again.
 */
export function planPluginEntityTypes(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  types: readonly CommercePluginEntityTypeV1[],
): readonly PluginEntityTypeWrite[] | "entityTypes" {
  const writes: PluginEntityTypeWrite[] = [];
  for (const type of types) {
    const typeId = type.typeId as CustomCommerceEntityTypeId;
    const existing = readCustomEntityType(database, merchantId, typeId);
    if (
      existing !== undefined &&
      entityTypeOwner(database, merchantId, type.typeId) !== pluginId
    )
      return "entityTypes";
    let draft: CustomCommerceEntityTypeDraft;
    try {
      if (
        existing !== undefined &&
        sameDefinition(
          draftOf(type, Number(existing.revision)),
          existing.definition,
        )
      )
        continue;
      draft = draftOf(type, Number(existing?.revision ?? 0) + 1);
    } catch {
      return "entityTypes";
    }
    writes.push({ draft });
  }
  return writes;
}

/**
 * Publishes the planned types and records their owner. The entity plane's
 * change feed gets one change for each type at the installation's merchant
 * revision.
 */
export function writePluginEntityTypes(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  writes: readonly PluginEntityTypeWrite[],
  merchantRevision: number,
  at: string,
): void {
  for (const { draft } of writes) {
    writeCustomEntityType(database, merchantId, draft, at);
    publishCustomEntityType(
      database,
      merchantId,
      draft.typeId,
      Number(draft.revision),
      at,
    );
    database
      .prepare(
        `INSERT INTO merchant_plugin_entity_type (
           merchant_id, entity_type_id, plugin_id
         ) VALUES (?, ?, ?)
         ON CONFLICT (merchant_id, entity_type_id) DO NOTHING`,
      )
      .run(merchantId, draft.typeId, pluginId);
    const resource = {
      kind: "entity_type",
      typeId: { origin: "custom", typeId: draft.typeId },
    };
    database
      .prepare(
        `INSERT INTO entity_plane_change (
           merchant_id, change_id, merchant_revision, change_kind,
           resource_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'entity_type', ?, ?, ?)`,
      )
      .run(
        merchantId,
        `${merchantId}:plugin_install:${merchantRevision}:${draft.typeId}`,
        merchantRevision,
        draft.typeId,
        JSON.stringify({ operation: "published", resource }),
        at,
      );
  }
}

/** The plugin that added a type, or undefined for any other type. */
export function entityTypeOwner(
  database: CommerceDatabase,
  merchantId: string,
  typeId: string,
): string | undefined {
  return database
    .prepare(
      `SELECT plugin_id AS pluginId FROM merchant_plugin_entity_type
       WHERE merchant_id = ? AND entity_type_id = ?`,
    )
    .get<Readonly<{ pluginId: string }>>(merchantId, typeId)?.pluginId;
}

type RecordValueRow = Readonly<{
  entityId: string;
  displayName: string;
  attributeId: string | null;
  valueKind: string | null;
  shortTextValue: string | null;
  integerValue: number | null;
  booleanValue: number | null;
  dateValue: string | null;
  timestampValue: string | null;
}>;

type PluginRecord = Readonly<{
  entityId: string;
  displayName: string;
  values: Readonly<Record<string, string | number | boolean>>;
}>;

/**
 * The active records of each type that the plugin's installed version
 * names, by type id, in entity id order; undefined when it names none.
 */
export function readPluginRecords(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): Readonly<Record<string, readonly PluginRecord[]>> | undefined {
  const named = database
    .prepare(
      `SELECT json_extract(version.definition_json,
                '$.contributions.entityTypes') AS typesJson
       FROM merchant_plugin_installation AS installation
       JOIN merchant_plugin_version AS version
         ON version.merchant_id = installation.merchant_id
        AND version.plugin_id = installation.plugin_id
        AND version.version = installation.version
       WHERE installation.merchant_id = ? AND installation.plugin_id = ?`,
    )
    .get<Readonly<{ typesJson: string | null }>>(merchantId, pluginId);
  const typeIds = JSON.parse(named?.typesJson ?? "[]") as readonly string[];
  if (typeIds.length === 0) return undefined;
  const records: Record<string, PluginRecord[]> = {};
  for (const typeId of typeIds) {
    const rows = database
      .prepare(
        `SELECT entity.entity_id AS entityId,
                entity.display_name AS displayName,
                value.attribute_id AS attributeId,
                value.value_kind AS valueKind,
                value.short_text_value AS shortTextValue,
                value.integer_value AS integerValue,
                value.boolean_value AS booleanValue,
                value.date_value AS dateValue,
                value.timestamp_value AS timestampValue
         FROM (
           SELECT entity_id, display_name, revision FROM custom_entity
           WHERE merchant_id = ? AND entity_type_id = ?
             AND lifecycle_state = 'active'
           ORDER BY entity_id LIMIT ?
         ) AS entity
         LEFT JOIN custom_entity_attribute_value AS value
           ON value.merchant_id = ? AND value.entity_id = entity.entity_id
          AND value.entity_revision = entity.revision
         ORDER BY entity.entity_id, value.attribute_id`,
      )
      .all<RecordValueRow>(merchantId, typeId, RECORDS_PER_TYPE, merchantId);
    const byEntity = new Map<
      string,
      { displayName: string; values: Record<string, string | number | boolean> }
    >();
    for (const row of rows) {
      const record = byEntity.get(row.entityId) ?? {
        displayName: row.displayName,
        values: {},
      };
      byEntity.set(row.entityId, record);
      const value = recordValue(row);
      if (row.attributeId !== null && value !== undefined)
        record.values[row.attributeId] = value;
    }
    records[typeId] = [...byEntity].map(([entityId, record]) => ({
      entityId,
      ...record,
    }));
  }
  return records;
}

function recordValue(
  row: RecordValueRow,
): string | number | boolean | undefined {
  switch (row.valueKind) {
    case "short_text":
      return row.shortTextValue ?? undefined;
    case "integer":
      return row.integerValue ?? undefined;
    case "boolean":
      return row.booleanValue === null ? undefined : row.booleanValue === 1;
    case "date":
      return row.dateValue ?? undefined;
    case "timestamp":
      return row.timestampValue ?? undefined;
    default:
      return undefined;
  }
}

/** The entity plane draft of a type at one revision; throws when invalid. */
function draftOf(
  type: CommercePluginEntityTypeV1,
  revision: number,
): CustomCommerceEntityTypeDraft {
  const draft = {
    typeId: type.typeId,
    revision,
    label: type.label,
    description: type.description,
    attributes: type.attributes.map((attribute) => ({
      id: attribute.key,
      scope: {
        kind: "custom",
        entityTypeId: type.typeId,
        typeRevision: revision,
      },
      label: attribute.label,
      helpText: null,
      required: attribute.required,
      sensitivity: "internal",
      kind: ATTRIBUTE_KINDS[attribute.valueKind],
      revision,
    })),
  };
  parseCustomEntityTypeDraft(draft);
  return draft as unknown as CustomCommerceEntityTypeDraft;
}

function sameDefinition(
  draft: CustomCommerceEntityTypeDraft,
  stored: ReturnType<typeof parseCustomEntityTypeDraft>,
): boolean {
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  return json(parseCustomEntityTypeDraft(draft)) === json(stored);
}
