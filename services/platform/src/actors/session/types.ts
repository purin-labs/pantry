import type { SteeringRequester } from "../harness-steering";
import type { PantryExecutionBillingError } from "../../account-platform/execution-billing";
import type { Outcome } from "@purin-labs/contracts";
import type { HarnessTurnContinuation } from "../agent-session-continuation";
import type { LiveRequestAuthorityValidationError } from "../../request-authority";
import type { MailOrganizationActorInput } from "../../mail-inbox/commands";
import type {
  AcceptedHarnessEventCursor,
  UserMessage,
  AgentSessionLifecycle,
  HarnessCheckpointRecord,
  SessionBudgetUsage,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import type { RequestId, SessionId, OrganisationId } from "../../ids";
import type { WorkspaceRevisionStoreError } from "../../workspace-revision-store";
import type { Result } from "../../result";
import type {
  SessionCutoverInspectionError,
  SessionCutoverQuiescence,
} from "../agent-session-cutover-quiescence";
import type { CanonicalSessionAccessError } from "../agent-session-canonical";
import type {
  AcceptedInputReadError,
  ActorTransitionCommitError,
  StartedSessionCommitError,
} from "../actor-journal";
import type { HarnessAuthorityError } from "../agent-session-harness-authority";
import type {
  CanonicalHarnessCheckpointError,
  CheckpointBudgetBindingError,
} from "../agent-session-harness-checkpoint";
import type { AttachmentPreparationExecutionInspection } from "../message-attachment-preparation";
import type { MessagePreparationError } from "../message-preparation";
import type { MessageLinkReceiptInspection } from "../message-link-receipt-inspection";
import type { HarnessToolHostConstructionError } from "../embedded-harness-tool-host";
import type {
  EmbeddedHarnessAdapter,
  EmbeddedHarnessCancelError,
  EmbeddedHarnessConstructionError,
  EmbeddedHarnessModelUsage,
  EmbeddedHarnessTurnError,
  EmbeddedHarnessTurnResult,
} from "../embedded-harness";
import type {
  EmailCaseManifest,
  EmailCueOutcome,
  EmailSizeBreach,
} from "../email-harness-tools";
import type {
  WhatsAppCaseManifest,
  WhatsAppTurnOutcome,
} from "../whatsapp-harness-tools";
import type { CanonicalTextTurnTransitionError } from "../agent-session-text-turn";
import type { SessionBudgetError } from "../agent-session-budget";
import type { SessionTurnStreamError } from "../agent-session-turn-stream";
import type { CanonicalTextTurnStartError } from "../agent-session-turn-start";
import type { CaseConversationSinkRefusal } from "../case-conversation-sink";
import type { SerializedFlowBinding } from "../../policy";
import type { Variant } from "@purin-labs/type-utils";

export type TransientEmailTurnRequest = {
  readonly evidenceDependency: import("../../case-context-discovery/evidence").CaseContextCollectionEvidenceDependency;
  readonly requestingOrganisationId: OrganisationId;
  readonly turnId: string;
  readonly inputId: string;
  readonly caseId: string;
  readonly assignmentId: string;
  readonly caseRevision: number;
  readonly contentDigest: string;
  readonly workspaceRevision: string;
  readonly contextBundleDigest: string;
  readonly requestAuthority: import("@purin-labs/contracts").RequestAuthority;
  readonly authorityPartitionDigest: string;
  readonly harnessInstructions: string;
  readonly turnPrompt: string;
  readonly allowanceTokens: number;
  readonly maxWallMs: number;
  readonly maxBodyChars: number;
  readonly manifest: EmailCaseManifest;
  /**
   * The accepted context this turn was prepared with. The Session verifies it
   * against `contextBundleDigest` and records it before asking the model.
   */
  readonly context: Readonly<{
    bundle: unknown;
    bundleDigest: string;
    modelContext: unknown;
  }>;
  readonly responsePolicy: import("../email-harness-tools").EmailResponsePolicy;
};

export type TransientMailAssistantRequest = Omit<
  TransientEmailTurnRequest,
  "manifest" | "responsePolicy" | "evidenceDependency" | "context"
> &
  Readonly<{
    mailbox: MailOrganizationActorInput;
    modelRouteDigest: string;
    sourcePin: string;
  }>;

export type TransientEmailTurnReply = {
  readonly flowBinding: SerializedFlowBinding;
  /** The Memory revisions the turn's prompt carried. */
  readonly memory: readonly Readonly<{ memoryId: string; revision: number }>[];
  readonly outcome: Exclude<EmailCueOutcome, { readonly kind: "none" }>;
  readonly modelUsage: EmbeddedHarnessModelUsage;
  readonly breaches: readonly EmailSizeBreach[];
  readonly commerceEvidence: readonly import("../../mail-inbox/supplier-context").EmailCommerceEvidence[];
  /** The verified sources of a draft for approval; none for other outcomes. */
  readonly sources: import("../../mail-inbox/reply-sources").EmailReplySources;
};

/**
 * One eval turn: a mailbox reply turn that reads a reviewed scenario in place
 * of mailbox mail. It drafts and sends nothing.
 */
export type TransientEvalTurnRequest = Omit<
  TransientEmailTurnRequest,
  "manifest" | "responsePolicy" | "evidenceDependency"
> &
  Readonly<{
    integrationAccountId: string;
    fixture: Readonly<{
      /** The Eval revision and scenario the message belongs to. */
      evalId: string;
      revision: number;
      scenarioId: string;
      /** The label of that Eval revision. */
      inputLabel: unknown;
      message: import("../../mail/gmail-adapter").GmailMessageContent;
    }>;
  }>;

export type TransientEvalTurnReply = Omit<
  TransientEmailTurnReply,
  "breaches" | "commerceEvidence" | "sources"
> &
  Readonly<{ toolCatalogDigest: string }>;

export type TransientModelTurnError = Readonly<{
  code: string;
  modelUsage: EmbeddedHarnessModelUsage | null;
}>;

export type TransientWhatsAppTurnRequest = {
  readonly requestingOrganisationId: OrganisationId;
  readonly turnId: string;
  readonly inputId: string;
  readonly caseId: string;
  readonly assignmentId: string;
  readonly caseRevision: number;
  readonly contentDigest: string;
  readonly workspaceRevision: string;
  readonly contextBundleDigest: string;
  readonly requestAuthority: import("@purin-labs/contracts").RequestAuthority;
  readonly authorityPartitionDigest: string;
  readonly harnessInstructions: string;
  readonly turnPrompt: string;
  readonly allowanceTokens: number;
  readonly maxWallMs: number;
  readonly manifest: WhatsAppCaseManifest;
};

export type TransientWhatsAppTurnReply = {
  readonly outcome: Exclude<WhatsAppTurnOutcome, { readonly kind: "none" }>;
  readonly modelUsage: EmbeddedHarnessModelUsage;
};

export type TransientWhatsAppTurnResult = Result<
  TransientWhatsAppTurnReply,
  TransientModelTurnError
>;

export type CanonicalEmbeddedHarnessTurnResult = EmbeddedHarnessTurnResult & {
  readonly binding: CanonicalEmbeddedHarnessCheckpointBinding;
  readonly manifest: EmbeddedHarnessAdapter["manifest"];
};

export type CanonicalEmbeddedHarnessTextTurnResult = {
  readonly outcome: Outcome;
  readonly finalMessage: string;
  readonly cursor: AcceptedHarnessEventCursor;
  readonly checkpoint: HarnessCheckpointRecord;
  readonly state: Variant<AgentSessionLifecycle, "sleeping">;
  readonly modelUsage: EmbeddedHarnessModelUsage;
  readonly flowBinding: SerializedFlowBinding;
};

export type SessionInformationFlowPreparationInput = {
  readonly requestingOrganisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly contextBundle: unknown;
};

export type SessionInformationFlowPreparationResult = {
  readonly flowBinding: SerializedFlowBinding;
};

export type FreshLineageHistoryError = {
  readonly code: "harness_history_lineage_conflict";
};

export type CanonicalEmbeddedHarnessRuntimeSource =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "resume_turn";
      readonly binding: HarnessTurnContinuation["binding"];
      readonly cursor: AcceptedHarnessEventCursor | null;
      readonly priorUsage: EmbeddedHarnessModelUsage;
    }
  | {
      readonly kind: "fresh_lineage";
      readonly reason: HarnessCheckpointRestartReason;
    }
  | {
      readonly kind: "restore";
      readonly checkpoint: HarnessCheckpointRecord;
    };

export type HarnessCheckpointRestartReason =
  | "backend_mismatch"
  | "build_mismatch"
  | "format_mismatch"
  | "model_route_digest_mismatch"
  | "tool_catalog_digest_mismatch";

export type CanonicalEmbeddedHarnessCheckpointBinding = {
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly workspaceRevision: string;
  readonly policyRevision: string;
  readonly instructionDigest: string;
  readonly toolCatalogDigest: string;
  readonly modelRouteDigest: string;
};

export type CanonicalEmbeddedHarnessResolution = Readonly<{
  readonly binding: CanonicalEmbeddedHarnessCheckpointBinding;
  readonly runtime: CanonicalEmbeddedHarnessRuntimeSource;
}>;

export type CanonicalRunBudgetIdentity = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly reservationId: string;
  readonly runtimeGeneration: number;
  readonly turnLeaseGeneration: number;
  readonly budgetRevision: string;
};

export type SessionReservationInspection =
  | { readonly kind: "none" }
  | {
      readonly kind: "active";
      readonly reservationId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly deadlineAt: number;
    }
  | {
      readonly kind: "indeterminate";
      readonly reservationId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly deadlineAt: number;
    };

export type SessionBudgetInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "open";
      readonly usage: SessionBudgetUsage;
      readonly usageCursor: number;
    }
  | {
      readonly kind: "exhausted";
      readonly usage: SessionBudgetUsage;
      readonly usageCursor: number;
    };

export type SessionCheckpointInspectionBase = {
  readonly backendId: string;
  readonly formatVersion: string;
  readonly harnessBuild: string;
  readonly createdAt: number;
  readonly runtimeGeneration: number;
  readonly turnId: string;
  readonly lastSequence: number;
  readonly lastEventDigest: string;
  readonly sha256: string;
  readonly instructionDigest: string;
  readonly toolCatalogDigest: string;
  readonly modelRouteDigest: string;
};

export type SessionCheckpointInspection =
  | { readonly kind: "none" }
  | {
      readonly kind: "invalid";
      readonly classification: "retirement_required";
      readonly reason: "malformed_checkpoint";
    }
  | (SessionCheckpointInspectionBase & {
      readonly kind: "current";
      readonly classification: "compatible";
      readonly budgetRevision: string;
      readonly usageCursor: number;
      readonly budgetAccountDigest: string;
    })
  | (SessionCheckpointInspectionBase & {
      readonly kind: "current";
      readonly classification: "fresh_lineage_restart";
      readonly reason:
        | "backend_mismatch"
        | "build_mismatch"
        | "format_mismatch"
        | "model_route_digest_mismatch";
      readonly budgetRevision: string;
      readonly usageCursor: number;
      readonly budgetAccountDigest: string;
    });

export type SessionInspection = {
  readonly identity: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  };
  readonly lifecycleKind: AgentSessionLifecycle["kind"];
  readonly quiescence: SessionCutoverQuiescence;
  readonly checkpoint: SessionCheckpointInspection;
  readonly budget: SessionBudgetInspection;
  readonly reservation: SessionReservationInspection;
  readonly preparation: AttachmentPreparationExecutionInspection;
  readonly latestMessageLinkReceipt: MessageLinkReceiptInspection;
};

export type SessionInspectionError =
  | SessionCutoverInspectionError
  | HarnessAuthorityError
  | SessionBudgetError
  | { readonly code: "session_not_initialized" }
  | { readonly code: "session_inspection_corrupt" }
  | { readonly code: "session_mismatch" };

export type SessionPing = {
  ok: true;
  kind: "session";
};

export type SessionStateError =
  | { code: "invalid_config" }
  | { code: "organisation_mismatch" }
  | { code: "session_not_initialized" }
  | SessionTurnStreamError;

export type SessionInterruptTurnInput = {
  requestId: RequestId;
  organisationId: OrganisationId;
  sessionId: SessionId;
  interruptedAt: number;
};

export type SessionInterruptTurnResult =
  { kind: "interrupted"; turnId: string } | { kind: "no_active_turn" };

/** A message from the running turn's requester that joins that turn (Plan 71). */
export type SessionSteerTurnInput = {
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly requester: SteeringRequester;
  /** The person's words, as the model reads them. */
  readonly text: string;
  /** The same message as the surface records it: text and links, no files. */
  readonly message: UserMessage;
};

/**
 * `accepted`: the turn holds the message and the model reads it before its
 * next request. `refused`: the message did not join the turn; the surface
 * runs it as the next turn.
 */
export type SessionSteerTurnResult =
  | {
      readonly kind: "accepted";
      readonly inputId: string;
      readonly reason?: never;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        "turn_not_running" | "requester_mismatch" | "steering_unsupported";
      readonly inputId?: never;
    };

export type SessionReplayInput = {
  organisationId: OrganisationId;
  turnId: string;
  afterSequence: number;
};

export type SessionTurnInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "present";
      readonly state: "running" | "complete" | "failed";
    };

export type SessionAgentFanout = {
  turnId: string;
  state:
    | { kind: "attached"; writer: WritableStreamDefaultWriter<Uint8Array> }
    | { kind: "detached"; detail: string };
};

export type SessionReplayMetrics = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly turnId: string;
  readonly startedAt: number;
  pollCount: number;
  emptyPollCount: number;
  rowsReturned: number;
  firstOutputAt: number | null;
};

export type CanonicalInputAcceptanceError =
  | ActorTransitionCommitError
  | {
      code: "workspace_revision_receipt_invalid";
      reason: WorkspaceRevisionStoreError["code"];
    }
  | { code: "canonical_session_schema_mismatch" };

export type CanonicalHarnessEventError =
  HarnessAuthorityError | { code: "canonical_session_schema_mismatch" };

export type CanonicalHarnessCheckpointCommitError =
  | CanonicalHarnessCheckpointError
  | ActorTransitionCommitError
  | CheckpointBudgetBindingError
  | SessionBudgetError
  | { code: "canonical_session_schema_mismatch" };

export type CanonicalHarnessCheckpointRestoreError =
  | LiveRequestAuthorityValidationError
  | CanonicalHarnessCheckpointError
  | CanonicalSessionAccessError
  | CheckpointBudgetBindingError
  | SessionBudgetError
  | FreshLineageHistoryError;

export type CanonicalHarnessHistoryErasureError =
  CanonicalSessionAccessError | HarnessAuthorityError;

export type CanonicalEmbeddedHarnessRunError =
  | PantryExecutionBillingError
  | CanonicalEmbeddedHarnessInputError
  | MessagePreparationError
  | CanonicalHarnessCheckpointRestoreError
  | EmbeddedHarnessConstructionError
  | EmbeddedHarnessCancelError
  | EmbeddedHarnessTurnError
  | HarnessToolHostConstructionError
  | { code: "embedded_harness_authority_partition_unavailable" }
  | { code: "embedded_harness_custom_connector_catalog_unavailable" }
  | SessionBudgetError
  | { code: "embedded_harness_instruction_digest_mismatch" }
  | { code: "embedded_harness_model_route_digest_mismatch" }
  | { code: "embedded_harness_runtime_source_mismatch" }
  | { code: "embedded_harness_model_authority_unavailable" }
  | { code: "embedded_harness_information_flow_unavailable" }
  | {
      readonly code: "embedded_harness_attachment_unavailable";
      readonly attachmentId: string;
    };

export type CanonicalEmbeddedHarnessCancellationError =
  | CanonicalInputAcceptanceError
  | CanonicalSessionAccessError
  | CanonicalTextTurnTransitionError
  | SessionBudgetError
  | TurnStateInvalidError
  | EmbeddedHarnessCancelError;

export type CanonicalEmbeddedHarnessTextTurnError =
  | CanonicalEmbeddedHarnessRunError
  | CanonicalHarnessCheckpointCommitError
  | CanonicalInputAcceptanceError
  | CanonicalTextTurnTransitionError
  | CanonicalTextTurnStartError
  | StartedSessionCommitError
  | EmbeddedHarnessCancelError
  | SessionTurnStreamError
  | TurnStateInvalidError
  | {
      code: "canonical_text_turn_sink_refused";
      refusal: CaseConversationSinkRefusal["code"];
    }
  | { code: "canonical_text_turn_checkpoint_binding_invalid" };

export type CheckpointPublicationError =
  | CanonicalHarnessCheckpointError
  | HarnessAuthorityError
  | TurnStateInvalidError;

export type CanonicalEmbeddedHarnessInputError =
  | CanonicalSessionAccessError
  | HarnessAuthorityError
  | AcceptedInputReadError
  | {
      readonly code:
        "project_evidence_unavailable" | "session_turn_context_missing";
    }
  | { readonly code: "embedded_harness_input_identity_invalid" };

/**
 * Why a turn's state did not allow the step (Refactor 15, refactor 3). The
 * code stays one code for its callers; the reason names the check, so a
 * trace or a retry reason says which one refused.
 */
export type TurnStateInvalidReason =
  | "assignment_missing"
  | "attachments_invalid"
  | "context_unavailable"
  | "execution_closed"
  | "execution_inactive"
  | "execution_unavailable"
  | "fence_closed"
  | "finalization_not_pending"
  | "flow_binding_invalid"
  | "flow_binding_missing"
  | "information_flow_unavailable"
  | "lease_expired"
  | "lease_missing"
  | "lifecycle_not_cancelling"
  | "lifecycle_not_processing"
  | "lifecycle_not_sleeping"
  | "placement_conflict"
  | "placement_inactive"
  | "recovery_cancellation_invalid"
  | "session_id_invalid"
  | "stream_completion_refused"
  | "surface_context_invalid"
  | "turn_running";

export type TurnStateInvalidError = {
  readonly code: "canonical_text_turn_state_invalid";
  readonly reason: TurnStateInvalidReason;
};
