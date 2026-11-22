import { env } from "cloudflare:workers";
import { expect } from "vitest";

import {
  parseVaultHandle,
  storeVaultSecret,
  type VaultHandle,
} from "../../src/credential-vault";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  type ArchiveOrganisationMutation,
} from "../../src/data/organisation-lifecycle";
import {
  eraseEntryWhere,
  PURGE_CATALOGUE,
} from "../../src/data/purge-catalogue";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import type { OrganisationClient } from "./organisation-fixture";

export type PurgeOwner = Readonly<{
  client: OrganisationClient;
  organisationId: OrganisationId;
}>;

/** An Organisation and the owner who archives and deletes it. */
export type PurgeSubject = Readonly<{
  organisationId: OrganisationId;
  userId: UserId;
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
export async function purgeOrganisation(
  owner: PurgeOwner | PurgeSubject,
): Promise<void> {
  await archiveAsOwner(owner);
  await purgeArchivedOrganisation(owner);
}

/**
 * The scheduled cleanup revokes the archived Organisation's credentials, the
 * owner deletes it, and the scheduled run purges it.
 */
export async function purgeArchivedOrganisation(
  owner: PurgeOwner | PurgeSubject,
): Promise<void> {
  const subject = purgeSubject(owner);
  await runScheduledOnboardingReconciliation(env, Date.now());
  await deleteAsOwner(subject);
  await runScheduledOnboardingReconciliation(env, Date.now() + 1_000);
  await runScheduledOnboardingReconciliation(env, Date.now() + 900_000);
  expect(await cleanupStatus(subject.organisationId)).toBe("purged");
}

/** The owner archives the Organisation. */
export async function archiveAsOwner(
  owner: PurgeOwner | PurgeSubject,
): Promise<void> {
  const subject = purgeSubject(owner);
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      subject.organisationId,
    ),
    actorUserId: subject.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await lifecycleMutation(subject, "archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
}

function purgeSubject(owner: PurgeOwner | PurgeSubject): PurgeSubject {
  return "client" in owner
    ? {
        organisationId: owner.organisationId,
        userId: owner.client.identity.userId,
      }
    : owner;
}

/** The owner deletes the archived Organisation. */
async function deleteAsOwner(subject: PurgeSubject): Promise<void> {
  const removed = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      subject.organisationId,
    ),
    actorUserId: subject.userId,
    now: Date.now(),
    mutation: await lifecycleMutation(subject, "delete"),
  });
  if (!removed.ok) throw new Error(removed.error.code);
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
    const count = await scope.database
      .prepare(
        `SELECT COUNT(*) AS count FROM ${entry.table} WHERE ${eraseEntryWhere(entry)}`,
      )
      .bind(organisationId)
      .first<number>("count");
    if (count !== null && count > 0) residue[entry.table] = count;
  }
  return residue;
}

async function cleanupStatus(organisationId: OrganisationId): Promise<unknown> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  return scope.database
    .prepare(
      "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first("status");
}

export function requiredVaultHandle(raw: string): VaultHandle {
  const handle = parseVaultHandle(raw);
  if (!handle.ok) throw new Error("The Vault handle is invalid");
  return handle.value;
}

/** Input: the ChatGPT sign-in that the Organisation's owner finished. */
export async function signInToChatGpt(owner: PurgeOwner): Promise<void> {
  const now = Date.now();
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = requiredVaultHandle(
    `vault:${owner.organisationId.toLowerCase()}:codex:profile:1`,
  );
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle,
    secret: { kind: "bearer", value: "chatgpt-profile-before-purge" },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await scope.database
    .prepare(
      `INSERT INTO organisation_codex_connection (
         organisation_id, lifecycle, revision, auth_profile_handle,
         auth_profile_generation, plan_type, action_required_reason,
         allowance_json, connected_at, verified_at, observed_at, updated_at,
         refresh_lease, refresh_until
       ) VALUES (?, 'connected', 1, ?, 1, 'plus', NULL, '{}', ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(owner.organisationId, handle, now, now, now, now)
    .run();
}

/** The owner's Portal session cookies, for a read. */
export function readHeaders(owner: PurgeOwner): Record<string, string> {
  const { token, csrfToken } = owner.client.session;
  return {
    cookie: `pantry_session=${token}; pantry_csrf=${csrfToken}`,
  };
}

/** The configuration version of the Organisation's onboarding. */
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
  subject: PurgeSubject,
  operation: "archive" | "delete",
): Promise<ArchiveOrganisationMutation> {
  const key = `purge-support-${subject.organisationId}-${operation}`;
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: key,
      requestHash: `${key}-request`,
      expectedConfigurationVersion: await configurationVersion(
        subject.organisationId,
      ),
    },
    scope: {
      userId: subject.userId,
      organisationScope: subject.organisationId,
      route: `/v1/control/organisations/${subject.organisationId}${operation === "archive" ? "/archive" : ""}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "purge-support-owner",
      causationId: key,
      now: Date.now(),
    }),
  };
}
