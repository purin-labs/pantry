import React from "react";
import {
  parseMenuBoardVersions,
  type MenuBoardVersionSummary,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { controlAnswer, controlRead, controlWrite } from "../../control-client";
import { controlPath } from "../../control-paths";
import "./board-history.css";

/**
 * The version history of a board (Plan 40B phase 5, slice 7). A person
 * names the board as it is, or restores a saved version. A restore is one
 * edit of the shared draft that every open editor sees at once; it first
 * saves the draft as "Before a restore", so restoring that undoes it.
 * Screens change only when a person publishes.
 */

const VERSION_LABEL_LIMIT = 80;

type HistoryState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; versions: readonly MenuBoardVersionSummary[] }>
  | Readonly<{ kind: "failed" }>;

export function BoardHistoryPanel(props: Readonly<{
  organisationId: string;
  boardId: string;
  editable: boolean;
  /** The draft revision that the editor shows; a new one reads the list again. */
  documentRevision: number | null;
  onClose: () => void;
}>): React.ReactNode {
  const path = controlPath(props.organisationId, `menu-boards/${encodeURIComponent(props.boardId)}/versions`);
  const [history, setHistory] = React.useState<HistoryState>({ kind: "loading" });
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<Readonly<{ kind: "done" | "failed"; text: string }> | null>(null);
  React.useEffect(() => {
    let current = true;
    void versionRequest(path, "GET").then((read) => {
      if (current) setHistory(read.ok ? { kind: "ready", versions: read.versions } : { kind: "failed" });
    });
    return () => {
      current = false;
    };
  }, [path, props.documentRevision]);
  const run = async (key: string, target: string, body: Readonly<Record<string, unknown>>, done: string): Promise<boolean> => {
    setBusy(key);
    const answered = await versionRequest(target, "POST", { ...body, operationId: crypto.randomUUID().replaceAll("-", "") });
    setBusy(null);
    if (answered.ok) {
      setHistory({ kind: "ready", versions: answered.versions });
      setMessage({ kind: "done", text: done });
      return true;
    }
    setMessage({ kind: "failed", text: answered.message });
    return false;
  };
  const versions = history.kind === "ready" ? history.versions : [];
  return <aside className="menu-boards-drawer menu-board-history" aria-label="Board history">
    <header>
      <div>
        <span>Board</span>
        <h3>History</h3>
      </div>
      <button type="button" className="secondary" onClick={props.onClose}>Done</button>
    </header>
    {props.editable ? <form
      className="menu-board-history-save"
      onSubmit={(event) => {
        event.preventDefault();
        void run("save", path, { label: label.trim() }, "Version saved.").then((saved) => {
          if (saved) setLabel("");
        });
      }}
    >
      <label>
        <span>Name this version</span>
        <input value={label} maxLength={VERSION_LABEL_LIMIT} onChange={(event) => setLabel(event.target.value)} placeholder="Morning menu" />
      </label>
      <button type="submit" className="secondary" disabled={busy !== null || label.trim().length === 0}>Save version</button>
    </form> : null}
    {message === null ? null : <p className={message.kind === "failed" ? "description-draft-error" : "content-studio-published"} role={message.kind === "failed" ? "alert" : "status"}>
      {message.text}
    </p>}
    {history.kind === "failed" ? <p className="description-draft-error" role="alert">The history could not be loaded. Try again.</p> : null}
    <ol className="menu-board-history-list">
      {versions.map((version) => <li key={version.versionId} data-version-kind={version.kind}>
        <div>
          <strong>{versionName(version)}</strong>
          <span>
            {formatTime(version.createdAt)}
            {version.createdBy === null ? "" : ` · ${version.createdBy}`}
          </span>
        </div>
        {props.editable ? <button
          type="button"
          className="secondary"
          disabled={busy !== null}
          aria-label={`Restore ${versionName(version)}`}
          onClick={() => void run(
            version.versionId,
            `${path}/${encodeURIComponent(version.versionId)}/restore`,
            {},
            `Restored “${versionName(version)}”. To undo it, restore “Before a restore” at the top. Screens change when you publish.`,
          )}
        >
          {busy === version.versionId ? "Restoring…" : "Restore"}
        </button> : null}
      </li>)}
    </ol>
  </aside>;
}

function versionName(version: MenuBoardVersionSummary): string {
  switch (version.kind) {
    case "named":
      return version.label;
    case "published":
      return `Published: ${version.label}`;
    case "created":
      return "Board made";
    case "before_restore":
      return "Before a restore";
    case "auto":
      return "Saved automatically";
    default:
      return version.kind satisfies never;
  }
}

type VersionResponse =
  | Readonly<{ ok: true; versions: readonly MenuBoardVersionSummary[] }>
  | Readonly<{ ok: false; message: string }>;

async function versionRequest(path: string, method: "GET" | "POST", body?: unknown): Promise<VersionResponse> {
  const answer = await controlAnswer(method === "GET" ? controlRead(path) : controlWrite(path, method, body));
  const raw = answer.body;
  const versions = answer.ok && isRecord(raw) ? parseMenuBoardVersions(raw.versions) : null;
  if (versions !== null) return { ok: true, versions };
  const code = isRecord(raw) ? raw.error : undefined;
  return {
    ok: false,
    message: code === "organisation_role_insufficient"
      ? "Only staff, admins and owners can save or restore a version."
      : code === "menu_board_version_missing"
        ? "That version is no longer in the history."
        : "The history could not be changed. Try again.",
  };
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
