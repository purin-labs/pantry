/**
 * The one transition function of an email reply proposal (Refactor 15). The
 * Case checks each move with it before it writes `case_email_proposal`, and
 * the Portal queue's projection checks each write with it, so that the
 * Connector, the routes and the reply turn move the two copies by the same
 * rules.
 */
import {
  isTerminalMachineState,
  machineTransition,
  type MachineEvent,
  type MachineState,
} from "@seams/std/state-machine";

import type { EmailReplyProposalLifecycle } from "./email-mailbox";
import { EMAIL_REPLY_PROPOSAL_MACHINE } from "./email-reply-proposal.machine";

export type EmailReplyProposalKind = EmailReplyProposalLifecycle["kind"];

// The machine names every lifecycle kind, and nothing else.
type MachineKinds = MachineState<typeof EMAIL_REPLY_PROPOSAL_MACHINE>;
const sameKinds: [MachineKinds, EmailReplyProposalKind] extends [
  EmailReplyProposalKind,
  MachineKinds,
]
  ? true
  : never = true;
void sameKinds;

type EmailReplyProposalEvent = MachineEvent<
  typeof EMAIL_REPLY_PROPOSAL_MACHINE
>;

/** The event that moves a proposal into each state; none enters a first state. */
const EVENT_INTO: Readonly<
  Record<EmailReplyProposalKind, EmailReplyProposalEvent | null>
> = {
  draft_creation_indeterminate: null,
  awaiting_approval: "await_approval",
  approved: "approve",
  sent: "send",
  send_indeterminate: "send_uncertain",
  operator_attested_present: "attest_present",
  operator_attested_absent: "attest_absent",
  proposal_missing: "lose_draft",
  invalidated: "invalidate",
  rejected: "reject",
  expired: "expire",
  superseded: "supersede",
  revoked: "revoke",
};

type EmailReplyProposalMove =
  | Readonly<{ kind: "moved" }>
  /** The proposal already rests in `to`; the write is a repeat. */
  | Readonly<{ kind: "repeat" }>
  | Readonly<{ kind: "refused"; terminal: boolean }>;

/** Whether a proposal of one version may move from `from` to `to`. */
export function emailReplyProposalTransition(
  from: EmailReplyProposalKind,
  to: EmailReplyProposalKind,
): EmailReplyProposalMove {
  const terminal = isTerminalMachineState(EMAIL_REPLY_PROPOSAL_MACHINE, from);
  if (from === to && terminal) return { kind: "repeat" };
  const event = EVENT_INTO[to];
  if (event === null) return { kind: "refused", terminal };
  return machineTransition(EMAIL_REPLY_PROPOSAL_MACHINE, from, event).allowed
    ? { kind: "moved" }
    : { kind: "refused", terminal };
}

/**
 * Whether a later version may replace a proposal that rests in `from`: the
 * earlier version must still be one that a later version supersedes.
 */
export function emailReplyProposalSupersedes(
  from: EmailReplyProposalKind,
): boolean {
  return (
    from === "superseded" ||
    emailReplyProposalTransition(from, "superseded").kind === "moved"
  );
}

export function isEmailReplyProposalKind(
  value: unknown,
): value is EmailReplyProposalKind {
  return typeof value === "string" && Object.hasOwn(EVENT_INTO, value);
}
