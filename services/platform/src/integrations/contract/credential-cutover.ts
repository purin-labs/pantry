import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  OrganisationActivatePolicyInput,
  OrganisationPolicyActivation,
  OrganisationPolicyActivationError,
} from "../../actors/organisation/policy-types";
import {
  parseProviderConnectionId,
  type ProviderConnectionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../policy-snapshot";
import type { Result } from "@purin-labs/kernel/result";
import { prepareSupersededGenerationsRevocation } from "../../data/provider-credential-generation";
import { prepareSupersededGenerationSecretsRevocation } from "../../credential-vault/secret-revocation";

export type ProviderCredentialCutoverError = {
  readonly code: "provider_policy_activation_failed";
};

type OrganisationPolicyActivator = {
  activatePolicy(
    input: OrganisationActivatePolicyInput,
  ): Promise<
    Result<OrganisationPolicyActivation, OrganisationPolicyActivationError>
  >;
};

export async function activateProviderCredentialCutover(input: {
  readonly db: OrganisationDatabase;
  readonly kv: KVNamespace;
  readonly organisation: OrganisationPolicyActivator;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly now: number;
}): Promise<Result<true, ProviderCredentialCutoverError>> {
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: input.db,
      kv: input.kv,
    },
    organisationId: input.organisationId,
    organisation: input.organisation,
    now: input.now,
  });
  if (!published.ok) {
    return { ok: false, error: { code: "provider_policy_activation_failed" } };
  }

  await revokeSupersededCredentialGenerations(input);

  return { ok: true, value: true };
}

export async function reconcileInterruptedProviderCredentialCutovers(input: {
  readonly db: OrganisationDatabase;
  readonly kv: KVNamespace;
  readonly organisation: OrganisationPolicyActivator;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<number, ProviderCredentialCutoverError>> {
  const rows = await input.db
    .prepare(
      `SELECT connection.provider_connection_id AS providerConnectionId
       FROM provider_connection AS connection
       WHERE connection.organisation_id = ?
         AND connection.lifecycle = 'active'
         AND EXISTS (
           SELECT 1
           FROM provider_credential_generation AS generation
           WHERE generation.provider_connection_id = connection.provider_connection_id
             AND generation.lifecycle = 'superseded'
         )
       ORDER BY connection.provider_connection_id`,
    )
    .bind(input.organisationId)
    .all<{ readonly providerConnectionId: unknown }>();
  let reconciled = 0;

  for (const row of rows.results ?? []) {
    if (typeof row.providerConnectionId !== "string") {
      return {
        ok: false,
        error: { code: "provider_policy_activation_failed" },
      };
    }
    const providerConnectionId = parseProviderConnectionId(
      row.providerConnectionId,
    );
    if (!providerConnectionId.ok) {
      return {
        ok: false,
        error: { code: "provider_policy_activation_failed" },
      };
    }
    const cutover = await activateProviderCredentialCutover({
      db: input.db,
      kv: input.kv,
      organisation: input.organisation,
      organisationId: input.organisationId,
      providerConnectionId: providerConnectionId.value,
      now: input.now,
    });
    if (!cutover.ok) {
      return cutover;
    }
    reconciled += 1;
  }

  return { ok: true, value: reconciled };
}

async function revokeSupersededCredentialGenerations(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  await session.batch([
    prepareSupersededGenerationSecretsRevocation(session, {
      now: input.now,
      organisationId: input.organisationId,
      providerConnectionId: input.providerConnectionId,
    }),
    prepareSupersededGenerationsRevocation(session, {
      now: input.now,
      organisationId: input.organisationId,
      providerConnectionId: input.providerConnectionId,
    }),
  ]);
}
