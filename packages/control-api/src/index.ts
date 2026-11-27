/**
 * Request and response shapes shared by the platform's control routes and the
 * portal that calls them. Both sides import these instead of keeping copies,
 * so changing a wire shape is a compile error on whichever side lags behind.
 */
export type * from "./access.ts";
export type * from "./agents.ts";
export type * from "./agent-operation-commands.ts";
export * from "./chat.ts";
export {
  type PortalPageViewFact,
  type PortalPageViewSection,
  type PortalPageViewV1,
} from "./portal-page-view.ts";
export {
  KITCHEN_SURFACE,
  SURFACE_OBSERVATION_MAX_BYTES,
  chatOriginFromObservation,
  parseChatOrigin,
  parseSurfaceObservation,
  sharedChatMayCarry,
  surfaceAreaTitle,
  surfaceObservationBytes,
  type ChatOrigin,
  type SurfaceArea,
  type SurfaceObservationV2,
  type SurfaceRecord,
  type SurfaceSource,
} from "./surface-observation.ts";
export * from "./slack-names.ts";
export * from "./surface-command.ts";
export * from "./case-screen-observations.ts";
export * from "./screen-relevance.ts";
export * from "./agent-permission-requests.ts";
export * from "./permission-required.ts";
export * from "./projects.ts";
export * from "./project-context.ts";
export type * from "./commerce-exceptions.ts";
export type * from "./commerce-receipts.ts";
export * from "./supplier-id.ts";
export type * from "./home.ts";
export type * from "./payouts.ts";
export type * from "./schedule.ts";
export type * from "./terminals.ts";
export type * from "./whatsapp.ts";
export * from "./inbox.ts";
export * from "./mail-inbox.ts";
export * from "./mail-reply-document.ts";
export {
  mailIdentifier,
  mailMatch,
  mailRevision,
  parseMailClassificationSelection,
  parseMailClassifications,
  parseMailOrganizationCommand,
  parseMailOrganizationView,
  parseMailRuleSet,
  parseMailRules,
  type MailClassification,
  type MailDecision,
  type MailMatch,
  type MailOrganizationCommand,
  type MailOrganizationView,
  type MailRule,
  type MailRuleSet,
} from "./mail-organization.ts";
export * from "./mail-assistant.ts";
export {
  mailWorkReplyCanPreview,
  type MailInboxWork,
  type MailWorkAssignment,
  type MailWorkCaseState,
  type MailWorkReply,
  type MailWorkReplyState,
} from "./mail-work.ts";
export * from "./mail-reply.ts";
export * from "./mail-sender-link.ts";
export * from "./email-review.ts";
export * from "./chat-forks.ts";
export * from "./chat-side-cases.ts";
export * from "./chat-signals.ts";

export {
  isConversationId,
  isProjectId,
  isUserId,
  newConversationId,
  newProjectId,
  newUserId,
  parseConversationId,
  parseProjectId,
  type ConversationId,
  type ProjectId,
  type UserId,
} from "./ids.ts";

export * from "./project-access.ts";

export * from "./user-preferences.ts";

export * from "./mailbox-setup.ts";
export * from "./home-region.ts";

export * from "./chat-disclosure.ts";
export * from "./case-context-collections.ts";
export {
  isIanaTimezone,
  parseMemoryAuthor,
  parseMemoryCommand,
  parseMemoryCommandReceipt,
  parseMemoryContent,
  parseMemoryListResponse,
  parseMemoryRevisionState,
  parseMemoryRevisionView,
  type MemoryApplicability,
  type MemoryAuthor,
  type MemoryCommand,
  type MemoryCommandErrorCode,
  type MemoryCommandReceipt,
  type MemoryContent,
  type MemoryDecision,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryRevisionState,
  type MemoryRevisionView,
  type MemoryValidity,
  type MemoryView,
} from "./memory.ts";
export * from "./evals.ts";
export {
  MAX_CASE_EXECUTION_CASES,
  MAX_CASE_EXECUTION_CONTENT_LENGTH,
  MAX_CASE_EXECUTION_PAGE,
  parseCaseExecutionCaseList,
  parseCaseExecutionNode,
  parseCaseExecutionNodeDetail,
  parseCaseExecutionPage,
  type CaseExecutionApprovalState,
  type CaseExecutionAssignmentState,
  type CaseExecutionCaseRef,
  type CaseExecutionContent,
  type CaseExecutionEdge,
  type CaseExecutionEdgeBasis,
  type CaseExecutionEffectState,
  type CaseExecutionLimitation,
  type CaseExecutionNode,
  type CaseExecutionNodeDetail,
  type CaseExecutionNodeKind,
  type CaseExecutionPage,
  type CaseExecutionProposalState,
  type CaseExecutionToolAuthority,
  type CaseExecutionTurnMemory,
  type OpenCaseExecutionNode,
} from "./case-execution.ts";
export * from "./case-timeline.ts";
export * from "./menu-board-reviews.ts";
export {
  parseFailedPaymentsDay,
  type FailedPaymentsDay,
} from "./failed-payments.ts";
export * from "./payments.ts";
export * from "./bank-payouts.ts";
export * from "./order-queue.ts";
export * from "./counter-register.ts";
export * from "./counter-receipt.ts";
export * from "./brain.ts";
export * from "./message-attachments.ts";

export type {
  ChatGoalCommand,
  ChatGoalSupport,
  ChatGoalView,
} from "./chat-goal.ts";

export { parseChatGoalView } from "./chat-goal.ts";

export * from "./claude.ts";
export * from "./slack-reasoning-effort.ts";
export * from "./organisations.ts";
export * from "./vault.ts";
export {
  VOICE_AUDIO_SECONDS_LIMIT,
  VOICE_DEVICE_HEADER,
  VOICE_GRANT_TTL_MS,
  VOICE_MAC_HEARTBEAT_FRESH_MS,
  VOICE_REQUEST_LIMIT,
  VOICE_REQUEST_WINDOW_MS,
  VOICE_VOCABULARY_TERM_LIMIT,
  isChatTranscriptionPath,
  normalizeVoicePhrase,
  parseChatInputMode,
  parseVoiceConfirmation,
  parseVoiceConfirmationCheck,
  parseVoiceConfirmationCheckRequest,
  parseVoiceConfirmationRequest,
  parseVoiceGrant,
  parseVoiceGrantRequest,
  parseVoiceMacChallenge,
  parseVoiceMacEngineChoice,
  parseVoiceMacEnrollRequest,
  parseVoiceMacEnrollmentStart,
  parseVoiceMacHealth,
  parseVoiceMacHeartbeat,
  parseVoiceMacList,
  parseVoiceMacRefusal,
  parseVoiceTranscription,
  parseVoiceVocabulary,
  type ChatInputMode,
  type ChatTranscriptionPath,
  type VoiceConfirmation,
  type VoiceConfirmationCheck,
  type VoiceConfirmationReceipts,
  type VoiceConfirmationTarget,
  type VoiceGrant,
  type VoiceGrantClaims,
  type VoiceMacEnrollResponse,
  type VoiceMacEnrollmentStart,
  type VoiceMacHeartbeat,
  type VoiceMacHeartbeatAnswer,
  type VoiceMacList,
  type VoiceMacView,
  type VoiceRefusalCode,
  type VoiceTranscription,
  type VoiceVocabulary,
} from "./voice.ts";
export {
  CLOUD_VOICE_ENGINE,
  DEFAULT_MAC_VOICE_ENGINE,
  VOICE_ENGINES,
  isVoiceEngineId,
  voiceMacDeadlineMs,
  type VoiceEngineId,
  type VoiceHeard,
} from "./voice-engines.ts";
export * from "./voice-text-check.ts";
export {
  DEVICE_CONNECTION_OFFLINE_MS,
  DEVICE_CONNECTION_QUIET_MS,
  DEVICE_GATEWAY_CODE_TTL_MS,
  DEVICE_GATEWAY_MESSAGE_BYTES,
  DEVICE_STATIONS,
  RECEIPT_COLUMNS,
  deviceGatewayVersionIsCurrent,
  parseDeviceActivity,
  parseDeviceAlertSetting,
  parseDeviceGatewayEnrollRequest,
  parseDeviceGatewayStart,
  parseDeviceList,
  parseDeviceSnapshotList,
  parseDeviceStationId,
  parseGatewayMessage,
  type DeviceActivity,
  type DeviceAlertSetting,
  type DeviceCapability,
  type DeviceConnection,
  type DeviceGatewayEnrollResponse,
  type DeviceGatewayStart,
  type DeviceHardwareKind,
  type DeviceHealth,
  type DeviceHealthReport,
  type DeviceKind,
  type DeviceList,
  type DeviceReadiness,
  type DeviceSampleReport,
  type DeviceSnapshotList,
  type DeviceStationId,
  type DeviceView,
  type FoundDevice,
  type GatewayDeviceView,
  type GatewayMessage,
  type KitchenDeviceView,
  type PlatformGatewayMessage,
  type PrinterOutcome,
  type PrinterTask,
  type ReceiptLayout,
  type ReceiptLine,
  type TerminalPaymentMethod,
} from "./devices.ts";
export {
  type CobotClockEntry,
  type CobotObserved,
  type CobotReport,
  type CobotRunSignal,
  type CobotStation,
  type CobotTask,
  type CobotTaskMessage,
  type CobotTaskState,
} from "./device-cobot.ts";
export type {
  PendingDecision,
  PendingDecisionList,
  PendingEmailReview,
  PendingGovernedAction,
  PendingHeldOutput,
  PendingPermissionRequest,
} from "./pending-decisions.ts";
