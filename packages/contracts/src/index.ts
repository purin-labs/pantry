export type { ActivatingSession } from "./types/ActivatingSession";
export type { PortalChatStreamRecord } from "./record-schemas.ts";
export type { AcceptedInputRef } from "./types/AcceptedInputRef";
export type { AgentObjective } from "./types/AgentObjective";
export type { AgentRole } from "./types/AgentRole";
export type { AssignmentId } from "./types/AssignmentId";
export type { AuthorityPartition } from "./types/AuthorityPartition";
export type { AuthorityPartitionKey } from "./types/AuthorityPartitionKey";
export type { SessionBudgetEventSequence } from "./types/SessionBudgetEventSequence";
export type { AdapterCapability } from "./types/AdapterCapability";
export type { AdmittedTurn } from "./types/AdmittedTurn";
export type {
  AgentSessionLifecycle,
  RecoveringSession,
  SessionCommand,
  SessionRecoveryAction,
  SessionRecoveryEvidence,
  SessionTransition,
} from "./session-recovery.ts";
export type { HarnessTaskContinuation } from "./types/HarnessTaskContinuation";
export type { HarnessTaskId } from "./types/HarnessTaskId";
export type { HarnessSubmissionId } from "./types/HarnessSubmissionId";
export type { SessionRecoveryBlock } from "./types/SessionRecoveryBlock";
export type { ApplicationId } from "./types/ApplicationId";
export type { ApprovalRequestId } from "./types/ApprovalRequestId";
export type { AwaitingApprovalTurn } from "./types/AwaitingApprovalTurn";
export type { AwaitingExecutionTurn } from "./types/AwaitingExecutionTurn";
export type { AwaitingToolEffectTurn } from "./types/AwaitingToolEffectTurn";
export type { BudgetRevision } from "./types/BudgetRevision";
export type { ByteLength } from "./types/ByteLength";
export type { CapabilityCallCount } from "./types/CapabilityCallCount";
export type { CancellationLease } from "./types/CancellationLease";
export type { CancellationPlan } from "./types/CancellationPlan";
export type { CancellationResolution } from "./types/CancellationResolution";
export type { CancellationResolutionInput } from "./types/CancellationResolutionInput";
export type { CancellationTarget } from "./types/CancellationTarget";
export type { CancellingSession } from "./types/CancellingSession";
export type { CausationRef } from "./types/CausationRef";
export type { CaseAssignment } from "./types/CaseAssignment";
export type { CaseAssignmentLifecycle } from "./types/CaseAssignmentLifecycle";
export type { CaseAssignmentStart } from "./types/CaseAssignmentStart";
export type {
  CaseAssignmentAbandonReason,
  CaseAssignmentTerminalDisposition,
} from "./types/CaseAssignmentTerminalDisposition";
export type { CaseBinding } from "./types/CaseBinding";
export type { CaseBindingId } from "./types/CaseBindingId";
export type { CaseContent } from "./types/CaseContent";
export {
  caseContributionSourceSchema,
  type CaseContributionSource,
} from "./case-output.ts";
export type { CaseContextEntryRef } from "./types/CaseContextEntryRef";
export type { CaseContextSnapshot } from "./types/CaseContextSnapshot";
export type CaseEvidenceDependency = import("@seams/type-utils").StrictUnion<
  import("./types/CaseEvidenceDependency").CaseEvidenceDependency
>;
export type { CaseContextCollectionEvidenceRef } from "./types/CaseContextCollectionEvidenceRef";
export type MailboxReplyScope = import("@seams/type-utils").StrictUnion<
  import("./types/MailboxReplyScope").MailboxReplyScope
>;
export type { CaseEntryId } from "./types/CaseEntryId";
export type { CaseId } from "./types/CaseId";
export type { CaseIdentity } from "./types/CaseIdentity";
export type { CaseJournalCursor } from "./types/CaseJournalCursor";
export type { CaseJournalSequence } from "./types/CaseJournalSequence";
export type { CaseLifecycle } from "./types/CaseLifecycle";
export type { CaseOutput } from "./types/CaseOutput";
export type { CaseOutputId } from "./types/CaseOutputId";
export type { CaseOutputLifecycle } from "./types/CaseOutputLifecycle";
export type { CaseProposalAcceptance } from "./types/CaseProposalAcceptance";
export type { CaseProposalRejection } from "./types/CaseProposalRejection";
export type { CaseRevision } from "./types/CaseRevision";
export type { CaseTrigger } from "./types/CaseTrigger";
export type { CaseTriggerId } from "./types/CaseTriggerId";
export type { CaseTriggerSource } from "./types/CaseTriggerSource";
export type { CaseWait } from "./types/CaseWait";
export type { CheckpointId } from "./types/CheckpointId";
export type { CheckpointingSession } from "./types/CheckpointingSession";
export type { CommandEnvelope } from "./types/CommandEnvelope";
export type { CommandId } from "./types/CommandId";
export type { ConnectorAddress } from "./types/ConnectorAddress";
export type { ConnectorDelivery } from "./types/ConnectorDelivery";
export type { ConnectorDeliveryId } from "./types/ConnectorDeliveryId";
export type { ConnectorDeliveryReceipt } from "./types/ConnectorDeliveryReceipt";
export type { ConnectorId } from "./types/ConnectorId";
export type { ConnectorIdentity } from "./types/ConnectorIdentity";
export type { ConnectorIngress } from "./types/ConnectorIngress";
export type { ConnectorIngressId } from "./types/ConnectorIngressId";
export type { ConnectorProvider } from "./types/ConnectorProvider";
export type { CodeModeExecutionOutcome } from "./types/CodeModeExecutionOutcome";
export type { CodeModeExecutionReceipt } from "./types/CodeModeExecutionReceipt";
export type { CodeModePriceBookRevision } from "./types/CodeModePriceBookRevision";
export type { CorrelationId } from "./types/CorrelationId";
export type { DispatchAttempt } from "./types/DispatchAttempt";
export type { DispatchId } from "./types/DispatchId";
export type { DispatchingEffect } from "./types/DispatchingEffect";
export type { DurationMs } from "./types/DurationMs";
export type { EffectId } from "./types/EffectId";
export type { EffectKind } from "./types/EffectKind";
export type { EffectLifecycle } from "./types/EffectLifecycle";
export type { EffectReceiptId } from "./types/EffectReceiptId";
export type { EnvelopeVersion } from "./types/EnvelopeVersion";
export type { EventBody } from "./types/EventBody";
export type { EventEnvelope } from "./types/EventEnvelope";
export type { EventId } from "./types/EventId";
export type { EventPrincipal } from "./types/EventPrincipal";
export type { EventSensitivity } from "./types/EventSensitivity";
export type { EventSequence } from "./types/EventSequence";
export type { EventStreamId } from "./types/EventStreamId";
export type { HarnessBuildId } from "./types/HarnessBuildId";
export type { HarnessCheckpointBlobRef } from "./types/HarnessCheckpointBlobRef";
export type { HarnessCheckpointRecord } from "./types/HarnessCheckpointRecord";
export type { EmbeddedHarnessBackendId } from "./types/EmbeddedHarnessBackendId";
export type { HarnessCheckpointFormatVersion } from "./types/HarnessCheckpointFormatVersion";
export type { AcceptedHarnessEventCursor } from "./types/AcceptedHarnessEventCursor";
export type { HarnessEventCursor } from "./types/HarnessEventCursor";
export type { HarnessEventSequence } from "./types/HarnessEventSequence";
export type { HarnessHistoryCursor } from "./types/HarnessHistoryCursor";
export type { AuthorizedHarnessToolResult } from "./types/AuthorizedHarnessToolResult";
export type { HarnessSurfaceEffectAuthority } from "./types/HarnessSurfaceEffectAuthority";
export type { EmbeddedHarnessModelUsage } from "./types/EmbeddedHarnessModelUsage";
export type { HarnessAssistantContent } from "./types/HarnessAssistantContent";
export type { HarnessHistoryContent } from "./types/HarnessHistoryContent";
export type { HarnessHistoryEntry } from "./types/HarnessHistoryEntry";
export type { HarnessHistoryEntryEnvelope } from "./types/HarnessHistoryEntryEnvelope";
export type { HarnessOpaqueContinuation } from "./types/HarnessOpaqueContinuation";
export type { HarnessReadAuthority } from "./types/HarnessReadAuthority";
export type { HarnessProviderEffectAuthority } from "./types/HarnessProviderEffectAuthority";
export type { HarnessCodeExecutionAuthority } from "./types/HarnessCodeExecutionAuthority";
export type { HarnessWorkspaceRevisionAuthority } from "./types/HarnessWorkspaceRevisionAuthority";
export type { HarnessStopReason } from "./types/HarnessStopReason";
export type { HarnessToolAuthority } from "./types/HarnessToolAuthority";
export type { HarnessToolOutcome } from "./types/HarnessToolOutcome";
export type { HarnessToolResultStatus } from "./types/HarnessToolResultStatus";
export type { HarnessToolOutput } from "./types/HarnessToolOutput";
export type { HarnessTurnLease } from "./types/HarnessTurnLease";
export type { HarnessTurnLeaseId } from "./types/HarnessTurnLeaseId";
export type { ExecutionId } from "./types/ExecutionId";
export type { IndeterminateEffect } from "./types/IndeterminateEffect";
export type { IndeterminateReason } from "./types/IndeterminateReason";
export type { IngressObservationId } from "./types/IngressObservationId";
export type { InputId } from "./types/InputId";
export type { InternalCostMicros } from "./types/InternalCostMicros";
export type { MediaType } from "./types/MediaType";
export type { MigrationId } from "./types/MigrationId";
export type { ModelRequestId } from "./types/ModelRequestId";
export type { ObjectKey } from "./types/ObjectKey";
export type { PayloadVersion } from "./types/PayloadVersion";
export type { PendingEffect } from "./types/PendingEffect";
export type { PrincipalId } from "./types/PrincipalId";
export type { ProposedCaseEntry } from "./types/ProposedCaseEntry";
export type { ProposedEffectRef } from "./types/ProposedEffectRef";
export type { ProviderDeliveryCursor } from "./types/ProviderDeliveryCursor";
export type { ProcessingSession } from "./types/ProcessingSession";
export type { QuarantineRecovery } from "./types/QuarantineRecovery";
export type { QuarantineReason } from "./types/QuarantineReason";
export type { QuarantinedSession } from "./types/QuarantinedSession";
export type { ReasoningTurn } from "./types/ReasoningTurn";
export type { RequestAuthority } from "./types/RequestAuthority";
export type { ReconciledEffect } from "./types/ReconciledEffect";
export type { ReducingResultTurn } from "./types/ReducingResultTurn";
export type { RetentionClass } from "./types/RetentionClass";
export type { RuntimeGeneration } from "./types/RuntimeGeneration";
export type { RuntimeLease } from "./types/RuntimeLease";
export type { RuntimeLeaseId } from "./types/RuntimeLeaseId";
export type { RuntimeRevision } from "./types/RuntimeRevision";
export type { RunId } from "./types/RunId";
export type { RunBudgetIndeterminateReason } from "./types/RunBudgetIndeterminateReason";
export type { RunBudgetReservation } from "./types/RunBudgetReservation";
export type { RunBudgetReservationId } from "./types/RunBudgetReservationId";
export type { RunBudgetReservationState } from "./types/RunBudgetReservationState";
export type { ScheduleId } from "./types/ScheduleId";
export type { SessionContract } from "./types/SessionContract";
export type { SessionAuthority } from "./types/SessionAuthority";
export type { SessionBudget } from "./types/SessionBudget";
export type { SessionBudgetAccount } from "./types/SessionBudgetAccount";
export type { SessionBudgetAllowance } from "./types/SessionBudgetAllowance";
export type { SessionBudgetDimension } from "./types/SessionBudgetDimension";
export type { SessionBudgetExhaustion } from "./types/SessionBudgetExhaustion";
export type { SessionBudgetExhaustionId } from "./types/SessionBudgetExhaustionId";
export type { SessionBudgetUsage } from "./types/SessionBudgetUsage";
export type { SessionCapabilityProfile } from "./types/SessionCapabilityProfile";
export type { SessionId } from "./types/SessionId";
export type { SessionIdentity } from "./types/SessionIdentity";
export type { SessionResumePoint } from "./types/SessionResumePoint";
export type { SessionImportEvidence } from "./types/SessionImportEvidence";
export type { SessionProposal } from "./types/SessionProposal";
export type { SessionProposalDisposition } from "./types/SessionProposalDisposition";
export type { SessionProposalId } from "./types/SessionProposalId";
export type { SessionTerminalReason } from "./types/SessionTerminalReason";
export type { SettledEffect } from "./types/SettledEffect";
export type { SleepingSession } from "./types/SleepingSession";
export type { SourceTime } from "./types/SourceTime";
export type { SourceSchemaVersion } from "./types/SourceSchemaVersion";
export type { SystemComponentId } from "./types/SystemComponentId";
export type { TerminalSession } from "./types/TerminalSession";
export type { Timestamp } from "./types/Timestamp";
export type { ThreadBlockId } from "./types/ThreadBlockId";
export type { TurnId } from "./types/TurnId";
export type { TurnIdentity } from "./types/TurnIdentity";
export type { TurnLeaseGeneration } from "./types/TurnLeaseGeneration";
export type { TurnLifecycle } from "./types/TurnLifecycle";
export type { TurnOutcome } from "./types/TurnOutcome";
export type { VerifiedSessionCheckpoint } from "./types/VerifiedSessionCheckpoint";
export type { WorkspaceRevision } from "./types/WorkspaceRevision";
export type { WorkspaceRevisionReceipt } from "./types/WorkspaceRevisionReceipt";
export type { WorkspaceExecutorAllocationId } from "./types/WorkspaceExecutorAllocationId";
export type { WorkspaceExecutorUsage } from "./types/WorkspaceExecutorUsage";
export type { WorkspaceRevisionReceiptId } from "./types/WorkspaceRevisionReceiptId";
export type { WorkspaceRevisionReceiptOutcome } from "./types/WorkspaceRevisionReceiptOutcome";
export type { ExhaustedRunBudgetReservation } from "./types/ExhaustedRunBudgetReservation";
export type { ActionClass } from "./types/ActionClass";
export type { ActionDef } from "./types/ActionDef";
export type { ActionNonce } from "./types/ActionNonce";
export type { ActionState } from "./types/ActionState";
export type { AgentEvent } from "./types/AgentEvent";
export type { AgentEventEnvelope } from "./types/AgentEventEnvelope";
export type { AgentStreamCursor } from "./types/AgentStreamCursor";
export type { AgentStatus } from "./types/AgentStatus";
export type { Amount } from "./types/Amount";
export type { ArtifactRef } from "./types/ArtifactRef";
export type { AttachmentSource } from "./types/AttachmentSource";
export type { AuthzRules } from "./types/AuthzRules";
export type { BindingCtx } from "./types/BindingCtx";
export type { BlockOrigin } from "./types/BlockOrigin";
export type { Budget } from "./types/Budget";
export type { CanonicalAction } from "./types/CanonicalAction";
export type { CanonicalBlock } from "./types/CanonicalBlock";
export type { CanonicalBody } from "./types/CanonicalBody";
export type { ChatFileDelivery } from "./types/ChatFileDelivery";
export type { ChatSurfaceContext } from "./types/ChatSurfaceContext";
export type { Confirmation } from "./types/Confirmation";
export type { ContainerHandle } from "./types/ContainerHandle";
export type { CredentialScope } from "./types/CredentialScope";
export type { CueAction } from "./types/CueAction";
export type { CueDecision } from "./types/CueDecision";
export type { CueEvent } from "./types/CueEvent";
export type { CueSubscription } from "./types/CueSubscription";
export type { EgressCtx } from "./types/EgressCtx";
export type { EgressPolicy } from "./types/EgressPolicy";
export type { ErrorInfo } from "./types/ErrorInfo";
export type { ErrorSource } from "./types/ErrorSource";
export type { GatewayModelRoute } from "./types/GatewayModelRoute";
export type { HeaderInjection } from "./types/HeaderInjection";
export type { Hlc } from "./types/Hlc";
export type { IdempotencySupport } from "./types/IdempotencySupport";
export type { InjectionMode } from "./types/InjectionMode";
export type { InjectionRule } from "./types/InjectionRule";
export type { InstanceType } from "./types/InstanceType";
export type { ModelRoute } from "./model-route.ts";
export type { FirstOperationalTask } from "./types/FirstOperationalTask";
export type { OnboardingActionCode } from "./types/OnboardingActionCode";
export type { OnboardingActivation } from "./types/OnboardingActivation";
export type { OnboardingActivationPhase } from "./types/OnboardingActivationPhase";
export type { OnboardingAudiencePolicy } from "./types/OnboardingAudiencePolicy";
export type { OnboardingCapabilityProfile } from "./types/OnboardingCapabilityProfile";
export type { OnboardingCredentialHealth } from "./types/OnboardingCredentialHealth";
export type { OnboardingEventRecency } from "./types/OnboardingEventRecency";
export type { OnboardingControlRole } from "./types/OnboardingControlRole";
export type { OnboardingCueTarget } from "./types/OnboardingCueTarget";
export type { OnboardingEnvironment } from "./types/OnboardingEnvironment";
export type { OnboardingIntegrationAccountLifecycle } from "./types/OnboardingIntegrationAccountLifecycle";
export type { OnboardingMembership } from "./types/OnboardingMembership";
export type { OnboardingNextAction } from "./types/OnboardingNextAction";
export type { OnboardingOperatingProfile } from "./types/OnboardingOperatingProfile";
export type { OnboardingPresentation } from "./types/OnboardingPresentation";
export type { OnboardingProjectionV1 } from "./types/OnboardingProjectionV1";
export type { OnboardingProvider } from "./types/OnboardingProvider";
export type { OnboardingProviderAccount } from "./types/OnboardingProviderAccount";
export type { OnboardingSelectedResource } from "./types/OnboardingSelectedResource";
export type { OnboardingWebhookHealth } from "./types/OnboardingWebhookHealth";
export type { OnboardingReadiness } from "./types/OnboardingReadiness";
export type { OnboardingReadinessBlocker } from "./types/OnboardingReadinessBlocker";
export type { ApprovalAuthenticationBranch } from "./types/ApprovalAuthenticationBranch";
export type { ApprovalAuthenticationReadiness } from "./types/ApprovalAuthenticationReadiness";
export type { ApprovalAuthenticationUnreadyReason } from "./types/ApprovalAuthenticationUnreadyReason";
export type { OnboardingRetentionPolicy } from "./types/OnboardingRetentionPolicy";
export type { OnboardingRetrySafety } from "./types/OnboardingRetrySafety";
export type { OnboardingStepName } from "./types/OnboardingStepName";
export type { OnboardingStepProjection } from "./types/OnboardingStepProjection";
export type { OnboardingSupportReference } from "./types/OnboardingSupportReference";
export type { OnboardingOrganisation } from "./types/OnboardingOrganisation";
export type { Outcome } from "./types/Outcome";
export type { OutcomeStatus } from "./types/OutcomeStatus";
export type { PersonRef } from "./types/PersonRef";
export type { PolicyEffect } from "./types/PolicyEffect";
export type { PolicyLayer } from "./types/PolicyLayer";
export type { PolicyReason } from "./types/PolicyReason";
export type { Predicate } from "./types/Predicate";
export type { SeamsIdentity } from "./types/SeamsIdentity";
export type { SessionHandle } from "./types/SessionHandle";
export type { SkillRef } from "./types/SkillRef";
export type { SurfaceKind } from "./types/SurfaceKind";
export type { SurfaceRef } from "./types/SurfaceRef";
export type { OrganisationOnboardingLifecycle } from "./types/OrganisationOnboardingLifecycle";
export type { ToolResult } from "./types/ToolResult";
export type { Track } from "./types/Track";
export type { TypedToolCall } from "./types/TypedToolCall";
export type { ViolationAction } from "./types/ViolationAction";
export type { ActivateCatalogReleaseV1 } from "./types/ActivateCatalogReleaseV1";
export type { ActorId } from "./types/ActorId";
export type { ActorRefV1 } from "./types/ActorRefV1";
export type { ApprovalReceiptId } from "./types/ApprovalReceiptId";
export type { ApprovalV1 } from "./types/ApprovalV1";
export type { CatalogActivationManifestV1 } from "./types/CatalogActivationManifestV1";
export type { CatalogMediaReferenceV1 } from "./types/CatalogMediaReferenceV1";
export type { CatalogOfferRefV1 } from "./types/CatalogOfferRefV1";
export type { CatalogPayloadV1 } from "./types/CatalogPayloadV1";
export type { CatalogRevision } from "./types/CatalogRevision";
export type { IdempotencyKey } from "./types/IdempotencyKey";
export type { ManifestSignerV1 } from "./types/ManifestSignerV1";
export type { MerchantId } from "./types/MerchantId";
export type { PolicyVersion } from "./types/PolicyVersion";
export type { ProductDocumentV1 } from "./types/ProductDocumentV1";
export type { ProductFieldV1 } from "./types/ProductFieldV1";
export type { ProductFolderDiffV1 } from "./types/ProductFolderDiffV1";
export type { ValidatedProductFolderChangesetV1 } from "./types/ValidatedProductFolderChangesetV1";
export type { ProductVariantV1 } from "./types/ProductVariantV1";
export type { ReleaseId } from "./types/ReleaseId";
export type { Sha256Digest } from "./types/Sha256Digest";
export type { Signature } from "./types/Signature";
export type { SignatureAlgorithmV1 } from "./types/SignatureAlgorithmV1";
export type { SignerDescriptorV1 } from "./types/SignerDescriptorV1";
export type { SigningKeyId } from "./types/SigningKeyId";
export type { WorkspaceId } from "./types/WorkspaceId";
export type { CanonicalContextSourceRef } from "./types/CanonicalContextSourceRef";
export type { ContextSourceRevision } from "./types/ContextSourceRevision";
export type { FileContextProvider } from "./record-schemas.ts";
export type { FileExtractionBudget } from "./types/FileExtractionBudget";
export type { FileGrantAdmission } from "./record-schemas.ts";
export type { FileGrantSyncState } from "./record-schemas.ts";
export type { FileResourceGrantTarget } from "./record-schemas.ts";
export type { FileResourceScope } from "./access-control.ts";
export type { ProviderFileCursor } from "./record-schemas.ts";
export type { ProviderFileRevision } from "./record-schemas.ts";
export type { AccessApprovalState } from "./types/AccessApprovalState";
export type { AccessDecisionExplanation } from "./types/AccessDecisionExplanation";
export type { AccessDecisionQuestion } from "./types/AccessDecisionQuestion";
export type { AccessDecisionStage } from "./types/AccessDecisionStage";
export type { AccessGrantLifecycle } from "./access-control.ts";
import type { AccessGrantTarget as GeneratedAccessGrantTarget } from "./types/AccessGrantTarget";
export type AccessGrantTarget =
  | Exclude<
      GeneratedAccessGrantTarget,
      { kind: "commerce_read" | "commerce_command" }
    >
  | (Omit<
      Extract<GeneratedAccessGrantTarget, { kind: "commerce_read" }>,
      "scope"
    > & { scope: CommerceReadGrantScope })
  | (Omit<
      Extract<GeneratedAccessGrantTarget, { kind: "commerce_command" }>,
      "scope"
    > & { scope: import("@seams/commerce-contracts").CommerceAuthorityScope });
export type { AccessSubjectRef } from "./types/AccessSubjectRef";
export type { AccessTargetRef } from "./types/AccessTargetRef";
export type { CapabilityCategory } from "./types/CapabilityCategory";
export type { CapabilityCommerceSystem } from "./types/CapabilityCommerceSystem";
export type { CapabilityDefinition } from "./access-control.ts";
export type { CapabilityMode } from "./types/CapabilityMode";
export type { CapabilityPolicyModes } from "./types/CapabilityPolicyModes";
export type { CapabilityPolicyProvenance } from "./types/CapabilityPolicyProvenance";
export type { CapabilityProvider } from "./types/CapabilityProvider";
export type { CapabilityProviderDependency } from "./access-control.ts";
export type { CapabilityRef } from "./types/CapabilityRef";
export type { CapabilityRisk } from "./types/CapabilityRisk";
export type { CapabilityTargetKind } from "./types/CapabilityTargetKind";
export type { CaseRef } from "./types/CaseRef";
export type CommerceReadGrantScope = Extract<
  import("@seams/commerce-contracts").CommerceAuthorityScope,
  { kind: "entity_type" | "commerce_list" | "saved_selector" }
>;
export type { EffectiveGrantRef } from "./types/EffectiveGrantRef";
export type { FlowDestinationRef } from "./types/FlowDestinationRef";
export type { GrantProvenance } from "./types/GrantProvenance";
export type { GrantSubject } from "./access-control.ts";
export type { InformationSourceRef } from "./types/InformationSourceRef";
export type { IntegrationDiscoveryAccount } from "./types/IntegrationDiscoveryAccount";
export type { IntegrationDiscoveryConnection } from "./types/IntegrationDiscoveryConnection";
export type { IntegrationDiscoveryDataClass } from "./types/IntegrationDiscoveryDataClass";
export type { IntegrationDiscoveryProvider } from "./types/IntegrationDiscoveryProvider";
export type { IntegrationDiscoveryView } from "./types/IntegrationDiscoveryView";
export type { OrganisationCapabilityPolicy } from "./types/OrganisationCapabilityPolicy";
export type { WorkflowAuthorityKind } from "./types/WorkflowAuthorityKind";

// Plan 37 — typed user messages and general attachments.
export type { AttachmentDescriptor } from "./message.ts";
export type { AttachmentId } from "./message.ts";
export type { AttachmentMediaClass } from "./message.ts";
export type { AttachmentRetentionClass } from "./message.ts";
export type { AudioMediaType } from "./message.ts";
export type { DisplayFilename } from "./message.ts";
export type { DocumentMediaType } from "./message.ts";
export type { FileExtensionHint } from "./message.ts";
export type { HttpUrl } from "./message.ts";
export type { ImageMediaType } from "./message.ts";
export type { MediaDeclaringProvider } from "./message.ts";
export type { MediaEvidence } from "./types/MediaEvidence";
export type { MediaSignatureMethod } from "./message.ts";
export type { MessageAttachmentSource } from "./message.ts";
export type { MessageLink } from "./message.ts";
export type { MessageLinkPresentation } from "./message.ts";
export type { NonEmptyText } from "./message.ts";
export type { NormalizedExtension } from "./message.ts";
export type { NormalizedMediaType } from "./message.ts";
export type { OctetStreamMediaType } from "./message.ts";
export type { OpaqueFormatHint } from "./types/OpaqueFormatHint";
export type { OpaqueMediaEvidence } from "./message.ts";
export type { OpaqueMediaType } from "./message.ts";
export type { SlackChannelId } from "./message.ts";
export type { SlackFileId } from "./message.ts";
export type { SlackFileRevision } from "./message.ts";
export type { SlackMessageTimestamp } from "./message.ts";
export type { SlackWorkspaceId } from "./message.ts";
export type { StoredMessageAttachment } from "./message.ts";
export type { OrganisationAttachmentObjectKey } from "./message.ts";
export type { UserMessage } from "./message.ts";
export type { UserMessagePart } from "./message.ts";
export type { UserMessageViews } from "./message.ts";
export type { VideoMediaType } from "./message.ts";
export type { MessageAttachmentPreparationIdentity } from "./attachment-preparation.ts";
export type { MessageAttachmentPreparationLimits } from "./attachment-preparation.ts";
export type { MessageAttachmentPreparationOutcome } from "./attachment-preparation.ts";
export type { MessageAttachmentPreparationReceipt } from "./attachment-preparation.ts";
export type { MessageAttachmentPreparationUsage } from "./attachment-preparation.ts";
export type { MessageAttachmentPreparationState } from "./message-preparation";

export type {
  CaseGoal,
  CaseGoalState,
  CaseGoalSnapshot,
  CaseGoalCommand,
  CaseGoalOperationOutcome,
} from "./goal.ts";

export { parseCaseGoal, parseCaseGoalSnapshot } from "./goal.ts";

export * from "@seams/commerce-contracts";

export type {
  AudioTrackMetadata,
  MediaContainer,
  MediaMetadata,
  VideoTrackMetadata,
  FrameSamplingOutcome,
  SampledFrame,
} from "./media-inspect.ts";
