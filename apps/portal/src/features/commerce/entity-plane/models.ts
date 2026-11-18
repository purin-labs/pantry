import type {
  AttributeDefinitionId,
  AttributeValue,
  CommerceBoardViewConfiguration,
  CommerceCursor,
  CommerceEntity,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceFreshness,
  CommerceGraphQueryResult,
  CommerceList,
  CommerceListEntry,
  CommerceListEntryRef,
  CommerceRelationship,
  CommerceSnapshotRevision,
  CommerceViewPresentation,
  SavedCommerceView,
  ListEntryAttributeValue,
} from "@seams/contracts";

import type {
  CommerceCollectionSelection,
  CommercePublishedResourceMetadata,
} from "./api";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type CommerceEntityTableRow = Readonly<{
  entity: CommerceEntity;
  relationships: readonly CommerceRelationship[];
}>;

export type CommerceEntityTableModel = Readonly<{
  kind: "entity_type_table";
  entityTypeId: CommerceEntityTypeId;
  merchantRevision: CommerceSnapshotRevision;
  rows: readonly CommerceEntityTableRow[];
  nextCursor: CommerceCursor | null;
}>;

export type CommerceRelationshipTraversalModel = Readonly<{
  kind: "relationship_traversal";
  seed: CommerceEntityRef;
  entities: readonly CommerceEntity[];
  relationships: readonly CommerceRelationship[];
}>;

export type CommerceEntityDossierModel = Readonly<{
  kind: "entity_dossier";
  entity: CommerceEntity;
  traversal: CommerceRelationshipTraversalModel;
  contextualListEntries: readonly CommerceListEntry[];
  provenance: CommerceGraphQueryResult["provenance"];
  freshness: readonly CommerceFreshness[];
}>;

export type CommerceListTableRow = Readonly<{
  entity: CommerceEntity;
  entry: CommerceListEntry;
  contextualAttributes: readonly ListEntryAttributeValue[];
}>;

export type CommerceListTableModel = Readonly<{
  kind: "commerce_list_table";
  list: CommerceList;
  merchantRevision: CommerceSnapshotRevision;
  rows: readonly CommerceListTableRow[];
}>;

export type CommerceBoardLane = Readonly<{
  key: string;
  rows: readonly CommerceListTableRow[];
}>;

export type CommerceBoardModel = Readonly<{
  kind: "commerce_board";
  list: CommerceList;
  configuration: CommerceBoardViewConfiguration;
  merchantRevision: CommerceSnapshotRevision;
  lanes: readonly CommerceBoardLane[];
}>;

export type CommerceModelError =
  | Readonly<{ kind: "entity_not_found"; reference: CommerceEntityRef }>
  | Readonly<{
      kind: "list_entry_entity_not_found";
      entry: CommerceListEntryRef;
    }>
  | Readonly<{
      kind: "published_resource_definition_unavailable";
      source: CommerceCollectionSelection;
    }>;

export type CommerceModelResult<TModel> =
  | Readonly<{ ok: true; value: TModel }>
  | Readonly<{ ok: false; error: CommerceModelError }>;

export type CommerceCollectionRow = Readonly<{
  entity: CommerceEntity;
  entry: CommerceListEntry;
}>;

type CommerceTablePresentation = Variant<CommerceViewPresentation, "table">;
type CommerceBoardPresentation = Variant<CommerceViewPresentation, "board">;

export type CommercePublishedCollectionModel =
  | Readonly<{
      kind: "commerce_collection";
      mode: "commerce_list";
      source: Variant<CommerceCollectionSelection, "commerce_list">;
      merchantRevision: CommerceSnapshotRevision;
      list: CommerceList;
      view: null;
      presentation: null;
      board: null;
      rows: readonly CommerceCollectionRow[];
      entityRows: readonly [];
      attributeIds: readonly AttributeDefinitionId[];
    }>
  | Readonly<{
      kind: "commerce_collection";
      mode: "saved_entity_view";
      source: Variant<CommerceCollectionSelection, "saved_commerce_view">;
      merchantRevision: CommerceSnapshotRevision;
      list: null;
      view: SavedCommerceView;
      presentation: CommerceTablePresentation;
      board: null;
      rows: readonly [];
      entityRows: readonly CommerceEntity[];
      attributeIds: readonly AttributeDefinitionId[];
    }>
  | Readonly<{
      kind: "commerce_collection";
      mode: "saved_list_table";
      source: Variant<CommerceCollectionSelection, "saved_commerce_view">;
      merchantRevision: CommerceSnapshotRevision;
      list: CommerceList;
      view: SavedCommerceView;
      presentation: CommerceTablePresentation;
      board: null;
      rows: readonly CommerceCollectionRow[];
      entityRows: readonly [];
      attributeIds: readonly AttributeDefinitionId[];
    }>
  | Readonly<{
      kind: "commerce_collection";
      mode: "saved_list_board";
      source: Variant<CommerceCollectionSelection, "saved_commerce_view">;
      merchantRevision: CommerceSnapshotRevision;
      list: CommerceList;
      view: SavedCommerceView;
      presentation: CommerceBoardPresentation;
      board: CommerceBoardModel;
      rows: readonly CommerceCollectionRow[];
      entityRows: readonly [];
      attributeIds: readonly AttributeDefinitionId[];
    }>;

export type CommerceCollectionDefinition = Readonly<{
  selection: CommerceCollectionSelection;
  list: CommerceList | null;
  view: SavedCommerceView | null;
}>;

export function buildEntityTypeTableModel(
  result: CommerceGraphQueryResult,
  entityTypeId: CommerceEntityTypeId,
): CommerceEntityTableModel {
  const rows = result.entities
    .filter((entity) => entityTypeMatches(entity.reference, entityTypeId))
    .map((entity) => ({
      entity,
      relationships: result.relationships.filter(
        (relationship) =>
          sameEntityRef(relationship.source, entity.reference) ||
          sameEntityRef(relationship.target, entity.reference),
      ),
    }));

  return {
    kind: "entity_type_table",
    entityTypeId,
    merchantRevision: result.merchantRevision,
    rows,
    nextCursor: result.nextCursor,
  };
}

export function buildCommerceRelationshipTraversalModel(
  result: CommerceGraphQueryResult,
  seed: CommerceEntityRef,
): CommerceModelResult<CommerceRelationshipTraversalModel> {
  if (
    !result.entities.some((entity) => sameEntityRef(entity.reference, seed))
  ) {
    return { ok: false, error: { kind: "entity_not_found", reference: seed } };
  }

  return {
    ok: true,
    value: {
      kind: "relationship_traversal",
      seed,
      entities: result.entities,
      relationships: result.relationships,
    },
  };
}

export function buildCommerceEntityDossierModel(
  result: CommerceGraphQueryResult,
  reference: CommerceEntityRef,
): CommerceModelResult<CommerceEntityDossierModel> {
  const entity = result.entities.find((candidate) =>
    sameEntityRef(candidate.reference, reference),
  );
  if (entity === undefined)
    return { ok: false, error: { kind: "entity_not_found", reference } };

  const traversal = buildCommerceRelationshipTraversalModel(result, reference);
  if (!traversal.ok) return traversal;

  return {
    ok: true,
    value: {
      kind: "entity_dossier",
      entity,
      traversal: traversal.value,
      contextualListEntries: result.listEntries.filter((entry) =>
        sameEntityRef(entry.entityRef, reference),
      ),
      provenance: result.provenance,
      freshness: result.freshness,
    },
  };
}

export function buildCommerceListTableModel(
  result: CommerceGraphQueryResult,
  list: CommerceList,
): CommerceModelResult<CommerceListTableModel> {
  const rows: CommerceListTableRow[] = [];
  const entries = result.listEntries.filter(
    (entry) =>
      entry.listId === list.listId &&
      entry.listRevision === list.publishedRevision,
  );

  for (const entry of entries) {
    const entity = result.entities.find((candidate) =>
      sameEntityRef(candidate.reference, entry.entityRef),
    );
    if (
      entity === undefined ||
      !entityTypeMatches(entity.reference, list.entityTypeId)
    ) {
      return {
        ok: false,
        error: {
          kind: "list_entry_entity_not_found",
          entry: {
            entryId: entry.entryId,
            listId: entry.listId,
            revision: entry.revision,
          },
        },
      };
    }
    rows.push({ entity, entry, contextualAttributes: entry.attributeValues });
  }

  return {
    ok: true,
    value: {
      kind: "commerce_list_table",
      list,
      merchantRevision: result.merchantRevision,
      rows,
    },
  };
}

export function buildCommerceBoardModel(
  result: CommerceGraphQueryResult,
  list: CommerceList,
  configuration: CommerceBoardViewConfiguration,
): CommerceModelResult<CommerceBoardModel> {
  const table = buildCommerceListTableModel(result, list);
  if (!table.ok) return table;

  const groups = new Map<string, CommerceListTableRow[]>();
  for (const row of table.value.rows) {
    const laneAttribute = row.contextualAttributes.find(
      (attribute) => attribute.attributeId === configuration.laneAttributeId,
    );
    const laneKey =
      laneAttribute === undefined
        ? "unassigned"
        : attributeValueKey(laneAttribute.value);
    const laneRows = groups.get(laneKey);
    if (laneRows === undefined) {
      groups.set(laneKey, [row]);
    } else {
      laneRows.push(row);
    }
  }

  return {
    ok: true,
    value: {
      kind: "commerce_board",
      list,
      configuration,
      merchantRevision: table.value.merchantRevision,
      lanes: Array.from(groups.entries(), ([key, rows]) => ({ key, rows })),
    },
  };
}

export function findCommerceCollectionDefinition(
  metadata: CommercePublishedResourceMetadata,
  selection: CommerceCollectionSelection,
): CommerceCollectionDefinition | null {
  if (selection.kind === "commerce_list") {
    const list = metadata.lists.find(
      (candidate) => candidate.listId === selection.listId,
    );
    return list === undefined ? null : { selection, list, view: null };
  }
  const view = metadata.views.find(
    (candidate) => candidate.viewId === selection.viewId,
  );
  if (view === undefined) return null;
  const source = view.source;
  switch (source.kind) {
    case "entity_type":
      return { selection, list: null, view };
    case "commerce_list": {
      const list = metadata.lists.find(
        (candidate) => candidate.listId === source.listId,
      );
      return list === undefined ? null : { selection, list, view };
    }
    default:
      return assertNever(source, "Unexpected commerce attribute value");
  }
}

export function buildPublishedCommerceCollectionModel(
  result: CommerceGraphQueryResult,
  definition: CommerceCollectionDefinition,
): CommerceModelResult<CommercePublishedCollectionModel> {
  const { selection, list, view } = definition;
  if (selection.kind === "commerce_list") {
    if (list === null) return publishedCollectionDefinitionError(selection);
    const table = buildCommerceListTableModel(result, list);
    if (!table.ok) return table;
    return {
      ok: true,
      value: {
        kind: "commerce_collection",
        mode: "commerce_list",
        source: selection,
        merchantRevision: table.value.merchantRevision,
        list,
        view: null,
        presentation: null,
        board: null,
        rows: table.value.rows.map(({ entity, entry }) => ({ entity, entry })),
        entityRows: [],
        attributeIds: list.entryAttributeDefinitions.map(
          (attribute) => attribute.attributeId,
        ),
      },
    };
  }
  if (view === null) return publishedCollectionDefinitionError(selection);
  const source = view.source;
  switch (source.kind) {
    case "entity_type": {
      const entityRows = result.entities.filter((entity) =>
        entityTypeMatches(entity.reference, source.entityTypeId),
      );
      if (view.presentation.kind !== "table")
        return publishedCollectionDefinitionError(selection);
      return {
        ok: true,
        value: {
          kind: "commerce_collection",
          mode: "saved_entity_view",
          source: selection,
          merchantRevision: result.merchantRevision,
          list: null,
          view,
          presentation: view.presentation,
          board: null,
          rows: [],
          entityRows,
          attributeIds: view.visibleAttributeIds,
        },
      };
    }
    case "commerce_list": {
      if (list === null) return publishedCollectionDefinitionError(selection);
      const table = buildCommerceListTableModel(result, list);
      if (!table.ok) return table;
      const rows = table.value.rows.map(({ entity, entry }) => ({
        entity,
        entry,
      }));
      if (view.presentation.kind === "table") {
        return {
          ok: true,
          value: {
            kind: "commerce_collection",
            mode: "saved_list_table",
            source: selection,
            merchantRevision: table.value.merchantRevision,
            list,
            view,
            presentation: view.presentation,
            board: null,
            rows,
            entityRows: [],
            attributeIds: view.visibleAttributeIds,
          },
        };
      }
      const board = buildCommerceBoardModel(
        result,
        list,
        view.presentation.configuration,
      );
      if (!board.ok) return board;
      return {
        ok: true,
        value: {
          kind: "commerce_collection",
          mode: "saved_list_board",
          source: selection,
          merchantRevision: table.value.merchantRevision,
          list,
          view,
          presentation: view.presentation,
          board: board.value,
          rows,
          entityRows: [],
          attributeIds: view.visibleAttributeIds,
        },
      };
    }
    default:
      return assertNever(source, "Unexpected commerce attribute value");
  }
}

function entityTypeMatches(
  reference: CommerceEntityRef,
  entityTypeId: CommerceEntityTypeId,
): boolean {
  return (
    reference.origin === entityTypeId.origin &&
    reference.typeId === entityTypeId.typeId
  );
}

function sameEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function attributeValueKey(value: AttributeValue): string {
  switch (value.kind) {
    case "short_text":
    case "long_text":
    case "date":
    case "timestamp":
    case "status":
      return value.value;
    case "integer":
      return value.value.toString();
    case "decimal":
      return `${value.value.unscaled}e${value.value.scale}`;
    case "boolean":
      return value.value ? "true" : "false";
    case "choice":
      return value.values.join(",");
    case "money":
      return `${value.value.currency}:${value.value.amountMinor}`;
    case "merchant_operator_reference":
      return value.value.principalId;
    case "external_resource_reference":
      return `${value.value.source}:${value.value.resourceId}`;
    default:
      return assertNever(value, "Unexpected commerce attribute value");
  }
}

function publishedCollectionDefinitionError(
  source: CommerceCollectionSelection,
): CommerceModelResult<never> {
  return {
    ok: false,
    error: { kind: "published_resource_definition_unavailable", source },
  };
}
