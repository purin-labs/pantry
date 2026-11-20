import type { OrganisationDatabase } from "../database-handles";
import type {
  CapabilityMode,
  CapabilityPolicyModes,
  OrganisationCapabilityPolicy,
} from "@purin-labs/contracts";

import {
  CAPABILITY_CATALOGUE,
  capabilityDefinitionById,
  type ActiveCapabilityId,
} from "../authorization/capability-catalogue";
import { listAccessGrants } from "../data/access-grants";
import {
  prepareReadAndProposeAccessDefaults,
  READ_AND_PROPOSE_ORGANISATION_GRANT_IDS,
  readOrganisationCapabilityPolicies,
} from "../data/capability-policy";
import type { OrganisationEnvironment } from "../data/control-plane";
import type { OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "../result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { OrganisationQuerySource } from "../data/query-source";
import {
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  type ControlMutationIdentity,
  type UnversionedControlMutationBoundary,
} from "../data/control-mutation";
import { assertNever, errorMessage, isPositiveInteger } from "@purin-labs/std";
import {
  prepareAccessChangeRevision,
  prepareAccessDefaultsRevision,
} from "../data/organisation-onboarding-row";

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

type CapabilityPolicyMutationResult = Readonly<{
  policy: OrganisationCapabilityPolicy;
  environment: OrganisationEnvironment;
  configurationVersion: number;
  projectionRevision: number;
}>;

type AccessDefaultsMutationResult = Readonly<{
  environment: OrganisationEnvironment;
  configurationVersion: number;
  projectionRevision: number;
  changed: boolean;
}>;

export type AccessCapabilityMutationError =
  | Readonly<{
      code: "access_control_revision_conflict";
      expected: number;
      actual: number;
    }>
  | Readonly<{
      code: "capability_policy_revision_conflict";
      expected: number;
      actual: number;
    }>
  | Readonly<{ code: "organisation_placement_conflict" }>
  | Readonly<{ code: "capability_policy_not_found" }>
  | Readonly<{ code: "capability_policy_mode_unsupported" }>
  | Readonly<{ code: "access_capability_mutation_failed"; detail: string }>;

type CapabilityMutationInput = Readonly<{
  scope: OrganisationExecutionScope;
  actorUserId: UserId;
  identity: ControlMutationIdentity;
  boundary: UnversionedControlMutationBoundary;
  expectedProjectionRevision: number;
}>;

export async function changeVersionedCapabilityPolicy(
  input: CapabilityMutationInput &
    Readonly<{
      capabilityId: ActiveCapabilityId;
      capabilityVersion: number;
      mode: CapabilityMode;
      expectedCapabilityRevision: number;
    }>,
): Promise<
  Result<CapabilityPolicyMutationResult, AccessCapabilityMutationError>
> {
  if (!(await input.scope.isActive())) return placementConflict();
  const definition = capabilityDefinitionById(input.capabilityId);
  if (definition.capabilityVersion !== input.capabilityVersion)
    return { ok: false, error: { code: "capability_policy_not_found" } };
  if (!supportsMode(definition.policyModes, input.mode))
    return { ok: false, error: { code: "capability_policy_mode_unsupported" } };
  const session = input.scope.database.withSession("first-primary");
  const state = await readMutationState(session, input.scope.organisationId);
  if (!state.ok) return state;
  if (state.value.projectionRevision !== input.expectedProjectionRevision)
    return aggregateRevisionConflict(
      input.expectedProjectionRevision,
      state.value.projectionRevision,
    );
  const current = await readCurrentPolicy(
    session,
    input.scope.organisationId,
    input.capabilityId,
  );
  if (!current.ok) return current;
  if (current.value.revision !== input.expectedCapabilityRevision)
    return {
      ok: false,
      error: {
        code: "capability_policy_revision_conflict",
        expected: input.expectedCapabilityRevision,
        actual: current.value.revision,
      },
    };
  const configurationVersion = state.value.configurationVersion + 1;
  const projectionRevision = state.value.projectionRevision + 1;
  const policy: OrganisationCapabilityPolicy = {
    organisationId: input.scope.organisationId,
    capabilityId: current.value.capabilityId,
    capabilityVersion: current.value.capabilityVersion,
    mode: input.mode,
    provenance: {
      kind: "operator",
      userId: input.actorUserId,
      mutationReceiptId: input.identity.receiptId,
    },
    revision: current.value.revision + 1,
    changedAt: input.identity.createdAt,
  };
  try {
    const [admission] = await session.batch([
      guardedCapabilityPolicyChange(session, input),
      prepareAccessChangeRevision(session, {
        organisationId: input.scope.organisationId,
        expectedProjectionRevision: input.expectedProjectionRevision,
        updatedAt: input.identity.createdAt,
      }),
      ...capabilitySettlement(
        session,
        input,
        {
          ok: true,
          revision: projectionRevision,
          configurationVersion,
          capability: policy,
        },
        {
          environment: state.value.environment,
          configurationVersion,
          projectionRevision,
          operation: "access_control.capability.change",
          targetKind: "organisation_capability_policy",
          targetId: input.capabilityId,
          newLifecycle: input.mode,
          reasonCode: "operator_changed_capability_mode",
        },
      ),
    ]);
    if (changes(admission) !== 1) return admissionConflict(input);
  } catch (error) {
    if (!(await input.scope.isActive())) return placementConflict();
    return mutationFailure(errorMessage(error));
  }
  return mutationResult(policy, {
    environment: state.value.environment,
    configurationVersion,
    projectionRevision,
  });
}

export async function applyVersionedAccessDefaults(
  input: CapabilityMutationInput,
): Promise<
  Result<AccessDefaultsMutationResult, AccessCapabilityMutationError>
> {
  if (!(await input.scope.isActive())) return placementConflict();
  const session = input.scope.database.withSession("first-primary");
  const state = await readMutationState(session, input.scope.organisationId);
  if (!state.ok) return state;
  if (state.value.projectionRevision !== input.expectedProjectionRevision)
    return aggregateRevisionConflict(
      input.expectedProjectionRevision,
      state.value.projectionRevision,
    );
  const complete = await baselineIsComplete(
    session,
    input.scope.organisationId,
  );
  if (!complete.ok) return complete;
  const increment = complete.value ? 0 : 1;
  const configurationVersion = state.value.configurationVersion + increment;
  const projectionRevision = state.value.projectionRevision + increment;
  const statements = [
    prepareAccessDefaultsRevision(session, {
      increment,
      now: input.identity.createdAt,
      organisationId: input.scope.organisationId,
      expectedProjectionRevision: input.expectedProjectionRevision,
      placement: {
        placementEpoch: input.scope.placement.placementEpoch,
        placementCellId: input.scope.placement.placementCellId,
        fenceToken: input.scope.fenceToken,
      },
    }),
    ...capabilitySettlement(
      session,
      input,
      {
        ok: true,
        revision: projectionRevision,
        configurationVersion,
        defaults: {
          profile: "read_and_propose",
          profileVersion: 1,
          changed: !complete.value,
        },
      },
      {
        environment: state.value.environment,
        configurationVersion,
        projectionRevision,
        operation: "access_control.defaults.apply",
        targetKind: "access_default_profile",
        targetId: "read_and_propose@1",
        newLifecycle: "applied",
        reasonCode: "operator_applied_access_defaults",
      },
    ),
  ];
  if (!complete.value)
    statements.push(
      ...prepareReadAndProposeAccessDefaults({
        source: session,
        admission: {
          kind: "accepted_mutation",
          scope: input.scope,
          auditEventId: input.identity.auditEventId,
          configurationVersion,
        },
        materializationReceiptId: input.identity.receiptId,
        now: input.identity.createdAt,
        destination: { kind: "organisation" },
      }),
    );
  try {
    const [admission] = await session.batch(statements);
    if (changes(admission) !== 1) return admissionConflict(input);
  } catch (error) {
    if (!(await input.scope.isActive())) return placementConflict();
    return mutationFailure(errorMessage(error));
  }
  return {
    ok: true,
    value: {
      environment: state.value.environment,
      configurationVersion,
      projectionRevision,
      changed: !complete.value,
    },
  };
}

function capabilitySettlement(
  source: OrganisationQuerySource,
  input: CapabilityMutationInput,
  responseBody: unknown,
  audit: Readonly<{
    environment: OrganisationEnvironment;
    configurationVersion: number;
    projectionRevision: number;
    operation: string;
    targetKind: string;
    targetId: string;
    newLifecycle: string;
    reasonCode: string;
  }>,
): D1PreparedStatement[] {
  return [
    prepareControlMutationReceiptAfterWrite(source, {
      scope: {
        userId: input.actorUserId,
        organisationScope: input.scope.organisationId,
        route: `/v1/control/organisations/${input.scope.organisationId}/access-control/${audit.targetKind === "organisation_capability_policy" ? `capabilities/${audit.targetId}` : "defaults/apply"}`,
        operation: audit.operation,
      },
      boundary: input.boundary,
      identity: input.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEventAfterWrite(source, input.identity, {
      organisationId: input.scope.organisationId,
      environment: audit.environment,
      actorUserId: input.actorUserId,
      operation: audit.operation,
      targetKind: audit.targetKind,
      targetId: audit.targetId,
      oldLifecycle: null,
      newLifecycle: audit.newLifecycle,
      configurationVersion: audit.configurationVersion,
      projectionRevision: audit.projectionRevision,
      reasonCode: audit.reasonCode,
    }),
  ];
}

function placementConflict(): Result<never, AccessCapabilityMutationError> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}

async function admissionConflict(
  input: CapabilityMutationInput,
): Promise<Result<never, AccessCapabilityMutationError>> {
  if (!(await input.scope.isActive())) return placementConflict();
  return aggregateRevisionConflict(
    input.expectedProjectionRevision,
    await currentProjectionRevision(
      input.scope.database,
      input.scope.organisationId,
    ),
  );
}

async function baselineIsComplete(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<Result<boolean, AccessCapabilityMutationError>> {
  const policies = await readOrganisationCapabilityPolicies({
    db,
    organisationId,
  });
  if (!policies.ok) return mutationFailure(policies.error.code);
  if (policies.value.length !== CAPABILITY_CATALOGUE.length)
    return { ok: true, value: false };
  const capabilityIds = new Set(policies.value.map(readCapabilityId));
  for (const definition of CAPABILITY_CATALOGUE) {
    if (!capabilityIds.has(definition.capabilityId))
      return { ok: true, value: false };
  }
  const grants = await listAccessGrants({ db, organisationId });
  if (!grants.ok) return mutationFailure(grants.error.code);
  const grantIds = new Set(grants.value.map(readGrantId));
  for (const grantId of READ_AND_PROPOSE_ORGANISATION_GRANT_IDS) {
    if (!grantIds.has(grantId)) return { ok: true, value: false };
  }
  return { ok: true, value: true };
}

function guardedCapabilityPolicyChange(
  db: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    scope: OrganisationExecutionScope;
    capabilityId: ActiveCapabilityId;
    mode: CapabilityMode;
    expectedProjectionRevision: number;
    expectedCapabilityRevision: number;
    actorUserId: UserId;
    identity: ControlMutationIdentity;
  }>,
): D1PreparedStatement {
  const definition = capabilityDefinitionById(input.capabilityId);
  return db
    .prepare(
      `UPDATE organisation_capability_policy
        SET mode = ?, provenance_json = ?, revision = revision + 1, changed_at = ?
      WHERE organisation_id = ? AND capability_id = ? AND capability_version = ? AND revision = ?
        AND EXISTS (
          SELECT 1 FROM organisation_onboarding
           WHERE organisation_id = ? AND projection_revision = ?
        ) AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
          AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.mode,
      JSON.stringify({
        kind: "operator",
        userId: input.actorUserId,
        mutationReceiptId: input.identity.receiptId,
      }),
      input.identity.createdAt,
      input.scope.organisationId,
      input.capabilityId,
      definition.capabilityVersion,
      input.expectedCapabilityRevision,
      input.scope.organisationId,
      input.expectedProjectionRevision,
      input.scope.organisationId,
      input.scope.placement.placementEpoch,
      input.scope.placement.placementCellId,
      input.scope.fenceToken,
    );
}

async function readMutationState(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: OrganisationId,
): Promise<Result<AccessControlMutationState, AccessCapabilityMutationError>> {
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

async function readCurrentPolicy(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  capabilityId: ActiveCapabilityId,
): Promise<
  Result<OrganisationCapabilityPolicy, AccessCapabilityMutationError>
> {
  const policies = await readOrganisationCapabilityPolicies({
    db,
    organisationId,
  });
  if (!policies.ok) return mutationFailure(policies.error.code);
  for (const policy of policies.value) {
    if (policy.capabilityId === capabilityId)
      return { ok: true, value: policy };
  }
  return { ok: false, error: { code: "capability_policy_not_found" } };
}

function mutationResult(
  policy: OrganisationCapabilityPolicy,
  state: AccessControlMutationState,
): Result<CapabilityPolicyMutationResult, never> {
  return {
    ok: true,
    value: {
      policy,
      environment: state.environment,
      configurationVersion: state.configurationVersion,
      projectionRevision: state.projectionRevision,
    },
  };
}

function supportsMode(
  modes: CapabilityPolicyModes,
  mode: CapabilityMode,
): boolean {
  switch (modes) {
    case "enabled_disabled":
      return mode === "enabled" || mode === "disabled";
    case "approval_required_disabled":
      return mode === "approval_required" || mode === "disabled";
    case "enabled_approval_required_disabled":
      return true;
    default:
      return assertNever(modes);
  }
}

async function currentProjectionRevision(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<number> {
  const state = await readMutationState(db, organisationId);
  return state.ok ? state.value.projectionRevision : 0;
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0;
}

function isOrganisationEnvironment(
  value: unknown,
): value is OrganisationEnvironment {
  return value === "development" || value === "production";
}

function readCapabilityId(policy: OrganisationCapabilityPolicy): string {
  return policy.capabilityId;
}

function readGrantId(grant: Readonly<{ grantId: string }>): string {
  return grant.grantId;
}

function aggregateRevisionConflict(
  expected: number,
  actual: number,
): Result<never, AccessCapabilityMutationError> {
  return {
    ok: false,
    error: { code: "access_control_revision_conflict", expected, actual },
  };
}

function mutationFailure(
  detail: string,
): Result<never, AccessCapabilityMutationError> {
  return {
    ok: false,
    error: { code: "access_capability_mutation_failed", detail },
  };
}
