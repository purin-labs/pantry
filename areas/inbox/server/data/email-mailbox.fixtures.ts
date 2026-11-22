import type {
  EmailReplyProposalLifecycle,
  MailboxIngressPolicy,
  MailboxProcessingPauseReason,
} from "./email-mailbox";

// @ts-expect-error An enabled mailbox policy requires every published limit.
const invalidEnabledPolicy: MailboxIngressPolicy = {
  kind: "enabled",
  policyVersion: 1,
  maxActiveCases: 3,
  maxMessagesPerHour: 20,
  debounce: { kind: "push_triggered", coalesceSeconds: 30 },
  overflow: "pause_and_notify",
  publishedBy: "app_user_1",
  publishedAt: 1,
};

const disabledByDefaultPolicy: MailboxIngressPolicy = {
  kind: "disabled_by_default",
  connectedAt: 1,
};

const invalidDisabledByDefaultPolicy: MailboxIngressPolicy = {
  kind: "disabled_by_default",
  connectedAt: 1,
  // @ts-expect-error disabled_by_default is derived from connection facts and has no publisher.
  publishedBy: "app_user_1",
};

const enabledPolicy: MailboxIngressPolicy = {
  kind: "enabled",
  policyVersion: 1,
  maxActiveCases: 3,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 250_000,
  maxMessageBytes: 262_144,
  maxAttachmentBytes: 5_242_880,
  debounce: { kind: "push_triggered", coalesceSeconds: 30 },
  overflow: "pause_and_notify",
  publishedBy: "app_user_1",
  publishedAt: 1,
};

const invalidDebouncePolicy: MailboxIngressPolicy = {
  kind: "enabled",
  policyVersion: 1,
  maxActiveCases: 3,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 250_000,
  maxMessageBytes: 262_144,
  maxAttachmentBytes: 5_242_880,
  // @ts-expect-error V1 fixes the debounce interval at one hour.
  debounce: { kind: "push_triggered", coalesceSeconds: 300 },
  overflow: "pause_and_notify",
  publishedBy: "app_user_1",
  publishedAt: 1,
};

// @ts-expect-error Daily token budget pauses carry both reserved and consumed tokens.
const invalidTokenBudgetPause: MailboxProcessingPauseReason = {
  kind: "daily_token_budget",
  reserved: 100,
  limit: 1000,
  windowEndsAt: 1,
};

// @ts-expect-error Approval binds the exact snapshot digest.
const invalidApprovedProposal: EmailReplyProposalLifecycle = {
  kind: "approved",
  approvedBy: "app_user_1",
  approvedAt: 1,
};

// @ts-expect-error Terminal proposal branches carry an explicit disposal state.
const invalidRejectedProposal: EmailReplyProposalLifecycle = {
  kind: "rejected",
  rejectedBy: "app_user_1",
  rejectedAt: 1,
};

void invalidEnabledPolicy;
void disabledByDefaultPolicy;
void invalidDisabledByDefaultPolicy;
void enabledPolicy;
void invalidDebouncePolicy;
void invalidTokenBudgetPause;
void invalidApprovedProposal;
void invalidRejectedProposal;
