import React from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { isRecord } from "@purin-labs/std";
import { controlAnswer, controlWrite } from "../../control-client";
import { controlPath } from "../../control-paths";
import "./board-archive.css";

/**
 * Board removal (Plan 40B): an owner or admin archives a board that no
 * screen shows, and restores it from the Archived list. An archive deletes
 * nothing: the draft, versions, comments and releases come back with it.
 */

export type ArchivedBoard = Readonly<{ boardId: string; title: string; archivedAt: number }>;

export function parseArchivedBoards(raw: unknown): readonly ArchivedBoard[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) =>
    isRecord(item) && typeof item.boardId === "string" && typeof item.title === "string" &&
      typeof item.archivedAt === "number"
      ? [{ boardId: item.boardId, title: item.title, archivedAt: item.archivedAt }]
      : []);
}

type Outcome = Readonly<{ ok: true } | { ok: false; message: string }>;

async function setArchived(organisationId: string, boardId: string, archived: boolean): Promise<Outcome> {
  const answer = await controlAnswer(controlWrite(
    controlPath(organisationId, `menu-boards/${encodeURIComponent(boardId)}/archive`),
    "POST",
    { archived },
  ));
  if (answer.ok) return { ok: true };
  const error = isRecord(answer.body) ? answer.body.error : undefined;
  switch (error) {
    case "menu_board_on_screen":
      return { ok: false, message: "A screen shows this board. Show another board on that screen first." };
    case "menu_board_limit":
      return { ok: false, message: "The shop has 12 boards. Archive one before you restore another." };
    case "organisation_role_insufficient":
      return { ok: false, message: "Only owners and admins can archive or restore a board." };
    default:
      return answer.status === 404 || answer.status === 403
        ? { ok: false, message: "Only owners and admins can archive or restore a board." }
        : { ok: false, message: "The board could not be changed. Try again." };
  }
}

/** Archives the open board, under the board list. */
export function ArchiveBoardButton(props: Readonly<{
  organisationId: string;
  boardId: string;
  title: string;
  screens: number;
  onArchived: () => Promise<void>;
}>): React.ReactNode {
  const [state, setState] = React.useState<"idle" | "busy" | Readonly<{ message: string }>>("idle");
  const onScreen = props.screens > 0;
  return <div className="menu-board-archive">
    <button
      type="button"
      className="menu-board-text-button"
      disabled={state === "busy" || onScreen}
      title={onScreen ? "A screen shows this board. Show another board on that screen first." : undefined}
      onClick={async () => {
        setState("busy");
        const outcome = await setArchived(props.organisationId, props.boardId, true);
        if (!outcome.ok) {
          setState({ message: outcome.message });
          return;
        }
        setState("idle");
        await props.onArchived();
      }}
    >
      <Archive size={14} aria-hidden="true" />
      {`Archive ${props.title}`}
    </button>
    {onScreen ? <p className="menu-boards-drawer-note">A screen shows this board, so it cannot be archived.</p> : null}
    {typeof state === "object" ? <p className="description-draft-error" role="alert">{state.message}</p> : null}
  </div>;
}

/** The archived boards, each with Restore. */
export function ArchivedBoards(props: Readonly<{
  organisationId: string;
  boards: readonly ArchivedBoard[];
  onRestored: (boardId: string) => Promise<void>;
}>): React.ReactNode {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  if (props.boards.length === 0) return null;
  return <section className="menu-board-panel-section menu-boards-archived" aria-label="Archived boards">
    <header><h3>Archived</h3></header>
    <ul>
      {props.boards.map((board) => <li key={board.boardId}>
        <span>{board.title}</span>
        <button
          type="button"
          className="menu-board-text-button"
          aria-label={`Restore ${board.title}`}
          disabled={busy !== null}
          onClick={async () => {
            setBusy(board.boardId);
            const outcome = await setArchived(props.organisationId, board.boardId, false);
            setBusy(null);
            if (!outcome.ok) {
              setMessage(outcome.message);
              return;
            }
            setMessage(null);
            await props.onRestored(board.boardId);
          }}
        >
          <ArchiveRestore size={14} aria-hidden="true" />
          Restore
        </button>
      </li>)}
    </ul>
    {message === null ? null : <p className="description-draft-error" role="alert">{message}</p>}
  </section>;
}
