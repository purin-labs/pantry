import type {
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "@seams/commerce-contracts/entity-plane-query-results";
export type {
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "@seams/commerce-contracts/entity-plane-query-results";
import type {
  CommerceEntityPlanePublishedResourceMetadataRequest,
  CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@seams/commerce-contracts/entity-plane-metadata";
export type {
  CommerceEntityPlanePublishedResourceReference,
  CommerceEntityPlanePublishedResourceMetadataRequest,
  CommerceEntityPlanePublishedResource,
  CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@seams/commerce-contracts/entity-plane-metadata";
import type {
  CommerceEntityPlaneChangeResource,
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionResponse,
  CommerceListEntryReadRequest,
  CommerceListEntryReadResult,
} from "@seams/commerce-contracts/entity-plane-resources";
export type {
  CommerceEntityPlaneChangeResource,
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionSidecar,
  CommerceEntityPlaneSystemExtensionResponse,
  CommerceListEntryReadRequest,
  CommerceListEntryReadResult,
} from "@seams/commerce-contracts/entity-plane-resources";
import type {
  AttributeDefinitionId,
  CommerceEntity,
  CommerceEntityType,
  CommerceGraphQueryResult,
  CommerceList,
  CommerceListEntryId,
  CommerceListEntryRef,
  CommerceListEntryRevision,
  CommerceListId,
  CommerceRelationship,
  CommerceViewPresentation,
  MerchantRevision,
  RelationshipDefinitionId,
  RelationshipDefinition,
  SavedCommerceView,
  SavedCommerceViewId,
  SystemCommerceEntityRef,
  SystemEntityExtension,
} from "@seams/commerce-contracts";
import {
  validateCommerceEntityShape,
  validateCommerceList,
  validateCommerceRelationshipShape,
  validateRelationshipDefinition,
  validateSavedCommerceView,
} from "@seams/commerce-contracts/browser-validators";

import {
  parseEntityRef,
  parseCustomEntityRef,
  parseEntityTypeId,
  parseCustomCommerceRelationshipRef,
  requireUniqueValues,
  booleanValue,
  objectValue,
  strictObjectValue,
  arrayValue,
  normalizedText,
  brandText,
  brandRevision,
  enumValue,
} from "./primitives.ts";
import * as metadataContracts from "@seams/commerce-contracts/entity-plane-metadata";
import * as resourceContracts from "@seams/commerce-contracts/entity-plane-resources";
import * as entityTypeContracts from "@seams/commerce-contracts/entity-type";
import { decodeRecord } from "./record-decoding.ts";
import * as queryResultContracts from "@seams/commerce-contracts/entity-plane-query-results";
import * as exportContracts from "@seams/commerce-contracts/entity-plane-export";
import {
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetEvidence,
  type CommerceEntityPlaneExportPresetPublishResponse,
} from "@seams/commerce-contracts/entity-plane-export";
export {
  EXPORT_COORDINATION_PRESET_ID,
  EXPORT_COORDINATION_PRESET_VERSION,
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetEvidence,
  type CommerceEntityPlaneExportPresetPublishResponse,
} from "@seams/commerce-contracts/entity-plane-export";

export function parseEntityPlaneExportPresetPublishRequest(
  value: unknown,
): CommerceEntityPlaneExportPresetPublishRequest {
  return decodeRecord(
    exportContracts.parseEntityPlaneExportPresetPublishRequest,
    value,
  );
}
export function parseEntityPlaneExportPresetPublishResponse(
  value: unknown,
): CommerceEntityPlaneExportPresetPublishResponse {
  return decodeRecord(
    exportContracts.parseEntityPlaneExportPresetPublishResponse,
    value,
  );
}

export function commerceExportPresetDigestPayload(
  input: Pick<
    CommerceEntityPlaneExportPresetPublishResponse,
    "presetId" | "presetVersion" | "evidence"
  >,
): string {
  return decodeRecord(
    exportContracts.parseCommerceExportPresetDigestPayload,
    input,
  );
}

export function parseEntityPlaneExportPresetEvidence(
  value: unknown,
): CommerceEntityPlaneExportPresetEvidence {
  return decodeRecord(
    exportContracts.parseEntityPlaneExportPresetEvidence,
    value,
  );
}

export function parseEntityPlanePublishedResourceMetadataRequest(
  value: unknown,
): CommerceEntityPlanePublishedResourceMetadataRequest {
  return decodeRecord(
    metadataContracts.parseEntityPlanePublishedResourceMetadataRequest,
    value,
  );
}

export function parseEntityPlanePublishedResourceMetadataResponse(
  value: unknown,
): CommerceEntityPlanePublishedResourceMetadataResponse {
  return decodeRecord(
    metadataContracts.parseEntityPlanePublishedResourceMetadataResponse,
    value,
  );
}

export function parseCommerceEntityType(value: unknown): CommerceEntityType {
  return decodeRecord(entityTypeContracts.parseCommerceEntityType, value);
}

export function parseEntityPlaneRelationshipTraversalStepResponse(
  value: unknown,
): CommerceEntityPlaneRelationshipTraversalStepResponse {
  return decodeRecord(
    queryResultContracts.parseEntityPlaneRelationshipTraversalStepResponse,
    value,
  );
}

export function parseEntityPlaneSystemExtensionRequest(
  value: unknown,
): CommerceEntityPlaneSystemExtensionRequest {
  return decodeRecord(
    resourceContracts.parseEntityPlaneSystemExtensionRequest,
    value,
  );
}

export function parseSystemEntityRefValue(
  value: unknown,
): SystemCommerceEntityRef {
  const reference = parseEntityRef(value);
  if (reference.origin !== "system")
    throw new Error(
      "systemExtensionRequest.entityRefs must contain system references",
    );
  return reference;
}

export function parseCommerceGraphResponse(
  value: unknown,
): CommerceGraphQueryResult {
  return decodeRecord(
    queryResultContracts.parseCommerceGraphQueryResult,
    value,
  );
}

export function parseEntityPlaneSystemExtensionResponse(
  value: unknown,
): CommerceEntityPlaneSystemExtensionResponse {
  return decodeRecord(
    resourceContracts.parseEntityPlaneSystemExtensionResponse,
    value,
  );
}

export function parseSystemEntityExtension(
  value: unknown,
): SystemEntityExtension {
  return decodeRecord(entityTypeContracts.parseSystemEntityExtension, value);
}

export function parseCommerceEntityPlanePlannedQueryResponse(
  value: unknown,
): CommerceEntityPlanePlannedQueryResponse {
  return decodeRecord(
    queryResultContracts.parseCommerceEntityPlanePlannedQueryResponse,
    value,
  );
}

export function parseRelationshipDefinition(
  value: unknown,
): RelationshipDefinition {
  return validateRelationshipDefinition(value);
}

export function parseCommerceList(value: unknown): CommerceList {
  return validateCommerceList(value);
}

export function parseEntity(value: unknown): CommerceEntity {
  return validateCommerceEntityShape(value);
}

export function parseCommerceRelationship(
  value: unknown,
): CommerceRelationship {
  return validateCommerceRelationshipShape(value);
}

export function parseCommerceListEntryRef(
  value: unknown,
): CommerceListEntryRef {
  const object = strictObjectValue(value, "listEntryRef", [
    "entryId",
    "listId",
    "revision",
  ]);
  return {
    entryId: brandText<CommerceListEntryId>(
      object.entryId,
      "listEntryRef.entryId",
    ),
    listId: brandText<CommerceListId>(object.listId, "listEntryRef.listId"),
    revision: brandRevision<CommerceListEntryRevision>(
      object.revision,
      "listEntryRef.revision",
    ),
  };
}

export function parseEntityPlaneChanges(
  value: unknown,
): CommerceEntityPlaneChanges {
  return decodeRecord(resourceContracts.parseEntityPlaneChanges, value);
}

export function parseChange(value: unknown): CommerceEntityPlaneChange {
  const object = objectValue(value, "change");
  return {
    changeId: normalizedText(object.changeId, "change.changeId"),
    merchantRevision: brandRevision<MerchantRevision>(
      object.merchantRevision,
      "change.merchantRevision",
    ),
    resource: parseChangeResource(object.resource),
    operation: enumValue(object.operation, "change.operation", [
      "created",
      "updated",
      "archived",
      "published",
      "deleted",
    ] as const),
    createdAt: normalizedText(object.createdAt, "change.createdAt"),
  };
}

export function parseChangeResource(
  value: unknown,
): CommerceEntityPlaneChangeResource {
  const object = objectValue(value, "change.resource");
  const kind = enumValue(object.kind, "change.resource.kind", [
    "entity_type",
    "entity",
    "relationship_definition",
    "custom_relationship",
    "commerce_list",
    "commerce_list_entry",
    "saved_view",
  ] as const);
  switch (kind) {
    case "entity_type":
      return { kind, typeId: parseEntityTypeId(object.typeId) };
    case "entity":
      return { kind, ref: parseCustomEntityRef(object.ref) };
    case "relationship_definition":
      return {
        kind,
        definitionId: brandText<RelationshipDefinitionId>(
          object.definitionId,
          "change.resource.definitionId",
        ),
      };
    case "custom_relationship":
      return { kind, ref: parseCustomCommerceRelationshipRef(object.ref) };
    case "commerce_list":
      return {
        kind,
        listId: brandText<CommerceListId>(
          object.listId,
          "change.resource.listId",
        ),
      };
    case "commerce_list_entry": {
      const ref = objectValue(object.ref, "change.resource.ref");
      return {
        kind,
        ref: {
          entryId: brandText<CommerceListEntryId>(
            ref.entryId,
            "change.resource.entryId",
          ),
          listId: brandText<CommerceListId>(
            ref.listId,
            "change.resource.listId",
          ),
          revision: brandRevision<CommerceListEntryRevision>(
            ref.revision,
            "change.resource.revision",
          ),
        },
      };
    }
    case "saved_view":
      return {
        kind,
        viewId: brandText<SavedCommerceViewId>(
          object.viewId,
          "change.resource.viewId",
        ),
      };
  }
}

export function parseSavedCommerceView(value: unknown): SavedCommerceView {
  return validateSavedCommerceView(value);
}

export function parseCommerceViewPresentation(
  value: unknown,
): CommerceViewPresentation {
  const object = objectValue(value, "savedCommerceView.presentation");
  const kind = enumValue(object.kind, "savedCommerceView.presentation.kind", [
    "table",
    "board",
  ] as const);
  if (kind === "table") {
    const table = strictObjectValue(object, "savedCommerceView.presentation", [
      "kind",
      "configuration",
    ]);
    const configuration = strictObjectValue(
      table.configuration,
      "savedCommerceView.presentation.configuration",
      ["density", "showRowNumbers"],
    );
    return {
      kind,
      configuration: {
        density: enumValue(
          configuration.density,
          "savedCommerceView.presentation.density",
          ["compact", "comfortable", "spacious"] as const,
        ),
        showRowNumbers: booleanValue(
          configuration.showRowNumbers,
          "savedCommerceView.presentation.showRowNumbers",
        ),
      },
    };
  }
  const board = strictObjectValue(object, "savedCommerceView.presentation", [
    "kind",
    "configuration",
  ]);
  const configuration = strictObjectValue(
    board.configuration,
    "savedCommerceView.presentation.configuration",
    ["laneAttributeId", "cardAttributeIds"],
  );
  const cardAttributeIds = arrayValue(
    configuration.cardAttributeIds,
    "savedCommerceView.presentation.cardAttributeIds",
  ).map((entry) =>
    brandText<AttributeDefinitionId>(
      entry,
      "savedCommerceView.presentation.cardAttributeIds[]",
    ),
  );
  if (cardAttributeIds.length === 0 || cardAttributeIds.length > 16)
    throw new Error(
      "savedCommerceView.presentation.cardAttributeIds is invalid",
    );
  requireUniqueValues(
    cardAttributeIds,
    "savedCommerceView.presentation.cardAttributeIds",
  );
  return {
    kind,
    configuration: {
      laneAttributeId: brandText<AttributeDefinitionId>(
        configuration.laneAttributeId,
        "savedCommerceView.presentation.laneAttributeId",
      ),
      cardAttributeIds,
    },
  };
}

export function parseListEntryReadRequest(
  raw: unknown,
): CommerceListEntryReadRequest {
  return decodeRecord(resourceContracts.parseListEntryReadRequest, raw);
}
export function parseListEntryReadResult(
  raw: unknown,
): CommerceListEntryReadResult {
  return decodeRecord(resourceContracts.parseListEntryReadResult, raw);
}
