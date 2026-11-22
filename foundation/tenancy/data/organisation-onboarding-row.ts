// The organisation's onboarding row: the configuration row of an Organisation.
// It holds two counters. `configuration_version` changes when the settings of
// the Organisation change, and a control mutation is fenced on it.
// `projection_revision` changes when anything that the Portal shows changes.
//
// This module owns the writes of the two counters. Another module puts one of
// these statements into its own batch, so that its change and the counter move
// together. The columns that a read gives stay unknown: each caller checks the
// ones it uses.

type Database = Pick<D1Database, "prepare">;

type OnboardingRow = Readonly<{
  environment: unknown;
  lifecycle: unknown;
  configurationVersion: unknown;
  projectionRevision: unknown;
}>;

/** The onboarding row, or null when the organisation has none. */
export function readOnboardingRow(
  db: Database,
  organisationId: string,
): Promise<OnboardingRow | null> {
  return db
    .prepare(
      `SELECT environment, lifecycle,
              configuration_version AS configurationVersion,
              projection_revision AS projectionRevision
         FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OnboardingRow>();
}

/**
 * Advances the configuration version from `expected` to `next`. A row at
 * another version gets a NULL version, which the batch's receipt then refuses.
 */
export function prepareConfigurationVersionAdvance(
  db: Database,
  input: Readonly<{
    organisationId: string;
    expected: number;
    next: number;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
       SET configuration_version =
         CASE WHEN configuration_version = ? THEN ? ELSE NULL END,
           projection_revision = projection_revision + 1, updated_at = ?
       WHERE organisation_id = ?`,
    )
    .bind(input.expected, input.next, input.now, input.organisationId);
}

/** Changes one row only when the configuration version is still `version`. */
export function prepareConfigurationVersionFence(
  db: Database,
  organisationId: string,
  version: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding SET updated_at = updated_at
       WHERE organisation_id = ? AND configuration_version = ?`,
    )
    .bind(organisationId, version);
}

/**
 * Moves the projection on by one, so that the Portal reads the Organisation
 * again. With `atConfigurationVersion`, no row changes when the settings moved
 * in the meantime.
 */
export function prepareProjectionRevisionBump(
  db: Database,
  organisationId: string,
  options: Readonly<{ updatedAt?: number; atConfigurationVersion?: number }> = {},
): D1PreparedStatement {
  const stamp = options.updatedAt === undefined ? "" : ", updated_at = ?";
  const fence =
    options.atConfigurationVersion === undefined
      ? ""
      : " AND configuration_version = ?";
  return db
    .prepare(
      `UPDATE organisation_onboarding
       SET projection_revision = projection_revision + 1${stamp}
       WHERE organisation_id = ?${fence}`,
    )
    .bind(
      ...(options.updatedAt === undefined ? [] : [options.updatedAt]),
      organisationId,
      ...(options.atConfigurationVersion === undefined
        ? []
        : [options.atConfigurationVersion]),
    );
}

/**
 * Moves the configuration version and the projection on by one. With
 * `atConfigurationVersion`, no row changes when the settings moved in the
 * meantime, and the caller reads that from the count of changed rows.
 */
export function prepareConfigurationVersionBump(
  db: Database,
  organisationId: string,
  now: number,
  options: Readonly<{ atConfigurationVersion?: number }> = {},
): D1PreparedStatement {
  const fence =
    options.atConfigurationVersion === undefined
      ? ""
      : " AND configuration_version = ?";
  return db
    .prepare(
      `UPDATE organisation_onboarding
       SET configuration_version = configuration_version + 1,
           projection_revision = projection_revision + 1, updated_at = ?
       WHERE organisation_id = ?${fence}`,
    )
    .bind(
      now,
      organisationId,
      ...(options.atConfigurationVersion === undefined
        ? []
        : [options.atConfigurationVersion]),
    );
}

/** The active placement that a fenced statement checks. */
type PlacementFence = Readonly<{
  placementEpoch: number;
  placementCellId: string;
  fenceToken: string;
}>;

/**
 * Moves both counters on by `increment` (0 or 1) after a change of the
 * access defaults. No row changes when the projection moved in the meantime
 * or the placement is no longer active.
 */
export function prepareAccessDefaultsRevision(
  db: Database,
  input: Readonly<{
    increment: number;
    now: number;
    organisationId: string;
    expectedProjectionRevision: number;
    placement: PlacementFence;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding SET configuration_version = configuration_version + ?,
      projection_revision = projection_revision + ?, updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END
      WHERE organisation_id = ? AND projection_revision = ? AND EXISTS (SELECT 1 FROM organisation_placement
        WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.increment,
      input.increment,
      input.increment,
      input.now,
      input.organisationId,
      input.expectedProjectionRevision,
      input.organisationId,
      input.placement.placementEpoch,
      input.placement.placementCellId,
      input.placement.fenceToken,
    );
}

/**
 * Moves both counters on by one when the statement before it in the batch
 * changed one row and the projection is still at `expectedProjectionRevision`.
 * With `updatedAt`, it also stamps the row.
 */
export function prepareAccessChangeRevision(
  db: Database,
  input: Readonly<{
    organisationId: string;
    expectedProjectionRevision: number;
    updatedAt?: number;
  }>,
): D1PreparedStatement {
  if (input.updatedAt !== undefined) {
    return db
      .prepare(
        `UPDATE organisation_onboarding
        SET configuration_version = configuration_version + 1,
            projection_revision = projection_revision + 1,
            updated_at = ?
      WHERE organisation_id = ? AND projection_revision = ? AND changes() = 1`,
      )
      .bind(
        input.updatedAt,
        input.organisationId,
        input.expectedProjectionRevision,
      );
  }
  return db
    .prepare(
      `UPDATE organisation_onboarding
        SET configuration_version = configuration_version + 1,
            projection_revision = projection_revision + 1
      WHERE organisation_id = ? AND projection_revision = ? AND changes() = 1`,
    )
    .bind(input.organisationId, input.expectedProjectionRevision);
}

/** Moves the projection on by one for the Organisation of an activation attempt. */
export function prepareActivationProjectionBump(
  db: Database,
  input: Readonly<{ now: number; activationAttemptId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
       SET projection_revision = projection_revision + 1, updated_at = ?
       WHERE activation_attempt_id = ?`,
    )
    .bind(input.now, input.activationAttemptId);
}

/**
 * Moves both counters on by one after a repair of the scheduled onboarding
 * run. An archived, purging or purged Organisation does not change.
 */
export function prepareRepairConfigurationBump(
  db: Database,
  organisationId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
     SET configuration_version = configuration_version + 1,
         projection_revision = projection_revision + 1,
         updated_at = ?
     WHERE organisation_id = ? AND lifecycle NOT IN ('archived', 'purging', 'purged')`,
    )
    .bind(now, organisationId);
}

/**
 * Sets the counters after a change of the inference selection. With
 * `invalidateReadiness`, the readiness and the activation are cleared. No row
 * changes when the configuration version moved in the meantime.
 */
export function prepareInferenceSelectionRevision(
  db: Database,
  input: Readonly<{
    nextConfigurationVersion: number;
    nextProjectionRevision: number;
    invalidateReadiness: boolean;
    now: number;
    organisationId: string;
    configurationVersion: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
       SET configuration_version = ?, projection_revision = ?,
           readiness_version = CASE WHEN ? = 1 THEN NULL ELSE readiness_version END,
           activation_attempt_id = CASE WHEN ? = 1 THEN NULL ELSE activation_attempt_id END,
           activation_receipt_id = CASE WHEN ? = 1 THEN NULL ELSE activation_receipt_id END,
           activated_at = CASE WHEN ? = 1 THEN NULL ELSE activated_at END,
           updated_at = ?
       WHERE organisation_id = ? AND configuration_version = ?`,
    )
    .bind(
      input.nextConfigurationVersion,
      input.nextProjectionRevision,
      input.invalidateReadiness ? 1 : 0,
      input.invalidateReadiness ? 1 : 0,
      input.invalidateReadiness ? 1 : 0,
      input.invalidateReadiness ? 1 : 0,
      input.now,
      input.organisationId,
      input.configurationVersion,
    );
}

/**
 * Sets the counters of a publication. No row changes when a counter moved in
 * the meantime, when the Organisation is not configuring or active, or when
 * the placement is no longer active.
 */
export function preparePublicationRevision(
  db: Database,
  input: Readonly<{
    nextConfigurationVersion: number;
    nextProjectionRevision: number;
    now: number;
    organisationId: string;
    configurationVersion: number;
    projectionRevision: number;
    placement: PlacementFence;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
          SET configuration_version = ?, projection_revision = ?, updated_at = ?
        WHERE organisation_id = ? AND configuration_version = ? AND projection_revision = ?
          AND lifecycle IN ('configuring', 'active') AND EXISTS (SELECT 1 FROM organisation_placement
            WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.nextConfigurationVersion,
      input.nextProjectionRevision,
      input.now,
      input.organisationId,
      input.configurationVersion,
      input.projectionRevision,
      input.organisationId,
      input.placement.placementEpoch,
      input.placement.placementCellId,
      input.placement.fenceToken,
    );
}

/**
 * Changes one row only when the configuration version is still `version` and
 * the caller's condition holds. The condition comes after the version.
 */
export function prepareGuardedConfigurationVersionFence(
  db: Database,
  input: Readonly<{
    organisationId: string;
    version: number;
    guard: Readonly<{ condition: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding SET updated_at = updated_at
        WHERE organisation_id = ? AND configuration_version = ? AND ${input.guard.condition}`,
    )
    .bind(input.organisationId, input.version, ...input.guard.bindings);
}

/** Moves both counters on by one, with no stamp and no fence. */
export function prepareUnfencedConfigurationBump(
  db: Database,
  organisationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
     SET configuration_version = configuration_version + 1,
         projection_revision = projection_revision + 1
     WHERE organisation_id = ?`,
    )
    .bind(organisationId);
}

/**
 * Moves the projection on by one when the account now waits for a new
 * authorization: its lifecycle is reauth_required and it changed at `now`.
 */
export function prepareReauthProjectionBump(
  db: Database,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organisation_onboarding
         SET projection_revision = projection_revision + 1
         WHERE organisation_id = ? AND EXISTS (
           SELECT 1 FROM integration_account
           WHERE organisation_id = ? AND integration_account_id = ?
             AND lifecycle = 'reauth_required' AND updated_at = ?
         )`,
    )
    .bind(
      input.organisationId,
      input.organisationId,
      input.integrationAccountId,
      input.now,
    );
}
