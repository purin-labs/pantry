import type { MenuBoardVersionSummary } from "@purin-labs/control-api";

import type { UserId } from "@purin-labs/control-api/ids";

/**
 * The version history of a board's draft (Plan 40B phase 5, slice 7). A
 * version is a frozen copy of the board's shared document. The Actor saves
 * one when a board is made, when a person names one, when a board is
 * published, before each restore, and before the first edit after ten quiet
 * minutes. A restore applies a version to the live draft as one new edit,
 * so people who edit the board at that moment keep their connection and see
 * the change at once.
 */

type MenuBoardVersionKind =
  | "created"
  | "named"
  | "published"
  | "before_restore"
  | "auto";

/** A board keeps at most this many versions. */
const MENU_BOARD_VERSION_LIMIT = 40;
/** An edit after this quiet time first saves the board as it was. */
const MENU_BOARD_AUTO_VERSION_MS = 10 * 60_000;
export const MENU_BOARD_VERSION_LABEL_LIMIT = 80;

export function createMenuBoardVersionSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS menu_board_version (
    board_id TEXT NOT NULL REFERENCES menu_board (board_id),
    version_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'named', 'published', 'before_restore', 'auto')),
    label TEXT NOT NULL CHECK (length(label) <= 80),
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 262144),
    created_by_user TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, version_id)
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS menu_board_version_time ON menu_board_version (board_id, created_at)",
  );
}

type MenuBoardVersionInput = Readonly<{
  boardId: string;
  versionId: string;
  kind: MenuBoardVersionKind;
  label: string;
  documentRevision: number;
  state: Uint8Array;
  userId: UserId;
  name: string;
  now: number;
}>;

/** Saves a version once: a version ID that exists keeps its first copy. */
export function saveMenuBoardVersion(
  sql: SqlStorage,
  input: MenuBoardVersionInput,
): void {
  sql.exec(
    `INSERT OR IGNORE INTO menu_board_version
      (board_id, version_id, kind, label, document_revision, encoded_state,
       created_by_user, created_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.boardId,
    input.versionId,
    input.kind,
    input.label.slice(0, MENU_BOARD_VERSION_LABEL_LIMIT),
    input.documentRevision,
    input.state,
    input.userId,
    input.name.slice(0, 256),
    input.now,
  );
  pruneMenuBoardVersions(sql, input.boardId);
}

/**
 * Before an edit, saves the stored board as an automatic version when the
 * newest version is older than ten minutes. It runs in the edit's own
 * transaction, before the edit writes the board.
 */
export function saveMenuBoardVersionBeforeEdit(
  sql: SqlStorage,
  boardId: string,
  userId: UserId,
  now: number,
): void {
  const newest = sql
    .exec<{ created_at: number }>(
      "SELECT max(created_at) AS created_at FROM menu_board_version WHERE board_id = ?",
      boardId,
    )
    .one().created_at;
  if (newest !== null && now - newest < MENU_BOARD_AUTO_VERSION_MS) return;
  const row = sql
    .exec<{ encoded_state: ArrayBuffer; revision: number }>(
      "SELECT encoded_state, revision FROM menu_board WHERE board_id = ?",
      boardId,
    )
    .toArray()[0];
  if (row === undefined) return;
  saveMenuBoardVersion(sql, {
    boardId,
    versionId: `version_auto_${row.revision}`,
    kind: "auto",
    label: "",
    documentRevision: row.revision,
    state: new Uint8Array(row.encoded_state),
    userId,
    name: "",
    now,
  });
}

/** The board's versions, newest first, without their copies. */
export function listMenuBoardVersions(
  sql: SqlStorage,
  boardId: string,
): MenuBoardVersionSummary[] {
  return sql
    .exec<{
      version_id: string;
      kind: MenuBoardVersionKind;
      label: string;
      document_revision: number;
      created_by_name: string;
      created_at: number;
    }>(
      `SELECT version_id, kind, label, document_revision, created_by_name, created_at
       FROM menu_board_version WHERE board_id = ?
       ORDER BY created_at DESC, document_revision DESC, version_id DESC`,
      boardId,
    )
    .toArray()
    .map((row) => ({
      versionId: row.version_id,
      kind: row.kind,
      label: row.label,
      documentRevision: row.document_revision,
      createdBy: row.created_by_name.length > 0 ? row.created_by_name : null,
      createdAt: row.created_at,
    }));
}

/** The frozen copy of one version, or null. */
export function readMenuBoardVersionState(
  sql: SqlStorage,
  boardId: string,
  versionId: string,
): Uint8Array | null {
  const row = sql
    .exec<{ encoded_state: ArrayBuffer }>(
      "SELECT encoded_state FROM menu_board_version WHERE board_id = ? AND version_id = ?",
      boardId,
      versionId,
    )
    .toArray()[0];
  return row === undefined ? null : new Uint8Array(row.encoded_state);
}

/**
 * Keeps the newest versions. The oldest automatic versions go first, then
 * the oldest of the others; the newest named version always stays.
 */
function pruneMenuBoardVersions(sql: SqlStorage, boardId: string): void {
  for (;;) {
    const count = sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM menu_board_version WHERE board_id = ?",
        boardId,
      )
      .one().count;
    if (count <= MENU_BOARD_VERSION_LIMIT) return;
    const oldest =
      sql
        .exec<{ version_id: string }>(
          `SELECT version_id FROM menu_board_version WHERE board_id = ? AND kind = 'auto'
           ORDER BY created_at, version_id LIMIT 1`,
          boardId,
        )
        .toArray()[0] ??
      sql
        .exec<{ version_id: string }>(
          `SELECT version_id FROM menu_board_version WHERE board_id = ?
             AND version_id NOT IN (
               SELECT version_id FROM menu_board_version
               WHERE board_id = ? AND kind = 'named'
               ORDER BY created_at DESC LIMIT 1)
           ORDER BY created_at, version_id LIMIT 1`,
          boardId,
          boardId,
        )
        .toArray()[0];
    if (oldest === undefined) return;
    sql.exec(
      "DELETE FROM menu_board_version WHERE board_id = ? AND version_id = ?",
      boardId,
      oldest.version_id,
    );
  }
}
