import type {
  MailboxSetupAgentChoice,
  MailboxSetupPlan,
  MailboxSetupRequirement,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

import { ControlApiError } from "../../control-client";
import type { MailboxPolicyDraft } from "../../pages/agent-mailbox";
import {
  agentMailboxPath,
  runMailboxSetup,
  type MailboxSetupTarget,
  type MailboxSetupTransport,
} from "./run";

/**
 * Makes the changes that the mailbox's setup names and, with a policy, turns
 * the mailbox on. It turns on only when no requirement is missing. The
 * Integrations page and the Inbox both set a mailbox up through here.
 */
export async function setUpMailbox(
  transport: MailboxSetupTransport,
  target: MailboxSetupTarget,
  choice: MailboxSetupAgentChoice,
  policy: MailboxPolicyDraft | null,
): Promise<MailboxSetupPlan> {
  const setup = await runMailboxSetup(transport, target, choice).catch(
    rethrowMailboxSetupProblem,
  );
  if (policy === null) return setup;
  if (setup.requirements.some(requirementIsMissing))
    throw new ControlApiError(
      "The mailbox is set up, and it did not turn on. Open it to see what it still needs.",
      "unknown",
    );
  await transport.mutate(`${agentMailboxPath(target)}/policy`, "POST", {
    policy: mailboxPolicyWireBody(policy),
  });
  return setup;
}

export function mailboxPolicyWireBody(
  policy: MailboxPolicyDraft,
): Record<string, unknown> {
  return policy.kind === "enabled"
    ? {
        kind: "enabled",
        maxActiveCases: policy.maxActiveCases,
        maxMessagesPerHour: policy.maxMessagesPerHour,
        dailyTokenBudget: policy.dailyTokenBudget,
        maxMessageBytes: policy.maxMessageBytes,
        maxAttachmentBytes: policy.maxAttachmentBytes,
        debounce: { kind: "push_triggered", coalesceSeconds: 30 },
        overflow: "pause_and_notify",
      }
    : { kind: "disabled_by_operator" };
}

function requirementIsMissing(requirement: MailboxSetupRequirement): boolean {
  return requirement.state === "missing";
}

/**
 * Says why a setup stopped, in words the person can act on. The changes
 * before the one that failed stay, and the next press continues from there.
 */
function rethrowMailboxSetupProblem(error: unknown): never {
  if (!(error instanceof ControlApiError))
    throw new ControlApiError(
      error instanceof Error
        ? error.message
        : "The setup did not finish. Open the mailbox and try again.",
      "unknown",
    );
  // The account authority admits an agent only for a manager of the account.
  if (isRecord(error.details) && error.details.error === "scope_forbidden")
    throw new ControlApiError(
      "Your account role cannot give an agent access to this mailbox. Ask an owner of the account to finish the setup.",
      error.kind,
      error.details,
    );
  throw error;
}
