import React from "react";
import type { CollaborationAgentColorKey } from "@seams/collaboration";
import type { MenuBoardRect } from "@seams/menu-board-crdt/board";
import type { BoardSize } from "./board-view";
import "./canvas-rulers.css";

/**
 * Rulers, size badges and spacing numbers on the free canvas (Plan 40B phase
 * 7, slice 5), for people and agents. The rulers stand on the board's top
 * and left edges, so the floating panels never cover them, and each actor's
 * selection shows on them as a range in that actor's colour. A drag or a
 * resize, a person's or an agent's, shows its size and, in red, the
 * distance to the nearest element on each side, or to the board's edge.
 * The snap guides stay as they are. No wire format changes: everything
 * here comes from the presence that the canvas already has.
 */

/** One actor's selection, as a range on each ruler. */
export type RulerRange = Readonly<{
  key: string;
  who: string;
  rect: MenuBoardRect;
  /** A person's colour; an agent has `agentColor` instead. */
  color: string | null;
  agentColor: CollaborationAgentColorKey | null;
}>;

/** A box that moves or changes size now, with the elements that it carries. */
export type MeasuredBox = Readonly<{
  key: string;
  who: string;
  rect: MenuBoardRect;
  /** The elements in the box, which are no neighbours of it. */
  elementIds: ReadonlySet<string>;
  /** False when the box already shows its size elsewhere (an agent's tag). */
  size: boolean;
}>;

const RULER_PX = 18;
const TICK_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000] as const;
/** A label needs this much room on the screen. */
const LABEL_PX = 44;

/** The rulers on the board's top and left edges, in screen pixels. */
export function CanvasRulers(props: Readonly<{
  /** The board's width on the screen. */
  width: number;
  design: BoardSize;
  ranges: readonly RulerRange[];
}>): React.ReactNode {
  if (props.width <= 0) return null;
  const scale = props.width / props.design.width;
  const step = TICK_STEPS.find((candidate) => candidate * scale >= LABEL_PX) ?? 1000;
  return <>
    <Ruler axis="x" length={props.design.width} scale={scale} step={step} ranges={props.ranges} />
    <Ruler axis="y" length={props.design.height} scale={scale} step={step} ranges={props.ranges} />
  </>;
}

function Ruler(props: Readonly<{
  axis: "x" | "y";
  length: number;
  scale: number;
  step: number;
  ranges: readonly RulerRange[];
}>): React.ReactNode {
  const { axis, scale, step } = props;
  const ticks: number[] = [];
  for (let at = 0; at <= props.length; at += step) ticks.push(at);
  const extent = props.length * scale;
  return <div
    className="menu-canvas-ruler"
    data-axis={axis}
    aria-hidden="true"
    style={axis === "x"
      ? { width: extent, height: RULER_PX }
      : { height: extent, width: RULER_PX }}
  >
    {props.ranges.map((range) => {
      const start = axis === "x" ? range.rect.x : range.rect.y;
      const size = axis === "x" ? range.rect.width : range.rect.height;
      const from = Math.max(0, start) * scale;
      const to = Math.min(props.length, start + size) * scale;
      if (to <= from) return null;
      return <span
        key={range.key}
        className="menu-canvas-ruler-range"
        data-who={range.who}
        data-agent-color={range.agentColor ?? undefined}
        data-start={Math.round(start)}
        data-end={Math.round(start + size)}
        style={{
          ...(axis === "x" ? { left: from, width: to - from } : { top: from, height: to - from }),
          ...(range.color === null ? {} : { "--range": range.color }),
        } as React.CSSProperties}
      />;
    })}
    {ticks.map((at) => <span
      key={at}
      className="menu-canvas-ruler-tick"
      style={axis === "x" ? { left: at * scale } : { top: at * scale }}
    >
      <span className="menu-canvas-ruler-label">{at}</span>
    </span>)}
  </div>;
}

type Gap = Readonly<{
  side: "left" | "right" | "top" | "bottom";
  /** The line of the gap, in board units. */
  from: Readonly<{ x: number; y: number }>;
  to: Readonly<{ x: number; y: number }>;
  distance: number;
}>;

/**
 * The distance from a box to the nearest element on each side: an element
 * whose span across that side overlaps the box. With none, the distance
 * goes to the board's edge. A box over the edge shows no gap on that side.
 */
export function boxGaps(
  box: MenuBoardRect,
  others: readonly MenuBoardRect[],
  design: BoardSize,
): Gap[] {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const middleX = box.x + box.width / 2;
  const middleY = box.y + box.height / 2;
  const across = (other: MenuBoardRect, axis: "x" | "y"): boolean => axis === "x"
    ? other.y < bottom && other.y + other.height > box.y
    : other.x < right && other.x + other.width > box.x;
  const nearest = (distances: readonly number[], edge: number): number =>
    distances.length === 0 ? edge : Math.min(...distances);
  const gaps: Gap[] = [];
  const left = nearest(others.filter((other) => across(other, "x") && other.x + other.width <= box.x)
    .map((other) => box.x - (other.x + other.width)), box.x);
  if (left > 0) gaps.push({ side: "left", from: { x: box.x - left, y: middleY }, to: { x: box.x, y: middleY }, distance: left });
  const rightGap = nearest(others.filter((other) => across(other, "x") && other.x >= right)
    .map((other) => other.x - right), design.width - right);
  if (rightGap > 0) gaps.push({ side: "right", from: { x: right, y: middleY }, to: { x: right + rightGap, y: middleY }, distance: rightGap });
  const top = nearest(others.filter((other) => across(other, "y") && other.y + other.height <= box.y)
    .map((other) => box.y - (other.y + other.height)), box.y);
  if (top > 0) gaps.push({ side: "top", from: { x: middleX, y: box.y - top }, to: { x: middleX, y: box.y }, distance: top });
  const bottomGap = nearest(others.filter((other) => across(other, "y") && other.y >= bottom)
    .map((other) => other.y - bottom), design.height - bottom);
  if (bottomGap > 0) gaps.push({ side: "bottom", from: { x: middleX, y: bottom }, to: { x: middleX, y: bottom + bottomGap }, distance: bottomGap });
  return gaps;
}

/** The size badges and spacing numbers of the boxes that move now. */
export function CanvasMeasures(props: Readonly<{
  boxes: readonly MeasuredBox[];
  rects: ReadonlyMap<string, MenuBoardRect>;
  design: BoardSize;
  scale: number;
}>): React.ReactNode {
  const inverse = props.scale === 0 ? 1 : 1 / props.scale;
  return props.boxes.map((box) => {
    const others = [...props.rects].filter(([id]) => !box.elementIds.has(id)).map(([, rect]) => rect);
    const line = Math.max(1, inverse);
    return <div key={box.key} className="menu-canvas-measure" data-who={box.who}>
      {boxGaps(box.rect, others, props.design).map((gap) => {
        const horizontal = gap.side === "left" || gap.side === "right";
        return <React.Fragment key={gap.side}>
          <span
            className="menu-canvas-spacing-line"
            data-side={gap.side}
            style={horizontal
              ? { left: gap.from.x, top: gap.from.y - line / 2, width: gap.distance, height: line }
              : { left: gap.from.x - line / 2, top: gap.from.y, width: line, height: gap.distance }}
          />
          <span
            className="menu-canvas-spacing"
            data-side={gap.side}
            data-distance={Math.round(gap.distance)}
            style={{
              left: (gap.from.x + gap.to.x) / 2,
              top: (gap.from.y + gap.to.y) / 2,
              transform: `translate(-50%, -50%) scale(${inverse})`,
            }}
          >
            {Math.round(gap.distance)}
          </span>
        </React.Fragment>;
      })}
      {box.size ? <span
        className="menu-canvas-measure-size"
        style={{
          left: box.rect.x + box.rect.width / 2,
          top: box.rect.y + box.rect.height + 8 * inverse,
          transform: `translate(-50%, 0) scale(${inverse})`,
        }}
      >
        {Math.round(box.rect.width)} × {Math.round(box.rect.height)}
      </span> : null}
    </div>;
  });
}
