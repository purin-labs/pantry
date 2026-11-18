// The role that Pantry keeps for an account invitation it issued.

type Database = Pick<D1Database, "prepare">;

/** The kept role of the invitation, or null when Pantry keeps none. */
export function readServiceInvitationRole(
  db: Database,
  organisationId: string,
  invitationId: string,
): Promise<{ role: unknown } | null> {
  return db
    .prepare(
      "SELECT role FROM account_service_invitation_role WHERE native_organisation_id = ? AND platform_invitation_id = ?",
    )
    .bind(organisationId, invitationId)
    .first<{ role: unknown }>();
}

/** True when Pantry keeps a role for the invitation. */
export async function serviceInvitationRoleExists(
  db: Database,
  organisationId: string,
  invitationId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT platform_invitation_id FROM account_service_invitation_role WHERE native_organisation_id = ? AND platform_invitation_id = ?",
    )
    .bind(organisationId, invitationId)
    .first();
  return row !== null;
}

export function prepareServiceInvitationRole(
  db: Database,
  input: Readonly<{
    organisationId: string;
    invitationId: string;
    role: string;
    invitedBy: string;
    createdAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO account_service_invitation_role " +
        "(native_organisation_id, platform_invitation_id, role, invited_by_native_user_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(
      input.organisationId,
      input.invitationId,
      input.role,
      input.invitedBy,
      input.createdAt,
    );
}
