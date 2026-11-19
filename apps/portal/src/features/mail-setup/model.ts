import type {
  MailboxSetupAgent,
  MailboxSetupPlan,
  MailboxSetupRequirementId,
} from "@purin-labs/control-api";

/** What the page knows of a mailbox's setup. */
export type MailboxSetupState =
  /** The person cannot change the mailbox, so the page reads no setup. */
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; plan: MailboxSetupPlan }>;

/**
 * The one action the mailbox offers while it is off.
 *
 * `set_up_and_turn_on` makes the missing changes and turns the mailbox on.
 * `set_up` makes them and leaves it off, because the model is not approved.
 * `turn_on` has nothing left to change. `wait_for_model` has nothing left
 * that this person can change.
 */
export type MailboxSetupAction =
  "set_up_and_turn_on" | "set_up" | "turn_on" | "wait_for_model";

export function mailboxSetupAction(plan: MailboxSetupPlan): MailboxSetupAction {
  const approved = plan.model.kind === "approved";
  if (plan.next !== null) return approved ? "set_up_and_turn_on" : "set_up";
  return approved ? "turn_on" : "wait_for_model";
}

export function requirementIsMet(
  plan: MailboxSetupPlan,
  id: MailboxSetupRequirementId,
): boolean {
  return plan.requirements.some(
    (requirement) => requirement.id === id && requirement.state === "met",
  );
}

/** The agent of the mailbox, as one sentence. */
export function agentSentence(agent: MailboxSetupAgent): string {
  switch (agent.state) {
    case "assigned":
      return `${agent.name} answers this mailbox.`;
    case "ready":
      return `${agent.name} will answer this mailbox.`;
    case "inactive":
      return `${agent.name} will answer this mailbox. Seams Pantry makes it active first.`;
    case "absent":
      return `Seams Pantry creates the agent ${agent.name} for this mailbox. You can change its instructions later on Agents.`;
  }
}

/** The three access changes, as the person reads them. */
export const ACCESS_REQUIREMENTS: readonly Readonly<{
  id: MailboxSetupRequirementId;
  label: (agentName: string) => string;
}>[] = [
  {
    id: "reply_drafts",
    label: (agentName) => `${agentName} may write reply drafts`,
  },
  {
    id: "agent_context",
    label: (agentName) => `${agentName} may read the Case of each email thread`,
  },
  {
    id: "review",
    label: () => "Owners and admins may read this mailbox and its drafts",
  },
];

/** What the model row says. */
export function modelSentence(plan: MailboxSetupPlan): string {
  switch (plan.model.kind) {
    case "approved":
      return "Approved for email content.";
    case "not_approved":
      return "Not approved for email content yet. Seams support records your consent, then approves it. Until then this mailbox stays off.";
    case "unavailable":
      return "No AI model is connected. Connect one under AI account, then ask Seams support to approve it for email content.";
  }
}

/** The sentence beside the action, which says what a press does. */
export function actionHint(
  plan: MailboxSetupPlan,
  action: MailboxSetupAction,
): string {
  const name = plan.agent.name;
  switch (action) {
    case "set_up_and_turn_on":
      return `Seams Pantry makes the changes under Setup. Then ${name} reads new mail. Sensitive or uncertain replies wait as drafts for your approval.`;
    case "set_up":
      return "Seams Pantry makes the changes under Setup. The mailbox stays off until Seams approves your AI model for email content.";
    case "turn_on":
      return `When on, ${name} sends routine replies at once. Sensitive or uncertain replies wait as drafts for your approval.`;
    case "wait_for_model":
      return "This mailbox is set up. It turns on after Seams approves your AI model for email content.";
  }
}
