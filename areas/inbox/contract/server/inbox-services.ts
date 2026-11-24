import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { EmailOperationalDirectoryError } from "./connection-parts";

export type GmailPilotBudget = {
  readonly environment: string;
  readonly consumed: number;
  readonly operatingCap: number;
  readonly submissionTrigger: number;
  readonly remaining: number;
  readonly status: "healthy" | "submit_verification" | "exhausted";
};

/** The Organisation databases and the limits of one Gmail pilot budget. */
export type GmailPilotBudgetQuery = {
  readonly databases: readonly OrganisationDatabase[];
  readonly environment: string;
  readonly operatingCap: number;
  readonly submissionTrigger: number;
};

/** The email contact of a new supplier. */
export type SupplierEmailContactRegistration = Readonly<{
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly supplierId: string;
  readonly contactRevision: number;
  readonly address: string;
  readonly displayName: string;
  readonly now: number;
}>;

type ReadGmailPilotBudget = (
  input: GmailPilotBudgetQuery,
) => Promise<GmailPilotBudget>;

type RegisterSupplierOperationalEmailContact = (
  input: SupplierEmailContactRegistration,
) => Promise<Result<null, EmailOperationalDirectoryError>>;

/**
 * The Inbox records that other areas use: the Gmail pilot budget that the
 * operators route shows, and the email contact of a new supplier. The Inbox
 * owns them, and the Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type InboxServices = Readonly<{
  readGmailPilotBudget: ReadGmailPilotBudget;
  registerSupplierOperationalEmailContact: RegisterSupplierOperationalEmailContact;
}>;

export const inboxServices = definePort<InboxServices>("inbox_services");
