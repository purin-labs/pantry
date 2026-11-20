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
