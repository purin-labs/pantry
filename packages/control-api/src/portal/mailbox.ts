import type {
  AgentMailboxRuntime,
  AgentMailboxView,
  MailboxPauseReasonView,
  MailboxPolicyView,
  MailboxProcessingView,
} from "./agent-mailbox.ts";
import {
  isNonEmptyString,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";

export function parseAgentMailboxResponse(raw: unknown): AgentMailboxView {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.mailbox)) {
    throw new Error("The server returned an invalid Gmail mailbox.");
  }
  const mailbox = raw.mailbox;
  if (
    !isNonEmptyString(mailbox.integration_account_id) ||
    !isNonEmptyString(mailbox.observed_address) ||
    !isNonEmptyString(mailbox.connection_lifecycle)
  ) {
    throw new Error("The server returned an invalid Gmail mailbox identity.");
  }
  return {
    integrationAccountId: mailbox.integration_account_id,
    observedAddress: mailbox.observed_address,
    connectionLifecycle: mailbox.connection_lifecycle,
    binding: parseAgentMailboxBinding(mailbox.binding),
    policy: parseMailboxPolicyView(mailbox.policy),
    runtime:
      mailbox.runtime === null
        ? null
        : parseAgentMailboxRuntime(mailbox.runtime),
  };
}

function parseAgentMailboxBinding(raw: unknown): AgentMailboxView["binding"] {
  if (raw === null) return null;
  if (!isRecord(raw))
    throw new Error("The server returned an invalid Gmail agent assignment.");
  const currentRevision = positiveIntegerOrNull(raw.current_revision);
  if (
    !isNonEmptyString(raw.mailbox_binding_id) ||
    currentRevision === null ||
    !isNonEmptyString(raw.installation_id) ||
    raw.response_policy !== "cue_routed"
  ) {
    throw new Error("The server returned an invalid Gmail agent assignment.");
  }
  return {
    mailboxBindingId: raw.mailbox_binding_id,
    currentRevision,
    installationId: raw.installation_id,
  };
}

function parseMailboxPolicyView(raw: unknown): MailboxPolicyView {
  if (!isRecord(raw))
    throw new Error("The server returned an invalid Gmail processing policy.");
  if (raw.kind === "disabled_by_default")
    return { kind: "disabled_by_default" };
  const policyVersion = positiveIntegerOrNull(raw.policyVersion);
  if (policyVersion === null)
    throw new Error("The server returned an invalid Gmail policy revision.");
  if (raw.kind === "disabled_by_operator") {
    return { kind: "disabled_by_operator", policyVersion };
  }
  if (raw.kind !== "enabled")
    throw new Error("The server returned an unknown Gmail policy.");
  const maxActiveCases = positiveIntegerOrNull(raw.maxActiveCases);
  const maxMessagesPerHour = positiveIntegerOrNull(raw.maxMessagesPerHour);
  const dailyTokenBudget = positiveIntegerOrNull(raw.dailyTokenBudget);
  const maxMessageBytes = positiveIntegerOrNull(raw.maxMessageBytes);
  const maxAttachmentBytes = positiveIntegerOrNull(raw.maxAttachmentBytes);
  if (
    maxActiveCases === null ||
    maxMessagesPerHour === null ||
    dailyTokenBudget === null ||
    maxMessageBytes === null ||
    maxAttachmentBytes === null
  ) {
    throw new Error("The server returned invalid Gmail policy limits.");
  }
  return {
    kind: "enabled",
    policyVersion,
    maxActiveCases,
    maxMessagesPerHour,
    dailyTokenBudget,
    maxMessageBytes,
    maxAttachmentBytes,
  };
}

function parseAgentMailboxRuntime(raw: unknown): AgentMailboxRuntime {
  if (
    !isRecord(raw) ||
    positiveIntegerOrNull(raw.policy_version) === null ||
    !isNonEmptyString(raw.accepted_history_id) ||
    !isRecord(raw.usage)
  ) {
    throw new Error("The server returned an invalid Gmail processing state.");
  }
  const watchExpiresAt = nullableNonNegativeInteger(raw.watch_expires_at);
  const activeCases = nonNegativeIntegerOrNull(raw.usage.active_cases);
  const admittedLastHour = nonNegativeIntegerOrNull(
    raw.usage.admitted_last_hour,
  );
  const tokensReserved = nonNegativeIntegerOrNull(raw.usage.tokens_reserved);
  const tokensConsumed = nonNegativeIntegerOrNull(raw.usage.tokens_consumed);
  const nextEvaluationAt = nullableNonNegativeInteger(
    raw.usage.next_evaluation_at,
  );
  if (
    activeCases === null ||
    admittedLastHour === null ||
    tokensReserved === null ||
    tokensConsumed === null ||
    nextEvaluationAt === undefined ||
    watchExpiresAt === undefined
  ) {
    throw new Error("The server returned invalid Gmail usage counters.");
  }
  return {
    processing: parseMailboxProcessingView(raw.processing),
    acceptedHistoryId: raw.accepted_history_id,
    watchExpiresAt,
    usage: {
      activeCases,
      admittedLastHour,
      tokensReserved,
      tokensConsumed,
      nextEvaluationAt,
    },
  };
}

function parseMailboxProcessingView(raw: unknown): MailboxProcessingView {
  if (!isRecord(raw))
    throw new Error("The server returned an invalid Gmail processing state.");
  if (raw.kind === "waiting") return { kind: "waiting" };
  const at = nonNegativeIntegerOrNull(raw.at);
  if (raw.kind === "scheduled" && at !== null) {
    return { kind: "scheduled", at };
  }
  const startedAt = nonNegativeIntegerOrNull(raw.startedAt);
  if (raw.kind === "evaluating" && startedAt !== null) {
    return { kind: "evaluating", startedAt };
  }
  const pausedAt = nonNegativeIntegerOrNull(raw.pausedAt);
  if (raw.kind === "paused" && pausedAt !== null) {
    return {
      kind: "paused",
      reason: parseMailboxPauseReasonView(raw.reason),
      pausedAt,
    };
  }
  throw new Error("The server returned an unknown Gmail processing state.");
}

function parseMailboxPauseReasonView(raw: unknown): MailboxPauseReasonView {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw new Error("The server returned an invalid Gmail pause reason.");
  }
  switch (raw.kind) {
    case "active_case_limit":
    case "hourly_message_limit":
      return mailboxPauseReasonFromLimit(
        raw.kind,
        raw.observed,
        raw.limit,
        null,
      );
    case "daily_token_budget": {
      const reserved = nonNegativeIntegerOrNull(raw.reserved);
      const consumed = nonNegativeIntegerOrNull(raw.consumed);
      if (reserved === null || consumed === null) {
        throw new Error("The server returned invalid Gmail token usage.");
      }
      return mailboxPauseReasonFromLimit(
        raw.kind,
        reserved + consumed,
        raw.limit,
        null,
      );
    }
    case "message_too_large":
    case "attachment_too_large":
    case "attachment_total_too_large":
      return mailboxPauseReasonFromLimit(
        raw.kind,
        raw.observedBytes,
        raw.limitBytes,
        raw.providerMessageId,
      );
    default:
      throw new Error("The server returned an unknown Gmail pause reason.");
  }
}

function mailboxPauseReasonFromLimit(
  kind: string,
  observedRaw: unknown,
  limitRaw: unknown,
  providerMessageIdRaw: unknown,
): MailboxPauseReasonView {
  const observed = nonNegativeIntegerOrNull(observedRaw);
  const limit = positiveIntegerOrNull(limitRaw);
  const providerMessageId =
    providerMessageIdRaw === null
      ? null
      : typeof providerMessageIdRaw === "string" &&
          providerMessageIdRaw.length > 0
        ? providerMessageIdRaw
        : undefined;
  if (observed === null || limit === null || providerMessageId === undefined) {
    throw new Error("The server returned invalid Gmail pause limits.");
  }
  return { kind, observed, limit, providerMessageId };
}

function nullableNonNegativeInteger(raw: unknown): number | null | undefined {
  return raw === null ? null : (nonNegativeIntegerOrNull(raw) ?? undefined);
}
