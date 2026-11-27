import type { IntegrationProvider } from "@purin-labs/connections/data/integration-account";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { VaultHandle } from "./domain";

/**
 * The records of the Integrations area that the Vault reads before it gives
 * a secret or raises an alert (Refactor 17): the provider cleanup of a
 * removed account, the credential rotations and the Discord installations.
 * Each member is one D1 read. Integrations owns the tables, and the Worker
 * registers its reads (`worker-ports.ts`).
 */
export type IntegrationCredentialReads = Readonly<{
  /**
   * Whether the provider cleanup of a removed account is still open for
   * exactly this account, provider connection and environment, and holds the
   * handle.
   */
  accountRemovalCleanupHoldsHandle(
    db: OrganisationDatabase,
    cleanup: Readonly<{
      cleanupId: string;
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
      provider: IntegrationProvider;
      environment: OrganisationEnvironment;
      providerAccountId: string;
      providerConnectionId: string;
      handle: VaultHandle;
    }>,
  ): Promise<boolean>;
  /** The rotations that wait for a verification or a commit since before a time. */
  countStuckCredentialRotations(
    db: OrganisationDatabase,
    createdBefore: number,
  ): Promise<number>;
  /** The rotations that failed since a time. */
  countFailedCredentialRotations(
    db: OrganisationDatabase,
    createdSince: number,
  ): Promise<number>;
  /**
   * Whether an active Discord installation of an active organisation holds
   * this public key handle.
   */
  discordInstallHoldsPublicKey(
    db: OrganisationDatabase,
    install: Readonly<{
      organisationId: OrganisationId;
      applicationId: string;
      guildId: string;
      publicKeyRef: VaultHandle;
    }>,
  ): Promise<boolean>;
}>;

export const integrationCredentialReads =
  definePort<IntegrationCredentialReads>("integration_credential_reads");
