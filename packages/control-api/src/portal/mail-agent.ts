import {
  isNonEmptyString,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

/** Why the mailbox agent stopped, as far as the Inbox names it. */
export type MailAgentPause = StrictUnion<
  | Readonly<{ kind: "active_case_limit"; observed: number; limit: number }>
  | Readonly<{ kind: "authorization_expired" }>
  | Readonly<{ kind: "policy_limit" }>
>;

/** What the mailbox agent does now for one mailbox, and the mailbox address. */
export type MailAgentState = StrictUnion<
  | Readonly<{ kind: "on"; address: string }>
  | Readonly<{ kind: "paused"; address: string; reason: MailAgentPause }>
  | Readonly<{ kind: "off"; address: string }>
>;

/**
 * Reads only the facts the Inbox states: the switch, the assigned agent and a
 * pause. The Integrations page owns the full mailbox view.
 */
export function parseMailAgentState(raw: unknown): MailAgentState | null {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.mailbox)) return null;
  const mailbox = raw.mailbox;
  if (
    !isNonEmptyString(mailbox.observed_address) ||
    !isRecord(mailbox.policy) ||
    (mailbox.binding !== null && !isRecord(mailbox.binding))
  )
    return null;
  const policy = mailbox.policy.kind;
  if (
    policy !== "enabled" &&
    policy !== "disabled_by_default" &&
    policy !== "disabled_by_operator"
  )
    return null;
  const address = mailbox.observed_address;
  if (
    policy !== "enabled" ||
    mailbox.binding === null ||
    mailbox.connection_lifecycle !== "active"
  )
    return { kind: "off", address };
  const on: MailAgentState = { kind: "on", address };
  // An enabled mailbox has no runtime until its first evaluation.
  if (mailbox.runtime === null) return on;
  if (!isRecord(mailbox.runtime) || !isRecord(mailbox.runtime.processing))
    return null;
  const processing = mailbox.runtime.processing;
  switch (processing.kind) {
    case "waiting":
    case "scheduled":
    case "evaluating":
      return on;
    case "paused":
      return {
        kind: "paused",
        address,
        reason: parseMailAgentPause(processing.reason),
      };
    default:
      return null;
  }
}

function parseMailAgentPause(raw: unknown): MailAgentPause {
  if (isRecord(raw) && raw.kind === "authorization_expired")
    return { kind: "authorization_expired" };
  if (isRecord(raw) && raw.kind === "active_case_limit") {
    const observed = nonNegativeIntegerOrNull(raw.observed);
    const limit = positiveIntegerOrNull(raw.limit);
    if (observed !== null && limit !== null)
      return { kind: "active_case_limit", observed, limit };
  }
  return { kind: "policy_limit" };
}
