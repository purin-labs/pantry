import React from "react";
import { Crosshair, MousePointer2, Sparkles, TextCursor, type LucideIcon } from "lucide-react";
import type {
  CollaborationAgentAction,
  CollaborationAgentActivity,
  CollaborationAgentColorKey,
} from "@seams/collaboration";
import type { MenuBoardElement, MenuBoardRect } from "@seams/menu-board-crdt/board";
import "./canvas-agents.css";

/**
 * Agents on the free canvas (Plan 40B phase 7, slice 2). Each agent that
 * edits the board shows in its own colour, apart from the colours of
 * people: an outline around the elements that it acts on, a cursor at the
 * corner of its real target, and a name tag with an AI mark and the action.
 * A create, a move or a resize also shows the size. Nothing moves between
 * targets: Plan 40C allows no invented pointer travel or clicks.
 */

/** One agent's action on the canvas, with the rects that it names. */
export type CanvasAgentMark = Readonly<{
  key: string;
  /** The agent's Session: one request of a person. */
  sessionId: string;
  name: string;
  color: CollaborationAgentColorKey;
  action: CollaborationAgentAction;
  /** The rect of the main target; null when the board itself is the target. */
  target: MenuBoardRect | null;
  /** The rect of each named element that shows on the canvas. */
  outlines: readonly Readonly<{ elementId: string; rect: MenuBoardRect }>[];
  label: string;
}>;

const VERBS: Readonly<Record<CollaborationAgentAction["kind"], string>> = {
  create: "placing",
  move: "moving",
  resize: "resizing",
  text: "writing",
  style: "styling",
  remove: "removing",
  comment: "commenting on",
  history: "changing the history of",
};

const CURSORS: Readonly<Record<CollaborationAgentAction["kind"], LucideIcon>> = {
  create: Crosshair,
  move: MousePointer2,
  resize: Crosshair,
  text: TextCursor,
  style: MousePointer2,
  remove: MousePointer2,
  comment: MousePointer2,
  history: MousePointer2,
};

/**
 * The marks of the agents that act on this board now. An activity from a
 * room that sends no action (a server from before phase 7) has none.
 */
export function canvasAgentMarks(
  activities: readonly CollaborationAgentActivity[],
  elements: readonly MenuBoardElement[],
  rects: ReadonlyMap<string, MenuBoardRect>,
  names: Readonly<Record<MenuBoardElement["kind"], string>>,
): CanvasAgentMark[] {
  return activities.flatMap((activity) => {
    const action = activity.action;
    if (action === undefined) return [];
    const outlines = action.elementIds.flatMap((elementId) => {
      const rect = rects.get(elementId);
      return rect === undefined ? [] : [{ elementId, rect }];
    });
    const main = action.elementIds[0];
    // The element's own rect where it shows; a new element shows its
    // proposed rect until the edit lands.
    const target = (main === undefined ? undefined : rects.get(main)) ??
      (action.kind === "create" ? action.rect : null);
    if (target === null && action.elementIds.length > 0) return [];
    const element = main === undefined ? undefined : elements.find((candidate) => candidate.id === main);
    return [{
      key: JSON.stringify([activity.agent.sessionId, activity.operationId]),
      sessionId: activity.agent.sessionId,
      name: activity.agent.displayName,
      color: activity.agent.colorKey ?? "violet",
      action,
      target,
      outlines,
      label: `${VERBS[action.kind]} ${targetName(action, element, names)}`,
    }];
  });
}

function targetName(
  action: CollaborationAgentAction,
  element: MenuBoardElement | undefined,
  names: Readonly<Record<MenuBoardElement["kind"], string>>,
): string {
  // A new element that the model still writes has no ID yet.
  if (action.elementIds.length === 0 && action.kind === "create")
    return action.field === "text" ? "a text" : "an element";
  if (action.elementIds.length === 0) return action.field === "title" ? "the board's name" : "the board";
  if (element === undefined) return action.field === "text" ? "a text" : "an element";
  const detail = elementDetail(element).trim();
  const name = detail.length === 0 ? names[element.kind] : detail;
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

function elementDetail(element: MenuBoardElement): string {
  switch (element.kind) {
    case "heading":
    case "order_qr":
    case "pickup_codes":
      return element.title;
    case "text":
      return element.text;
    case "featured":
      return element.label;
    case "section":
    case "image":
    case "stack":
      return "";
    default:
      return element satisfies never;
  }
}

/**
 * The agents' outlines, cursors and name tags, on the canvas overlay. While
 * an edit is pending, a dashed ghost box stands at the rect that the edit
 * proposes (slice 3), with the text that the model writes so far (slice 4).
 * A mark that goes away while it is pending fades out; the element stays
 * where it was.
 */
export function CanvasAgents(props: Readonly<{
  marks: readonly CanvasAgentMark[];
  scale: number;
}>): React.ReactNode {
  const inverse = props.scale === 0 ? 1 : 1 / props.scale;
  const leaving = useLeavingMarks(props.marks);
  return [...props.marks.map((mark) => [mark, false] as const), ...leaving.map((mark) => [mark, true] as const)]
    .map(([mark, gone]) => <div
      key={mark.key}
      className="menu-canvas-agent-mark"
      data-agent-color={mark.color}
      data-leaving={gone ? "true" : undefined}
    >
      {mark.outlines.map((outline) => <div
        key={outline.elementId}
        className="menu-canvas-agent-outline"
        data-agent-color={mark.color}
        data-state={mark.action.state}
        data-element-id={outline.elementId}
        style={rectStyle(outline.rect, inverse)}
      />)}
      <GhostBox mark={mark} inverse={inverse} />
      <DraftText mark={mark} inverse={inverse} />
      <AgentCursor mark={mark} inverse={inverse} />
    </div>);
}

/**
 * The box at the rect that a pending edit proposes: a new element before
 * it exists, or the place where a move or a resize puts its element.
 */
function GhostBox(props: Readonly<{ mark: CanvasAgentMark; inverse: number }>): React.ReactNode {
  const { mark } = props;
  const rect = ghostRect(mark);
  if (rect === null) return null;
  const created = mark.action.kind === "create";
  const text = created ? mark.action.text : undefined;
  return <div
    className="menu-canvas-agent-ghost"
    data-agent-color={mark.color}
    data-kind={mark.action.kind}
    data-agent-ghost={mark.name}
    style={{ ...rectStyle(rect, props.inverse), "--agent-text": `${textSize(rect)}px` } as React.CSSProperties}
  >
    {text === undefined || text.length === 0
      ? created ? <span className="menu-canvas-agent-generating" style={{ transform: `scale(${props.inverse})` }}>
        <Sparkles size={12} aria-hidden="true" />
        Generating …
      </span> : null
      : <DraftLetters text={text} />}
  </div>;
}

/** A pending create, move or resize shows its proposed rect. */
function ghostRect(mark: CanvasAgentMark): MenuBoardRect | null {
  const action = mark.action;
  if (action.state !== "pending" || action.rect === null) return null;
  if (action.kind === "create") return mark.outlines.length === 0 ? action.rect : null;
  if (action.kind !== "move" && action.kind !== "resize") return null;
  const target = mark.target;
  return target !== null && sameRect(target, action.rect) ? null : action.rect;
}

/**
 * The text of a text edit while the model writes it, over its element. The
 * accepted value of the edit replaces it when the edit lands.
 */
function DraftText(props: Readonly<{ mark: CanvasAgentMark; inverse: number }>): React.ReactNode {
  const { mark } = props;
  const text = mark.action.text;
  if (mark.action.kind !== "text" || mark.action.state !== "pending" || text === undefined || mark.target === null)
    return null;
  return <div
    className="menu-canvas-agent-draft"
    data-agent-color={mark.color}
    data-agent-draft={mark.name}
    style={{ ...rectStyle(mark.target, props.inverse), "--agent-text": `${textSize(mark.target)}px` } as React.CSSProperties}
  >
    <DraftLetters text={text} />
  </div>;
}

function DraftLetters(props: Readonly<{ text: string }>): React.ReactNode {
  return <p className="menu-canvas-agent-letters">
    {props.text}
    <span className="menu-canvas-agent-caret" aria-hidden="true" />
  </p>;
}

/** A readable size in board units for the draft text of a box. */
function textSize(rect: MenuBoardRect): number {
  return Math.round(Math.max(18, Math.min(44, rect.height * 0.32)));
}

function sameRect(first: MenuBoardRect, second: MenuBoardRect): boolean {
  return first.x === second.x && first.y === second.y &&
    first.width === second.width && first.height === second.height;
}

/** How long a mark that went away while it was pending takes to fade. */
const LEAVE_MS = 320;

/**
 * The marks that went away while they were pending, for their fade. A mark
 * that gives its place to the same agent's next mark does not fade: the
 * real edit takes the place of its draft.
 */
function useLeavingMarks(marks: readonly CanvasAgentMark[]): readonly CanvasAgentMark[] {
  const [leaving, setLeaving] = React.useState<readonly CanvasAgentMark[]>([]);
  const last = React.useRef<readonly CanvasAgentMark[]>([]);
  // A fade ends on its own timer: a later frame does not cut it short.
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  React.useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);
  const signature = marks.map((mark) => `${mark.key}:${mark.action.state}`).join("|");
  React.useEffect(() => {
    const shown = new Set(marks.map((mark) => mark.key));
    const agents = new Set(marks.map((mark) => mark.sessionId));
    const gone = last.current.filter((mark) =>
      !shown.has(mark.key) && mark.action.state === "pending" && !agents.has(mark.sessionId));
    last.current = marks;
    setLeaving((before) => {
      const kept = before.filter((mark) => !shown.has(mark.key) && !agents.has(mark.sessionId));
      return gone.length === 0 && kept.length === before.length ? before : [...kept, ...gone];
    });
    if (gone.length === 0) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((before) => before.filter((mark) => !gone.includes(mark)));
    }, LEAVE_MS);
    timers.current.add(timer);
    // The signature names every change of the marks that matters here.
  }, [signature]);
  return leaving;
}

/**
 * When an agent's move or resize lands, its element goes from its real old
 * rect to its real new rect in about 240 ms; with reduced motion it moves
 * at once. This is the only motion on the canvas (Plan 40C): no pointer
 * travels between targets. The person's own drag never animates.
 */
export function useAgentMotion(
  root: React.RefObject<HTMLElement | null>,
  marks: readonly CanvasAgentMark[],
  rects: ReadonlyMap<string, MenuBoardRect>,
  ownDrag: Readonly<{ has(elementId: string): boolean }>,
): void {
  const previous = React.useRef<ReadonlyMap<string, MenuBoardRect>>(new Map());
  React.useLayoutEffect(() => {
    const before = previous.current;
    previous.current = rects;
    const named = new Set(marks
      .filter((mark) => mark.action.kind === "move" || mark.action.kind === "resize")
      .flatMap((mark) => mark.action.elementIds));
    if (named.size === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const id of named) {
      const from = before.get(id);
      const to = rects.get(id);
      if (from === undefined || to === undefined || sameRect(from, to) || ownDrag.has(id)) continue;
      const node = root.current?.querySelector(`.menu-board-canvas-element[data-element-id="${CSS.escape(id)}"]`);
      if (!(node instanceof HTMLElement) || typeof node.animate !== "function") continue;
      node.animate([boxFrame(from), boxFrame(to)], { duration: AGENT_MOVE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
  });
}

const AGENT_MOVE_MS = 240;

function boxFrame(rect: MenuBoardRect): Keyframe {
  return { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` };
}

function AgentCursor(props: Readonly<{ mark: CanvasAgentMark; inverse: number }>): React.ReactNode {
  const { mark } = props;
  const Icon = CURSORS[mark.action.kind];
  const at = cursorPoint(mark.action, mark.target);
  const size = sizeBadge(mark.action, mark.target);
  return <div
    className="menu-canvas-agent"
    data-agent-color={mark.color}
    data-kind={mark.action.kind}
    data-state={mark.action.state}
    data-agent={mark.name}
    style={{ left: at.x, top: at.y, transform: `scale(${props.inverse})` }}
  >
    <Icon className="menu-canvas-agent-pointer" size={22} strokeWidth={mark.action.kind === "move" ? 1.5 : 2.25} aria-hidden="true" />
    <span className="menu-canvas-agent-tag">
      <span className="menu-canvas-agent-name">
        <Sparkles size={12} aria-hidden="true" />
        <span className="menu-canvas-agent-ai">AI</span>
        {mark.name}
      </span>
      <span className="menu-canvas-agent-action">{mark.label}</span>
      {size === null ? null : <span className="menu-canvas-agent-size">{size}</span>}
    </span>
  </div>;
}

/**
 * Where the cursor stands: at the far corner of a box that grows or changes
 * size, at the start of a text, and at the top-left corner otherwise.
 */
function cursorPoint(action: CollaborationAgentAction, target: MenuBoardRect | null): Readonly<{ x: number; y: number }> {
  if (target === null) return { x: 0, y: 0 };
  const rect = action.kind === "resize" && action.rect !== null ? action.rect : target;
  switch (action.kind) {
    case "create":
    case "resize":
      return { x: rect.x + rect.width, y: rect.y + rect.height };
    case "text":
      return { x: rect.x, y: rect.y + Math.min(rect.height / 2, 40) };
    default:
      return { x: rect.x, y: rect.y };
  }
}

function sizeBadge(action: CollaborationAgentAction, target: MenuBoardRect | null): string | null {
  if (action.kind !== "create" && action.kind !== "move" && action.kind !== "resize") return null;
  const rect = action.rect ?? target;
  return rect === null ? null : `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

function rectStyle(rect: MenuBoardRect, inverse: number): React.CSSProperties {
  return {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    "--agent-line": `${Math.max(2, 3 * inverse)}px`,
  } as React.CSSProperties;
}

/** The agents that act on one element, for its row in the layers list. */
export function agentsOnElement(marks: readonly CanvasAgentMark[], elementId: string): CanvasAgentMark[] {
  return marks.filter((mark) => mark.action.elementIds.includes(elementId));
}

/** The agents' actions, in words, for a screen reader. */
export function CanvasAgentStatus(props: Readonly<{ marks: readonly CanvasAgentMark[] }>): React.ReactNode {
  return <p className="visually-hidden" role="status">
    {props.marks.map((mark) => `${mark.name}, AI agent: ${mark.label}.`).join(" ")}
  </p>;
}
