import { formatLifecycle } from "../formatting";
import type { StatusChipStatus } from "../status-chip";
import { assertNever } from "@purin-labs/std";
import type { AgentMailboxView, MailboxPauseReasonView } from "@purin-labs/control-api/portal/agent-mailbox";

/**
 * An agent in a mailbox's list. A mailbox can be assigned to an agent that is
 * installed. An agent that exists without an active installation is named
 * too, so that the person sees why it cannot be chosen.
 */
export type MailboxInstallationOption =
  | {
      readonly kind: "ready";
      readonly installationId: string;
      readonly label: string;
      readonly agentDefinitionId?: never;
    }
  | {
      readonly kind: "setup_needed";
      readonly agentDefinitionId: string;
      readonly label: string;
      readonly installationId?: never;
    };

/**
 * The one sentence under a mailbox's address. It says if the agent reads mail
 * now and, if it does not, what holds it back.
 */
export function gmailMailboxSummary(
  mailbox: AgentMailboxView,
  agentName: string | null,
): string {
  if (mailbox.connectionLifecycle !== "active") {
    return "Gmail is not connected. Purin Pantry reads no mail until you reconnect this mailbox.";
  }
  switch (mailbox.policy.kind) {
    case "disabled_by_default":
    case "disabled_by_operator":
      return "Off. New mail stays in Gmail untouched.";
    case "enabled": {
      const processing = mailbox.runtime?.processing ?? null;
      if (processing === null) {
        return "On. Purin Pantry is starting to watch this mailbox.";
      }
      if (processing.kind === "paused") {
        return "Paused. New mail stays in Gmail until processing resumes.";
      }
      return `On. ${agentName ?? "The assigned agent"} reads new mail and prepares replies.`;
    }
    default:
      return assertNever(mailbox.policy, "Unhandled agent mailbox variant");
  }
}

/**
 * The one chip a mailbox shows, in the list and in its own view. A working
 * connection is Off, On or Paused. A broken connection outranks
 * them, because "On" is false while Gmail refuses Pantry.
 */
export function gmailMailboxStatus(
  mailbox: AgentMailboxView,
): StatusChipStatus {
  if (mailbox.connectionLifecycle !== "active") {
    return {
      kind: "warning",
      label: formatLifecycle(mailbox.connectionLifecycle),
    };
  }
  if (mailbox.policy.kind !== "enabled") return { kind: "neutral", label: "Off" };
  const processing = mailbox.runtime?.processing ?? null;
  // The switch is on, but the runtime has not reported: on, not yet live.
  if (processing === null) return { kind: "info", label: "On" };
  switch (processing.kind) {
    case "paused":
      return {
        kind: "warning",
        label: `Paused · ${gmailPauseReasonLabel(processing.reason)}`,
      };
    case "evaluating":
    case "scheduled":
    case "waiting":
      return { kind: "success", label: "On" };
    default:
      return assertNever(processing, "Unhandled agent mailbox variant");
  }
}

/** The pause reason in the few words that fit beside "Paused" on a chip. */
function gmailPauseReasonLabel(reason: MailboxPauseReasonView): string {
  switch (reason.kind) {
    case "active_case_limit":
      return reason.observed === null
        ? "emails in progress"
        : `${reason.observed.toLocaleString()} ${reason.observed === 1 ? "email" : "emails"} in progress`;
    case "hourly_message_limit":
      return "hourly message limit";
    case "daily_token_budget":
      return "daily token budget";
    case "message_too_large":
      return "message too large";
    case "attachment_too_large":
    case "attachment_total_too_large":
      return "attachment too large";
    case "authorization_expired":
      return "Gmail sign-in expired";
    default:
      return "limit reached";
  }
}

export function gmailPauseCopy(reason: MailboxPauseReasonView): string {
  const observed = reason.observed?.toLocaleString() ?? null;
  const limit = reason.limit?.toLocaleString() ?? null;
  switch (reason.kind) {
    case "active_case_limit":
      return `Processing paused: ${observed} emails are in progress, and ${limit} is the most at one time. Resume lets them finish first.`;
    case "hourly_message_limit":
      return `Processing paused at the hourly message limit (${observed} of ${limit} this hour).`;
    case "daily_token_budget":
      return `Processing paused at the daily token budget (${limit} tokens).`;
    case "message_too_large":
      return `Processing paused on a message larger than the policy allows (${observed} of ${limit} bytes).`;
    case "attachment_too_large":
      return `Processing paused on an attachment larger than the policy allows (${observed} of ${limit} bytes).`;
    case "authorization_expired":
      return (
        "Processing paused because Gmail authorization expired. New mail is " +
        "waiting in Gmail, unread. Reconnect to resume."
      );
    case "attachment_total_too_large":
      return `Processing paused on a message whose attachments together exceed the policy limit (${observed} of ${limit} bytes).`;
    default:
      return "Processing paused by a policy limit.";
  }
}

export function emailReplyIsOpenable(lifecycleKind: string): boolean {
  return lifecycleKind === "awaiting_approval";
}

export function emailReplyLifecycleLabel(lifecycleKind: string): string {
  switch (lifecycleKind) {
    case "awaiting_approval":
      return "Awaiting your approval";
    case "sent":
      return "Sent";
    case "rejected":
      return "Rejected";
    case "invalidated":
      return "Invalidated by a Gmail edit";
    case "expired":
      return "Expired";
    case "superseded":
      return "Superseded by a newer version";
    case "send_indeterminate":
      return "Send unconfirmed";
    case "proposal_missing":
      return "Draft deleted in Gmail";
    default:
      return "Recorded";
  }
}

export function emailReplyLifecycleStatus(
  lifecycleKind: string,
): StatusChipStatus {
  switch (lifecycleKind) {
    case "awaiting_approval":
      return { kind: "info", label: "Needs review" };
    case "sent":
      return { kind: "success", label: "Sent" };
    case "send_indeterminate":
      return { kind: "warning", label: "Unconfirmed" };
    case "invalidated":
    case "expired":
    case "proposal_missing":
      return { kind: "neutral", label: "Closed" };
    case "rejected":
      return { kind: "neutral", label: "Rejected" };
    case "superseded":
      return { kind: "neutral", label: "Superseded" };
    default:
      return { kind: "neutral", label: "Recorded" };
  }
}
