import {
  CANVAS_BOUNDS,
  CanvasEncoding,
  CanvasLayout,
  WORKFLOW_CANVAS_SCHEMA,
  WorkflowCanvasDoc,
} from "@purin-labs/workflow-canvas-crdt";
import {
  CanvasMoveRequest,
  type CanvasMoveOutcome,
  type CanvasMoveReceipt,
  type CanvasMoveOrigin,
} from "@purin-labs/workflow-canvas-crdt/move";
import {
  encodeCanvasServerMessage,
  parseCanvasClientMessage,
  FRAME_LIMIT,
  type CanvasProtocolFailureCode,
  type CanvasRoomMetadata,
  type CanvasSelection,
  type CanvasLastChange,
} from "@purin-labs/workflow-canvas-crdt/protocol";
import {
  assertNever,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import type {
  CollaborationRoomBacking,
  CollaborationRoomProtocol,
  CollaborationRoomServerMessage,
} from "./collaboration-room";

type CanvasUpdate = CanvasEncoding<"update">;
type CanvasStateVector = CanvasEncoding<"state_vector">;
type CanvasStorageFailure = Readonly<{ code: CanvasProtocolFailureCode }>;
type StoredCanvas = Readonly<{ document: WorkflowCanvasDoc; revision: number }>;
export type WorkflowCanvasRead = Readonly<{
  documentId: string;
  documentRevision: number;
  bounds: typeof CANVAS_BOUNDS;
  objects: readonly Readonly<{
    objectId: string;
    label: string;
    x: number;
    y: number;
  }>[];
}>;

export function createWorkflowCanvasProtocol(
  backing: WorkflowCanvasBacking,
): CollaborationRoomProtocol<
  CanvasUpdate,
  CanvasStateVector,
  CanvasSelection,
  CanvasRoomMetadata,
  CanvasProtocolFailureCode
> {
  return {
    frameLimit: FRAME_LIMIT,
    failureCodes: {
      invalidMessage: "invalid_message",
      accessRevoked: "access_revoked",
      storageUnavailable: "storage_unavailable",
      roomFull: "room_full",
    },
    parseClientMessage: parseCanvasClientMessage,
    encodeServerMessage: encodeRoomMessage.bind(null, backing),
  };
}

/** The owner supplies membership from the authoritative saved run, never a browser update. */
export class WorkflowCanvasBacking implements CollaborationRoomBacking<
  WorkflowCanvasDoc,
  CanvasRoomMetadata,
  CanvasProtocolFailureCode
> {
  readonly #storage: DurableObjectStorage;
  readonly #documentId: string;
  readonly #membership: CanvasLayout;
  readonly #labels: ReadonlyMap<string, string>;

  constructor(
    storage: DurableObjectStorage,
    documentId: string,
    membership: CanvasLayout,
    labels: ReadonlyMap<string, string>,
  ) {
    this.#storage = storage;
    this.#documentId = documentId;
    this.#membership = membership;
    this.#labels = labels;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, CanvasStorageFailure>> {
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    return this.#storage.transactionSync(this.#initialize.bind(this, userId));
  }

  readDocument(): Result<WorkflowCanvasDoc, CanvasStorageFailure> {
    const stored = this.#read();
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readLastChange(): CanvasLastChange {
    const row = this.#storage.sql
      .exec(
        `SELECT canvas.revision, operation.operation_id,
       json_extract(operation.request_json, '$.origin.kind') AS origin
       FROM workflow_canvas AS canvas LEFT JOIN workflow_canvas_operation AS operation
       ON operation.document_id = canvas.document_id AND operation.document_revision = canvas.revision
       WHERE canvas.document_id = ?`,
        this.#documentId,
      )
      .toArray()[0];
    if (row === undefined || !isPositiveInteger(row.revision))
      throw new Error("Canvas change attribution unavailable");
    if (row.revision === 1) return "initial";
    if (row.operation_id === null) return "human";
    if (row.origin === "human" || row.origin === "agent") return row.origin;
    throw new Error("Canvas change attribution invalid");
  }

  readForSync(): Promise<
    Result<
      Readonly<{ document: WorkflowCanvasDoc; metadata: CanvasRoomMetadata }>,
      CanvasStorageFailure
    >
  > {
    const stored = this.#read();
    if (!stored.ok) return Promise.resolve(stored);
    return Promise.resolve({
      ok: true,
      value: {
        document: stored.value.document,
        metadata: { documentRevision: stored.value.revision },
      },
    });
  }

  readLayout(
    origin: CanvasMoveOrigin,
    userId: UserId,
  ): Result<WorkflowCanvasRead, CanvasStorageFailure> {
    const stored = this.#read();
    if (!stored.ok) return stored;
    try {
      if (origin.kind === "agent") {
        this.#storage.sql.exec(
          `INSERT OR IGNORE INTO workflow_canvas_request
           (document_id, request_json, requested_by_app_user, initial_revision)
           VALUES (?, ?, ?, ?)`,
          this.#documentId,
          JSON.stringify(origin.request),
          userId,
          stored.value.revision,
        );
      }
      const objects = [];
      for (const object of stored.value.document.snapshot().objects) {
        const label = this.#labels.get(object.objectId);
        if (label === undefined)
          return { ok: false, error: { code: "storage_unavailable" } };
        objects.push({
          objectId: object.objectId,
          label,
          x: object.x,
          y: object.y,
        });
      }
      return {
        ok: true,
        value: {
          documentId: this.#documentId,
          documentRevision: stored.value.revision,
          bounds: CANVAS_BOUNDS,
          objects,
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  persist(state: Uint8Array, userId: UserId): void {
    const before = this.#read();
    const encoded = CanvasEncoding.parse("state", state);
    if (!before.ok) throw new Error("Canvas state unavailable");
    if (!encoded.ok) {
      before.value.document.destroy();
      throw new Error("Invalid canvas state");
    }
    const after = WorkflowCanvasDoc.restore(encoded.value, this.#membership);
    try {
      if (!after.ok) throw new Error("Invalid canvas state");
      this.#persistState(state, userId);
      for (const current of after.value.snapshot().objects) {
        for (const previous of before.value.document.snapshot().objects) {
          if (
            previous.objectId !== current.objectId ||
            (previous.x === current.x && previous.y === current.y)
          )
            continue;
          this.#storage.sql.exec(
            `INSERT INTO workflow_canvas_human_change (document_id, object_id, document_revision)
             VALUES (?, ?, ?) ON CONFLICT (document_id, object_id)
             DO UPDATE SET document_revision = excluded.document_revision`,
            this.#documentId,
            current.objectId,
            before.value.revision + 1,
          );
        }
      }
    } finally {
      before.value.document.destroy();
      if (after.ok) after.value.destroy();
    }
  }

  #persistState(state: Uint8Array, userId: UserId): void {
    this.#storage.sql.exec(
      `UPDATE workflow_canvas SET encoded_state = ?, revision = revision + 1,
       updated_by_app_user = ?, updated_at = ? WHERE document_id = ?`,
      state,
      userId,
      Date.now(),
      this.#documentId,
    );
  }

  /** Call only inside CollaborationRoom.mutate, after its live authorization check. */
  move(
    request: CanvasMoveRequest,
    userId: UserId,
    origin: CanvasMoveOrigin,
  ): Result<
    Readonly<{ value: CanvasMoveOutcome; update: CanvasUpdate | null }>,
    CanvasStorageFailure
  > {
    if (request.documentId !== this.#documentId)
      return {
        ok: true,
        value: { value: { kind: "object_conflict" }, update: null },
      };
    const prior = this.#storage.sql
      .exec(
        `SELECT request_json, requested_by_app_user, document_revision
       FROM workflow_canvas_operation WHERE document_id = ? AND operation_id = ?`,
        this.#documentId,
        request.operationId,
      )
      .toArray()[0];
    // A lost response must return the original receipt even after a human moves the object.
    if (prior !== undefined) {
      const priorRequest =
        typeof prior.request_json === "string"
          ? parseJsonOrNull(prior.request_json)
          : null;
      if (
        !isRecord(priorRequest) ||
        JSON.stringify(priorRequest.request) !== JSON.stringify(request) ||
        JSON.stringify(priorRequest.origin) !== JSON.stringify(origin) ||
        prior.requested_by_app_user !== userId
      )
        return {
          ok: true,
          value: { value: { kind: "operation_conflict" }, update: null },
        };
      if (!isPositiveInteger(prior.document_revision)) return unavailable();
      return accepted(request, prior.document_revision, null);
    }
    const initialized = this.#initialize(userId);
    if (!initialized.ok) return initialized;
    const stored = this.#read();
    if (!stored.ok) return stored;
    const { document, revision } = stored.value;
    try {
      if (origin.kind === "agent") {
        const started = this.#storage.sql
          .exec(
            `SELECT initial_revision FROM workflow_canvas_request
           WHERE document_id = ? AND request_json = ? AND requested_by_app_user = ?`,
            this.#documentId,
            JSON.stringify(origin.request),
            userId,
          )
          .toArray()[0];
        if (
          started === undefined ||
          !isPositiveInteger(started.initial_revision)
        )
          return unavailable();
        const changed = this.#storage.sql
          .exec(
            `SELECT document_revision FROM workflow_canvas_human_change
           WHERE document_id = ? AND object_id = ? AND document_revision > ?`,
            this.#documentId,
            request.destination.objectId,
            started.initial_revision,
          )
          .toArray();
        if (changed.length > 0)
          return {
            ok: true,
            value: { value: { kind: "human_intervention" }, update: null },
          };
      }
      if (revision !== request.expectedRevision)
        return {
          ok: true,
          value: {
            value: { kind: "revision_conflict", revision },
            update: null,
          },
        };
      const before = document
        .snapshot()
        .objects.find(
          canvasPointMatches.bind(null, request.destination.objectId),
        );
      const update = document.move(request.destination);
      if (!update.ok) {
        if (update.error.code === "object_conflict")
          return {
            ok: true,
            value: { value: { kind: "object_conflict" }, update: null },
          };
        return update;
      }
      const state = document.state();
      if (!state.ok) return state;
      if (origin.kind === "human") this.persist(state.value.encode(), userId);
      else this.#persistState(state.value.encode(), userId);
      this.#storage.sql.exec(
        `INSERT INTO workflow_canvas_operation
         (document_id, operation_id, request_json, requested_by_app_user, document_revision)
         VALUES (?, ?, ?, ?, ?)`,
        this.#documentId,
        request.operationId,
        JSON.stringify({ request, origin, before: before?.toJSON() ?? null }),
        userId,
        revision + 1,
      );
      return accepted(request, revision + 1, update.value);
    } finally {
      document.destroy();
    }
  }

  undoAgentMove(
    expectedRevision: number,
    operationId: string,
    userId: UserId,
  ): ReturnType<WorkflowCanvasBacking["move"]> {
    const stored = this.#read();
    if (!stored.ok) return stored;
    const revision = stored.value.revision;
    stored.value.document.destroy();
    if (revision !== expectedRevision)
      return {
        ok: true,
        value: { value: { kind: "revision_conflict", revision }, update: null },
      };
    const row = this.#storage.sql
      .exec(
        "SELECT request_json FROM workflow_canvas_operation WHERE document_id = ? AND document_revision = ?",
        this.#documentId,
        revision,
      )
      .toArray()[0];
    const payload =
      typeof row?.request_json === "string"
        ? parseJsonOrNull(row.request_json)
        : null;
    if (
      !isRecord(payload) ||
      !isRecord(payload.origin) ||
      payload.origin.kind !== "agent" ||
      !isRecord(payload.before)
    )
      return {
        ok: true,
        value: { value: { kind: "operation_conflict" }, update: null },
      };
    const move = CanvasMoveRequest.parse({
      documentId: this.#documentId,
      operationId,
      expectedRevision,
      objectId: payload.before.objectId,
      x: payload.before.x,
      y: payload.before.y,
    });
    if (move === null) return unavailable();
    return this.move(move, userId, { kind: "human" });
  }

  #initialize(userId: UserId): Result<null, CanvasStorageFailure> {
    const exists =
      this.#storage.sql
        .exec(
          "SELECT document_id FROM workflow_canvas WHERE document_id = ?",
          this.#documentId,
        )
        .toArray().length > 0;
    if (exists) {
      const stored = this.#read();
      if (!stored.ok) return stored;
      stored.value.document.destroy();
      return { ok: true, value: null };
    }
    const document = WorkflowCanvasDoc.create(this.#membership);
    try {
      const state = document.state();
      if (!state.ok) return state;
      this.#storage.sql.exec(
        `INSERT INTO workflow_canvas
         (document_id, schema_version, encoded_state, revision, updated_by_app_user, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        this.#documentId,
        WORKFLOW_CANVAS_SCHEMA,
        state.value.encode(),
        userId,
        Date.now(),
      );
      return { ok: true, value: null };
    } finally {
      document.destroy();
    }
  }

  #read(): Result<StoredCanvas, CanvasStorageFailure> {
    const row = this.#storage.sql
      .exec(
        "SELECT schema_version, encoded_state, revision FROM workflow_canvas WHERE document_id = ?",
        this.#documentId,
      )
      .toArray()[0];
    if (
      row === undefined ||
      row.schema_version !== WORKFLOW_CANVAS_SCHEMA ||
      !(row.encoded_state instanceof ArrayBuffer) ||
      !isPositiveInteger(row.revision)
    )
      return unavailable();
    const state = CanvasEncoding.parse(
      "state",
      new Uint8Array(row.encoded_state),
    );
    if (!state.ok) return state;
    const document = WorkflowCanvasDoc.restore(state.value, this.#membership);
    return document.ok
      ? {
          ok: true,
          value: { document: document.value, revision: row.revision },
        }
      : document;
  }
}

export function createWorkflowCanvasSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_canvas_request (
    document_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    requested_by_app_user TEXT NOT NULL,
    initial_revision INTEGER NOT NULL CHECK (initial_revision > 0),
    PRIMARY KEY (document_id, request_json, requested_by_app_user)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_canvas_human_change (
    document_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    PRIMARY KEY (document_id, object_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_canvas (
    document_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'workflow_canvas_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 131072),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_canvas_operation (
    document_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    requested_by_app_user TEXT NOT NULL,
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    PRIMARY KEY (document_id, operation_id)
  )`);
}

function accepted(
  request: CanvasMoveRequest,
  revision: number,
  update: CanvasUpdate | null,
): Result<
  Readonly<{ value: CanvasMoveOutcome; update: CanvasUpdate | null }>,
  never
> {
  const receipt: CanvasMoveReceipt = {
    documentId: request.documentId,
    operationId: request.operationId,
    objectId: request.destination.objectId,
    x: request.destination.x,
    y: request.destination.y,
    documentRevision: revision,
  };
  return { ok: true, value: { value: { kind: "accepted", receipt }, update } };
}

function unavailable(): Result<never, CanvasStorageFailure> {
  return { ok: false, error: { code: "storage_unavailable" } };
}

function encodeRoomMessage(
  backing: WorkflowCanvasBacking,
  message: CollaborationRoomServerMessage<
    CanvasUpdate,
    CanvasStateVector,
    CanvasSelection,
    CanvasRoomMetadata,
    CanvasProtocolFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeCanvasServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        access: message.access,
        sessionId: message.sessionId,
        lastChange: backing.readLastChange(),
      });
    case "update_accepted":
      return encodeCanvasServerMessage({
        kind: "update_accepted",
        updateId: message.updateId,
        lastChange: backing.readLastChange(),
      });
    case "update_broadcast":
      return encodeCanvasServerMessage({
        kind: "update_broadcast",
        update: message.update,
        lastChange: backing.readLastChange(),
      });
    case "presence_changed":
      return encodeCanvasServerMessage({
        kind: "presence_changed",
        participants: message.participants,
        agents: message.agents,
      });
    case "failure":
      return encodeCanvasServerMessage(message);
    default:
      return assertNever(message);
  }
}

function canvasPointMatches(
  id: string,
  point: Readonly<{ objectId: string }>,
): boolean {
  return point.objectId === id;
}
