import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { CommerceSystemSyncStatus } from "../../actors/commerce-projection";
import { ensureCreatedOrganisationActor } from "../../control/organisation-runtime";
import { resolveOrganisationCommerceSystemAuthority } from "@purin-labs/connections/data/organisation-commerce-system";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

export async function readCommerceSystemSyncStatus(
  input: Readonly<{
    env: Env;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<Result<CommerceSystemSyncStatus, { readonly code: string }>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) return scope;
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: scope.value.database,
    organisationId: input.organisationId,
  });
  if (!authority.ok) return authority;
  try {
    const organisation = await requireActiveOrganisationActor({
      env: input.env,
      organisationId: input.organisationId,
      now: input.now,
    });
    const current = await organisation.readCommerceSystemSyncStatus({
      organisationId: input.organisationId,
      integrationAccountId: authority.value.integrationAccountId,
      now: input.now,
    });
    if (current.ok || current.error.code !== "organisation_not_initialized")
      return current;
    await ensureCreatedOrganisationActor(input);
    return organisation.readCommerceSystemSyncStatus({
      organisationId: input.organisationId,
      integrationAccountId: authority.value.integrationAccountId,
      now: input.now,
    });
  } catch {
    return { ok: false, error: { code: "commerce_system_sync_unavailable" } };
  }
}

export async function commerceSystemReadiness(
  env: Env,
  organisationId: OrganisationId,
  now: number,
): Promise<"ready" | "syncing"> {
  const sync = await readCommerceSystemSyncStatus({ env, organisationId, now });
  return sync.ok && sync.value.kind === "ready" ? "ready" : "syncing";
}
