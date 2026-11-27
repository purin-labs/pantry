import type {
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "@purin-labs/commerce-contracts/entity-plane-query-results";
export type {
  CommerceEntityPlanePlannedQueryResponse,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "@purin-labs/commerce-contracts/entity-plane-query-results";
import type {
  CommerceEntityPlanePublishedResourceMetadataRequest,
  CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@purin-labs/commerce-contracts/entity-plane-metadata";
export type {
  CommerceEntityPlanePublishedResourceReference,
  CommerceEntityPlanePublishedResourceMetadataRequest,
  CommerceEntityPlanePublishedResource,
  CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@purin-labs/commerce-contracts/entity-plane-metadata";
import type {
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionResponse,
  CommerceListEntryReadRequest,
  CommerceListEntryReadResult,
} from "@purin-labs/commerce-contracts/entity-plane-resources";
export type {
  CommerceEntityPlaneChangeResource,
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionSidecar,
  CommerceEntityPlaneSystemExtensionResponse,
  CommerceListEntryReadRequest,
  CommerceListEntryReadResult,
} from "@purin-labs/commerce-contracts/entity-plane-resources";
import type {
  AttributeDefinitionId,
  CommerceGraphQueryResult,
  CommerceListEntryId,
  CommerceListEntryRef,
  CommerceListEntryRevision,
  CommerceListId,
  CommerceRelationship,
  CommerceViewPresentation,
} from "@purin-labs/commerce-contracts";
import { validateCommerceRelationshipShape } from "@purin-labs/commerce-contracts/browser-validators";

import {
  requireUniqueValues,
  booleanValue,
  objectValue,
  strictObjectValue,
  arrayValue,
  brandText,
  brandRevision,
  enumValue,
} from "./primitives.ts";
import * as metadataContracts from "@purin-labs/commerce-contracts/entity-plane-metadata";
import * as resourceContracts from "@purin-labs/commerce-contracts/entity-plane-resources";
import { decodeRecord } from "./record-decoding.ts";
import * as queryResultContracts from "@purin-labs/commerce-contracts/entity-plane-query-results";
import * as exportContracts from "@purin-labs/commerce-contracts/entity-plane-export";
import type {
  CommerceEntityPlaneExportPresetPublishRequest,
  CommerceEntityPlaneExportPresetPublishResponse,
} from "@purin-labs/commerce-contracts/entity-plane-export";
export {
  EXPORT_COORDINATION_PRESET_ID,
  EXPORT_COORDINATION_PRESET_VERSION,
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetEvidence,
  type CommerceEntityPlaneExportPresetPublishResponse,
} from "@purin-labs/commerce-contracts/entity-plane-export";

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

export function parseCommerceEntityPlanePlannedQueryResponse(
  value: unknown,
): CommerceEntityPlanePlannedQueryResponse {
  return decodeRecord(
    queryResultContracts.parseCommerceEntityPlanePlannedQueryResponse,
    value,
  );
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
