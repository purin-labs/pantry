import type { OrganisationDatabase } from "../database-handles";
import type {
  OrganisationActivatePolicyInput,
  OrganisationPolicyActivation,
  OrganisationPolicyActivationError,
} from "../actors/organisation/types";
import {
  parseProviderConnectionId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../ids";
import { compilePublishAndActivateOrganisationPolicy } from "../policy-snapshot";
import type { Result } from "../result";

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
    session
      .prepare(
        `UPDATE vault_secret
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE organisation_id = ?
         AND vault_handle IN (
           SELECT credential_ref
           FROM provider_credential_generation
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND lifecycle = 'superseded'
         )`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.organisationId,
        input.providerConnectionId,
      ),
    session
      .prepare(
        `UPDATE provider_credential_generation
       SET lifecycle = 'revoked',
           revoked_at = COALESCE(revoked_at, ?),
           superseded_at = COALESCE(superseded_at, ?)
       WHERE organisation_id = ? AND provider_connection_id = ?
         AND lifecycle = 'superseded'`,
      )
      .bind(
        input.now,
        input.now,
        input.organisationId,
        input.providerConnectionId,
      ),
  ]);
}
