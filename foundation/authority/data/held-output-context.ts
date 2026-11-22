// What the held output page shows about where a request came from and went.

type Database = Pick<D1Database, "prepare">;

/** The Portal conversation of the session, or null. */
export async function readSessionConversationId(
  db: Database,
  organisationId: string,
  sessionId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT conversation_id AS conversationId FROM session_turn_access
       WHERE organisation_id = ? AND session_id = ?
         AND origin_kind = 'conversation_session'
       LIMIT 1`,
    )
    .bind(organisationId, sessionId)
    .first<{ conversationId: unknown }>();
  return typeof row?.conversationId === "string" ? row.conversationId : null;
}

/** The resource's label in the newest discovery, or null. */
export async function readDiscoveredResourceLabel(
  db: Database,
  organisationId: string,
  providerResourceId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT r.display_label AS label
       FROM provider_discovered_resource r
       JOIN provider_resource_snapshot s ON s.snapshot_revision = r.snapshot_revision
       WHERE s.organisation_id = ? AND r.provider_resource_id = ?
       ORDER BY s.created_at DESC
       LIMIT 1`,
    )
    .bind(organisationId, providerResourceId)
    .first<{ label: unknown }>();
  return typeof row?.label === "string" && row.label.length > 0
    ? row.label
    : null;
}
