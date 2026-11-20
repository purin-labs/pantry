import {
  OrganisationExecutionScope,
  fetchWithOrganisationPlacement,
} from "../organisation-execution-scope";
import { parseVaultHandle, type VaultHandle } from "../credential-vault";
import {
  recordProviderManifestObservation,
  type ProviderManifestEvidence,
} from "../data/provider-attempt";
import type { Env } from "../env";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import {
  observeProviderConnection,
  parseActiveIntegrationProvider,
} from "../provider-adapters/catalogue";
import type { ActiveIntegrationProvider } from "../provider-adapters/domain";
import {
  prepareConfigurationVersionBump,
} from "../data/organisation-onboarding-row";

export async function reconcileProviderManifestObservations(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly fetcher: typeof fetch;
}): Promise<number> {
  const resolved = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  const scope = resolved.value;
  const rows = await scope.database
    .prepare(
      `SELECT account.integration_account_id AS integrationAccountId,
            account.provider, account.environment,
            account.provider_account_id AS providerAccountId,
            account.lifecycle, account.lifecycle_reason_code AS lifecycleReasonCode,
            connection.credential_ref AS credentialRef
     FROM integration_account AS account
     JOIN provider_connection AS connection
       ON connection.provider_connection_id = account.provider_connection_id
     WHERE account.organisation_id = ?
       AND account.lifecycle IN ('active', 'degraded')
       AND connection.lifecycle IN ('active', 'reauth_required')`,
    )
    .bind(input.organisationId)
    .all<ProviderObservationRow>();
  let observed = 0;
  for (const row of rows.results ?? []) {
    const parsed = parseObservationRow(row);
    if (parsed === null) continue;
    const evidence = await observeProviderConnection(parsed.provider, {
      env: input.env,
      scope,
      integrationAccountId: parsed.integrationAccountId,
      environment: parsed.environment,
      providerAccountId: parsed.providerAccountId,
      credentialRef: parsed.credentialRef,
      organisationId: input.organisationId,
      fetcher: fetchWithOrganisationPlacement.bind(null, scope, input.fetcher),
    });
    await recordProviderManifestObservation({
      manifestDatabase: input.env.DB,
      scope,
      organisationId: input.organisationId,
      integrationAccountId: parsed.integrationAccountId,
      provider: parsed.provider,
      environment: parsed.environment,
      evidence,
      now: input.now,
    });
    await updateObservedAccountLifecycle({
      scope,
      organisationId: input.organisationId,
      integrationAccountId: parsed.integrationAccountId,
      currentLifecycle: parsed.lifecycle,
      currentLifecycleReasonCode: parsed.lifecycleReasonCode,
      evidence,
      now: input.now,
    });
    observed += 1;
  }
  return observed;
}

type ProviderObservationRow = {
  readonly integrationAccountId: unknown;
  readonly provider: unknown;
  readonly environment: unknown;
  readonly providerAccountId: unknown;
  readonly lifecycle: unknown;
  readonly lifecycleReasonCode: unknown;
  readonly credentialRef: unknown;
};

type ParsedProviderObservation = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: ActiveIntegrationProvider;
  readonly environment: "development" | "production";
  readonly providerAccountId: string;
  readonly lifecycle: "active" | "degraded";
  readonly lifecycleReasonCode: string | null;
  readonly credentialRef: VaultHandle | null;
};

function parseObservationRow(
  row: ProviderObservationRow,
): ParsedProviderObservation | null {
  if (
    typeof row.integrationAccountId !== "string" ||
    typeof row.providerAccountId !== "string" ||
    parseActiveIntegrationProvider(row.provider) === null ||
    (row.provider !== "whatsapp" && typeof row.credentialRef !== "string") ||
    (row.environment !== "development" && row.environment !== "production") ||
    (row.lifecycle !== "active" && row.lifecycle !== "degraded") ||
    (row.lifecycle === "degraded" &&
      typeof row.lifecycleReasonCode !== "string")
  ) {
    return null;
  }
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  const provider = parseActiveIntegrationProvider(row.provider);
  const credentialRef =
    typeof row.credentialRef === "string"
      ? parseVaultHandle(row.credentialRef)
      : null;
  if (
    !integrationAccountId.ok ||
    provider === null ||
    (credentialRef !== null && !credentialRef.ok)
  )
    return null;
  return {
    integrationAccountId: integrationAccountId.value,
    provider,
    environment: row.environment,
    providerAccountId: row.providerAccountId,
    lifecycle: row.lifecycle,
    lifecycleReasonCode:
      typeof row.lifecycleReasonCode === "string"
        ? row.lifecycleReasonCode
        : null,
    credentialRef: credentialRef?.ok === true ? credentialRef.value : null,
  };
}

async function updateObservedAccountLifecycle(input: {
  readonly scope: OrganisationExecutionScope;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly currentLifecycle: "active" | "degraded";
  readonly currentLifecycleReasonCode: string | null;
  readonly evidence: ProviderManifestEvidence;
  readonly now: number;
}): Promise<void> {
  if (input.evidence.kind === "observation_unsupported") return;
  const unhealthy = input.evidence.kind !== "healthy";
  const shouldDegrade = unhealthy && input.currentLifecycle === "active";
  const shouldRestore =
    !unhealthy &&
    input.currentLifecycle === "degraded" &&
    input.currentLifecycleReasonCode === "provider_manifest_unhealthy";
  if (!shouldDegrade && !shouldRestore) return;
  const session = input.scope.database.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE integration_account
       SET lifecycle = ?, lifecycle_reason_code = ?, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = ?`,
      )
      .bind(
        shouldDegrade ? "degraded" : "active",
        shouldDegrade ? "provider_manifest_unhealthy" : null,
        input.now,
        input.organisationId,
        input.integrationAccountId,
        input.currentLifecycle,
      ),
    prepareConfigurationVersionBump(session, input.organisationId, input.now),
    input.scope.prepareMutationFence(),
  ]);
}
