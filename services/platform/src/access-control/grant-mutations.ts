import type { OrganisationDatabase } from "../database-handles";
import type {
  AccessGrant,
  AccessGrantTarget,
  GrantSubject,
} from "../authorization/access-grants/types";
import { readAccessGrant } from "../data/access-grants";
import type { OrganisationEnvironment } from "../data/control-plane";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { parseIntegrationAccountId } from "../ids";
import type { Result } from "../result";
import { fileGrantParts } from "../authorization/access-grants/file-grant-parts";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  type ControlMutationIdentity,
  type UnversionedControlMutationBoundary,
} from "../data/control-mutation";
import { errorMessage, isPositiveInteger } from "@purin-labs/std";
import { prepareAccessChangeRevision } from "../data/organisation-onboarding-row";

type AccessControlMutationStateRow = Readonly<{
  environment: unknown;
  configurationVersion: unknown;
  projectionRevision: unknown;
}>;

type AccessControlMutationState = Readonly<{
  environment: OrganisationEnvironment;
  configurationVersion: number;
  projectionRevision: number;
}>;

export type AccessGrantMutationResult = Readonly<{
  grant: AccessGrant;
  environment: OrganisationEnvironment;
  configurationVersion: number;
  projectionRevision: number;
  recovered: boolean;
}>;

export type AccessGrantMutationError =
  | Readonly<{
      code: "access_control_revision_conflict";
      expected: number;
      actual: number;
    }>
  | Readonly<{
      code: "access_grant_revision_conflict";
      expected: number;
      actual: number;
    }>
  | Readonly<{ code: "access_grant_not_found" }>
  | Readonly<{
      code: "access_grant_invalid_transition";
      lifecycle: AccessGrant["lifecycle"]["kind"];
    }>
  | Readonly<{ code: "access_grant_mutation_failed"; detail: string }>;

export async function createVersionedAccessGrant(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    grantId: string;
    expectedProjectionRevision: number;
    subject: GrantSubject;
    target: AccessGrantTarget;
    actorUserId: UserId;
    identity: ControlMutationIdentity;
    boundary: UnversionedControlMutationBoundary;
  }>,
): Promise<Result<AccessGrantMutationResult, AccessGrantMutationError>> {
  if (!(await input.scope.isActive()))
    return mutationFailure("organisation placement is no longer active");
  const state = await readMutationState(
    input.scope.database,
    input.scope.organisationId,
  );
  if (!state.ok) return state;
  const existing = await readAccessGrant({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    grantId: input.grantId,
  });
  if (existing.ok) {
    return matchingCreatedGrant(existing.value, {
      subject: input.subject,
      target: input.target,
      actorUserId: input.actorUserId,
      mutationReceiptId: input.identity.receiptId,
    }) && state.value.projectionRevision >= input.expectedProjectionRevision + 1
      ? recoveredResult(existing.value, state.value)
      : mutationFailure("grant ID collision");
  }
  if (existing.error.code !== "access_grant_not_found") {
    return mutationFailure(existing.error.code);
  }
  if (state.value.projectionRevision !== input.expectedProjectionRevision) {
    return revisionConflict(
      input.expectedProjectionRevision,
      state.value.projectionRevision,
    );
  }
  const provenance = {
    kind: "operator" as const,
    userId: input.actorUserId,
    mutationReceiptId: input.identity.receiptId,
  };
  const statements = [
    input.scope.database
      .prepare(
        `INSERT INTO access_grant (
         organisation_id, grant_id, subject_json, target_json, lifecycle,
         revision, reason, provenance_json, changed_at
       )
       SELECT ?, ?, ?, ?, 'active', 1, NULL, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM organisation_onboarding
           WHERE organisation_id = ? AND projection_revision = ?
        ) AND EXISTS (
          SELECT 1 FROM organisation_placement WHERE organisation_id = ?
            AND placement_epoch = ? AND placement_cell_id = ?
            AND fence_token = ? AND status = 'active'
        )`,
      )
      .bind(
        input.scope.organisationId,
        input.grantId,
        JSON.stringify(input.subject),
        JSON.stringify(input.target),
        JSON.stringify(provenance),
        input.identity.createdAt,
        input.scope.organisationId,
        input.expectedProjectionRevision,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      ),
  ];
  const grant: AccessGrant = {
    organisationId: input.scope.organisationId,
    grantId: input.grantId,
    subject: input.subject,
    target: input.target,
    provenance,
    lifecycle: {
      kind: "active",
      revision: 1,
      activatedAt: input.identity.createdAt,
    },
  };
  statements.push(
    prepareAccessChangeRevision(input.scope.database, {
      organisationId: input.scope.organisationId,
      expectedProjectionRevision: input.expectedProjectionRevision,
    }),
    ...prepareGrantSettlement(input, state.value, grant),
  );
  if (input.target.kind === "file_resource") {
    statements.push(
      fileGrantParts.use().prepareChangedFileGrantSync(input.scope.database, {
        organisationId: input.scope.organisationId,
        grantId: input.grantId,
        integrationAccountId: requireIntegrationAccountId(
          input.target.integrationAccountId,
        ),
        now: input.identity.createdAt,
      }),
    );
  }
  try {
    const [grantWrite, revisionWrite, receiptWrite, auditWrite] =
      await input.scope.database.batch(statements);
    if (
      changes(grantWrite) !== 1 ||
      changes(revisionWrite) !== 1 ||
      changes(receiptWrite) !== 1 ||
      changes(auditWrite) !== 1
    ) {
      return revisionConflict(
        input.expectedProjectionRevision,
        await currentProjectionRevision(
          input.scope.database,
          input.scope.organisationId,
        ),
      );
    }
  } catch (error) {
    return mutationFailure(errorMessage(error));
  }
  return {
    ok: true,
    value: {
      grant,
      environment: state.value.environment,
      configurationVersion: state.value.configurationVersion + 1,
      projectionRevision: state.value.projectionRevision + 1,
      recovered: false,
    },
  };
}

export async function revokeVersionedAccessGrant(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    grantId: string;
    expectedProjectionRevision: number;
    expectedGrantRevision: number;
    reason: string;
    actorUserId: UserId;
    identity: ControlMutationIdentity;
    boundary: UnversionedControlMutationBoundary;
  }>,
): Promise<Result<AccessGrantMutationResult, AccessGrantMutationError>> {
  if (!(await input.scope.isActive()))
    return mutationFailure("organisation placement is no longer active");
  const state = await readMutationState(
    input.scope.database,
    input.scope.organisationId,
  );
  if (!state.ok) return state;
  const existing = await readAccessGrant({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    grantId: input.grantId,
  });
  if (!existing.ok) {
    return existing.error.code === "access_grant_not_found"
      ? { ok: false, error: { code: "access_grant_not_found" } }
      : mutationFailure(existing.error.code);
  }
  if (
    isMatchingRecoveredRevocation(existing.value, {
      expectedGrantRevision: input.expectedGrantRevision,
      reason: input.reason,
      actorUserId: input.actorUserId,
      mutationReceiptId: input.identity.receiptId,
    }) &&
    state.value.projectionRevision >= input.expectedProjectionRevision + 1
  ) {
    return recoveredResult(existing.value, state.value);
  }
  if (state.value.projectionRevision !== input.expectedProjectionRevision) {
    return revisionConflict(
      input.expectedProjectionRevision,
      state.value.projectionRevision,
    );
  }
  if (existing.value.lifecycle.revision !== input.expectedGrantRevision) {
    return {
      ok: false,
      error: {
        code: "access_grant_revision_conflict",
        expected: input.expectedGrantRevision,
        actual: existing.value.lifecycle.revision,
      },
    };
  }
  if (existing.value.lifecycle.kind !== "active") {
    return {
      ok: false,
      error: {
        code: "access_grant_invalid_transition",
        lifecycle: existing.value.lifecycle.kind,
      },
    };
  }
  const grant: AccessGrant = {
    organisationId: input.scope.organisationId,
    grantId: input.grantId,
    subject: existing.value.subject,
    target: existing.value.target,
    provenance: {
      kind: "operator",
      userId: input.actorUserId,
      mutationReceiptId: input.identity.receiptId,
    },
    lifecycle: {
      kind: "revoked",
      revision: input.expectedGrantRevision + 1,
      revokedAt: input.identity.createdAt,
      reason: input.reason,
    },
  };
  try {
    const statements = [
      input.scope.database
        .prepare(
          `UPDATE access_grant
            SET lifecycle = 'revoked', revision = revision + 1,
                reason = ?, provenance_json = ?, changed_at = ?
          WHERE organisation_id = ? AND grant_id = ? AND lifecycle = 'active' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM organisation_onboarding
               WHERE organisation_id = ? AND projection_revision = ?
            ) AND EXISTS (
              SELECT 1 FROM organisation_placement WHERE organisation_id = ?
                AND placement_epoch = ? AND placement_cell_id = ?
                AND fence_token = ? AND status = 'active'
            )`,
        )
        .bind(
          input.reason,
          JSON.stringify(grant.provenance),
          input.identity.createdAt,
          input.scope.organisationId,
          input.grantId,
          input.expectedGrantRevision,
          input.scope.organisationId,
          input.expectedProjectionRevision,
          input.scope.organisationId,
          input.scope.placement.placementEpoch,
          input.scope.placement.placementCellId,
          input.scope.fenceToken,
        ),
      prepareAccessChangeRevision(input.scope.database, {
        organisationId: input.scope.organisationId,
        expectedProjectionRevision: input.expectedProjectionRevision,
      }),
      ...prepareGrantSettlement(input, state.value, grant),
    ];
    if (existing.value.target.kind === "file_resource") {
      statements.push(
        ...fileGrantParts.use().prepareRevokedFileGrantCleanup({
          scope: input.scope,
          receiptId: input.identity.receiptId,
          grantId: input.grantId,
          integrationAccountId: requireIntegrationAccountId(
            existing.value.target.integrationAccountId,
          ),
          now: input.identity.createdAt,
        }),
      );
    }
    const [grantWrite, revisionWrite, receiptWrite, auditWrite] =
      await input.scope.database.batch(statements);
    if (
      changes(grantWrite) !== 1 ||
      changes(revisionWrite) !== 1 ||
      changes(receiptWrite) !== 1 ||
      changes(auditWrite) !== 1
    ) {
      return revisionConflict(
        input.expectedProjectionRevision,
        await currentProjectionRevision(
          input.scope.database,
          input.scope.organisationId,
        ),
      );
    }
  } catch (error) {
    return mutationFailure(errorMessage(error));
  }
  return {
    ok: true,
    value: {
      grant,
      environment: state.value.environment,
      configurationVersion: state.value.configurationVersion + 1,
      projectionRevision: state.value.projectionRevision + 1,
      recovered: false,
    },
  };
}

async function readMutationState(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: OrganisationId,
): Promise<Result<AccessControlMutationState, AccessGrantMutationError>> {
  try {
    const row = await db
      .prepare(
        `SELECT environment,
              configuration_version AS configurationVersion,
              projection_revision AS projectionRevision
         FROM organisation_onboarding
        WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<AccessControlMutationStateRow>();
    if (
      row === null ||
      !isOrganisationEnvironment(row.environment) ||
      !isPositiveInteger(row.configurationVersion) ||
      !isPositiveInteger(row.projectionRevision)
    ) {
      return mutationFailure("organisation state is unavailable");
    }
    return {
      ok: true,
      value: {
        environment: row.environment,
        configurationVersion: row.configurationVersion,
        projectionRevision: row.projectionRevision,
      },
    };
  } catch (error) {
    return mutationFailure(errorMessage(error));
  }
}

function prepareGrantSettlement(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    actorUserId: UserId;
    identity: ControlMutationIdentity;
    boundary: UnversionedControlMutationBoundary;
  }>,
  state: AccessControlMutationState,
  grant: AccessGrant,
): D1PreparedStatement[] {
  const created = grant.lifecycle.kind === "active";
  const operation = created
    ? "access_control.grant.create"
    : "access_control.grant.revoke";
  const base = `/v1/control/organisations/${input.scope.organisationId}/access-control/grants`;
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  return [
    prepareControlMutationReceiptAfterWrite(input.scope.database, {
      scope: {
        userId: input.actorUserId,
        organisationScope: input.scope.organisationId,
        route: created ? base : `${base}/${grant.grantId}/revoke`,
        operation,
      },
      boundary: input.boundary,
      identity: input.identity,
      responseStatus: 200,
      responseBody: {
        ok: true,
        revision: projectionRevision,
        configurationVersion,
        grant,
      },
    }),
    prepareOnboardingAuditEventAfterWrite(
      input.scope.database,
      input.identity,
      {
        organisationId: input.scope.organisationId,
        environment: state.environment,
        actorUserId: input.actorUserId,
        operation,
        targetKind: "access_grant",
        targetId: grant.grantId,
        oldLifecycle: created ? null : "active",
        newLifecycle: grant.lifecycle.kind,
        configurationVersion,
        projectionRevision,
        reasonCode: created
          ? "operator_granted_access"
          : "operator_revoked_access",
      },
    ),
  ];
}

function matchingCreatedGrant(
  grant: AccessGrant,
  input: Readonly<{
    subject: GrantSubject;
    target: AccessGrantTarget;
    actorUserId: UserId;
    mutationReceiptId: string;
  }>,
): boolean {
  return (
    grant.lifecycle.kind === "active" &&
    JSON.stringify(grant.subject) === JSON.stringify(input.subject) &&
    JSON.stringify(grant.target) === JSON.stringify(input.target) &&
    grant.provenance.kind === "operator" &&
    grant.provenance.userId === input.actorUserId &&
    grant.provenance.mutationReceiptId === input.mutationReceiptId
  );
}

function isMatchingRecoveredRevocation(
  grant: AccessGrant,
  input: Readonly<{
    expectedGrantRevision: number;
    reason: string;
    actorUserId: UserId;
    mutationReceiptId: string;
  }>,
): boolean {
  return (
    grant.lifecycle.kind === "revoked" &&
    grant.lifecycle.revision === input.expectedGrantRevision + 1 &&
    grant.lifecycle.reason === input.reason &&
    grant.provenance.kind === "operator" &&
    grant.provenance.userId === input.actorUserId &&
    grant.provenance.mutationReceiptId === input.mutationReceiptId
  );
}

function recoveredResult(
  grant: AccessGrant,
  state: AccessControlMutationState,
): Result<AccessGrantMutationResult, never> {
  return {
    ok: true,
    value: {
      grant,
      environment: state.environment,
      configurationVersion: state.configurationVersion,
      projectionRevision: state.projectionRevision,
      recovered: true,
    },
  };
}

async function currentProjectionRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<number> {
  const state = await readMutationState(db, organisationId);
  return state.ok ? state.value.projectionRevision : 0;
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0;
}

function requireIntegrationAccountId(value: string): IntegrationAccountId {
  const parsed = parseIntegrationAccountId(value);
  if (!parsed.ok)
    throw new Error("Stored file integration account ID is invalid");
  return parsed.value;
}

function isOrganisationEnvironment(
  value: unknown,
): value is OrganisationEnvironment {
  return value === "development" || value === "production";
}

function revisionConflict(
  expected: number,
  actual: number,
): Result<never, AccessGrantMutationError> {
  return {
    ok: false,
    error: { code: "access_control_revision_conflict", expected, actual },
  };
}

function mutationFailure(
  detail: string,
): Result<never, AccessGrantMutationError> {
  return { ok: false, error: { code: "access_grant_mutation_failed", detail } };
}
