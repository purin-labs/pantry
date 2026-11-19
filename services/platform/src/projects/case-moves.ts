import {
  isCaseOriginKind,
  isConversationId,
  isProjectId,
  type CaseProjectCommand,
  type CaseProjectResult,
  type CaseProjectView,
  type ConversationId,
  type ProjectCaseEntry,
  type ProjectId,
} from "@purin-labs/control-api";
import { canonicalJson, isPositiveInteger, sha256Hex } from "@purin-labs/std";
import { holdsAdmittedWork } from "../chat/conversation";
import { authorizeConversation } from "../chat/conversation-access";
import {
  readConversationStatus,
  reconcileRevokedConversationRun,
} from "../chat/store";
import type { CaseId, UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { authorizeProject, type ProjectAccessScope } from "./access";
import { readDefaultProjectId } from "./case-project";
import type { Variant } from "@purin-labs/type-utils";

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

const RECEIPT_OPEN = `EXISTS (SELECT 1 FROM project_operation o
  WHERE o.organisation_id = ? AND o.actor_user_id = ? AND o.operation_id = ?
    AND o.command_digest = ? AND o.applied = 0) AND ${ACTIVE_PLACEMENT}`;

type Rejection = Variant<CaseProjectResult, "rejected">["code"];

type StoredCasePlacement = CaseProjectView &
  Readonly<{ filedAt: number; conversationId: ConversationId | null }>;

// The caller is an administrator of the Organisation: the route requires it.
// That is the authority over a Case its source admitted. A Case that a chat
// presents is read under that chat's own access instead.
export async function readCaseProject(
  execution: OrganisationExecutionScope,
  scope: ProjectAccessScope,
  caseId: CaseId,
): Promise<CaseProjectView | null> {
  const stored = await readStoredPlacement(execution, caseId);
  if (stored === null) return null;
  if (
    stored.conversationId !== null &&
    (await authorizeConversation(
      execution.database,
      scope,
      stored.conversationId,
    )) === null
  )
    return null;
  return casePlacementView(stored);
}

// Files a Case in another Project. The Case, its Actor and its source binding
// stay the same; only the association and its revision change. A move grants
// the handling agent nothing.
export async function moveCase(
  execution: OrganisationExecutionScope,
  userId: UserId,
  caseId: CaseId,
  command: CaseProjectCommand,
  now: number,
): Promise<CaseProjectResult> {
  const db = execution.database;
  const scope: ProjectAccessScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive())) return rejected("case_project_conflict");
  const digest = await sha256Hex(canonicalJson({ caseId, command }));
  const replay = await readReceipt(
    execution,
    scope,
    command.operationId,
    digest,
  );
  if (replay !== null) return replay;
  const stored = await readStoredPlacement(execution, caseId);
  if (stored === null) return rejected("case_not_found");
  const destination = await authorizeProject(
    db,
    scope,
    command.projectId,
    "read",
  );
  const toDefault =
    (await readDefaultProjectId(db, scope.organisationId)) ===
    command.projectId;
  // What the actor must hold over the Case, checked again in the statement
  // that accepts the move.
  let holds: Readonly<{ sql: string; bindings: readonly (string | number)[] }>;
  if (stored.conversationId === null) {
    // A Case its source admitted moves into a shared Project its mover may
    // edit, or back to the default. A personal Project would hide it.
    if (
      !toDefault &&
      (destination === null ||
        destination.access.kind !== "shared" ||
        destination.access.role === "viewer")
    )
      return rejected("case_destination_unavailable");
    holds = {
      sql: `NOT EXISTS (SELECT 1 FROM portal_conversation c
          WHERE c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id)`,
      bindings: [],
    };
  } else {
    await reconcileRevokedConversationRun(
      execution,
      userId,
      stored.conversationId,
    );
    const chat = await authorizeConversation(db, scope, stored.conversationId);
    if (chat === null) return rejected("case_not_found");
    // A canvas chat belongs to its document and stays where it was filed.
    if (chat.access.kind === "workspace_canvas")
      return rejected("case_destination_unavailable");
    // Moving a shared chat changes who reads it. That takes the sharing
    // command and its disclosure review.
    if (chat.access.kind === "shared")
      return rejected("case_move_requires_audience_review");
    if (chat.execution.kind === "active") return rejected("case_running");
    const status = await readConversationStatus(
      db,
      scope,
      stored.conversationId,
    );
    if (status === null) return rejected("case_not_found");
    if (holdsAdmittedWork(status.work, status.queuedInputs))
      return rejected("case_work_unfinished");
    if (!toDefault && destination === null)
      return rejected("case_destination_unavailable");
    // The chat's revision fences the state read above: a turn that fails or
    // a message queued since then refuses the move as a conflict.
    holds = {
      sql: `EXISTS (SELECT 1 FROM portal_conversation c
          WHERE c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
            AND c.access_kind = 'private' AND c.user_id = ? AND c.active_user_id IS NULL
            AND c.revision = ?)`,
      bindings: [userId, status.revision],
    };
  }
  if (stored.revision !== command.expectedRevision)
    return rejected("case_project_conflict");
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  const open = [
    scope.organisationId,
    scope.userId,
    command.operationId,
    digest,
    ...fence,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO project_operation
           (organisation_id, actor_user_id, operation_id, command_digest, project_id, case_id, result_revision, accepted_at)
         SELECT cp.organisation_id, ?, ?, ?, p.project_id, cp.case_id, cp.revision + 1, ?
         FROM case_project cp
         JOIN project p ON p.organisation_id = cp.organisation_id AND p.project_id = ?
         JOIN service_role_grant tm ON tm.organisation_id = cp.organisation_id
           AND tm.user_id = ? AND tm.status = 'active'
         WHERE cp.organisation_id = ? AND cp.case_id = ? AND cp.revision = ?
           AND ${holds.sql}
           AND (EXISTS (SELECT 1 FROM organisation_default_project d
               WHERE d.organisation_id = p.organisation_id AND d.project_id = p.project_id)
             OR (p.access_revision = ? AND ((p.access_kind = 'personal' AND p.user_id = tm.user_id)
               OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.organisation_id = p.organisation_id
                 AND pm.project_id = p.project_id AND pm.user_id = tm.user_id))))
           AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.userId,
        command.operationId,
        digest,
        now,
        command.projectId,
        scope.userId,
        scope.organisationId,
        caseId,
        command.expectedRevision,
        ...holds.bindings,
        destination?.access.accessRevision ?? 0,
        ...fence,
      ),
    db
      .prepare(
        `UPDATE case_project SET project_id = ?, revision = revision + 1, updated_at = ?
         WHERE organisation_id = ? AND case_id = ? AND ${RECEIPT_OPEN}`,
      )
      .bind(command.projectId, now, scope.organisationId, caseId, ...open),
    // A chat's readers fetch it again under its new Project.
    db
      .prepare(
        `UPDATE portal_conversation SET revision = revision + 1
         WHERE organisation_id = ? AND case_id = ? AND ${RECEIPT_OPEN}`,
      )
      .bind(scope.organisationId, caseId, ...open),
    db
      .prepare(
        `INSERT OR IGNORE INTO portal_chat_directory (organisation_id, user_id, revision)
         SELECT ?, ?, 0 WHERE ${RECEIPT_OPEN}`,
      )
      .bind(scope.organisationId, scope.userId, ...open),
    db
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1
         WHERE organisation_id = ? AND ${RECEIPT_OPEN}`,
      )
      .bind(scope.organisationId, ...open),
    db
      .prepare(
        `UPDATE project_operation SET applied = 1
         WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ?
           AND command_digest = ? AND applied = 0 AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        scope.userId,
        command.operationId,
        digest,
        ...fence,
      ),
  ]);
  return (
    (await readReceipt(execution, scope, command.operationId, digest)) ??
    rejected("case_project_conflict")
  );
}

// The Cases filed in a Project that this reader may know of: the chats they
// can open and, as an administrator, the Cases a source admitted. Another
// member's private chat is absent, from the list and from its length.
export async function listProjectCases(
  execution: OrganisationExecutionScope,
  scope: ProjectAccessScope,
  projectId: ProjectId,
): Promise<readonly ProjectCaseEntry[] | null> {
  const db = execution.database;
  if ((await authorizeProject(db, scope, projectId, "read")) === null)
    return null;
  const rows = await db
    .prepare(
      `SELECT cp.case_id, cp.project_id, cp.revision, cp.origin_kind, cp.updated_at,
         c.conversation_id, c.access_kind, c.user_id
       FROM case_project cp
       LEFT JOIN portal_conversation c ON c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
       WHERE cp.organisation_id = ? AND cp.project_id = ?
         AND (c.conversation_id IS NULL
           OR (c.access_kind = 'private' AND c.user_id = ?)
           OR c.access_kind = 'shared')
         AND NOT EXISTS (SELECT 1 FROM portal_chat_deletion x
           WHERE x.organisation_id = cp.organisation_id AND x.conversation_id = c.conversation_id)
       ORDER BY cp.updated_at DESC, cp.case_id
       LIMIT 200`,
    )
    .bind(scope.organisationId, projectId, scope.userId)
    .all<Record<string, unknown>>();
  const entries: ProjectCaseEntry[] = [];
  for (const row of rows.results) entries.push(parsePlacementRow(row));
  // Recheck after the query so a concurrent revocation cannot return the list.
  return (await authorizeProject(db, scope, projectId, "read")) === null
    ? null
    : entries;
}

async function readStoredPlacement(
  execution: OrganisationExecutionScope,
  caseId: CaseId,
): Promise<StoredCasePlacement | null> {
  const row = await execution.database
    .prepare(
      `SELECT cp.case_id, cp.project_id, cp.revision, cp.origin_kind, cp.updated_at,
         c.conversation_id
       FROM case_project cp
       LEFT JOIN portal_conversation c ON c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
       WHERE cp.organisation_id = ? AND cp.case_id = ?`,
    )
    .bind(execution.organisationId, caseId)
    .first<Record<string, unknown>>();
  return row === null ? null : parsePlacementRow(row);
}

function parsePlacementRow(row: Record<string, unknown>): StoredCasePlacement {
  if (
    typeof row.case_id !== "string" ||
    !isProjectId(row.project_id) ||
    !isPositiveInteger(row.revision) ||
    !isCaseOriginKind(row.origin_kind) ||
    typeof row.updated_at !== "number" ||
    (row.conversation_id !== null && !isConversationId(row.conversation_id))
  )
    throw new Error("case_project_storage_invalid");
  return {
    caseId: row.case_id,
    projectId: row.project_id,
    revision: row.revision,
    origin: row.origin_kind,
    filedAt: row.updated_at,
    conversationId: row.conversation_id,
  };
}

function casePlacementView(stored: StoredCasePlacement): CaseProjectView {
  return {
    caseId: stored.caseId,
    projectId: stored.projectId,
    revision: stored.revision,
    origin: stored.origin,
  };
}

async function readReceipt(
  execution: OrganisationExecutionScope,
  scope: ProjectAccessScope,
  operationId: string,
  digest: string,
): Promise<CaseProjectResult | null> {
  const row = await execution.database
    .prepare(
      `SELECT command_digest, case_id FROM project_operation
       WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ? AND applied = 1`,
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first<{ command_digest: unknown; case_id: unknown }>();
  if (row === null) return null;
  if (row.command_digest !== digest || typeof row.case_id !== "string")
    return rejected("case_operation_conflict");
  // The receipt answers that the move was accepted. Where the Case is now is
  // read live: it may have moved again since.
  const current = await execution.database
    .prepare(
      `SELECT cp.case_id, cp.project_id, cp.revision, cp.origin_kind, cp.updated_at, NULL AS conversation_id
       FROM case_project cp WHERE cp.organisation_id = ? AND cp.case_id = ?`,
    )
    .bind(scope.organisationId, row.case_id)
    .first<Record<string, unknown>>();
  if (current === null) return rejected("case_not_found");
  return {
    kind: "accepted",
    placement: casePlacementView(parsePlacementRow(current)),
    agentProjectContext: "none",
  };
}

function rejected(code: Rejection): Variant<CaseProjectResult, "rejected"> {
  return { kind: "rejected", code };
}
