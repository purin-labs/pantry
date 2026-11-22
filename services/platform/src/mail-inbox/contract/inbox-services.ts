import type { readGmailPilotBudget } from "../../data/email-mailbox";
import type { registerSupplierOperationalEmailContact } from "../../data/email-operational";
import { definePort } from "@purin-labs/kernel/port";

/**
 * The Inbox records that other areas use: the Gmail pilot budget that the
 * operators route shows, and the email contact of a new supplier. The Inbox
 * owns them, and the Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type InboxServices = Readonly<{
  readGmailPilotBudget: typeof readGmailPilotBudget;
  registerSupplierOperationalEmailContact: typeof registerSupplierOperationalEmailContact;
}>;

export const inboxServices = definePort<InboxServices>("inbox_services");
