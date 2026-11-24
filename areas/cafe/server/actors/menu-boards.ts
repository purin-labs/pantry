import type {
  MenuBoardCommentThread,
  MenuBoardVersionSummary,
} from "@purin-labs/control-api";
import type {
  MenuBoardRelease,
  MenuBoardReleaseItem,
  MenuBoardReleaseSection,
  MenuBoardSummary,
} from "@purin-labs/cafe-control-api";
import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_LAYOUTS,
  isMenuBoardStyleValue,
  MENU_BOARD_SCHEMA,
  MenuBoardDoc,
  isMenuBoardId,
  isMenuBoardMediaId,
  isMenuBoardText,
  parseMenuBoardState,
  type MenuBoardCrdtResult,
  type MenuBoardElement,
  type MenuBoardElementProps,
  type MenuBoardFrameId,
  type MenuBoardImageFit,
  type MenuBoardItemRow,
  type MenuBoardStackAlign,
  type MenuBoardStackDirection,
  menuBoardCanvasRects,
  MENU_BOARD_SCREEN_SIZES,
  MENU_BOARD_TEXT_PROPS,
  layoutHasFrame,
  menuBoardElementProps,
  type MenuBoardLayout,
  type MenuBoardStart,
  type MenuBoardProductLook,
  menuBoardStartFits,
  menuBoardStartStyle,
  type MenuBoardPlacement,
  type MenuBoardPresenceSelection,
  type MenuBoardRect,
  type MenuBoardSnapshot,
  type MenuBoardStyle,
  type MenuBoardStyleToken,
  type MenuBoardStateVector,
  type MenuBoardUpdate,
} from "@purin-labs/menu-board-crdt";
import {
  encodeMenuBoardServerMessage,
  FRAME_LIMIT,
  parseMenuBoardClientMessage,
  type MenuBoardClientMessage,
  type MenuBoardFailureCode,
  type MenuBoardRoomMetadata,
} from "@purin-labs/menu-board-crdt/protocol";
import {
  isCollaborationAgentAction,
  type CollaborationAgent,
  type CollaborationAgentAction,
  type CollaborationAgentActivity,
} from "@purin-labs/collaboration";
import type { MenuDraftSnapshot } from "@purin-labs/menu-draft-crdt";
import { assertNever, canonicalJson, sha256Hex } from "@purin-labs/std";

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
import { templateElements } from "@purin-labs/menu-board-crdt/templates";
import {
  boardDraftAction,
  boardEditAction,
  type MenuBoardDraftEdit,
} from "./menu-board-agent-action";
import {
  addMenuBoardArchiveColumns,
  boardArchiveState,
  listArchivedBoards,
  writeBoardArchived,
  type ArchivedMenuBoard,
} from "./menu-board-archive";
import {
  addMenuBoardComment,
  createMenuBoardCommentSchema,
  deleteMenuBoardComment,
  listMenuBoardComments,
  resolveMenuBoardComment,
  type MenuBoardCommentAuthor,
  type MenuBoardCommentError,
} from "./menu-board-comments";
import {
  createMenuBoardVersionSchema,
  listMenuBoardVersions,
  readMenuBoardVersionState,
  saveMenuBoardVersion,
  saveMenuBoardVersionBeforeEdit,
  MENU_BOARD_VERSION_LABEL_LIMIT,
} from "./menu-board-versions";
import {
  CollaborationRoom,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "@purin-labs/collaboration/worker/collaboration-room";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The menu boards of an Organisation (Plan 40B phase 1). Each board is a
 * shared draft in its own Plan 40C room, keyed by its board ID. A member
 * publishes the draft revision that they saw as the board's next release:
 * the layout and elements, and the menu copy that they name, frozen with a
 * digest. A screen plays the newest release; later draft edits stay in the
 * draft.
 */

/** An Organisation has at most this many boards. */
const BOARD_LIMIT = 12;

type StoredBoard = Readonly<{ document: MenuBoardDoc; revision: number }>;
type BoardRoom = CollaborationRoom<
  MenuBoardUpdate,
  MenuBoardStateVector,
  MenuBoardPresenceSelection,
  MenuBoardRoomMetadata,
  MenuBoardFailureCode,
  MenuBoardDoc
>;

export type MenuBoardPublication = Result<
  Readonly<{ release: MenuBoardRelease; replayed: boolean }>,
  | Readonly<{ code: "menu_board_missing" | "menu_board_unavailable" }>
  | Readonly<{ code: "menu_board_changed"; documentRevision: number }>
  | Readonly<{
      code: "menu_board_release_conflict";
      releaseRevision: number | null;
    }>
  | Readonly<{ code: "menu_board_empty" | "menu_board_unplaced" }>
  | Readonly<{ code: "menu_board_media_unavailable" }>
  | Readonly<{
      code: "menu_board_binding_missing";
      elementIds: readonly string[];
    }>
>;

type MenuBoardCreation = Result<
  MenuBoardSummary,
  Readonly<{ code: "menu_board_limit" | "menu_board_unavailable" }>
>;


/**
 * One change that an agent makes to a board's draft (Plan 40B phase 4). It
 * never changes a price, stock or the board's release: a person publishes
 * the draft, and a price goes through an approved commerce action.
 */
export type MenuBoardEdit =
  | Readonly<{ kind: "rename_board"; title: string }>
  | Readonly<{
      kind: "set_text";
      elementId: string;
      prop: string;
      /** The text that the agent read; a different value now is a conflict. */
      before: string;
      text: string;
    }>
  | Readonly<{ kind: "set_featured_item"; elementId: string; itemId: string }>
  | Readonly<{
      kind: "add_text";
      frameId: MenuBoardFrameId;
      /** The rect on a free canvas; null in a fixed layout. */
      rect: MenuBoardRect | null;
      text: string;
    }>
  | Readonly<{
      /**
       * Plan 40B, the Products panel: one menu item as a product, in a
       * look, at a rect on a free canvas or at the end of a frame.
       */
      kind: "add_item";
      frameId: MenuBoardFrameId;
      rect: MenuBoardRect | null;
      itemId: string;
      look: MenuBoardProductLook;
    }>
  | Readonly<{
      /**
       * Plan 40B, the image element: an image of the shop's media library
       * on a free canvas.
       */
      kind: "add_image";
      rect: MenuBoardRect;
      mediaId: string;
      altText: string;
      fit: MenuBoardImageFit;
    }>
  | Readonly<{
      /** How one image fills its rect. */
      kind: "set_fit";
      elementId: string;
      fit: MenuBoardImageFit;
    }>
  | Readonly<{
      kind: "move_element";
      elementId: string;
      frameId: MenuBoardFrameId;
      order: number;
    }>
  | Readonly<{
      /** Plan 40B phase 5: moves or resizes an element on the free canvas. */
      kind: "place_on_canvas";
      elementId: string;
      rect: MenuBoardRect;
    }>
  | Readonly<{ kind: "remove_element"; elementId: string }>
  | Readonly<{
      /**
       * Plan 40B phase 5: the item-row variant of one section, or null for
       * the board's default.
       */
      kind: "set_row";
      elementId: string;
      row: MenuBoardItemRow | null;
    }>
  | Readonly<{
      /** Plan 40B, the Products panel: the look of one product. */
      kind: "set_look";
      elementId: string;
      look: MenuBoardProductLook;
    }>
  | MenuBoardStackEdit
  | Readonly<{
      /** Plan 40B phase 5: sets one style token, or clears it with null. */
      kind: "set_style";
      token: MenuBoardStyleToken;
      value: string | number | null;
    }>
  | MenuBoardCommentEdit
  | MenuBoardHistoryEdit;

/**
 * Plan 40B phase 5, slice 7: a named version of the board's draft, or a
 * restore of a version as one new edit of the draft. A restore first saves
 * the draft as it was, so that it can be undone by another restore.
 */
export type MenuBoardHistoryEdit =
  | Readonly<{ kind: "save_version"; label: string }>
  | Readonly<{ kind: "restore_version"; versionId: string }>;

/**
 * Plan 40B phase 5, slice 6: a comment on a board's element, a reply, or a
 * thread resolved or opened again. A comment changes no board document,
 * no release and no screen.
 */
/**
 * Plan 40B phase 5, slice 8: auto-layout stacks on the free canvas. A new
 * stack holds canvas elements in the given order; each keeps its size.
 */
export type MenuBoardStackSettings = Readonly<{
  direction: MenuBoardStackDirection;
  gap: number;
  padding: number;
  align: MenuBoardStackAlign;
}>;

export type MenuBoardStackEdit =
  | Readonly<{
      kind: "stack_elements";
      elementIds: readonly string[];
      settings: MenuBoardStackSettings;
    }>
  | Readonly<{ kind: "set_stack"; elementId: string; settings: MenuBoardStackSettings }>
  | Readonly<{ kind: "unstack"; elementId: string }>
  | Readonly<{ kind: "move_in_stack"; elementId: string; index: number }>;

/** An edit of the board's shared document. */
export type MenuBoardLayoutEdit = Exclude<
  MenuBoardEdit,
  MenuBoardCommentEdit | MenuBoardHistoryEdit
>;

type MenuBoardCommentEdit =
  | Readonly<{ kind: "add_comment"; elementId: string; text: string }>
  | Readonly<{ kind: "reply_comment"; commentId: string; text: string }>
  | Readonly<{ kind: "resolve_comment"; commentId: string; resolved: boolean }>;

export type MenuBoardAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  boardId: string;
  edit: MenuBoardEdit;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;

/**
 * The edit that an agent's model writes now (Plan 40B phase 7): `draft` is
 * null when the Session ends the preview without an edit.
 */
export type MenuBoardAgentPreview = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  boardId: string;
  previewId: string;
  draft: MenuBoardDraftEdit | null;
  userId: UserId;
  deadlineAt: number;
}>;

export type MenuBoardRead = Readonly<{
  boardId: string;
  documentRevision: number;
  board: MenuBoardSnapshot;
  /** Plan 40B phase 5, slice 6: the comment threads on its elements. */
  comments: readonly MenuBoardCommentThread[];
  /** Plan 40B phase 5, slice 7: its saved versions, newest first. */
  versions: readonly MenuBoardVersionSummary[];
  release: Readonly<{
    releaseRevision: number;
    documentRevision: number;
    publishedAt: number;
  }> | null;
}>;

/** The element that an edit touched, before and after; null where it was none. */
type MenuBoardChange = Readonly<{
  elementId: string | null;
  before: MenuBoardChangeSide | null;
  after: MenuBoardChangeSide | null;
}>;
type MenuBoardChangeSide =
  | Readonly<{ kind: "board"; title: string }>
  | Readonly<{ kind: "comment_thread"; thread: MenuBoardCommentThread }>
  | Readonly<{ kind: "version"; version: MenuBoardVersionSummary }>
  | Readonly<{ kind: "style"; style: MenuBoardStyle }>
  | (MenuBoardElementProps &
      Readonly<{ placement: MenuBoardElement["placement"] }>);

export type MenuBoardEditResult = MenuBoardRead &
  Readonly<{ change: MenuBoardChange }>;

export type MenuBoardEditError = Readonly<{
  code:
    | "menu_board_missing"
    | "menu_board_unavailable"
    | "menu_board_element_missing"
    | "menu_board_text_changed"
    | "menu_board_edit_invalid"
    | MenuBoardCommentError["code"]
    | "menu_board_version_missing"
    | "menu_board_version_invalid"
    | "organisation_placement_conflict"
    | "access_revoked"
    | "room_full";
  current?: string;
}>;

export type MenuBoardArchiveResult = Result<
  Readonly<{
    boardId: string;
    archived: boolean;
    /** The active boards after the change. */
    boards: number;
    archivedBoards: readonly ArchivedMenuBoard[];
  }>,
  Readonly<
    | { code: "menu_board_missing" | "menu_board_limit"; screens?: never }
    | { code: "menu_board_on_screen"; screens: number }
  >
>;

export class MenuBoardRooms {
  readonly #rooms = new Map<string, BoardRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    ctx.storage.transactionSync(
      createMenuBoardSchema.bind(null, ctx.storage.sql),
    );
    ctx.storage.transactionSync(
      addMenuBoardArchiveColumns.bind(null, ctx.storage.sql),
    );
    ctx.storage.transactionSync(
      createMenuBoardCommentSchema.bind(null, ctx.storage.sql),
    );
    ctx.storage.transactionSync(
      createMenuBoardVersionSchema.bind(null, ctx.storage.sql),
    );
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    key: string,
  ): CollaborationSocketRoom | null {
    return this.exists(key) ? this.#room(organisationId, key) : null;
  }

  exists(boardId: string): boolean {
    return (
      isMenuBoardId(boardId) &&
      this.#storage.sql
        .exec(
          "SELECT board_id FROM menu_board WHERE board_id = ? AND archived_at IS NULL",
          boardId,
        )
        .toArray().length > 0
    );
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    boardId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    if (!this.exists(boardId)) return controlError("menu_board_missing", 404);
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
    return this.#room(authorized.organisationId, boardId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  /** A board's draft as people edit it, with its newest release. */
  read(boardId: string): Result<MenuBoardRead, MenuBoardEditError> {
    if (!this.exists(boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const stored = readBoard(this.#storage.sql, boardId);
    if (!stored.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    try {
      const release = this.#latestReleaseRow(boardId);
      const board = stored.value.document.read();
      return {
        ok: true,
        value: {
          boardId,
          documentRevision: stored.value.revision,
          board,
          comments: listMenuBoardComments(
            this.#storage.sql,
            boardId,
            elementIds(board),
            null,
          ),
          versions: listMenuBoardVersions(this.#storage.sql, boardId),
          release:
            release === null
              ? null
              : {
                  releaseRevision: release.release_revision,
                  documentRevision: release.document_revision,
                  publishedAt: release.published_at,
                },
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * An agent's change of a board's draft, in the room that people edit. Open
   * board editors show it at once. A new element takes its ID from the
   * operation, so a repeated operation adds one element.
   */
  async edit(
    organisationId: OrganisationId,
    input: MenuBoardAgentEdit,
    menu: MenuDraftSnapshot,
    scope: OrganisationExecutionScope,
  ): Promise<Result<MenuBoardEditResult, MenuBoardEditError>> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const operationId = await sha256Hex(input.operationId);
    const edited = await this.#room(organisationId, input.boardId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      isCommentEdit(input.edit)
        ? applyAgentComment.bind(
            null,
            this.#storage.sql,
            input,
            input.edit,
            operationId,
          )
        : isHistoryEdit(input.edit)
          ? applyHistoryEdit.bind(null, this.#storage.sql, {
              boardId: input.boardId,
              edit: input.edit,
              operationId,
              userId: input.userId,
              name: input.agent.displayName,
            })
          : applyBoardEdit.bind(null, this.#storage.sql, input, menu, operationId),
      agentActivity(
        input.agent,
        operationId,
        boardEditTarget(input.edit),
        boardEditAction(
          input.edit,
          operationId,
          input.edit.kind === "place_on_canvas"
            ? this.#canvasRect(input.boardId, input.edit.elementId)
            : null,
        ),
      ),
    );
    if (!edited.ok) return edited;
    const read = this.read(input.boardId);
    return read.ok
      ? { ok: true, value: { ...read.value, change: edited.value } }
      : read;
  }

  /**
   * Shows an agent's board edit while its model writes it (Plan 40B phase
   * 7). The board and its draft do not change; the room shows the action to
   * the people on the board until the real edit takes its place.
   */
  async preview(
    organisationId: OrganisationId,
    input: MenuBoardAgentPreview,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, MenuBoardEditError>> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const room = this.#room(organisationId, input.boardId);
    const authority = {
      scope,
      origin: { kind: "session_turn" as const, execution: input.execution },
      userId: input.userId,
      deadlineAt: input.deadlineAt,
    };
    if (input.draft === null) {
      await room.endPreview(authority, input.agent.sessionId, input.previewId);
      return { ok: true, value: null };
    }
    const action = boardDraftAction(
      input.draft,
      input.draft.kind === "place_on_canvas" && input.draft.elementId !== null
        ? this.#canvasRect(input.boardId, input.draft.elementId)
        : null,
    );
    if (action === null) return { ok: true, value: null };
    if (!isCollaborationAgentAction(action))
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    return room.preview(authority, {
      agent: input.agent,
      operationId: input.previewId,
      target: action.elementIds[0] ?? "board",
      action,
    });
  }

  /** An element's rect on the stored board, or null. */
  #canvasRect(boardId: string, elementId: string): MenuBoardRect | null {
    const stored = readBoard(this.#storage.sql, boardId);
    if (!stored.ok) return null;
    try {
      return canvasRectsOf(stored.value.document.read()).get(elementId) ?? null;
    } finally {
      stored.value.document.destroy();
    }
  }

  /** The board's saved versions, newest first (slice 7). */
  versions(
    boardId: string,
  ): Result<readonly MenuBoardVersionSummary[], MenuBoardEditError> {
    return this.exists(boardId)
      ? { ok: true, value: listMenuBoardVersions(this.#storage.sql, boardId) }
      : { ok: false, error: { code: "menu_board_missing" } };
  }

  /**
   * A person's named version (slice 7) or restore, in the board's room, so
   * that a restore reaches every open editor as one update. The request's
   * operation ID makes a repeated request save or restore once.
   */
  async personHistoryEdit(
    organisationId: OrganisationId,
    scope: OrganisationExecutionScope,
    input: Readonly<{
      boardId: string;
      edit: MenuBoardHistoryEdit;
      operationId: string;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ): Promise<Result<readonly MenuBoardVersionSummary[], MenuBoardEditError>> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const identity = await resolveUser({ db: this.#env.DB, userId: input.userId });
    if (identity === null) return { ok: false, error: { code: "access_revoked" } };
    const operationId = await sha256Hex(
      JSON.stringify([input.userId, input.operationId]),
    );
    const done = await this.#room(organisationId, input.boardId).mutate(
      {
        scope,
        origin: {
          kind: "control_session",
          controlSessionId: input.controlSessionId,
        },
        userId: input.userId,
        deadlineAt: Date.now() + 30_000,
      },
      applyHistoryEdit.bind(null, this.#storage.sql, {
        boardId: input.boardId,
        edit: input.edit,
        operationId,
        userId: input.userId,
        name: identity.displayName,
      }),
    );
    return done.ok ? this.versions(input.boardId) : done;
  }

  /** The board's comment threads, as `viewer` reads them (slice 6). */
  comments(
    boardId: string,
    viewer: UserId,
  ): Result<readonly MenuBoardCommentThread[], MenuBoardEditError> {
    const read = this.#draftElements(boardId);
    return read.ok
      ? {
          ok: true,
          value: listMenuBoardComments(
            this.#storage.sql,
            boardId,
            read.value,
            viewer,
          ),
        }
      : read;
  }

  /**
   * A person's comment on an element, or a reply. The Actor names the
   * author from the person's own account. The request's operation ID makes
   * a repeated request add one comment.
   */
  async addComment(
    input: Readonly<{
      boardId: string;
      elementId: string | null;
      threadId: string | null;
      body: string;
      operationId: string;
      userId: UserId;
      now: number;
    }>,
  ): Promise<Result<readonly MenuBoardCommentThread[], MenuBoardEditError>> {
    const elements = this.#draftElements(input.boardId);
    if (!elements.ok) return elements;
    if (
      input.threadId === null &&
      (input.elementId === null || !elements.value.has(input.elementId))
    )
      return { ok: false, error: { code: "menu_board_element_missing" } };
    const identity = await resolveUser({ db: this.#env.DB, userId: input.userId });
    if (identity === null) return { ok: false, error: { code: "access_revoked" } };
    const commentId = `comment_${(
      await sha256Hex(JSON.stringify([input.userId, input.operationId]))
    ).slice(0, 20)}`;
    const added = this.#storage.transactionSync(() =>
      addMenuBoardComment(this.#storage.sql, {
        boardId: input.boardId,
        commentId,
        threadId: input.threadId,
        elementId: input.elementId,
        body: input.body,
        author: {
          kind: "person",
          userId: input.userId,
          name: identity.displayName.slice(0, 256),
        },
        now: input.now,
      }),
    );
    return added.ok ? this.comments(input.boardId, input.userId) : added;
  }

  async resolveComment(
    input: Readonly<{
      boardId: string;
      threadId: string;
      resolved: boolean;
      userId: UserId;
      now: number;
    }>,
  ): Promise<Result<readonly MenuBoardCommentThread[], MenuBoardEditError>> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const identity = await resolveUser({ db: this.#env.DB, userId: input.userId });
    if (identity === null) return { ok: false, error: { code: "access_revoked" } };
    const resolved = resolveMenuBoardComment(this.#storage.sql, {
      boardId: input.boardId,
      threadId: input.threadId,
      resolved: input.resolved,
      by: identity.displayName.slice(0, 256),
      now: input.now,
    });
    return resolved.ok ? this.comments(input.boardId, input.userId) : resolved;
  }

  deleteComment(
    input: Readonly<{ boardId: string; commentId: string; userId: UserId }>,
  ): Result<readonly MenuBoardCommentThread[], MenuBoardEditError> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const deleted = deleteMenuBoardComment(this.#storage.sql, input);
    return deleted.ok ? this.comments(input.boardId, input.userId) : deleted;
  }

  /** The IDs of the draft's elements, placed or not. */
  #draftElements(boardId: string): Result<Set<string>, MenuBoardEditError> {
    if (!this.exists(boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const stored = readBoard(this.#storage.sql, boardId);
    if (!stored.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    try {
      return { ok: true, value: elementIds(stored.value.document.read()) };
    } finally {
      stored.value.document.destroy();
    }
  }

  /** Every board, newest first, with its newest release. */
  list(screens: ReadonlyMap<string, number>): MenuBoardSummary[] {
    const rows = this.#storage.sql
      .exec<{
        board_id: string;
        title: string;
        layout: string;
        revision: number;
      }>(
        "SELECT board_id, title, layout, revision FROM menu_board WHERE archived_at IS NULL ORDER BY created_at DESC, board_id",
      )
      .toArray();
    return rows.flatMap((row) => {
      const layout = row.layout;
      if (!(layout in MENU_BOARD_LAYOUTS)) return [];
      const release = this.#latestReleaseRow(row.board_id);
      return [
        {
          boardId: row.board_id,
          title: row.title,
          layout: layout as MenuBoardLayout,
          documentRevision: row.revision,
          release:
            release === null
              ? null
              : {
                  releaseRevision: release.release_revision,
                  documentRevision: release.document_revision,
                  publishedAt: release.published_at,
                },
          screens: screens.get(row.board_id) ?? 0,
        },
      ];
    });
  }

  /**
   * Makes a board from a fixed layout, filled from the shop's menu draft: a
   * heading, one section list for each menu section that the layout's
   * columns hold, the first item as the featured item, and the order QR
   * code.
   */
  create(
    input: Readonly<{
      title: string;
      layout: MenuBoardLayout;
      /** How the board starts (the start screen); the template by default. */
      start?: MenuBoardStart;
      menu: MenuDraftSnapshot;
      userId: UserId;
      now: number;
    }>,
  ): MenuBoardCreation {
    const count = this.#storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM menu_board WHERE archived_at IS NULL",
      )
      .one().count;
    if (count >= BOARD_LIMIT)
      return { ok: false, error: { code: "menu_board_limit" } };
    const start = input.start ?? "template";
    // The route refuses a start that does not fit the layout.
    if (!menuBoardStartFits(start, input.layout))
      return { ok: false, error: { code: "menu_board_unavailable" } };
    const document = templateBoard(input.title, input.layout, input.menu, start);
    if (!document.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    try {
      const state = document.value.state();
      if (!state.ok)
        return { ok: false, error: { code: "menu_board_unavailable" } };
      const boardId = `board_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const snapshot = document.value.read();
      this.#storage.sql.exec(
        `INSERT INTO menu_board
          (board_id, schema_version, encoded_state, revision, title, layout,
           updated_by_app_user, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        boardId,
        MENU_BOARD_SCHEMA,
        state.value.encode(),
        snapshot.title,
        snapshot.layout,
        input.userId,
        input.now,
        input.now,
      );
      saveMenuBoardVersion(this.#storage.sql, {
        boardId,
        versionId: "version_created",
        kind: "created",
        label: "",
        documentRevision: 1,
        state: state.value.encode(),
        userId: input.userId,
        name: "",
        now: input.now,
      });
      return {
        ok: true,
        value: {
          boardId,
          title: snapshot.title,
          layout: snapshot.layout,
          documentRevision: 1,
          release: null,
          screens: 0,
        },
      };
    } finally {
      document.value.destroy();
    }
  }

  /**
   * Publishes the draft revision that the member saw as the board's next
   * release. A repeated request for a release that exists already answers
   * that release.
   */
  async publish(
    input: Readonly<{
      boardId: string;
      documentRevision: number;
      expectedReleaseRevision: number | null;
      menu: MenuDraftSnapshot;
      /** The shop's media address; a board with an image needs it. */
      mediaBase: () => Promise<string | null>;
      userId: UserId;
      now: number;
    }>,
  ): Promise<MenuBoardPublication> {
    if (!this.exists(input.boardId))
      return { ok: false, error: { code: "menu_board_missing" } };
    const latest = this.#latestReleaseRow(input.boardId);
    const nextRevision = (input.expectedReleaseRevision ?? 0) + 1;
    if (
      latest !== null &&
      latest.release_revision === nextRevision &&
      latest.document_revision === input.documentRevision &&
      latest.published_by_app_user === input.userId
    ) {
      const release = parseStoredRelease(latest.release_json);
      if (release !== null)
        return { ok: true, value: { release, replayed: true } };
    }
    if ((latest?.release_revision ?? null) !== input.expectedReleaseRevision)
      return {
        ok: false,
        error: {
          code: "menu_board_release_conflict",
          releaseRevision: latest?.release_revision ?? null,
        },
      };
    const stored = readBoard(this.#storage.sql, input.boardId);
    if (!stored.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    let snapshot: MenuBoardSnapshot;
    let publishedState: Uint8Array | null = null;
    try {
      if (stored.value.revision !== input.documentRevision)
        return {
          ok: false,
          error: {
            code: "menu_board_changed",
            documentRevision: stored.value.revision,
          },
        };
      snapshot = stored.value.document.read();
      const state = stored.value.document.state();
      if (state.ok) publishedState = state.value.encode();
    } finally {
      stored.value.document.destroy();
    }
    if (snapshot.unplaced.length > 0)
      return { ok: false, error: { code: "menu_board_unplaced" } };
    if (snapshot.elements.length === 0)
      return { ok: false, error: { code: "menu_board_empty" } };
    const copy = releaseCopy(snapshot, input.menu);
    if (!copy.ok) return copy;
    // Only a release with an image names where the shop serves its media.
    const hasImage = snapshot.elements.some((element) => element.kind === "image");
    const mediaBase = hasImage ? await input.mediaBase() : null;
    if (hasImage && mediaBase === null)
      return { ok: false, error: { code: "menu_board_media_unavailable" } };
    const content = {
      boardId: input.boardId,
      releaseRevision: nextRevision,
      publishedAt: input.now,
      title: snapshot.title,
      layout: snapshot.layout,
      style: snapshot.style,
      elements: snapshot.elements,
      sections: copy.value.sections,
      items: copy.value.items,
      ...(mediaBase === null ? {} : { mediaBase }),
    };
    const release: MenuBoardRelease = {
      ...content,
      digest: await sha256Hex(canonicalJson(content)),
    };
    this.#storage.sql.exec(
      `INSERT INTO menu_board_release
        (board_id, release_revision, document_revision, digest, release_json,
         published_by_app_user, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.boardId,
      release.releaseRevision,
      input.documentRevision,
      release.digest,
      JSON.stringify(release),
      input.userId,
      input.now,
    );
    if (publishedState !== null)
      saveMenuBoardVersion(this.#storage.sql, {
        boardId: input.boardId,
        versionId: `version_release_${release.releaseRevision}`,
        kind: "published",
        label: `Release ${release.releaseRevision}`,
        documentRevision: input.documentRevision,
        state: publishedState,
        userId: input.userId,
        name: "",
        now: input.now,
      });
    return { ok: true, value: { release, replayed: false } };
  }

  /** The newest release of a board, which its screens play. */
  latestRelease(boardId: string): MenuBoardRelease | null {
    const row = this.#latestReleaseRow(boardId);
    return row === null ? null : parseStoredRelease(row.release_json);
  }

  /**
   * Whether the newest release of a board names this image (Plan 40B, the
   * image element). Only such an image is public: a TV reads it with no
   * session, while a draft's image stays in the Portal.
   */
  namesPublishedMedia(mediaId: string): boolean {
    const rows = this.#storage.sql
      .exec<{ release_json: string }>(
        `SELECT release_json FROM menu_board_release AS release
         JOIN menu_board AS board ON board.board_id = release.board_id
         WHERE board.archived_at IS NULL AND release_revision = (
           SELECT MAX(newest.release_revision) FROM menu_board_release AS newest
           WHERE newest.board_id = release.board_id)`,
      )
      .toArray();
    return rows.some((row) => {
      const release = parseStoredRelease(row.release_json);
      return release?.elements.some(
        (element) => element.kind === "image" && element.mediaId === mediaId,
      ) ?? false;
    });
  }

  /**
   * The boards whose draft or newest release shows this image, archived
   * boards too. A person may delete a library image only when no board
   * shows it, so that no screen, no editor and no restore loses it.
   */
  boardsShowingMedia(mediaId: string): readonly string[] {
    const rows = this.#storage.sql
      .exec<{ board_id: string; title: string; archived_at: number | null }>(
        "SELECT board_id, title, archived_at FROM menu_board ORDER BY created_at, board_id",
      )
      .toArray()
      .map((row) => ({
        board_id: row.board_id,
        title: row.archived_at === null ? row.title : `${row.title} (archived)`,
      }));
    return rows.flatMap((row) => {
      const shows = (elements: readonly MenuBoardElement[] | undefined): boolean =>
        elements?.some((element) => element.kind === "image" && element.mediaId === mediaId) ?? false;
      if (shows(this.latestRelease(row.board_id)?.elements)) return [row.title];
      const stored = readBoard(this.#storage.sql, row.board_id);
      if (!stored.ok) return [];
      try {
        const board = stored.value.document.read();
        return shows([...board.elements, ...board.unplaced]) ? [row.title] : [];
      } finally {
        stored.value.document.destroy();
      }
    });
  }

  /**
   * Archives a board that no screen shows, or restores an archived board
   * (Plan 40B, board removal). Open editors of an archived board close.
   * A repeated request answers the same state.
   */
  async setArchived(
    input: Readonly<{
      organisationId: OrganisationId;
      boardId: string;
      archived: boolean;
      screens: number;
      userId: UserId;
      now: number;
    }>,
  ): Promise<MenuBoardArchiveResult> {
    const state = isMenuBoardId(input.boardId)
      ? boardArchiveState(this.#storage.sql, input.boardId)
      : "missing";
    if (state === "missing")
      return { ok: false, error: { code: "menu_board_missing" } };
    if (input.archived) {
      if (input.screens > 0)
        return {
          ok: false,
          error: { code: "menu_board_on_screen", screens: input.screens },
        };
      if (state === "active") {
        writeBoardArchived(this.#storage.sql, input.boardId, {
          at: input.now,
          userId: input.userId,
        });
        await this.#room(input.organisationId, input.boardId).end("access_revoked");
      }
    } else if (state === "archived") {
      const active = this.#storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM menu_board WHERE archived_at IS NULL",
        )
        .one().count;
      if (active >= BOARD_LIMIT)
        return { ok: false, error: { code: "menu_board_limit" } };
      writeBoardArchived(this.#storage.sql, input.boardId, null);
    }
    return {
      ok: true,
      value: {
        boardId: input.boardId,
        archived: input.archived,
        boards: this.list(new Map()).length,
        archivedBoards: listArchivedBoards(this.#storage.sql),
      },
    };
  }

  archivedBoards(): ArchivedMenuBoard[] {
    return listArchivedBoards(this.#storage.sql);
  }

  #latestReleaseRow(boardId: string): ReleaseRow | null {
    return (
      this.#storage.sql
        .exec<ReleaseRow>(
          `SELECT release_revision, document_revision, release_json,
                  published_by_app_user, published_at
           FROM menu_board_release WHERE board_id = ?
           ORDER BY release_revision DESC LIMIT 1`,
          boardId,
        )
        .toArray()[0] ?? null
    );
  }

  #room(organisationId: OrganisationId, boardId: string): BoardRoom {
    const existing = this.#rooms.get(boardId);
    if (existing !== undefined) return existing;
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: MENU_BOARD_ROOM_PROTOCOL,
      backing: new MenuBoardBacking(this.#storage, boardId),
      route: { kind: "menu_board", key: boardId },
      closeReason: "Menu board disconnected",
      onEmpty: this.#remove.bind(this, boardId),
    });
    this.#rooms.set(boardId, room);
    return room;
  }

  #remove(boardId: string): void {
    this.#rooms.delete(boardId);
  }
}

type ReleaseRow = Readonly<{
  release_revision: number;
  document_revision: number;
  release_json: string;
  published_by_app_user: string;
  published_at: number;
}>;

const MENU_BOARD_ROOM_PROTOCOL: CollaborationRoomProtocol<
  MenuBoardUpdate,
  MenuBoardStateVector,
  MenuBoardPresenceSelection,
  MenuBoardRoomMetadata,
  MenuBoardFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseBoardRoomClientMessage,
  encodeServerMessage: encodeBoardRoomServerMessage,
};

class MenuBoardBacking implements CollaborationRoomBacking<
  MenuBoardDoc,
  MenuBoardRoomMetadata,
  MenuBoardFailureCode
> {
  readonly #storage: DurableObjectStorage;
  readonly #boardId: string;

  constructor(storage: DurableObjectStorage, boardId: string) {
    this.#storage = storage;
    this.#boardId = boardId;
  }

  async initialize(
    _userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, Readonly<{ code: MenuBoardFailureCode }>>> {
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    const stored = readBoard(this.#storage.sql, this.#boardId);
    if (!stored.ok) return stored;
    stored.value.document.destroy();
    return { ok: true, value: null };
  }

  readDocument(): MenuBoardCrdtResult<MenuBoardDoc> {
    const stored = readBoard(this.#storage.sql, this.#boardId);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    Result<
      Readonly<{ document: MenuBoardDoc; metadata: MenuBoardRoomMetadata }>,
      Readonly<{ code: MenuBoardFailureCode }>
    >
  > {
    const stored = readBoard(this.#storage.sql, this.#boardId);
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

  /** Keeps the title and layout beside the state, for the board list. */
  persist(state: Uint8Array, userId: UserId): void {
    const parsed = parseMenuBoardState(state);
    const restored = parsed.ok ? MenuBoardDoc.restore(parsed.value) : parsed;
    if (!restored.ok) throw new Error("A persisted board must restore.");
    const snapshot = restored.value.read();
    restored.value.destroy();
    saveMenuBoardVersionBeforeEdit(
      this.#storage.sql,
      this.#boardId,
      userId,
      Date.now(),
    );
    this.#storage.sql.exec(
      `UPDATE menu_board
       SET encoded_state = ?, revision = revision + 1, title = ?, layout = ?,
           updated_by_app_user = ?, updated_at = ?
       WHERE board_id = ?`,
      state,
      snapshot.title,
      snapshot.layout,
      userId,
      Date.now(),
      this.#boardId,
    );
  }
}

function parseBoardRoomClientMessage(
  frame: unknown,
): Result<MenuBoardClientMessage, Readonly<{ code: MenuBoardFailureCode }>> {
  return parseMenuBoardClientMessage(frame);
}

function encodeBoardRoomServerMessage(
  message: CollaborationRoomServerMessage<
    MenuBoardUpdate,
    MenuBoardStateVector,
    MenuBoardPresenceSelection,
    MenuBoardRoomMetadata,
    MenuBoardFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeMenuBoardServerMessage({
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
      return encodeMenuBoardServerMessage(message);
    default:
      return assertNever(message);
  }
}

function createMenuBoardSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_board (
    board_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'menu_board_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 262144),
    revision INTEGER NOT NULL CHECK (revision > 0),
    title TEXT NOT NULL,
    layout TEXT NOT NULL,
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_board_release (
    board_id TEXT NOT NULL REFERENCES menu_board (board_id),
    release_revision INTEGER NOT NULL CHECK (release_revision > 0),
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    release_json TEXT NOT NULL,
    published_by_app_user TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, release_revision)
  )`);
}

function readBoard(
  sql: SqlStorage,
  boardId: string,
): MenuBoardCrdtResult<StoredBoard> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, revision FROM menu_board WHERE board_id = ?",
      boardId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== MENU_BOARD_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    return { ok: false, error: { code: "invalid_state" } };
  const state = parseMenuBoardState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const document = MenuBoardDoc.restore(state.value);
  return document.ok
    ? { ok: true, value: { document: document.value, revision: row.revision } }
    : document;
}

function parseStoredRelease(json: string): MenuBoardRelease | null {
  try {
    return JSON.parse(json) as MenuBoardRelease;
  } catch {
    return null;
  }
}

/**
 * The menu copy that a release carries: each bound section with its items,
 * and the featured items. An element that names a section or an item that
 * the menu draft no longer has blocks the release.
 */
function releaseCopy(
  board: MenuBoardSnapshot,
  menu: MenuDraftSnapshot,
): Result<
  Readonly<{
    sections: readonly MenuBoardReleaseSection[];
    items: readonly MenuBoardReleaseItem[];
  }>,
  Readonly<{
    code: "menu_board_binding_missing";
    elementIds: readonly string[];
  }>
> {
  const missing: string[] = [];
  const sections: MenuBoardReleaseSection[] = [];
  const itemIds = new Set<string>();
  for (const element of board.elements) {
    if (element.kind === "section") {
      const section = menu.sections.find(
        (candidate) => candidate.id === element.sectionId,
      );
      if (section === undefined) {
        missing.push(element.id);
        continue;
      }
      if (sections.some((known) => known.sectionId === section.id)) continue;
      const ids = menu.items
        .filter((item) => item.placement.sectionId === section.id)
        .map((item) => item.id);
      for (const id of ids) itemIds.add(id);
      sections.push({
        sectionId: section.id,
        title: section.title,
        itemIds: ids,
      });
    } else if (element.kind === "featured") {
      if (menu.items.some((item) => item.id === element.itemId))
        itemIds.add(element.itemId);
      else missing.push(element.id);
    }
  }
  if (missing.length > 0)
    return {
      ok: false,
      error: { code: "menu_board_binding_missing", elementIds: missing },
    };
  const items = menu.items
    .filter((item) => itemIds.has(item.id))
    .map((item) => ({
      itemId: item.id,
      name: item.displayName,
      description: item.description,
    }));
  return { ok: true, value: { sections, items } };
}

/** A new board from a layout and the shop's menu draft. */
function templateBoard(
  title: string,
  layout: MenuBoardLayout,
  menu: MenuDraftSnapshot,
  start: MenuBoardStart,
): MenuBoardCrdtResult<MenuBoardDoc> {
  const created = MenuBoardDoc.create(title, layout);
  if (!created.ok) return created;
  // A designed menu starts with its style preset and item row.
  const style = menuBoardStartStyle(start);
  if (style !== null) {
    const styled = created.value.setStyle(style);
    if (!styled.ok) {
      created.value.destroy();
      return styled;
    }
  }
  return addTemplateElements(
    created.value,
    templateElements(title, layout, menu, start),
  );
}

function addTemplateElements(
  document: MenuBoardDoc,
  elements: readonly MenuBoardElement[],
): MenuBoardCrdtResult<MenuBoardDoc> {
  for (const element of elements) {
    const added = document.addElement(element);
    if (!added.ok) {
      document.destroy();
      return added;
    }
  }
  return { ok: true, value: document };
}

/**
 * The agent's activity in the room. An action that the wire refuses (it
 * cannot, by its construction) leaves the activity as it was before phase 7.
 */
function agentActivity(
  agent: CollaborationAgent,
  operationId: string,
  target: string,
  action: CollaborationAgentAction,
): CollaborationAgentActivity {
  return isCollaborationAgentAction(action)
    ? { agent, operationId, target, action }
    : { agent, operationId, target };
}

function boardEditTarget(edit: MenuBoardEdit): string {
  switch (edit.kind) {
    case "rename_board":
    case "add_text":
    case "add_item":
    case "add_image":
    case "set_style":
    case "reply_comment":
    case "resolve_comment":
    case "save_version":
    case "restore_version":
      return "board";
    case "stack_elements":
      return "board";
    case "set_stack":
    case "unstack":
    case "move_in_stack":
    case "add_comment":
    case "set_text":
    case "set_featured_item":
    case "move_element":
    case "place_on_canvas":
    case "set_row":
    case "set_look":
    case "set_fit":
    case "remove_element":
      return edit.elementId;
    default:
      return assertNever(edit);
  }
}

function isCommentEdit(edit: MenuBoardEdit): edit is MenuBoardCommentEdit {
  return (
    edit.kind === "add_comment" ||
    edit.kind === "reply_comment" ||
    edit.kind === "resolve_comment"
  );
}

function isHistoryEdit(edit: MenuBoardEdit): edit is MenuBoardHistoryEdit {
  return edit.kind === "save_version" || edit.kind === "restore_version";
}

/**
 * A named version, or a restore (slice 7), in the room's queue. A restore
 * saves the stored board first as "Before restore", then applies the
 * version as one edit of the live draft. Both take their IDs from the
 * operation, so a repeated operation saves one version and restores once.
 */
function applyHistoryEdit(
  sql: SqlStorage,
  input: Readonly<{
    boardId: string;
    edit: MenuBoardHistoryEdit;
    operationId: string;
    userId: UserId;
    name: string;
  }>,
): BoardEditOutcome {
  const stored = readBoard(sql, input.boardId);
  if (!stored.ok)
    return { ok: false, error: { code: "menu_board_unavailable" } };
  const document = stored.value.document;
  const now = Date.now();
  const summary = (versionId: string): MenuBoardVersionSummary | null =>
    listMenuBoardVersions(sql, input.boardId).find(
      (version) => version.versionId === versionId,
    ) ?? null;
  try {
    const current = document.state();
    if (!current.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    if (input.edit.kind === "save_version") {
      const label = input.edit.label.trim();
      if (label.length === 0 || label.length > MENU_BOARD_VERSION_LABEL_LIMIT)
        return { ok: false, error: { code: "menu_board_version_invalid" } };
      const versionId = `version_${input.operationId.slice(0, 20)}`;
      saveMenuBoardVersion(sql, {
        boardId: input.boardId,
        versionId,
        kind: "named",
        label,
        documentRevision: stored.value.revision,
        state: current.value.encode(),
        userId: input.userId,
        name: input.name,
        now,
      });
      const saved = summary(versionId);
      return {
        ok: true,
        value: {
          value: {
            elementId: null,
            before: null,
            after: saved === null ? null : { kind: "version", version: saved },
          },
          update: null,
        },
      };
    }
    const bytes = readMenuBoardVersionState(
      sql,
      input.boardId,
      input.edit.versionId,
    );
    const parsed = bytes === null ? null : parseMenuBoardState(bytes);
    const target = parsed?.ok === true ? MenuBoardDoc.restore(parsed.value) : null;
    if (target === null || !target.ok)
      return { ok: false, error: { code: "menu_board_version_missing" } };
    let snapshot: MenuBoardSnapshot;
    try {
      snapshot = target.value.read();
    } finally {
      target.value.destroy();
    }
    const beforeId = `version_before_${input.operationId.slice(0, 16)}`;
    saveMenuBoardVersion(sql, {
      boardId: input.boardId,
      versionId: beforeId,
      kind: "before_restore",
      label: "",
      documentRevision: stored.value.revision,
      state: current.value.encode(),
      userId: input.userId,
      name: input.name,
      now,
    });
    const restoredFrom = summary(input.edit.versionId);
    const before = summary(beforeId);
    const change: MenuBoardChange = {
      elementId: null,
      before: before === null ? null : { kind: "version", version: before },
      after:
        restoredFrom === null ? null : { kind: "version", version: restoredFrom },
    };
    const update = document.restoreTo(snapshot);
    if (!update.ok) {
      // The draft already equals the version: a repeated restore.
      if (update.error.code === "record_conflict")
        return { ok: true, value: { value: change, update: null } };
      return crdtRefusal(update.error.code);
    }
    const state = document.state();
    if (!state.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    const restored = document.read();
    sql.exec(
      `UPDATE menu_board
       SET encoded_state = ?, revision = revision + 1, title = ?, layout = ?,
           updated_by_app_user = ?, updated_at = ?
       WHERE board_id = ?`,
      state.value.encode(),
      restored.title,
      restored.layout,
      input.userId,
      now,
      input.boardId,
    );
    return { ok: true, value: { value: change, update: update.value } };
  } finally {
    document.destroy();
  }
}

function elementIds(board: MenuBoardSnapshot): Set<string> {
  return new Set(
    [...board.elements, ...board.unplaced].map((element) => element.id),
  );
}

/**
 * An agent's comment (slice 6), in the room's queue with the agent's
 * admission. The comment takes its ID from the operation, so a repeated
 * operation adds one comment. The author is the agent, for the person.
 */
function applyAgentComment(
  sql: SqlStorage,
  input: MenuBoardAgentEdit,
  edit: MenuBoardCommentEdit,
  operationId: string,
): BoardEditOutcome {
  const stored = readBoard(sql, input.boardId);
  if (!stored.ok)
    return { ok: false, error: { code: "menu_board_unavailable" } };
  let onBoard: Set<string>;
  try {
    onBoard = elementIds(stored.value.document.read());
  } finally {
    stored.value.document.destroy();
  }
  const threadOf = (threadId: string): MenuBoardCommentThread | undefined =>
    listMenuBoardComments(sql, input.boardId, onBoard, null).find(
      (thread) =>
        thread.threadId === threadId ||
        thread.comments.some((comment) => comment.commentId === threadId),
    );
  const author: MenuBoardCommentAuthor = {
    kind: "agent",
    userId: input.userId,
    name: input.agent.displayName.slice(0, 256),
  };
  const now = Date.now();
  if (edit.kind === "resolve_comment") {
    const before = threadOf(edit.commentId);
    if (before === undefined)
      return { ok: false, error: { code: "menu_board_comment_missing" } };
    const resolved = resolveMenuBoardComment(sql, {
      boardId: input.boardId,
      threadId: before.threadId,
      resolved: edit.resolved,
      by: author.name,
      now,
    });
    if (!resolved.ok) return resolved;
    const after = threadOf(before.threadId);
    return {
      ok: true,
      value: {
        value: {
          elementId: before.elementId,
          before: { kind: "comment_thread", thread: before },
          after: after === undefined ? null : { kind: "comment_thread", thread: after },
        },
        update: null,
      },
    };
  }
  if (edit.kind === "add_comment" && !onBoard.has(edit.elementId))
    return { ok: false, error: { code: "menu_board_element_missing" } };
  const before =
    edit.kind === "reply_comment" ? threadOf(edit.commentId) : undefined;
  if (edit.kind === "reply_comment" && before === undefined)
    return { ok: false, error: { code: "menu_board_comment_missing" } };
  const added = addMenuBoardComment(sql, {
    boardId: input.boardId,
    commentId: `comment_${operationId.slice(0, 20)}`,
    threadId: before?.threadId ?? null,
    elementId: edit.kind === "add_comment" ? edit.elementId : null,
    body: edit.text,
    author,
    now,
  });
  if (!added.ok) return added;
  const after = threadOf(added.value.threadId);
  return {
    ok: true,
    value: {
      value: {
        elementId: after?.elementId ?? null,
        before:
          before === undefined || added.value.replayed
            ? null
            : { kind: "comment_thread", thread: before },
        after: after === undefined ? null : { kind: "comment_thread", thread: after },
      },
      update: null,
    },
  };
}

function changeSide(element: MenuBoardElement): MenuBoardChangeSide {
  return { ...menuBoardElementProps(element), placement: element.placement };
}

function boardElement(
  snapshot: MenuBoardSnapshot,
  elementId: string,
): MenuBoardElement | undefined {
  return [...snapshot.elements, ...snapshot.unplaced].find(
    (element) => element.id === elementId,
  );
}

type BoardEditOutcome = Result<
  Readonly<{ value: MenuBoardChange; update: MenuBoardUpdate | null }>,
  MenuBoardEditError
>;

function applyBoardEdit(
  sql: SqlStorage,
  input: MenuBoardAgentEdit,
  menu: MenuDraftSnapshot,
  operationId: string,
): BoardEditOutcome {
  const stored = readBoard(sql, input.boardId);
  if (!stored.ok)
    return { ok: false, error: { code: "menu_board_unavailable" } };
  const document = stored.value.document;
  const edit = input.edit;
  if (isCommentEdit(edit) || isHistoryEdit(edit))
    return { ok: false, error: { code: "menu_board_edit_invalid" } };
  try {
    const planned = boardEditUpdate(document, edit, menu, operationId);
    if (!planned.ok || planned.value.update === null) return planned;
    const state = document.state();
    if (!state.ok)
      return { ok: false, error: { code: "menu_board_unavailable" } };
    const snapshot = document.read();
    saveMenuBoardVersionBeforeEdit(sql, input.boardId, input.userId, Date.now());
    sql.exec(
      `UPDATE menu_board
       SET encoded_state = ?, revision = revision + 1, title = ?, layout = ?,
           updated_by_app_user = ?, updated_at = ?
       WHERE board_id = ?`,
      state.value.encode(),
      snapshot.title,
      snapshot.layout,
      input.userId,
      Date.now(),
      input.boardId,
    );
    return { ok: true, value: planned.value };
  } finally {
    document.destroy();
  }
}

/**
 * Checks the values that the edit touches again at admission (Plan 40B):
 * the element must still be there, and a text edit must start from the text
 * that the agent read. Then it applies the edit.
 */
function boardEditUpdate(
  document: MenuBoardDoc,
  edit: MenuBoardLayoutEdit,
  menu: MenuDraftSnapshot,
  operationId: string,
): BoardEditOutcome {
  const snapshot = document.read();
  if (edit.kind === "rename_board") {
    const update = document.rename(edit.title);
    if (!update.ok) return crdtRefusal(update.error.code);
    return {
      ok: true,
      value: {
        value: {
          elementId: null,
          before: { kind: "board", title: snapshot.title },
          after: { kind: "board", title: document.read().title },
        },
        update: update.value,
      },
    };
  }
  if (edit.kind === "set_style") {
    const before = snapshot.style;
    if (edit.value !== null && !isMenuBoardStyleValue(edit.token, edit.value))
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    if ((before[edit.token] ?? null) === edit.value)
      return {
        ok: true,
        value: {
          value: {
            elementId: null,
            before: { kind: "style", style: before },
            after: { kind: "style", style: before },
          },
          update: null,
        },
      };
    const update = document.setStyle({ [edit.token]: edit.value });
    if (!update.ok) return crdtRefusal(update.error.code);
    return {
      ok: true,
      value: {
        value: {
          elementId: null,
          before: { kind: "style", style: before },
          after: { kind: "style", style: document.read().style },
        },
        update: update.value,
      },
    };
  }
  if (edit.kind === "add_item") {
    const canvas = MENU_BOARD_LAYOUTS[snapshot.layout].canvas;
    if (
      !layoutHasFrame(snapshot.layout, edit.frameId) ||
      canvas !== (edit.rect !== null) ||
      !menu.items.some((item) => item.id === edit.itemId)
    )
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    const id = `element_${operationId.slice(0, 16)}`;
    const existing = boardElement(snapshot, id);
    if (existing !== undefined)
      return {
        ok: true,
        value: {
          value: { elementId: id, before: null, after: changeSide(existing) },
          update: null,
        },
      };
    const order = snapshot.elements
      .filter((element) => element.placement.frameId === edit.frameId)
      .reduce(
        (highest, element) => Math.max(highest, element.placement.order + 1),
        0,
      );
    const placement: MenuBoardPlacement =
      edit.rect !== null
        ? {
            frameId: "canvas",
            order,
            rect: edit.rect,
            constraints: MENU_BOARD_DEFAULT_CONSTRAINTS,
          }
        : edit.frameId === "canvas"
          ? { frameId: "column_1", order }
          : { frameId: edit.frameId, order };
    const added = document.addElement({
      id,
      kind: "featured",
      placement,
      itemId: edit.itemId,
      label: "",
      note: "",
      look: edit.look,
    });
    if (!added.ok) return crdtRefusal(added.error.code);
    const after = boardElement(document.read(), id);
    return {
      ok: true,
      value: {
        value: {
          elementId: id,
          before: null,
          after: after === undefined ? null : changeSide(after),
        },
        update: added.value,
      },
    };
  }
  if (edit.kind === "add_image") {
    if (
      !MENU_BOARD_LAYOUTS[snapshot.layout].canvas ||
      !isMenuBoardMediaId(edit.mediaId) ||
      !isMenuBoardText(edit.altText)
    )
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    const id = `element_${operationId.slice(0, 16)}`;
    const existing = boardElement(snapshot, id);
    if (existing !== undefined)
      return {
        ok: true,
        value: {
          value: { elementId: id, before: null, after: changeSide(existing) },
          update: null,
        },
      };
    const order = snapshot.elements
      .filter((element) => element.placement.frameId === "canvas")
      .reduce(
        (highest, element) => Math.max(highest, element.placement.order + 1),
        0,
      );
    const added = document.addElement({
      id,
      kind: "image",
      placement: {
        frameId: "canvas",
        order,
        rect: edit.rect,
        constraints: MENU_BOARD_DEFAULT_CONSTRAINTS,
      },
      mediaId: edit.mediaId,
      altText: edit.altText,
      fit: edit.fit,
    });
    if (!added.ok) return crdtRefusal(added.error.code);
    const after = boardElement(document.read(), id);
    return {
      ok: true,
      value: {
        value: {
          elementId: id,
          before: null,
          after: after === undefined ? null : changeSide(after),
        },
        update: added.value,
      },
    };
  }
  if (edit.kind === "add_text") {
    const canvas = MENU_BOARD_LAYOUTS[snapshot.layout].canvas;
    if (
      !layoutHasFrame(snapshot.layout, edit.frameId) ||
      canvas !== (edit.rect !== null)
    )
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    const id = `element_${operationId.slice(0, 16)}`;
    const existing = boardElement(snapshot, id);
    if (existing !== undefined)
      return {
        ok: true,
        value: {
          value: { elementId: id, before: null, after: changeSide(existing) },
          update: null,
        },
      };
    const order = snapshot.elements
      .filter((element) => element.placement.frameId === edit.frameId)
      .reduce(
        (highest, element) => Math.max(highest, element.placement.order + 1),
        0,
      );
    const placement: MenuBoardPlacement =
      edit.rect !== null
        ? {
            frameId: "canvas",
            order,
            rect: edit.rect,
            constraints: MENU_BOARD_DEFAULT_CONSTRAINTS,
          }
        : edit.frameId === "canvas"
          ? { frameId: "column_1", order }
          : { frameId: edit.frameId, order };
    const added = document.addElement({
      id,
      kind: "text",
      placement,
      text: edit.text,
    });
    if (!added.ok) return crdtRefusal(added.error.code);
    const after = boardElement(document.read(), id);
    return {
      ok: true,
      value: {
        value: {
          elementId: id,
          before: null,
          after: after === undefined ? null : changeSide(after),
        },
        update: added.value,
      },
    };
  }
  if (edit.kind === "stack_elements")
    return stackEditUpdate(document, snapshot, edit, operationId);
  const element = boardElement(snapshot, edit.elementId);
  if (element === undefined)
    return { ok: false, error: { code: "menu_board_element_missing" } };
  const before = changeSide(element);
  if (edit.kind === "unstack") {
    if (element.kind !== "stack")
      return { ok: false, error: { code: "menu_board_edit_invalid" } };
    const rects = canvasRectsOf(snapshot);
    const placements = [...snapshot.elements, ...snapshot.unplaced].flatMap(
      (child) => {
        const rect = rects.get(child.id);
        return child.placement.frameId === "stack" &&
          child.placement.stackId === element.id &&
          rect !== undefined
          ? [
              {
                elementId: child.id,
                placement: {
                  frameId: "canvas" as const,
                  order:
                    element.placement.frameId === "canvas"
                      ? element.placement.order
                      : 0,
                  rect,
                  constraints: MENU_BOARD_DEFAULT_CONSTRAINTS,
                },
              },
            ]
          : [];
      },
    );
    const update = document.unstackElements(element.id, placements);
    if (!update.ok) return crdtRefusal(update.error.code);
    return {
      ok: true,
      value: {
        value: { elementId: element.id, before, after: null },
        update: update.value,
      },
    };
  }
  let update: MenuBoardCrdtResult<MenuBoardUpdate>;
  switch (edit.kind) {
    case "set_text": {
      if (!MENU_BOARD_TEXT_PROPS[element.kind].includes(edit.prop))
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      const current = (element as unknown as Record<string, string>)[edit.prop];
      // The text is already what the agent asked for: a repeated edit.
      if (current === edit.text)
        return {
          ok: true,
          value: {
            value: { elementId: element.id, before, after: before },
            update: null,
          },
        };
      if (current !== edit.before)
        return {
          ok: false,
          error: { code: "menu_board_text_changed", current: current ?? "" },
        };
      update = document.updateElement(element.id, { [edit.prop]: edit.text });
      break;
    }
    case "set_featured_item":
      if (
        element.kind !== "featured" ||
        !menu.items.some((item) => item.id === edit.itemId)
      )
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      if (element.itemId === edit.itemId)
        return {
          ok: true,
          value: {
            value: { elementId: element.id, before, after: before },
            update: null,
          },
        };
      update = document.updateElement(element.id, { itemId: edit.itemId });
      break;
    case "move_element":
      if (
        edit.frameId === "canvas" ||
        !layoutHasFrame(snapshot.layout, edit.frameId)
      )
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      update = document.moveElement(element.id, {
        frameId: edit.frameId,
        order: edit.order,
      });
      break;
    case "set_row":
      if (element.kind !== "section")
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      if ((element.row ?? null) === edit.row)
        return {
          ok: true,
          value: {
            value: { elementId: element.id, before, after: before },
            update: null,
          },
        };
      update = document.updateElement(element.id, { row: edit.row ?? "" });
      break;
    case "set_look":
      if (element.kind !== "featured")
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      if ((element.look ?? "card") === edit.look)
        return {
          ok: true,
          value: {
            value: { elementId: element.id, before, after: before },
            update: null,
          },
        };
      update = document.updateElement(element.id, { look: edit.look });
      break;
    case "set_fit":
      if (element.kind !== "image")
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      if (element.fit === edit.fit)
        return {
          ok: true,
          value: {
            value: { elementId: element.id, before, after: before },
            update: null,
          },
        };
      update = document.updateElement(element.id, { fit: edit.fit });
      break;
    case "place_on_canvas":
      if (!MENU_BOARD_LAYOUTS[snapshot.layout].canvas)
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      update = document.moveElement(element.id, {
        frameId: "canvas",
        order:
          element.placement.frameId === "canvas"
            ? element.placement.order
            : nextCanvasOrder(snapshot),
        rect: edit.rect,
        constraints:
          element.placement.frameId === "canvas"
            ? element.placement.constraints
            : MENU_BOARD_DEFAULT_CONSTRAINTS,
      });
      break;
    case "set_stack":
      if (element.kind !== "stack")
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      update = document.updateElement(element.id, stackProps(edit.settings));
      break;
    case "move_in_stack": {
      if (element.placement.frameId !== "stack")
        return { ok: false, error: { code: "menu_board_edit_invalid" } };
      const stackId = element.placement.stackId;
      const siblings = [...snapshot.elements, ...snapshot.unplaced]
        .filter(
          (child) =>
            child.placement.frameId === "stack" &&
            child.placement.stackId === stackId &&
            child.id !== element.id,
        )
        .sort(
          (first, second) =>
            first.placement.order - second.placement.order ||
            first.id.localeCompare(second.id),
        );
      const index = Math.min(edit.index, siblings.length);
      siblings.splice(index, 0, element);
      update = document.placeElements(
        siblings.flatMap((child, order) =>
          child.placement.frameId === "stack"
            ? [{ elementId: child.id, placement: { ...child.placement, order } }]
            : [],
        ),
      );
      break;
    }
    case "remove_element":
      update = document.removeElement(element.id);
      if (!update.ok) return crdtRefusal(update.error.code);
      return {
        ok: true,
        value: {
          value: { elementId: element.id, before, after: null },
          update: update.value,
        },
      };
    default:
      return assertNever(edit);
  }
  if (!update.ok) {
    // An edit that changes nothing is no conflict: answer the same element.
    if (update.error.code === "record_conflict")
      return {
        ok: true,
        value: {
          value: { elementId: element.id, before, after: before },
          update: null,
        },
      };
    return crdtRefusal(update.error.code);
  }
  const after = boardElement(document.read(), element.id);
  return {
    ok: true,
    value: {
      value: {
        elementId: element.id,
        before,
        after: after === undefined ? null : changeSide(after),
      },
      update: update.value,
    },
  };
}

function stackProps(settings: MenuBoardStackSettings): Record<string, string> {
  return {
    direction: settings.direction,
    gap: String(settings.gap),
    padding: String(settings.padding),
    align: settings.align,
  };
}

/** Each element's rect as the board's shape draws it, stacks placed. */
function canvasRectsOf(snapshot: MenuBoardSnapshot): Map<string, MenuBoardRect> {
  const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[snapshot.layout].shape];
  return menuBoardCanvasRects(
    [...snapshot.elements, ...snapshot.unplaced],
    size,
    size,
  );
}

/**
 * A new stack (slice 8) around canvas elements, in the order that the agent
 * gave: its rect is their bounds, and each keeps its size. The stack takes
 * its ID from the operation, so a repeated operation makes one stack.
 */
function stackEditUpdate(
  document: MenuBoardDoc,
  snapshot: MenuBoardSnapshot,
  edit: Variant<MenuBoardStackEdit, "stack_elements">,
  operationId: string,
): BoardEditOutcome {
  const id = `element_${operationId.slice(0, 16)}`;
  const existing = boardElement(snapshot, id);
  if (existing !== undefined)
    return {
      ok: true,
      value: {
        value: { elementId: id, before: null, after: changeSide(existing) },
        update: null,
      },
    };
  if (!MENU_BOARD_LAYOUTS[snapshot.layout].canvas)
    return { ok: false, error: { code: "menu_board_edit_invalid" } };
  const members = edit.elementIds.map((elementId) =>
    boardElement(snapshot, elementId),
  );
  if (members.some((member) => member === undefined))
    return { ok: false, error: { code: "menu_board_element_missing" } };
  const placed = members.flatMap((member) =>
    member !== undefined &&
    member.kind !== "stack" &&
    member.placement.frameId === "canvas"
      ? [{ id: member.id, order: member.placement.order, rect: member.placement.rect }]
      : [],
  );
  if (placed.length !== edit.elementIds.length)
    return { ok: false, error: { code: "menu_board_edit_invalid" } };
  const left = Math.min(...placed.map(({ rect }) => rect.x));
  const top = Math.min(...placed.map(({ rect }) => rect.y));
  const right = Math.max(...placed.map(({ rect }) => rect.x + rect.width));
  const bottom = Math.max(...placed.map(({ rect }) => rect.y + rect.height));
  const vertical = edit.settings.direction === "vertical";
  const pad = 2 * edit.settings.padding;
  const gaps = edit.settings.gap * (placed.length - 1);
  // The stack holds its elements one after another, so its length along
  // its direction is their sum with the gaps and the padding.
  const length =
    placed.reduce(
      (sum, { rect }) => sum + (vertical ? rect.height : rect.width),
      0,
    ) +
    gaps +
    pad;
  const rect: MenuBoardRect = {
    x: left,
    y: top,
    width: vertical ? right - left + pad : length,
    height: vertical ? length : bottom - top + pad,
  };
  const stack: MenuBoardElement = {
    id,
    kind: "stack",
    placement: {
      frameId: "canvas",
      order: Math.min(...placed.map(({ order }) => order)),
      rect,
      constraints: MENU_BOARD_DEFAULT_CONSTRAINTS,
    },
    ...(stackProps(edit.settings) as {
      direction: MenuBoardStackDirection;
      gap: string;
      padding: string;
      align: MenuBoardStackAlign;
    }),
  };
  const update = document.stackElements(
    stack,
    placed.map((member, order) => ({
      elementId: member.id,
      placement: {
        frameId: "stack",
        stackId: id,
        order,
        size: { width: member.rect.width, height: member.rect.height },
      },
    })),
  );
  if (!update.ok) return crdtRefusal(update.error.code);
  const after = boardElement(document.read(), id);
  return {
    ok: true,
    value: {
      value: {
        elementId: id,
        before: null,
        after: after === undefined ? null : changeSide(after),
      },
      update: update.value,
    },
  };
}

function nextCanvasOrder(snapshot: MenuBoardSnapshot): number {
  return [...snapshot.elements, ...snapshot.unplaced].reduce(
    (highest, element) => Math.max(highest, element.placement.order + 1),
    0,
  );
}

function crdtRefusal(code: string): Result<never, MenuBoardEditError> {
  return {
    ok: false,
    error: {
      code:
        code === "text_too_long" ||
        code === "collection_limit" ||
        code === "invalid_document_shape"
          ? "menu_board_edit_invalid"
          : "menu_board_unavailable",
    },
  };
}
