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

/**
 * Marks the invitation accepted, once the batch has made the member with
 * this membership and this acceptance receipt.
 */
export function prepareServiceInvitationAcceptance(
  db: Database,
  input: Readonly<{
    organisationId: string;
    invitationId: string;
    userId: string;
    membershipId: string;
    acceptanceReceiptId: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE account_service_invitation_role SET accepted_at = ?, accepted_native_user_id = ?
       WHERE native_organisation_id = ? AND platform_invitation_id = ? AND accepted_at IS NULL
         AND EXISTS (SELECT 1 FROM service_role_grant g
           JOIN organisation_onboarding o ON o.organisation_id = g.organisation_id
           WHERE g.organisation_id = account_service_invitation_role.native_organisation_id
             AND g.user_id = ? AND g.status = 'active' AND g.platform_membership_id = ?
             AND g.account_acceptance_receipt_id = ?
             AND o.lifecycle NOT IN ('activating', 'archived'))`,
    )
    .bind(
      input.now,
      input.userId,
      input.organisationId,
      input.invitationId,
      input.userId,
      input.membershipId,
      input.acceptanceReceiptId,
    );
}
