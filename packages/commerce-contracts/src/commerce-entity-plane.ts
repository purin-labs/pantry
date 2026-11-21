import type { CommerceEntityPlaneCommand as SchemaEntityPlaneCommand } from "./entity-plane-commands.ts";
export type { CommerceCommandAuthorityContext } from "./relationship-authority.ts";
import type { AddCommerceListEntryCommand as GeneratedAddCommerceListEntryCommand } from "./list-view-commands.ts";
import type { ArchiveCustomEntityCommand as GeneratedArchiveCustomEntityCommand } from "./records/entity-plane.ts";
import type { ArchiveSavedCommerceViewCommand as GeneratedArchiveSavedCommerceViewCommand } from "./list-view-commands.ts";
import type { AttributeDefinition as GeneratedAttributeDefinition } from "./attribute-definition.ts";
import type { AttributeDefinitionScope as GeneratedAttributeDefinitionScope } from "./records/entity-plane.ts";
import type { AttributeDefinitionKind as GeneratedAttributeDefinitionKind } from "./records/entity-plane.ts";
import type { AttributeFilter as GeneratedAttributeFilter } from "./records/entity-plane.ts";
import type { AttributeOption as GeneratedAttributeOption } from "./records/entity-plane.ts";
import type { AttributeValueAssignment as GeneratedAttributeValueAssignment } from "./entity-record.ts";
import type { AttributeValueKind as GeneratedAttributeValueKind } from "./records/entity-plane.ts";
import type { DecimalValue as GeneratedDecimalValue } from "./records/entity-plane.ts";
import type { ExternalResourceReference as GeneratedExternalResourceReference } from "./records/entity-plane.ts";
import type { MerchantOperatorReference as GeneratedMerchantOperatorReference } from "./records/entity-plane.ts";
import type { CommerceAggregationQuery as GeneratedCommerceAggregationQuery } from "./records/entity-plane.ts";
import type { CommerceAggregation as GeneratedCommerceAggregation } from "./graph-query-schema.ts";
import type { CommerceAggregationGroup as GeneratedCommerceAggregationGroup } from "./entity-plane-query-results.ts";
import type { CommerceAggregationResult as GeneratedCommerceAggregationResult } from "./entity-plane-query-results.ts";
import type { CommerceAggregationSource as GeneratedCommerceAggregationSource } from "./graph-query-schema.ts";
import type { CommerceAgeBucket as GeneratedCommerceAgeBucket } from "./entity-plane-query-results.ts";
import type { CommerceAuthorityCausation as GeneratedCommerceAuthorityCausation } from "./relationship-authority.ts";
import type { CommerceAuthorityContext as GeneratedCommerceAuthorityContext } from "./relationship-authority.ts";
import type { CommerceAuthorityScope as GeneratedCommerceAuthorityScope } from "./authority-scope.ts";
import type { CommerceBoardViewConfiguration as GeneratedCommerceBoardViewConfiguration } from "./view-records.ts";
import type { CommerceCausationId as GeneratedCommerceCausationId } from "./records/entity-plane.ts";
import type { CommerceCommandResult as GeneratedCommerceCommandResult } from "./entity-plane-results.ts";
import type { CommerceCursorMismatchReason as GeneratedCommerceCursorMismatchReason } from "./query-planner.ts";
import type { CommerceEntity as GeneratedCommerceEntity } from "./entity-record.ts";
import type { CommerceEntityAuthority as GeneratedCommerceEntityAuthority } from "./command-authority.ts";
import type { CommerceEntityCommandTarget as GeneratedCommerceEntityCommandTarget } from "./command-authority.ts";
import type { CommerceEntityPlaneEffect as GeneratedCommerceEntityPlaneEffect } from "./entity-plane-effects.ts";
import type { CommerceEntityPlaneProposal as GeneratedCommerceEntityPlaneProposal } from "./records/entity-plane.ts";
import type { CommerceEntityType as GeneratedCommerceEntityType } from "./entity-type.ts";
import type { CommerceEntityTypeId as GeneratedCommerceEntityTypeId } from "./query-parts.ts";
import type { CommerceFreshness as GeneratedCommerceFreshness } from "./entity-state.ts";

import type {
  CommerceGraphQuery as SchemaCommerceGraphQuery,
  CommerceContextSelection as SchemaCommerceContextSelection,
} from "./graph-query-schema.ts";
import type { CommerceGraphQueryPlanRequest as GeneratedCommerceGraphQueryPlanRequest } from "./query-planner.ts";
import type { CommerceGraphQueryResult as GeneratedCommerceGraphQueryResult } from "./entity-plane-query-results.ts";
import type { CommerceGrouping as GeneratedCommerceGrouping } from "./view-records.ts";
import type { CommerceList as GeneratedCommerceList } from "./list-records.ts";
import type { CommerceListCommandTarget as GeneratedCommerceListCommandTarget } from "./command-authority.ts";
import type { CommerceListCreateTarget as GeneratedCommerceListCreateTarget } from "./command-authority.ts";
import type { CommerceListEntry as GeneratedCommerceListEntry } from "./list-records.ts";
import type { CommerceListEntryCommandTarget as GeneratedCommerceListEntryCommandTarget } from "./command-authority.ts";
import type { CommerceListEntryCreateTarget as GeneratedCommerceListEntryCreateTarget } from "./command-authority.ts";
import type { CommerceListEntryRef as GeneratedCommerceListEntryRef } from "./authority-scope.ts";
import type { CommerceListPageQuery as GeneratedCommerceListPageQuery } from "./records/entity-plane.ts";
import type { CommerceMutationTarget as GeneratedCommerceMutationTarget } from "./entity-plane-receipts.ts";
import type { CommerceObservationOutcome as GeneratedCommerceObservationOutcome } from "./entity-plane-observations.ts";
import type { CommerceObservationResult as GeneratedCommerceObservationResult } from "./entity-plane-results.ts";
import type { CommerceNormalizedPredicate as GeneratedCommerceNormalizedPredicate } from "./query-plan-parts.ts";
import type { CommerceOrderingIntent as GeneratedCommerceOrderingIntent } from "./query-plan-parts.ts";
import type { CommerceQueryLimit as GeneratedCommerceQueryLimit } from "./query-plan.ts";
import type { CommerceQueryPlan as GeneratedCommerceQueryPlan } from "./query-plan.ts";
import type { CommerceQueryPlanOperation as GeneratedCommerceQueryPlanOperation } from "./query-operation.ts";
import type { CommerceQueryCapabilityProfile as GeneratedCommerceQueryCapabilityProfile } from "./query-capabilities.ts";
import type { CommerceCapabilityMatrix as GeneratedCommerceCapabilityMatrix } from "./query-capabilities.ts";
import type { CommerceSavedViewCapabilitySource as GeneratedCommerceSavedViewCapabilitySource } from "./query-capabilities.ts";
import type { CommerceAggregationCapability as GeneratedCommerceAggregationCapability } from "./query-capabilities.ts";
import type { CommerceQueryPlanErrorCapability as GeneratedCommerceQueryPlanErrorCapability } from "./query-planner.ts";
import type { CommerceQueryPlanOutcome as GeneratedCommerceQueryPlanOutcome } from "./query-planner.ts";
import type { CommerceQueryProjection as GeneratedCommerceQueryProjection } from "./query-plan-parts.ts";
import type { CommerceQuerySemanticsV1 as GeneratedCommerceQuerySemanticsV1 } from "./query-plan-parts.ts";
import type { CommerceTextNormalizationVersion as GeneratedCommerceTextNormalizationVersion } from "./records/entity-plane.ts";
import type { CommerceRelationshipTraversalSubject as GeneratedCommerceRelationshipTraversalSubject } from "./query-operation.ts";
import type { CommerceRelationship as GeneratedCommerceRelationship } from "./relationships.ts";
import type { CommerceMerchantId as GeneratedCommerceMerchantId } from "./records/identifiers.ts";
import type { CustomEntityOrigin as GeneratedCustomEntityOrigin } from "./records/entity-plane.ts";
import type { SystemEntityOrigin as GeneratedSystemEntityOrigin } from "./records/entity-plane.ts";
import type { OrganisationId as GeneratedOrganisationId } from "./records/identifiers.ts";
import type { CustomCommerceRelationshipRef as GeneratedCustomCommerceRelationshipRef } from "./relationships.ts";
import type { CustomRelationshipDefinitionRef as GeneratedCustomRelationshipDefinitionRef } from "./records/entity-plane.ts";
import type { CustomCommerceRelationshipCommandTarget as GeneratedCustomCommerceRelationshipCommandTarget } from "./relationship-commands.ts";
import type { CustomCommerceRelationshipReplacementTarget as GeneratedCustomCommerceRelationshipReplacementTarget } from "./relationship-commands.ts";
import type { CustomCommerceEntityCreateTarget as GeneratedCustomCommerceEntityCreateTarget } from "./command-authority.ts";
import type { CustomCommerceRelationshipCreateTarget as GeneratedCustomCommerceRelationshipCreateTarget } from "./relationship-commands.ts";
import type { CommerceRelationshipRef as GeneratedCommerceRelationshipRef } from "./relationships.ts";
import type { CommerceSearchQuery as GeneratedCommerceSearchQuery } from "./records/entity-plane.ts";
import type { CommerceTableDensity as GeneratedCommerceTableDensity } from "./view-records.ts";
import type { CommerceTableViewConfiguration as GeneratedCommerceTableViewConfiguration } from "./view-records.ts";

import type { CommerceViewPresentation as GeneratedCommerceViewPresentation } from "./view-records.ts";
import type { CreateCommerceListCommand as GeneratedCreateCommerceListCommand } from "./list-view-commands.ts";
import type { CreateCustomEntityCommand as GeneratedCreateCustomEntityCommand } from "./records/entity-plane.ts";
import type { CreateCustomEntityTypeCommand as GeneratedCreateCustomEntityTypeCommand } from "./records/entity-plane.ts";
import type { CreateCustomRelationshipCommand as GeneratedCreateCustomRelationshipCommand } from "./records/entity-plane.ts";
import type { CreateCustomRelationshipDefinitionCommand as GeneratedCreateCustomRelationshipDefinitionCommand } from "./records/entity-plane.ts";
import type { CreateSystemEntityExtensionSchemaCommand as GeneratedCreateSystemEntityExtensionSchemaCommand } from "./records/entity-plane.ts";
import type { CustomCommerceEntity as GeneratedCustomCommerceEntity } from "./records/entity-plane.ts";
import type { CustomCommerceEntityState as GeneratedCustomCommerceEntityState } from "./entity-state.ts";
import type { CustomCommerceEntityTypeCommandTarget as GeneratedCustomCommerceEntityTypeCommandTarget } from "./command-authority.ts";
import type { CustomCommerceEntityTypeCreateTarget as GeneratedCustomCommerceEntityTypeCreateTarget } from "./command-authority.ts";
import type { CustomCommerceEntityTypeDraft as GeneratedCustomCommerceEntityTypeDraft } from "./entity-commands.ts";
import type { CustomCommerceRelationship as GeneratedCustomCommerceRelationship } from "./relationships.ts";
import type { DeleteCustomRelationshipCommand as GeneratedDeleteCustomRelationshipCommand } from "./records/entity-plane.ts";
import type { CustomCommerceRelationshipDefinitionCommandTarget as GeneratedCustomCommerceRelationshipDefinitionCommandTarget } from "./relationship-commands.ts";
import type { CustomCommerceRelationshipDefinitionCreateTarget as GeneratedCustomCommerceRelationshipDefinitionCreateTarget } from "./relationship-commands.ts";
import type { CustomCommerceRelationshipDefinitionDraft as GeneratedCustomCommerceRelationshipDefinitionDraft } from "./relationship-commands.ts";
import type { EntityByRefQuery as GeneratedEntityByRefQuery } from "./records/entity-plane.ts";
import type { EntityTypePageQuery as GeneratedEntityTypePageQuery } from "./records/entity-plane.ts";
import type { ListEntryAttributeDefinition as GeneratedListEntryAttributeDefinition } from "./list-records.ts";
import type { ListEntryAttributeValue as GeneratedListEntryAttributeValue } from "./list-records.ts";
import type { PatchCommerceListEntryCommand as GeneratedPatchCommerceListEntryCommand } from "./list-view-commands.ts";
import type { PatchCustomEntityCommand as GeneratedPatchCustomEntityCommand } from "./records/entity-plane.ts";
import type { PublishCustomEntityTypeCommand as GeneratedPublishCustomEntityTypeCommand } from "./records/entity-plane.ts";
import type { PublishCustomRelationshipDefinitionCommand as GeneratedPublishCustomRelationshipDefinitionCommand } from "./records/entity-plane.ts";
import type { PublishSavedCommerceViewCommand as GeneratedPublishSavedCommerceViewCommand } from "./list-view-commands.ts";
import type { PublishSystemEntityExtensionSchemaCommand as GeneratedPublishSystemEntityExtensionSchemaCommand } from "./records/entity-plane.ts";
import type { RelationshipCardinality as GeneratedRelationshipCardinality } from "./relationships.ts";
import type { RelationshipDefinition as GeneratedRelationshipDefinition } from "./relationships.ts";
import type { RelationshipDefinitionRef as GeneratedRelationshipDefinitionRef } from "./records/entity-plane.ts";
import type { RelationshipDeletionBehavior as GeneratedRelationshipDeletionBehavior } from "./relationships.ts";
import type { RelationshipFilter as GeneratedRelationshipFilter } from "./records/entity-plane.ts";
import type { RelationshipFilterOperator as GeneratedRelationshipFilterOperator } from "./records/entity-plane.ts";
import type { RelationshipTraversalQuery as GeneratedRelationshipTraversalQuery } from "./records/entity-plane.ts";
import type { RemoveCommerceListEntryCommand as GeneratedRemoveCommerceListEntryCommand } from "./list-view-commands.ts";
import type { ReplaceCustomRelationshipCommand as GeneratedReplaceCustomRelationshipCommand } from "./records/entity-plane.ts";
import type { SavedCommerceView as GeneratedSavedCommerceView } from "./view-records.ts";
import type { SavedCommerceViewCommandTarget as GeneratedSavedCommerceViewCommandTarget } from "./command-authority.ts";
import type { SavedCommerceViewCreateTarget as GeneratedSavedCommerceViewCreateTarget } from "./command-authority.ts";
import type { SavedCommerceViewQuery as GeneratedSavedCommerceViewQuery } from "./records/entity-plane.ts";
import type { SavedCommerceViewSource as GeneratedSavedCommerceViewSource } from "./view-records.ts";
import type { PantryCommerceReadAuthority as GeneratedPantryCommerceReadAuthority } from "./read-authority.ts";
import type { SystemCommerceEntity as GeneratedSystemCommerceEntity } from "./records/entity-plane.ts";
import type { SystemCommerceEntityKind as GeneratedSystemCommerceEntityKind } from "./records/entity-plane.ts";
import type { SystemCommerceRelationship as GeneratedSystemCommerceRelationship } from "./relationships.ts";
import type { SystemCommerceRelationshipRef as GeneratedSystemCommerceRelationshipRef } from "./relationships.ts";
import type { SystemRelationshipDefinitionRef as GeneratedSystemRelationshipDefinitionRef } from "./records/entity-plane.ts";
import type { SystemEntityExtension as GeneratedSystemEntityExtension } from "./entity-type.ts";
import type { SystemEntityExtensionSchemaCommandTarget as GeneratedSystemEntityExtensionSchemaCommandTarget } from "./command-authority.ts";
import type { SystemEntityExtensionSchemaCreateTarget as GeneratedSystemEntityExtensionSchemaCreateTarget } from "./command-authority.ts";
import type { SystemEntityExtensionSchemaDraft as GeneratedSystemEntityExtensionSchemaDraft } from "./entity-commands.ts";
import type { SystemRelationshipDefinitionKind as GeneratedSystemRelationshipDefinitionKind } from "./records/entity-plane.ts";
import type { CommerceEntityPlaneObservationV1 as GeneratedCommerceEntityPlaneObservationV1 } from "./entity-plane-observations.ts";
import type { CommerceEntityPlaneDeliveryId as GeneratedCommerceEntityPlaneDeliveryId } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptOutcome as GeneratedCommerceMutationReceiptOutcome } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptKeyId as GeneratedCommerceMutationReceiptKeyId } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptSignature as GeneratedCommerceMutationReceiptSignature } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptSignatureAlgorithm as GeneratedCommerceMutationReceiptSignatureAlgorithm } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptSigner as GeneratedCommerceMutationReceiptSigner } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptSigningEnvelopeV1 as GeneratedCommerceMutationReceiptSigningEnvelopeV1 } from "./entity-plane-receipts.ts";
import type { CommerceMutationReceiptV1 as GeneratedCommerceMutationReceiptV1 } from "./entity-plane-receipts.ts";
import type { CommerceEntityPlaneError as GeneratedCommerceEntityPlaneError } from "./entity-plane-results.ts";
import type { VisibleRelationshipColumn as GeneratedVisibleRelationshipColumn } from "./view-records.ts";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";

export type { CommerceEntityRef } from "./entity-reference.ts";
export type { SystemCommerceEntityRef } from "./entity-reference.ts";
export type CommerceEntityTypeId = StrictUnion<GeneratedCommerceEntityTypeId>;
export type CommerceEntityType = StrictUnion<GeneratedCommerceEntityType>;
export type CommerceEntity = StrictUnion<GeneratedCommerceEntity>;
export type CustomCommerceEntity = StrictUnion<GeneratedCustomCommerceEntity>;
export type { CustomCommerceEntityRef } from "./entity-reference.ts";
export type CustomCommerceEntityTypeDraft = Omit<
  GeneratedCustomCommerceEntityTypeDraft,
  "attributes"
> &
  Readonly<{
    attributes: Array<AttributeDefinition>;
  }>;
export type CustomCommerceEntityTypeCommandTarget =
  GeneratedCustomCommerceEntityTypeCommandTarget;
export type CustomCommerceEntityTypeCreateTarget =
  GeneratedCustomCommerceEntityTypeCreateTarget;

export type AttributeDefinition = Omit<GeneratedAttributeDefinition, "kind"> &
  Readonly<{
    kind: StrictUnion<GeneratedAttributeDefinitionKind>;
  }>;
export type AttributeDefinitionScope = GeneratedAttributeDefinitionScope;
export type AttributeDefinitionKind =
  StrictUnion<GeneratedAttributeDefinitionKind>;
export type AttributeOption = GeneratedAttributeOption;
export type { AttributeValue } from "./attribute-value.ts";
export type AttributeValueAssignment = Omit<
  GeneratedAttributeValueAssignment,
  "value"
> &
  Readonly<{
    value: AttributeValue;
  }>;
export type AttributeValueKind = GeneratedAttributeValueKind;
export type DecimalValue = GeneratedDecimalValue;
export type ExternalResourceReference = GeneratedExternalResourceReference;
export type ListEntryAttributeValue = GeneratedListEntryAttributeValue;
export type ListEntryAttributeDefinition =
  StrictUnion<GeneratedListEntryAttributeDefinition>;
export type MerchantOperatorReference = GeneratedMerchantOperatorReference;

export type RelationshipDefinition =
  StrictUnion<GeneratedRelationshipDefinition>;
export type RelationshipDefinitionRef =
  StrictUnion<GeneratedRelationshipDefinitionRef>;
export type CustomCommerceRelationshipDefinitionDraft = Omit<
  GeneratedCustomCommerceRelationshipDefinitionDraft,
  "sourceType" | "targetType"
> &
  Readonly<{
    sourceType: CommerceEntityTypeId;
    targetType: CommerceEntityTypeId;
  }>;
export type CustomCommerceRelationshipDefinitionCommandTarget =
  GeneratedCustomCommerceRelationshipDefinitionCommandTarget;
export type CustomCommerceRelationshipDefinitionCreateTarget =
  GeneratedCustomCommerceRelationshipDefinitionCreateTarget;
export type CustomRelationshipDefinitionRef =
  GeneratedCustomRelationshipDefinitionRef;
export type SystemRelationshipDefinitionRef =
  GeneratedSystemRelationshipDefinitionRef;
export type RelationshipCardinality = GeneratedRelationshipCardinality;
export type RelationshipDeletionBehavior =
  GeneratedRelationshipDeletionBehavior;
export type RelationshipFilter = StrictUnion<GeneratedRelationshipFilter>;
export type RelationshipFilterOperator = GeneratedRelationshipFilterOperator;
export type CommerceRelationship = StrictUnion<GeneratedCommerceRelationship>;
export type CommerceRelationshipRef = GeneratedCommerceRelationshipRef;
export type CustomCommerceRelationship =
  StrictUnion<GeneratedCustomCommerceRelationship>;
export type CustomCommerceRelationshipRef =
  GeneratedCustomCommerceRelationshipRef;
export type SystemCommerceRelationship =
  StrictUnion<GeneratedSystemCommerceRelationship>;
export type SystemCommerceRelationshipRef =
  GeneratedSystemCommerceRelationshipRef;

export type CommerceList = StrictUnion<GeneratedCommerceList>;
export type CommerceListCommandTarget = GeneratedCommerceListCommandTarget;
export type CommerceListCreateTarget = GeneratedCommerceListCreateTarget;
export type CommerceListEntry = StrictUnion<GeneratedCommerceListEntry>;
export type CommerceListEntryCommandTarget =
  GeneratedCommerceListEntryCommandTarget;
export type CommerceListEntryCreateTarget =
  GeneratedCommerceListEntryCreateTarget;
export type CommerceListEntryRef = GeneratedCommerceListEntryRef;
export type SavedCommerceView = StrictUnion<GeneratedSavedCommerceView>;
export type SavedCommerceViewCommandTarget =
  GeneratedSavedCommerceViewCommandTarget;
export type SavedCommerceViewCreateTarget =
  GeneratedSavedCommerceViewCreateTarget;
export type SavedCommerceViewSource =
  StrictUnion<GeneratedSavedCommerceViewSource>;
export type PublishedCommerceSelector = Variant<
  SchemaCommerceContextSelection,
  "selector"
>["selector"];

export type { CommerceFilter } from "./query-filter.ts";
export type AttributeFilter = StrictUnion<GeneratedAttributeFilter>;
export type CommerceAgeBucket = GeneratedCommerceAgeBucket;
export type CommerceAggregationGroup = GeneratedCommerceAggregationGroup;
export type CommerceAggregationSource =
  StrictUnion<GeneratedCommerceAggregationSource>;
export type CommerceGraphQuery = SchemaCommerceGraphQuery;
export type CommerceGraphQueryPlanRequest =
  GeneratedCommerceGraphQueryPlanRequest;
export type CommerceGraphQueryResult =
  StrictUnion<GeneratedCommerceGraphQueryResult>;
export type CommerceAggregationQuery =
  StrictUnion<GeneratedCommerceAggregationQuery>;
export type CommerceAggregation = StrictUnion<GeneratedCommerceAggregation>;
export type CommerceAggregationResult =
  StrictUnion<GeneratedCommerceAggregationResult>;
export type CommerceAuthorityCausation =
  StrictUnion<GeneratedCommerceAuthorityCausation>;
export type CommerceBoardViewConfiguration =
  StrictUnion<GeneratedCommerceBoardViewConfiguration>;
export type CommerceCausationId = GeneratedCommerceCausationId;
export type CommerceCommandResult = StrictUnion<GeneratedCommerceCommandResult>;
export type CommerceContextSelection = SchemaCommerceContextSelection;
export type { CommerceCursorBoundary } from "./cursor-payload.ts";
export type CommerceCursorMismatchReason =
  GeneratedCommerceCursorMismatchReason;
export type { CommerceCursorPayload } from "./cursor-payload.ts";
export type CommerceEntityCommandTarget = GeneratedCommerceEntityCommandTarget;
export type CustomCommerceEntityCreateTarget =
  GeneratedCustomCommerceEntityCreateTarget;
export type CustomCommerceRelationshipCommandTarget =
  GeneratedCustomCommerceRelationshipCommandTarget;
export type CustomCommerceRelationshipCreateTarget =
  GeneratedCustomCommerceRelationshipCreateTarget;
export type CustomCommerceRelationshipReplacementTarget =
  GeneratedCustomCommerceRelationshipReplacementTarget;
export type SystemEntityExtensionSchemaDraft = Omit<
  GeneratedSystemEntityExtensionSchemaDraft,
  "attributes"
> &
  Readonly<{
    attributes: Array<AttributeDefinition>;
  }>;
export type SystemEntityExtensionSchemaCommandTarget =
  GeneratedSystemEntityExtensionSchemaCommandTarget;
export type CommerceFreshness = GeneratedCommerceFreshness;
export type { CommerceFreshnessRequirement } from "./query-limits.ts";
export type CommerceGrouping = StrictUnion<GeneratedCommerceGrouping>;
export type { CommerceEffectiveOrdering } from "./query-ordering.ts";
export type { CommerceEntityIdTieBreaker } from "./query-ordering.ts";
export type { CommerceOrderingLeadingField } from "./query-ordering.ts";
export type { CommerceOrderingLeadingKey } from "./query-ordering.ts";
export type CommerceMutationTarget =
  StrictUnion<GeneratedCommerceMutationTarget>;
export type CommerceObservationOutcome =
  StrictUnion<GeneratedCommerceObservationOutcome>;
export type { CommercePagination } from "./query-pagination.ts";
export type CommerceNormalizedPredicate =
  StrictUnion<GeneratedCommerceNormalizedPredicate>;
export type { CommerceNullPlacement } from "./query-ordering.ts";
export type CommerceOrderingIntent =
  StrictUnion<GeneratedCommerceOrderingIntent>;
export type { CommerceOrderingValue } from "./cursor-values.ts";
export type { CommerceOrderingVersion } from "./query-metadata.ts";
export type { CommerceQueryFingerprint } from "./query-metadata.ts";
export type CommerceQueryLimit = GeneratedCommerceQueryLimit;
export type CommerceQueryPlan = GeneratedCommerceQueryPlan;
export type CommerceQueryPlanOperation = GeneratedCommerceQueryPlanOperation;
export type CommerceQueryCapabilityProfile =
  StrictUnion<GeneratedCommerceQueryCapabilityProfile>;
export type CommerceCapabilityMatrix =
  StrictUnion<GeneratedCommerceCapabilityMatrix>;
export type CommerceSavedViewCapabilitySource =
  StrictUnion<GeneratedCommerceSavedViewCapabilitySource>;
export type CommerceAggregationCapability =
  StrictUnion<GeneratedCommerceAggregationCapability>;
export type CommerceQueryPlanErrorCapability =
  StrictUnion<GeneratedCommerceQueryPlanErrorCapability>;
export type CommerceQueryPlanOutcome = GeneratedCommerceQueryPlanOutcome;
export type CommerceQueryProjection =
  StrictUnion<GeneratedCommerceQueryProjection>;
export type CommerceQuerySemanticsV1 =
  StrictUnion<GeneratedCommerceQuerySemanticsV1>;
export type { CommerceQuerySemanticsVersion } from "./query-metadata.ts";
export type CommerceTextNormalizationVersion =
  GeneratedCommerceTextNormalizationVersion;
export type CommerceRelationshipTraversalSubject =
  StrictUnion<GeneratedCommerceRelationshipTraversalSubject>;
export type { CommerceReadWatermark } from "./query-metadata.ts";
export type { CommerceReadWatermarkKind } from "./query-metadata.ts";
export type CommerceMerchantId = GeneratedCommerceMerchantId;
export type CustomEntityOrigin = GeneratedCustomEntityOrigin;
export type SystemEntityOrigin = GeneratedSystemEntityOrigin;
export type OrganisationId = GeneratedOrganisationId;
export type EntityByRefQuery = StrictUnion<GeneratedEntityByRefQuery>;
export type EntityTypePageQuery = StrictUnion<GeneratedEntityTypePageQuery>;
export type RelationshipTraversalQuery =
  StrictUnion<GeneratedRelationshipTraversalQuery>;
export type CommerceListPageQuery = StrictUnion<GeneratedCommerceListPageQuery>;
export type SavedCommerceViewQuery =
  StrictUnion<GeneratedSavedCommerceViewQuery>;
export type CommerceSearchQuery = StrictUnion<GeneratedCommerceSearchQuery>;
export type { CommerceSort } from "./query-ordering.ts";
export type { CommerceSortDirection } from "./query-ordering.ts";
export type { CommerceSortField } from "./query-ordering.ts";
export type { CommerceSnapshotRevision } from "./query-metadata.ts";
export type CommerceTableDensity = GeneratedCommerceTableDensity;
export type CommerceTableViewConfiguration =
  StrictUnion<GeneratedCommerceTableViewConfiguration>;
export type { CommerceTraversalLimits } from "./query-limits.ts";
export type CommerceViewPresentation =
  StrictUnion<GeneratedCommerceViewPresentation>;
export type VisibleRelationshipColumn =
  StrictUnion<GeneratedVisibleRelationshipColumn>;
export type CommerceContextRequest = Omit<
  Variant<CommerceGraphQuery, "commerce_context">,
  "kind"
>;

export type CommerceAuthorityContext =
  StrictUnion<GeneratedCommerceAuthorityContext>;
export type CommerceAuthorityScope = GeneratedCommerceAuthorityScope;
export type CommerceEntityAuthority = GeneratedCommerceEntityAuthority;
export type PantryCommerceReadAuthority = GeneratedPantryCommerceReadAuthority;

export type CommerceEntityPlaneCommand = SchemaEntityPlaneCommand;
export type CommerceEntityPlaneEffect =
  StrictUnion<GeneratedCommerceEntityPlaneEffect>;
export type CommerceEntityPlaneProposal =
  StrictUnion<GeneratedCommerceEntityPlaneProposal>;
export type CreateCustomEntityCommand =
  StrictUnion<GeneratedCreateCustomEntityCommand>;
export type CreateCustomEntityTypeCommand = Omit<
  GeneratedCreateCustomEntityTypeCommand,
  "draft"
> &
  Readonly<{
    draft: CustomCommerceEntityTypeDraft;
  }>;
export type PatchCustomEntityCommand =
  StrictUnion<GeneratedPatchCustomEntityCommand>;
export type ArchiveCustomEntityCommand =
  StrictUnion<GeneratedArchiveCustomEntityCommand>;
export type CreateCustomRelationshipCommand =
  StrictUnion<GeneratedCreateCustomRelationshipCommand>;
export type CreateCustomRelationshipDefinitionCommand = Omit<
  GeneratedCreateCustomRelationshipDefinitionCommand,
  "draft"
> &
  Readonly<{
    draft: CustomCommerceRelationshipDefinitionDraft;
  }>;
export type CreateSystemEntityExtensionSchemaCommand = Omit<
  GeneratedCreateSystemEntityExtensionSchemaCommand,
  "draft"
> &
  Readonly<{
    draft: SystemEntityExtensionSchemaDraft;
  }>;
export type DeleteCustomRelationshipCommand =
  StrictUnion<GeneratedDeleteCustomRelationshipCommand>;
export type ReplaceCustomRelationshipCommand =
  StrictUnion<GeneratedReplaceCustomRelationshipCommand>;
export type CreateCommerceListCommand =
  StrictUnion<GeneratedCreateCommerceListCommand>;
export type AddCommerceListEntryCommand =
  StrictUnion<GeneratedAddCommerceListEntryCommand>;
export type PatchCommerceListEntryCommand =
  StrictUnion<GeneratedPatchCommerceListEntryCommand>;
export type RemoveCommerceListEntryCommand =
  StrictUnion<GeneratedRemoveCommerceListEntryCommand>;
export type ArchiveSavedCommerceViewCommand =
  StrictUnion<GeneratedArchiveSavedCommerceViewCommand>;
export type PublishSavedCommerceViewCommand =
  StrictUnion<GeneratedPublishSavedCommerceViewCommand>;
export type PublishCustomEntityTypeCommand =
  StrictUnion<GeneratedPublishCustomEntityTypeCommand>;
export type PublishCustomRelationshipDefinitionCommand =
  StrictUnion<GeneratedPublishCustomRelationshipDefinitionCommand>;
export type PublishSystemEntityExtensionSchemaCommand =
  StrictUnion<GeneratedPublishSystemEntityExtensionSchemaCommand>;
export type SystemEntityExtensionSchemaCreateTarget =
  GeneratedSystemEntityExtensionSchemaCreateTarget;
export type CustomCommerceEntityState = GeneratedCustomCommerceEntityState;
export type SystemCommerceEntity = StrictUnion<GeneratedSystemCommerceEntity>;
export type SystemCommerceEntityKind = GeneratedSystemCommerceEntityKind;
export type SystemEntityExtension = StrictUnion<GeneratedSystemEntityExtension>;
export type SystemRelationshipDefinitionKind =
  GeneratedSystemRelationshipDefinitionKind;
export type CommerceEntityPlaneObservationV1 =
  StrictUnion<GeneratedCommerceEntityPlaneObservationV1>;
export type CommerceObservationResult =
  StrictUnion<GeneratedCommerceObservationResult>;
export type CommerceMutationReceiptOutcome =
  GeneratedCommerceMutationReceiptOutcome;
export type CommerceEntityPlaneDeliveryId =
  GeneratedCommerceEntityPlaneDeliveryId;
export type CommerceMutationReceiptKeyId =
  GeneratedCommerceMutationReceiptKeyId;
export type CommerceMutationReceiptSignature =
  GeneratedCommerceMutationReceiptSignature;
export type CommerceMutationReceiptSignatureAlgorithm =
  GeneratedCommerceMutationReceiptSignatureAlgorithm;
export type CommerceMutationReceiptSigner =
  GeneratedCommerceMutationReceiptSigner;
export type CommerceMutationReceiptSigningEnvelopeV1 =
  StrictUnion<GeneratedCommerceMutationReceiptSigningEnvelopeV1>;
export type CommerceMutationReceiptV1 =
  StrictUnion<GeneratedCommerceMutationReceiptV1>;
export type CommerceEntityPlaneError =
  StrictUnion<GeneratedCommerceEntityPlaneError>;
import type { AttributeValue } from "./attribute-value.ts";
