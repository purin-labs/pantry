// The options that the Access page offers for a grant's subject and resource.

import {
  subjectSources,
  subjectSourcesSql,
  type SubjectSource,
} from "../access-control/subject-reads";

type Database = Pick<D1Database, "prepare">;

export type SubjectOptionRow = Readonly<{
  kind: unknown;
  firstId: unknown;
  secondId: unknown;
  revision: unknown;
  label: unknown;
}>;

export type IntegrationOptionRow = Readonly<{
  integrationAccountId: unknown;
  label: unknown;
  provider: unknown;
  lifecycle: unknown;
}>;

/** One page of subject options that match the query, and one row more. */
export async function readSubjectOptionRows(
  db: Database,
  input: Readonly<{
    organisationId: string;
    query: string;
    limit: number;
    offset: number;
  }>,
): Promise<readonly SubjectOptionRow[]> {
  const sources = subjectSources();
  const rows = await db
    .prepare(subjectOptionsSql(sources))
    .bind(
      input.organisationId,
      ...sources.map(() => input.organisationId),
      input.query,
      input.query,
      input.limit,
      input.offset,
    )
    .all<SubjectOptionRow>();
  return rows.results ?? [];
}

/** One page of integration accounts that match the query, and one row more. */
export async function readIntegrationOptionRows(
  db: Database,
  input: Readonly<{
    organisationId: string;
    query: string;
    limit: number;
    offset: number;
  }>,
): Promise<readonly IntegrationOptionRow[]> {
  const rows = await db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
              display_name AS label,
              provider,
              lifecycle
         FROM integration_account
        WHERE organisation_id = ?
          AND (? = '' OR instr(lower(display_name), ?) > 0)
        ORDER BY lower(display_name), integration_account_id
        LIMIT ? OFFSET ?`,
    )
    .bind(
      input.organisationId,
      input.query,
      input.query,
      input.limit,
      input.offset,
    )
    .all<IntegrationOptionRow>();
  return rows.results ?? [];
}

function subjectOptionsSql(sources: readonly SubjectSource[]): string {
  return `WITH subject_options AS (
    SELECT * FROM (
      SELECT 'organisation_role' AS kind, 'owner' AS firstId, NULL AS secondId, 1 AS revision, 'Owner role' AS label
      UNION ALL SELECT 'organisation_role', 'admin', NULL, 1, 'Admin role'
      UNION ALL SELECT 'organisation_role', 'operator', NULL, 1, 'Operator role'
      UNION ALL SELECT 'organisation_role', 'viewer', NULL, 1, 'Viewer role'
      UNION ALL
      SELECT 'person', person.person_id, NULL, 1, person.display_name
        FROM service_role_grant AS membership
        JOIN person ON person.organisation_id = membership.organisation_id
          AND person.person_id = membership.person_id
       WHERE membership.organisation_id = ? AND membership.status = 'active'
    )
    UNION ALL
    SELECT * FROM (
      ${subjectSourcesSql(sources, "option")}
    )
  )
  SELECT kind, firstId, secondId, revision, label
    FROM subject_options
   WHERE (? = '' OR instr(lower(label), ?) > 0)
   ORDER BY lower(label), kind, firstId, secondId
   LIMIT ? OFFSET ?`;
}
