import type {
  CommerceListEntryRef,
  CommerceSnapshotRevision,
  CustomCommerceRelationshipRef,
  MerchantRevision,
  RelationshipRevision,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import type {
  EntityPlaneChange,
  EntityPlaneChangeOperation,
  EntityPlaneChangeRequest,
  EntityPlaneChangeResource,
  EntityPlaneChangeResponse,
} from "./entity-types.ts";
import { EntityPlaneHttpError } from "./http-error.ts";
import {
  parseEntityRef,
  parseEntityTypeId,
  parsePositiveRevision,
  parseRelationshipDefinitionId,
  parseRelationshipId,
  parseSnapshotRevision,
} from "./parsers.ts";
import { readMerchant } from "./entities.ts";
import { customRelationshipDefinitionReference } from "@seams/commerce-contracts/commerce-relationship-references";
import { isRecord } from "@seams/std";

type StoredChangeRow = Readonly<{
  changeId: string;
  merchantRevision: number;
  changeKind: EntityPlaneChange["resource"]["kind"];
  resourceId: string;
  metadataJson: string;
  createdAt: string;
}>;

export function readEntityPlaneChanges(
  database: CommerceDatabase,
  request: EntityPlaneChangeRequest,
): EntityPlaneChangeResponse {
  const merchant = readMerchant(database, request.merchantId);
  if (merchant === undefined)
    throw new EntityPlaneHttpError(404, "Merchant not found");
  // A page holds whole merchant revisions, up to `limit` of them: one
  // revision can hold several changes (a plugin's entity types), and the
  // cursor is a revision, so a page that split one would lose changes.
  const revisions = database
    .prepare(
      `SELECT DISTINCT merchant_revision AS merchantRevision
     FROM entity_plane_change
     WHERE merchant_id = ? AND merchant_revision > ?
     ORDER BY merchant_revision LIMIT ?`,
    )
    .all<Readonly<{ merchantRevision: number }>>(
      request.merchantId,
      request.afterMerchantRevision,
      request.limit + 1,
    );
  const hasMore = revisions.length > request.limit;
  const lastRevision = revisions
    .slice(0, request.limit)
    .at(-1)?.merchantRevision;
  const rows =
    lastRevision === undefined
      ? []
      : database
          .prepare(
            `SELECT change_id AS changeId, merchant_revision AS merchantRevision,
            change_kind AS changeKind, resource_id AS resourceId,
            metadata_json AS metadataJson, created_at AS createdAt
     FROM entity_plane_change
     WHERE merchant_id = ? AND merchant_revision > ? AND merchant_revision <= ?
     ORDER BY merchant_revision, rowid`,
          )
          .all<StoredChangeRow>(
            request.merchantId,
            request.afterMerchantRevision,
            lastRevision,
          );
  const changes = rows.map(parseStoredChange);
  const nextAfterMerchantRevision =
    changes.at(-1)?.merchantRevision ?? request.afterMerchantRevision;
  return {
    merchantId: request.merchantId,
    merchantRevision: parseSnapshotRevision<CommerceSnapshotRevision>(
      merchant.revision,
      "merchantRevision",
    ),
    changes,
    nextAfterMerchantRevision: parseSnapshotRevision<CommerceSnapshotRevision>(
      Number(nextAfterMerchantRevision),
      "nextAfterMerchantRevision",
    ),
    hasMore,
  };
}

function parseStoredChange(row: StoredChangeRow): EntityPlaneChange {
  const metadata = parseRecord(row.metadataJson);
  return {
    changeId: row.changeId,
    merchantRevision: parsePositiveRevision<MerchantRevision>(
      row.merchantRevision,
      "change.merchantRevision",
    ),
    resource: parseChangeResource(
      metadata.resource,
      row.changeKind,
      row.resourceId,
    ),
    operation: parseOperation(metadata.operation),
    createdAt: row.createdAt,
  };
}

function parseChangeResource(
  value: unknown,
  kind: StoredChangeRow["changeKind"],
  resourceId: string,
): EntityPlaneChangeResource {
  const object = isRecord(value) ? value : { kind };
  if (object.kind !== kind)
    throw new Error("Stored entity-plane change resource kind mismatch");
  switch (kind) {
    case "entity_type": {
      if (!isRecord(object.typeId))
        throw new Error("Stored entity type resource is invalid");
      return { kind, typeId: parseEntityTypeId(object.typeId) };
    }
    case "entity": {
      const reference = parseEntityRef(object.ref);
      if (reference.origin !== "custom")
        throw new Error("Stored entity resource is not custom");
      return { kind, ref: reference };
    }
    case "relationship_definition":
      return { kind, definitionId: parseRelationshipDefinitionId(resourceId) };
    case "custom_relationship": {
      if (!isRecord(object.ref))
        throw new Error(
          "Stored custom relationship resource reference is missing",
        );
      return { kind, ref: parseStoredChangeRelationshipReference(object.ref) };
    }
    case "commerce_list":
      return { kind, listId: parsePositiveText(resourceId, "change.listId") };
    case "commerce_list_entry": {
      if (!isRecord(object.ref))
        throw new Error("Stored list entry resource reference is missing");
      return {
        kind,
        ref: listEntryReference(
          parsePositiveText(object.ref.entryId, "change.listEntry.entryId"),
          parsePositiveText(object.ref.listId, "change.listEntry.listId"),
          parseSafeInteger(object.ref.revision, "change.listEntry.revision"),
        ),
      };
    }
    case "saved_view":
      return { kind, viewId: parsePositiveText(resourceId, "change.viewId") };
  }
}

function parseStoredChangeRelationshipReference(
  value: Readonly<{ [key: string]: unknown }>,
): CustomCommerceRelationshipRef {
  if (value.origin !== "custom")
    throw new Error("Stored custom relationship resource is not custom");
  const definitionValue = value.definition;
  if (!isRecord(definitionValue) || definitionValue.origin !== "custom") {
    throw new Error("Stored custom relationship definition is invalid");
  }
  const definition = customRelationshipDefinitionReference(
    parseRelationshipDefinitionId(definitionValue.definitionId),
    parsePositiveRevision(
      definitionValue.revision,
      "change.customRelationship.definition.revision",
    ),
  );
  return {
    origin: "custom",
    relationshipId: parseRelationshipId(value.relationshipId),
    definition,
    revision: parsePositiveRevision<RelationshipRevision>(
      value.revision,
      "change.customRelationship.revision",
    ),
  };
}

function listEntryReference(
  entryId: string,
  listId: string,
  revision: number,
): CommerceListEntryRef {
  return {
    entryId: parsePositiveText(entryId, "listEntry.entryId"),
    listId: parsePositiveText(listId, "listEntry.listId"),
    revision: parsePositiveRevision(revision, "listEntry.revision"),
  };
}

function parseOperation(value: unknown): EntityPlaneChangeOperation {
  if (
    value === "created" ||
    value === "updated" ||
    value === "archived" ||
    value === "published" ||
    value === "deleted"
  ) {
    return value;
  }
  throw new Error("Stored entity-plane change operation is invalid");
}

function parseRecord(value: string): Readonly<{ [key: string]: unknown }> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("stored JSON must be an object");
  return parsed;
}

function parseSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value;
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
