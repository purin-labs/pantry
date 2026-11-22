import type {
  ConnectedIntegrationSeed,
  ProviderConnectionAuthority,
} from "@purin-labs/connections/data/integration-account";
import type {
  WhatsAppConversationOwnership,
  WhatsAppIngressPolicy,
  WhatsAppIngressPolicyPublishRequest,
  WhatsAppReplyProposalLifecycle,
} from "../src/data/whatsapp";
import type { WhatsAppSendOutcome } from "@purin-labs/connections/whatsapp/graph";
import type { WhatsAppWebhookEvent } from "../src/whatsapp/webhook";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/index";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  parseWhatsAppCustomerId,
  parseWhatsAppMessageId,
  parseWhatsAppPhoneNumberId,
  parseWhatsAppBusinessAccountId,
} from "@purin-labs/connections/whatsapp/identifiers";

/**
 * Compile-time evidence that the WhatsApp domain cannot express the states
 * Plan 32 forbids: a connection without its organisation Vault credential, the
 * removed shared-application authority, a lifecycle constructed from loose
 * fields, or a send outcome that is simultaneously accepted and unprovable.
 */

const credentialRef = requireParsed(
  parseVaultHandle("vault:organisation:gmail:sub:oauth:g1"),
);
const userId = requireParsed(
  parseUserId("user_ae9defbd-6a95-5345-8a5d-951ce3c97a4e"),
);
const wabaId = requireParsed(parseWhatsAppBusinessAccountId("102290129340398"));
const phoneNumberId = requireParsed(
  parseWhatsAppPhoneNumberId("106540352242922"),
);
const customerWaId = requireParsed(parseWhatsAppCustomerId("15550002222"));
const whatsappMessageId = requireParsed(
  parseWhatsAppMessageId("wamid.FIXTURE"),
);

const organisationCredential: ProviderConnectionAuthority = {
  kind: "connection_credential",
  credentialGeneration: 1,
  credentialRef,
};

const removedSharedGrant: ProviderConnectionAuthority = {
  // @ts-expect-error shared application grants are no longer a connection authority
  kind: "shared_application_asset_grant",
};

const mixedAuthority: ProviderConnectionAuthority = {
  kind: "connection_credential",
  credentialGeneration: 1,
  credentialRef,
  // @ts-expect-error connection credentials cannot carry shared application state
  providerApplication: "whatsapp",
};

// @ts-expect-error a connection credential always requires its Vault handle
const missingCredential: ProviderConnectionAuthority = {
  kind: "connection_credential",
  credentialGeneration: 1,
};

const looseSeed: Pick<ConnectedIntegrationSeed, "authority"> = {
  // @ts-expect-error the connect seed no longer accepts a bare credential handle
  credentialRef,
};

const fabricatedOwner: WhatsAppConversationOwnership = {
  kind: "human_owned",
  // @ts-expect-error a human owner must be a real control identity
  ownerId: "pending_operator",
  startedAt: 1,
  reason: "agent_handoff",
};

const agentWithOwner: WhatsAppConversationOwnership = {
  kind: "agent_active",
  // @ts-expect-error agent_active ownership carries no owner
  ownerId: userId,
};

const unknownReason: WhatsAppConversationOwnership = {
  kind: "human_owned",
  ownerId: userId,
  startedAt: 1,
  // @ts-expect-error takeover reasons are exhaustive
  reason: "operator_guess",
};

// @ts-expect-error a sent proposal must carry the WhatsApp message id
const sentWithoutReceipt: WhatsAppReplyProposalLifecycle = {
  kind: "sent",
  sentAt: 1,
};

// @ts-expect-error a rejected proposal must record its disposal
const rejectedWithoutDisposal: WhatsAppReplyProposalLifecycle = {
  kind: "rejected",
  rejectedBy: "control_1",
  rejectedAt: 1,
};

const autonomousSend: WhatsAppReplyProposalLifecycle = {
  // @ts-expect-error v1 has no autonomous-send lifecycle branch
  kind: "sent_without_approval",
  whatsappMessageId: "wamid.X",
  sentAt: 1,
};

// @ts-expect-error an enabled policy cannot omit the debounce bound
const policyWithoutDebounce: WhatsAppIngressPolicyPublishRequest = {
  kind: "enabled",
  maxActiveCases: 1,
  maxMessagesPerHour: 1,
  dailyAgentTokenBudget: 1,
  maxMessageBytes: 1,
  maxActiveCaseMessages: 1,
  maxActiveCaseBytes: 1,
  overflow: "pause_and_notify",
  notificationDestination: { kind: "organisation_communication_destination" },
};

const unknownOverflow: WhatsAppIngressPolicyPublishRequest = {
  kind: "enabled",
  maxActiveCases: 1,
  maxMessagesPerHour: 1,
  dailyAgentTokenBudget: 1,
  maxMessageBytes: 1,
  maxActiveCaseMessages: 1,
  maxActiveCaseBytes: 1,
  debounceSeconds: 15,
  // @ts-expect-error overflow is a closed union
  overflow: "drop_oldest",
  notificationDestination: { kind: "organisation_communication_destination" },
};

const defaultPolicy: WhatsAppIngressPolicy = {
  kind: "disabled_by_default",
  connectedAt: 1,
};
// @ts-expect-error the default policy branch has no limits to read
const defaultPolicyLimit: number = defaultPolicy.maxActiveCases;

// @ts-expect-error an accepted send always carries a WhatsApp message id
const acceptedWithoutId: WhatsAppSendOutcome = { kind: "accepted" };

const partialSend: WhatsAppSendOutcome = {
  kind: "accepted",
  whatsappMessageId,
  // @ts-expect-error there is no partially-delivered send outcome
  indeterminate: true,
};

const mediaEvent: WhatsAppWebhookEvent = {
  // @ts-expect-error the webhook union has no media message branch
  kind: "media_message",
  wabaId,
  phoneNumberId,
  customerWaId,
  providerMessageId: whatsappMessageId,
  providerTimestamp: 1,
  mediaId: "media-1",
};

const unsupportedWithBody: WhatsAppWebhookEvent = {
  kind: "unsupported_message",
  wabaId,
  phoneNumberId,
  customerWaId,
  providerMessageId: whatsappMessageId,
  providerTimestamp: 1,
  messageType: "image",
  // @ts-expect-error an unsupported message never carries provider content
  body: "leaked caption",
};

function requireParsed<T>(
  parsed:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

export type WhatsAppTypeFixtures = {
  readonly organisationCredential: typeof organisationCredential;
  readonly removedSharedGrant: typeof removedSharedGrant;
  readonly mixedAuthority: typeof mixedAuthority;
  readonly missingCredential: typeof missingCredential;
  readonly looseSeed: typeof looseSeed;
  readonly fabricatedOwner: typeof fabricatedOwner;
  readonly agentWithOwner: typeof agentWithOwner;
  readonly unknownReason: typeof unknownReason;
  readonly sentWithoutReceipt: typeof sentWithoutReceipt;
  readonly rejectedWithoutDisposal: typeof rejectedWithoutDisposal;
  readonly autonomousSend: typeof autonomousSend;
  readonly policyWithoutDebounce: typeof policyWithoutDebounce;
  readonly unknownOverflow: typeof unknownOverflow;
  readonly defaultPolicyLimit: typeof defaultPolicyLimit;
  readonly acceptedWithoutId: typeof acceptedWithoutId;
  readonly partialSend: typeof partialSend;
  readonly mediaEvent: typeof mediaEvent;
  readonly unsupportedWithBody: typeof unsupportedWithBody;
};
