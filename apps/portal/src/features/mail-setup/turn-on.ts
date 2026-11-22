import type {
  MailboxSetupAgentChoice,
  MailboxSetupPlan,
  MailboxSetupRequirement,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { ControlApiError } from "../../control-client";
import {
  agentMailboxPath,
  runMailboxSetup,
  type MailboxSetupTarget,
  type MailboxSetupTransport,
} from "./run";

/**
 * Makes the changes that the mailbox's setup names and, with `turnOn`, turns
 * the mailbox on with the server's default limits. It turns on only when no
 * requirement is missing. The Integrations page and the Inbox both turn a
 * mailbox on through here.
 */
export async function setUpMailbox(
  transport: MailboxSetupTransport,
  target: MailboxSetupTarget,
  choice: MailboxSetupAgentChoice,
  turnOn: boolean,
): Promise<MailboxSetupPlan> {
  const setup = await runMailboxSetup(transport, target, choice).catch(
    rethrowMailboxSetupProblem,
  );
  if (!turnOn) return setup;
  if (setup.requirements.some(requirementIsMissing))
    throw new ControlApiError(
      "The mailbox is set up, and it did not turn on. Open it to see what it still needs.",
      "unknown",
    );
  await transport.mutate(`${agentMailboxPath(target)}/policy`, "POST", {
    policy: { kind: "enabled" },
  });
  return setup;
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
      "Your account role cannot give an agent access to this mailbox. Ask an owner of the account to turn it on.",
      error.kind,
      error.details,
    );
  throw error;
}
