export type { PortalChatStreamRecord } from "./record-schemas.ts";
export type { AcceptedInputRef } from "./types/AcceptedInputRef";
export type { AgentRole } from "./types/AgentRole";
export type { AuthorityPartition } from "./types/AuthorityPartition";
export type { AuthorityPartitionKey } from "./types/AuthorityPartitionKey";
export type {
  AgentSessionLifecycle,
  RecoveringSession,
  SessionCommand,
  SessionRecoveryAction,
  SessionRecoveryEvidence,
  SessionTransition,
} from "./session-recovery.ts";
export type { HarnessTaskContinuation } from "./types/HarnessTaskContinuation";
export type { CancellationLease } from "./types/CancellationLease";
export type { CancellationPlan } from "./types/CancellationPlan";
export type { CausationRef } from "./types/CausationRef";
export type { CaseAssignment } from "./types/CaseAssignment";
export type { CaseAssignmentLifecycle } from "./types/CaseAssignmentLifecycle";
export type { CaseAssignmentStart } from "./types/CaseAssignmentStart";
export type { CaseAssignmentTerminalDisposition } from "./types/CaseAssignmentTerminalDisposition";
export type { CaseBinding } from "./types/CaseBinding";
export type { CaseContent } from "./types/CaseContent";
export { type CaseContributionSource } from "./case-output.ts";
export type { CaseContextEntryRef } from "./types/CaseContextEntryRef";
export type CaseEvidenceDependency =
  import("@purin-labs/type-utils").StrictUnion<
    import("./types/CaseEvidenceDependency").CaseEvidenceDependency
  >;
export type { CaseContextCollectionEvidenceRef } from "./types/CaseContextCollectionEvidenceRef";
export type MailboxReplyScope = import("@purin-labs/type-utils").StrictUnion<
  import("./types/MailboxReplyScope").MailboxReplyScope
>;
export type { CaseIdentity } from "./types/CaseIdentity";
export type { CaseJournalCursor } from "./types/CaseJournalCursor";
export type { CaseLifecycle } from "./types/CaseLifecycle";
export type { CaseOutput } from "./types/CaseOutput";
export type { CaseOutputLifecycle } from "./types/CaseOutputLifecycle";
export type { CaseProposalAcceptance } from "./types/CaseProposalAcceptance";
export type { CaseProposalRejection } from "./types/CaseProposalRejection";
export type { CaseTrigger } from "./types/CaseTrigger";
export type { CaseTriggerSource } from "./types/CaseTriggerSource";
export type { CommandEnvelope } from "./types/CommandEnvelope";
export type { ConnectorAddress } from "./types/ConnectorAddress";
export type { ConnectorDelivery } from "./types/ConnectorDelivery";
export type { ConnectorDeliveryReceipt } from "./types/ConnectorDeliveryReceipt";
export type { ConnectorId } from "./types/ConnectorId";
export type { ConnectorIdentity } from "./types/ConnectorIdentity";
export type { ConnectorIngress } from "./types/ConnectorIngress";
export type { CodeModeExecutionOutcome } from "./types/CodeModeExecutionOutcome";
export type { CodeModeExecutionReceipt } from "./types/CodeModeExecutionReceipt";
export type { CorrelationId } from "./types/CorrelationId";
export type { EffectLifecycle } from "./types/EffectLifecycle";
export type { EventBody } from "./types/EventBody";
export type { EventEnvelope } from "./types/EventEnvelope";
export type { EventPrincipal } from "./types/EventPrincipal";
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
export type { EmbeddedHarnessModelUsage } from "./types/EmbeddedHarnessModelUsage";
export type { HarnessAssistantContent } from "./types/HarnessAssistantContent";
export type { HarnessHistoryContent } from "./types/HarnessHistoryContent";
export type { HarnessHistoryEntry } from "./types/HarnessHistoryEntry";
export type { HarnessHistoryEntryEnvelope } from "./types/HarnessHistoryEntryEnvelope";
export type { HarnessOpaqueContinuation } from "./types/HarnessOpaqueContinuation";
export type { HarnessStopReason } from "./types/HarnessStopReason";
export type { HarnessToolAuthority } from "./types/HarnessToolAuthority";
export type { HarnessToolOutcome } from "./types/HarnessToolOutcome";
export type { HarnessToolOutput } from "./types/HarnessToolOutput";
export type { HarnessTurnLease } from "./types/HarnessTurnLease";
export type { HarnessTurnLeaseId } from "./types/HarnessTurnLeaseId";
export type { PrincipalId } from "./types/PrincipalId";
export type { ProcessingSession } from "./types/ProcessingSession";
export type { RequestAuthority } from "./types/RequestAuthority";
export type { RuntimeLease } from "./types/RuntimeLease";
export type { RunBudgetIndeterminateReason } from "./types/RunBudgetIndeterminateReason";
export type { RunBudgetReservation } from "./types/RunBudgetReservation";
export type { RunBudgetReservationState } from "./types/RunBudgetReservationState";
export type { SessionContract } from "./types/SessionContract";
export type { SessionBudget } from "./types/SessionBudget";
export type { SessionBudgetAccount } from "./types/SessionBudgetAccount";
export type { SessionBudgetAllowance } from "./types/SessionBudgetAllowance";
export type { SessionBudgetDimension } from "./types/SessionBudgetDimension";
export type { SessionBudgetExhaustion } from "./types/SessionBudgetExhaustion";
export type { SessionBudgetUsage } from "./types/SessionBudgetUsage";
export type { SessionId } from "./types/SessionId";
export type { SessionIdentity } from "./types/SessionIdentity";
export type { SessionProposal } from "./types/SessionProposal";
export type { SessionProposalDisposition } from "./types/SessionProposalDisposition";
export type { Timestamp } from "./types/Timestamp";
export type { TurnIdentity } from "./types/TurnIdentity";
export type { TurnLeaseGeneration } from "./types/TurnLeaseGeneration";
export type { TurnLifecycle } from "./types/TurnLifecycle";
export type { VerifiedSessionCheckpoint } from "./types/VerifiedSessionCheckpoint";
export type { WorkspaceRevision } from "./types/WorkspaceRevision";
export type { WorkspaceRevisionReceipt } from "./types/WorkspaceRevisionReceipt";
export type { WorkspaceExecutorUsage } from "./types/WorkspaceExecutorUsage";
export type { ActionDef } from "./types/ActionDef";
export type { ActionState } from "./types/ActionState";
export type { AgentEvent } from "./types/AgentEvent";
export type { AgentEventEnvelope } from "./types/AgentEventEnvelope";
export type { ArtifactRef } from "./types/ArtifactRef";
export type { AuthzRules } from "./types/AuthzRules";
export type { Budget } from "./types/Budget";
export type { CanonicalAction } from "./types/CanonicalAction";
export type { CueEvent } from "./types/CueEvent";
export type { EgressPolicy } from "./types/EgressPolicy";
export type { ErrorSource } from "./types/ErrorSource";
export type { InjectionMode } from "./types/InjectionMode";
export type { ModelRoute } from "./model-route.ts";
export type { FirstOperationalTask } from "./types/FirstOperationalTask";
export type { OnboardingActionCode } from "./types/OnboardingActionCode";
export type { OnboardingActivation } from "./types/OnboardingActivation";
export type { OnboardingActivationPhase } from "./types/OnboardingActivationPhase";
export type { OnboardingCapabilityProfile } from "./types/OnboardingCapabilityProfile";
export type { OnboardingCredentialHealth } from "./types/OnboardingCredentialHealth";
export type { OnboardingEventRecency } from "./types/OnboardingEventRecency";
export type { OnboardingControlRole } from "./types/OnboardingControlRole";
export type { OnboardingCueTarget } from "./types/OnboardingCueTarget";
export type { OnboardingEnvironment } from "./types/OnboardingEnvironment";
export type { OnboardingIntegrationAccountLifecycle } from "./types/OnboardingIntegrationAccountLifecycle";
export type { OnboardingNextAction } from "./types/OnboardingNextAction";
export type { OnboardingOperatingProfile } from "./types/OnboardingOperatingProfile";
export type { OnboardingProjectionV1 } from "./types/OnboardingProjectionV1";
export type { OnboardingProvider } from "./types/OnboardingProvider";
export type { OnboardingProviderAccount } from "./types/OnboardingProviderAccount";
export type { OnboardingSelectedResource } from "./types/OnboardingSelectedResource";
export type { OnboardingWebhookHealth } from "./types/OnboardingWebhookHealth";
export type { OnboardingReadiness } from "./types/OnboardingReadiness";
export type { OnboardingReadinessBlocker } from "./types/OnboardingReadinessBlocker";
export type { ApprovalAuthenticationReadiness } from "./types/ApprovalAuthenticationReadiness";
export type { OnboardingStepProjection } from "./types/OnboardingStepProjection";
export type { OnboardingSupportReference } from "./types/OnboardingSupportReference";
export type { Outcome } from "./types/Outcome";
export type { SurfaceKind } from "./types/SurfaceKind";
export type { SurfaceRef } from "./types/SurfaceRef";
export type { OrganisationOnboardingLifecycle } from "./types/OrganisationOnboardingLifecycle";
export type { Track } from "./types/Track";
export type { ViolationAction } from "./types/ViolationAction";
export type { IdempotencyKey } from "./types/IdempotencyKey";
export type { Sha256Digest } from "./types/Sha256Digest";
export type { WorkspaceId } from "./types/WorkspaceId";
export type { CanonicalContextSourceRef } from "./types/CanonicalContextSourceRef";
export type { ContextSourceRevision } from "./types/ContextSourceRevision";
export type { FileContextProvider } from "./record-schemas.ts";
export type { FileGrantAdmission } from "./record-schemas.ts";
export type { FileGrantSyncState } from "./record-schemas.ts";
export type { FileResourceGrantTarget } from "./record-schemas.ts";
export type { FileResourceScope } from "./access-control.ts";
export type { ProviderFileCursor } from "./record-schemas.ts";
export type { ProviderFileRevision } from "./record-schemas.ts";
export type { AccessApprovalState } from "./types/AccessApprovalState";
export type { AccessDecisionExplanation } from "./types/AccessDecisionExplanation";
export type { AccessDecisionQuestion } from "./types/AccessDecisionQuestion";
export type { AccessGrantLifecycle } from "./access-control.ts";
import type { AccessGrantTarget as GeneratedAccessGrantTarget } from "./types/AccessGrantTarget";
import type { Variant } from "@purin-labs/type-utils";
export type AccessGrantTarget =
  | Exclude<
      GeneratedAccessGrantTarget,
      { kind: "commerce_read" | "commerce_command" }
    >
  | (Omit<Variant<GeneratedAccessGrantTarget, "commerce_read">, "scope"> & {
      scope: CommerceReadGrantScope;
    })
  | (Omit<Variant<GeneratedAccessGrantTarget, "commerce_command">, "scope"> & {
      scope: import("@purin-labs/commerce-contracts").CommerceAuthorityScope;
    });
export type { AccessSubjectRef } from "./types/AccessSubjectRef";
export type { AccessTargetRef } from "./types/AccessTargetRef";
export type { CapabilityDefinition } from "./access-control.ts";
export {
  commerceSystemKindOfSource,
  commerceSystemSource,
  isCommerceSystemKind,
  type CommerceSystemKind,
  type CommerceSystemSource,
} from "./commerce-system.ts";
export type { CapabilityMode } from "./types/CapabilityMode";
export type { CapabilityPolicyModes } from "./types/CapabilityPolicyModes";
export type { CapabilityPolicyProvenance } from "./types/CapabilityPolicyProvenance";
export type { CapabilityProviderDependency } from "./access-control.ts";
export type { CapabilityRef } from "./types/CapabilityRef";
export type { CaseRef } from "./types/CaseRef";
export type CommerceReadGrantScope = Variant<
  import("@purin-labs/commerce-contracts").CommerceAuthorityScope,
  "entity_type" | "commerce_list" | "saved_selector"
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
export type { AudioMediaType } from "./message.ts";
export type { DisplayFilename } from "./message.ts";
export type { DocumentMediaType } from "./message.ts";
export type { FileExtensionHint } from "./message.ts";
export type { HttpUrl } from "./message.ts";
export type { ImageMediaType } from "./message.ts";
export type { MessageAttachmentSource } from "./message.ts";
export type { MessageLink } from "./message.ts";
export type { NonEmptyText } from "./message.ts";
export type { NormalizedExtension } from "./message.ts";
export type { NormalizedMediaType } from "./message.ts";
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

export type { MediaMetadata, FrameSamplingOutcome } from "./media-inspect.ts";
