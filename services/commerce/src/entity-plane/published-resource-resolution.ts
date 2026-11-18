import type {
  CommerceEntityType,
  CommerceEntityTypeId,
  CommerceList,
  CommerceListEntryId,
  CommerceListId,
  CommerceMerchantId,
  CommerceSnapshotRevision,
  CustomEntityTypeRevision,
  SavedCommerceView,
  SavedCommerceViewId,
  OrganisationId,
} from "@seams/commerce-contracts";
import type {
  CommerceEntityPlaneExportPresetEvidence,
  CommerceEntityPlanePublishedResource,
  CommerceEntityPlanePublishedResourceMetadataRequest,
  CommerceEntityPlanePublishedResourceMetadataResponse,
  CommerceEntityPlanePublishedResourceReference,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import {
  listCustomEntityTypes,
  listSystemEntityTypeIds,
  readMerchant,
  systemEntityType,
} from "./entities.ts";
import { EntityPlaneHttpError } from "./http-error.ts";
import {
  parseCommerceList,
  parseEntityRef,
  parseEntityTypeId,
  parsePositiveRevision,
  parseSavedCommerceView,
  parseSnapshotRevision,
} from "./parsers.ts";
import { EXPORT_COORDINATION_PRESET } from "./presets.ts";
import { readExactCommerceRelationship } from "./commerce-relationship-relation.ts";
import { listRelationshipDefinitions } from "./relationships.ts";
import { sameJson } from "@seams/std";

type StoredListEntryRow = Readonly<{
  entryId: string;
  listId: string;
  listRevision: number;
  entityOrigin: "system" | "custom";
  entityTypeId: string;
  entityId: string;
  revision: number;
  lifecycleState: "active" | "archived";
}>;

type PublishedListRow = Readonly<{
  listId: string;
  revision: number;
  definitionJson: string;
}>;
type PublishedViewRow = Readonly<{
  viewId: string;
  revision: number;
  definitionJson: string;
}>;

export function readPublishedResourceMetadata(
  database: CommerceDatabase,
  request: CommerceEntityPlanePublishedResourceMetadataRequest,
): CommerceEntityPlanePublishedResourceMetadataResponse {
  const merchant = readMerchant(database, request.merchantId);
  if (merchant === undefined)
    throw new EntityPlaneHttpError(404, "Merchant not found");
  if (merchant.organisationId !== request.organisationId) {
    throw new EntityPlaneHttpError(
      403,
      "Merchant is outside the organisation authority",
      { code: "authority_out_of_scope" },
    );
  }
  const organisationId = parsePositiveText<OrganisationId>(
    request.organisationId,
    "organisationId",
  );
  const merchantId = parsePositiveText<CommerceMerchantId>(
    request.merchantId,
    "merchantId",
  );
  const merchantRevision = parseSnapshotRevision<CommerceSnapshotRevision>(
    merchant.revision,
    "merchantRevision",
  );
  if (request.kind === "enumerate") {
    return {
      kind: "enumerated",
      organisationId,
      merchantId,
      merchantRevision,
      entityTypes: listPublishedEntityTypes(database, request.merchantId),
      lists: listPublishedLists(database, request.merchantId),
      views: listPublishedViews(database, request.merchantId),
    };
  }
  return {
    kind: "resolved",
    organisationId,
    merchantId,
    merchantRevision,
    resource: resolvePublishedResource(
      database,
      request.merchantId,
      request.resource,
    ),
  };
}

export function readExportPresetEvidence(
  database: CommerceDatabase,
  merchantId: string,
): CommerceEntityPlaneExportPresetEvidence {
  const publishedEntityTypes = listPublishedEntityTypes(database, merchantId);
  const publishedDefinitions = listRelationshipDefinitions(
    database,
    merchantId,
  );
  const publishedLists = listPublishedLists(database, merchantId);
  const publishedViews = listPublishedViews(database, merchantId);
  const customEntityTypes = EXPORT_COORDINATION_PRESET.definitions.map(
    (definition) => {
      const entityType = publishedEntityTypes.find(
        (candidate) =>
          candidate.origin === "custom" &&
          String(candidate.typeId) === String(definition.typeId) &&
          Number(candidate.publishedRevision) === 1,
      );
      if (entityType === undefined || entityType.origin !== "custom") {
        throw new Error(
          `Published export preset entity type is missing: ${String(definition.typeId)}`,
        );
      }
      return entityType;
    },
  );
  const relationshipDefinitions =
    EXPORT_COORDINATION_PRESET.relationshipDefinitions.map((expected) => {
      const definition = publishedDefinitions.find(
        (candidate) =>
          candidate.origin === "custom" &&
          String(candidate.definitionId) === String(expected.definitionId) &&
          Number(candidate.revision) === Number(expected.revision),
      );
      if (
        definition === undefined ||
        definition.origin !== "custom" ||
        !sameJson(definition, expected)
      ) {
        throw new Error(
          `Published export preset relationship definition is missing: ${String(expected.definitionId)}`,
        );
      }
      return definition;
    });
  const lists = EXPORT_COORDINATION_PRESET.lists.map((expected) => {
    const list = publishedLists.find(
      (candidate) =>
        String(candidate.listId) === String(expected.listId) &&
        Number(candidate.publishedRevision) ===
          Number(expected.publishedRevision),
    );
    if (list === undefined || !sameJson(list, expected)) {
      throw new Error(
        `Published export preset list is missing: ${String(expected.listId)}`,
      );
    }
    return list;
  });
  const views = EXPORT_COORDINATION_PRESET.views.map((expected) => {
    const view = publishedViews.find(
      (candidate) =>
        String(candidate.viewId) === String(expected.viewId) &&
        Number(candidate.revision) === Number(expected.revision),
    );
    if (view === undefined || !sameJson(view, expected)) {
      throw new Error(
        `Published export preset view is missing: ${String(expected.viewId)}`,
      );
    }
    return view;
  });
  return { customEntityTypes, relationshipDefinitions, lists, views };
}

function listPublishedEntityTypes(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceEntityType[] {
  const system = listSystemEntityTypeIds().map((typeId) =>
    systemEntityType(database, merchantId, typeId),
  );
  const custom = listCustomEntityTypes(database, merchantId).map((entry) => ({
    origin: "custom" as const,
    typeId: entry.definition.typeId,
    publishedRevision: parsePositiveRevision<CustomEntityTypeRevision>(
      entry.revision,
      "entityType.publishedRevision",
    ),
  }));
  return [...system, ...custom];
}

function listPublishedLists(
  database: CommerceDatabase,
  merchantId: string,
): readonly CommerceList[] {
  const rows = database
    .prepare(
      `SELECT list.list_id AS listId, list.revision, list.definition_json AS definitionJson
     FROM commerce_list AS list
     JOIN commerce_list_head AS head
       ON head.merchant_id = list.merchant_id
      AND head.list_id = list.list_id
      AND head.published_revision = list.revision
     WHERE list.merchant_id = ? AND head.lifecycle_state = 'published'
     ORDER BY list.list_id`,
    )
    .all<PublishedListRow>(merchantId);
  return rows.map(parsePublishedListRow);
}

function listPublishedViews(
  database: CommerceDatabase,
  merchantId: string,
): readonly SavedCommerceView[] {
  const rows = database
    .prepare(
      `SELECT view.view_id AS viewId, view.revision, view.definition_json AS definitionJson
     FROM saved_commerce_view AS view
     JOIN saved_commerce_view_head AS head
       ON head.merchant_id = view.merchant_id
      AND head.view_id = view.view_id
      AND head.published_revision = view.revision
     WHERE view.merchant_id = ? AND head.lifecycle_state = 'published'
     ORDER BY view.view_id`,
    )
    .all<PublishedViewRow>(merchantId);
  return rows.map(parsePublishedViewRow);
}

function readPublishedList(
  database: CommerceDatabase,
  merchantId: string,
  listId: CommerceListId,
): CommerceList | undefined {
  const row = database
    .prepare(
      `SELECT list.list_id AS listId, list.revision, list.definition_json AS definitionJson
     FROM commerce_list AS list
     JOIN commerce_list_head AS head
       ON head.merchant_id = list.merchant_id
      AND head.list_id = list.list_id
      AND head.published_revision = list.revision
     WHERE list.merchant_id = ? AND list.list_id = ? AND head.lifecycle_state = 'published'`,
    )
    .get<PublishedListRow>(merchantId, listId);
  return row === undefined ? undefined : parsePublishedListRow(row);
}

function readPublishedView(
  database: CommerceDatabase,
  merchantId: string,
  viewId: SavedCommerceViewId,
): SavedCommerceView | undefined {
  const row = database
    .prepare(
      `SELECT view.view_id AS viewId, view.revision, view.definition_json AS definitionJson
     FROM saved_commerce_view AS view
     JOIN saved_commerce_view_head AS head
       ON head.merchant_id = view.merchant_id
      AND head.view_id = view.view_id
      AND head.published_revision = view.revision
     WHERE view.merchant_id = ? AND view.view_id = ? AND head.lifecycle_state = 'published'`,
    )
    .get<PublishedViewRow>(merchantId, viewId);
  return row === undefined ? undefined : parsePublishedViewRow(row);
}

function resolvePublishedResource(
  database: CommerceDatabase,
  merchantId: string,
  resource: CommerceEntityPlanePublishedResourceReference,
): CommerceEntityPlanePublishedResource {
  switch (resource.kind) {
    case "entity_type": {
      const entityType = listPublishedEntityTypes(database, merchantId).find(
        (candidate) =>
          candidate.origin === resource.entityTypeId.origin &&
          candidate.typeId === resource.entityTypeId.typeId,
      );
      if (entityType === undefined) throw publishedResourceNotFound();
      return { kind: resource.kind, entityType };
    }
    case "relationship": {
      const relationship = readExactCommerceRelationship(
        database,
        merchantId,
        resource.relationship,
      );
      if (relationship === undefined) throw publishedResourceNotFound();
      return { kind: resource.kind, relationship };
    }
    case "commerce_list": {
      const list = readPublishedList(database, merchantId, resource.listId);
      if (list === undefined) throw publishedResourceNotFound();
      return { kind: resource.kind, list };
    }
    case "commerce_list_entry": {
      const row = readListEntry(database, merchantId, resource.entry.entryId);
      if (
        row === undefined ||
        row.lifecycleState !== "active" ||
        row.listId !== resource.entry.listId
      ) {
        throw publishedResourceNotFound();
      }
      const listId = parsePositiveText<CommerceListId>(
        row.listId,
        "listEntry.listId",
      );
      const list = readPublishedList(database, merchantId, listId);
      if (
        list === undefined ||
        Number(list.publishedRevision) !== Number(row.listRevision)
      ) {
        throw publishedResourceNotFound();
      }
      const entityTypeId = parseEntityTypeId({
        origin: row.entityOrigin,
        typeId: row.entityTypeId,
      });
      if (!sameEntityTypeId(entityTypeId, list.entityTypeId))
        throw publishedResourceNotFound();
      const entityRef = parseEntityRef({
        origin: row.entityOrigin,
        typeId: row.entityTypeId,
        entityId: row.entityId,
      });
      return {
        kind: resource.kind,
        entry: {
          entryId: parsePositiveText(row.entryId, "listEntry.entryId"),
          listId,
          revision: parsePositiveRevision(row.revision, "listEntry.revision"),
        },
        listRevision: parsePositiveRevision(
          row.listRevision,
          "listEntry.listRevision",
        ),
        entityTypeId,
        entityRef,
      };
    }
    case "saved_selector": {
      if (resource.selector.query.kind !== "saved_commerce_view")
        throw publishedResourceNotFound();
      const view = readPublishedView(
        database,
        merchantId,
        resource.selector.query.viewId,
      );
      if (
        view === undefined ||
        String(resource.selector.selectorId) !== String(view.viewId) ||
        Number(resource.selector.revision) !== Number(view.revision)
      ) {
        throw publishedResourceNotFound();
      }
      return { kind: resource.kind, selector: resource.selector, view };
    }
  }
}

function readListEntry(
  database: CommerceDatabase,
  merchantId: string,
  entryId: CommerceListEntryId,
): StoredListEntryRow | undefined {
  return database
    .prepare(
      `SELECT entry_id AS entryId, list_id AS listId, list_revision AS listRevision,
            entity_origin AS entityOrigin, entity_type_id AS entityTypeId,
            entity_id AS entityId, revision, lifecycle_state AS lifecycleState
     FROM commerce_list_entry WHERE merchant_id = ? AND entry_id = ?`,
    )
    .get<StoredListEntryRow>(merchantId, entryId);
}

function parsePublishedListRow(row: PublishedListRow): CommerceList {
  const list = parseCommerceList(JSON.parse(row.definitionJson));
  if (
    String(list.listId) !== row.listId ||
    Number(list.publishedRevision) !== Number(row.revision)
  ) {
    throw new Error(`Published Commerce List identity mismatch: ${row.listId}`);
  }
  return list;
}

function parsePublishedViewRow(row: PublishedViewRow): SavedCommerceView {
  const view = parseSavedCommerceView(JSON.parse(row.definitionJson));
  if (
    String(view.viewId) !== row.viewId ||
    Number(view.revision) !== Number(row.revision)
  ) {
    throw new Error(`Published saved view identity mismatch: ${row.viewId}`);
  }
  return view;
}

function publishedResourceNotFound(): never {
  throw new EntityPlaneHttpError(404, "Published resource not found", {
    code: "not_found",
  });
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
