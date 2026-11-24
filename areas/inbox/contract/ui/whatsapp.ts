import type { WhatsAppPolicyDraft } from "@purin-labs/control-api/portal/whatsapp";

const WHATSAPP_DEFAULT_RELEVANT_MESSAGE_TOPICS =
  "Purin Pantry, café automation, café and bakery operations, orders, menus, opening hours, and integrations.";

const WHATSAPP_DEFAULT_AUTOMATIC_ACKNOWLEDGEMENT_TEXT =
  "Thanks for your message. We’ve received it and will get back to you shortly.";

export const WHATSAPP_DEFAULT_POLICY_DRAFT: WhatsAppPolicyDraft = {
  maxActiveCases: 5,
  maxMessagesPerHour: 60,
  dailyAgentTokenBudget: 200_000,
  maxMessageBytes: 4_096,
  maxActiveCaseMessages: 40,
  maxActiveCaseBytes: 65_536,
  debounceSeconds: 15,
  relevantMessageTopics: WHATSAPP_DEFAULT_RELEVANT_MESSAGE_TOPICS,
  automaticAcknowledgementText: WHATSAPP_DEFAULT_AUTOMATIC_ACKNOWLEDGEMENT_TEXT,
};

export function whatsappAccountsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/whatsapp-accounts`;
}

export function whatsappAccountActionPath(
  organisationId: string,
  integrationAccountId: string,
  action: string,
): string {
  return `${whatsappAccountsPath(organisationId)}/${encodeURIComponent(integrationAccountId)}/${action}`;
}

function whatsappRepliesPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/whatsapp-replies`;
}

export function whatsappReplyPath(
  organisationId: string,
  proposalId: string,
): string {
  return `${whatsappRepliesPath(organisationId)}/${encodeURIComponent(proposalId)}`;
}

export function whatsappCasePath(
  organisationId: string,
  caseId: string,
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/whatsapp-cases/${encodeURIComponent(caseId)}`;
}
