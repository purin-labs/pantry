import { definePort } from "@purin-labs/kernel/port";
import type { readProviderCleanupContext } from "../../provider-adapters/catalogue";
import type { reconcileProviderManifestObservations } from "../../provider-lifecycle/observation";

/**
 * The provider services of the integrations area, as a service interface of
 * its contract. The onboarding route reconciles the provider manifest
 * observations of an Organisation, and the account removal reads the cleanup
 * context of a provider. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type ProviderServices = Readonly<{
  reconcileProviderManifestObservations: typeof reconcileProviderManifestObservations;
  readProviderCleanupContext: typeof readProviderCleanupContext;
}>;

export const providerServices =
  definePort<ProviderServices>("provider_services");
