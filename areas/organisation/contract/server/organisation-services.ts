import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { IntegrationAccountMutation } from "@purin-labs/connections/data/integration-account";
import type { AgentOperationsError } from "@purin-labs/agent/data/agent-operations";
import { definePort } from "@purin-labs/kernel/port";
import type {
  ConfirmOperatorDraftInput,
  OperatorConfigurationDraft,
  OperatorDraftError,
  OperatorDraftReceipt,
} from "./operator-drafts";

export type RemoveIntegrationAccountError =
  | { readonly code: "integration_account_not_found" }
  | { readonly code: "integration_account_not_disabled" }
  | { readonly code: "integration_account_is_default_for_provider" }
  | { readonly code: "integration_account_in_use" }
  | { readonly code: "provider_attempt_in_progress" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "provider_connection_corrupt" };

export type RemoveIntegrationAccountResult = {
  readonly receiptId: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

type RemoveIntegrationAccount = (input: {
  readonly db: OrganisationDatabase;
  // The global directory, which holds the Slack connection records.
  readonly directory: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly removedByUserId: UserId;
  readonly mutation: IntegrationAccountMutation;
  readonly now: number;
}) => Promise<
  Result<RemoveIntegrationAccountResult, RemoveIntegrationAccountError>
>;

type ReadOperatorDraft = (
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  draftId: string,
) => Promise<OperatorConfigurationDraft | null>;

/** The pending draft of a Case that a reply in its thread confirms. */
type ReadPendingOperatorDraft = (
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
    now: number;
  }>,
) => Promise<OperatorConfigurationDraft | null>;

/** The newest decided draft of a Case, for a repeated confirmation. */
type ReadLatestDecidedOperatorDraft = (
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
  }>,
) => Promise<OperatorConfigurationDraft | null>;

type CancelOperatorConfigurationDraft = (
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    draftId: string;
    actorUserId: string;
    now: number;
  }>,
) => Promise<Result<true, OperatorDraftError>>;

type ConfirmOperatorConfigurationDraft = (
  input: ConfirmOperatorDraftInput,
) => Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
>;

/** A finished run of the email watch reconciliation of the Inbox. */
export type EmailWatchReconciliationRun = Readonly<{
  reconciliationRunId: string;
  organisationId: string;
  environment: string;
  lifecycle: "completed" | "failed";
  repairCount: number;
  reasonCode: string | null;
  now: number;
}>;

type PrepareEmailWatchReconciliationRun = (
  db: OrganisationDatabase,
  input: EmailWatchReconciliationRun,
) => D1PreparedStatement;

/**
 * The Organisation records that other areas use: the removal of an
 * integration account, the configuration drafts that a Kitchen workflow
 * change waits on and that a Slack reply confirms, and the record of an
 * email watch reconciliation run. The Organisation area owns them, and the
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type OrganisationServices = Readonly<{
  removeIntegrationAccount: RemoveIntegrationAccount;
  readOperatorDraft: ReadOperatorDraft;
  readPendingOperatorDraft: ReadPendingOperatorDraft;
  readLatestDecidedOperatorDraft: ReadLatestDecidedOperatorDraft;
  cancelOperatorConfigurationDraft: CancelOperatorConfigurationDraft;
  confirmOperatorConfigurationDraft: ConfirmOperatorConfigurationDraft;
  /** The short code that a person compares before a confirmation. */
  previewCode: (commandDigest: string) => string;
  prepareEmailWatchReconciliationRun: PrepareEmailWatchReconciliationRun;
}>;

export const organisationServices = definePort<OrganisationServices>(
  "organisation_services",
);
