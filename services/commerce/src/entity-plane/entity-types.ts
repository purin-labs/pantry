import type { CommerceSnapshotRevision } from "@purin-labs/commerce-contracts";
import type {
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChangeResource,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneCommandRequest,
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionResponse,
} from "@purin-labs/commerce-client";

export type {
  AttributeDefinition,
  AttributeDefinitionId,
  AttributeDefinitionKind,
  AttributeDefinitionRevision,
  AttributeFilter,
  AttributeValue,
  AttributeValueAssignment,
  CommerceEntity,
  CommerceEntityPlaneCommand,
  CommerceEntityPlaneError,
  CommerceEntityRef,
  CommerceEntityType,
  CommerceEntityTypeId,
  CommerceFilter,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceList,
  CommerceListEntry,
  CommerceListEntryRevision,
  CommerceListId,
  CommerceListName,
  CommercePagination,
  CommerceRelationship,
  CommerceSensitivity,
  CommerceSort,
  CommerceTraversalLimits,
  CustomCommerceEntity,
  CustomCommerceEntityId,
  CustomCommerceEntityRef,
  CustomCommerceEntityTypeId,
  CustomEntityTypeRevision,
  ListEntryAttributeDefinition,
  ListEntryAttributeValue,
  MerchantRevision,
  RelationshipDefinition,
  RelationshipDefinitionId,
  RelationshipDefinitionRevision,
  SavedCommerceView,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";

/** The route owns merchant binding; request wire shapes remain client-owned. */
export type EntityPlaneQueryRequest = CommerceEntityPlaneQueryRequest;
/** Idempotency and organisation fencing live at the Commerce request boundary. */
export type EntityPlaneCommandRequest = CommerceEntityPlaneCommandRequest;

export type EntityPlaneChangeOperation =
  CommerceEntityPlaneChange["operation"];
export type EntityPlaneChangeResource = CommerceEntityPlaneChangeResource;
export type EntityPlaneChange = CommerceEntityPlaneChange;

export type EntityPlaneChangeRequest = Readonly<{
  merchantId: string;
  afterMerchantRevision: CommerceSnapshotRevision;
  limit: number;
}>;

export type EntityPlaneChangeResponse = CommerceEntityPlaneChanges;

export type EntityPlaneSystemExtensionRequest =
  CommerceEntityPlaneSystemExtensionRequest;
export type EntityPlaneSystemExtensionResponse =
  CommerceEntityPlaneSystemExtensionResponse;
