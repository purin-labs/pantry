import {
  copyOrganisationRowToDirectory,
  prepareOrganisationDeletion,
  prepareOrganisationName,
  prepareOrganisationStatus,
} from "./shared-rows/organisation-row";
import type {
  GlobalDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import { parseOrganisationId, type OrganisationId } from "../ids";
import { type UserId } from "@purin-labs/control-api/ids";
import type { Result } from "../result";
import {
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  prepareOnboardingEventAfterWrite,
  hashPortalSubject,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import type { OrganisationEnvironment } from "./control-plane";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { assertNever } from "@purin-labs/std";
import { organisationLifecycleParts } from "./organisation-lifecycle-port";
import {
  prepareOrganisationLifecycleMove,
  type OrganisationLifecycleState as LifecycleMachineState,
} from "./organisation-lifecycle-moves";

export type ArchiveOrganisationMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

export type ArchivedOrganisation = {
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly archivedAt: number;
  readonly purgeAfter: number;
  readonly receiptId: string;
};

type ArchiveOrganisationError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "organisation_archive_authority_conflict" }
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    };

export type ArchiveAuthority =
  | Readonly<{ kind: "organisation_owner" }>
  | Readonly<{
      kind: "support_admin";
      subjectHash: string;
      reasonCode: "legacy_cutover";
    }>;

type RestoreOrganisationMutation = ArchiveOrganisationMutation;

type RenameOrganisationMutation = ArchiveOrganisationMutation;

type DeleteOrganisationMutation = ArchiveOrganisationMutation;

type RestoredOrganisation = {
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly receiptId: string;
};

type RestoreOrganisationError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "configuration_version_conflict" }
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    }
  | { readonly code: "organisation_purge_started" };

type RenameOrganisationError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "configuration_version_conflict" };

type DeleteOrganisationError =
  | RenameOrganisationError
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    };

type OrganisationLifecycleRow = {
  readonly organisationId: unknown;
  readonly environment: unknown;
  readonly lifecycle: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
  readonly purgeAfter: unknown;
};

const ARCHIVE_PURGE_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

// The audit's new configuration version proves this batch admitted the mutation.
const ACCEPTED_MUTATION = `EXISTS (SELECT 1 FROM onboarding_audit_event
  WHERE audit_event_id = ? AND organisation_id = ? AND configuration_version = ?)`;

function placementBindings(execution: OrganisationExecutionScope) {
  return [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
}

function mutationBindings(
  execution: OrganisationExecutionScope,
  identity: ControlMutationIdentity,
  configurationVersion: number,
) {
  return [
    identity.auditEventId,
    execution.organisationId,
    configurationVersion,
  ];
}

async function lifecycleAdmissionConflict(
  execution: OrganisationExecutionScope,
): Promise<
  Result<
    never,
    {
      readonly code:
        "organisation_placement_conflict" | "configuration_version_conflict";
    }
  >
> {
  return {
    ok: false,
    error: {
      code: (await execution.isActive())
        ? "configuration_version_conflict"
        : "organisation_placement_conflict",
    },
  };
}

export async function renameOrganisation(input: {
  /** The global copy of the Organisation row, which the request updates. */
  readonly directory: GlobalDatabase;
  readonly execution: OrganisationExecutionScope;
  readonly actorUserId: UserId;
  readonly name: string;
  readonly mutation: RenameOrganisationMutation;
  readonly now: number;
}): Promise<Result<RestoredOrganisation, RenameOrganisationError>> {
  if (!(await input.execution.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const session = input.execution.database.withSession("first-primary");
  const state = parseOrganisationLifecycleRow(
    await readOrganisationLifecycleRow(session, input.execution.organisationId),
  );
  if (state === null)
    return { ok: false, error: { code: "organisation_not_found" } };
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.execution.organisationId,
  };
  const acceptedMutation = mutationBindings(
    input.execution,
    input.mutation.identity,
    configurationVersion,
  );
  const [admission] = await session.batch([
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET configuration_version = ?, projection_revision = ?, updated_at = ?
       WHERE organisation_id = ? AND configuration_version = ? AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        configurationVersion,
        projectionRevision,
        input.now,
        input.execution.organisationId,
        state.configurationVersion,
        ...placementBindings(input.execution),
      ),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.mutation.identity, {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      actorUserId: input.actorUserId,
      operation: "organisation.rename",
      targetKind: "organisation",
      targetId: input.execution.organisationId,
      oldLifecycle: state.lifecycle,
      newLifecycle: state.lifecycle,
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_renamed",
    }),
    prepareOrganisationName(session, {
      organisationId: input.execution.organisationId,
      name: input.name,
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
  ]);
  if (admission?.meta.changes !== 1)
    return lifecycleAdmissionConflict(input.execution);
  // The regional row is the record; the request copies it to the directory.
  await copyOrganisationRowToDirectory({
    directory: input.directory,
    db: input.execution.database,
    organisationId: input.execution.organisationId,
  });
  return {
    ok: true,
    value: {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      configurationVersion,
      projectionRevision,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

export async function deleteArchivedOrganisation(input: {
  /** The global copy of the Organisation row, which the request updates. */
  readonly directory: GlobalDatabase;
  readonly execution: OrganisationExecutionScope;
  readonly actorUserId: UserId;
  readonly mutation: DeleteOrganisationMutation;
  readonly now: number;
}): Promise<Result<RestoredOrganisation, DeleteOrganisationError>> {
  const parts = organisationLifecycleParts().archive;
  if (!(await input.execution.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const session = input.execution.database.withSession("first-primary");
  const state = parseOrganisationLifecycleRow(
    await readOrganisationLifecycleRow(session, input.execution.organisationId),
  );
  if (state === null)
    return { ok: false, error: { code: "organisation_not_found" } };
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (state.lifecycle !== "archived") {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.execution.organisationId,
  };
  const acceptedMutation = mutationBindings(
    input.execution,
    input.mutation.identity,
    configurationVersion,
  );
  const [admission] = await session.batch([
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET configuration_version = ?, projection_revision = ?, purge_after = ?, updated_at = ?
       WHERE organisation_id = ? AND configuration_version = ? AND lifecycle = 'archived' AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        configurationVersion,
        projectionRevision,
        input.now,
        input.now,
        input.execution.organisationId,
        state.configurationVersion,
        ...placementBindings(input.execution),
      ),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.mutation.identity, {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      actorUserId: input.actorUserId,
      operation: "organisation.delete",
      targetKind: "organisation",
      targetId: input.execution.organisationId,
      oldLifecycle: state.lifecycle,
      newLifecycle: state.lifecycle,
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_deleted",
    }),
    prepareOrganisationDeletion(session, {
      organisationId: input.execution.organisationId,
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
    session
      .prepare(
        `UPDATE organisation_archive_cleanup SET purge_after = ?, updated_at = ? WHERE organisation_id = ? AND ${ACCEPTED_MUTATION}`,
      )
      .bind(
        input.now,
        input.now,
        input.execution.organisationId,
        ...acceptedMutation,
      ),
    session
      .prepare(
        `UPDATE organisation_archive_tombstone SET purge_after = ? WHERE organisation_id = ? AND ${ACCEPTED_MUTATION}`,
      )
      .bind(input.now, input.execution.organisationId, ...acceptedMutation),
    parts.projectMembersDeletion(session, {
      organisationId: input.execution.organisationId,
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
    session
      .prepare(
        `DELETE FROM service_role_grant WHERE organisation_id = ? AND ${ACCEPTED_MUTATION}`,
      )
      .bind(input.execution.organisationId, ...acceptedMutation),
  ]);
  if (admission?.meta.changes !== 1)
    return lifecycleAdmissionConflict(input.execution);
  // The regional row is the record; the request copies it to the directory.
  await copyOrganisationRowToDirectory({
    directory: input.directory,
    db: input.execution.database,
    organisationId: input.execution.organisationId,
  });
  return {
    ok: true,
    value: {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      configurationVersion,
      projectionRevision,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

function readOrganisationLifecycleRow(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
): Promise<OrganisationLifecycleRow | null> {
  return db
    .prepare(
      `SELECT organisation_id AS organisationId, environment, lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision, purge_after AS purgeAfter
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OrganisationLifecycleRow>();
}

type OrganisationLifecycleKind = LifecycleMachineState;

/** The states that keep the archive time and the purge time. */
type EndingLifecycle = "archived" | "purging" | "purged";

type OrganisationLifecycleState = Readonly<{
  organisationId: OrganisationId;
  environment: OrganisationEnvironment;
  configurationVersion: number;
  projectionRevision: number;
}> &
  (
    | Readonly<{ lifecycle: EndingLifecycle; purgeAfter: number }>
    | Readonly<{
        lifecycle: Exclude<OrganisationLifecycleKind, EndingLifecycle>;
        purgeAfter?: never;
      }>
  );

type ArchiveOrganisationInput = {
  readonly identityDatabase: GlobalDatabase;
  readonly execution: OrganisationExecutionScope;
  readonly actorUserId: UserId;
  readonly mutation: ArchiveOrganisationMutation;
  readonly now: number;
} & (
  | Readonly<{
      authority: Variant<ArchiveAuthority, "organisation_owner">;
      reasonCode: "merchant_archived" | "automatic_inactivity";
    }>
  | Readonly<{
      authority: Variant<ArchiveAuthority, "support_admin">;
      reasonCode: "legacy_cutover";
    }>
);

export async function archiveOrganisation(
  input: ArchiveOrganisationInput,
): Promise<Result<ArchivedOrganisation, ArchiveOrganisationError>> {
  const parts = organisationLifecycleParts().archive;
  if (!(await input.execution.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const session = input.execution.database.withSession("first-primary");
  const row = await session
    .prepare(
      `SELECT organisation_id AS organisationId, environment, lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision, purge_after AS purgeAfter
     FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .bind(input.execution.organisationId)
    .first<OrganisationLifecycleRow>();
  const state = parseOrganisationLifecycleRow(row);
  if (state === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (state.lifecycle !== "configuring" && state.lifecycle !== "active") {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  const authority = await resolveArchiveAuthority(
    session,
    input,
    state.lifecycle,
  );
  if (!authority.ok) return authority;
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const purgeAfter = input.now + ARCHIVE_PURGE_DELAY_MS;
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.execution.organisationId,
  };
  const acceptedMutation = mutationBindings(
    input.execution,
    input.mutation.identity,
    configurationVersion,
  );
  const [admission] = await session.batch([
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.execution.organisationId,
      event: "archive",
      from: [state.lifecycle],
      fence: input.execution,
      set: {
        sql: `configuration_version = ?, projection_revision = ?,
           activation_attempt_id = NULL, readiness_version = NULL,
           activation_receipt_id = NULL, activated_at = NULL,
           suspension_reason_code = NULL, suspended_at = NULL,
           archived_at = ?, purge_after = ?`,
        bindings: [
          configurationVersion,
          projectionRevision,
          input.now,
          purgeAfter,
        ],
      },
      guard: {
        sql: "configuration_version = ?",
        bindings: [state.configurationVersion],
      },
      now: input.now,
    }),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.mutation.identity, {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      actorUserId: input.actorUserId,
      operation: "organisation.archive",
      targetKind: "organisation",
      targetId: input.execution.organisationId,
      oldLifecycle: state.lifecycle,
      newLifecycle: "archived",
      configurationVersion,
      projectionRevision,
      reasonCode: input.reasonCode,
    }),
    prepareOnboardingEventAfterWrite(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "organisation_archived",
      organisationId: input.execution.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        previous_lifecycle: state.lifecycle,
        receipt_id: input.mutation.identity.receiptId,
      },
    }),
    prepareOrganisationStatus(session, {
      organisationId: input.execution.organisationId,
      status: "deleted",
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
    ...parts.connectionsDisable(session, {
      organisationId: input.execution.organisationId,
      actorUserId: input.actorUserId,
      now: input.now,
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
    session
      .prepare(
        `INSERT INTO organisation_archive_cleanup (
         organisation_id, environment, archive_receipt_id, status, failure_code,
         archived_at, purge_after, updated_at
       ) SELECT ?, ?, ?, 'pending_provider_cleanup', NULL, ?, ?, ? WHERE ${ACCEPTED_MUTATION}`,
      )
      .bind(
        input.execution.organisationId,
        state.environment,
        input.mutation.identity.receiptId,
        input.now,
        purgeAfter,
        input.now,
        ...acceptedMutation,
      ),
    session
      .prepare(
        `INSERT INTO organisation_archive_tombstone (
         organisation_id, archive_authority_kind, archive_authority_subject_hash,
         environment, archival_reason, archived_at, purge_after, purged_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${ACCEPTED_MUTATION}
       ON CONFLICT (organisation_id) DO UPDATE SET
         archive_authority_kind = excluded.archive_authority_kind,
         archive_authority_subject_hash = excluded.archive_authority_subject_hash,
         environment = excluded.environment,
         archival_reason = excluded.archival_reason,
         archived_at = excluded.archived_at,
         purge_after = excluded.purge_after,
         purged_at = NULL`,
      )
      .bind(
        input.execution.organisationId,
        authority.value.kind,
        authority.value.subjectHash,
        state.environment,
        input.reasonCode,
        input.now,
        purgeAfter,
        ...acceptedMutation,
      ),
  ]);
  if (admission?.meta.changes !== 1)
    return lifecycleAdmissionConflict(input.execution);
  // The regional row is the record; the request copies it to the directory.
  await copyOrganisationRowToDirectory({
    directory: input.identityDatabase,
    db: input.execution.database,
    organisationId: input.execution.organisationId,
  });
  return {
    ok: true,
    value: {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      configurationVersion,
      projectionRevision,
      archivedAt: input.now,
      purgeAfter,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

async function resolveArchiveAuthority(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  input: ArchiveOrganisationInput,
  lifecycle: OrganisationLifecycleKind,
): Promise<
  Result<
    Readonly<{
      kind: ArchiveAuthority["kind"];
      subjectHash: string;
    }>,
    ArchiveOrganisationError
  >
> {
  switch (input.authority.kind) {
    case "organisation_owner": {
      const membership = await db
        .prepare(
          `SELECT user_id AS userId FROM service_role_grant
         WHERE organisation_id = ? AND status = 'active' AND role = 'owner'
         ORDER BY created_at LIMIT 1`,
        )
        .bind(input.execution.organisationId)
        .first<{ readonly userId: unknown }>();
      if (membership === null || typeof membership.userId !== "string") {
        return {
          ok: false,
          error: { code: "organisation_archive_authority_conflict" },
        };
      }
      const owner = await input.identityDatabase
        .prepare("SELECT issuer, subject FROM app_user WHERE user_id = ?")
        .bind(membership.userId)
        .first<{ readonly issuer: unknown; readonly subject: unknown }>();
      return owner !== null &&
        typeof owner.issuer === "string" &&
        typeof owner.subject === "string"
        ? {
            ok: true,
            value: {
              kind: "organisation_owner",
              subjectHash: await hashPortalSubject(owner.issuer, owner.subject),
            },
          }
        : {
            ok: false,
            error: { code: "organisation_archive_authority_conflict" },
          };
    }
    case "support_admin": {
      if (lifecycle !== "active" || input.authority.subjectHash.length === 0) {
        return {
          ok: false,
          error: { code: "organisation_archive_authority_conflict" },
        };
      }
      const guard = await db
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM service_role_grant
            WHERE organisation_id = ? AND status = 'active') AS activeMembershipCount,
           (SELECT COUNT(*) FROM commerce_merchant_binding
            WHERE organisation_id = ?) AS commerceBindingCount,
           (SELECT COUNT(*) FROM integration_account
            WHERE organisation_id = ? AND provider = 'shopify'
              AND lifecycle = 'active' AND is_default_for_provider = 1) AS activeShopifyCount`,
        )
        .bind(
          input.execution.organisationId,
          input.execution.organisationId,
          input.execution.organisationId,
        )
        .first<{
          readonly activeMembershipCount: unknown;
          readonly commerceBindingCount: unknown;
          readonly activeShopifyCount: unknown;
        }>();
      return guard?.activeMembershipCount === 0 &&
        guard.commerceBindingCount === 0 &&
        guard.activeShopifyCount === 0
        ? {
            ok: true,
            value: {
              kind: "support_admin",
              subjectHash: input.authority.subjectHash,
            },
          }
        : {
            ok: false,
            error: { code: "organisation_archive_authority_conflict" },
          };
    }
    default:
      return assertNever(input.authority);
  }
}

export async function restoreOrganisation(input: {
  /** The global copy of the Organisation row, which the request updates. */
  readonly directory: GlobalDatabase;
  readonly execution: OrganisationExecutionScope;
  readonly actorUserId: UserId;
  readonly mutation: RestoreOrganisationMutation;
  readonly now: number;
}): Promise<Result<RestoredOrganisation, RestoreOrganisationError>> {
  if (!(await input.execution.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const session = input.execution.database.withSession("first-primary");
  const row = await session
    .prepare(
      `SELECT organisation_id AS organisationId, environment, lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision, purge_after AS purgeAfter
     FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .bind(input.execution.organisationId)
    .first<OrganisationLifecycleRow>();
  const state = parseOrganisationLifecycleRow(row);
  if (state === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (state.lifecycle === "purging" || state.lifecycle === "purged") {
    return { ok: false, error: { code: "organisation_purge_started" } };
  }
  if (state.lifecycle !== "archived") {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  if (state.purgeAfter <= input.now) {
    return { ok: false, error: { code: "organisation_purge_started" } };
  }
  const cleanup = await session
    .prepare(
      `SELECT 1 FROM organisation_archive_cleanup
      WHERE organisation_id = ? AND status != 'purged'
        AND NOT EXISTS (SELECT 1 FROM organisation_harness_erasure WHERE organisation_id = ?)`,
    )
    .bind(input.execution.organisationId, input.execution.organisationId)
    .first();
  if (cleanup === null) {
    return { ok: false, error: { code: "organisation_purge_started" } };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.execution.organisationId,
  };
  const acceptedMutation = mutationBindings(
    input.execution,
    input.mutation.identity,
    configurationVersion,
  );
  const [admission] = await session.batch([
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.execution.organisationId,
      event: "restore",
      from: ["archived"],
      fence: input.execution,
      set: {
        sql: `configuration_version = ?, projection_revision = ?,
           activation_attempt_id = NULL, readiness_version = NULL,
           activation_receipt_id = NULL, activated_at = NULL,
           suspension_reason_code = NULL, suspended_at = NULL,
           archived_at = NULL, purge_after = NULL`,
        bindings: [configurationVersion, projectionRevision],
      },
      // purge_not_due: the purge time has not come and no erasure started.
      guard: {
        sql: `configuration_version = ? AND purge_after > ?
         AND EXISTS (SELECT 1 FROM organisation_archive_cleanup AS cleanup
           WHERE cleanup.organisation_id = organisation_onboarding.organisation_id AND cleanup.status != 'purged')
         AND NOT EXISTS (SELECT 1 FROM organisation_harness_erasure AS erasure
           WHERE erasure.organisation_id = organisation_onboarding.organisation_id)`,
        bindings: [state.configurationVersion, input.now],
      },
      now: input.now,
    }),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.mutation.identity, {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      actorUserId: input.actorUserId,
      operation: "organisation.restore",
      targetKind: "organisation",
      targetId: input.execution.organisationId,
      oldLifecycle: "archived",
      newLifecycle: "configuring",
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_restored",
    }),
    prepareOnboardingEventAfterWrite(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "onboarding_resumed",
      organisationId: input.execution.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        previous_lifecycle: "archived",
        receipt_id: input.mutation.identity.receiptId,
      },
    }),
    prepareOrganisationStatus(session, {
      organisationId: input.execution.organisationId,
      status: "active",
      guard: { sql: ACCEPTED_MUTATION, bindings: acceptedMutation },
    }),
    session
      .prepare(
        `DELETE FROM organisation_archive_cleanup WHERE organisation_id = ? AND status != 'purged' AND ${ACCEPTED_MUTATION}`,
      )
      .bind(input.execution.organisationId, ...acceptedMutation),
    session
      .prepare(
        `DELETE FROM organisation_archive_tombstone
       WHERE organisation_id = ? AND purged_at IS NULL AND ${ACCEPTED_MUTATION}`,
      )
      .bind(input.execution.organisationId, ...acceptedMutation),
  ]);
  if (admission?.meta.changes !== 1) {
    if (!(await input.execution.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    const erasure = await session
      .prepare(
        "SELECT 1 FROM organisation_harness_erasure WHERE organisation_id = ?",
      )
      .bind(input.execution.organisationId)
      .first();
    return {
      ok: false,
      error: {
        code:
          erasure === null
            ? "configuration_version_conflict"
            : "organisation_purge_started",
      },
    };
  }
  // The regional row is the record; the request copies it to the directory.
  await copyOrganisationRowToDirectory({
    directory: input.directory,
    db: input.execution.database,
    organisationId: input.execution.organisationId,
  });
  return {
    ok: true,
    value: {
      organisationId: input.execution.organisationId,
      environment: state.environment,
      configurationVersion,
      projectionRevision,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

function parseOrganisationLifecycleRow(
  row: OrganisationLifecycleRow | null,
): OrganisationLifecycleState | null {
  if (
    row === null ||
    typeof row.organisationId !== "string" ||
    (row.environment !== "development" && row.environment !== "production") ||
    !isOrganisationLifecycleKind(row.lifecycle) ||
    typeof row.configurationVersion !== "number" ||
    !Number.isSafeInteger(row.configurationVersion) ||
    row.configurationVersion < 1 ||
    typeof row.projectionRevision !== "number" ||
    !Number.isSafeInteger(row.projectionRevision) ||
    row.projectionRevision < 1
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(row.organisationId);
  if (!organisationId.ok) {
    return null;
  }
  if (
    row.lifecycle === "archived" ||
    row.lifecycle === "purging" ||
    row.lifecycle === "purged"
  ) {
    if (
      typeof row.purgeAfter !== "number" ||
      !Number.isSafeInteger(row.purgeAfter) ||
      row.purgeAfter < 0
    )
      return null;
    return {
      organisationId: organisationId.value,
      environment: row.environment,
      lifecycle: row.lifecycle,
      configurationVersion: row.configurationVersion,
      projectionRevision: row.projectionRevision,
      purgeAfter: row.purgeAfter,
    };
  }
  if (row.purgeAfter !== null) return null;
  return {
    organisationId: organisationId.value,
    environment: row.environment,
    lifecycle: row.lifecycle,
    configurationVersion: row.configurationVersion,
    projectionRevision: row.projectionRevision,
  };
}

function isOrganisationLifecycleKind(
  raw: unknown,
): raw is OrganisationLifecycleKind {
  return (
    raw === "configuring" ||
    raw === "activating" ||
    raw === "active" ||
    raw === "archived" ||
    raw === "purging" ||
    raw === "purged"
  );
}
