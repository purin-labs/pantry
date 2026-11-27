import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { reconcileHeldOutputRequests } from "@purin-labs/surface-slack/server/held-output-release";
import { reconcileHeldPermissionDecisions } from "@purin-labs/surface-slack/server/permission-request-release";
import { deleteEndedControlSessions } from "@purin-labs/tenancy/data/control-plane";
import { deleteEndedGoogleOidcStates } from "@purin-labs/control/worker/oidc";
import {
  publishOnboardingPolicy,
  reconcileCredentialCutovers,
  reconcileOnboarding,
  reconcileOrganisations,
  resumeStalledActivation,
  type OrganisationReconciliationStep,
} from "@purin-labs/area-organisation/server/data/scheduled-reconciliation";
import { reconcileProviderAccountCleanup } from "@purin-labs/area-integrations/server/provider-lifecycle/cleanup-reconciliation";
import { deleteExpiredMutationReceipts } from "@purin-labs/tenancy/data/shared-rows/mutation-receipt";
import type { Env } from "@purin-labs/kernel/env";
import { reconcileProviderManifestObservations } from "@purin-labs/area-integrations/server/provider-lifecycle/observation";
import { sweepVaultAlerts } from "@purin-labs/authority/credential-vault/alerts";
import { reconcileOrganisationEmailWatches } from "@purin-labs/area-inbox/server/mail-inbox/watch-reconciliation";

/**
 * The steps of the scheduled run for each Organisation, in their order. The
 * organisation area runs them after it publishes the shared rows of the
 * Organisation.
 */
const ORGANISATION_RECONCILIATION_STEPS: readonly OrganisationReconciliationStep[] =
  [
    publishOnboardingPolicy,
    reconcileCredentialCutovers,
    async function reconcileProviderAccounts({ env, organisationId, now }) {
      await reconcileProviderAccountCleanup({
        env,
        organisationId,
        now,
        fetcher: runtimeFetch,
      });
    },
    async function reconcileManifestObservations({ env, organisationId, now }) {
      await reconcileProviderManifestObservations({
        env,
        organisationId,
        now,
        fetcher: runtimeFetch,
      });
    },
    // After the health check, so a Slack account that works again takes
    // the decisions that waited for it in the same run.
    async function releaseHeldPermissionDecisions({ env, scope, now }) {
      await reconcileHeldPermissionDecisions({ env, scope, now });
    },
    async function releaseHeldOutputRequests({ env, scope, now }) {
      await reconcileHeldOutputRequests({ env, scope, now });
    },
    reconcileOnboarding,
    resumeStalledActivation,
    async function reconcileEmailWatches({ env, scope, now }) {
      await reconcileOrganisationEmailWatches({ env, scope, now });
    },
  ];

export async function runScheduledOnboardingReconciliation(
  env: Env,
  now: number,
): Promise<void> {
  await reconcileOrganisations(env, now, ORGANISATION_RECONCILIATION_STEPS);
  await deleteExpiredMutationReceipts(env, now);
  await deleteEndedControlSessions(env.DB, now);
  await deleteEndedGoogleOidcStates(env.DB, now);
  await sweepVaultAlerts(env, now);
}
