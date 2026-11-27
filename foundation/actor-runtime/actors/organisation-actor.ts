// The parts of the Organisation actor that the actor runtime gives: the
// admission of one command, the database of the stored placement and the
// meta record of the Organisation.
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  OrganisationMeta,
  OrganisationMetaRow,
} from "@purin-labs/tenancy/actors/organisation/types";
import { organisationPlacementConflict } from "@purin-labs/tenancy/actors/organisation/organisation-record";
import { readPlacementByEpoch } from "@purin-labs/tenancy/data/organisation-placement";
import {
  selectOrganisationPlacementDatabase,
  type OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { admitActorRecovery } from "./actor-activation";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import {
  readActivationExportSource,
  type ActorExportError,
} from "./actor-export";

export function organisationRowToMeta(
  row: OrganisationMetaRow,
): OrganisationMeta {
  const organisationId = parseOrganisationId(row.organisation_id);

  if (!organisationId.ok) {
    throw new Error("organisation_meta_identity_invalid");
  }

  return {
    organisationId: organisationId.value,
    name: row.name,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function executeOrganisationCommand<
  Outcome extends Result<unknown, { readonly code: string }>,
>(
  env: Env,
  storage: DurableObjectStorage,
  organisationId: OrganisationId,
  start: (scope: OrganisationExecutionScope) => Promise<Outcome>,
): Promise<
  Outcome | Result<never, { readonly code: "organisation_placement_conflict" }>
> {
  const admission = await admitActorRecovery(env, storage);
  if (
    admission.kind !== "admitted" ||
    admission.scope.organisationId !== organisationId ||
    !(await isOrganisationExecutionActive(storage.sql, admission.scope))
  )
    return organisationPlacementConflict();
  const result = await start(admission.scope);
  if (!(await isOrganisationExecutionActive(storage.sql, admission.scope)))
    return organisationPlacementConflict();
  return result;
}

export async function resolveOrganisationActorDatabase(
  env: Env,
  sql: SqlStorage,
): Promise<Result<OrganisationDatabase, ActorExportError>> {
  const activation = readActivationExportSource(sql);
  if (!activation.ok) return activation;
  const placement = await readPlacementByEpoch(
    env.DB,
    activation.value.identity.organisationId,
    activation.value.placementEpoch,
  );
  if (!placement.ok)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  const selected = selectOrganisationPlacementDatabase(
    env,
    activation.value.identity.organisationId,
    placement.value.placement,
  );
  return selected.ok
    ? selected
    : {
        ok: false,
        error: { code: "actor_cleanup_failed", detail: selected.error.code },
      };
}
