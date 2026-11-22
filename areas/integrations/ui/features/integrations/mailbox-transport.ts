import { controlRead } from "@purin-labs/control/portal/control-client";
import {
  parseAgentOperationsResponse,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { AgentMailboxView, EmailReplyPreviewResult, EmailReplyQueueItem, EmailOperationalPreviewResult, EmailOperationalQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import type { MailboxInstallationOption } from "@purin-labs/area-inbox/ui/pages/agent-mailbox";
import type { IntegrationAccount } from "@purin-labs/control-api/portal/settings";
import { parseEmailOperationalPreviewResponse, parseEmailReplyPreviewResponse, parseEmailReviewQueue } from "@purin-labs/control-api/portal/email-review";
import { isRecord } from "@purin-labs/std";
import { parseAgentMailboxResponse } from "@purin-labs/control-api/portal/mailbox";

export function agentMailboxPath(
  organisationId: string,
  integrationAccountId: string,
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/agent-mailboxes/${encodeURIComponent(integrationAccountId)}`;
}

export function emailReplyPath(organisationId: string, proposalId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-replies/${encodeURIComponent(proposalId)}`;
}

export function emailOperationalPath(
  organisationId: string,
  proposalId: string,
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-operational/${encodeURIComponent(proposalId)}`;
}

type AgentMailboxSurface = {
  readonly agentMailboxes: readonly AgentMailboxView[];
  readonly emailReplies: readonly EmailReplyQueueItem[];
  readonly emailOperational: readonly EmailOperationalQueueItem[];
  readonly mailboxInstallations: readonly MailboxInstallationOption[];
};

export async function fetchAgentMailboxSurface(
  organisationId: string,
  accounts: readonly IntegrationAccount[],
  organisationIsActive: boolean,
): Promise<AgentMailboxSurface> {
  if (!organisationIsActive) {
    return {
      agentMailboxes: [],
      emailReplies: [],
      emailOperational: [],
      mailboxInstallations: [],
    };
  }
  const mailboxReads: Array<Promise<AgentMailboxView>> = [];
  let hasOperationalEmail = false;
  let needsAgentOptions = false;
  for (const account of accounts) {
    if (account.provider === "gmail" || account.provider === "whatsapp") {
      needsAgentOptions = true;
    }
    if (account.provider === "gmail" && isFullMailboxGmailAccount(account)) {
      mailboxReads.push(
        fetchAgentMailboxView(organisationId, account.integrationAccountId),
      );
    }
    if (
      account.provider === "gmail" &&
      account.capabilities.includes("email.operational.propose")
    ) {
      hasOperationalEmail = true;
    }
  }
  if (!needsAgentOptions) {
    return {
      agentMailboxes: [],
      emailReplies: [],
      emailOperational: [],
      mailboxInstallations: [],
    };
  }
  const [agentMailboxes, emailReviews, operations] = await Promise.all([
    Promise.all(mailboxReads),
    mailboxReads.length > 0 || hasOperationalEmail
      ? fetchEmailReviewQueue(organisationId)
      : Promise.resolve({ emailReplies: [], emailOperational: [] }),
    controlRead(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/operations`,
    ),
  ]);
  return {
    agentMailboxes,
    emailReplies: emailReviews.emailReplies,
    emailOperational: emailReviews.emailOperational,
    mailboxInstallations: mailboxInstallationOptions(
      parseAgentOperationsResponse(operations),
    ),
  };
}

function isFullMailboxGmailAccount(account: IntegrationAccount): boolean {
  return (
    account.provider === "gmail" &&
    account.capabilities.includes("mailbox.ingress")
  );
}

async function fetchAgentMailboxView(
  organisationId: string,
  integrationAccountId: string,
): Promise<AgentMailboxView> {
  return parseAgentMailboxResponse(
    await controlRead(agentMailboxPath(organisationId, integrationAccountId)),
  );
}

async function fetchEmailReviewQueue(organisationId: string): Promise<
  Readonly<{
    readonly emailReplies: readonly EmailReplyQueueItem[];
    readonly emailOperational: readonly EmailOperationalQueueItem[];
  }>
> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-reviews`,
  );
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.reviews)) {
    throw new Error("The server returned an invalid email approval queue.");
  }
  const queue = parseEmailReviewQueue(raw.reviews);
  return {
    emailReplies: queue.replies,
    emailOperational: queue.operational,
  };
}

function mailboxInstallationOptions(
  operations: ReturnType<typeof parseAgentOperationsResponse>,
): readonly MailboxInstallationOption[] {
  const definitionLabels = new Map<string, string>();
  for (const definition of operations.definitions) {
    definitionLabels.set(definition.agentDefinitionId, definition.displayName);
  }
  const options: MailboxInstallationOption[] = [];
  const installed = new Set<string>();
  for (const installation of operations.installations) {
    if (installation.lifecycle !== "active") continue;
    installed.add(installation.agentDefinitionId);
    options.push({
      kind: "ready",
      installationId: installation.installationId,
      label:
        definitionLabels.get(installation.agentDefinitionId) ??
        installation.installationId,
    });
  }
  // An agent with no active installation cannot take a mailbox yet. The list
  // still names it, so that the person does not think it is missing.
  for (const definition of operations.definitions) {
    if (
      definition.lifecycle !== "active" ||
      installed.has(definition.agentDefinitionId)
    )
      continue;
    options.push({
      kind: "setup_needed",
      agentDefinitionId: definition.agentDefinitionId,
      label: definition.displayName,
    });
  }
  return options;
}

export async function readEmailReplyPreview(
  organisationId: string,
  proposalId: string,
): Promise<EmailReplyPreviewResult> {
  return parseEmailReplyPreviewResponse(
    await controlRead(emailReplyPath(organisationId, proposalId)),
  );
}

export async function readEmailOperationalPreview(
  organisationId: string,
  proposalId: string,
): Promise<EmailOperationalPreviewResult> {
  return parseEmailOperationalPreviewResponse(
    await controlRead(emailOperationalPath(organisationId, proposalId)),
  );
}
