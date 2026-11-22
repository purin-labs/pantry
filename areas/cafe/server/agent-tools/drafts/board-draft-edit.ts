/**
 * The part of a streamed `menu_board_edit` call that the canvas can draw
 * before the call ends. It reads only the arguments, so the Plan 40B
 * real-route measurement script runs the same code outside the Worker.
 */
import { COLLABORATION_AGENT_DRAFT_TEXT_LIMIT } from "@purin-labs/collaboration";
import type { MenuBoardRect } from "@purin-labs/menu-board-crdt/board";
import type { MenuBoardDraftEdit } from "../../actors/menu-board-agent-action";

const DRAFT_KINDS: ReadonlySet<string> = new Set([
  "add_text",
  "set_text",
  "place_on_canvas",
]);

/** The fields of a board edit that the canvas draws, from its arguments. */
export function draftEdit(
  args: Readonly<Record<string, unknown>>,
): MenuBoardDraftEdit | null {
  const kind = args.kind;
  if (typeof kind !== "string" || !DRAFT_KINDS.has(kind)) return null;
  const text = typeof args.text === "string" ? args.text : null;
  return {
    kind: kind as MenuBoardDraftEdit["kind"],
    elementId: typeof args.elementId === "string" ? args.elementId : null,
    prop: typeof args.prop === "string" ? args.prop : null,
    text:
      text === null
        ? null
        : [...text].slice(0, COLLABORATION_AGENT_DRAFT_TEXT_LIMIT).join(""),
    rect: draftRect(args),
  };
}

/**
 * The board of the call, once the model has finished its id. A string grows
 * while the model writes it, so a part such as `board_3f` would check the
 * pass of another board and fix the preview on it (Plan 40B phase 7).
 */
export function draftBoardId(
  args: Readonly<Record<string, unknown>>,
  complete: boolean,
): string | null {
  const boardId = args.boardId;
  if (typeof boardId !== "string" || boardId === "") return null;
  const fields = Object.keys(args);
  return complete || fields.indexOf("boardId") < fields.length - 1
    ? boardId
    : null;
}

/** A rect only when the model has finished all four of its numbers. */
function draftRect(
  args: Readonly<Record<string, unknown>>,
): MenuBoardRect | null {
  const fields = Object.keys(args);
  const parts = (["x", "y", "width", "height"] as const).map((field) =>
    draftInteger(args[field], fields.indexOf(field) < fields.length - 1),
  );
  if (parts.some((part) => part === null)) return null;
  const [x, y, width, height] = parts as number[];
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width < 16 ||
    height < 16 ||
    Math.abs(x) > 4000 ||
    Math.abs(y) > 4000 ||
    width > 4000 ||
    height > 4000
  )
    return null;
  return { x, y, width, height };
}

/**
 * One finished rect number. Some models (qwen3.7-flash on OpenRouter) write
 * `"x":"80"`; the tool coerces it, but a partial string grows ("8", "80"),
 * so a string counts only after a later field has started.
 */
function draftInteger(value: unknown, closed: boolean): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !closed || !/^-?\d{1,4}$/.test(value))
    return null;
  return Number(value);
}
