import type { MailboxSetupPlan } from "@purin-labs/control-api";

/** What the page knows of a mailbox's setup. */
export type MailboxSetupState =
  /** The person cannot change the mailbox, so the page reads no setup. */
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; plan: MailboxSetupPlan }>;

/**
 * Turn on makes every change that the setup names and turns the mailbox on,
 * in one press. Only the AI model can hold it back: Pantry cannot approve a
 * model for email content by itself.
 */
export function mailboxCanTurnOn(plan: MailboxSetupPlan): boolean {
  return plan.model.kind === "approved";
}

/** The sentence under Turn on: what a press does, or what holds it back. */
export function turnOnHint(plan: MailboxSetupPlan): string {
  switch (plan.model.kind) {
    case "approved":
      return `${plan.agent.name} sends routine replies and keeps sensitive ones as drafts for your approval in Inbox. Owners and admins can also read this mailbox in Pantry.`;
    case "not_approved":
      return "Purin must approve your AI model for email before this mailbox can turn on. Ask Purin support to approve it.";
    case "unavailable":
      return "Connect an AI model under AI account first. Then ask Purin support to approve it for email.";
  }
}
