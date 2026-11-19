import React from "react";
import { Select } from "../../ui/select";
import { createPortal } from "react-dom";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Columns3,
  Rows3,
  type LucideIcon,
} from "lucide-react";
import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  MENU_BOARD_STACK_SPACING_LIMIT,
  menuBoardCanvasRects,
  type MenuBoardCanvasPlacement,
  type MenuBoardElement,
  type MenuBoardHorizontalConstraint,
  type MenuBoardRect,
  type MenuBoardScreenShape,
  type MenuBoardSnapshot,
  type MenuBoardVerticalConstraint,
} from "@purin-labs/menu-board-crdt/board";
import {
  MENU_BOARD_MOVING_LIMIT,
  type MenuBoardElementPlacement,
  type MenuBoardPresenceSelection,
} from "@purin-labs/menu-board-crdt";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import type { MenuBoardClient, MenuBoardPresenceView } from "./board-client";
import {
  CanvasAgents,
  CanvasAgentStatus,
  agentsOnElement,
  canvasAgentMarks,
  useAgentMotion,
  type CanvasAgentMark,
} from "./canvas-agents";
import { CanvasPresenceBar, followTarget, useAgentChanges, type CanvasAgentRequest } from "./canvas-presence-bar";
import { CanvasMeasures, CanvasRulers, type MeasuredBox, type RulerRange } from "./canvas-rulers";
import { ScaledBoard, type BoardContent, type BoardFactsView, type BoardSize } from "./board-view";
import { BoardViewport } from "./board-viewport";
import {
  HANDLES,
  align,
  boundsOf,
  distribute,
  marqueeRect,
  marqueeSelection,
  normalizeRect,
  placementsFor,
  resizeRect,
  restack,
  snapMove,
  type Alignment,
  type Guide,
  type Handle,
} from "./canvas-geometry";
import "./canvas-editor.css";

/**
 * The free canvas editor of a menu board (Plan 40B phase 5). A person
 * selects, moves and resizes elements with snapping and smart guides,
 * nudges them with the arrow keys, aligns and distributes a selection,
 * restacks it in the layers list, and undoes their own changes. Other
 * people's cursors and selections show live. Every change goes to the
 * board's shared draft; screens change only when a person publishes.
 */

export const ELEMENT_NAMES: Readonly<Record<MenuBoardElement["kind"], string>> = {
  heading: "Heading",
  section: "Menu section",
  featured: "Product",
  order_qr: "Order QR code",
  pickup_codes: "Order codes",
  text: "Text",
  image: "Image",
  stack: "Stack",
};

const SHAPE_NAMES: Readonly<Record<MenuBoardScreenShape, string>> = {
  landscape: "Landscape TV",
  portrait: "Portrait TV",
  tablet: "Tablet",
};

const HORIZONTAL_CONSTRAINTS: readonly Readonly<{ value: MenuBoardHorizontalConstraint; label: string }>[] = [
  { value: "left", label: "Keep the left edge" },
  { value: "right", label: "Keep the right edge" },
  { value: "center", label: "Keep the centre" },
  { value: "stretch", label: "Stretch with the screen" },
  { value: "scale", label: "Scale with the screen" },
];

const VERTICAL_CONSTRAINTS: readonly Readonly<{ value: MenuBoardVerticalConstraint; label: string }>[] = [
  { value: "top", label: "Keep the top edge" },
  { value: "bottom", label: "Keep the bottom edge" },
  { value: "center", label: "Keep the middle" },
  { value: "stretch", label: "Stretch with the screen" },
  { value: "scale", label: "Scale with the screen" },
];

const NUDGE = 1;
const NUDGE_LARGE = 10;
const DUPLICATE_OFFSET = 24;

type Drag =
  | Readonly<{
      kind: "move" | "resize";
      handle: Handle | null;
      pointerId: number;
      origin: Readonly<{ x: number; y: number }>;
      start: ReadonlyMap<string, MenuBoardRect>;
      current: ReadonlyMap<string, MenuBoardRect>;
      guides: readonly Guide[];
      moved: boolean;
      /** The element under the pointer, for a click that keeps one of several. */
      target: string;
    }>;

/** A marquee drag on the empty canvas (Plan 40B phase 5, slice 4). */
type Marquee = Readonly<{
  pointerId: number;
  origin: Readonly<{ x: number; y: number }>;
  current: Readonly<{ x: number; y: number }>;
  /** The selection that a Shift marquee adds to. */
  base: readonly string[];
}>;

/** A marquee smaller than this is a click that clears the selection. */
const MARQUEE_CLICK = 3;

export function CanvasEditor(props: Readonly<{
  board: MenuBoardSnapshot;
  content: BoardContent;
  facts: BoardFactsView;
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
  participants: readonly MenuBoardPresenceView[];
  /** The agents that edit the board now (Plan 40B phase 7). */
  agents: readonly CollaborationAgentActivity[];
  /** The agent request of this person, from the side chat; null for none. */
  agentRequest?: CanvasAgentRequest | null;
  selection: readonly string[];
  onSelect: (elementIds: readonly string[]) => void;
  /** The board editor's toolbar, where the tools for a selection go. */
  toolsHost: HTMLElement | null;
  /** The side panel, where the layers list goes. */
  layersHost: HTMLElement | null;
  /** Drawn on the board's stage (comment pins). */
  stageChildren?: React.ReactNode;
  stageRef?: React.RefObject<HTMLDivElement | null>;
  fitKey: string;
  /** A product dropped on the canvas (the Products panel). */
  drop?: React.ComponentProps<typeof BoardViewport>["drop"];
}>): React.ReactNode {
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [marquee, setMarquee] = React.useState<Marquee | null>(null);
  const [previewShape, setPreviewShape] = React.useState<MenuBoardScreenShape | null>(null);
  // Screen guides (Plan 40B, the start screen's canvas): where a screen of
  // another shape cuts this board. All other shapes show at first.
  const [hiddenGuides, setHiddenGuides] = React.useState<ReadonlySet<MenuBoardScreenShape>>(new Set());
  const root = React.useRef<HTMLDivElement>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  const layout = MENU_BOARD_LAYOUTS[props.board.layout];
  const design = MENU_BOARD_SCREEN_SIZES[layout.shape];
  const elements = props.board.elements;
  const selected = React.useMemo(() => new Set(props.selection), [props.selection]);
  React.useEffect(() => {
    props.client.current?.setPointerSurface(surface.current);
    return () => props.client.current?.setPointerSurface(null);
  }, [props.client]);
  const remote = props.participants.filter((participant) => !participant.isSelf);
  // Every element's place, with the elements of each stack (slice 8).
  const drafted = menuBoardCanvasRects(elements, design, design);
  // Other people's drags in progress (slice 5), then this person's own: a
  // drag shows on the board at once; the shared draft changes on release.
  const moving = remoteMoving(remote, drafted);
  const local = drag === null || !drag.moved ? new Map<string, MenuBoardRect>() : drag.current;
  const moved = new Map<string, MenuBoardRect>([...[...moving].map(([id, entry]) => [id, entry.rect] as const), ...local]);
  const shown: BoardContent = moved.size === 0
    ? props.content
    : { ...props.content, elements: props.content.elements.map(withRect.bind(null, moved)) };
  // A stack in motion carries its elements with it.
  const rects = moved.size === 0 ? drafted : menuBoardCanvasRects(shown.elements, design, design);
  const place = (next: ReadonlyMap<string, MenuBoardRect>): void => {
    props.client.current?.placeElements(placementsFor(elements, next));
  };
  const selectedRects = new Map([...rects].filter(([id]) => selected.has(id)));
  const agentMarks = canvasAgentMarks(props.agents, elements, rects, ELEMENT_NAMES);
  useAgentMotion(root, agentMarks, rects, local);
  // Slice 5 of phase 7: each actor's selection on the rulers, and the size
  // and spacing of each box that moves now.
  const rulerRanges = canvasRulerRanges(selectedRects, remote, rects, agentMarks);
  const measured = measuredBoxes(drag, moving, remote, agentMarks);
  // Slice 6: Follow is off until the person turns it on.
  const [follow, setFollow] = React.useState(false);
  const agentChanges = useAgentChanges(props.agents);
  const followed = follow ? followTarget(agentMarks) : null;
  /** Any input of the person on the canvas turns Follow off. */
  const personInput = (event: React.SyntheticEvent): void => {
    if (!follow) return;
    if (event.target instanceof Element && event.target.closest(".menu-presence-bar") !== null) return;
    setFollow(false);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!props.editable || isTyping(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    // Undo and redo belong to the board editor, which has them in every layout.
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      props.onSelect(elements.map((element) => element.id));
      return;
    }
    if (event.key === "Escape") {
      props.onSelect([]);
      return;
    }
    if (selected.size === 0) return;
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      props.onSelect(duplicate(props.client.current, elements, selected));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      props.client.current?.removeElements([...selected]);
      props.onSelect([]);
      return;
    }
    if (mod && (event.key === "]" || event.key === "[")) {
      event.preventDefault();
      const direction = event.key === "]"
        ? event.shiftKey ? "front" : "forward"
        : event.shiftKey ? "back" : "backward";
      props.client.current?.placeElements(restack(elements, selected, direction));
      return;
    }
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE;
    const delta = arrowDelta(event.key, step);
    if (delta === null) return;
    event.preventDefault();
    const moved = new Map<string, MenuBoardRect>();
    for (const [id, rect] of selectedRects) moved.set(id, { ...rect, x: rect.x + delta.x, y: rect.y + delta.y });
    place(moved);
  };
  const begin = (
    event: React.PointerEvent,
    scale: number,
    kind: "move" | "resize",
    target: string,
    handle: Handle | null,
  ): void => {
    if (!props.editable || previewShape !== null || event.button !== 0 || scale === 0) return;
    event.stopPropagation();
    event.preventDefault();
    root.current?.focus({ preventScroll: true });
    let ids = props.selection;
    if (kind === "move") {
      if (event.shiftKey) {
        ids = selected.has(target) ? ids.filter((id) => id !== target) : [...ids, target];
        props.onSelect(ids);
        return;
      }
      if (!selected.has(target)) {
        ids = [target];
        props.onSelect(ids);
      }
    }
    // A drag of an element in a stack moves the stack (slice 8); the
    // drawer reorders it or takes it out.
    const moving = new Set(ids.map((id) => stackOf(elements, id) ?? id));
    const start = new Map([...rects].filter(([id]) => moving.has(id) && onCanvas(elements, id)));
    if (start.size === 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({
      kind,
      handle,
      pointerId: event.pointerId,
      origin: boardPoint(event, surface.current, scale),
      start,
      current: start,
      guides: [],
      moved: false,
      target,
    });
  };
  const move = (event: React.PointerEvent, scale: number, size: BoardSize): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const point = boardPoint(event, surface.current, scale);
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    if (!drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const others = [...rects].filter(([id]) => !drag.start.has(id)).map(([, rect]) => rect);
    const free = event.altKey;
    if (drag.kind === "resize") {
      const [id, start] = [...drag.start][0] ?? [];
      if (id === undefined || start === undefined || drag.handle === null) return;
      const resized = resizeRect(start, drag.handle, dx, dy, others, size, { free, keepRatio: event.shiftKey });
      setDrag({ ...drag, current: new Map([[id, resized.rect]]), guides: resized.guides, moved: true });
      props.client.current?.showMoving({ kind: "moving", elementIds: [id], offset: null, from: null, rect: resized.rect });
      return;
    }
    const bounds = boundsOf([...drag.start.values()]);
    if (bounds === null) return;
    const snapped = snapMove({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, others, size, free);
    const offsetX = snapped.rect.x - bounds.x;
    const offsetY = snapped.rect.y - bounds.y;
    const current = new Map<string, MenuBoardRect>();
    for (const [id, rect] of drag.start) current.set(id, normalizeRect({ ...rect, x: rect.x + offsetX, y: rect.y + offsetY }));
    setDrag({ ...drag, current, guides: snapped.guides, moved: true });
    const shared = [...drag.start].slice(0, MENU_BOARD_MOVING_LIMIT);
    const from = boundsOf(shared.map(([, rect]) => rect));
    if (from !== null)
      props.client.current?.showMoving({
        kind: "moving",
        elementIds: shared.map(([id]) => id),
        offset: { x: Math.round(offsetX), y: Math.round(offsetY) },
        from: { x: from.x, y: from.y },
        rect: null,
      });
  };
  /** After a drag, other people see this person's selection again. */
  const endMoving = (): void => {
    props.client.current?.select(presenceOf(props.selection));
  };
  const end = (event: React.PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      place(drag.current);
      endMoving();
    } else if (drag.kind === "move" && props.selection.length > 1) props.onSelect([drag.target]);
    setDrag(null);
  };
  const marqueeTouched = new Set(marquee === null ? [] : marqueeSelection(marqueeRect(marquee.origin, marquee.current), rects));
  const overlay = (scale: number, size: BoardSize): React.ReactNode => <div
    ref={surface}
    className="menu-canvas-overlay"
    style={{ width: size.width, height: size.height }}
    onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (previewShape !== null || event.button !== 0 || scale === 0) {
        if (!event.shiftKey) props.onSelect([]);
        return;
      }
      root.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const origin = boardPoint(event, surface.current, scale);
      setMarquee({ pointerId: event.pointerId, origin, current: origin, base: event.shiftKey ? props.selection : [] });
    }}
    onPointerMove={(event) => {
      if (marquee !== null && event.pointerId === marquee.pointerId) {
        setMarquee({ ...marquee, current: boardPoint(event, surface.current, scale) });
        return;
      }
      move(event, scale, size);
    }}
    onPointerUp={(event) => {
      if (marquee !== null && event.pointerId === marquee.pointerId) {
        const box = marqueeRect(marquee.origin, marquee.current);
        const touched = box.width < MARQUEE_CLICK && box.height < MARQUEE_CLICK ? [] : marqueeSelection(box, rects);
        props.onSelect([...marquee.base, ...touched.filter((id) => !marquee.base.includes(id))]);
        setMarquee(null);
        return;
      }
      end(event);
    }}
    onPointerCancel={() => {
      if (drag?.moved === true) endMoving();
      setDrag(null);
      setMarquee(null);
    }}
  >
    {previewShape === null ? [...rects].map(([id, rect]) => <div
      key={id}
      className="menu-canvas-hit"
      data-element-id={id}
      data-selected={selected.has(id) ? "true" : undefined}
      data-marquee={marqueeTouched.has(id) ? "true" : undefined}
      style={rectStyle(rect)}
      onPointerDown={(event) => begin(event, scale, "move", id, null)}
    />) : null}
    {previewShape === null ? remote.flatMap((participant) =>
      selectedIds(participant.selection).flatMap((elementId, index) => {
        const rect = rects.get(elementId);
        if (rect === undefined) return [];
        return [<div
          key={`selection:${participant.sessionId}:${elementId}`}
          className="menu-canvas-remote-selection"
          data-moving={moving.get(elementId)?.sessionId === participant.sessionId ? "true" : undefined}
          data-participant={participant.displayName}
          style={{ ...rectStyle(rect), "--participant": participantColor(participant.userId) } as React.CSSProperties}
        >
          {index === 0 ? <span>{participant.displayName}</span> : null}
        </div>];
      })) : null}
    {previewShape === null && props.editable && props.selection.length === 1 ? (() => {
      const id = props.selection[0];
      const rect = id === undefined ? undefined : rects.get(id);
      if (id === undefined || rect === undefined || !onCanvas(elements, id)) return null;
      return HANDLES.map((handle) => <div
        key={handle}
        className="menu-canvas-handle"
        data-handle={handle}
        style={handleStyle(rect, handle, scale)}
        onPointerDown={(event) => begin(event, scale, "resize", id, handle)}
      />);
    })() : null}
    {marquee === null ? null : <div
      className="menu-canvas-marquee"
      style={{ ...rectStyle(marqueeRect(marquee.origin, marquee.current)), borderWidth: Math.max(1, 1 / (scale === 0 ? 1 : scale)) }}
    />}
    {drag?.guides.map((guide, index) => <div
      key={`${guide.axis}:${guide.at}:${index}`}
      className="menu-canvas-guide"
      data-axis={guide.axis}
      style={guide.axis === "x"
        ? { left: guide.at, top: 0, height: size.height, width: Math.max(1, 1 / scale) }
        : { top: guide.at, left: 0, width: size.width, height: Math.max(1, 1 / scale) }}
    />)}
    {previewShape === null ? <CanvasMeasures boxes={measured} rects={rects} design={design} scale={scale} /> : null}
    {previewShape === null ? <CanvasAgents marks={agentMarks} scale={scale} /> : null}
    {remote.flatMap((participant) => participant.pointer === null ? [] : [<div
      key={`pointer:${participant.sessionId}`}
      className="menu-canvas-cursor"
      style={{
        left: participant.pointer.position.x * size.width,
        top: participant.pointer.position.y * size.height,
        transform: `scale(${scale === 0 ? 1 : 1 / scale})`,
        "--participant": participantColor(participant.userId),
      } as React.CSSProperties}
    >
      <span>{participant.displayName}</span>
    </div>])}
  </div>;
  const multiple = selectedRects.size;
  /** Puts the selected canvas elements in a new stack, in their order on the board. */
  const stack = (direction: "vertical" | "horizontal"): void => {
    const made = stackFor(stackable(elements, selected), rects, direction);
    if (made === null) return;
    props.client.current?.stackElements(made.stack, made.placements);
    props.onSelect([made.stack.id]);
  };
  const tool = (name: string, Icon: LucideIcon, disabled: boolean, action: () => void): React.ReactNode => <button
    key={name}
    type="button"
    className="menu-board-icon-button"
    aria-label={name}
    title={name}
    disabled={disabled}
    onClick={action}
  >
    <Icon size={16} aria-hidden="true" />
  </button>;
  const canStack = stackable(elements, selected).length >= 2;
  // The tools for a selection sit at the top of the inspector, as in Figma;
  // they need two or more elements.
  const tools = props.editable && props.toolsHost !== null ? createPortal(<span
    className="menu-canvas-toolbar"
    role="group"
    aria-label="Canvas tools"
  >
    <span className="menu-canvas-toolbar-group" role="group" aria-label="Align">
      {(["left", "center", "right", "top", "middle", "bottom"] as const).map((alignment) =>
        tool(ALIGN_NAMES[alignment], ALIGN_ICONS[alignment], multiple < 2, () => place(align(selectedRects, alignment))))}
    </span>
    <span className="menu-canvas-toolbar-group" role="group" aria-label="Distribute">
      {tool("Space across", AlignHorizontalSpaceAround, multiple < 3, () => place(distribute(selectedRects, "x")))}
      {tool("Space down", AlignVerticalSpaceAround, multiple < 3, () => place(distribute(selectedRects, "y")))}
    </span>
    <span className="menu-canvas-toolbar-group" role="group" aria-label="Auto layout">
      {tool("Stack down", Rows3, !canStack, () => stack("vertical"))}
      {tool("Stack across", Columns3, !canStack, () => stack("horizontal"))}
    </span>
  </span>, props.toolsHost) : null;
  const layers = props.layersHost === null ? null : createPortal(<LayersPanel
    elements={elements}
    selected={selected}
    editable={props.editable}
    participants={remote}
    agents={agentMarks}
    design={design}
    onSelect={(id, extend) => props.onSelect(extend
      ? selected.has(id) ? props.selection.filter((other) => other !== id) : [...props.selection, id]
      : [id])}
    onRestack={(direction) => props.client.current?.placeElements(restack(elements, selected, direction))}
  />, props.layersHost);
  const shownSize = previewShape === null ? design : MENU_BOARD_SCREEN_SIZES[previewShape];
  return <div
    ref={root}
    className="menu-canvas"
    tabIndex={0}
    onKeyDown={onKeyDown}
    onPointerDownCapture={personInput}
    onWheelCapture={personInput}
    onKeyDownCapture={personInput}
    aria-label="Board canvas. Drag on the board to select an area. Arrow keys move the selection; Shift moves it further. Drag the empty area or hold Space to pan; Ctrl and the wheel zooms."
  >
    <BoardViewport
      design={shownSize}
      fitKey={`${props.fitKey}:${previewShape ?? "design"}`}
      stageChildren={previewShape === null ? (width: number) => <>
        {props.stageChildren}
        {screenGuides(layout.shape, design, width, hiddenGuides)}
        <CanvasRulers width={width} design={design} ranges={rulerRanges} />
      </> : null}
      stageRef={props.stageRef}
      label={`${props.board.title} · ${SHAPE_NAMES[previewShape ?? layout.shape]}`}
      onBackgroundClick={() => props.onSelect([])}
      follow={followed}
      {...(props.drop === undefined ? {} : { drop: props.drop })}
      footer={<>
        <span className="menu-canvas-guides" role="group" aria-label="Screen guides">
          <span className="menu-canvas-guides-label">Guides</span>
          {otherShapes(layout.shape).map((shape) => <button
            key={shape}
            type="button"
            className="menu-board-text-button"
            aria-pressed={!hiddenGuides.has(shape) && previewShape === null}
            disabled={previewShape !== null}
            title={`Show where a ${SHAPE_NAMES[shape].toLowerCase()} cuts this board`}
            onClick={() => setHiddenGuides((before) => {
              const next = new Set(before);
              if (next.has(shape)) next.delete(shape);
              else next.add(shape);
              return next;
            })}
          >
            <span className="menu-canvas-guide-swatch" style={{ background: GUIDE_COLORS[shape] }} aria-hidden="true" />
            {SHAPE_NAMES[shape]}
          </button>)}
        </span>
        <label className="menu-canvas-preview-shape">
        <span>Show on</span>
        <Select.Root
          items={{ ...SHAPE_NAMES, design: `This board (${SHAPE_NAMES[layout.shape]})` }}
          value={previewShape ?? "design"}
          onValueChange={(value) => {
            if (value === null) return;
            setPreviewShape(value === "design" ? null : value as MenuBoardScreenShape);
          }}
        >
          <Select.Trigger variant="ghost"><Select.Value /></Select.Trigger>
          <Select.Popup>
            <Select.Item value="design">This board ({SHAPE_NAMES[layout.shape]})</Select.Item>
            {(Object.keys(SHAPE_NAMES) as MenuBoardScreenShape[]).filter((shape) => shape !== layout.shape).map((shape) => <Select.Item key={shape} value={shape}>{SHAPE_NAMES[shape]}</Select.Item>)}
          </Select.Popup>
        </Select.Root>
      </label>
      </>}
    >
      {(width) => <div style={{ width }}>
        <ScaledBoard
          content={shown}
          facts={props.facts}
          previewShape={previewShape ?? undefined}
          overlay={overlay}
        />
      </div>}
    </BoardViewport>
    {previewShape === null ? null : <p className="menu-board-float menu-board-preview-note" role="status">
      This is how a {SHAPE_NAMES[previewShape].toLowerCase()} shows the board: each element keeps its constraints. Choose “This board” to edit.
    </p>}
    <CanvasAgentStatus marks={agentMarks} />
    {previewShape === null ? <CanvasPresenceBar
      participants={props.participants}
      marks={agentMarks}
      changes={agentChanges}
      follow={follow}
      onFollow={setFollow}
      request={props.agentRequest ?? null}
      color={participantColor}
    /> : null}
    {tools}
    {layers}
  </div>;
}

const ALIGN_NAMES: Readonly<Record<Alignment, string>> = {
  left: "Left",
  center: "Centre",
  right: "Right",
  top: "Top",
  middle: "Middle",
  bottom: "Bottom",
};

const GUIDE_COLORS: Readonly<Record<MenuBoardScreenShape, string>> = {
  landscape: "#2e86ab",
  portrait: "#e0782f",
  tablet: "#8a5cd6",
};

/** The aspects that a canvas board stretches to on a screen (board-view). */
const GUIDE_ASPECT = { min: 0.4, max: 3 } as const;

function otherShapes(shape: MenuBoardScreenShape): MenuBoardScreenShape[] {
  return (Object.keys(SHAPE_NAMES) as MenuBoardScreenShape[]).filter((other) => other !== shape);
}

/**
 * Dashed outlines of the other screen shapes on the board: a screen draws a
 * free canvas at the board's height and its own width, so each guide is a
 * band of that width, centred. An element outside a band moves by its
 * constraints on that screen; "Show on" draws the exact result.
 */
function screenGuides(
  shape: MenuBoardScreenShape,
  design: BoardSize,
  width: number,
  hidden: ReadonlySet<MenuBoardScreenShape>,
): React.ReactNode {
  const scale = width / design.width;
  return otherShapes(shape).filter((other) => !hidden.has(other)).map((other) => {
    const size = MENU_BOARD_SCREEN_SIZES[other];
    const aspect = Math.min(GUIDE_ASPECT.max, Math.max(GUIDE_ASPECT.min, size.width / size.height));
    const band = design.height * aspect * scale;
    const ratio = other === "landscape" ? "16 : 9" : other === "portrait" ? "9 : 16" : "4 : 3";
    return <div
      key={other}
      className="menu-canvas-screen-guide"
      data-shape={other}
      style={{ left: (width - band) / 2, width: band, height: design.height * scale, "--guide": GUIDE_COLORS[other] } as React.CSSProperties}
      aria-hidden="true"
    >
      <span>{SHAPE_NAMES[other]} {ratio}</span>
    </div>;
  });
}

const ALIGN_ICONS: Readonly<Record<Alignment, LucideIcon>> = {
  left: AlignStartVertical,
  center: AlignCenterVertical,
  right: AlignEndVertical,
  top: AlignStartHorizontal,
  middle: AlignCenterHorizontal,
  bottom: AlignEndHorizontal,
};

function LayersPanel(props: Readonly<{
  elements: readonly MenuBoardElement[];
  selected: ReadonlySet<string>;
  editable: boolean;
  participants: readonly MenuBoardPresenceView[];
  agents: readonly CanvasAgentMark[];
  design: BoardSize;
  onSelect: (elementId: string, extend: boolean) => void;
  onRestack: (direction: "front" | "back" | "forward" | "backward") => void;
}>): React.ReactNode {
  const layers = [...props.elements]
    .filter((element) => element.placement.frameId === "canvas")
    .sort((first, second) => second.placement.order - first.placement.order || second.id.localeCompare(first.id))
    .flatMap((element) => [
      element,
      // The elements of a stack follow it, in their order (slice 8).
      ...props.elements
        .filter((child) => child.placement.frameId === "stack" && child.placement.stackId === element.id)
        .sort((first, second) => first.placement.order - second.placement.order || first.id.localeCompare(second.id)),
    ]);
  return <aside className="menu-canvas-layers" aria-label="Layers">
    <header>
      <h3>Layers</h3>
      <span>Front at the top</span>
    </header>
    <ol>
      {layers.map((element) => {
        const editors = props.participants.filter((participant) =>
          selectedIds(participant.selection).includes(element.id));
        return <li key={element.id} data-in-stack={element.placement.frameId === "stack" ? "true" : undefined}>
          <button
            type="button"
            aria-pressed={props.selected.has(element.id)}
            onClick={(event) => props.onSelect(element.id, event.shiftKey || event.metaKey || event.ctrlKey)}
          >
            <span className="menu-canvas-layer-name">{ELEMENT_NAMES[element.kind]}</span>
            <span className="menu-canvas-layer-detail">{layerDetail(element)}</span>
            {editors.map((participant) => <span
              key={participant.sessionId}
              className="menu-canvas-layer-editor"
              title={`${participant.displayName} has this selected`}
              style={{ "--participant": participantColor(participant.userId) } as React.CSSProperties}
            >
              {initials(participant.displayName)}
            </span>)}
            {agentsOnElement(props.agents, element.id).map((mark) => <span
              key={mark.key}
              className="menu-canvas-layer-agent"
              data-agent-color={mark.color}
              title={`${mark.name}, an AI agent, is ${mark.label}`}
            >
              AI · {mark.name}
            </span>)}
          </button>
        </li>;
      })}
    </ol>
    <div className="menu-canvas-layer-actions">
      <button type="button" className="secondary" disabled={!props.editable || props.selected.size === 0} onClick={() => props.onRestack("front")}>To front</button>
      <button type="button" className="secondary" disabled={!props.editable || props.selected.size === 0} onClick={() => props.onRestack("forward")}>Forward</button>
      <button type="button" className="secondary" disabled={!props.editable || props.selected.size === 0} onClick={() => props.onRestack("backward")}>Backward</button>
      <button type="button" className="secondary" disabled={!props.editable || props.selected.size === 0} onClick={() => props.onRestack("back")}>To back</button>
    </div>
  </aside>;
}

/** The position, size and constraints of one canvas element, as fields. */
export function CanvasPlacementFields(props: Readonly<{
  element: MenuBoardElement;
  placement: MenuBoardCanvasPlacement;
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
}>): React.ReactNode {
  const { placement } = props;
  const set = (next: Partial<MenuBoardCanvasPlacement>): void => {
    props.client.current?.moveElement(props.element.id, { ...placement, ...next });
  };
  const number = (key: keyof MenuBoardRect, label: string): React.ReactNode => <label key={key}>
    <span>{label}</span>
    <input
      type="number"
      value={placement.rect[key]}
      disabled={!props.editable}
      onChange={(event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        set({ rect: normalizeRect({ ...placement.rect, [key]: value }) });
      }}
    />
  </label>;
  return <div className="menu-canvas-fields">
    <div className="menu-canvas-fields-grid">
      {number("x", "X")}
      {number("y", "Y")}
      {number("width", "Width")}
      {number("height", "Height")}
    </div>
    <label>
      <span>On a wider or narrower screen</span>
      <Select.Root
        items={HORIZONTAL_CONSTRAINTS}
        value={placement.constraints.horizontal}
        disabled={!props.editable}
        onValueChange={(value) => {
          if (value !== null) set({ constraints: { ...placement.constraints, horizontal: value as MenuBoardHorizontalConstraint } });
        }}
      >
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{HORIZONTAL_CONSTRAINTS.map((choice) => <Select.Item key={choice.value} value={choice.value}>{choice.label}</Select.Item>)}</Select.Popup>
      </Select.Root>
    </label>
    <label>
      <span>On a taller or shorter screen</span>
      <Select.Root
        items={VERTICAL_CONSTRAINTS}
        value={placement.constraints.vertical}
        disabled={!props.editable}
        onValueChange={(value) => {
          if (value !== null) set({ constraints: { ...placement.constraints, vertical: value as MenuBoardVerticalConstraint } });
        }}
      >
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{VERTICAL_CONSTRAINTS.map((choice) => <Select.Item key={choice.value} value={choice.value}>{choice.label}</Select.Item>)}</Select.Popup>
      </Select.Root>
    </label>
  </div>;
}

/** The elements that a person has selected or is moving. */
function selectedIds(selection: MenuBoardPresenceSelection | null): readonly string[] {
  if (selection === null) return [];
  switch (selection.kind) {
    case "element":
      return [selection.elementId];
    case "moving":
      return selection.elementIds;
    case "frame":
      return [];
    default:
      return selection satisfies never;
  }
}

function presenceOf(selection: readonly string[]): MenuBoardPresenceSelection | null {
  const first = selection[0];
  return first === undefined ? null : { kind: "element", elementId: first };
}

/**
 * Where other people's drags in progress show the elements (Plan 40B
 * phase 5, slice 5). A move adds its offset while the elements are still
 * where the drag began; once the drag's edit arrives, they are not, and the
 * draft shows the new place.
 */
/** The selections of this person, the other people and the agents. */
function canvasRulerRanges(
  own: ReadonlyMap<string, MenuBoardRect>,
  remote: readonly MenuBoardPresenceView[],
  rects: ReadonlyMap<string, MenuBoardRect>,
  agents: readonly CanvasAgentMark[],
): RulerRange[] {
  const ranges: RulerRange[] = [];
  const mine = boundsOf([...own.values()]);
  if (mine !== null) ranges.push({ key: "self", who: "You", rect: mine, color: SELF_COLOR, agentColor: null });
  for (const participant of remote) {
    const bounds = boundsOf(selectedIds(participant.selection).flatMap((id) => {
      const rect = rects.get(id);
      return rect === undefined ? [] : [rect];
    }));
    if (bounds !== null)
      ranges.push({
        key: `person:${participant.sessionId}`,
        who: participant.displayName,
        rect: bounds,
        color: participantColor(participant.userId),
        agentColor: null,
      });
  }
  for (const mark of agents) {
    const rect = mark.action.state === "pending" && mark.action.rect !== null ? mark.action.rect : mark.target;
    if (rect !== null)
      ranges.push({ key: `agent:${mark.key}`, who: mark.name, rect, color: null, agentColor: mark.color });
  }
  return ranges;
}

/** This person's selection outline colour (canvas-editor.css). */
const SELF_COLOR = "#f29e4c";

/** The boxes that move or change size now: a person's drag, or an agent's pending edit. */
function measuredBoxes(
  drag: Drag | null,
  moving: ReadonlyMap<string, Readonly<{ rect: MenuBoardRect; sessionId: string }>>,
  remote: readonly MenuBoardPresenceView[],
  agents: readonly CanvasAgentMark[],
): MeasuredBox[] {
  const boxes: MeasuredBox[] = [];
  if (drag !== null && drag.moved) {
    const rect = boundsOf([...drag.current.values()]);
    if (rect !== null) boxes.push({ key: "self", who: "You", rect, elementIds: new Set(drag.current.keys()), size: true });
  }
  const bySession = new Map<string, string[]>();
  for (const [id, entry] of moving) bySession.set(entry.sessionId, [...(bySession.get(entry.sessionId) ?? []), id]);
  for (const [sessionId, ids] of bySession) {
    const rect = boundsOf(ids.flatMap((id) => {
      const entry = moving.get(id);
      return entry === undefined ? [] : [entry.rect];
    }));
    const who = remote.find((participant) => participant.sessionId === sessionId)?.displayName ?? "";
    if (rect !== null) boxes.push({ key: `person:${sessionId}`, who, rect, elementIds: new Set(ids), size: true });
  }
  for (const mark of agents) {
    const action = mark.action;
    if (action.state !== "pending" || action.rect === null) continue;
    if (action.kind !== "create" && action.kind !== "move" && action.kind !== "resize") continue;
    // The agent's tag shows the size already.
    boxes.push({ key: `agent:${mark.key}`, who: mark.name, rect: action.rect, elementIds: new Set(action.elementIds), size: false });
  }
  return boxes;
}

function remoteMoving(
  participants: readonly MenuBoardPresenceView[],
  drafted: ReadonlyMap<string, MenuBoardRect>,
): Map<string, Readonly<{ rect: MenuBoardRect; sessionId: string }>> {
  const moving = new Map<string, Readonly<{ rect: MenuBoardRect; sessionId: string }>>();
  for (const participant of participants) {
    const selection = participant.selection;
    if (selection?.kind !== "moving") continue;
    if (selection.rect !== null) {
      const id = selection.elementIds[0];
      if (id !== undefined && drafted.has(id)) moving.set(id, { rect: selection.rect, sessionId: participant.sessionId });
      continue;
    }
    const start = selection.elementIds.map((id) => drafted.get(id));
    if (selection.offset === null || selection.from === null || start.some((rect) => rect === undefined)) continue;
    const bounds = boundsOf(start.filter((rect): rect is MenuBoardRect => rect !== undefined));
    if (bounds === null || bounds.x !== selection.from.x || bounds.y !== selection.from.y) continue;
    const offset = selection.offset;
    selection.elementIds.forEach((id, index) => {
      const rect = start[index];
      if (rect !== undefined)
        moving.set(id, { rect: { ...rect, x: rect.x + offset.x, y: rect.y + offset.y }, sessionId: participant.sessionId });
    });
  }
  return moving;
}

/** Whether an element sits on the canvas itself, not in a stack. */
function onCanvas(elements: readonly MenuBoardElement[], id: string): boolean {
  return elements.some((element) => element.id === id && element.placement.frameId === "canvas");
}

/** The stack that holds an element, or null. */
function stackOf(elements: readonly MenuBoardElement[], id: string): string | null {
  const placement = elements.find((element) => element.id === id)?.placement;
  return placement?.frameId === "stack" ? placement.stackId : null;
}

/** The selected elements that a new stack can hold: canvas elements, not stacks. */
function stackable(elements: readonly MenuBoardElement[], selected: ReadonlySet<string>): MenuBoardElement[] {
  return elements.filter((element) =>
    selected.has(element.id) && element.kind !== "stack" && element.placement.frameId === "canvas");
}

/**
 * A new stack around `members` (Plan 40B phase 5, slice 8): its rect is
 * their bounds, its gap the mean space between them, and each keeps its
 * size, in its order along the stack's direction.
 */
function stackFor(
  members: readonly MenuBoardElement[],
  rects: ReadonlyMap<string, MenuBoardRect>,
  direction: "vertical" | "horizontal",
): Readonly<{ stack: MenuBoardElement; placements: MenuBoardElementPlacement[] }> | null {
  const vertical = direction === "vertical";
  const placed = members.flatMap((element) => {
    const rect = rects.get(element.id);
    return rect === undefined ? [] : [{ element, rect }];
  }).sort((first, second) => vertical
    ? first.rect.y - second.rect.y || first.rect.x - second.rect.x
    : first.rect.x - second.rect.x || first.rect.y - second.rect.y);
  const bounds = boundsOf(placed.map(({ rect }) => rect));
  if (placed.length < 2 || bounds === null) return null;
  const spaces = placed.slice(1).map(({ rect }, index) => {
    const before = placed[index]?.rect;
    if (before === undefined) return 0;
    return vertical ? rect.y - (before.y + before.height) : rect.x - (before.x + before.width);
  });
  const gap = Math.max(0, Math.min(MENU_BOARD_STACK_SPACING_LIMIT,
    Math.round(spaces.reduce((sum, space) => sum + space, 0) / spaces.length)));
  const order = Math.min(...placed.map(({ element }) => element.placement.order));
  const id = `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const stack: MenuBoardElement = {
    id,
    kind: "stack",
    placement: { frameId: "canvas", order, rect: normalizeRect(bounds), constraints: MENU_BOARD_DEFAULT_CONSTRAINTS },
    direction,
    gap: String(gap),
    padding: "0",
    align: "start",
  };
  return {
    stack,
    placements: placed.map(({ element, rect }, index) => ({
      elementId: element.id,
      placement: { frameId: "stack", stackId: id, order: index, size: { width: rect.width, height: rect.height } },
    })),
  };
}

/** Canvas places for the elements of a stack, where the stack shows them now. */
export function unstackPlacements(
  elements: readonly MenuBoardElement[],
  stackId: string,
  rects: ReadonlyMap<string, MenuBoardRect>,
): MenuBoardElementPlacement[] {
  const stack = elements.find((element) => element.id === stackId);
  const base = stack?.placement.frameId === "canvas" ? stack.placement.order : 0;
  return elements.flatMap((element) => {
    const rect = rects.get(element.id);
    if (element.placement.frameId !== "stack" || element.placement.stackId !== stackId || rect === undefined) return [];
    return [{
      elementId: element.id,
      placement: { frameId: "canvas", order: base, rect: normalizeRect(rect), constraints: MENU_BOARD_DEFAULT_CONSTRAINTS },
    }];
  });
}

function withRect(rects: ReadonlyMap<string, MenuBoardRect>, element: MenuBoardElement): MenuBoardElement {
  const rect = rects.get(element.id);
  return rect === undefined || element.placement.frameId !== "canvas"
    ? element
    : { ...element, placement: { ...element.placement, rect } };
}

/** Copies of the selected elements, a little lower and to the right. */
function duplicate(
  client: MenuBoardClient | null,
  elements: readonly MenuBoardElement[],
  selected: ReadonlySet<string>,
): string[] {
  if (client === null) return [...selected];
  let order = elements.reduce((highest, element) => Math.max(highest, element.placement.order + 1), 0);
  const copies: string[] = [];
  for (const element of elements) {
    if (!selected.has(element.id) || element.placement.frameId !== "canvas") continue;
    const id = `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const rect = element.placement.rect;
    client.addElement({
      ...element,
      id,
      placement: {
        ...element.placement,
        order: order++,
        rect: normalizeRect({ ...rect, x: rect.x + DUPLICATE_OFFSET, y: rect.y + DUPLICATE_OFFSET }),
      },
    } as MenuBoardElement);
    copies.push(id);
  }
  return copies;
}

function arrowDelta(key: string, step: number): Readonly<{ x: number; y: number }> | null {
  switch (key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}

function isTyping(target: EventTarget): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function boardPoint(event: React.PointerEvent, surface: HTMLElement | null, scale: number): Readonly<{ x: number; y: number }> {
  const box = surface?.getBoundingClientRect();
  if (box === undefined || scale === 0) return { x: 0, y: 0 };
  return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
}

function rectStyle(rect: MenuBoardRect): React.CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** A handle keeps the same size on screen at every zoom. */
function handleStyle(rect: MenuBoardRect, handle: Handle, scale: number): React.CSSProperties {
  const size = 10 / (scale === 0 ? 1 : scale);
  const x = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
  return { left: x - size / 2, top: y - size / 2, width: size, height: size };
}

function layerDetail(element: MenuBoardElement): string {
  switch (element.kind) {
    case "heading":
      return element.title;
    case "text":
      return element.text;
    case "featured":
      return element.label;
    case "order_qr":
      return element.title;
    case "pickup_codes":
      return element.title;
    case "section":
      return element.note;
    case "image":
      return element.altText;
    case "stack":
      return `${element.direction === "vertical" ? "Down" : "Across"} · gap ${element.gap} · padding ${element.padding}`;
    default:
      return element satisfies never;
  }
}

const PARTICIPANT_COLORS = ["#E4572E", "#2E86AB", "#7A9E3B", "#B5179E", "#F29E4C", "#3F88C5"] as const;

export function participantColor(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0];
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
