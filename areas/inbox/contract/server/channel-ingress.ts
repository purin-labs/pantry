import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { OrganisationPlacementBindings } from "@purin-labs/tenancy/organisation-execution-scope";

/** The mailbox that a Gmail push names by its address. */
type EmailMailboxRoute = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
};

/** The WhatsApp number account that a Meta webhook event names. */
export type WhatsAppWebhookRoute = {
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly credentialGeneration: number;
};

/** One parsed Meta webhook event, as the Connector admits it. */
export type WhatsAppAdmissionRequest =
  | {
      readonly kind: "text_message";
      readonly customerWaId: string;
      readonly providerMessageId: string;
      readonly providerTimestamp: number;
      readonly body: string;
    }
  | {
      readonly kind: "unsupported_message";
      readonly customerWaId: string;
      readonly providerMessageId: string;
      readonly messageType: string;
    }
  | {
      readonly kind: "status";
      readonly whatsappMessageId: string;
      readonly status: "sent" | "delivered" | "read" | "failed";
      readonly statusAt: number;
      readonly failureCode: string | null;
    };

type FindEmailMailboxByAddress = (input: {
  readonly env: OrganisationPlacementBindings;
  readonly observedAddress: string;
}) => Promise<EmailMailboxRoute | null>;

type RouteWhatsAppWebhookAccount = (input: {
  readonly db: OrganisationDatabase;
  readonly wabaId: string;
  readonly phoneNumberId: string;
}) => Promise<WhatsAppWebhookRoute | null>;

/**
 * The Inbox reads that route a provider push to its Connector: the Gmail
 * push of the email surface and the Meta webhook of the WhatsApp surface.
 * The Inbox owns the account tables, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type ChannelIngress = Readonly<{
  findEmailMailboxByAddress: FindEmailMailboxByAddress;
  routeWhatsAppWebhookAccount: RouteWhatsAppWebhookAccount;
}>;

export const channelIngress = definePort<ChannelIngress>(
  "inbox_channel_ingress",
);
