import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CaseId, OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { EmailOperationalDirectoryError } from "./connection-parts";
import type { EmailReviewProjection } from "./email-review";

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

type ReadLatestEmailReviewProjectionForCase = (
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
  }>,
) => Promise<EmailReviewProjection | null>;

/**
 * The Inbox records that other areas and the surfaces use: the Gmail pilot
 * budget that the operators route shows, the email contact of a new
 * supplier, and the newest email review of a Case that the Slack surface
 * announces. The Inbox owns them, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type InboxServices = Readonly<{
  readGmailPilotBudget: ReadGmailPilotBudget;
  registerSupplierOperationalEmailContact: RegisterSupplierOperationalEmailContact;
  readLatestEmailReviewProjectionForCase: ReadLatestEmailReviewProjectionForCase;
}>;

export const inboxServices = definePort<InboxServices>("inbox_services");
