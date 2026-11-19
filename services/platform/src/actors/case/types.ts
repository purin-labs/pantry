import type {
  AuthorityPartition,
  CaseAssignmentLifecycle,
  CaseAssignmentStart,
  CaseAssignmentTerminalDisposition,
  CaseBinding,
  CaseContent,
  CaseContextEntryRef,
  CaseIdentity,
  CaseJournalCursor,
  CaseLifecycle,
  CaseTrigger,
  CommerceEntityPlaneProposal,
  CaseContributionSource as ContractCaseContributionSource,
  CaseOutput as ContractCaseOutput,
  CaseProposalAcceptance as ContractCaseProposalAcceptance,
  ConnectorDeliveryReceipt as ContractConnectorDeliveryReceipt,
  RequestAuthority,
  SessionProposal,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import type { SourceProvenance } from "@purin-labs/contracts";
import type { IntegrationAccountId } from "../../ids";
import type { EmailReplyProposalLifecycle } from "../../data/email-mailbox";
import type { EmailProposalTarget } from "../../data/email-operational";
import type { CommerceSystemRevision } from "../../data/organisation-commerce-system";
import type { CommerceActionRequest } from "../../commerce/action-model";
import type {
  MerchantActionDecision,
  MerchantActionRejectionEvidence,
} from "../../approval-authentication";
import type { CaseContextReplayAuthority } from "../../context/projection";
import { FlowBinding } from "../../policy";
import type { SerializedFlowBinding } from "../../policy";
import type { Variant } from "@purin-labs/type-utils";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";

export type CaseGmailReplyProposal = {
  readonly evidence: import("../../case-context-discovery/evidence").CaseContextCollectionProposalEvidence;
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly threadId: string;
  readonly providerDraftId: string;
  readonly providerDraftMessageId: string;
  readonly triggeringProviderMessageId: string;
  readonly mailboxBindingId: string;
  readonly bindingRevision: number;
  readonly policyVersion: number;
  readonly targetDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lifecycle: EmailReplyProposalLifecycle;
};

export type CaseOperationalEmailProposal = {
  readonly kind: "operational_new_message";
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly integrationAccountId: string;
  readonly target: EmailProposalTarget;
  readonly targetDigest: string;
  readonly subjectDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly policyVersion: number;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lifecycle: EmailReplyProposalLifecycle;
};

export type CaseEmailProposal =
  CaseGmailReplyProposal | CaseOperationalEmailProposal;

export type QuarantinedCaseDiscardResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly kind: "discarded" | "already_empty";
        readonly stateVersion: number | null;
        readonly reachableAttachmentCount: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: "quarantined_case_discard_conflict" };
    };

export type CaseContributionSource =
  | (Variant<ContractCaseContributionSource, "agent_turn"> & {
      readonly actionNonce?: never;
      readonly commandId?: never;
      readonly requestDigest?: never;
    })
  | (Variant<ContractCaseContributionSource, "commerce_outcome"> & {
      readonly commandId?: never;
      readonly requestDigest?: never;
      readonly assignmentId?: never;
      readonly sessionId?: never;
      readonly turnId?: never;
    })
  | (Variant<ContractCaseContributionSource, "operator_command"> & {
      readonly proposalId?: never;
      readonly assignmentId?: never;
      readonly sessionId?: never;
      readonly turnId?: never;
      readonly actionNonce?: never;
    })
  | (Variant<ContractCaseContributionSource, "commerce_approval_notice"> & {
      readonly commandId?: never;
      readonly requestDigest?: never;
      readonly assignmentId?: never;
      readonly sessionId?: never;
      readonly turnId?: never;
    });

export type ProducedCaseOutput = Omit<ContractCaseOutput, "source"> & {
  readonly source: CaseContributionSource;
};

export type CaseOutput = ProducedCaseOutput & {
  readonly flowBinding: SerializedFlowBinding;
};

/** An output that waited for a person and never left (Plan 27C). */
export type CaseOutputDropped<Output> = Readonly<{
  readonly kind: "dropped";
  readonly output: Output;
  readonly reason: CaseOutputDropReason | "undelivered";
  readonly droppedAt: number;
}>;

/**
 * Why a person's decision dropped a held output. A pending output that
 * nothing delivered within a day is dropped as `undelivered` by the Case
 * alarm (Refactor 15, refactor 2).
 */
export type CaseOutputDropReason = "denied" | "expired";

/**
 * An output that the exit check stopped while a person decides (Plan 27C,
 * Refactor 15). Only that decision moves it: no resume path sends it.
 */
export type CaseOutputHeld<Output> = Readonly<{
  readonly kind: "held";
  readonly output: Output;
  readonly requestId: string;
  readonly heldAt: number;
}>;

/** An output whose delivery the provider refused for good. */
export type CaseOutputRejected<Output> = Readonly<{
  readonly kind: "rejected";
  readonly output: Output;
  readonly reason: string;
  readonly rejectedAt: number;
}>;

export type CaseOutputLifecycle =
  | Readonly<{ readonly kind: "pending"; readonly output: CaseOutput }>
  | Readonly<{
      readonly kind: "settled";
      readonly output: CaseOutput;
      readonly receipt: ConnectorDeliveryReceipt;
    }>
  | CaseOutputHeld<CaseOutput>
  | CaseOutputRejected<CaseOutput>
  | CaseOutputDropped<CaseOutput>;

export type CaseProposalAcceptance = Omit<
  ContractCaseProposalAcceptance,
  "outputs"
> & {
  readonly outputs: readonly CaseOutput[];
};

export type ConnectorDeliveryReceipt = ContractConnectorDeliveryReceipt & {
  readonly flowBindingDigest: string;
  readonly decisionDigest: string;
};

export type StoredCaseOutput = ProducedCaseOutput & {
  readonly flowBinding: SerializedFlowBinding;
};

export type RawCaseOutput = ProducedCaseOutput & {
  readonly flowBinding: unknown;
};

export type RestoredCaseOutput = ProducedCaseOutput & {
  readonly flowBinding: FlowBinding;
};

export type StoredCaseOutputLifecycle =
  | Readonly<{ readonly kind: "pending"; readonly output: StoredCaseOutput }>
  | Readonly<{
      readonly kind: "settled";
      readonly output: StoredCaseOutput;
      readonly receipt: ConnectorDeliveryReceipt;
    }>
  | CaseOutputHeld<StoredCaseOutput>
  | CaseOutputRejected<StoredCaseOutput>
  | CaseOutputDropped<StoredCaseOutput>;

export type RawCaseOutputLifecycle =
  | Readonly<{ readonly kind: "pending"; readonly output: RawCaseOutput }>
  | Readonly<{
      readonly kind: "settled";
      readonly output: RawCaseOutput;
      readonly receipt: ConnectorDeliveryReceipt;
    }>
  | CaseOutputHeld<RawCaseOutput>
  | CaseOutputRejected<RawCaseOutput>
  | CaseOutputDropped<RawCaseOutput>;

export type RestoredCaseOutputLifecycle =
  | Readonly<{ readonly kind: "pending"; readonly output: RestoredCaseOutput }>
  | Readonly<{
      readonly kind: "settled";
      readonly output: RestoredCaseOutput;
      readonly receipt: ConnectorDeliveryReceipt;
    }>
  | CaseOutputHeld<RestoredCaseOutput>
  | CaseOutputRejected<RestoredCaseOutput>
  | CaseOutputDropped<RestoredCaseOutput>;

export type RawCaseProposalAcceptance = Omit<
  ContractCaseProposalAcceptance,
  "outputs"
> & {
  readonly outputs: readonly RawCaseOutput[];
};

export type RestoredCaseProposalAcceptance = Omit<
  ContractCaseProposalAcceptance,
  "outputs"
> & {
  readonly outputs: readonly RestoredCaseOutput[];
};

export type CaseEnsureRequest = {
  readonly identity: CaseIdentity;
  readonly purpose: string;
  readonly workspaceRevision: string;
  readonly lifecycle: Variant<CaseLifecycle, "open">;
};

export type PrepareOngoingCaseTurnRequest = {
  readonly ensure: CaseEnsureRequest;
  readonly trigger: CaseTriggerRecord;
  readonly binding: CaseBinding;
};

export type BeginAssignmentRequest = {
  readonly caseId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly expectedCaseRevision: number;
  readonly start: CaseAssignmentStart;
};

export type AbandonAssignmentRequest = {
  readonly caseId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly expectedCaseRevision: number;
  /** The state that the caller read; another state is not moved. */
  readonly expectedState: "assigned" | "running";
  readonly expectedStartId: string | null;
  /** The Session's answer that it runs no turn, and when it was read. */
  readonly proof: {
    readonly kind: "session_quiescent";
    readonly sessionId: string;
    readonly inspectedAt: number;
  };
  /** How old the assignment must be, from its start or its making. */
  readonly minimumAgeMs: number;
  readonly abandonedAt: number;
};

export type SettleAssignmentRequest = {
  readonly caseId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly expectedCaseRevision: number;
  readonly expectedStartId: string;
  readonly disposition: CaseAssignmentTerminalDisposition;
};

export type AcceptProposalRequest = {
  readonly proposal: SessionProposal;
  readonly requestAuthority: RequestAuthority;
  readonly acceptedAt: number;
  readonly flowBinding: FlowBinding;
};

export type AcceptCommerceProposalRequest = {
  readonly proposal: CommerceCaseProposal;
  readonly acceptedAt: number;
  readonly flowBinding: FlowBinding;
  /** The tool call that made the proposal, when the caller names one. */
  readonly toolCallId?: string;
  /**
   * The agent turn that made the proposal. An assignment keeps its first
   * start across the turns of a thread, so a later turn names itself.
   */
  readonly turnId?: string;
};

export type CommerceEntityPlaneCaseProposal = {
  readonly kind: "entity_plane";
  readonly proposalId: string;
  readonly caseId: string;
  readonly basedOnRevision: number;
  readonly requestAuthority: RequestAuthority;
  readonly proposal: CommerceEntityPlaneProposal;
  readonly origin:
    | {
        readonly kind: "merchant_control";
        readonly userId: string;
        readonly controlSessionId: string;
      }
    | {
        readonly kind: "agent_session";
        readonly sessionId: string;
        readonly assignmentId: string;
        readonly threadId: string;
      };
};

export type AcceptCommerceEntityPlaneProposalRequest = {
  readonly proposal: CommerceEntityPlaneCaseProposal;
  readonly acceptedAt: number;
  readonly flowBinding: FlowBinding;
};

export type ParsedAcceptCommerceProposalRequest =
  | Readonly<{
      readonly kind: "agent_bound";
      readonly proposal: CommerceCaseProposal & {
        readonly origin: Variant<
          CommerceCaseProposal["origin"],
          "agent_session"
        >;
      };
      readonly acceptedAt: number;
      readonly flowBinding: FlowBinding;
      readonly toolCallId?: string;
      readonly turnId?: string;
    }>
  | Readonly<{
      readonly kind: "merchant_input";
      readonly proposal: CommerceCaseProposal & {
        readonly origin: Variant<
          CommerceCaseProposal["origin"],
          "merchant_control"
        >;
      };
      readonly acceptedAt: number;
      readonly authorityPartition: AuthorityPartition;
    }>;

export type WaitForCommerceApprovalRequest = {
  readonly caseId: string;
  readonly proposalId: string;
  readonly actionNonce: string;
  readonly expectedCaseRevision: number;
  readonly requestedAt: number;
};

export type ResolveCommerceApprovalRequest = {
  readonly caseId: string;
  readonly proposalId: string;
  readonly actionNonce: string;
  readonly decision: MerchantActionDecision;
};

export type CaseCommerceApprovalRecord =
  | {
      readonly kind: "waiting";
      readonly request: WaitForCommerceApprovalRequest;
    }
  | {
      readonly kind: "decided";
      readonly request: WaitForCommerceApprovalRequest;
      readonly decision: MerchantActionDecision;
    }
  | {
      /** The action expired in the ledger before a person decided it. */
      readonly kind: "lapsed";
      readonly request: WaitForCommerceApprovalRequest;
      readonly lapsedAt: number;
    };

export type CommerceCaseProposal = {
  readonly proposalId: string;
  readonly caseId: string;
  readonly basedOnRevision: number;
  readonly requestAuthority: RequestAuthority;
  readonly origin:
    | {
        readonly kind: "merchant_control";
        readonly userId: string;
        readonly controlSessionId: string;
      }
    | {
        readonly kind: "agent_session";
        readonly sessionId: string;
        readonly assignmentId: string;
        readonly threadId: string;
      };
} & (
  | Readonly<{
      action: Exclude<
        CommerceActionRequest,
        {
          kind:
            | "install_merchant_plugin"
            | "publish_cafe_menu"
            | "change_menu_price"
            | "refund_order"
            | "stock_operation"
            | "submit_supplier_payout"
            | "resume_supplier_payout_funding";
        }
      >;
      authority: CommerceCaseAuthority;
      provenance: SourceProvenance;
    }>
  | Readonly<{
      // A merchant plugin is configuration, not a projection: the commerce
      // system is the authority, and no source record is its provenance.
      action: Variant<
        CommerceActionRequest,
        | "install_merchant_plugin"
        | "publish_cafe_menu"
        | "change_menu_price"
        | "refund_order"
        | "stock_operation"
      >;
      authority: CommerceCaseAuthority;
      provenance: null;
    }>
  | Readonly<{
      action: Variant<
        CommerceActionRequest,
        "submit_supplier_payout" | "resume_supplier_payout_funding"
      >;
      authority: Readonly<{
        kind: "integration_account";
        integrationAccountId: IntegrationAccountId;
      }>;
      provenance: null;
    }>
);

export type PersistedCommerceProposal =
  CommerceCaseProposal | CommerceEntityPlaneCaseProposal;

export type CommerceCaseAuthority =
  | Readonly<{ kind: "lab" }>
  | Readonly<{
      kind: "commerce_system";
      system: "satyr_commerce" | "shopify";
      revision: CommerceSystemRevision;
      integrationAccountId: IntegrationAccountId;
    }>;

export type ParsedDeliveryReceiptRequest = {
  readonly outputId: string;
  readonly receipt: ConnectorDeliveryReceipt;
};

export type AcceptDeliveryReceiptRequest = ParsedDeliveryReceiptRequest & {
  readonly expectedFlowBindingDigest: string;
};

export type AcceptCommerceOutcomeRequest = {
  readonly caseId: string;
  readonly proposalId: string;
  readonly actionNonce: string;
  readonly outcome:
    | {
        readonly kind: "provider_receipt";
        readonly receipt: CommerceProviderReceipt;
      }
    | {
        readonly kind: "merchant_rejection";
        readonly evidence: MerchantActionRejectionEvidence;
      }
    | {
        readonly kind: "execution_failure";
        readonly actionNonce: string;
      };
  readonly content: Variant<CaseContent, "text">;
  readonly acceptedAt: number;
};

export type StoredAcceptCommerceOutcomeRequest =
  AcceptCommerceOutcomeRequest & {
    readonly flowBinding: FlowBinding;
  };

export type CaseCommerceOutcomeAcceptance = {
  readonly kind: "accepted" | "already_accepted";
  readonly revision: number;
  readonly output: CaseOutputLifecycle | null;
};

export type RawCaseCommerceOutcomeAcceptance = {
  readonly kind: "accepted" | "already_accepted";
  readonly revision: number;
  readonly output: RawCaseOutputLifecycle | null;
};

export type RestoredCaseSnapshot = Omit<CaseSnapshot, "outputs"> & {
  readonly outputs: readonly RestoredCaseOutputLifecycle[];
};

export type CaseTriggerRecord = CaseTrigger & {
  readonly attachments: readonly StoredMessageAttachment[];
  /**
   * What the trigger is about, in a few words from its own source: an email's
   * subject. It is stored with the trigger and shown under the trigger's label.
   */
  readonly title?: string;
};

/** The longest stored trigger title. */
export const MAX_TRIGGER_TITLE = 200;

export type CaseSnapshot = {
  readonly identity: CaseIdentity;
  readonly purpose: string;
  readonly workspaceRevision: string;
  readonly revision: number;
  readonly lifecycle: CaseLifecycle;
  readonly journalCursor: CaseJournalCursor;
  readonly bindings: readonly CaseBinding[];
  readonly assignmentLifecycles: readonly CaseAssignmentLifecycle[];
  readonly acceptedProposalIds: readonly string[];
  readonly acceptedCommerceProposalIds: readonly string[];
  readonly commerceApprovals: readonly CaseCommerceApprovalRecord[];
  readonly entries: readonly CaseContextEntryRef[];
  readonly outputs: readonly CaseOutputLifecycle[];
};

export type RawCaseSnapshot = Omit<CaseSnapshot, "outputs"> & {
  readonly outputs: readonly RawCaseOutputLifecycle[];
};

export type CaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string } };

export type CaseMetaRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  case_id: string;
  purpose: string;
  workspace_revision: string;
  revision: number;
  lifecycle_json: string;
};

export type JsonRow = Record<string, SqlStorageValue> & { payload: string };

export type LifecycleRow = Record<string, SqlStorageValue> & {
  lifecycle_json: string;
};

export type ProposalRow = Record<string, SqlStorageValue> & {
  proposal_id: string;
  payload: string;
  acceptance_json: string;
};

export type JournalRow = Record<string, SqlStorageValue> & {
  sequence: number;
  entry_id: string;
  digest: string;
  preview: string;
  request_authority_json: string;
  visibility_json: string;
  visibility_key: string;
  flow_label_json: string | null;
  authority_scope_json: string | null;
  accepted_at: number;
};

export type ContextJournalRow = JournalRow & { payload: string };

export const PARTITION_INDEPENDENT_REPLAY_AUTHORITY: CaseContextReplayAuthority =
  Object.freeze({
    kind: "partition_independent",
  });
