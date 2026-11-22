import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

type StatementSession = Pick<OrganisationDatabaseSession, "prepare">;

/** The support reference of a provider attempt that failed. */
export type ProviderAttemptSupportReference = Readonly<{
  supportReference: string;
  organisationId: string;
  environment: string;
  actorUserId: string;
  correlationId: string;
  route: string;
  operation: string;
  reasonCode: string;
  retryClassification: "retryable" | "terminal";
  now: number;
  provider: string;
  adapterOperation: string;
  lifecycleBefore: string;
  redactedProviderStatus: string | null;
  redactedProviderRequestId: string | null;
  durableReceipts: string;
  lastSuccessfulPhase: string | null;
}>;

/**
 * The statements of other owners that a connection flow puts in its own
 * batch: the support references and the communication destination of the
 * Organisation, and the credential reference of the Vault. Each owner
 * builds its statement, and the Worker registers the builders
 * (`worker-ports.ts`).
 */
export type ConnectionFlowParts = Readonly<{
  /** Closes the open support references, of all providers or of one. */
  prepareResolveOpenSupportReferences(
    session: StatementSession,
    input: {
      readonly organisationId: OrganisationId;
      readonly provider?: string;
      readonly now: number;
    },
  ): D1PreparedStatement;
  /** The support reference of a provider attempt that failed. */
  prepareProviderAttemptSupportReference(
    session: StatementSession,
    input: ProviderAttemptSupportReference,
  ): D1PreparedStatement;
  /** Moves the communication destination to another Slack account. */
  prepareCommunicationDestinationAccount(
    session: StatementSession,
    input: Readonly<{
      organisationId: string;
      integrationAccountId: string;
      now: number;
    }>,
  ): D1PreparedStatement;
  /** Points the credential reference of a reconnect at the new handle. */
  prepareCredentialRefReplacement(
    session: StatementSession,
    input: Readonly<{
      organisationId: string;
      provider: string;
      previousCredentialRef: string;
      replacementCredentialRef: string;
    }>,
  ): D1PreparedStatement;
}>;

export const connectionFlowParts = definePort<ConnectionFlowParts>(
  "connection_flow_parts",
);
