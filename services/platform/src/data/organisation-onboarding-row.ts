// The organisation's onboarding row, as the control routes read and fence it.
// The columns stay unknown: each caller checks the ones it uses.

type Database = Pick<D1Database, "prepare">;

export type OnboardingRow = Readonly<{
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
