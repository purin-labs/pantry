import type {
  readEmailMailboxIdentityClaimant,
  registerEmailMailboxAccount,
} from "../../data/email-mailbox";
import type {
  readEmailSenderIdentityClaimant,
  registerEmailSenderAccount,
} from "../../data/email-operational";
import type {
  registerWhatsAppPhoneNumberAccount,
  setWhatsAppProviderHealth,
} from "../../data/whatsapp";
import type { tearDownAgentMailboxForRemoval } from "../agent-mailbox-teardown";

/**
 * The mailbox part of a Gmail connection. The Inbox owns the mailbox and the
 * sender records of a Google account. The connection workflow claims and
 * registers them, and the integrations routes tear the mailbox agent down
 * before an account goes.
 */
export type MailboxConnectionPart = Readonly<{
  readEmailSenderIdentityClaimant: typeof readEmailSenderIdentityClaimant;
  readEmailMailboxIdentityClaimant: typeof readEmailMailboxIdentityClaimant;
  registerEmailSenderAccount: typeof registerEmailSenderAccount;
  registerEmailMailboxAccount: typeof registerEmailMailboxAccount;
  tearDownAgentMailboxForRemoval: typeof tearDownAgentMailboxForRemoval;
}>;

/**
 * The WhatsApp part of a WhatsApp connection: the Inbox owns the phone
 * number record and its provider health.
 */
export type WhatsAppConnectionPart = Readonly<{
  registerWhatsAppPhoneNumberAccount: typeof registerWhatsAppPhoneNumberAccount;
  setWhatsAppProviderHealth: typeof setWhatsAppProviderHealth;
}>;
