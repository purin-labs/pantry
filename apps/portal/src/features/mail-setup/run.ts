import {
  encodeMailboxSetupAgentChoice,
  parseMailboxSetupPlan,
  type MailboxSetupAgentChoice,
  type MailboxSetupChange,
  type MailboxSetupPlan,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

export type MailboxSetupTransport = Readonly<{
  read: (path: string) => Promise<unknown>;
  mutate: (path: string, method: "POST", body: unknown) => Promise<unknown>;
}>;

export type MailboxSetupTarget = Readonly<{
  organisationId: string;
  integrationAccountId: string;
}>;

/** A plan names at most nine changes for one mailbox. */
const MAX_CHANGES = 16;

function organisationPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

export function agentMailboxPath(target: MailboxSetupTarget): string {
  return `${organisationPath(target.organisationId)}/agent-mailboxes/${encodeURIComponent(target.integrationAccountId)}`;
}

export async function readMailboxSetup(
  transport: MailboxSetupTransport,
  target: MailboxSetupTarget,
  choice: MailboxSetupAgentChoice,
): Promise<MailboxSetupPlan> {
  const raw = await transport.read(
    `${agentMailboxPath(target)}/setup?agent=${encodeURIComponent(encodeMailboxSetupAgentChoice(choice))}`,
  );
  const plan = isRecord(raw) ? parseMailboxSetupPlan(raw.setup) : null;
  if (plan === null)
    throw new Error(
      "The server returned a mailbox setup this page cannot read.",
    );
  return plan;
}

/**
 * Makes each change that the mailbox's setup names, one at a time, and
 * returns the setup that has no change left.
 *
 * Each change goes to the control route it belongs to, with this person's
 * session. The setup is read again after each one, so a change that another
 * person made in between is not made twice. A change that the server refuses
 * stops the run, and the changes before it stay.
 */
export async function runMailboxSetup(
  transport: MailboxSetupTransport,
  target: MailboxSetupTarget,
  choice: MailboxSetupAgentChoice,
): Promise<MailboxSetupPlan> {
  let agent = choice;
  for (let made = 0; made <= MAX_CHANGES; made += 1) {
    const plan = await readMailboxSetup(transport, target, agent);
    if (plan.next === null) return plan;
    // The first read settles an automatic choice. The later reads keep it.
    agent = plan.agent.choice;
    await transport.mutate(
      changePath(target, plan.next),
      "POST",
      plan.next.body,
    );
  }
  throw new Error("The setup did not finish. Open the mailbox and try again.");
}

function changePath(
  target: MailboxSetupTarget,
  change: MailboxSetupChange,
): string {
  const organisation = organisationPath(target.organisationId);
  switch (change.kind) {
    case "agent_operation":
      return `${organisation}/operations`;
    case "assign_agent":
      return `${agentMailboxPath(target)}/bind`;
    case "enable_action":
      return `${organisation}/access-control/capabilities/${encodeURIComponent(change.capabilityId)}`;
    case "grant_access":
      return `${organisation}/access-control/grants`;
  }
}
