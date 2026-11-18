import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { newControlMutationIdentity } from "../../src/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  type ArchiveOrganisationMutation,
} from "../../src/data/organisation-lifecycle";
import { PURGE_CATALOGUE } from "../../src/data/purge-catalogue";
import type { OrganisationId } from "../../src/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import type { SharedAccountNativeClient } from "./shared-account-platform-fixture";

export type PurgeOwner = Readonly<{
  client: SharedAccountNativeClient;
  organisationId: OrganisationId;
}>;

/** An owner and the Organisation that onboarding creates for it. */
export async function purgeOwner(
  subject: string,
  name: string,
): Promise<PurgeOwner> {
  const client = await commerceClient(subject);
  const organisationId = await commerceWorkspace(client, name);
  return { client, organisationId };
}

/**
 * The owner archives the Organisation, the scheduled cleanup revokes its
 * credentials, the owner deletes it, and the scheduled run purges it.
 */
export async function purgeOrganisation(owner: PurgeOwner): Promise<void> {
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    ),
    actorUserId: owner.client.identity.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await lifecycleMutation(owner, "archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now());
  const removed = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    ),
    actorUserId: owner.client.identity.userId,
    now: Date.now(),
    mutation: await lifecycleMutation(owner, "delete"),
  });
  if (!removed.ok) throw new Error(removed.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now() + 1_000);
  await runScheduledOnboardingReconciliation(env, Date.now() + 900_000);
  expect(await cleanupStatus(owner.organisationId)).toBe("purged");
}

/**
 * Each table that the purge catalogue marks erase and that still holds a row
 * of the Organisation, with its row count.
 */
export async function erasedTableResidue(
  organisationId: OrganisationId,
): Promise<Readonly<Record<string, number>>> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const residue: Record<string, number> = {};
  for (const entry of PURGE_CATALOGUE) {
    if (entry.action !== "erase") continue;
    const where = "where" in entry ? entry.where : "organisation_id = ?";
    const count = await scope.database
      .prepare(`SELECT COUNT(*) AS count FROM ${entry.table} WHERE ${where}`)
      .bind(organisationId)
      .first<number>("count");
    if (count !== null && count > 0) residue[entry.table] = count;
  }
  return residue;
}

export async function cleanupStatus(
  organisationId: OrganisationId,
): Promise<unknown> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  return scope.database
    .prepare(
      "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first("status");
}

export async function configurationVersion(
  organisationId: OrganisationId,
): Promise<number> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const version = await scope.database
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first("configuration_version");
  if (typeof version !== "number")
    throw new Error("The Organisation has no configuration version");
  return version;
}

async function lifecycleMutation(
  owner: PurgeOwner,
  operation: "archive" | "delete",
): Promise<ArchiveOrganisationMutation> {
  const key = `purge-support-${owner.organisationId}-${operation}`;
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: key,
      requestHash: `${key}-request`,
      expectedConfigurationVersion: await configurationVersion(
        owner.organisationId,
      ),
    },
    scope: {
      userId: owner.client.identity.userId,
      organisationScope: owner.organisationId,
      route: `/v1/control/organisations/${owner.organisationId}${operation === "archive" ? "/archive" : ""}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "purge-support-owner",
      causationId: key,
      now: Date.now(),
    }),
  };
}
