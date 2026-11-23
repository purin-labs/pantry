import React from "react";
import {
  isMenuScreenCode,
  parseMenuBoardSummaries,
  parseMenuScreenSummaries,
  type MenuBoardSummary,
  type MenuScreenSummary,
} from "@purin-labs/cafe-control-api";
import { isRecord } from "@purin-labs/std";
import { DialogHeading, cancelDialog, syncDialog } from "@purin-labs/ui/dialog";
import { Select } from "@purin-labs/ui/select";
import { Button } from "@purin-labs/ui/index";
import { controlAnswer, controlRead, controlWrite } from "@purin-labs/control/portal/control-client";
import { controlPath } from "@purin-labs/control/portal/control-paths";
import "./menu-boards.css";

/**
 * Menus › Screens (Plan 40B phase 1). A TV or a tablet opens `/tv`, which
 * shows a six-letter code. A member enters the code here and picks the
 * board that the screen plays. The list shows which screens are live; a
 * removed screen goes back to its code.
 */

type ScreensState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      screens: readonly MenuScreenSummary[];
      boards: readonly MenuBoardSummary[];
    }>
  | Readonly<{ kind: "failed" }>;

const REFRESH_MS = 15_000;

export function MenuScreensPanel(props: Readonly<{ organisationId: string }>): React.ReactNode {
  const [state, setState] = React.useState<ScreensState>({ kind: "loading" });
  const [pairing, setPairing] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const reload = React.useCallback(async () => {
    setState(await readScreens(props.organisationId));
  }, [props.organisationId]);
  React.useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const boards = state.kind === "ready" ? state.boards : [];
  const screens = state.kind === "ready" ? state.screens : [];
  const change = async (method: "PUT" | "DELETE", screenId: string, body?: unknown): Promise<void> => {
    const answer = await controlAnswer(
      controlWrite(controlPath(props.organisationId, `menu-screens/${encodeURIComponent(screenId)}`), method, body),
    );
    setMessage(answer.ok
      ? null
      : answer.status === 404
        ? "Only staff, admins and owners can change a screen."
        : "The screen could not be changed. Try again.");
    await reload();
  };
  // The sheet's title names the screens; each row says if it plays a saved copy.
  return <section className="menu-screens" aria-label="Screens">
    <header className="menu-screens-header">
      <button
        type="button"
        className="menu-boards-primary"
        disabled={boards.length === 0}
        onClick={() => setPairing(true)}
      >
        Add a screen
      </button>
    </header>
    {state.kind === "failed" ? <p className="description-draft-error" role="alert">
      The screens could not be loaded. Reload the page.
    </p> : null}
    {state.kind === "ready" && boards.length === 0 ? <p className="content-studio-menu-empty">
      Make a board first, then add the screen that plays it.
    </p> : null}
    {state.kind === "ready" && boards.length > 0 && screens.length === 0 ? <p className="content-studio-menu-empty">
      No screens yet.
    </p> : null}
    {message === null ? null : <p className="description-draft-error" role="alert">{message}</p>}
    {screens.length === 0 ? null : <ul className="menu-screens-list">
      {screens.map((screen) => <ScreenRow
        key={screen.screenId}
        screen={screen}
        boards={boards}
        onAssign={(boardId) => void change("PUT", screen.screenId, { boardId })}
        onRemove={() => void change("DELETE", screen.screenId)}
      />)}
    </ul>}
    <PairDialog
      open={pairing}
      organisationId={props.organisationId}
      boards={boards}
      onClose={() => setPairing(false)}
      onPaired={async () => {
        setPairing(false);
        await reload();
      }}
    />
  </section>;
}

function ScreenRow(props: Readonly<{
  screen: MenuScreenSummary;
  boards: readonly MenuBoardSummary[];
  onAssign: (boardId: string) => void;
  onRemove: () => void;
}>): React.ReactNode {
  const [confirming, setConfirming] = React.useState(false);
  const { screen } = props;
  return <li className="menu-screens-row">
    <div className="menu-screens-name">
      <strong>{screen.name}</strong>
      <span className="menu-screens-status" data-live={screen.connected ? "true" : "false"}>
        {screen.connected ? null : <span aria-hidden="true" />}
        {screenStatus(screen)}
      </span>
    </div>
    <Select.Root
      items={props.boards.map((board) => ({ value: board.boardId, label: board.title }))}
      value={screen.boardId}
      onValueChange={(value) => {
        if (value !== null) props.onAssign(value);
      }}
    >
      <Select.Trigger aria-label={`Board for ${screen.name}`}><Select.Value /></Select.Trigger>
      <Select.Popup>{props.boards.map((board) => <Select.Item key={board.boardId} value={board.boardId}>{board.title}</Select.Item>)}</Select.Popup>
    </Select.Root>
    {confirming ? <div className="menu-screens-confirm">
      <span>Remove {screen.name}? It goes back to its pairing code.</span>
      <Button variant="secondary" onClick={() => setConfirming(false)}>Keep</Button>
      <Button variant="danger" onClick={props.onRemove}>Remove</Button>
    </div> : <Button variant="secondary" onClick={() => setConfirming(true)}>Remove</Button>}
  </li>;
}

function PairDialog(props: Readonly<{
  open: boolean;
  organisationId: string;
  boards: readonly MenuBoardSummary[];
  onClose: () => void;
  onPaired: () => Promise<void>;
}>): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("Counter TV");
  const [boardId, setBoardId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => syncDialog(dialog, props.open), [props.open]);
  React.useEffect(() => {
    if (props.open) {
      setCode("");
      setError(null);
      setBoardId((current) => current.length > 0 ? current : props.boards[0]?.boardId ?? "");
    }
  }, [props.open, props.boards]);
  const normalized = code.trim().toUpperCase();
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const answer = await controlAnswer(
      controlWrite(controlPath(props.organisationId, "menu-screens"), "POST", { code: normalized, name: name.trim(), boardId }),
    );
    const raw = answer.body;
    setBusy(false);
    if (answer.ok) {
      await props.onPaired();
      return;
    }
    setError(pairFailure(isRecord(raw) ? raw.error : undefined));
  };
  return <dialog
    ref={dialog}
    className="menu-screens-dialog"
    aria-labelledby="menu-screens-pair-title"
    onCancel={cancelDialog.bind(null, props.onClose)}
  >
    <DialogHeading id="menu-screens-pair-title" title="Add a screen" close={props.onClose} />
    <form onSubmit={(event) => void submit(event)}>
      <p>On the TV or tablet, open <strong>{window.location.origin}/tv</strong> in its browser. It shows a six-letter code.</p>
      <label>
        <span>Code from the screen</span>
        <input
          className="menu-screens-code"
          value={code}
          maxLength={6}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </label>
      <label>
        <span>Name</span>
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label>
        <span>Board for this screen</span>
        <Select.Root items={props.boards.map((board) => ({ value: board.boardId, label: board.title }))} value={boardId} onValueChange={(value) => { if (value !== null) setBoardId(value); }}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{props.boards.map((board) => <Select.Item key={board.boardId} value={board.boardId}>{board.title}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
      {error === null ? null : <p className="description-draft-error" role="alert">{error}</p>}
      <div className="menu-screens-dialog-actions">
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <button
          type="submit"
          className="menu-boards-primary"
          disabled={busy || !isMenuScreenCode(normalized) || name.trim().length === 0 || boardId.length === 0}
        >
          {busy ? "Pairing…" : "Pair screen"}
        </button>
      </div>
    </form>
  </dialog>;
}

function pairFailure(code: unknown): string {
  switch (code) {
    case "menu_screen_code_unknown":
      return "No screen shows this code now. Check the code on the screen; a code lasts ten minutes.";
    case "menu_screen_code_used":
      return "This code paired a screen already. Open /tv again on the screen for a new code.";
    case "organisation_role_insufficient":
      return "Only staff, admins and owners can add a screen.";
    case "menu_screen_limit":
      return "This shop has 40 screens. Remove one before you add another.";
    case "menu_board_missing":
      return "This board no longer exists. Choose another board.";
    default:
      return "The screen could not be paired. Try again.";
  }
}

function screenStatus(screen: MenuScreenSummary): string {
  if (screen.connected) return "Live";
  if (screen.lastSeenAt === null) return "Not connected yet";
  const time = new Date(screen.lastSeenAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Offline since ${time} · shows its saved copy`;
}

async function readScreens(organisationId: string): Promise<ScreensState> {
  // A refusal's body has no list either: each read is used as it came.
  const [screensAnswer, boardsAnswer] = await Promise.all([
    controlAnswer(controlRead(controlPath(organisationId, "menu-screens"))),
    controlAnswer(controlRead(controlPath(organisationId, "menu-boards"))),
  ]);
  const screensRaw = screensAnswer.body;
  const boardsRaw = boardsAnswer.body;
  const screens = isRecord(screensRaw) ? parseMenuScreenSummaries(screensRaw.screens) : null;
  const boards = isRecord(boardsRaw) ? parseMenuBoardSummaries(boardsRaw.boards) : null;
  return screens === null || boards === null ? { kind: "failed" } : { kind: "ready", screens, boards };
}
