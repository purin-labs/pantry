import { parseUserId } from "@purin-labs/control-api/ids";
import type {
  SlackIdentityLinks,
  SlackLinkedMember,
} from "@purin-labs/conversation/actors/action-mutation-execution";

// The reads of the Slack identity links that the conversation module makes
// (Refactor 17). The Worker registers them (`worker-ports.ts`). Each one is
// one D1 read and writes nothing.

/**
 * The member behind a Slack user, right now: a verified link to their Pantry
 * user in the Slack workspace of an active Slack account, and an active
 * membership. Null when there is none. Each caller checks the role that its
 * action needs.
 */
export const resolveSlackLinkedMember: SlackIdentityLinks["resolveLinkedMember"] =
  async (db, input): Promise<SlackLinkedMember | null> => {
    const row = await db
      .prepare(
        `SELECT identity_link.user_id AS userId, membership.person_id AS personId,
              membership.role AS role
       FROM integration_account AS account
       JOIN external_identity_link AS identity_link
         ON identity_link.organisation_id = account.organisation_id
        AND identity_link.workspace_connection_id = account.provider_connection_id
        AND identity_link.workspace_id = ? AND identity_link.external_user_id = ?
       JOIN service_role_grant AS membership
         ON membership.organisation_id = identity_link.organisation_id
        AND membership.user_id = identity_link.user_id AND membership.status = 'active'
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND account.provider = 'slack' AND account.lifecycle = 'active'`,
      )
      .bind(
        input.workspaceId,
        input.slackUserId,
        input.organisationId,
        input.integrationAccountId,
      )
      .first<{
        readonly userId: unknown;
        readonly personId: unknown;
        readonly role: unknown;
      }>();
    if (
      row === null ||
      typeof row.personId !== "string" ||
      typeof row.userId !== "string" ||
      (row.role !== "owner" &&
        row.role !== "admin" &&
        row.role !== "operator" &&
        row.role !== "viewer")
    )
      return null;
    const userId = parseUserId(row.userId);
    return userId.ok
      ? { userId: userId.value, personId: row.personId, role: row.role }
      : null;
  };

export const SLACK_IDENTITY_LINKS: SlackIdentityLinks = {
  resolveLinkedMember: resolveSlackLinkedMember,
  async linkedSlackUserIds(db, organisationId, userId) {
    const links = await db
      .prepare(
        `SELECT external_user_id FROM external_identity_link
       WHERE organisation_id = ? AND user_id = ?`,
      )
      .bind(organisationId, userId)
      .all<{ external_user_id: string }>();
    return links.results.map((link) => link.external_user_id);
  },
};
