import React from "react";
import type {
  EmailReplyPreviewResult,
  EmailOperationalPreviewResult,
} from "@purin-labs/control-api/portal/agent-mailbox";
import {
  runIntegrationsCommand,
  runProviderConnection,
  startProviderConnection,
} from "./page-actions";
import type {
  IntegrationsRouteMutationContext,
  MailboxSetupRequest,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/settings-types";

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

/**
 * Makes each change that the mailbox's setup names, and records the
 * acceptance of the model's terms. With `turnOn`, it then turns the mailbox
 * on with the server's default limits.
 */
export async function setUpMailbox(
  context: IntegrationsRouteMutationContext,
  request: MailboxSetupRequest,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    {
      kind: "set_up_mailbox",
      integrationAccountId: request.integrationAccountId,
      agent: request.agent.choice,
      turnOn: request.turnOn,
      accepted: request.accepted,
    },
    { kind: "agent_mailbox", integrationAccountId: request.integrationAccountId },
    request.turnOn
      ? `${request.agent.name} now reads new mail in ${request.address}.`
      : request.accepted !== null
        ? `${request.agent.name} reads new mail in ${request.address} again.`
        : `${request.agent.name} has the access it needs again.`,
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
    "Mail sync restarted. Purin Pantry starts again from now.",
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
    "Reply rejected. Purin Pantry is removing its draft from Gmail.",
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
