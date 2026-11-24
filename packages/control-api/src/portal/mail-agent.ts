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

/**
 * Why new mail waits for the AI model. Mail goes only to a model that Purin
 * reviewed for email and whose data terms an owner or admin accepted.
 */
export type MailAgentHold = StrictUnion<
  | Readonly<{ kind: "model_terms"; model: string }>
  | Readonly<{ kind: "model_not_reviewed"; model: string }>
>;

/** What the mailbox agent does now for one mailbox, and the mailbox address. */
export type MailAgentState = StrictUnion<
  | Readonly<{ kind: "on"; address: string }>
  | Readonly<{ kind: "paused"; address: string; reason: MailAgentPause }>
  | Readonly<{ kind: "held"; address: string; reason: MailAgentHold }>
  | Readonly<{ kind: "off"; address: string }>
>;

/**
 * Reads only the facts the Inbox states: the switch, the assigned agent, a
 * pause and a wait for the model. The Integrations page owns the full
 * mailbox view.
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
  const hold = parseMailAgentHold(mailbox.model);
  const on: MailAgentState =
    hold === null
      ? { kind: "on", address }
      : { kind: "held", address, reason: hold };
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

function parseMailAgentHold(raw: unknown): MailAgentHold | null {
  if (!isRecord(raw) || !isNonEmptyString(raw.name)) return null;
  if (raw.kind === "consent_needed")
    return { kind: "model_terms", model: raw.name };
  if (raw.kind === "not_reviewed")
    return { kind: "model_not_reviewed", model: raw.name };
  return null;
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
