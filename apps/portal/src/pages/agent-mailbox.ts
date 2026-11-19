import { formatAbsoluteTime, formatLifecycle } from "../formatting";
import type { StatusChipStatus } from "../status-chip";
import { assertNever } from "@purin-labs/std";
import type { AgentMailboxView, MailboxPauseReasonView } from "@purin-labs/control-api/portal/agent-mailbox";
import type { Variant } from "@purin-labs/type-utils";

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

export type MailboxPolicyDraft =
  | { readonly kind: "disabled_by_operator" }
  | {
      readonly kind: "enabled";
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxAttachmentBytes: number;
    };

/** The limits a mailbox turns on with until a person changes them. */
export const DEFAULT_MAILBOX_POLICY: Variant<MailboxPolicyDraft, "enabled"> = {
  kind: "enabled",
  maxActiveCases: 3,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 1_000_000,
  maxMessageBytes: 262_144,
  maxAttachmentBytes: 5_242_880,
};

type MailboxPolicyDraftParseResult =
  | { readonly kind: "valid"; readonly policy: MailboxPolicyDraft }
  | { readonly kind: "invalid"; readonly message: string };

export function parseMailboxPolicyDraft(
  formData: FormData,
): MailboxPolicyDraftParseResult {
  if (formData.get("processingEnabled") !== "on") {
    return { kind: "valid", policy: { kind: "disabled_by_operator" } };
  }
  const limits = {
    maxActiveCases: readPolicyLimit(formData, "maxActiveCases"),
    maxMessagesPerHour: readPolicyLimit(formData, "maxMessagesPerHour"),
    dailyTokenBudget: readPolicyLimit(formData, "dailyTokenBudget"),
    maxMessageBytes: readPolicyLimit(formData, "maxMessageBytes"),
    maxAttachmentBytes: readPolicyLimit(formData, "maxAttachmentBytes"),
  };
  for (const value of Object.values(limits)) {
    if (value === null) {
      return {
        kind: "invalid",
        message: "Every limit must be a whole number greater than zero.",
      };
    }
  }
  return {
    kind: "valid",
    policy: {
      kind: "enabled",
      maxActiveCases: limits.maxActiveCases ?? 0,
      maxMessagesPerHour: limits.maxMessagesPerHour ?? 0,
      dailyTokenBudget: limits.dailyTokenBudget ?? 0,
      maxMessageBytes: limits.maxMessageBytes ?? 0,
      maxAttachmentBytes: limits.maxAttachmentBytes ?? 0,
    },
  };
}

/**
 * Policy limits are whole positive numbers or nothing. Parsing digit-by-digit
 * would let "1.5" publish a limit of 1, so the whole field must be digits
 * before it is trusted; a limit is a policy boundary, not a suggestion.
 */

function readPolicyLimit(formData: FormData, name: string): number | null {
  const raw = formData.get(name);
  if (typeof raw !== "string" || !/^[0-9]+$/u.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The one sentence under a mailbox's address. It says if the agent reads mail
 * now and, if it does not, what holds it back.
 */
export function gmailMailboxSummary(
  mailbox: AgentMailboxView,
  agentName: string | null,
): string {
  if (mailbox.connectionLifecycle !== "active") {
    return "Gmail is not connected. Seams Pantry reads no mail until you reconnect this mailbox.";
  }
  switch (mailbox.policy.kind) {
    case "disabled_by_default":
    case "disabled_by_operator":
      return "Off. New mail stays in Gmail untouched.";
    case "enabled": {
      const processing = mailbox.runtime?.processing ?? null;
      if (processing === null) {
        return "On. Seams Pantry is starting to watch this mailbox.";
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
 * connection is Needs setup, Off, On or Paused. A broken connection outranks
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
  if (mailbox.policy.kind !== "enabled") {
    return mailbox.binding === null
      ? { kind: "info", label: "Needs setup" }
      : { kind: "neutral", label: "Off" };
  }
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
        ? "open Case limit"
        : `${reason.observed.toLocaleString()} open ${reason.observed === 1 ? "Case" : "Cases"}`;
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
      return `Processing paused at the active-Case limit (${observed} open of ${limit} allowed).`;
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

/**
 * Slack channel selection. This used to be a second top-level band that
 * restated the connection status already shown in the Communication group, so
 * Slack appeared twice on one page under two different mental models. It now
 * renders inside that group as the follow-on step it always was.
 */

type MailboxAuthorizationNotice = {
  readonly tone: "info" | "warning" | "danger";
  readonly headline: string;
  readonly detail: string;
};

const AUTHORIZATION_WARNING_MS = 48 * 60 * 60 * 1000;

/**
 * What to tell an operator about this mailbox's Gmail authorization.
 *
 * A pilot runs on a Testing-status Google project, where a refresh token dies
 * on a fixed clock no matter how healthy everything looks. The failure is
 * silent by nature (mail simply stops being answered), so the console states
 * the expiry date while the connection still works, escalates before it
 * lapses, and says plainly what has stopped once it has. Deployments with no
 * configured expiry window show nothing rather than inventing a date.
 */
export function mailboxAuthorizationNotice(
  mailbox: AgentMailboxView,
  now: number,
): MailboxAuthorizationNotice | null {
  const processing = mailbox.runtime?.processing ?? null;
  if (
    processing !== null &&
    processing.kind === "paused" &&
    processing.reason.kind === "authorization_expired"
  ) {
    return {
      tone: "danger",
      headline: "Gmail authorization has expired",
      detail:
        "Processing stopped and no reply can be sent. New mail is still " +
        "waiting in Gmail and was never read. Reconnect this mailbox to resume " +
        "from where it left off. Nothing that arrived meanwhile is skipped.",
    };
  }
  const authorization = mailbox.authorization;
  if (authorization === null || authorization.expiresAt === null) return null;
  const remaining = authorization.expiresAt - now;
  if (remaining <= 0) {
    return {
      tone: "danger",
      headline: "Gmail authorization has lapsed",
      detail:
        `This authorization was due to expire ${formatAbsoluteTime(authorization.expiresAt)}. ` +
        "Reconnect to resume processing from the last message Seams Pantry accepted.",
    };
  }
  if (remaining <= AUTHORIZATION_WARNING_MS) {
    return {
      tone: "warning",
      headline: `Gmail authorization expires ${formatRelativeDeadline(remaining)}`,
      detail:
        `Google ends this authorization ${formatAbsoluteTime(authorization.expiresAt)}. ` +
        "Reconnect before then to avoid a gap; processing pauses until you do.",
    };
  }
  return {
    tone: "info",
    headline: `Gmail authorization expires ${formatAbsoluteTime(authorization.expiresAt)}`,
    detail:
      `This deployment's Google project ends every authorization after ` +
      `${authorization.expiryWindowDays ?? 0} days. Reconnecting resets the window ` +
      "and keeps processing where it left off.",
  };
}

function formatRelativeDeadline(remainingMs: number): string {
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours < 1) return "within the hour";
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
