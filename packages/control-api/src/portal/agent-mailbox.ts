import type { EmailReplyHeadline, MailReplySource } from "../index.ts";

export type MailboxPolicyView =
  | { readonly kind: "disabled_by_default" }
  | { readonly kind: "disabled_by_operator"; readonly policyVersion: number }
  | {
      readonly kind: "enabled";
      readonly policyVersion: number;
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxAttachmentBytes: number;
    };

export type MailboxPauseReasonView = {
  readonly kind: string;
  readonly observed: number | null;
  readonly limit: number | null;
  readonly providerMessageId: string | null;
};

export type MailboxProcessingView =
  | { readonly kind: "waiting" }
  | { readonly kind: "scheduled"; readonly at: number }
  | { readonly kind: "evaluating"; readonly startedAt: number }
  | {
      readonly kind: "paused";
      readonly reason: MailboxPauseReasonView;
      readonly pausedAt: number;
    };

export type AgentMailboxRuntime = {
  readonly processing: MailboxProcessingView;
  readonly acceptedHistoryId: string;
  readonly watchExpiresAt: number | null;
  readonly usage: {
    readonly activeCases: number;
    readonly admittedLastHour: number;
    readonly tokensReserved: number;
    readonly tokensConsumed: number;
    readonly nextEvaluationAt: number | null;
  };
};

export type AgentMailboxView = {
  readonly integrationAccountId: string;
  readonly observedAddress: string;
  readonly connectionLifecycle: string;
  readonly binding: {
    readonly mailboxBindingId: string;
    readonly currentRevision: number;
    readonly installationId: string;
  } | null;
  readonly policy: MailboxPolicyView;
  readonly runtime: AgentMailboxRuntime | null;
};

export type EmailReplyQueueItem = {
  readonly proposalId: string;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly gmailThreadId: string;
  readonly version: number;
  readonly lifecycleKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * The mail that a waiting draft answers. Null when the queue names none:
   * the draft does not wait, or its mailbox cannot be read now.
   */
  readonly headline: EmailReplyHeadline | null;
};

/** One accepted memory a draft's turn was shown. */
export type EmailReplyMemory = {
  readonly memoryId: string;
  readonly revision: number;
  readonly statement: string;
};

export type EmailReplyPreviewResult =
  | {
      readonly kind: "current";
      readonly proposal: {
        readonly proposalId: string;
        readonly version: number;
        readonly bodyEdited: boolean;
        readonly to: string;
        readonly subject: string;
        readonly gmailThreadId: string;
        readonly body: string;
        readonly snapshotDigest: string;
        readonly expiresAt: number;
      };
      readonly challenge: string;
      /** The accepted memories the agent was shown when it wrote the draft. */
      readonly memory: readonly EmailReplyMemory[];
      /**
       * The records the agent checked for the draft that this person may
       * read: the cited ones with their spans, then uncited Memory.
       */
      readonly sources: readonly MailReplySource[];
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "invalidated"; readonly reason: string }
  | { readonly kind: "expired" };

export type EmailOperationalTargetView =
  | { readonly kind: "self_test"; readonly selfTestId: string }
  | {
      readonly kind: "customer_contact";
      readonly customerId: string;
      readonly contactId: string;
      readonly contactRevision: number;
    }
  | {
      readonly kind: "supplier_contact";
      readonly supplierId: string;
      readonly contactId: string;
      readonly contactRevision: number;
    };

export type EmailOperationalQueueItem = {
  readonly proposalId: string;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly target: EmailOperationalTargetView;
  readonly version: number;
  readonly snapshotDigest: string;
  readonly indeterminateRfcMessageId: string | null;
  readonly lifecycleKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type EmailOperationalPreviewResult =
  | {
      readonly kind: "current";
      readonly proposal: {
        readonly proposalId: string;
        readonly version: number;
        readonly caseId: string;
        readonly integrationAccountId: string;
        readonly target: EmailOperationalTargetView;
        readonly from: string;
        readonly to: string;
        readonly recipientDisplayName: string | null;
        readonly subject: string;
        readonly body: string;
        readonly targetDigest: string;
        readonly snapshotDigest: string;
        readonly expiresAt: number;
      };
      readonly challenge: string;
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "target_changed" }
  | { readonly kind: "content_unavailable" };
