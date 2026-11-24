import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

export type OperationalEmailTarget =
  | Readonly<{
      readonly kind: "customer_contact";
      readonly customerId: string;
      readonly contactId: string;
      readonly contactRevision: number;
      readonly selfTestId?: never;
      readonly address?: never;
      readonly supplierId?: never;
    }>
  | Readonly<{
      readonly kind: "supplier_contact";
      readonly supplierId: string;
      readonly contactId: string;
      readonly contactRevision: number;
      readonly selfTestId?: never;
      readonly address?: never;
      readonly customerId?: never;
    }>;

export type ContactEndpoint =
  | Readonly<{ channel: "gmail"; address: string; waId?: never }>
  | Readonly<{ channel: "whatsapp"; waId: string; address?: never }>;

export type VerifiedContactEndpoint = Readonly<{
  verificationId: string;
  revision: number;
  organisationId: OrganisationId;
  merchantId: string;
  integrationAccountId: IntegrationAccountId;
  target: OperationalEmailTarget;
  endpoint: ContactEndpoint;
}>;

/** The mailbox whose verified contacts a list reads. */
export type VerifiedContactQuery = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
}>;

type ListVerifiedContactEndpoints = (
  input: VerifiedContactQuery,
) => Promise<readonly VerifiedContactEndpoint[] | null>;

/**
 * The verified contacts of a mailbox, as a service interface of the Inbox
 * contract. An Eval names a verified sender as the sender of its scenario.
 * The Inbox owns the verification record, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type VerifiedContacts = Readonly<{
  /** The verified contact endpoints of one mailbox, or null on a failed read. */
  listVerifiedContactEndpoints: ListVerifiedContactEndpoints;
}>;

export const verifiedContacts =
  definePort<VerifiedContacts>("verified_contacts");
