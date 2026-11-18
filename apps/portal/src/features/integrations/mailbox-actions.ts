import React from "react";
import type { OrganisationMutation } from "../../mutation-state";
import { parseMailboxPolicyDraft, type MailboxPolicyDraft } from "../../pages/agent-mailbox";
import type { EmailReplyPreviewResult, EmailOperationalPreviewResult } from "@seams/control-api/portal/agent-mailbox";
import type { MailboxSetupAgent } from "@seams/control-api";
import {
  runIntegrationsCommand,
  runProviderConnection,
  startProviderConnection,
} from "./page-actions";
import type { IntegrationsRouteMutationContext } from "./settings-types";

/**
 * The Gmail, Dropbox and Google Drive cards state what the sign-in allows, as
 * the consent sheet does, so their buttons open the provider without the
 * consent sheet in between.
 */
export async function connectGmail(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  context.setFeedback(null);
  await startProviderConnection(
    context,
    { kind: "connect_gmail" },
    { kind: "connect_provider", provider: "gmail" },
  );
}

export async function connectGmailSendOnly(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  context.setFeedback(null);
  await startProviderConnection(
    context,
    { kind: "connect_gmail_send_only" },
    { kind: "connect_provider", provider: "gmail" },
  );
}

export async function connectDropbox(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  context.setFeedback(null);
  await startProviderConnection(
    context,
    { kind: "connect_dropbox" },
    { kind: "connect_provider", provider: "dropbox" },
  );
}

export async function connectGoogleDrive(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  context.setFeedback(null);
  await startProviderConnection(
    context,
    { kind: "connect_google_drive" },
    { kind: "connect_provider", provider: "google_drive" },
  );
}

export async function connectWhatsApp(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_whatsapp" },
    { kind: "connect_provider", provider: "whatsapp" },
  );
}

export async function publishMailboxPolicy(
  context: IntegrationsRouteMutationContext,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const integrationAccountId = formData.get("integrationAccountId");
  if (typeof integrationAccountId !== "string") return;
  const mutation: OrganisationMutation = {
    kind: "agent_mailbox",
    integrationAccountId,
  };
  const parsed = parseMailboxPolicyDraft(formData);
  if (parsed.kind === "invalid") {
    context.setFeedback({ mutation, message: parsed.message });
    return;
  }
  await runIntegrationsCommand(
    context,
    {
      kind: "publish_mailbox_policy",
      integrationAccountId,
      policy: parsed.policy,
    },
    mutation,
    parsed.policy.kind === "enabled"
      ? "Saved. Processing is on with these limits."
      : "Processing is off. New mail stays in Gmail untouched.",
  );
}

/** One press of the mailbox's setup action. */
export type MailboxSetupRequest = {
  readonly integrationAccountId: string;
  readonly address: string;
  readonly agent: MailboxSetupAgent;
  /** The limits form to turn the mailbox on with. Null leaves it as it is. */
  readonly limitsFormId: string | null;
};

/**
 * Makes each change that the mailbox's setup names. With a limits form, it
 * then turns the mailbox on with the limits on screen.
 */
export async function setUpMailbox(
  context: IntegrationsRouteMutationContext,
  request: MailboxSetupRequest,
): Promise<void> {
  const integrationAccountId = request.integrationAccountId;
  const mutation: OrganisationMutation = {
    kind: "agent_mailbox",
    integrationAccountId,
  };
  let policy: MailboxPolicyDraft | null = null;
  if (request.limitsFormId !== null) {
    const form = document.getElementById(request.limitsFormId);
    if (!(form instanceof HTMLFormElement)) return;
    // A closed Limits section cannot show which field is invalid.
    if (!form.checkValidity()) {
      const section = form.closest("details");
      if (section !== null) section.open = true;
      form.reportValidity();
      return;
    }
    const parsed = parseMailboxPolicyDraft(new FormData(form));
    if (parsed.kind === "invalid") {
      context.setFeedback({ mutation, message: parsed.message });
      return;
    }
    policy = parsed.policy;
  }
  await runIntegrationsCommand(
    context,
    {
      kind: "set_up_mailbox",
      integrationAccountId,
      agent: request.agent.choice,
      policy,
    },
    mutation,
    policy === null
      ? `${request.agent.name} is set up for ${request.address}.`
      : `${request.agent.name} now reads new mail in ${request.address}.`,
  );
}

export async function resumeMailboxProcessing(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    { kind: "resume_mailbox", integrationAccountId },
    { kind: "agent_mailbox", integrationAccountId },
    "Processing resumed.",
  );
}

export async function reconnectAgentMailbox(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    { kind: "reconnect_mailbox", integrationAccountId },
    { kind: "agent_mailbox", integrationAccountId },
    "Mail sync restarted. Seams Pantry starts again from now.",
  );
}

export async function disableAgentMailbox(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    { kind: "disable_mailbox", integrationAccountId },
    { kind: "agent_mailbox", integrationAccountId },
    "Processing is off. New mail stays in Gmail.",
  );
}

export async function revokeAgentMailbox(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    { kind: "revoke_mailbox", integrationAccountId },
    { kind: "agent_mailbox", integrationAccountId },
    "Mailbox access revoked.",
  );
}

export async function skipAndResumeMailboxProcessing(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  const providerMessageId = event.currentTarget.dataset.messageId;
  if (integrationAccountId === undefined || providerMessageId === undefined)
    return;
  await runIntegrationsCommand(
    context,
    {
      kind: "skip_and_resume_mailbox",
      integrationAccountId,
      providerMessageId,
    },
    { kind: "agent_mailbox", integrationAccountId },
    "Message skipped. Processing resumed; the skipped message stays in Gmail.",
  );
}

export function loadEmailReplyPreview(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
): Promise<EmailReplyPreviewResult> {
  return context.props.transport.readEmailReply(
    context.props.organisationId,
    proposalId,
  );
}

export async function approveEmailReply(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
  approval: {
    readonly version: number;
    readonly snapshotDigest: string;
    readonly challenge: string;
  },
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "approve_email_reply", proposalId, ...approval },
    { kind: "email_reply", proposalId, operation: "approve" },
    "Reply sent from your Gmail address.",
  );
}

export async function rejectEmailReply(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "reject_email_reply", proposalId },
    { kind: "email_reply", proposalId, operation: "reject" },
    "Reply rejected. Seams Pantry is removing its draft from Gmail.",
  );
}

export async function resolveEmailReply(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
  dispatchVersion: number,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "resolve_email_reply", proposalId, dispatchVersion },
    { kind: "email_reply", proposalId, operation: "resolve" },
    "Send state reconciled with Gmail.",
  );
}

export function loadEmailOperationalPreview(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
): Promise<EmailOperationalPreviewResult> {
  return context.props.transport.readEmailOperational(
    context.props.organisationId,
    proposalId,
  );
}

export async function approveEmailOperational(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
  approval: {
    readonly version: number;
    readonly snapshotDigest: string;
    readonly challenge: string;
    readonly selfTestOwnershipConfirmed?: true;
  },
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "approve_email_operational", proposalId, ...approval },
    { kind: "email_operational", proposalId, operation: "approve" },
    "Accepted by Gmail.",
  );
}

export async function rejectEmailOperational(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "reject_email_operational", proposalId },
    { kind: "email_operational", proposalId, operation: "reject" },
    "Operational email rejected.",
  );
}

export async function editEmailOperational(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
  subject: string,
  body: string,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "edit_email_operational", proposalId, subject, body },
    { kind: "email_operational", proposalId, operation: "edit" },
    "Operational email updated for review.",
  );
}

export async function attestEmailOperational(
  context: IntegrationsRouteMutationContext,
  proposalId: string,
  attestation: "present" | "absent",
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "attest_email_operational", proposalId, attestation },
    { kind: "email_operational", proposalId, operation: "attest" },
    attestation === "present"
      ? "Recorded that the message is present in Sent Mail."
      : "Recorded that the message is absent. Create a new proposal before sending again.",
  );
}
