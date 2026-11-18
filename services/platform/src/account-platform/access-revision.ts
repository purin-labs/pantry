import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId, UserId } from "../ids";
import type { Result } from "../result";
import { prepareReturnPrivateChatsToDefault } from "../projects/case-project";
import { prepareProjectMembershipRevocation } from "../projects/default-project";
import type { AccountEligibilityFailure } from "./access";

export type NativeAccountAccessFence = Readonly<{
  placementEpoch: number;
  placementCellId: string;
  fenceToken: string;
}>;

/** A later account grant cannot revive native project access retained from an earlier grant. */
type AccountAccessRevisionInput = Readonly<{
  database: OrganisationDatabase;
  organisationId: OrganisationId;
  userId: UserId;
  accessRevision: number;
  fence: NativeAccountAccessFence;
}>;

export function prepareAccountAccessRevisionAcknowledgement(
  input: AccountAccessRevisionInput,
  now: number,
): D1PreparedStatement[] {
  const guard = {
    sql: "EXISTS (SELECT 1 FROM account_service_access_revision WHERE native_organisation_id = ? AND native_user_id = ? AND access_revision = ? AND cleanup_pending = 1)",
    bindings: [input.organisationId, input.userId, input.accessRevision],
  };
  return [
    input.database
      .prepare(
        `INSERT INTO account_service_access_revision
          (native_organisation_id, native_user_id, access_revision, cleanup_pending, updated_at)
         SELECT m.organisation_id, m.user_id, ?, CASE WHEN ? = 1 THEN 0 ELSE 1 END, ?
         FROM service_role_grant m JOIN organisation_placement p ON p.organisation_id = m.organisation_id
         WHERE m.organisation_id = ? AND m.user_id = ? AND m.status = 'active'
           AND p.status = 'active' AND p.placement_epoch = ? AND p.placement_cell_id = ? AND p.fence_token = ?
         ON CONFLICT(native_organisation_id, native_user_id) DO UPDATE SET
           access_revision = excluded.access_revision, cleanup_pending = 1, updated_at = excluded.updated_at
         WHERE excluded.access_revision > account_service_access_revision.access_revision`,
      )
      .bind(
        input.accessRevision,
        input.accessRevision,
        now,
        input.organisationId,
        input.userId,
        input.fence.placementEpoch,
        input.fence.placementCellId,
        input.fence.fenceToken,
      ),
    ...prepareReturnPrivateChatsToDefault(input.database, {
      organisationId: input.organisationId,
      sourceProjectId: null,
      ownerUserId: input.userId,
      now,
      guard,
    }),
    ...prepareProjectMembershipRevocation(input.database, {
      organisationId: input.organisationId,
      userId: input.userId,
      now,
      guard,
    }),
    input.database
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1
         WHERE organisation_id = ? AND ${guard.sql}`,
      )
      .bind(input.organisationId, ...guard.bindings),
    input.database
      .prepare(
        `UPDATE account_service_access_revision SET cleanup_pending = 0
         WHERE native_organisation_id = ? AND native_user_id = ? AND access_revision = ? AND cleanup_pending = 1`,
      )
      .bind(input.organisationId, input.userId, input.accessRevision),
  ];
}

export async function acknowledgeAccountAccessRevision(
  input: AccountAccessRevisionInput,
): Promise<Result<void, AccountEligibilityFailure>> {
  try {
    // The read is the last statement of the batch, so it follows the writes
    // in one transaction and costs no second round trip. It reads the fence
    // apart from the revision: a placement that froze or moved since this
    // scope was admitted leaves the decision to the next placement, and a
    // missing revision under the current fence means the person lost access.
    const results = await input.database.batch<{
      fenceCurrent: unknown;
      accessRevision: unknown;
    }>([
      ...prepareAccountAccessRevisionAcknowledgement(input, Date.now()),
      input.database
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM organisation_placement p
         WHERE p.organisation_id = ? AND p.status = 'active'
           AND p.placement_epoch = ? AND p.placement_cell_id = ? AND p.fence_token = ?) AS fenceCurrent,
       (SELECT a.access_revision FROM account_service_access_revision a
         JOIN service_role_grant g ON g.organisation_id = a.native_organisation_id
           AND g.user_id = a.native_user_id AND g.status = 'active'
         WHERE a.native_organisation_id = ? AND a.native_user_id = ? AND a.cleanup_pending = 0) AS accessRevision`,
        )
        .bind(
          input.organisationId,
          input.fence.placementEpoch,
          input.fence.placementCellId,
          input.fence.fenceToken,
          input.organisationId,
          input.userId,
        ),
    ]);
    const acknowledged = results.at(-1)?.results[0];
    if (acknowledged?.fenceCurrent !== 1)
      return { ok: false, error: { code: "authority_unavailable" } };
    return acknowledged.accessRevision === input.accessRevision
      ? { ok: true, value: undefined }
      : { ok: false, error: { code: "membership_ineligible" } };
  } catch {
    return { ok: false, error: { code: "authority_unavailable" } };
  }
}
