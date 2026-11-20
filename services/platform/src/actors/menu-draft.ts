import {
  MENU_DRAFT_SCHEMA,
  MenuDraftDoc,
  parseMenuDraftState,
  type MenuDraftCrdtError,
  type MenuDraftCrdtResult,
  type MenuDraftSnapshot,
  type MenuDraftStateVector,
  type MenuDraftUpdate,
  type MenuPresenceSelection,
} from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftServerMessage,
  FRAME_LIMIT,
  parseMenuDraftClientMessage,
  type MenuDraftClientMessage,
  type MenuDraftFailureCode,
  type MenuRoomMetadata,
} from "@purin-labs/menu-draft-crdt/protocol";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import type { SessionTurnExecution } from "../chat/turn-access";
import { controlError } from "../control/http";
import { resolveUser } from "../data/control-plane";
import type { Env } from "../env";
import type { UserId, OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  CollaborationRoom,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";
import { assertNever, sha256Hex } from "@purin-labs/std";
import { ToolRequestError } from "../agent-tools/errors";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";

const MENU_DRAFT_ID = "cafe-menu";
type StoredMenuDraft = Readonly<{ document: MenuDraftDoc; revision: number }>;
type MenuRoom = CollaborationRoom<
  MenuDraftUpdate,
  MenuDraftStateVector,
  MenuPresenceSelection,
  MenuRoomMetadata,
  MenuDraftFailureCode,
  MenuDraftDoc
>;

export type MenuDraftRead = Readonly<{
  documentId: typeof MENU_DRAFT_ID;
  revision: number;
  observedAt: number;
  draft: MenuDraftSnapshot;
}>;

/** A menu request that the model can correct. Its message reaches the model. */
export class MenuDraftRequestError extends ToolRequestError {}

/** One change that an agent makes to the shared menu. */
export type MenuDraftEdit =
  | Readonly<{ kind: "rename_menu"; title: string }>
  | Readonly<{ kind: "add_section"; title: string }>
  | Readonly<{
      kind: "add_item";
      productId: string;
      displayName: string;
      description: string;
      sectionId: string;
    }>
  | Readonly<{ kind: "rename_item"; itemId: string; displayName: string }>
  | Readonly<{ kind: "describe_item"; itemId: string; description: string }>
  | Readonly<{
      kind: "move_item";
      itemId: string;
      sectionId: string;
      order: number;
    }>
  | Readonly<{ kind: "remove_item"; itemId: string }>;

export type MenuDraftAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  edit: MenuDraftEdit;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;

export class MenuDraftRooms {
  readonly #rooms = new Map<OrganisationId, MenuRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    ctx.storage.transactionSync(
      createMenuDraftSchema.bind(null, ctx.storage.sql),
    );
  }

  /** The room of a socket that the Actor accepted, after a wake. */
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
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
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

  read(): MenuDraftCrdtResult<MenuDraftRead> {
    const stored = readMenuDraft(this.#storage.sql);
    if (!stored.ok) return stored;
    try {
      return { ok: true, value: menuRead(stored.value) };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * An agent's change of the menu, in the room that people edit. Open pages
   * show it at once. A repeated operation applies one time.
   */
  async edit(
    organisationId: OrganisationId,
    input: MenuDraftAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      MenuDraftRead,
      Readonly<{
        code:
          | MenuDraftCrdtError["code"]
          | "organisation_placement_conflict"
          | "access_revoked"
          | "room_full";
      }>
    >
  > {
    const created = this.#storage.transactionSync(
      initializeMenuDraft.bind(null, this.#storage.sql, input.userId),
    );
    if (!created.ok) return created;
    created.value.document.destroy();
    const operationId = await sha256Hex(input.operationId);
    const edited = await this.#room(organisationId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      applyMenuEdit.bind(null, this.#storage.sql, input, operationId),
      {
        agent: input.agent,
        operationId,
        target: menuEditTarget(input.edit),
      },
    );
    if (!edited.ok) return edited;
    return this.read();
  }

  review(authorized: AuthorizedOrganisationRequest): Response {
    const stored = readMenuDraft(this.#storage.sql);
    if (!stored.ok) return controlError(stored.error.code, 503);
    try {
      const reviewedAt = Date.now();
      const reviewId = crypto.randomUUID();
      const draft = stored.value.document.read();
      this.#storage.sql.exec(
        `INSERT INTO menu_draft_review
          (review_id, document_revision, snapshot_json, reviewed_by_app_user, reviewed_at)
         VALUES (?, ?, ?, ?, ?)`,
        reviewId,
        stored.value.revision,
        JSON.stringify(draft),
        authorized.authenticated.session.userId,
        reviewedAt,
      );
      return Response.json({
        ok: true,
        value: {
          reviewId,
          documentId: MENU_DRAFT_ID,
          documentRevision: stored.value.revision,
          reviewedAt,
          draft,
        },
      });
    } finally {
      stored.value.document.destroy();
    }
  }

  #room(organisationId: OrganisationId): MenuRoom {
    const existing = this.#rooms.get(organisationId);
    if (existing !== undefined) return existing;
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: MENU_ROOM_PROTOCOL,
      backing: new MenuDraftBacking(this.#storage),
      route: { kind: "menu_draft", key: organisationId },
      closeReason: "Menu draft disconnected",
      onEmpty: this.#remove.bind(this, organisationId),
    });
    this.#rooms.set(organisationId, room);
    return room;
  }

  #remove(organisationId: OrganisationId): void {
    this.#rooms.delete(organisationId);
  }
}

const MENU_ROOM_PROTOCOL: CollaborationRoomProtocol<
  MenuDraftUpdate,
  MenuDraftStateVector,
  MenuPresenceSelection,
  MenuRoomMetadata,
  MenuDraftFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseMenuRoomClientMessage,
  encodeServerMessage: encodeMenuRoomServerMessage,
};

class MenuDraftBacking implements CollaborationRoomBacking<
  MenuDraftDoc,
  MenuRoomMetadata,
  MenuDraftFailureCode
> {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, Readonly<{ code: MenuDraftFailureCode }>>> {
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    const initialized = this.#storage.transactionSync(
      initializeMenuDraft.bind(null, this.#storage.sql, userId),
    );
    if (initialized.ok) initialized.value.document.destroy();
    return initialized.ok ? { ok: true, value: null } : initialized;
  }

  readDocument(): MenuDraftCrdtResult<MenuDraftDoc> {
    const stored = readMenuDraft(this.#storage.sql);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    Result<
      Readonly<{
        document: MenuDraftDoc;
        metadata: MenuRoomMetadata;
      }>,
      Readonly<{ code: MenuDraftFailureCode }>
    >
  > {
    const stored = readMenuDraft(this.#storage.sql);
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
    this.#storage.sql.exec(
      `UPDATE menu_draft
       SET encoded_state = ?, revision = revision + 1, updated_by_app_user = ?, updated_at = ?
       WHERE singleton_id = ?`,
      state,
      userId,
      Date.now(),
      MENU_DRAFT_ID,
    );
  }
}

function parseMenuRoomClientMessage(
  frame: unknown,
): Result<MenuDraftClientMessage, Readonly<{ code: MenuDraftFailureCode }>> {
  return parseMenuDraftClientMessage(frame);
}

function encodeMenuRoomServerMessage(
  message: CollaborationRoomServerMessage<
    MenuDraftUpdate,
    MenuDraftStateVector,
    MenuPresenceSelection,
    MenuRoomMetadata,
    MenuDraftFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeMenuDraftServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "update_accepted":
    case "update_broadcast":
    case "presence_changed":
    case "failure":
      return encodeMenuDraftServerMessage(message);
    default:
      return assertNever(message);
  }
}

function menuEditTarget(edit: MenuDraftEdit): string {
  switch (edit.kind) {
    case "rename_menu":
    case "add_section":
      return "menu";
    case "add_item":
      return edit.sectionId;
    case "rename_item":
    case "describe_item":
    case "move_item":
    case "remove_item":
      return edit.itemId;
    default:
      return assertNever(edit);
  }
}

function applyMenuEdit(
  sql: SqlStorage,
  input: MenuDraftAgentEdit,
  operationId: string,
): MenuDraftCrdtResult<
  Readonly<{ value: null; update: MenuDraftUpdate | null }>
> {
  const stored = readMenuDraft(sql);
  if (!stored.ok) return stored;
  const document = stored.value.document;
  try {
    const update = menuEditUpdate(document, input.edit, operationId);
    if (!update.ok) return update;
    const state = document.state();
    if (!state.ok) return state;
    sql.exec(
      `UPDATE menu_draft
       SET encoded_state = ?, revision = revision + 1, updated_by_app_user = ?, updated_at = ?
       WHERE singleton_id = ?`,
      state.value.encode(),
      input.userId,
      Date.now(),
      MENU_DRAFT_ID,
    );
    return { ok: true, value: { value: null, update: update.value } };
  } finally {
    document.destroy();
  }
}

/** A new section or item takes its identity from the operation. */
function menuEditUpdate(
  document: MenuDraftDoc,
  edit: MenuDraftEdit,
  operationId: string,
): MenuDraftCrdtResult<MenuDraftUpdate> {
  const draft = document.read();
  switch (edit.kind) {
    case "rename_menu":
      return document.rename(edit.title);
    case "add_section":
      return document.addSection({
        id: `section_${operationId.slice(0, 32)}`,
        title: edit.title,
        order: nextOrder(draft.sections.map(orderOf)),
      });
    case "add_item":
      return document.addItem({
        id: `item_${operationId.slice(0, 32)}`,
        productId: edit.productId,
        displayName: edit.displayName,
        description: edit.description,
        placement: {
          sectionId: edit.sectionId,
          order: nextOrder(
            draft.items
              .filter((item) => item.placement.sectionId === edit.sectionId)
              .map((item) => item.placement.order),
          ),
        },
      });
    case "rename_item":
      return document.renameItem(edit.itemId, edit.displayName);
    case "describe_item":
      return document.describeItem(edit.itemId, edit.description);
    case "move_item":
      return document.moveItem(edit.itemId, {
        sectionId: edit.sectionId,
        order: edit.order,
      });
    case "remove_item":
      return document.deleteItem(edit.itemId);
    default:
      return assertNever(edit);
  }
}

function orderOf(section: Readonly<{ order: number }>): number {
  return section.order;
}

function nextOrder(orders: readonly number[]): number {
  return orders.reduce((highest, order) => Math.max(highest, order + 1), 0);
}

function createMenuDraftSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_draft (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'cafe-menu'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'menu_draft_crdt.v2'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 786432),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_draft_review (
    review_id TEXT PRIMARY KEY,
    document_revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    reviewed_by_app_user TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL
  )`);
}

function initializeMenuDraft(
  sql: SqlStorage,
  userId: UserId,
): MenuDraftCrdtResult<StoredMenuDraft> {
  const exists =
    sql
      .exec(
        "SELECT singleton_id FROM menu_draft WHERE singleton_id = ?",
        MENU_DRAFT_ID,
      )
      .toArray().length > 0;
  if (exists) return readMenuDraft(sql);
  const document = MenuDraftDoc.create();
  if (!document.ok) return document;
  const section = document.value.addSection({
    id: "section_main",
    title: "Menu",
    order: 0,
  });
  if (!section.ok) {
    document.value.destroy();
    return section;
  }
  try {
    const state = document.value.state();
    if (!state.ok) return state;
    const now = Date.now();
    sql.exec(
      `INSERT INTO menu_draft
        (singleton_id, schema_version, encoded_state, revision, updated_by_app_user, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      MENU_DRAFT_ID,
      MENU_DRAFT_SCHEMA,
      state.value.encode(),
      userId,
      now,
      now,
    );
  } finally {
    document.value.destroy();
  }
  return readMenuDraft(sql);
}

function readMenuDraft(sql: SqlStorage): MenuDraftCrdtResult<StoredMenuDraft> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, revision FROM menu_draft WHERE singleton_id = ?",
      MENU_DRAFT_ID,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== MENU_DRAFT_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    return { ok: false, error: { code: "invalid_state" } };
  }
  const state = parseMenuDraftState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const document = MenuDraftDoc.restore(state.value);
  return document.ok
    ? { ok: true, value: { document: document.value, revision: row.revision } }
    : document;
}

function menuRead(stored: StoredMenuDraft): MenuDraftRead {
  return {
    documentId: MENU_DRAFT_ID,
    revision: stored.revision,
    observedAt: Date.now(),
    draft: stored.document.read(),
  };
}
