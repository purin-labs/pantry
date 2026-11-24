import type { UserId } from "@purin-labs/control-api/ids";
import { addMissingColumn } from "@purin-labs/actor-runtime/actors/schema-migrations";
import type { ArchivedMenuBoard } from "@purin-labs/area-cafe-contract/server/menu-board-commands";

/**
 * Archived menu boards (Plan 40B, board removal). An owner or admin archives
 * a board that no screen shows; it leaves the board list, its editor and the
 * screen picker, and its image stops being public. Restore brings it back
 * with its draft, versions, comments and releases. Nothing is deleted, so an
 * archive is always undone.
 */

/** Adds the archive columns to a board table from before board removal. */
export function addMenuBoardArchiveColumns(sql: SqlStorage): void {
  addMissingColumn(sql, "menu_board", "archived_at", "INTEGER");
  addMissingColumn(sql, "menu_board", "archived_by_app_user", "TEXT");
}

/** Whether a board row exists, and whether it is archived. */
export function boardArchiveState(
  sql: SqlStorage,
  boardId: string,
): "active" | "archived" | "missing" {
  const row = sql
    .exec<{ archived_at: number | null }>(
      "SELECT archived_at FROM menu_board WHERE board_id = ?",
      boardId,
    )
    .toArray()[0];
  if (row === undefined) return "missing";
  return row.archived_at === null ? "active" : "archived";
}

export function writeBoardArchived(
  sql: SqlStorage,
  boardId: string,
  archived: Readonly<{ at: number; userId: UserId }> | null,
): void {
  sql.exec(
    "UPDATE menu_board SET archived_at = ?, archived_by_app_user = ? WHERE board_id = ?",
    archived?.at ?? null,
    archived?.userId ?? null,
    boardId,
  );
}

/** The archived boards, newest archive first. */
export function listArchivedBoards(sql: SqlStorage): ArchivedMenuBoard[] {
  return sql
    .exec<{ board_id: string; title: string; archived_at: number }>(
      `SELECT board_id, title, archived_at FROM menu_board
       WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, board_id`,
    )
    .toArray()
    .map((row) => ({
      boardId: row.board_id,
      title: row.title,
      archivedAt: row.archived_at,
    }));
}
