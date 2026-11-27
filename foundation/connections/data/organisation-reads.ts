import type { GlobalDatabase } from "@purin-labs/kernel/database-handles";
import { definePort } from "@purin-labs/kernel/port";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";

/**
 * The records of the Organisation area that a connection flow reads
 * (Refactor 17): the communication destination of the Organisation and the
 * provider manifests. Each member is one D1 read. The Organisation area owns
 * the tables, and the Worker registers its reads (`worker-ports.ts`).
 */
export type OrganisationConnectionReads = Readonly<{
  /** Whether the Organisation has a communication destination. */
  communicationDestinationIsConfigured(
    db: OrganisationQuerySource,
    organisationId: string,
  ): Promise<boolean>;
  /**
   * The newest manifest version of a provider in an environment, or null
   * when there is none. A stored version that is not a positive integer is a
   * fault, and it throws.
   */
  currentProviderManifestVersion(
    manifestDatabase: GlobalDatabase,
    provider: string,
    environment: OrganisationEnvironment,
  ): Promise<number | null>;
}>;

export const organisationConnectionReads =
  definePort<OrganisationConnectionReads>("organisation_connection_reads");
