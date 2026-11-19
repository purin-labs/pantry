import React from "react";
import {
  MENU_BOARD_DESIGNS,
  MENU_BOARD_STYLE_PRESETS,
  MENU_BOARD_TEXT_LIMIT,
  type MenuBoardDesign,
  type MenuBoardLayout,
  type MenuBoardStart,
} from "@purin-labs/menu-board-crdt/board";
import { isRecord } from "@purin-labs/std";
import { controlAnswer, controlWrite } from "../../control-client";
import { controlPath } from "./menu-board-requests";
import "./start-board.css";

/**
 * The start screen of a new board (Plan 40B). The person picks a blank
 * canvas, a layout or a designed menu, and names the board. Every start is
 * a landscape board: the canvas's constraints and screen guides fit it to a
 * portrait TV and a tablet, and the toolbar's Layout changes it later. A
 * designed menu is a free canvas with a style preset, filled from the
 * shop's menu on the server, so that the agent's menu_board_create makes
 * the same board.
 */

type Option = Readonly<{
  layout: MenuBoardLayout;
  start: MenuBoardStart;
  name: string;
  detail: string;
  /** How the card draws its picture. */
  picture: "blank" | "canvas" | "three" | "featured" | "pickup" | MenuBoardDesign;
}>;

const CANVAS: MenuBoardLayout = "canvas_landscape";

/** The fixed layouts, after the blank and free canvases. */
const LAYOUTS: readonly Option[] = [
  { layout: "three_columns", start: "template", name: "Three columns", detail: "One column for each section", picture: "three" },
  { layout: "two_columns", start: "template", name: "Featured item", detail: "A list and one big card", picture: "featured" },
  { layout: "pickup_board", start: "template", name: "Pickup board", detail: "Preparing and ready codes", picture: "pickup" },
];

const DESIGNS = Object.keys(MENU_BOARD_DESIGNS) as MenuBoardDesign[];

const LAYOUT_OPTIONS: readonly Option[] = [
  { layout: CANVAS, start: "blank", name: "Blank", detail: "An empty canvas", picture: "blank" },
  { layout: CANVAS, start: "template", name: "Free canvas", detail: "Your sections, placed anywhere", picture: "canvas" },
  ...LAYOUTS,
];

const DESIGN_OPTIONS: readonly Option[] = DESIGNS.map((design) => ({
  layout: CANVAS,
  start: design,
  name: MENU_BOARD_DESIGNS[design].name,
  detail: MENU_BOARD_DESIGNS[design].detail,
  picture: design,
}));

const keyOf = (option: Option): string => `${option.layout}:${option.start}`;

export function StartBoard(props: Readonly<{
  organisationId: string;
  /** The buttons that open the Menus sheets, for a shop with no board yet. */
  menuLinks?: React.ReactNode;
  /** Null when the shop has no board yet. */
  onCancel: (() => void) | null;
  onCreated: (boardId: string) => Promise<void>;
  /** The menu's size, for the line under the designed menus. */
  menuSize: Readonly<{ items: number; sections: number }>;
  /** The archived boards, when every board is archived, to restore one. */
  archived?: React.ReactNode;
}>): React.ReactNode {
  const [chosen, setChosen] = React.useState<string>(`${CANVAS}:espresso_bar`);
  const [title, setTitle] = React.useState("Morning menu");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const options = [...LAYOUT_OPTIONS, ...DESIGN_OPTIONS];
  const option = options.find((candidate) => keyOf(candidate) === chosen) ?? options[0];
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (option === undefined) return;
    setBusy(true);
    setError(null);
    const answer = await controlAnswer(controlWrite(controlPath(props.organisationId, "menu-boards"), "POST", {
      title: title.trim(),
      layout: option.layout,
      start: option.start,
    }));
    setBusy(false);
    const raw = answer.body;
    if (answer.ok && isRecord(raw) && isRecord(raw.board) && typeof raw.board.boardId === "string") {
      await props.onCreated(raw.board.boardId);
      return;
    }
    const code = isRecord(raw) ? raw.error : undefined;
    setError(code === "organisation_role_insufficient"
      ? "Only staff, admins and owners can make a board."
      : code === "menu_board_limit"
        ? "This shop has 12 boards. Remove one before you make another."
        : "The board could not be made. Try again.");
  };
  const card = (candidate: Option): React.ReactNode => <label key={keyOf(candidate)} className="menu-board-start-card">
    <input
      type="radio"
      name="menu-board-start"
      value={keyOf(candidate)}
      data-layout={candidate.layout}
      checked={keyOf(candidate) === chosen}
      onChange={() => setChosen(keyOf(candidate))}
    />
    <span className="menu-board-start-picture" aria-hidden="true">
      <Picture picture={candidate.picture} />
    </span>
    <span className="menu-board-start-name">{candidate.name}</span>
    <span className="menu-board-start-detail">{candidate.detail}</span>
  </label>;
  return <div className="menu-board-start-layer">
    <form className="menu-boards-new menu-board-start" aria-label="Start a board" onSubmit={(event) => void submit(event)}>
      {props.menuLinks === undefined || props.onCancel !== null ? null : <div className="menu-board-start-tabs">{props.menuLinks}</div>}
      <header>
        <h2>Start a board</h2>
        <p>Your products and their live prices fill the board. One board fits every screen, and you can change everything on the canvas later.</p>
      </header>
      <fieldset className="menu-board-start-grid" data-count={LAYOUT_OPTIONS.length}>
        <legend>Start from a layout</legend>
        {LAYOUT_OPTIONS.map(card)}
      </fieldset>
      <fieldset className="menu-board-start-grid" data-count={DESIGNS.length}>
        <legend>
          Or a designed menu, filled with your products
          <span>{props.menuSize.items === 1 ? "1 product" : `${props.menuSize.items} products`} · {props.menuSize.sections === 1 ? "1 section" : `${props.menuSize.sections} sections`}</span>
        </legend>
        {DESIGN_OPTIONS.map(card)}
      </fieldset>
      <footer>
        <label>
          <span>Name</span>
          <input value={title} maxLength={MENU_BOARD_TEXT_LIMIT} required onChange={(event) => setTitle(event.target.value)} />
        </label>
        <span className="menu-board-start-summary">{option?.name}</span>
        {props.onCancel === null ? null : <button type="button" className="menu-board-text-button" onClick={props.onCancel}>Cancel</button>}
        <button type="submit" className="menu-boards-primary" disabled={busy || title.trim().length === 0 || option === undefined}>
          {busy ? "Creating…" : "Create board"}
        </button>
      </footer>
      {error === null ? null : <p className="description-draft-error" role="alert">{error}</p>}
    </form>
    {props.archived}
  </div>;
}

/** A small drawing of a start: a wireframe, or a designed menu in its colours. */
function Picture(props: Readonly<{ picture: Option["picture"] }>): React.ReactNode {
  const frame = "menu-board-start-frame menu-board-start-frame-landscape";
  switch (props.picture) {
    case "blank":
      return <span className={`${frame} menu-board-start-blank`}>+</span>;
    case "canvas":
      return <span className={`${frame} menu-board-start-wire`}>
        <i className="bar" /><span className="free"><i /><i /><i /></span>
      </span>;
    case "three":
      return <span className={`${frame} menu-board-start-wire`}>
        <i className="bar" />
        <span className="cols" data-cols={3}>
          {Array.from({ length: 3 }, (_, index) => <span key={index}><i /><i /><i /></span>)}
        </span>
      </span>;
    case "featured":
      return <span className={`${frame} menu-board-start-wire`}>
        <i className="bar" /><span className="cols" data-cols="featured"><span><i /><i /><i /><i /></span><span className="card" /></span>
      </span>;
    case "pickup":
      return <span className={`${frame} menu-board-start-wire`}>
        <i className="bar" /><span className="cols" data-cols="2"><span><i /><i /></span><span className="ready"><i /><i /></span></span>
      </span>;
    default: {
      const design = MENU_BOARD_DESIGNS[props.picture];
      const style = MENU_BOARD_STYLE_PRESETS[design.preset].style;
      return <span
        className={`${frame} menu-board-start-design`}
        style={{ background: style.background, color: style.ink, "--accent": style.accent } as React.CSSProperties}
      >
        <i className="eyebrow" />
        <b>{design.pickup ? "Order here" : "Menu"}</b>
        {Array.from({ length: 3 }, (_, index) => <span key={index} className="row"><i /><i className="price" /></span>)}
      </span>;
    }
  }
}
