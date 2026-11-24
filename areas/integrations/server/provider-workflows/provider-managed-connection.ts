import { createConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "@purin-labs/connections/data/provider-attempt";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "@purin-labs/area-integrations-contract/server/provider-lifecycle";
import {
  advanceProviderPhase,
  finalizeProviderConnection,
} from "../contract/provisioning";
import type { Result } from "@purin-labs/kernel/result";

/**
 * The end of an OAuth connection whose provider manages the resource
 * selection (Dropbox, Google Drive, Airtable and Notion): no webhooks, no
 * resource snapshot, then the account, the credential cutover and the
 * healthy completion.
 */
export async function finishProviderManagedConnection(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  connected: Awaited<ReturnType<typeof createConnectedIntegration>>,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = await advanceProviderPhase(
    input,
    provisioning,
    "discovering_accounts",
    {
      integration_account_ids: [connected.account.integrationAccountId],
    },
    "reconciling_webhooks",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      webhook_count: 0,
    },
    "discovering_resources",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      resource_selection_managed_by_provider: true,
    },
    "verifying_connection",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "verifying_connection",
    {
      provider_identity_verified: true,
    },
    "finalizing",
  );
  return finalizeProviderConnection(input, authorization, current, connected, {
    kind: "healthy",
    evidenceCode: "callback_identity_verified",
  });
}
