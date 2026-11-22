import {
  COSTS_SHEET_SCHEMA,
  CostsSheetDoc,
  SCENARIO_PRESET_CELL_KEY,
  parseCostsSheetState,
  type CostsSheetCell,
  type CostsSheetCellChange,
  type CostsSheetSelection,
  type CostsSheetStateVector,
  type CostsSheetUpdate,
} from "@purin-labs/costs-sheet-crdt";
import {
  encodeCostsSheetServerMessage,
  FRAME_LIMIT,
  parseCostsSheetClientMessage,
  type CostsSheetFailureCode,
  type CostsSheetRoomMetadata,
} from "@purin-labs/costs-sheet-crdt/protocol";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import { assertNever, sha256Hex } from "@purin-labs/std";
import type { SessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError } from "@purin-labs/control/worker/http";
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
  type CollaborationMutationOrigin,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "@purin-labs/collaboration/worker/collaboration-room";

const COSTS_SHEET_ID = "costs-sheet";
const COMPACT_STATE_BYTES = 48 * 1024;
const COMPACT_VECTOR_BYTES = 4 * 1024;

type SheetRoom = CollaborationRoom<
  CostsSheetUpdate,
  CostsSheetStateVector,
  CostsSheetSelection,
  CostsSheetRoomMetadata,
  CostsSheetFailureCode,
  CostsSheetDoc
>;

type StoredSheet = Readonly<{
  document: CostsSheetDoc;
  revision: number;
  generation: number;
}>;

type SheetResult<T> = Result<T, Readonly<{ code: CostsSheetFailureCode }>>;

type CostsSheetDraftRead = Readonly<{
  documentId: typeof COSTS_SHEET_ID;
  revision: number;
  generation: number;
  cells: readonly CostsSheetCell[];
}>;

export type CostsSheetAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  organisationId: OrganisationId;
  changes: readonly CostsSheetCellChange[];
  targetCellKey: string;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;

export type CostsSheetSettleInput = Readonly<{
  organisationId: OrganisationId;
  cellKeys: readonly string[];
  clearPriceCells?: boolean;
  savedAtMs: number;
  userId: UserId;
  origin:
    | Readonly<{ kind: "control_session"; controlSessionId: ControlSessionId }>
    | Readonly<{
        kind: "session_turn";
        execution: SessionTurnExecution;
        /** The agent that saved, shown on the first saved cell. */
        agent: CollaborationAgent;
        operationId: string;
      }>;
}>;

export class CostsSheetRooms {
  readonly #rooms = new Map<OrganisationId, SheetRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    ctx.storage.transactionSync(
      createCostsSheetSchema.bind(null, ctx.storage.sql),
    );
  }

  socketRoom(
    organisationId: OrganisationId,
    key: string,
  ): CollaborationSocketRoom | null {
    return key === organisationId ? this.#room(organisationId) : null;
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256) {
      return controlError("access_revoked", 403);
    }
    return this.#room(authorized.organisationId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  snapshot(): Response {
    const result = this.read();
    return result.ok
      ? Response.json(result)
      : controlError(result.error.code, 503);
  }

  read(): SheetResult<CostsSheetDraftRead> {
    const stored = readStoredSheetIfAny(this.#storage.sql);
    if (!stored.ok) {
      return stored;
    }
    if (stored.value === null) {
      return {
        ok: true,
        value: {
          documentId: COSTS_SHEET_ID,
          revision: 0,
          generation: 1,
          cells: [],
        },
      };
    }
    try {
      return {
        ok: true,
        value: {
          documentId: COSTS_SHEET_ID,
          revision: stored.value.revision,
          generation: stored.value.generation,
          cells: stored.value.document.read().cells,
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  async reset(
    authorized: AuthorizedOrganisationRequest,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const userId = authorized.authenticated.session.userId;
    const created = this.#storage.transactionSync(
      initializeCostsSheet.bind(null, this.#storage.sql, userId, false),
    );
    if (!created.ok) {
      return controlError(created.error.code, 503);
    }
    const cleared = await this.#room(authorized.organisationId).mutate(
      {
        scope,
        origin: {
          kind: "control_session",
          controlSessionId: authorized.authenticated.session.controlSessionId,
        },
        userId,
        deadlineAt: Date.now() + 30_000,
      },
      clearAllSheetCells.bind(null, this.#storage.sql, userId),
    );
    if (!cleared.ok) {
      return controlError(
        cleared.error.code,
        cleared.error.code === "access_revoked" ? 403 : 409,
      );
    }
    return this.snapshot();
  }

  async edit(
    input: CostsSheetAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CostsSheetDraftRead,
      Readonly<{
        code:
          | CostsSheetFailureCode
          | "organisation_placement_conflict"
          | "access_revoked"
          | "room_full";
      }>
    >
  > {
    const created = this.#storage.transactionSync(
      initializeCostsSheet.bind(null, this.#storage.sql, input.userId, false),
    );
    if (!created.ok) {
      return created;
    }
    const operationId = await sha256Hex(input.operationId);
    const edited = await this.#room(input.organisationId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      applyAgentSheetChanges.bind(null, this.#storage.sql, input),
      {
        agent: input.agent,
        operationId,
        target: input.targetCellKey,
      },
    );
    if (!edited.ok) {
      return edited;
    }
    return this.read();
  }

  async settleSaved(
    scope: OrganisationExecutionScope,
    input: CostsSheetSettleInput,
  ) {
    const hasSockets = openRoomSockets(this.#ctx, "costs_sheet").some(
      (socket) => socket.key === input.organisationId,
    );
    const stored = readStoredSheetIfAny(this.#storage.sql);
    if (!stored.ok) {
      return stored;
    }
    if (stored.value === null && !hasSockets) {
      return { ok: true as const, value: null };
    }
    stored.value?.document.destroy();
    const created = this.#storage.transactionSync(
      initializeCostsSheet.bind(null, this.#storage.sql, input.userId, false),
    );
    if (!created.ok) {
      return created;
    }
    const origin: CollaborationMutationOrigin =
      input.origin.kind === "control_session"
        ? {
            kind: "control_session",
            controlSessionId: input.origin.controlSessionId,
          }
        : {
            kind: "session_turn",
            execution: input.origin.execution,
          };
    // The preset cell has no place on the page; label the first real cell.
    const target = input.cellKeys.find(isLabelledCell);
    return this.#room(input.organisationId).mutate(
      {
        scope,
        origin,
        userId: input.userId,
        deadlineAt: Date.now() + 30_000,
      },
      settleSavedSheetCells.bind(
        null,
        this.#storage.sql,
        input.cellKeys,
        input.savedAtMs,
        input.clearPriceCells === true,
        input.userId,
      ),
      input.origin.kind === "session_turn" && target !== undefined
        ? {
            agent: input.origin.agent,
            operationId: await sha256Hex(input.origin.operationId),
            target,
          }
        : null,
    );
  }

  #room(organisationId: OrganisationId): SheetRoom {
    const existing = this.#rooms.get(organisationId);
    if (existing !== undefined) {
      return existing;
    }
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: COSTS_SHEET_ROOM_PROTOCOL,
      backing: new CostsSheetBacking(this.#ctx, organisationId),
      route: { kind: "costs_sheet", key: organisationId },
      closeReason: "Costs sheet disconnected",
      onEmpty: this.#remove.bind(this, organisationId),
    });
    this.#rooms.set(organisationId, room);
    return room;
  }

  #remove(organisationId: OrganisationId): void {
    this.#rooms.delete(organisationId);
  }
}

const COSTS_SHEET_ROOM_PROTOCOL: CollaborationRoomProtocol<
  CostsSheetUpdate,
  CostsSheetStateVector,
  CostsSheetSelection,
  CostsSheetRoomMetadata,
  CostsSheetFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: (frame) => parseCostsSheetClientMessage(frame),
  encodeServerMessage: encodeRoomServerMessage,
};

class CostsSheetBacking
  implements
    CollaborationRoomBacking<
      CostsSheetDoc,
      CostsSheetRoomMetadata,
      CostsSheetFailureCode
    >
{
  readonly #ctx: DurableObjectState;
  readonly #organisationId: OrganisationId;

  constructor(ctx: DurableObjectState, organisationId: OrganisationId) {
    this.#ctx = ctx;
    this.#organisationId = organisationId;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<SheetResult<null>> {
    const sql = this.#ctx.storage.sql;
    if (!(await isOrganisationExecutionActive(sql, scope))) {
      return { ok: false, error: { code: "access_revoked" } };
    }
    const idle = !openRoomSockets(this.#ctx, "costs_sheet").some(
      (socket) => socket.key === this.#organisationId,
    );
    return this.#ctx.storage.transactionSync(
      initializeCostsSheet.bind(null, sql, userId, idle),
    );
  }

  readDocument(): SheetResult<CostsSheetDoc> {
    const stored = readSheet(this.#ctx.storage.sql);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    SheetResult<
      Readonly<{ document: CostsSheetDoc; metadata: CostsSheetRoomMetadata }>
    >
  > {
    const stored = readSheet(this.#ctx.storage.sql);
    return Promise.resolve(
      stored.ok
        ? {
            ok: true,
            value: {
              document: stored.value.document,
              metadata: {
                documentRevision: stored.value.revision,
                generation: stored.value.generation,
              },
            },
          }
        : stored,
    );
  }

  persist(state: Uint8Array, userId: UserId): void {
    persistSheet(this.#ctx.storage.sql, state, userId);
  }
}

function encodeRoomServerMessage(
  message: CollaborationRoomServerMessage<
    CostsSheetUpdate,
    CostsSheetStateVector,
    CostsSheetSelection,
    CostsSheetRoomMetadata,
    CostsSheetFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeCostsSheetServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        generation: message.metadata.generation,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "update_accepted":
    case "update_broadcast":
    case "presence_changed":
    case "failure":
      return encodeCostsSheetServerMessage(message);
    default:
      return assertNever(message);
  }
}

function createCostsSheetSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS costs_sheet_draft (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'costs-sheet'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'costs_sheet_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 262144),
    generation INTEGER NOT NULL CHECK (generation > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function initializeCostsSheet(
  sql: SqlStorage,
  userId: UserId,
  idle: boolean,
): SheetResult<null> {
  const row = sql
    .exec(
      "SELECT length(encoded_state) AS bytes FROM costs_sheet_draft WHERE singleton_id = ?",
      COSTS_SHEET_ID,
    )
    .toArray()[0];
  if (row === undefined) {
    const document = CostsSheetDoc.create();
    try {
      const state = document.state();
      if (!state.ok) {
        return state;
      }
      const now = Date.now();
      sql.exec(
        `INSERT INTO costs_sheet_draft
          (singleton_id, schema_version, encoded_state, generation, revision, updated_by_app_user, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
        COSTS_SHEET_ID,
        COSTS_SHEET_SCHEMA,
        state.value.encode(),
        userId,
        now,
        now,
      );
      return { ok: true, value: null };
    } finally {
      document.destroy();
    }
  }
  return idle ? compactSheet(sql, userId) : { ok: true, value: null };
}

function compactSheet(sql: SqlStorage, userId: UserId): SheetResult<null> {
  const stored = readSheet(sql);
  if (!stored.ok) {
    return stored;
  }
  try {
    const state = stored.value.document.state();
    const vector = stored.value.document.stateVector();
    if (!state.ok) {
      return state;
    }
    if (!vector.ok) {
      return vector;
    }
    if (
      state.value.encode().byteLength <= COMPACT_STATE_BYTES &&
      vector.value.encode().byteLength <= COMPACT_VECTOR_BYTES
    ) {
      return { ok: true, value: null };
    }
    const compact = CostsSheetDoc.compact(stored.value.document.read());
    if (!compact.ok) {
      return compact;
    }
    try {
      const next = compact.value.state();
      if (!next.ok) {
        return next;
      }
      sql.exec(
        `UPDATE costs_sheet_draft
         SET encoded_state = ?, generation = generation + 1, revision = revision + 1,
             updated_by_app_user = ?, updated_at = ?
         WHERE singleton_id = ?`,
        next.value.encode(),
        userId,
        Date.now(),
        COSTS_SHEET_ID,
      );
      return { ok: true, value: null };
    } finally {
      compact.value.destroy();
    }
  } finally {
    stored.value.document.destroy();
  }
}

function applyAgentSheetChanges(
  sql: SqlStorage,
  input: CostsSheetAgentEdit,
): Result<
  Readonly<{ value: null; update: CostsSheetUpdate | null }>,
  Readonly<{ code: CostsSheetFailureCode }>
> {
  const stored = readSheet(sql);
  if (!stored.ok) {
    return stored;
  }
  const document = stored.value.document;
  try {
    const applied = document.setCells(input.changes);
    if (!applied.ok) {
      return applied;
    }
    if (applied.value !== null) {
      const state = document.state();
      if (!state.ok) {
        return state;
      }
      persistSheet(sql, state.value.encode(), input.userId);
    }
    return { ok: true, value: { value: null, update: applied.value } };
  } finally {
    document.destroy();
  }
}

function clearAllSheetCells(
  sql: SqlStorage,
  userId: UserId,
): Result<
  Readonly<{ value: null; update: CostsSheetUpdate | null }>,
  Readonly<{ code: CostsSheetFailureCode }>
> {
  const stored = readSheet(sql);
  if (!stored.ok) {
    return stored;
  }
  const document = stored.value.document;
  try {
    const cleared = document.clearAllDraftCells();
    if (!cleared.ok) {
      return cleared;
    }
    if (cleared.value !== null) {
      const state = document.state();
      if (!state.ok) {
        return state;
      }
      persistSheet(sql, state.value.encode(), userId);
    }
    return { ok: true, value: { value: null, update: cleared.value } };
  } finally {
    document.destroy();
  }
}

function settleSavedSheetCells(
  sql: SqlStorage,
  cellKeys: readonly string[],
  savedAtMs: number,
  clearPriceCells: boolean,
  userId: UserId,
): Result<
  Readonly<{ value: null; update: CostsSheetUpdate | null }>,
  Readonly<{ code: CostsSheetFailureCode }>
> {
  const stored = readSheet(sql);
  if (!stored.ok) {
    return stored;
  }
  const document = stored.value.document;
  try {
    const settled = document.settleSavedCells(
      cellKeys,
      savedAtMs,
      clearPriceCells,
    );
    if (!settled.ok) {
      return settled;
    }
    if (settled.value !== null) {
      const state = document.state();
      if (!state.ok) {
        return state;
      }
      persistSheet(sql, state.value.encode(), userId);
    }
    return { ok: true, value: { value: null, update: settled.value } };
  } finally {
    document.destroy();
  }
}

function persistSheet(
  sql: SqlStorage,
  state: Uint8Array,
  userId: UserId,
): void {
  sql.exec(
    `UPDATE costs_sheet_draft
     SET encoded_state = ?, revision = revision + 1, updated_by_app_user = ?, updated_at = ?
     WHERE singleton_id = ?`,
    state,
    userId,
    Date.now(),
    COSTS_SHEET_ID,
  );
}

function readStoredSheetIfAny(sql: SqlStorage): SheetResult<StoredSheet | null> {
  const exists =
    sql
      .exec(
        "SELECT singleton_id FROM costs_sheet_draft WHERE singleton_id = ?",
        COSTS_SHEET_ID,
      )
      .toArray().length > 0;
  return exists ? readSheet(sql) : { ok: true, value: null };
}

function readSheet(sql: SqlStorage): SheetResult<StoredSheet> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, generation, revision FROM costs_sheet_draft WHERE singleton_id = ?",
      COSTS_SHEET_ID,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== COSTS_SHEET_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    return { ok: false, error: { code: "invalid_state" } };
  }
  const state = parseCostsSheetState(new Uint8Array(row.encoded_state));
  if (!state.ok) {
    return state;
  }
  const document = CostsSheetDoc.restore(state.value);
  return document.ok
    ? {
        ok: true,
        value: {
          document: document.value,
          revision: row.revision,
          generation: row.generation,
        },
      }
    : document;
}

function isLabelledCell(cellKey: string): boolean {
  return cellKey !== SCENARIO_PRESET_CELL_KEY;
}
