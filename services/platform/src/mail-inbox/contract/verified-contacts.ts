import type { listVerifiedContactEndpoints } from "../../data/contact-verification";
import { definePort } from "@purin-labs/kernel/port";

/**
 * The verified contacts of a mailbox, as a service interface of the Inbox
 * contract. An Eval names a verified sender as the sender of its scenario.
 * The Inbox owns the verification record, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type VerifiedContacts = Readonly<{
  /** The verified contact endpoints of one mailbox, or null on a failed read. */
  listVerifiedContactEndpoints: typeof listVerifiedContactEndpoints;
}>;

export const verifiedContacts =
  definePort<VerifiedContacts>("verified_contacts");
