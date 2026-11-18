import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { VISIBLE_CONVERSATIONS_SQL } from "./conversation-access";
import { authorizeConversation } from "./conversation-access";
import { isConversationId, isUserId, type UserId } from "@seams/control-api";
import type { ConversationId } from "@seams/control-api";
import {
  assertNever,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
} from "@seams/std";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "../actors/actor-router";
import {
  parseSessionId,
  type OrganisationId,
  type SessionId,
} from "../ids";
import type { Env } from "../env";
import { readConversation, type ConversationScope } from "./store";
import { prepareSourceSideCaseErasure } from "./side-cases";
import { parseConversationActorIdentity } from "./conversation-actor-identity";

export type ChatDeletionCommand = Readonly<{
  operationId: string;
  expectedRevision: number;
}>;
export type ChatDeletionResult =
  | Readonly<{ kind: "deleted"; conversationId: ConversationId }>
  | Readonly<{
      kind: "rejected";
      code: "chat_delete_conflict" | "chat_not_found";
    }>
  | Readonly<{
      kind: "failed";
      conversationId: ConversationId;
      operationId: string;
      message: string;
    }>;
type SessionCleanup = Readonly<{
  sessionId: SessionId;
  objectKeys: readonly string[];
}>;
type DeletionCleanup =
  | Readonly<{ kind: "discovering"; sessions?: never }>
  | Readonly<{ kind: "ready"; sessions: readonly SessionCleanup[] }>;

type DeletionStep<T> = Result<T, { readonly code: "chat_delete_conflict" }>;

export async function deleteArchivedChat(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  command: ChatDeletionCommand,
): Promise<ChatDeletionResult> {
  const db = execution.database;
  const scope: ConversationScope = { organisationId: execution.organisationId, userId };
  if (!(await execution.isActive()))
    return { kind: "rejected", code: "chat_delete_conflict" };
  const existing = await readDeletionReceipt(db, scope, conversationId);
  if (
    existing !== null &&
    (existing.operationId !== command.operationId ||
      existing.expectedRevision !== command.expectedRevision)
  )
    return { kind: "rejected", code: "chat_delete_conflict" };
  if (existing?.kind === "deleted") return { kind: "deleted", conversationId };
  let cleanup: DeletionCleanup;
  if (existing === null) {
    const stored = await readConversation(db, scope, conversationId);
    if (stored === null) return { kind: "rejected", code: "chat_not_found" };
    const access = await authorizeConversation(db, scope, conversationId);
    if (access === null || access.role !== "owner")
      return { kind: "rejected", code: "chat_not_found" };
    if (
      stored.metadata.lifecycle !== "archived" ||
      stored.revision !== command.expectedRevision ||
      (stored.conversation.work.kind !== "ready" &&
        stored.conversation.work.kind !== "failed") ||
      stored.conversation.pendingInputs.length > 0
    )
      return { kind: "rejected", code: "chat_delete_conflict" };
    const inventory = await chatSessionInventory(
      env,
      execution,
      stored.actorIdentity,
      stored.conversation.timeline.length > 0,
    );
    if (!inventory.ok) return { kind: "rejected", code: inventory.error.code };
    cleanup = { kind: "ready", sessions: inventory.value };
    const admitted = await db
      .prepare(
        `${VISIBLE_CONVERSATIONS_SQL}
      INSERT OR IGNORE INTO portal_chat_deletion (organisation_id, user_id, conversation_id, operation_id, expected_revision, status, cleanup_json)
      SELECT c.organisation_id, ?, c.conversation_id, ?, ?, 'cleaning', ? FROM visible_conversation c
      WHERE c.conversation_id = ? AND c.lifecycle = 'archived' AND c.revision = ? AND c.active_user_id IS NULL
        AND json_extract(c.state_json, '$.work.kind') IN ('ready', 'failed')
        AND json_array_length(json_extract(c.state_json, '$.pendingInputs')) = 0
        AND (c.access_kind = 'private' OR c.member_role = 'owner') AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        userId,
        userId,
        command.operationId,
        command.expectedRevision,
        JSON.stringify(cleanup.sessions),
        conversationId,
        command.expectedRevision,
        ...placementBindings(execution),
      )
      .run();
    if (admitted.meta.changes !== 1)
      return { kind: "rejected", code: "chat_delete_conflict" };
  } else cleanup = existing.cleanup;
  await db
    .prepare(
      `UPDATE portal_chat_deletion SET status = 'cleaning'
    WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND operation_id = ?
      AND status = 'failed' AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      userId,
      conversationId,
      command.operationId,
      ...placementBindings(execution),
    )
    .run();
  try {
    const inventory = await prepareDeletionCleanup(
      env,
      execution,
      userId,
      conversationId,
      cleanup,
    );
    if (!inventory.ok) return { kind: "rejected", code: inventory.error.code };
    const descendants = await eraseForkDescendants(
      env,
      execution,
      conversationId,
    );
    if (!descendants.ok)
      return { kind: "rejected", code: descendants.error.code };
    for (const session of inventory.value) {
      const erased = await eraseChatSession(env, execution, session);
      if (!erased.ok) return { kind: "rejected", code: erased.error.code };
    }
    const caseId = await readConversationCaseId(
      db,
      scope.organisationId,
      conversationId,
    );
    const [settlement, removed] = await db.batch([
      db
        .prepare(
          `UPDATE portal_chat_deletion SET status = 'deleted', cleanup_json = '[]', error = NULL
        WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND operation_id = ? AND status = 'cleaning'
          AND expected_revision = ? AND EXISTS (SELECT 1 FROM portal_conversation c
            WHERE c.organisation_id = portal_chat_deletion.organisation_id AND c.conversation_id = portal_chat_deletion.conversation_id
              AND c.revision = portal_chat_deletion.expected_revision) AND ${ACTIVE_PLACEMENT}`,
        )
        .bind(
          scope.organisationId,
          userId,
          conversationId,
          command.operationId,
          command.expectedRevision,
          ...placementBindings(execution),
        ),
      db
        .prepare(
          `DELETE FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ? AND revision = ? AND changes() = 1
          AND EXISTS (SELECT 1 FROM portal_chat_deletion d WHERE d.organisation_id = portal_conversation.organisation_id
            AND d.conversation_id = portal_conversation.conversation_id AND d.user_id = ? AND d.operation_id = ? AND d.status = 'deleted')
          AND ${ACTIVE_PLACEMENT}`,
        )
        .bind(
          scope.organisationId,
          conversationId,
          command.expectedRevision,
          userId,
          command.operationId,
          ...placementBindings(execution),
        ),
      db
        .prepare(
          `UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND changes() = 1 AND ${ACTIVE_PLACEMENT}`,
        )
        .bind(scope.organisationId, ...placementBindings(execution)),
      prepareErasedCaseProject(execution, caseId),
      // A started side Case stays, with its proposal as its evidence (Plan 74).
      prepareSourceSideCaseErasure(execution, conversationId),
    ]);
    // D1 includes cascading personal-state deletions in its change count.
    return settlement?.meta.changes === 1 && (removed?.meta.changes ?? 0) > 0
      ? { kind: "deleted", conversationId }
      : { kind: "rejected", code: "chat_delete_conflict" };
  } catch {
    if (!(await execution.isActive()))
      return { kind: "rejected", code: "chat_delete_conflict" };
    await db
      .prepare(
        `UPDATE portal_chat_deletion SET status = 'failed', error = 'Chat cleanup did not finish.'
      WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND operation_id = ? AND status = 'cleaning' AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        scope.organisationId,
        userId,
        conversationId,
        command.operationId,
        ...placementBindings(execution),
      )
      .run();
    return {
      kind: "failed",
      conversationId,
      operationId: command.operationId,
      message: "Chat cleanup did not finish. Retry deletion.",
    };
  }
}

async function eraseForkDescendants(
  env: Env,
  execution: OrganisationExecutionScope,
  sourceId: ConversationId,
): Promise<DeletionStep<void>> {
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const db = execution.database;
  const rows = await db
    .prepare(
      "SELECT destination_conversation_id, user_id FROM portal_chat_fork WHERE organisation_id = ? AND source_conversation_id = ?",
    )
    .bind(execution.organisationId, sourceId)
    .all<{ destination_conversation_id: unknown; user_id: unknown }>();
  for (const row of rows.results) {
    if (
      !isConversationId(row.destination_conversation_id) ||
      !isUserId(row.user_id)
    )
      throw new Error("chat_fork_storage_invalid");
    const erased = await eraseRetainedFork(
      env,
      execution,
      row.user_id,
      sourceId,
      row.destination_conversation_id,
    );
    if (!erased.ok) return erased;
  }
  await db
    .prepare(
      `UPDATE portal_chat_fork SET status = 'erased', history_json = NULL, conversation_json = NULL, digest = NULL, failure_code = NULL
    WHERE organisation_id = ? AND destination_conversation_id = ? AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(execution.organisationId, sourceId, ...placementBindings(execution))
    .run();
  return { ok: true, value: undefined };
}

async function eraseRetainedFork(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  sourceId: ConversationId,
  destinationId: ConversationId,
): Promise<DeletionStep<void>> {
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const db = execution.database;
  const organisationId = execution.organisationId;
  const operationId = `erase_fork_${await sha256Hex(`${organisationId}:${destinationId}`)}`;
  // An accepted ancestor deletion authorizes erasure of its retained copies across users.
  await db
    .prepare(
      `INSERT OR IGNORE INTO portal_chat_deletion (organisation_id, user_id, conversation_id, operation_id, expected_revision, status, cleanup_json)
    SELECT f.organisation_id, f.user_id, f.destination_conversation_id, ?, COALESCE(c.revision, 1), 'cleaning', 'null'
    FROM portal_chat_fork f JOIN portal_chat_deletion parent ON parent.organisation_id = f.organisation_id AND parent.conversation_id = f.source_conversation_id
    LEFT JOIN portal_conversation c ON c.organisation_id = f.organisation_id AND c.conversation_id = f.destination_conversation_id
    WHERE f.organisation_id = ? AND f.source_conversation_id = ? AND f.destination_conversation_id = ?
      AND parent.status IN ('cleaning', 'failed') AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      operationId,
      organisationId,
      sourceId,
      destinationId,
      ...placementBindings(execution),
    )
    .run();
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const receipt = await readDeletionReceipt(
    db,
    { organisationId, userId },
    destinationId,
  );
  if (receipt === null) throw new Error("chat_fork_erasure_unauthorized");
  if (receipt.kind === "deleted") return { ok: true, value: undefined };
  const inventory = await prepareDeletionCleanup(
    env,
    execution,
    userId,
    destinationId,
    receipt.cleanup,
  );
  if (!inventory.ok) return inventory;
  const descendants = await eraseForkDescendants(env, execution, destinationId);
  if (!descendants.ok) return descendants;
  for (const session of inventory.value) {
    const erased = await eraseChatSession(env, execution, session);
    if (!erased.ok) return erased;
  }
  const caseId = await readConversationCaseId(
    db,
    organisationId,
    destinationId,
  );
  const [settlement] = await db.batch([
    db
      .prepare(
        `UPDATE portal_chat_deletion SET status = 'deleted', cleanup_json = '[]', error = NULL
      WHERE organisation_id = ? AND user_id = ? AND conversation_id = ? AND operation_id = ? AND status IN ('cleaning', 'failed')
        AND (NOT EXISTS (SELECT 1 FROM portal_conversation c WHERE c.organisation_id = portal_chat_deletion.organisation_id
          AND c.conversation_id = portal_chat_deletion.conversation_id)
          OR EXISTS (SELECT 1 FROM portal_conversation c WHERE c.organisation_id = portal_chat_deletion.organisation_id
            AND c.conversation_id = portal_chat_deletion.conversation_id AND c.revision = portal_chat_deletion.expected_revision))
        AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(
        organisationId,
        userId,
        destinationId,
        receipt.operationId,
        ...placementBindings(execution),
      ),
    db
      .prepare(
        `UPDATE portal_chat_fork SET status = 'erased', history_json = NULL, conversation_json = NULL, digest = NULL, failure_code = NULL
      WHERE organisation_id = ? AND destination_conversation_id = ? AND changes() = 1 AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(organisationId, destinationId, ...placementBindings(execution)),
    db
      .prepare(
        `DELETE FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ? AND changes() = 1 AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(organisationId, destinationId, ...placementBindings(execution)),
    db
      .prepare(
        `UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND changes() = 1 AND ${ACTIVE_PLACEMENT}`,
      )
      .bind(organisationId, ...placementBindings(execution)),
    prepareErasedCaseProject(execution, caseId),
  ]);
  return settlement?.meta.changes === 1
    ? { ok: true, value: undefined }
    : { ok: false, error: { code: "chat_delete_conflict" } };
}

async function prepareDeletionCleanup(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  conversationId: ConversationId,
  cleanup: DeletionCleanup,
): Promise<DeletionStep<readonly SessionCleanup[]>> {
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  switch (cleanup.kind) {
    case "ready":
      return { ok: true, value: cleanup.sessions };
    case "discovering":
      break;
    default:
      return assertNever(cleanup);
  }
  const db = execution.database;
  const organisationId = execution.organisationId;
  const root = await db
    .prepare(
      "SELECT json_extract(state_json, '$.actorIdentity') AS actor_identity, latest_sequence FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
    )
    .bind(organisationId, conversationId)
    .first<{ actor_identity: unknown; latest_sequence: unknown }>();
  let sessions: readonly SessionCleanup[] = [];
  if (root !== null) {
    if (!isNonNegativeInteger(root.latest_sequence))
      throw new Error("chat_fork_storage_invalid");
    const inventory = await chatSessionInventory(
      env,
      execution,
      parseConversationActorIdentity(root.actor_identity, organisationId),
      root.latest_sequence > 0,
    );
    if (!inventory.ok) return inventory;
    sessions = inventory.value;
  }
  // Freeze the inventory before erasure; retries survive disposable Actor storage.
  const saved = await db
    .prepare(
      `UPDATE portal_chat_deletion SET cleanup_json = ? WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
      AND status IN ('cleaning', 'failed') AND json_type(cleanup_json) = 'null' AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      JSON.stringify(sessions),
      organisationId,
      userId,
      conversationId,
      ...placementBindings(execution),
    )
    .run();
  if (saved.meta.changes === 1) return { ok: true, value: sessions };
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const current = await readDeletionReceipt(
    db,
    { organisationId, userId },
    conversationId,
  );
  if (current === null) throw new Error("chat_delete_inventory_missing");
  if (current.kind === "deleted") return { ok: true, value: [] };
  if (current.cleanup.kind !== "ready")
    throw new Error("chat_delete_inventory_missing");
  return { ok: true, value: current.cleanup.sessions };
}

async function eraseChatSession(
  env: Env,
  execution: OrganisationExecutionScope,
  cleanup: SessionCleanup,
): Promise<DeletionStep<void>> {
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const actor = await resolveActiveSessionActor({
    env: env,
    namespace: env.SESSION,
    organisationId: execution.organisationId,
    sessionId: cleanup.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const erased = await actor.value.erasePortalChatSession({
    requestingOrganisationId: execution.organisationId,
    sessionId: cleanup.sessionId,
    placement: execution.placement,
    placementFenceToken: execution.fenceToken,
    objectKeys: cleanup.objectKeys,
  });
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  if (!erased.ok) {
    switch (erased.error.code) {
      case "chat_cleanup_conflict":
        return { ok: false, error: { code: "chat_delete_conflict" } };
      case "chat_cleanup_failed":
        throw new Error(erased.error.detail);
      default:
        return assertNever(erased.error);
    }
  }
  return { ok: true, value: undefined };
}

async function chatSessionInventory(
  env: Env,
  execution: OrganisationExecutionScope,
  actorIdentity: string,
  hasHistory: boolean,
): Promise<DeletionStep<readonly SessionCleanup[]>> {
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  if (!hasHistory) return { ok: true, value: [] };
  const organisationId = execution.organisationId;
  const identities = await deriveDirectCaseIdentities(actorIdentity);
  if (!identities.ok) throw new Error(identities.error.code);
  const actor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  if (!(await execution.isActive()))
    return { ok: false, error: { code: "chat_delete_conflict" } };
  const snapshot = await actor.value.inspect();
  if (!snapshot.ok) {
    if (snapshot.error.code === "case_missing") return { ok: true, value: [] };
    throw new Error(snapshot.error.code);
  }
  const inventory: SessionCleanup[] = [];
  const seen = new Set<string>();
  for (const lifecycle of snapshot.value.assignmentLifecycles) {
    const rawId = lifecycle.assignment.sessionId;
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    const sessionId = parseSessionId(rawId);
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    if (!(await execution.isActive()))
      return { ok: false, error: { code: "chat_delete_conflict" } };
    const session = await resolveActiveSessionActor({
      env: env,
      namespace: env.SESSION,
      organisationId,
      sessionId: sessionId.value,
      now: Date.now(),
    });
    if (!session.ok) throw new Error(session.error.code);
    if (!(await execution.isActive()))
      return { ok: false, error: { code: "chat_delete_conflict" } };
    const refs = await session.value.inspectHarnessHistoryReferences({
      requestingOrganisationId: organisationId,
    });
    if (!refs.ok) throw new Error(refs.error.code);
    inventory.push({ sessionId: sessionId.value, objectKeys: refs.value });
  }
  return { ok: true, value: inventory };
}

type DeletionReceiptIdentity = Readonly<{
  operationId: string;
  expectedRevision: number;
}>;
type DeletionReceipt = DeletionReceiptIdentity &
  (
    | Readonly<{ kind: "pending"; cleanup: DeletionCleanup }>
    | Readonly<{ kind: "deleted"; cleanup?: never }>
  );

async function readDeletionReceipt(
  db: OrganisationDatabase,
  scope: ConversationScope,
  conversationId: ConversationId,
): Promise<DeletionReceipt | null> {
  const row = await db
    .prepare(
      "SELECT operation_id, expected_revision, status, cleanup_json FROM portal_chat_deletion WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
    )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{
      operation_id: unknown;
      expected_revision: unknown;
      status: unknown;
      cleanup_json: unknown;
    }>();
  if (row === null) return null;
  if (
    typeof row.operation_id !== "string" ||
    row.operation_id.length === 0 ||
    !isNonNegativeInteger(row.expected_revision) ||
    row.expected_revision === 0
  )
    throw new Error("chat_deletion_state_invalid");
  switch (row.status) {
    case "deleted":
      return {
        kind: "deleted",
        operationId: row.operation_id,
        expectedRevision: row.expected_revision,
      };
    case "cleaning":
    case "failed":
      if (typeof row.cleanup_json !== "string")
        throw new Error("chat_deletion_state_invalid");
      return {
        kind: "pending",
        operationId: row.operation_id,
        expectedRevision: row.expected_revision,
        cleanup: parseDeletionCleanup(JSON.parse(row.cleanup_json)),
      };
    default:
      throw new Error("chat_deletion_state_invalid");
  }
}

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function placementBindings(execution: OrganisationExecutionScope) {
  return [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
}

function parseDeletionCleanup(raw: unknown): DeletionCleanup {
  if (raw === null) return { kind: "discovering" };
  return { kind: "ready", sessions: parseCleanupInventory(raw) };
}

function parseCleanupInventory(raw: unknown): readonly SessionCleanup[] {
  if (!Array.isArray(raw)) throw new Error("chat_delete_inventory_invalid");
  const entries: SessionCleanup[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.sessionId !== "string" ||
      !Array.isArray(item.objectKeys) ||
      !item.objectKeys.every(isObjectKey)
    )
      throw new Error("chat_delete_inventory_invalid");
    const sessionId = parseSessionId(item.sessionId);
    if (!sessionId.ok) throw new Error("chat_delete_inventory_invalid");
    entries.push({ sessionId: sessionId.value, objectKeys: item.objectKeys });
  }
  return entries;
}
function isObjectKey(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0;
}

export type PendingChatDeletion = Readonly<{
  conversationId: ConversationId;
  title: string;
  operationId: string;
  expectedRevision: number;
  kind: "cleaning" | "failed";
}>;
export async function listPendingChatDeletions(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
): Promise<readonly PendingChatDeletion[]> {
  const rows = await placement.database.prepare(
    "SELECT x.conversation_id, json_extract(c.state_json, '$.title') AS title, x.operation_id, x.expected_revision, x.status FROM portal_chat_deletion x JOIN portal_conversation c ON c.organisation_id = x.organisation_id AND c.conversation_id = x.conversation_id WHERE x.organisation_id = ? AND x.user_id = ? AND x.status IN ('cleaning', 'failed') ORDER BY x.conversation_id",
  )
    .bind(scope.organisationId, scope.userId)
    .all<{
      conversation_id: string;
      title: string;
      operation_id: string;
      expected_revision: number;
      status: string;
    }>();
  const pending: PendingChatDeletion[] = [];
  for (const row of rows.results) {
    if (
      !isConversationId(row.conversation_id) ||
      (row.status !== "cleaning" && row.status !== "failed")
    )
      throw new Error("chat_deletion_state_invalid");
    pending.push({
      conversationId: row.conversation_id,
      title: row.title,
      operationId: row.operation_id,
      expectedRevision: row.expected_revision,
      kind: row.status,
    });
  }
  return pending;
}

async function readConversationCaseId(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  conversationId: ConversationId,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
    )
    .bind(organisationId, conversationId)
    .first<{ case_id: unknown }>();
  if (row === null) return null;
  if (typeof row.case_id !== "string")
    throw new Error("chat_storage_invalid");
  return row.case_id;
}

// An erased chat's Case leaves its Project. Runs after the chat row is gone,
// and does nothing while the chat still exists.
function prepareErasedCaseProject(
  execution: OrganisationExecutionScope,
  caseId: string | null,
): D1PreparedStatement {
  return execution.database
    .prepare(
      `DELETE FROM case_project WHERE organisation_id = ? AND case_id = ?
        AND NOT EXISTS (SELECT 1 FROM portal_conversation c
          WHERE c.organisation_id = case_project.organisation_id AND c.case_id = case_project.case_id)
        AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(execution.organisationId, caseId, ...placementBindings(execution));
}
