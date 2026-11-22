import {
  mailboxModelConsentRequest,
  type MailboxModelReview,
  type MailboxSetupAgentChoice,
  type MailboxSetupPlan,
  type MailboxSetupRequirement,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { sameModelReview } from "./model";
import {
  agentMailboxPath,
  runMailboxSetup,
  type MailboxSetupTarget,
  type MailboxSetupTransport,
} from "./run";

/**
 * Makes the changes that the mailbox's setup names. With `accepted`, it
 * records that the person accepted the reviewed model's data terms. With
 * `turnOn`, it then turns the mailbox on with the server's default limits.
 * It turns on only when no requirement is missing. The Integrations page
 * and the Inbox both turn a mailbox on through here.
 */
export async function setUpMailbox(
  transport: MailboxSetupTransport,
  target: MailboxSetupTarget,
  choice: MailboxSetupAgentChoice,
  turnOn: boolean,
  accepted: MailboxModelReview | null,
): Promise<MailboxSetupPlan> {
  const setup = await runMailboxSetup(transport, target, choice).catch(
    rethrowMailboxSetupProblem,
  );
  let modelAccepted = setup.model.kind === "approved";
  if (setup.model.kind === "consent_needed" && accepted !== null) {
    // The person accepts only the terms that the page showed.
    if (!sameModelReview(setup.model.review, accepted))
      throw new ControlApiError(MODEL_CHANGED, "unknown");
    await transport
      .mutate(
        `${agentMailboxPath(target)}/model-consent`,
        "POST",
        mailboxModelConsentRequest(accepted),
      )
      .catch(rethrowMailboxSetupProblem);
    modelAccepted = true;
  }
  if (!turnOn) return setup;
  if (
    setup.requirements.some(
      (requirement) =>
        requirementIsMissing(requirement) &&
        !(requirement.id === "model" && modelAccepted),
    )
  )
    throw new ControlApiError(
      "The mailbox is set up, and it did not turn on. Open it to see what it still needs.",
      "unknown",
    );
  await transport.mutate(`${agentMailboxPath(target)}/policy`, "POST", {
    policy: { kind: "enabled" },
  });
  return setup;
}

const MODEL_CHANGED =
  "The workspace's AI model or its terms changed. Read the new terms, then press again.";

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
  const code = isRecord(error.details) ? error.details.error : null;
  // The account authority admits an agent only for a manager of the account.
  if (code === "scope_forbidden")
    throw new ControlApiError(
      "Your account role cannot give an agent access to this mailbox. Ask an owner of the account to turn it on.",
      error.kind,
      error.details,
    );
  if (code === "mailbox_model_changed" || code === "mailbox_model_not_reviewed")
    throw new ControlApiError(MODEL_CHANGED, error.kind, error.details);
  throw error;
}
