/**
 * The provider work that holds a relocation (Refactor 17). The provider
 * connection attempts and the provider cleanups have owners above the Actor
 * runtime, so the owner gives these reads; the Worker registers them
 * (`worker-ports.ts`). Each read keeps its one query.
 */
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

export type ProviderWorkReads = Readonly<{
  /**
   * The first provider operation that a relocation must wait for: a
   * callback or a provisioning in flight, or a running provider cleanup.
   */
  pendingOperation(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<Readonly<{ operationId: string }> | null>;
  /**
   * True while provider work holds the cleanup of a relocation. Work that
   * ended, done or left to a person, holds nothing.
   */
  unresolved(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<boolean>;
}>;

export const providerWorkReads = definePort<ProviderWorkReads>(
  "provider_work_reads",
);
