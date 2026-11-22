import { draftSeed } from "@purin-labs/bakery-workflow/draft";
import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  DRAFT_ENCODING_LIMITS,
  DraftEncoding,
  WORKFLOW_DRAFT_SCHEMA,
  WorkflowDraftDoc,
  type DraftChangeSet,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";
import {
  FRAME_LIMIT,
  encodeDraftServerMessage,
  parseDraftClientMessage,
  type DraftProtocolFailureCode,
  type DraftRoomMetadata,
  type DraftSelection,
} from "@purin-labs/workflow-canvas-crdt/draft-protocol";
import { assertNever } from "@purin-labs/std";
import {
  isBakeryWorkflowId,
  readCurrentWorkflow,
} from "../commerce/bakery/workflow-revisions";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError } from "../control/http";
import { resolveUser } from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  CollaborationRoom,
  openRoomSockets,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";

type DraftUpdate = DraftEncoding<"update">;
type DraftStateVector = DraftEncoding<"state_vector">;
type DraftRoom = CollaborationRoom<
  DraftUpdate,
  DraftStateVector,
  DraftSelection,
  DraftRoomMetadata,
  DraftProtocolFailureCode,
  WorkflowDraftDoc
>;
type DraftOutcome<T> = Result<T, Readonly<{ code: DraftProtocolFailureCode }>>;

const REVISION_CHANGED = encodeDraftServerMessage({ kind: "revision_changed" });

/**
 * Plan 84: the shared draft of each recipe's workflow. A draft starts from the
 * applied revision, so a first apply must exist. Only the compile before a run or
 * an apply judges a draft's content. A draft has no authority over a run, stock or
 * a machine.
 */
export class WorkflowDraftRooms {
  readonly #rooms = new Map<string, DraftRoom>();
  readonly #ctx: DurableObjectState;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    ctx.storage.transactionSync(createDraftSchema.bind(null, ctx.storage.sql));
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    key: string,
  ): CollaborationSocketRoom | null {
    return isBakeryWorkflowId(key) ? this.#room(organisationId, key) : null;
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    workflowId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
    const sql = this.#ctx.storage.sql;
    if (readStored(sql, workflowId) === null) {
      let seed: Uint8Array;
      try {
        const current = await readCurrentWorkflow(
          this.#env,
          scope.database,
          scope.organisationId,
          workflowId,
        );
        if (current === null)
          return controlError("bakery_workflow_not_found", 404);
        const doc = WorkflowDraftDoc.create(draftSeed(current.document));
        if (!doc.ok) return controlError("bakery_workflow_too_large", 422);
        const state = doc.value.state();
        doc.value.destroy();
        if (!state.ok) return controlError("bakery_workflow_too_large", 422);
        seed = state.value.encode();
      } catch {
        return controlError("bakery_workflow_unavailable", 503);
      }
      insertSeed(
        sql,
        workflowId,
        seed,
        authorized.authenticated.session.userId,
      );
    }
    return this.#room(authorized.organisationId, workflowId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  /** The draft now, for a check of an agent's proposal. Null when nobody opened it. */
  snapshot(workflowId: string): DraftSnapshot | null {
    const row = readStored(this.#ctx.storage.sql, workflowId);
    if (row === null) return null;
    const state = DraftEncoding.parse("state", row.state);
    if (!state.ok) return null;
    const document = WorkflowDraftDoc.restore(state.value);
    if (!document.ok) return null;
    const snapshot = document.value.snapshot();
    document.value.destroy();
    return snapshot;
  }

  /**
   * An approved proposal enters the draft as one update, and open pages receive it.
   * A draft that nobody opened starts from the new revision anyway.
   */
  mergeProposal(
    scope: OrganisationExecutionScope,
    organisationId: OrganisationId,
    workflowId: string,
    change: DraftChangeSet,
    person: Readonly<{ userId: UserId; controlSessionId: ControlSessionId }>,
  ) {
    if (readStored(this.#ctx.storage.sql, workflowId) === null)
      return Promise.resolve({ ok: true as const, value: null });
    return this.#room(organisationId, workflowId).mutate(
      {
        scope,
        origin: {
          kind: "control_session",
          controlSessionId: person.controlSessionId,
        },
        userId: person.userId,
        deadlineAt: Date.now() + 30_000,
      },
      writeChangeSet.bind(
        null,
        this.#ctx.storage.sql,
        workflowId,
        change,
        person.userId,
      ),
    );
  }

  /** Tells open pages that a revision changed. They read it through the route. */
  revisionApplied(workflowId: string): void {
    for (const socket of openRoomSockets(this.#ctx, "workflow_draft")) {
      if (socket.key !== workflowId) continue;
      try {
        socket.socket.send(REVISION_CHANGED);
      } catch {
        // The socket closed; its close event ends it.
      }
    }
  }

  #room(organisationId: OrganisationId, workflowId: string): DraftRoom {
    const existing = this.#rooms.get(workflowId);
    if (existing !== undefined) return existing;
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: DRAFT_ROOM_PROTOCOL,
      backing: new DraftBacking(this.#ctx.storage.sql, workflowId),
      route: { kind: "workflow_draft", key: workflowId },
      closeReason: "Workflow draft disconnected",
      onEmpty: this.#remove.bind(this, workflowId),
    });
    this.#rooms.set(workflowId, room);
    return room;
  }

  #remove(workflowId: string): void {
    this.#rooms.delete(workflowId);
  }
}

const DRAFT_ROOM_PROTOCOL: CollaborationRoomProtocol<
  DraftUpdate,
  DraftStateVector,
  DraftSelection,
  DraftRoomMetadata,
  DraftProtocolFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseDraftClientMessage,
  encodeServerMessage: encodeDraftRoomMessage,
};

function encodeDraftRoomMessage(
  message: CollaborationRoomServerMessage<
    DraftUpdate,
    DraftStateVector,
    DraftSelection,
    DraftRoomMetadata,
    DraftProtocolFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeDraftServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "presence_changed":
      return encodeDraftServerMessage({
        kind: "presence_changed",
        participants: message.participants,
      });
    case "update_accepted":
    case "update_broadcast":
    case "failure":
      return encodeDraftServerMessage(message);
    default:
      return assertNever(message);
  }
}

class DraftBacking implements CollaborationRoomBacking<
  WorkflowDraftDoc,
  DraftRoomMetadata,
  DraftProtocolFailureCode
> {
  readonly #sql: SqlStorage;
  readonly #workflowId: string;

  constructor(sql: SqlStorage, workflowId: string) {
    this.#sql = sql;
    this.#workflowId = workflowId;
  }

  async initialize(
    _userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<DraftOutcome<null>> {
    if (!(await isOrganisationExecutionActive(this.#sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    return readStored(this.#sql, this.#workflowId) === null
      ? { ok: false, error: { code: "storage_unavailable" } }
      : { ok: true, value: null };
  }

  readDocument(): DraftOutcome<WorkflowDraftDoc> {
    const stored = this.#read();
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    DraftOutcome<
      Readonly<{ document: WorkflowDraftDoc; metadata: DraftRoomMetadata }>
    >
  > {
    const stored = this.#read();
    return Promise.resolve(
      stored.ok
        ? {
            ok: true,
            value: {
              document: stored.value.document,
              metadata: { documentRevision: stored.value.revision },
            },
          }
        : stored,
    );
  }

  persist(state: Uint8Array, userId: UserId): void {
    this.#sql.exec(
      `UPDATE workflow_draft SET encoded_state = ?, revision = revision + 1,
       updated_by_app_user = ?, updated_at = ? WHERE workflow_id = ?`,
      state,
      userId,
      Date.now(),
      this.#workflowId,
    );
  }

  #read(): DraftOutcome<
    Readonly<{ document: WorkflowDraftDoc; revision: number }>
  > {
    const row = readStored(this.#sql, this.#workflowId);
    if (row === null)
      return { ok: false, error: { code: "storage_unavailable" } };
    const state = DraftEncoding.parse("state", row.state);
    if (!state.ok) return { ok: false, error: { code: state.error.code } };
    const document = WorkflowDraftDoc.restore(state.value);
    return document.ok
      ? {
          ok: true,
          value: { document: document.value, revision: row.revision },
        }
      : { ok: false, error: { code: document.error.code } };
  }
}

function writeChangeSet(
  sql: SqlStorage,
  workflowId: string,
  change: DraftChangeSet,
  userId: UserId,
): DraftOutcome<Readonly<{ value: null; update: DraftUpdate | null }>> {
  const backing = new DraftBacking(sql, workflowId);
  const document = backing.readDocument();
  if (!document.ok) return document;
  try {
    const update = document.value.applyChangeSet(change);
    if (!update.ok) return { ok: false, error: { code: "invalid_message" } };
    const state = document.value.state();
    if (!state.ok) return { ok: false, error: { code: "storage_unavailable" } };
    backing.persist(state.value.encode(), userId);
    return { ok: true, value: { value: null, update: update.value } };
  } finally {
    document.value.destroy();
  }
}

function readStored(
  sql: SqlStorage,
  workflowId: string,
): Readonly<{ state: Uint8Array; revision: number }> | null {
  const row = sql
    .exec(
      `SELECT encoded_state, revision FROM workflow_draft WHERE workflow_id = ?`,
      workflowId,
    )
    .toArray()[0];
  if (
    !isRecord(row) ||
    !hasExactKeys(row, ["encoded_state", "revision"]) ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    !isPositiveInteger(row.revision)
  )
    return null;
  return { state: new Uint8Array(row.encoded_state), revision: row.revision };
}

function insertSeed(
  sql: SqlStorage,
  workflowId: string,
  state: Uint8Array,
  userId: UserId,
): void {
  sql.exec(
    `INSERT OR IGNORE INTO workflow_draft
     (workflow_id, schema_version, encoded_state, revision, updated_by_app_user, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    workflowId,
    WORKFLOW_DRAFT_SCHEMA,
    state,
    userId,
    Date.now(),
  );
}

function createDraftSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_draft (
    workflow_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'workflow_canvas_crdt.v2'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= ${DRAFT_ENCODING_LIMITS.state}),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}
