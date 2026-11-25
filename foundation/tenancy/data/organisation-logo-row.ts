import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationQuerySource } from "./query-source";

/**
 * The organisation_logo row: the SHA-256 of the logo that an owner uploaded
 * for the organisation. The bytes are in R2 (organisation-logos/); the
 * organisation's control plane reads the digest with each membership.
 */

/** The organisation's logo digest; undefined when the organisation is gone. */
export async function readOrganisationLogoDigest(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<string | null | undefined> {
  const row = await db
    .prepare(
      `SELECT organisation_logo.logo_sha256 AS sha256
       FROM organisation
       LEFT JOIN organisation_logo
         ON organisation_logo.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ sha256: unknown }>();
  if (row === null) return undefined;
  return typeof row.sha256 === "string" ? row.sha256 : null;
}

/**
 * Moves the digest from `from` to `to` (null: no logo). The statement changes
 * no row when another write came first.
 */
export function prepareOrganisationLogoDigest(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    from: string | null;
    to: string | null;
    now: number;
  }>,
): D1PreparedStatement {
  if (input.from === null)
    return db
      .prepare(
        `INSERT INTO organisation_logo (organisation_id, logo_sha256, updated_at)
         VALUES (?, ?, ?) ON CONFLICT (organisation_id) DO NOTHING`,
      )
      .bind(input.organisationId, input.to, input.now);
  if (input.to === null)
    return db
      .prepare(
        "DELETE FROM organisation_logo WHERE organisation_id = ? AND logo_sha256 = ?",
      )
      .bind(input.organisationId, input.from);
  return db
    .prepare(
      `UPDATE organisation_logo SET logo_sha256 = ?, updated_at = ?
       WHERE organisation_id = ? AND logo_sha256 = ?`,
    )
    .bind(input.to, input.now, input.organisationId, input.from);
}
