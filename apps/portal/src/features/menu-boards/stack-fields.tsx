import React from "react";
import {
  MENU_BOARD_STACK_SPACING_LIMIT,
  menuBoardCanvasRects,
  type MenuBoardElement,
  type MenuBoardStackPlacement,
} from "@seams/menu-board-crdt/board";
import { Select } from "../../ui/select";
import type { MenuBoardClient } from "./board-client";
import { unstackPlacements } from "./canvas-editor";
import { normalizeRect } from "./canvas-geometry";

/**
 * The drawer fields of an auto-layout stack and of an element in one
 * (Plan 40B phase 5, slice 8). A stack's direction, gap, padding and
 * alignment are separate props, so two people who change two of them both
 * keep their change.
 */

type StackElement = Extract<MenuBoardElement, { kind: "stack" }>;

const DIRECTIONS = [
  { value: "vertical", label: "Down" },
  { value: "horizontal", label: "Across" },
];

type Choice = Readonly<{ value: string; label: string }>;

function renderChoice(choice: Choice): React.ReactNode {
  return <Select.Item key={choice.value} value={choice.value}>{choice.label}</Select.Item>;
}

export function StackFields(props: Readonly<{
  element: StackElement;
  elements: readonly MenuBoardElement[];
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
  onUnstacked: () => void;
}>): React.ReactNode {
  const { element } = props;
  const set = (key: string, value: string): void => {
    props.client.current?.updateElement(element.id, { [key]: value });
  };
  const spacing = (key: "gap" | "padding", label: string): React.ReactNode => <label key={key}>
    <span>{label}</span>
    <input
      type="number"
      min={0}
      max={MENU_BOARD_STACK_SPACING_LIMIT}
      value={element[key]}
      disabled={!props.editable}
      onChange={(event) => {
        const value = Math.round(Number(event.target.value));
        if (!Number.isFinite(value)) return;
        set(key, String(Math.max(0, Math.min(MENU_BOARD_STACK_SPACING_LIMIT, value))));
      }}
    />
  </label>;
  const alignments: readonly Choice[] = [
    { value: "start", label: element.direction === "vertical" ? "Left" : "Top" },
    { value: "center", label: "Centre" },
    { value: "end", label: element.direction === "vertical" ? "Right" : "Bottom" },
    { value: "stretch", label: "Fill the stack" },
  ];
  const count = props.elements.filter((candidate) =>
    candidate.placement.frameId === "stack" && candidate.placement.stackId === element.id).length;
  return <>
    <p className="menu-boards-drawer-note">
      {count === 1 ? "1 element" : `${count} elements`} in this stack. Each keeps its size along the stack; the stack places them.
    </p>
    <label>
      <span>Direction</span>
      <Select.Root items={DIRECTIONS} value={element.direction} disabled={!props.editable} onValueChange={(value) => { if (value !== null) set("direction", value); }}>
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{DIRECTIONS.map(renderChoice)}</Select.Popup>
      </Select.Root>
    </label>
    <div className="menu-canvas-fields-grid">
      {spacing("gap", "Gap")}
      {spacing("padding", "Padding")}
    </div>
    <label>
      <span>{element.direction === "vertical" ? "Across the stack" : "Down the stack"}</span>
      <Select.Root items={alignments} value={element.align} disabled={!props.editable} onValueChange={(value) => { if (value !== null) set("align", value); }}>
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{alignments.map(renderChoice)}</Select.Popup>
      </Select.Root>
    </label>
    <button
      type="button"
      className="secondary"
      disabled={!props.editable}
      onClick={() => {
        props.client.current?.unstack(element.id, unstackPlacements(props.elements, element.id, canvasRects(props.elements)));
        props.onUnstacked();
      }}
    >
      Unstack
    </button>
  </>;
}

export function StackChildFields(props: Readonly<{
  element: MenuBoardElement;
  placement: MenuBoardStackPlacement;
  elements: readonly MenuBoardElement[];
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
}>): React.ReactNode {
  const { element, placement } = props;
  const siblings = props.elements
    .filter((candidate) => candidate.placement.frameId === "stack" && candidate.placement.stackId === placement.stackId)
    .sort((first, second) => first.placement.order - second.placement.order || first.id.localeCompare(second.id));
  const index = siblings.findIndex((candidate) => candidate.id === element.id);
  /** Swaps this element with its neighbour, as one edit. */
  const move = (step: -1 | 1): void => {
    const other = siblings[index + step];
    if (other === undefined || other.placement.frameId !== "stack") return;
    props.client.current?.placeElements([
      { elementId: element.id, placement: { ...placement, order: other.placement.order === placement.order ? placement.order + step : other.placement.order } },
      { elementId: other.id, placement: { ...other.placement, order: placement.order } },
    ]);
  };
  const size = (key: "width" | "height", label: string): React.ReactNode => <label key={key}>
    <span>{label}</span>
    <input
      type="number"
      value={placement.size[key]}
      disabled={!props.editable}
      onChange={(event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        const next = normalizeRect({ x: 0, y: 0, ...placement.size, [key]: value });
        props.client.current?.moveElement(element.id, { ...placement, size: { width: next.width, height: next.height } });
      }}
    />
  </label>;
  return <div className="menu-canvas-fields">
    <div className="menu-canvas-fields-grid">
      {size("width", "Width")}
      {size("height", "Height")}
    </div>
    <div className="menu-boards-drawer-actions">
      <button type="button" className="secondary" disabled={!props.editable || index <= 0} onClick={() => move(-1)}>Earlier in the stack</button>
      <button type="button" className="secondary" disabled={!props.editable || index < 0 || index >= siblings.length - 1} onClick={() => move(1)}>Later in the stack</button>
      <button
        type="button"
        className="secondary"
        disabled={!props.editable}
        onClick={() => {
          const rect = canvasRects(props.elements).get(element.id);
          const stack = props.elements.find((candidate) => candidate.id === placement.stackId);
          if (rect === undefined || stack?.placement.frameId !== "canvas") return;
          props.client.current?.moveElement(element.id, {
            frameId: "canvas",
            order: stack.placement.order + 1,
            rect: normalizeRect(rect),
            constraints: stack.placement.constraints,
          });
        }}
      >
        Take out of the stack
      </button>
    </div>
  </div>;
}

/**
 * Each element's rect as the board's own shape draws it: the stored rects,
 * with the elements of each stack placed.
 */
function canvasRects(elements: readonly MenuBoardElement[]) {
  const same = { width: 1, height: 1 };
  return menuBoardCanvasRects(elements, same, same);
}
