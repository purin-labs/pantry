import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  hashOpaqueSecret,
  resolveUser,
} from "@purin-labs/tenancy/data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
} from "@purin-labs/tenancy/data/control-mutation";
import { archiveOrganisation } from "@purin-labs/tenancy/data/organisation-lifecycle";
import { publishOrganisationDirectoryRow } from "@purin-labs/tenancy/data/shared-rows/organisation-row";
import { publishStoppedInitialPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import { hasActiveOrganisationOnboarding } from "@purin-labs/tenancy/data/organisation-onboarding-row";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { reconcileInterruptedProviderCredentialCutovers } from "@purin-labs/area-integrations-contract/server/credential-cutover";
import {
  holdOrganisationPolicyDistribution,
  reconcileOrganisationPolicyPublication,
} from "@purin-labs/authority/policy-snapshot";
import {
  listOnboardingReconciliationOrganisationIds,
  reconcileOrganisationOnboarding,
} from "./onboarding-reconciliation";

/** The parts of one Organisation that a step of the scheduled run reads. */
export type OrganisationReconciliationInput = Readonly<{
  env: Env;
  organisationId: OrganisationId;
  scope: OrganisationExecutionScope;
  organisation: OrganisationActorStub;
  now: number;
}>;

/**
 * One step of the scheduled run for one Organisation. A step that throws
 * stops the run.
 */
export type OrganisationReconciliationStep = (
  input: OrganisationReconciliationInput,
) => Promise<void>;

type StalledActivationRow = {
  readonly configurationVersion: unknown;
  readonly readinessVersion: unknown;
  readonly readinessHash: unknown;
  readonly activationAttemptId: unknown;
  readonly leaseExpiresAt: unknown;
  readonly userId: unknown;
};

type ArchiveCandidateRow = {
  readonly organisationId: unknown;
  readonly configurationVersion: unknown;
  readonly userId: unknown;
};

const AUTOMATIC_ARCHIVE_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * The scheduled reconciliation of each Organisation (ORG-01). It archives
 * the Organisations that stayed idle while they were configuring. Then, for
 * each Organisation of each regional database, it publishes the shared rows
 * and runs the steps in their order.
 */
export async function reconcileOrganisations(
  env: Env,
  now: number,
  steps: readonly OrganisationReconciliationStep[],
): Promise<void> {
  await archiveIdleConfiguringOrganisations(env, now);
  for (const database of configuredOrganisationDatabases(env)) {
    const organisationIds =
      await listOnboardingReconciliationOrganisationIds(database);
    for (const organisationId of organisationIds) {
      // A request that stopped before the global activation left this
      // Organisation unroutable; its cell's rows are committed.
      await publishStoppedInitialPlacement({
        directory: env.DB,
        db: database,
        organisationId,
      });
      const execution = await OrganisationExecutionScope.resolve(
        env,
        organisationId,
      );
      if (!execution.ok || execution.value.database !== database) continue;
      const scope = execution.value;
      // A rename, an archive, a restore and a deletion write the regional row
      // only. The directory's copy follows within one run.
      await publishOrganisationDirectoryRow({
        directory: env.DB,
        db: scope.database,
        organisationId,
      });
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: scope.placement,
        now,
      });
      for (const step of steps) {
        await step({ env, organisationId, scope, organisation, now });
      }
    }
  }
}

/** Publishes the policy of an Organisation while its onboarding is active. */
export async function publishOnboardingPolicy({
  env,
  organisationId,
  scope,
  organisation,
  now,
}: OrganisationReconciliationInput): Promise<void> {
  if (await hasActiveOrganisationOnboarding(scope.database, organisationId)) {
    const policyPublication = await reconcileOrganisationPolicyPublication({
      bindings: {
        db: scope.database,
        kv: env.POLICY_KV,
      },
      organisationId,
      organisation,
      now,
    });
    if (!policyPublication.ok) {
      throw new Error(policyPublication.error.code);
    }
  }
}

/** Finishes each provider credential cutover that a request left open. */
export async function reconcileCredentialCutovers({
  env,
  organisationId,
  scope,
  organisation,
  now,
}: OrganisationReconciliationInput): Promise<void> {
  const credentialCutovers =
    await reconcileInterruptedProviderCredentialCutovers({
      db: scope.database,
      kv: env.POLICY_KV,
      organisation,
      organisationId,
      now,
    });
  if (!credentialCutovers.ok) {
    throw new Error(credentialCutovers.error.code);
  }
}

/** The onboarding reconciliation of one Organisation. */
export async function reconcileOnboarding({
  env,
  organisationId,
  scope,
  now,
}: OrganisationReconciliationInput): Promise<void> {
  await reconcileOrganisationOnboarding({
    env,
    db: scope.database,
    archive: env.ARCHIVE,
    sessionNamespace: env.SESSION,
    connectorNamespace: env.CONNECTOR,
    organisationNamespace: env.ORGANISATION,
    organisationId,
    now,
  });
}

async function archiveIdleConfiguringOrganisations(
  env: Env,
  now: number,
): Promise<void> {
  for (const database of configuredOrganisationDatabases(env)) {
    const rows = await database
      .prepare(
        `SELECT onboarding.organisation_id AS organisationId,
            onboarding.configuration_version AS configurationVersion,
            membership.user_id AS userId
     FROM organisation_onboarding AS onboarding
     JOIN service_role_grant AS membership
       ON membership.organisation_id = onboarding.organisation_id
       AND membership.role = 'owner' AND membership.status = 'active'
     WHERE onboarding.lifecycle = 'configuring'
       AND onboarding.updated_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM provider_connection
         WHERE organisation_id = onboarding.organisation_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM provider_connection_attempt
         WHERE organisation_id = onboarding.organisation_id
           AND updated_at > ?
       )
     ORDER BY onboarding.organisation_id, membership.created_at`,
      )
      .bind(now - AUTOMATIC_ARCHIVE_IDLE_MS, now - AUTOMATIC_ARCHIVE_IDLE_MS)
      .all<ArchiveCandidateRow>();
    const seen = new Set<string>();
    for (const row of rows.results ?? []) {
      if (
        typeof row.organisationId !== "string" ||
        typeof row.configurationVersion !== "number" ||
        typeof row.userId !== "string" ||
        seen.has(row.organisationId)
      ) {
        continue;
      }
      const organisationId = parseOrganisationId(row.organisationId);
      const userId = parseUserId(row.userId);
      if (!organisationId.ok || !userId.ok) {
        continue;
      }
      const execution = await OrganisationExecutionScope.resolve(
        env,
        organisationId.value,
      );
      if (!execution.ok || execution.value.database !== database) continue;
      const identity = await resolveUser({ db: env.DB, userId: userId.value });
      if (identity === null) continue;
      seen.add(row.organisationId);
      const idempotencyKey = `auto-archive:${organisationId.value}:${row.configurationVersion}`;
      const archived = await archiveOrganisation({
        identityDatabase: env.DB,
        execution: execution.value,
        actorUserId: userId.value,
        mutation: {
          boundary: {
            kind: "configuration_versioned",
            idempotencyKey,
            requestHash: await hashOpaqueSecret(
              `${organisationId.value}\u0000${row.configurationVersion}\u0000automatic_inactivity`,
            ),
            expectedConfigurationVersion: row.configurationVersion,
          },
          scope: {
            userId: userId.value,
            organisationScope: organisationId.value,
            route: `/v1/control/organisations/${organisationId.value}/archive`,
            operation: "organisation.archive",
          },
          identity: newControlMutationIdentity({
            portalSubjectHash: await hashPortalSubject(
              identity.issuer,
              identity.subject,
            ),
            causationId: `reconciliation:auto-archive:${organisationId.value}`,
            now,
          }),
        },
        authority: { kind: "organisation_owner" },
        reasonCode: "automatic_inactivity",
        now,
      });
      if (archived.ok) {
        await holdOrganisationPolicyDistribution({
          kv: env.POLICY_KV,
          organisationId: organisationId.value,
        });
      }
    }
  }
}

/** Resumes an activation whose lease ended while it ran. */
export async function resumeStalledActivation({
  env,
  scope,
  now,
}: OrganisationReconciliationInput): Promise<void> {
  const organisationId = scope.organisationId;
  const row = await scope.database
    .prepare(
      `SELECT onboarding.configuration_version AS configurationVersion,
            attempt.readiness_version AS readinessVersion,
            attempt.readiness_hash AS readinessHash,
            attempt.activation_attempt_id AS activationAttemptId,
            attempt.lease_expires_at AS leaseExpiresAt,
            membership.user_id AS userId
     FROM organisation_onboarding AS onboarding
     JOIN organisation_activation_attempt AS attempt
       ON attempt.activation_attempt_id = onboarding.activation_attempt_id
     JOIN service_role_grant AS membership
       ON membership.organisation_id = onboarding.organisation_id
       AND membership.role = 'owner' AND membership.status = 'active'
     WHERE onboarding.organisation_id = ? AND onboarding.lifecycle = 'activating'
       AND attempt.status = 'running'
       AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= ?)
     ORDER BY membership.created_at
     LIMIT 1`,
    )
    .bind(organisationId, now)
    .first<StalledActivationRow>();
  if (
    row === null ||
    typeof row.configurationVersion !== "number" ||
    typeof row.readinessVersion !== "number" ||
    typeof row.readinessHash !== "string" ||
    typeof row.activationAttemptId !== "string" ||
    (row.leaseExpiresAt !== null && typeof row.leaseExpiresAt !== "number") ||
    typeof row.userId !== "string"
  ) {
    return;
  }
  const parsedOrganisationId = parseOrganisationId(organisationId);
  const userId = parseUserId(row.userId);
  if (!parsedOrganisationId.ok || !userId.ok) {
    return;
  }
  const identity = await resolveUser({ db: env.DB, userId: userId.value });
  if (identity === null) return;
  const idempotencyKey = `activation-reconcile:${row.activationAttemptId}`;
  const route = `/v1/control/organisations/${organisationId}/activate`;
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: scope.placement,
    now,
  });
  await organisation.activateOnboarding({
    organisationId,
    readinessVersion: row.readinessVersion,
    readinessHash: row.readinessHash,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey,
        requestHash: await hashOpaqueSecret(
          `${organisationId}\u0000${row.readinessVersion}\u0000${row.readinessHash}`,
        ),
        expectedConfigurationVersion: row.configurationVersion,
      },
      scope: {
        userId: userId.value,
        organisationScope: organisationId,
        route,
        operation: "organisation.activation.start",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: `reconciliation:${row.activationAttemptId}`,
        now,
      }),
    },
    now,
  });
}
