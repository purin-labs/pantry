import type { MenuBoardCommentThread } from "@purin-labs/control-api";
import { normalizePlainText } from "@purin-labs/collaboration";

import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * Comments pinned to a board's elements (Plan 40B phase 5, slice 6). A
 * thread starts on one element; replies follow it. The Actor stamps the
 * author and the time, so a person cannot write a comment in another
 * person's name. Comments live beside the board, not in its shared
 * document: a release never carries them, and no screen shows them.
 */

/** A board holds at most this many comments, replies included. */
const MENU_BOARD_COMMENT_LIMIT = 300;
/** A comment holds at most this many characters. */
const MENU_BOARD_COMMENT_TEXT_LIMIT = 1000;

export type MenuBoardCommentAuthor = Readonly<{
  kind: "person" | "agent";
  /** The person, or the person for whom the agent works. */
  userId: UserId;
  name: string;
}>;

export type MenuBoardCommentError = Readonly<{
  code:
    | "menu_board_comment_missing"
    | "menu_board_comment_limit"
    | "menu_board_comment_invalid"
    | "menu_board_comment_not_author";
}>;

type CommentRow = Readonly<{
  comment_id: string;
  thread_id: string;
  element_id: string;
  body: string;
  author_kind: string;
  author_user: string;
  author_name: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by_name: string | null;
}>;

export function createMenuBoardCommentSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_board_comment (
    board_id TEXT NOT NULL REFERENCES menu_board (board_id),
    comment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
    author_user TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by_name TEXT,
    PRIMARY KEY (board_id, comment_id)
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS menu_board_comment_thread ON menu_board_comment (board_id, thread_id, created_at)",
  );
}

/** A comment text, normalized, or null when it is empty or too long. */
function menuBoardCommentText(text: string): string | null {
  const normalized = normalizePlainText(text).trim();
  return normalized.length === 0 ||
    normalized.length > MENU_BOARD_COMMENT_TEXT_LIMIT
    ? null
    : normalized;
}

/**
 * The board's threads, oldest first, each with its replies. `viewer` marks
 * the comments that the reader wrote, so the Portal offers to delete them.
 * `onBoard` names the elements that the draft still has.
 */
export function listMenuBoardComments(
  sql: SqlStorage,
  boardId: string,
  onBoard: ReadonlySet<string>,
  viewer: UserId | null,
): MenuBoardCommentThread[] {
  const rows = sql
    .exec<CommentRow>(
      `SELECT comment_id, thread_id, element_id, body, author_kind, author_user,
              author_name, created_at, resolved_at, resolved_by_name
       FROM menu_board_comment WHERE board_id = ?
       ORDER BY created_at, comment_id`,
      boardId,
    )
    .toArray();
  const threads = new Map<string, MenuBoardCommentThread>();
  for (const row of rows) {
    const comment = {
      commentId: row.comment_id,
      body: row.body,
      author: {
        kind: row.author_kind === "agent" ? ("agent" as const) : ("person" as const),
        name: row.author_name,
      },
      mine: viewer !== null && row.author_kind === "person" && row.author_user === viewer,
      createdAt: row.created_at,
    };
    if (row.comment_id === row.thread_id) {
      threads.set(row.thread_id, {
        threadId: row.thread_id,
        elementId: row.element_id,
        onBoard: onBoard.has(row.element_id),
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by_name,
        comments: [comment],
      });
      continue;
    }
    const thread = threads.get(row.thread_id);
    if (thread !== undefined)
      threads.set(row.thread_id, {
        ...thread,
        comments: [...thread.comments, comment],
      });
  }
  return [...threads.values()];
}

/**
 * Adds a thread on an element, or a reply to a thread. A comment ID that
 * exists already answers that comment's thread, so a repeated request adds
 * one comment.
 */
export function addMenuBoardComment(
  sql: SqlStorage,
  input: Readonly<{
    boardId: string;
    commentId: string;
    /** Null for a new thread on `elementId`. */
    threadId: string | null;
    elementId: string | null;
    body: string;
    author: MenuBoardCommentAuthor;
    now: number;
  }>,
): Result<Readonly<{ threadId: string; replayed: boolean }>, MenuBoardCommentError> {
  const existing = sql
    .exec<{ thread_id: string }>(
      "SELECT thread_id FROM menu_board_comment WHERE board_id = ? AND comment_id = ?",
      input.boardId,
      input.commentId,
    )
    .toArray()[0];
  if (existing !== undefined)
    return { ok: true, value: { threadId: existing.thread_id, replayed: true } };
  const body = menuBoardCommentText(input.body);
  if (body === null)
    return { ok: false, error: { code: "menu_board_comment_invalid" } };
  const count = sql
    .exec<{ count: number }>(
      "SELECT count(*) AS count FROM menu_board_comment WHERE board_id = ?",
      input.boardId,
    )
    .one().count;
  if (count >= MENU_BOARD_COMMENT_LIMIT)
    return { ok: false, error: { code: "menu_board_comment_limit" } };
  let threadId = input.commentId;
  let elementId = input.elementId;
  if (input.threadId !== null) {
    const root = sql
      .exec<{ element_id: string }>(
        "SELECT element_id FROM menu_board_comment WHERE board_id = ? AND comment_id = ? AND thread_id = comment_id",
        input.boardId,
        input.threadId,
      )
      .toArray()[0];
    if (root === undefined)
      return { ok: false, error: { code: "menu_board_comment_missing" } };
    threadId = input.threadId;
    elementId = root.element_id;
  }
  if (elementId === null)
    return { ok: false, error: { code: "menu_board_comment_invalid" } };
  sql.exec(
    `INSERT INTO menu_board_comment
      (board_id, comment_id, thread_id, element_id, body, author_kind,
       author_user, author_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.boardId,
    input.commentId,
    threadId,
    elementId,
    body,
    input.author.kind,
    input.author.userId,
    input.author.name,
    input.now,
  );
  // A reply opens a resolved thread again, as in Figma.
  if (input.threadId !== null)
    sql.exec(
      "UPDATE menu_board_comment SET resolved_at = NULL, resolved_by_name = NULL WHERE board_id = ? AND comment_id = ?",
      input.boardId,
      threadId,
    );
  return { ok: true, value: { threadId, replayed: false } };
}

/** Resolves a thread, or opens it again. Any editor of the board may. */
export function resolveMenuBoardComment(
  sql: SqlStorage,
  input: Readonly<{
    boardId: string;
    threadId: string;
    resolved: boolean;
    by: string;
    now: number;
  }>,
): Result<null, MenuBoardCommentError> {
  const root = sql
    .exec<{ resolved_at: number | null }>(
      "SELECT resolved_at FROM menu_board_comment WHERE board_id = ? AND comment_id = ? AND thread_id = comment_id",
      input.boardId,
      input.threadId,
    )
    .toArray()[0];
  if (root === undefined)
    return { ok: false, error: { code: "menu_board_comment_missing" } };
  // A thread that is already in that state keeps its first resolution.
  if ((root.resolved_at !== null) === input.resolved)
    return { ok: true, value: null };
  sql.exec(
    "UPDATE menu_board_comment SET resolved_at = ?, resolved_by_name = ? WHERE board_id = ? AND comment_id = ?",
    input.resolved ? input.now : null,
    input.resolved ? input.by : null,
    input.boardId,
    input.threadId,
  );
  return { ok: true, value: null };
}

/**
 * Deletes a person's own comment. A deleted first comment takes its whole
 * thread with it. An agent's comment has no author to delete it; a person
 * resolves its thread instead.
 */
export function deleteMenuBoardComment(
  sql: SqlStorage,
  input: Readonly<{ boardId: string; commentId: string; userId: UserId }>,
): Result<null, MenuBoardCommentError> {
  const row = sql
    .exec<{ thread_id: string; author_kind: string; author_user: string }>(
      "SELECT thread_id, author_kind, author_user FROM menu_board_comment WHERE board_id = ? AND comment_id = ?",
      input.boardId,
      input.commentId,
    )
    .toArray()[0];
  if (row === undefined)
    return { ok: false, error: { code: "menu_board_comment_missing" } };
  if (row.author_kind !== "person" || row.author_user !== input.userId)
    return { ok: false, error: { code: "menu_board_comment_not_author" } };
  if (row.thread_id === input.commentId)
    sql.exec(
      "DELETE FROM menu_board_comment WHERE board_id = ? AND thread_id = ?",
      input.boardId,
      input.commentId,
    );
  else
    sql.exec(
      "DELETE FROM menu_board_comment WHERE board_id = ? AND comment_id = ?",
      input.boardId,
      input.commentId,
    );
  return { ok: true, value: null };
}
