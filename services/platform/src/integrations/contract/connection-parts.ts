import type {
  MailboxConnectionPart,
  WhatsAppConnectionPart,
} from "../../mail-inbox/contract/connection-parts";
import { definePort } from "@purin-labs/kernel/port";

/**
 * The parts that another area registers with the connection workflows and
 * the integrations routes. The Inbox registers the mailbox part of a Gmail
 * connection and the WhatsApp part of a WhatsApp connection, and the Worker
 * registers them once (`worker-ports.ts`).
 */
export type ConnectionParts = Readonly<{
  mailbox: MailboxConnectionPart;
  whatsapp: WhatsAppConnectionPart;
}>;

export const connectionParts = definePort<ConnectionParts>("connection_parts");
