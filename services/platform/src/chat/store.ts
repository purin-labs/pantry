import { chatOriginField, conversationOrigin } from "./origin";
import type { OrganisationDatabase } from "../database-handles";
import type { ConversationExecution } from "./execution";
import {
  chatThreadActivity,
  type ChatThreadActivity,
} from "@purin-labs/control-api";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isProjectRole, type ProjectRole } from "@purin-labs/control-api";
import { VISIBLE_CONVERSATIONS_SQL } from "./conversation-access";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
  parseConversationActorIdentity,
} from "./conversation-actor-identity";
import { prepareMemberCaseProject } from "../projects/case-project";
import { isConversationId } from "@purin-labs/control-api";
import { isNonNegativeInteger } from "@purin-labs/std";
import type { ChatOrigin, ConversationId } from "@purin-labs/control-api";
import { signalChat } from "./signals";
import {
  PERMISSION_EXPIRED_MESSAGE,
  conversationTransition,
  expirePermissionWait,
} from "./conversation-machine";
import { conversationProjectSnapshots } from "./project-context-binding";
import type { D1Database } from "@cloudflare/workers-types";
import type { UserId, OrganisationId } from "../ids";
import {
  latestPublicTimelineSequence,
  normalizeConversationTimeline,
  parseConversation,
  parseWork,
  type ConversationWork,
  type Conversation,
} from "./conversation";
import type {
  ActiveConversationMetadata,
  ArchivedConversationMetadata,
  ChatPlacement,
  ChatDestination,
} from "@purin-labs/control-api";
import {
  prepareChatDirectoryInitialization,
  parseConversationPlacement,
  type ConversationPlacementRow,
} from "./projects";

export type ConversationScope = {
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
};

export type ConversationMetadata =
  ActiveConversationMetadata | ArchivedConversationMetadata;

type ConversationSummary = Readonly<{
  id: ConversationId;
  title: string;
  revision: number;
  latestSequence: number;
  lastReadSequence: number;
  activity: ChatThreadActivity;
  placement: ChatPlacement;
  updatedAt: number;
  sharing: ConversationSharing;
  /** The chat that proposed this side Case (Plan 74); null for any other chat. */
  parentConversationId: ConversationId | null;
  /** Where the chat started (Plan 87); null when its first message carried no page. */
  origin: ChatOrigin | null;
}> &
  ConversationMetadata;

export type ChatDirectoryCursors = Readonly<{
  active: { id: string; lastActivityAt: number } | null;
  archived: { id: string; archivedAt: number } | null;
}>;
type ConversationDirectory = Readonly<{
  nextActiveCursor: string | null;
  nextArchivedCursor: string | null;
  active: readonly (Readonly<
    Pick<
      ConversationSummary,
      | "id"
      | "title"
      | "revision"
      | "latestSequence"
      | "lastReadSequence"
      | "activity"
      | "placement"
      | "updatedAt"
      | "sharing"
      | "parentConversationId"
      | "origin"
    >
  > &
    ActiveConversationMetadata)[];
  archived: readonly (Readonly<
    Pick<
      ConversationSummary,
      | "id"
      | "title"
      | "revision"
      | "latestSequence"
      | "lastReadSequence"
      | "activity"
      | "placement"
      | "updatedAt"
      | "sharing"
      | "parentConversationId"
      | "origin"
    >
  > &
    ArchivedConversationMetadata)[];
}>;

type ConversationSharing = Readonly<{
  visibility: "private" | "shared";
  role: ProjectRole;
}>;

export type StoredConversation = {
  readonly actorIdentity: string;
  readonly sharing: ConversationSharing;
  readonly revision: number;
  readonly conversation: Conversation;
  readonly metadata: ConversationMetadata;
  readonly placement: ChatPlacement;
  // Whether the reader takes context from the chat's Project: only under their
  // own access to it, and never for a canvas chat.
  readonly inheritsProject: boolean;
};

export type ConversationMetadataAction =
  | { readonly kind: "pin" }
  | { readonly kind: "unpin" }
  | { readonly kind: "archive"; readonly expectedRevision: number }
  | { readonly kind: "restore"; readonly expectedRevision: number };

type ConversationMetadataUpdate =
  | { readonly ok: true; readonly summary: ConversationSummary }
  | {
      readonly ok: false;
      readonly code:
        | "chat_not_found"
        | "chat_archived"
        | "chat_running"
        | "chat_metadata_conflict";
    };

type ConversationDraftUpdate =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly draft: string;
      readonly updatedAt: number | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | "chat_not_found"
        | "chat_archived"
        | "chat_revision_conflict"
        | "chat_capacity_reached"
        | "chat_draft_invalid";
      readonly serverDraft?: string;
      readonly serverRevision?: number;
      readonly serverUpdatedAt?: number | null;
    };

type ConversationReadUpdate =
  | {
      readonly ok: true;
      readonly latestSequence: number;
      readonly lastReadSequence: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "chat_not_found"
        | "chat_read_invalid"
        | "chat_revision_conflict"
        | "chat_capacity_reached";
    };

type ConversationRenameUpdate =
  | { readonly ok: true; readonly summary: ConversationSummary }
  | {
      readonly ok: false;
      readonly code:
        | "chat_not_found"
        | "chat_title_invalid"
        | "chat_revision_conflict"
        | "chat_capacity_reached";
    };

type StoredConversationRow = ConversationPlacementRow & {
  readonly actor_identity: unknown;
  readonly project_readable: unknown;
  readonly revision: unknown;
  readonly access_kind: unknown;
  readonly member_role: unknown;
  readonly state_json: unknown;
  readonly lifecycle: unknown;
  readonly pinned_at: unknown;
  readonly archived_at: unknown;
  readonly state_format: unknown;
  readonly title_normalized: unknown;
  readonly last_activity_at: unknown;
  readonly latest_sequence: unknown;
  readonly last_read_sequence: unknown;
  readonly draft_text: unknown;
  readonly draft_updated_at: unknown;
};

type ConversationSummaryRow = ConversationPlacementRow & {
  readonly updated_at: unknown;
  readonly last_activity_at: unknown;
  readonly id: unknown;
  readonly title: unknown;
  readonly revision: unknown;
  readonly lifecycle: unknown;
  readonly pinned_at: unknown;
  readonly archived_at: unknown;
  readonly latest_sequence: unknown;
  readonly last_read_sequence: unknown;
  readonly access_kind: unknown;
  readonly member_role: unknown;
  readonly state_json: unknown;
};

export async function readConversation(
  db: D1Database,
  scope: ConversationScope,
  id: string,
): Promise<StoredConversation | null> {
  const row = await prepareConversationRead(db, scope, id)
    .first<StoredConversationRow>();
  return parseStoredConversationRow(scope, row);
}

function prepareConversationRead(
  db: D1Database,
  scope: ConversationScope,
  id: string,
): D1PreparedStatement {
  return db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT * FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, id);
}

function parseStoredConversationRow(
  scope: ConversationScope,
  row: StoredConversationRow | null,
): StoredConversation | null {
  if (row === null) return null;
  if (
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    typeof row.state_json !== "string" ||
    (row.state_format !== undefined &&
      row.state_format !== null &&
      (typeof row.state_format !== "number" ||
        !Number.isSafeInteger(row.state_format)))
  )
    throw new Error("conversation_storage_invalid");
  return {
    actorIdentity: parseConversationActorIdentity(
      row.actor_identity,
      scope.organisationId,
    ),
    revision: row.revision,
    sharing: parseConversationSharing(row),
    // A permission wait past its 24 hours reads as the failure it is
    // (Refactor 15, refactor 9).
    conversation: expirePermissionWait(
      personalizeConversation(
        parseConversation(JSON.parse(row.state_json)),
        row,
      ),
      Date.now(),
    ),
    metadata: parseConversationMetadata(row),
    placement: parseConversationPlacement(row),
    inheritsProject: row.project_readable === 1,
  };
}

export async function readConversationStatus(
  db: D1Database,
  scope: ConversationScope,
  conversationId: ConversationId,
): Promise<{
  readonly revision: number;
  readonly work: ConversationWork;
  readonly queuedInputs: number;
} | null> {
  const row = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT revision, json_extract(state_json, '$.work') AS work_json,
        json_array_length(json_extract(state_json, '$.pendingInputs')) AS queued_inputs
      FROM visible_conversation WHERE conversation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{ revision: unknown; work_json: unknown; queued_inputs: unknown }>();
  if (row === null) return null;
  if (
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    typeof row.work_json !== "string" ||
    !isNonNegativeInteger(row.queued_inputs)
  )
    throw new Error("conversation_status_invalid");
  const work = parseWork(JSON.parse(row.work_json));
  return {
    revision: row.revision,
    work:
      work.kind === "awaiting_permission" &&
      conversationTransition(work, "expire_permission", {
        now: Date.now(),
        modelRouteAvailable: true,
      }).allowed
        ? {
            kind: "failed",
            requestId: work.requestId,
            error: PERMISSION_EXPIRED_MESSAGE,
            recovery: null,
          }
        : work,
    queuedInputs: row.queued_inputs,
  };
}

type ConversationSaveOutcome =
  | { readonly kind: "saved" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "capacity";
      readonly bytes: number;
      readonly limit: number;
    };

// Terminal metadata must still fit when a completed answer exceeds the budget.
const CONVERSATION_PROJECTION_BYTES = 960_000;
const CONVERSATION_STORAGE_BYTES = 1_000_000;

export async function saveConversation(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversation: Conversation,
  revision: number,
  // Only a new chat reads this. Without one it joins the Organisation's default Project.
  initialDestination: ChatDestination | null = null,
): Promise<ConversationSaveOutcome> {
  const outcome = await writeConversation(
    execution,
    userId,
    conversation,
    revision,
    initialDestination,
  );
  if (outcome.kind === "saved")
    signalChat(execution, {
      kind: "conversation",
      conversationId: conversation.id,
    });
  return outcome;
}

async function writeConversation(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversation: Conversation,
  revision: number,
  initialDestination: ChatDestination | null,
): Promise<ConversationSaveOutcome> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  // Each write checks the captured placement fence in its SQL predicate.
  const normalized = normalizeConversationTimeline(conversation);
  const state = serializeConversation(normalized);
  const bytes = new TextEncoder().encode(state).byteLength;
  const limit =
    normalized.work.kind === "failed"
      ? CONVERSATION_STORAGE_BYTES
      : CONVERSATION_PROJECTION_BYTES;
  if (bytes > limit) return { kind: "capacity", bytes, limit };
  const now = Date.now();
  const activeUserId =
    normalized.work.kind === "ready" || normalized.work.kind === "failed"
      ? null
      : scope.userId;
  if (revision === 0) {
    const actorIdentity = initialConversationCaseIdentity(scope, normalized.id);
    const caseId = await conversationCaseId(actorIdentity);
    // The Project its first input was admitted under stays the chat's Project.
    // A fork carries its source's snapshots and starts in the default instead.
    const admitted =
      normalized.lineage.kind === "fork"
        ? undefined
        : conversationProjectSnapshots(normalized).at(-1);
    const destination =
      initialDestination?.projectId ?? admitted?.layer.projectId ?? null;
    const creatable = {
      sql: `NOT EXISTS (SELECT 1 FROM portal_chat_deletion WHERE organisation_id = ? AND conversation_id = ?)
          AND NOT EXISTS (SELECT 1 FROM portal_chat_fork WHERE organisation_id = ? AND user_id = ? AND destination_conversation_id = ? AND status NOT IN ('prepared', 'ready'))`,
      bindings: [
        scope.organisationId,
        normalized.id,
        scope.organisationId,
        scope.userId,
        normalized.id,
      ],
    };
    const [, , creation] = await db.batch([
      prepareChatDirectoryInitialization(execution, userId, 0),
      prepareMemberCaseProject(execution, {
        userId,
        caseId,
        origin: "portal_chat",
        projectId: destination,
        now,
        condition: creatable,
      }),
      db
        .prepare(
          `INSERT OR IGNORE INTO portal_conversation
        (organisation_id, user_id, conversation_id, case_id, revision, state_json, state_format, title_normalized, updated_at, last_activity_at, latest_sequence, active_user_id)
        SELECT ?, ?, ?, ?, 1, json_set(?, '$.actorIdentity', ?), 3, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM case_project cp WHERE cp.organisation_id = ? AND cp.case_id = ?
            AND (? IS NULL OR cp.project_id = ?))
          AND ${creatable.sql} AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
        )
        .bind(
          scope.organisationId,
          scope.userId,
          normalized.id,
          caseId,
          state,
          actorIdentity,
          normalizeConversationTitle(normalized.title),
          now,
          now,
          normalized.latestSequence,
          activeUserId,
          scope.organisationId,
          caseId,
          destination,
          destination,
          ...creatable.bindings,
          execution.organisationId,
          execution.placement.placementEpoch,
          execution.placement.placementCellId,
          execution.fenceToken,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO portal_conversation_user
        (organisation_id, user_id, conversation_id, manual_position, last_read_sequence, draft_text, draft_updated_at)
        SELECT c.organisation_id, c.user_id, c.conversation_id,
          COALESCE((SELECT MAX(u.manual_position) + 1 FROM portal_conversation_user u
            JOIN portal_conversation n ON n.organisation_id = u.organisation_id AND n.conversation_id = u.conversation_id
            JOIN case_project np ON np.organisation_id = n.organisation_id AND np.case_id = n.case_id
            WHERE u.organisation_id = c.organisation_id AND u.user_id = c.user_id AND np.project_id = cp.project_id), 0), ?, ?, ?
        FROM portal_conversation c
        JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
        WHERE c.organisation_id = ? AND c.user_id = ? AND c.conversation_id = ? AND changes() = 1`,
        )
        .bind(
          Math.min(normalized.lastReadSequence, normalized.latestSequence),
          normalized.draftText,
          normalized.draftUpdatedAt,
          scope.organisationId,
          scope.userId,
          normalized.id,
        ),
      db
        .prepare(
          "UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND user_id = ? AND changes() = 1",
        )
        .bind(scope.organisationId, scope.userId),
    ]);
    return creation?.meta.changes === 1
      ? { kind: "saved" }
      : { kind: "conflict" };
  }
  const result = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    UPDATE portal_conversation SET revision = revision + 1,
      state_json = json_set(?, '$.actorIdentity', json_extract(state_json, '$.actorIdentity')), state_format = 3,
      title_normalized = ?, updated_at = ?, last_activity_at = ?, latest_sequence = ?, active_user_id = ?
    WHERE organisation_id = ? AND conversation_id = ? AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM portal_conversation newer
        WHERE newer.organisation_id = portal_conversation.organisation_id
          AND newer.canvas_document_id = portal_conversation.canvas_document_id
          AND newer.canvas_generation > portal_conversation.canvas_generation)
      AND conversation_id IN (SELECT conversation_id FROM visible_conversation WHERE
        (access_kind = 'private' OR member_role IN ('owner', 'editor'))
        AND (active_user_id IS NULL OR active_user_id = ?))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) binding WHERE instr(state_json, json_extract(binding.value, '$.digest')) = 0
        AND (NOT EXISTS (SELECT 1 FROM case_project cp WHERE cp.organisation_id = portal_conversation.organisation_id
            AND cp.case_id = portal_conversation.case_id
            AND cp.revision = json_extract(binding.value, '$.layer.membershipRevision')
            AND cp.project_id = json_extract(binding.value, '$.layer.projectId'))
          OR (json_extract(binding.value, '$.layer.kind') = 'project' AND NOT EXISTS (
            SELECT 1 FROM project p JOIN service_role_grant tm ON tm.organisation_id = p.organisation_id AND tm.user_id = ? AND tm.status = 'active'
            WHERE p.organisation_id = portal_conversation.organisation_id AND p.project_id = json_extract(binding.value, '$.layer.projectId')
              AND p.content_revision = json_extract(binding.value, '$.layer.contentRevision')
              AND (p.user_id = tm.user_id OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.organisation_id = p.organisation_id AND pm.project_id = p.project_id AND pm.user_id = tm.user_id)))))) AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      state,
      normalizeConversationTitle(normalized.title),
      now,
      now,
      normalized.latestSequence,
      activeUserId,
      scope.organisationId,
      normalized.id,
      revision,
      scope.userId,
      JSON.stringify(conversationProjectSnapshots(normalized)),
      scope.userId,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    )
    .run();
  if (result.meta.changes !== 1) return { kind: "conflict" };
  return { kind: "saved" };
}

function serializeConversation(conversation: Conversation): string {
  const { lastReadSequence, draftText, draftUpdatedAt, ...accepted } =
    conversation;
  return JSON.stringify(accepted);
}

export async function reconcileRevokedConversationRun(
  execution: OrganisationExecutionScope,
  userId: UserId,
  id: ConversationId,
): Promise<void> {
  const result = await prepareRevokedRunReconciliation(execution, {
    kind: "reader",
    userId,
    id,
  }).run();
  if (result.meta.changes > 0)
    signalChat(execution, { kind: "conversation", conversationId: id });
}

/** The revoked run settles and the read follows it, in one round trip. */
export async function reconcileAndReadConversation(
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
  id: ConversationId,
): Promise<StoredConversation | null> {
  const [reconciled, current] =
    await execution.database.batch<StoredConversationRow>([
      prepareRevokedRunReconciliation(execution, {
        kind: "reader",
        userId: scope.userId,
        id,
      }),
      prepareConversationRead(execution.database, scope, id),
    ]);
  if (current === undefined) throw new Error("conversation_storage_invalid");
  if ((reconciled?.meta.changes ?? 0) > 0)
    signalChat(execution, { kind: "conversation", conversationId: id });
  return parseStoredConversationRow(scope, current.results[0] ?? null);
}

export async function readConversationForExecution(
  execution: OrganisationExecutionScope,
  pending: ConversationExecution,
): Promise<StoredConversation | null> {
  if (execution.organisationId !== pending.scope.organisationId) return null;
  const [reconciled, current] =
    await execution.database.batch<StoredConversationRow>([
      prepareRevokedRunReconciliation(execution, { kind: "actor", pending }),
      prepareConversationRead(
        execution.database,
        pending.scope,
        pending.conversationId,
      ),
    ]);
  if (current === undefined) throw new Error("conversation_storage_invalid");
  if ((reconciled?.meta.changes ?? 0) > 0)
    signalChat(execution, {
      kind: "conversation",
      conversationId: pending.conversationId,
    });
  return parseStoredConversationRow(pending.scope, current.results[0] ?? null);
}

type RevokedRunReconciliation =
  | {
      readonly kind: "reader";
      readonly userId: UserId;
      readonly id: ConversationId;
    }
  | { readonly kind: "actor"; readonly pending: ConversationExecution };

function prepareRevokedRunReconciliation(
  execution: OrganisationExecutionScope,
  authority: RevokedRunReconciliation,
): D1PreparedStatement {
  const userId =
    authority.kind === "reader"
      ? authority.userId
      : authority.pending.scope.userId;
  const id =
    authority.kind === "reader"
      ? authority.id
      : authority.pending.conversationId;
  // Actor recovery may discard its revoked contributor's unfinished projection.
  // Reader-triggered reconciliation still requires current conversation visibility.
  const visibility =
    authority.kind === "reader"
      ? "conversation_id IN (SELECT conversation_id FROM visible_conversation)"
      : "active_user_id = ?";
  const visibilityBindings = authority.kind === "reader" ? [] : [userId];
  const db = execution.database;
  // Discard unaccepted projections so the remaining members can still read accepted history.
  return db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    UPDATE portal_conversation SET active_user_id = NULL, revision = revision + 1,
    state_json = json_set(state_json, '$.work', json_object('kind', 'failed',
      'requestId', json_extract(state_json, '$.work.requestId'), 'error', 'Project access changed. The response was stopped.', 'recovery', NULL),
      '$.pendingInputs', json('[]'), '$.timeline', json(COALESCE((SELECT json_group_array(json(event.value))
        FROM json_each(portal_conversation.state_json, '$.timeline') event
        WHERE json_extract(event.value, '$.requestId') IS NOT json_extract(portal_conversation.state_json, '$.work.requestId')
          OR EXISTS (SELECT 1 FROM json_each(portal_conversation.state_json, '$.historyBindings') binding
            WHERE json_extract(binding.value, '$.requestId') = json_extract(event.value, '$.requestId'))), '[]')))
    WHERE organisation_id = ? AND conversation_id = ? AND active_user_id IS NOT NULL
      AND ${visibility}
      AND ${ACTIVE_CONVERSATION_PLACEMENT}
      AND (NOT EXISTS (SELECT 1 FROM service_role_grant tm WHERE tm.organisation_id = portal_conversation.organisation_id
        AND tm.user_id = active_user_id AND tm.status = 'active')
        OR (access_kind = 'shared' AND NOT EXISTS (SELECT 1 FROM project_member pm
          JOIN case_project cp ON cp.organisation_id = pm.organisation_id AND cp.project_id = pm.project_id
          WHERE pm.organisation_id = portal_conversation.organisation_id AND cp.case_id = portal_conversation.case_id
            AND pm.user_id = active_user_id AND pm.role IN ('owner', 'editor')))
        OR EXISTS (SELECT 1 FROM session_turn_access a WHERE a.organisation_id = portal_conversation.organisation_id
          AND a.conversation_id = portal_conversation.conversation_id AND a.turn_id = json_extract(state_json, '$.work.stream.turnId')
          AND a.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project p
            WHERE p.organisation_id = a.organisation_id AND p.project_id = a.project_id AND (p.user_id = active_user_id
              OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.organisation_id = p.organisation_id
                AND pm.project_id = p.project_id AND pm.user_id = active_user_id)))))`,
    )
    .bind(
      execution.organisationId,
      userId,
      execution.organisationId,
      id,
      ...visibilityBindings,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
}

export async function clearSubmittedConversationDraft(
  db: OrganisationDatabase,
  scope: ConversationScope,
  stored: StoredConversation | null,
  text: string,
): Promise<void> {
  if (stored === null || stored.conversation.draftText.trim() !== text.trim())
    return;
  await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} UPDATE portal_conversation_user SET draft_text = '', draft_updated_at = NULL
    WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND draft_updated_at IS ?
      AND conversation_id IN (SELECT conversation_id FROM visible_conversation)`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      scope.organisationId,
      scope.userId,
      stored.conversation.id,
      stored.conversation.draftUpdatedAt,
    )
    .run();
}

function personalizeConversation(
  conversation: Conversation,
  row: Readonly<{
    last_read_sequence: unknown;
    draft_text: unknown;
    draft_updated_at: unknown;
  }>,
): Conversation {
  if (
    typeof row.last_read_sequence !== "number" ||
    !Number.isSafeInteger(row.last_read_sequence) ||
    row.last_read_sequence < 0 ||
    typeof row.draft_text !== "string" ||
    row.draft_text.length > 8000 ||
    (row.draft_updated_at !== null &&
      (typeof row.draft_updated_at !== "number" ||
        !Number.isSafeInteger(row.draft_updated_at)))
  )
    throw new Error("chat_personal_state_invalid");
  return {
    lineage: conversation.lineage,
    historyBindings: conversation.historyBindings,
    id: conversation.id,
    title: conversation.title,
    modelRoute: conversation.modelRoute,
    documents: conversation.documents,
    work: conversation.work,
    completedRequests: conversation.completedRequests,
    timeline: conversation.timeline,
    pendingInputs: conversation.pendingInputs,
    latestSequence: conversation.latestSequence,
    lastReadSequence: Math.min(
      row.last_read_sequence,
      conversation.latestSequence,
    ),
    surfaceEventCursor: conversation.surfaceEventCursor,
    draftText: row.draft_text,
    draftUpdatedAt: row.draft_updated_at,
    effort: conversation.effort,
    ...chatOriginField(conversation.origin),
  };
}

export async function listConversationDirectory(
  db: D1Database,
  scope: ConversationScope,
  cursors: ChatDirectoryCursors = { active: null, archived: null },
): Promise<ConversationDirectory> {
  return readConversationDirectory(db, scope, "", cursors);
}

/** One page of the chat list, with the chats whose title holds `title`. */
async function readConversationDirectory(
  db: D1Database,
  scope: ConversationScope,
  title: string,
  cursors: ChatDirectoryCursors,
): Promise<ConversationDirectory> {
  const [activeRows, archivedRows] = await Promise.all([
    listConversationRows(db, scope, "active", title, cursors),
    listConversationRows(db, scope, "archived", title, cursors),
  ]);
  const active: (Readonly<
    Pick<
      ConversationSummary,
      | "id"
      | "title"
      | "revision"
      | "latestSequence"
      | "lastReadSequence"
      | "activity"
      | "placement"
      | "updatedAt"
      | "sharing"
      | "parentConversationId"
      | "origin"
    >
  > &
    ActiveConversationMetadata)[] = [];
  for (const row of activeRows)
    active.push(parseConversationSummary(row, "active"));
  const archived: (Readonly<
    Pick<
      ConversationSummary,
      | "id"
      | "title"
      | "revision"
      | "latestSequence"
      | "lastReadSequence"
      | "activity"
      | "placement"
      | "updatedAt"
      | "sharing"
      | "parentConversationId"
      | "origin"
    >
  > &
    ArchivedConversationMetadata)[] = [];
  for (const row of archivedRows)
    archived.push(parseConversationSummary(row, "archived"));
  return directoryPage(active, archived);
}

/**
 * The titles of the chats that present these Cases, for the chats this
 * person can open, as the chat list shows them. A chat whose history
 * evidence is unavailable gives no title.
 */
export async function listVisibleChatTitles(
  db: D1Database,
  scope: ConversationScope,
  caseIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  if (caseIds.length === 0) return titles;
  const rows = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT case_id, state_json, json_extract(state_json, '$.title') AS title FROM visible_conversation WHERE case_id IN (${caseIds.map(() => "?").join(", ")})`,
    )
    .bind(scope.organisationId, scope.userId, ...caseIds)
    .all<Record<string, unknown>>();
  for (const row of rows.results)
    if (
      typeof row.case_id === "string" &&
      typeof row.title === "string" &&
      typeof row.state_json === "string" &&
      restoreSummaryHistory(row.state_json).kind === "available"
    )
      titles.set(row.case_id, row.title);
  return titles;
}

export async function searchConversationDirectory(
  db: D1Database,
  scope: ConversationScope,
  query: string,
  cursors: ChatDirectoryCursors = { active: null, archived: null },
): Promise<ConversationDirectory> {
  const normalized = normalizeConversationTitle(query);
  if (normalized.length === 0)
    return listConversationDirectory(db, scope, cursors);
  return readConversationDirectory(db, scope, normalized, cursors);
}

export async function updateConversationMetadata(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  action: ConversationMetadataAction,
  now: number,
): Promise<ConversationMetadataUpdate> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { ok: false, code: "chat_metadata_conflict" };
  const stored = await readConversation(db, scope, conversationId);
  if (stored === null) return { ok: false, code: "chat_not_found" };
  if (
    (action.kind === "archive" || action.kind === "restore") &&
    stored.revision !== action.expectedRevision
  ) {
    if (
      (action.kind === "archive" && stored.metadata.lifecycle === "archived") ||
      (action.kind === "restore" && stored.metadata.lifecycle === "active")
    ) {
      return { ok: true, summary: conversationSummary(stored) };
    }
    return { ok: false, code: "chat_metadata_conflict" };
  }
  const result = await executeMetadataUpdate(
    execution,
    userId,
    stored,
    action,
    now,
  );
  if (!result.ok) return result;
  const updated = await readConversation(db, scope, conversationId);
  if (updated === null) return { ok: false, code: "chat_metadata_conflict" };
  return {
    ok: true,
    summary: {
      sharing: updated.sharing,
      parentConversationId: sideCaseParent(updated.conversation),
      origin: conversationOrigin(updated.conversation),
      id: updated.conversation.id,
      title: updated.conversation.title,
      revision: updated.revision,
      latestSequence: latestPublicTimelineSequence(updated.conversation),
      lastReadSequence: Math.min(
        updated.conversation.lastReadSequence,
        latestPublicTimelineSequence(updated.conversation),
      ),
      activity: chatThreadActivity(updated.conversation.work.kind),
      placement: updated.placement,
      updatedAt: now,
      ...updated.metadata,
    },
  };
}

export async function updateConversationDraft(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  draft: string,
  expectedUpdatedAt: number | null,
  now: number,
): Promise<ConversationDraftUpdate> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { ok: false, code: "chat_revision_conflict" };
  if (draft.length > 8000) return { ok: false, code: "chat_draft_invalid" };
  const stored = await readConversation(db, scope, conversationId);
  if (stored === null) return { ok: false, code: "chat_not_found" };
  if (stored.metadata.lifecycle === "archived")
    return { ok: false, code: "chat_archived" };
  const updatedAt =
    draft.length === 0
      ? null
      : Math.max(now, (stored.conversation.draftUpdatedAt ?? 0) + 1);
  const mutation = db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    UPDATE portal_conversation_user SET draft_text = ?, draft_updated_at = ?
    WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND draft_updated_at IS ?
      AND conversation_id IN (SELECT conversation_id FROM visible_conversation WHERE lifecycle = 'active') AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      draft,
      updatedAt,
      scope.organisationId,
      scope.userId,
      conversationId,
      expectedUpdatedAt,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
  const [, result] = await db.batch([
    prepareConversationUser(execution, userId, conversationId),
    mutation,
  ]);
  if (result?.meta.changes === 1)
    return { ok: true, revision: stored.revision, draft, updatedAt };
  const latest = await readConversation(db, scope, conversationId);
  return latest === null
    ? { ok: false, code: "chat_not_found" }
    : {
        ok: false,
        code: "chat_revision_conflict",
        serverDraft: latest.conversation.draftText,
        serverRevision: latest.revision,
        serverUpdatedAt: latest.conversation.draftUpdatedAt,
      };
}

export async function advanceConversationRead(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  sequence: number,
): Promise<ConversationReadUpdate> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { ok: false, code: "chat_revision_conflict" };
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    return { ok: false, code: "chat_read_invalid" };
  const stored = await readConversation(db, scope, conversationId);
  if (stored === null) return { ok: false, code: "chat_not_found" };
  const latestSequence = latestPublicTimelineSequence(stored.conversation);
  if (sequence > latestSequence)
    return { ok: false, code: "chat_read_invalid" };
  const mutation = db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    UPDATE portal_conversation_user SET last_read_sequence = MAX(last_read_sequence, ?)
    WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
      AND conversation_id IN (SELECT conversation_id FROM visible_conversation) AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      sequence,
      scope.organisationId,
      scope.userId,
      conversationId,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
  const [, result] = await db.batch([
    prepareConversationUser(execution, userId, conversationId),
    mutation,
  ]);
  return result?.meta.changes === 1
    ? {
        ok: true,
        latestSequence,
        lastReadSequence: Math.max(
          sequence,
          stored.conversation.lastReadSequence,
        ),
      }
    : { ok: false, code: "chat_not_found" };
}

export async function renameConversation(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  title: string,
  expectedRevision: number,
  now: number,
): Promise<ConversationRenameUpdate> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { ok: false, code: "chat_revision_conflict" };
  const normalized = title.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > 120)
    return { ok: false, code: "chat_title_invalid" };
  const stored = await readConversation(db, scope, conversationId);
  if (stored === null) return { ok: false, code: "chat_not_found" };
  if (stored.revision !== expectedRevision)
    return { ok: false, code: "chat_revision_conflict" };
  const updated: Conversation = { ...stored.conversation, title: normalized };
  const saved = await updateConversationProjection(
    execution,
    userId,
    stored,
    updated,
    now,
  );
  if (saved.kind === "capacity")
    return { ok: false, code: "chat_capacity_reached" };
  if (saved.kind === "conflict")
    return { ok: false, code: "chat_revision_conflict" };
  const latest = await readConversation(db, scope, conversationId);
  if (latest === null) return { ok: false, code: "chat_revision_conflict" };
  return {
    ok: true,
    summary: {
      sharing: latest.sharing,
      parentConversationId: sideCaseParent(latest.conversation),
      origin: conversationOrigin(latest.conversation),
      id: latest.conversation.id,
      title: latest.conversation.title,
      revision: latest.revision,
      latestSequence: latestPublicTimelineSequence(latest.conversation),
      lastReadSequence: Math.min(
        latest.conversation.lastReadSequence,
        latestPublicTimelineSequence(latest.conversation),
      ),
      activity: chatThreadActivity(latest.conversation.work.kind),
      placement: latest.placement,
      updatedAt: now,
      ...latest.metadata,
    },
  };
}

async function updateConversationProjection(
  execution: OrganisationExecutionScope,
  userId: UserId,
  stored: StoredConversation,
  conversation: Conversation,
  now: number,
): Promise<ConversationSaveOutcome> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  const normalized = normalizeConversationTimeline(conversation);
  const state = serializeConversation(normalized);
  const bytes = new TextEncoder().encode(state).byteLength;
  const limit =
    normalized.work.kind === "failed"
      ? CONVERSATION_STORAGE_BYTES
      : CONVERSATION_PROJECTION_BYTES;
  if (bytes > limit) return { kind: "capacity", bytes, limit };
  const result = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    UPDATE portal_conversation SET revision = revision + 1,
      state_json = json_set(?, '$.actorIdentity', json_extract(state_json, '$.actorIdentity')), state_format = 3, title_normalized = ?, updated_at = ?
    WHERE organisation_id = ? AND conversation_id = ? AND revision = ? AND conversation_id IN (
      SELECT conversation_id FROM visible_conversation WHERE access_kind = 'private' OR member_role IN ('owner', 'editor')) AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      state,
      normalizeConversationTitle(normalized.title),
      now,
      scope.organisationId,
      normalized.id,
      stored.revision,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    )
    .run();
  if (result.meta.changes !== 1) return { kind: "conflict" };
  signalChat(execution, {
    kind: "conversation",
    conversationId: normalized.id,
  });
  return { kind: "saved" };
}

async function listConversationRows(
  db: D1Database,
  scope: ConversationScope,
  lifecycle: "active" | "archived",
  query = "",
  cursors: ChatDirectoryCursors = { active: null, archived: null },
): Promise<readonly ConversationSummaryRow[]> {
  const order =
    lifecycle === "active"
      ? "last_activity_at DESC, conversation_id ASC"
      : "archived_at DESC, conversation_id ASC";
  const rows = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT *, conversation_id AS id, json_extract(state_json, '$.title') AS title FROM visible_conversation WHERE lifecycle = ? AND (? = '' OR title_normalized LIKE ?) AND (lifecycle <> 'active' OR ? IS NULL OR last_activity_at < ? OR (last_activity_at = ? AND conversation_id > ?)) AND (lifecycle <> 'archived' OR ? IS NULL OR archived_at < ? OR (archived_at = ? AND conversation_id > ?)) ORDER BY ${order} LIMIT 51`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      lifecycle,
      query,
      `%${query}%`,
      cursors.active?.lastActivityAt ?? null,
      cursors.active?.lastActivityAt ?? null,
      cursors.active?.lastActivityAt ?? null,
      cursors.active?.id ?? null,
      cursors.archived?.archivedAt ?? null,
      cursors.archived?.archivedAt ?? null,
      cursors.archived?.archivedAt ?? null,
      cursors.archived?.id ?? null,
    )
    .all<ConversationSummaryRow>();
  return rows.results;
}

async function executeMetadataUpdate(
  execution: OrganisationExecutionScope,
  userId: UserId,
  stored: StoredConversation,
  action: ConversationMetadataAction,
  now: number,
): Promise<
  { readonly ok: true } | Exclude<ConversationMetadataUpdate, { ok: true }>
> {
  const db = execution.database;
  const scope: ConversationScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (
    (action.kind === "pin" || action.kind === "unpin") &&
    stored.metadata.lifecycle === "archived"
  )
    return { ok: false, code: "chat_archived" };
  const assignments =
    action.kind === "pin"
      ? "pinned_at = COALESCE(pinned_at, ?)"
      : action.kind === "unpin"
        ? "pinned_at = NULL"
        : action.kind === "archive"
          ? "lifecycle = 'archived', archived_at = COALESCE(archived_at, ?)"
          : "lifecycle = 'active', archived_at = NULL";
  const value = action.kind === "pin" || action.kind === "archive" ? [now] : [];
  const [, , mutation] = await db.batch([
    prepareChatDirectoryInitialization(execution, userId, 0),
    prepareConversationUser(execution, userId, stored.conversation.id),
    db
      .prepare(
        `${VISIBLE_CONVERSATIONS_SQL}
      UPDATE portal_conversation_user SET ${assignments}
      WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
        AND conversation_id IN (SELECT conversation_id FROM visible_conversation)
        AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        userId,
        ...value,
        scope.organisationId,
        userId,
        stored.conversation.id,
        execution.organisationId,
        execution.placement.placementEpoch,
        execution.placement.placementCellId,
        execution.fenceToken,
      ),
    db
      .prepare(
        "UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND user_id = ? AND changes() = 1",
      )
      .bind(scope.organisationId, userId),
  ]);
  if (mutation?.meta.changes !== 1)
    return { ok: false, code: "chat_metadata_conflict" };
  // A pin or an archive is the user's own state: only their pages hear it.
  signalChat(execution, { kind: "user", userId });
  return { ok: true };
}

const ACTIVE_CONVERSATION_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function prepareConversationUser(
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
): D1PreparedStatement {
  return execution.database
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    INSERT OR IGNORE INTO portal_conversation_user (organisation_id, user_id, conversation_id)
    SELECT organisation_id, ?, conversation_id FROM visible_conversation
    WHERE conversation_id = ? AND ${ACTIVE_CONVERSATION_PLACEMENT}`,
    )
    .bind(
      execution.organisationId,
      userId,
      userId,
      conversationId,
      execution.organisationId,
      execution.placement.placementEpoch,
      execution.placement.placementCellId,
      execution.fenceToken,
    );
}

function parseConversationMetadata(
  row: Pick<StoredConversationRow, "lifecycle" | "pinned_at" | "archived_at">,
): ConversationMetadata {
  if (row.lifecycle === "active" && row.archived_at === null)
    return {
      lifecycle: "active",
      pinnedAt: parseOptionalTimestamp(row.pinned_at),
    };
  if (
    row.lifecycle === "archived" &&
    typeof row.archived_at === "number" &&
    Number.isSafeInteger(row.archived_at)
  )
    return {
      lifecycle: "archived",
      pinnedAt: parseOptionalTimestamp(row.pinned_at),
      archivedAt: row.archived_at,
    };
  throw new Error("conversation_metadata_invalid");
}

function parseOptionalTimestamp(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  throw new Error("conversation_metadata_invalid");
}

function normalizeConversationTitle(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ").toLocaleLowerCase().slice(0, 160);
}

function parseConversationSummary(
  row: ConversationSummaryRow,
  lifecycle: "active",
): Readonly<
  Pick<
    ConversationSummary,
    | "id"
    | "title"
    | "revision"
    | "latestSequence"
    | "lastReadSequence"
    | "activity"
    | "placement"
    | "updatedAt"
    | "sharing"
    | "parentConversationId"
    | "origin"
  >
> &
  ActiveConversationMetadata;
function parseConversationSummary(
  row: ConversationSummaryRow,
  lifecycle: "archived",
): Readonly<
  Pick<
    ConversationSummary,
    | "id"
    | "title"
    | "revision"
    | "latestSequence"
    | "lastReadSequence"
    | "activity"
    | "placement"
    | "updatedAt"
    | "sharing"
    | "parentConversationId"
    | "origin"
  >
> &
  ArchivedConversationMetadata;
function parseConversationSummary(
  row: ConversationSummaryRow,
  lifecycle: "active" | "archived",
): ConversationSummary {
  if (
    !isConversationId(row.id) ||
    typeof row.title !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    row.lifecycle !== lifecycle
  )
    throw new Error("conversation_storage_invalid");
  if (typeof row.state_json !== "string")
    throw new Error("conversation_storage_invalid");
  const history = restoreSummaryHistory(row.state_json);
  const latestSequence =
    history.kind === "available"
      ? latestPublicTimelineSequence(history.conversation)
      : 0;
  const lastReadSequence = Math.min(
    typeof row.last_read_sequence === "number" ? row.last_read_sequence : 0,
    latestSequence,
  );
  return {
    sharing: parseConversationSharing(row),
    id: row.id,
    title:
      history.kind === "available"
        ? row.title
        : "History permissions unavailable",
    revision: row.revision,
    latestSequence,
    lastReadSequence,
    activity:
      history.kind === "available"
        ? chatThreadActivity(history.conversation.work.kind)
        : "failed",
    placement: parseConversationPlacement(row),
    // The time of the last turn in the thread: the chat list sorts on it.
    updatedAt:
      typeof row.last_activity_at === "number" ? row.last_activity_at : 0,
    parentConversationId:
      history.kind === "available"
        ? sideCaseParent(history.conversation)
        : null,
    origin:
      history.kind === "available"
        ? conversationOrigin(history.conversation)
        : null,
    ...parseConversationMetadata(row),
  };
}

function restoreSummaryHistory(
  serialized: string,
):
  | Readonly<{ kind: "available"; conversation: Conversation }>
  | Readonly<{ kind: "evidence_unavailable" }> {
  try {
    return {
      kind: "available",
      conversation: parseConversation(JSON.parse(serialized)),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_evidence_unavailable"
    )
      return { kind: "evidence_unavailable" };
    throw error;
  }
}

function sideCaseParent(conversation: Conversation): ConversationId | null {
  return conversation.lineage.kind === "side_case"
    ? conversation.lineage.sourceConversationId
    : null;
}

export function conversationSummary(
  stored: StoredConversation,
): ConversationSummary {
  return {
    sharing: stored.sharing,
    id: stored.conversation.id,
    title: stored.conversation.title,
    revision: stored.revision,
    latestSequence: latestPublicTimelineSequence(stored.conversation),
    lastReadSequence: stored.conversation.lastReadSequence,
    activity: chatThreadActivity(stored.conversation.work.kind),
    placement: stored.placement,
    updatedAt: stored.conversation.timeline.at(-1)?.createdAt ?? 0,
    parentConversationId: sideCaseParent(stored.conversation),
    origin: conversationOrigin(stored.conversation),
    ...stored.metadata,
  };
}

function directoryPage(
  active: ConversationDirectory["active"],
  archived: ConversationDirectory["archived"],
): ConversationDirectory {
  const lastActive = active[49];
  const lastArchived = archived[49];
  return {
    active: active.slice(0, 50),
    archived: archived.slice(0, 50),
    nextActiveCursor:
      active.length > 50 && lastActive !== undefined
        ? `${lastActive.updatedAt}.${lastActive.id}`
        : null,
    nextArchivedCursor:
      archived.length > 50 && lastArchived !== undefined
        ? `${lastArchived.archivedAt}.${lastArchived.id}`
        : null,
  };
}

export async function listPinnedConversations(
  db: D1Database,
  scope: ConversationScope,
): Promise<ConversationDirectory["active"]> {
  const rows = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL} SELECT *, conversation_id AS id, json_extract(state_json, '$.title') AS title FROM visible_conversation WHERE lifecycle = 'active' AND pinned_at IS NOT NULL ORDER BY pinned_at DESC, conversation_id ASC`,
    )
    .bind(scope.organisationId, scope.userId)
    .all<ConversationSummaryRow>();
  const summaries: ConversationDirectory["active"][number][] = [];
  for (const row of rows.results) {
    const summary = parseConversationSummary(row, "active");
    if (summary.lifecycle !== "active")
      throw new Error("chat_pin_state_invalid");
    summaries.push(summary);
  }
  return summaries;
}

function parseConversationSharing(
  row: Readonly<{ access_kind: unknown; member_role: unknown }>,
): ConversationSharing {
  if (row.access_kind === "private")
    return { visibility: "private", role: "owner" };
  if (
    (row.access_kind === "shared" || row.access_kind === "workspace_canvas") &&
    isProjectRole(row.member_role)
  )
    return { visibility: "shared", role: row.member_role };
  throw new Error("chat_access_storage_invalid");
}
