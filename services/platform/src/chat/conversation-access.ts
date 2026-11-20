import type { OrganisationDatabase } from "../database-handles";
import {
  isProjectId,
  isUserId,
  isConversationId,
  isProjectRole,
  type ChatConversationAccess,
  type ProjectRole,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import { isNonNegativeInteger } from "@purin-labs/std";
import type { ConversationScope } from "./store";
import { parseConversationActorIdentity } from "./conversation-actor-identity";
import { parseCaseId, type CaseId } from "../ids";
import { authorizeProject } from "../projects/access";
import type { NativeChatSourceAccess } from "../policy/information-flow/source-labels";

export type AuthorizedConversation = Readonly<{
  creatorUserId: UserId;
  access: ChatConversationAccess;
  role: ProjectRole;
  accessRevision: number;
  execution:
    | Readonly<{ kind: "idle"; userId?: never }>
    | Readonly<{ kind: "active"; userId: UserId }>;
}>;

// A chat inherits from its Project only when the requester can read that Project.
// A canvas chat belongs to its document's audience and inherits from none.
const PROJECT_READABLE_SQL = `(c.access_kind <> 'workspace_canvas'
      AND ((p.access_kind = 'personal' AND p.user_id = r.user_id) OR pm.user_id IS NOT NULL))`;

// Bind organisation and requesting user once. Directory rows personalize an authorized transcript.
// A chat's Project and its revision are read from its Case's association.
export const VISIBLE_CONVERSATIONS_SQL = visibleConversationsSql(
  "SELECT ? AS organisation_id, ? AS user_id",
);

/**
 * The conversations that each row of `requesterSql` may see. The rows have
 * the columns `organisation_id` and `user_id`; with several requesters, the
 * result has one row for each requester and conversation, and
 * `requesterColumn` names the requester of each row (`requester_user_id`).
 */
export function visibleConversationsSql(
  requesterSql: string,
  options: Readonly<{ requesterColumn?: boolean }> = {},
): string {
  return `WITH requester AS (
  ${requesterSql}
), visible_conversation AS (
  SELECT c.*,${options.requesterColumn === true ? " r.user_id AS requester_user_id," : ""} json_extract(c.state_json, '$.actorIdentity') AS actor_identity,
    cp.project_id AS project_id, cp.revision AS membership_revision,
    ${PROJECT_READABLE_SQL} AS project_readable,
    CASE WHEN c.access_kind = 'workspace_canvas' THEN CASE WHEN tm.role = 'viewer' THEN 'viewer' ELSE 'editor' END ELSE pm.role END AS member_role,
    CASE WHEN ${PROJECT_READABLE_SQL} THEN p.access_revision ELSE 0 END AS access_revision,
    COALESCE(u.lifecycle, 'active') AS lifecycle, u.pinned_at, u.archived_at,
    COALESCE(u.manual_position, 0) AS manual_position,
    COALESCE(u.last_read_sequence, 0) AS last_read_sequence,
    COALESCE(u.draft_text, '') AS draft_text, u.draft_updated_at
  FROM portal_conversation c
  JOIN requester r ON r.organisation_id = c.organisation_id
  JOIN organisation t ON t.organisation_id = c.organisation_id AND t.status = 'active'
  JOIN service_role_grant tm ON tm.organisation_id = c.organisation_id AND tm.user_id = r.user_id AND tm.status = 'active'
  JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
  JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id
  LEFT JOIN project_member pm ON pm.organisation_id = c.organisation_id AND pm.project_id = cp.project_id AND pm.user_id = r.user_id
  LEFT JOIN portal_conversation_user u ON u.organisation_id = c.organisation_id AND u.user_id = r.user_id AND u.conversation_id = c.conversation_id
  WHERE ((c.access_kind = 'workspace_canvas') OR (c.access_kind = 'private' AND c.user_id = r.user_id)
    OR (c.access_kind = 'shared' AND p.access_kind = 'shared' AND pm.user_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM portal_chat_deletion d WHERE d.organisation_id = c.organisation_id AND d.conversation_id = c.conversation_id)
)`;
}

export async function authorizeConversation(
  db: OrganisationDatabase,
  scope: ConversationScope,
  conversationId: ConversationId,
): Promise<AuthorizedConversation | null> {
  const row = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT user_id, access_kind, canvas_document_id, project_id, member_role, access_revision, active_user_id
    FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{
      user_id: unknown;
      access_kind: unknown;
      canvas_document_id: unknown;
      project_id: unknown;
      member_role: unknown;
      access_revision: unknown;
      active_user_id: unknown;
    }>();
  if (row === null) return null;
  if (!isUserId(row.user_id) || !isNonNegativeInteger(row.access_revision))
    throw new Error("chat_access_storage_invalid");
  let access: ChatConversationAccess;
  let role: ProjectRole;
  if (
    row.access_kind === "workspace_canvas" &&
    typeof row.canvas_document_id === "string" &&
    isProjectRole(row.member_role)
  ) {
    access = { kind: "workspace_canvas", documentId: row.canvas_document_id };
    role = row.member_role;
  } else if (row.access_kind === "private") {
    access = { kind: "private", ownerUserId: row.user_id };
    role = "owner";
  } else if (
    row.access_kind === "shared" &&
    isProjectId(row.project_id) &&
    isProjectRole(row.member_role)
  ) {
    access = { kind: "shared", sharedProjectId: row.project_id };
    role = row.member_role;
  } else throw new Error("chat_access_storage_invalid");
  const execution =
    row.active_user_id === null
      ? { kind: "idle" as const }
      : isUserId(row.active_user_id)
        ? { kind: "active" as const, userId: row.active_user_id }
        : null;
  if (execution === null) throw new Error("chat_execution_storage_invalid");
  return {
    creatorUserId: row.user_id,
    access,
    role,
    accessRevision: row.access_revision,
    execution,
  };
}

/** Resolve only a currently visible chat's persisted Case association. */
export async function readConversationCaseId(
  db: OrganisationDatabase,
  scope: ConversationScope,
  conversationId: ConversationId,
): Promise<CaseId | null> {
  const row = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
     SELECT case_id FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{ case_id: unknown }>();
  if (row === null || typeof row.case_id !== "string") return null;
  const parsed = parseCaseId(row.case_id);
  return parsed.ok ? parsed.value : null;
}

export async function currentCanvasConversation(
  db: OrganisationDatabase,
  scope: ConversationScope,
  documentId: string,
): Promise<ConversationId | null> {
  const row = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT conversation_id FROM visible_conversation WHERE access_kind = 'workspace_canvas'
      AND canvas_document_id = ? ORDER BY canvas_generation DESC LIMIT 1`,
    )
    .bind(scope.organisationId, scope.userId, documentId)
    .first<{ conversation_id: unknown }>();
  if (row === null) return null;
  if (!isConversationId(row.conversation_id))
    throw new Error("canvas_chat_storage_invalid");
  return row.conversation_id;
}

export async function conversationCaseIdentity(
  db: OrganisationDatabase,
  scope: ConversationScope,
  conversationId: ConversationId,
): Promise<string> {
  const row = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT actor_identity FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{ actor_identity: unknown }>();
  if (row === null) throw new Error("chat_not_found");
  return parseConversationActorIdentity(
    row.actor_identity,
    scope.organisationId,
  );
}

/** The access checks that the label of a native chat source asks for. */
export const NATIVE_CHAT_SOURCE_ACCESS: NativeChatSourceAccess = {
  authorizeProject,
  authorizeConversation,
};
