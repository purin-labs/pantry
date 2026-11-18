import type {
  AttributeDefinition,
  AttributeDefinitionId,
  CommerceEntityPlaneError,
  CommerceEntityTypeId,
  CommerceListId,
  CommerceListRevision,
  CustomCommerceEntityTypeId,
  CustomEntityTypeRevision,
  SavedCommerceView,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
  SystemCommerceEntityRef,
  SystemSchemaRevision,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  parseCommerceList,
  parseCustomEntityTypeDraft,
  parsePositiveRevision,
  parseSavedCommerceView,
} from "./parsers.ts";
import { listRelationshipDefinitions } from "./relationships.ts";
import { canonicalSystemAttributeDefinitions } from "./commerce-attribute-relation.ts";
import {
  relationshipDefinitionReference,
  sameRelationshipDefinitionRef,
} from "@seams/commerce-contracts/commerce-relationship-references";

export function savedViewPlanContext(
  database: CommerceDatabase,
  merchantId: string,
  viewId: SavedCommerceViewId,
) {
  const row = database
    .prepare(
      `SELECT view.revision, view.definition_json AS definitionJson
       FROM saved_commerce_view AS view
       JOIN saved_commerce_view_head AS head
         ON head.merchant_id = view.merchant_id
        AND head.view_id = view.view_id
        AND head.published_revision = view.revision
      WHERE view.merchant_id = ? AND view.view_id = ?`,
    )
    .get<Readonly<{ revision: number; definitionJson: string }>>(
      merchantId,
      viewId,
    );
  if (row === undefined) return null;
  const view = parseSavedCommerceView(JSON.parse(row.definitionJson));
  const source =
    view.source.kind === "commerce_list"
      ? listCapability(database, merchantId, view.source.listId)
      : view.source.entityTypeId.origin === "system"
        ? systemCapability(
            database,
            merchantId,
            view.source.entityTypeId.typeId,
          )
        : customCapability(
            database,
            merchantId,
            view.source.entityTypeId.typeId,
          );
  if (source === null) return null;
  return {
    capability: {
      kind: "saved_commerce_view" as const,
      viewId,
      viewRevision: parsePositiveRevision<SavedCommerceViewRevision>(
        row.revision,
        "savedView.revision",
      ),
      source,
      filter: view.filter,
      sorts: view.sorts,
    },
    visibleAttributeIds: view.visibleAttributeIds,
    relationshipDefinitions: view.relationshipColumns.map(
      (column) => column.relationshipDefinition,
    ),
  };
}

export function validateSavedViewPublication(
  database: CommerceDatabase,
  merchantId: string,
  view: SavedCommerceView,
): CommerceEntityPlaneError | undefined {
  const source =
    view.source.kind === "commerce_list"
      ? listCapability(database, merchantId, view.source.listId)
      : view.source.entityTypeId.origin === "system"
        ? systemCapability(
            database,
            merchantId,
            view.source.entityTypeId.typeId,
          )
        : customCapability(
            database,
            merchantId,
            view.source.entityTypeId.typeId,
          );
  if (source === null) return { code: "invalid_view_source" };
  const attributeIds = new Set(
    source.capability.filterableAttributeIds.map(String),
  );
  const visibleAttributeIds = view.visibleAttributeIds.map(String);
  if (
    visibleAttributeIds.some((attributeId) => !attributeIds.has(attributeId))
  ) {
    return { code: "invalid_view_source" };
  }
  for (const sort of view.sorts) {
    if (
      sort.field.kind === "attribute" &&
      !attributeIds.has(String(sort.field.attributeId))
    ) {
      return { code: "invalid_view_source" };
    }
  }
  if (
    view.grouping !== null &&
    !attributeIds.has(String(view.grouping.attributeId))
  ) {
    return { code: "invalid_view_source" };
  }
  if (view.presentation.kind === "board") {
    if (
      view.source.kind !== "commerce_list" ||
      !attributeIds.has(String(view.presentation.configuration.laneAttributeId))
    ) {
      return { code: "invalid_view_presentation" };
    }
    if (
      view.presentation.configuration.cardAttributeIds.some(
        (attributeId) => !attributeIds.has(String(attributeId)),
      )
    ) {
      return { code: "invalid_view_presentation" };
    }
  }
  const definitions = listRelationshipDefinitions(database, merchantId);
  for (const column of view.relationshipColumns) {
    const definition = definitions.find((candidate) =>
      sameRelationshipDefinitionRef(
        relationshipDefinitionReference(candidate),
        column.relationshipDefinition,
      ),
    );
    if (definition === undefined) return { code: "invalid_view_source" };
    if (
      view.source.kind === "entity_type" &&
      definition.origin === "custom" &&
      !sameEntityTypeId(definition.sourceType, view.source.entityTypeId)
    ) {
      return { code: "invalid_view_source" };
    }
  }
  return undefined;
}

export function listCapability(
  database: CommerceDatabase,
  merchantId: string,
  listId: CommerceListId | null,
) {
  if (listId === null) return null;
  const row = database
    .prepare(
      `SELECT published_revision AS publishedRevision
       FROM commerce_list_head
      WHERE merchant_id = ? AND list_id = ?`,
    )
    .get<Readonly<{ publishedRevision: number | null }>>(merchantId, listId);
  if (row?.publishedRevision === null || row?.publishedRevision === undefined)
    return null;
  const list = database
    .prepare(
      `SELECT definition_json AS definitionJson FROM commerce_list
     WHERE merchant_id = ? AND list_id = ? AND revision = ?`,
    )
    .get<Readonly<{ definitionJson: string }>>(
      merchantId,
      listId,
      row.publishedRevision,
    );
  if (list === undefined) return null;
  const definition = parseCommerceList(JSON.parse(list.definitionJson));
  const attributeIds = definition.entryAttributeDefinitions.map(
    (entry) => entry.attributeId,
  );
  return {
    kind: "commerce_list" as const,
    listId,
    listRevision: parsePositiveRevision<CommerceListRevision>(
      row.publishedRevision,
      "list.publishedRevision",
    ),
    capability: {
      filterableAttributeIds: attributeIds,
      sortableAttributeIds: attributeIds,
      aggregation: { kind: "count_only" as const },
    },
  };
}

export function customCapability(
  database: CommerceDatabase,
  merchantId: string,
  entityTypeId: string,
) {
  const row = database
    .prepare(
      `SELECT published_revision AS publishedRevision
       FROM custom_entity_type_head
      WHERE merchant_id = ? AND entity_type_id = ?`,
    )
    .get<Readonly<{ publishedRevision: number | null }>>(
      merchantId,
      entityTypeId,
    );
  if (row?.publishedRevision === null || row?.publishedRevision === undefined)
    return null;
  const definition = database
    .prepare(
      `SELECT definition_json AS definitionJson FROM custom_entity_type
     WHERE merchant_id = ? AND entity_type_id = ? AND revision = ?`,
    )
    .get<Readonly<{ definitionJson: string }>>(
      merchantId,
      entityTypeId,
      row.publishedRevision,
    );
  if (definition === undefined) return null;
  const type = parseCustomEntityTypeDraft(
    JSON.parse(definition.definitionJson),
  );
  const attributeIds = type.attributes.map((attribute) => attribute.id);
  return {
    kind: "underclerk_custom" as const,
    entityTypeId: parsePositiveText<CustomCommerceEntityTypeId>(
      entityTypeId,
      "custom.entityTypeId",
    ),
    publishedRevision: parsePositiveRevision<CustomEntityTypeRevision>(
      row.publishedRevision,
      "custom.publishedRevision",
    ),
    capability: {
      filterableAttributeIds: attributeIds,
      sortableAttributeIds: attributeIds,
      aggregation: { kind: "count_only" as const },
    },
  };
}

export function systemCapability(
  database: CommerceDatabase,
  merchantId: string,
  typeId: SystemCommerceEntityRef["typeId"],
) {
  const canonicalAttributeIds =
    canonicalSystemAttributeDefinitions(typeId).map(canonicalAttributeId);
  const extensionRows = database
    .prepare(
      `SELECT attribute_id AS attributeId
       FROM system_entity_extension_attribute_definition AS definition
       JOIN system_entity_extension_schema_head AS head
         ON head.merchant_id = definition.merchant_id
        AND head.system_entity_type_id = definition.system_entity_type_id
        AND head.published_revision = definition.extension_schema_revision
      WHERE definition.merchant_id = ? AND definition.system_entity_type_id = ?
      ORDER BY definition.attribute_id`,
    )
    .all<Readonly<{ attributeId: string }>>(merchantId, typeId);
  const attributeIds = [
    ...canonicalAttributeIds,
    ...extensionRows.map((row) =>
      parsePositiveText<AttributeDefinitionId>(
        row.attributeId,
        "system.extensionAttributeId",
      ),
    ),
  ];
  return {
    kind: "system_mapped" as const,
    systemEntityKind: typeId,
    systemSchemaRevision: parsePositiveRevision<SystemSchemaRevision>(
      1,
      "system.schemaRevision",
    ),
    capability: {
      filterableAttributeIds: attributeIds,
      sortableAttributeIds: attributeIds,
      aggregation: { kind: "count_only" as const },
    },
  };
}

function canonicalAttributeId(
  definition: AttributeDefinition,
): AttributeDefinitionId {
  return definition.id;
}

function sameEntityTypeId(
  left: CommerceEntityTypeId,
  right: CommerceEntityTypeId,
): boolean {
  return left.origin === right.origin && left.typeId === right.typeId;
}

function parsePositiveText<T extends string>(value: unknown, field: string): T {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be normalized text`);
  }
  if (!isPositiveText<T>(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function isPositiveText<T extends string>(value: string): value is T {
  return value.length > 0 && value === value.trim();
}
