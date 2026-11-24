import { resolveProviderManifestCredential } from "@purin-labs/authority/credential-vault/index";
import type { ProviderManifestEvidence } from "@purin-labs/connections/data/provider-attempt";
import type { ProviderObservationRequest } from "@purin-labs/area-integrations-contract/server/provider-adapter";

/**
 * The bearer token of a provider whose credential is in the Vault, for a
 * provider module that checks its own connection. Null when there is none.
 */
export async function resolveStoredObservationBearer(
  input: ProviderObservationRequest,
  provider: "shopify",
): Promise<string | null> {
  if (input.credentialRef === null) {
    return null;
  }
  const credential = await resolveProviderManifestCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider,
    environment: input.environment,
    providerAccountId: input.providerAccountId,
    credentialRef: input.credentialRef,
  });
  return credential.ok && credential.value.kind === "bearer"
    ? credential.value.value
    : null;
}

export function blockedEvidence(
  reasonCode: string,
  repairActions: readonly string[],
): ProviderManifestEvidence {
  return { kind: "blocked", reasonCode, repairActions };
}
