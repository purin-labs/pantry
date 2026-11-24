import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { ActiveIntegrationProvider } from "@purin-labs/connections/data/integration-provider-directory";

/** `reconcileProviderManifestObservations` of `provider-lifecycle/observation.ts`. */
type ReconcileProviderManifestObservations = (input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly fetcher: typeof fetch;
}) => Promise<number>;

/** `readProviderCleanupContext` of `provider-adapters/catalogue.ts`. */
type ReadProviderCleanupContext = (
  input: Readonly<{
    db: Pick<OrganisationDatabaseSession, "prepare">;
    integrationAccountId: IntegrationAccountId;
    provider: ActiveIntegrationProvider;
    removeApplicationSubscription: boolean;
  }>,
) => Promise<string | null>;

/**
 * The provider services of the integrations area, as a service interface of
 * its contract. The onboarding route reconciles the provider manifest
 * observations of an Organisation, and the account removal reads the cleanup
 * context of a provider. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type ProviderServices = Readonly<{
  reconcileProviderManifestObservations: ReconcileProviderManifestObservations;
  readProviderCleanupContext: ReadProviderCleanupContext;
}>;

export const providerServices =
  definePort<ProviderServices>("provider_services");
