import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export type LabelSwatch = Readonly<{ color: string; text: string }>;

/** Structured label text. The element is rebuilt only when the text changes. */
export type LabelContent = Readonly<{
  kind: "station" | "batch" | "worker";
  badge: string | null;
  title: string;
  swatches: readonly LabelSwatch[];
  status: string | null;
  lines: readonly string[];
  selected: boolean;
  hovered: boolean;
  /** Lower numbers keep their place when labels collide. */
  priority: number;
  /** Required labels move aside instead of hiding. */
  required: boolean;
}>;

type Box = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

type Placement = Readonly<{
  label: CSS2DObject;
  rect: DOMRect;
  priority: number;
  required: boolean;
}>;

const gap = 4;
const rendered = new WeakMap<HTMLElement, string>();

export function sceneLabel(text: string): CSS2DObject {
  const element = document.createElement("div");
  element.className = "workflow-scene-label";
  element.textContent = text;
  return new CSS2DObject(element);
}

export function setLabelContent(
  label: CSS2DObject,
  content: LabelContent,
): void {
  const element = label.element;
  element.dataset.kind = content.kind;
  element.dataset.priority = String(content.priority);
  element.dataset.required = String(content.required);
  element.dataset.selected = String(content.selected);
  element.dataset.hovered = String(content.hovered);
  const key = [
    content.badge,
    content.title,
    content.status,
    ...content.swatches.map(swatchKey),
    ...content.lines,
  ].join("␟");
  if (rendered.get(element) === key) return;
  rendered.set(element, key);
  const title = document.createElement("span");
  title.className = "workflow-scene-label-title";
  if (content.badge !== null)
    title.append(textSpan("workflow-scene-label-badge", content.badge));
  for (const swatch of content.swatches) {
    const item = textSpan("workflow-scene-label-swatch", swatch.text);
    item.style.setProperty("--swatch", swatch.color);
    title.append(item);
  }
  if (content.title !== "")
    title.append(textSpan("workflow-scene-label-name", content.title));
  if (content.status !== null) {
    const status = textSpan("workflow-scene-label-status", "");
    status.dataset.state = content.status;
    title.append(status);
  }
  element.replaceChildren(
    title,
    ...content.lines.map(textSpan.bind(null, "workflow-scene-label-line")),
  );
}

/**
 * Keeps labels readable: higher-priority labels keep their anchor, others try
 * nearby spots, and optional labels hide rather than pile up. Obstacles are
 * floating controls that labels must not sit under.
 */
export function arrangeLabels(
  labels: readonly CSS2DObject[],
  bounds: DOMRect,
  obstacles: readonly DOMRect[] = [],
): void {
  for (const label of labels) {
    const style = label.element.style;
    style.marginTop = "0px";
    style.marginLeft = "0px";
    style.visibility = "";
    delete label.element.dataset.leader;
  }
  const entries: Placement[] = [];
  for (const label of labels) {
    if (!label.visible) continue;
    const rect = label.element.getBoundingClientRect();
    if (rect.width === 0) continue;
    entries.push({
      label,
      rect,
      priority: Number(label.element.dataset.priority ?? "0"),
      required: label.element.dataset.required !== "false",
    });
  }
  entries.sort(byPriority);
  const occupied: Box[] = obstacles.filter(hasArea).map(toBox);
  const placed: Box[] = [];
  for (const entry of entries) {
    let chosen = firstFree(entry.rect, bounds, occupied);
    if (chosen === null) {
      if (!entry.required) {
        entry.label.element.style.visibility = "hidden";
        continue;
      }
      chosen = stacked(entry.rect, bounds, placed);
    }
    occupied.push(chosen);
    placed.push(chosen);
    const dx = chosen.left - entry.rect.left,
      dy = chosen.top - entry.rect.top;
    entry.label.element.style.marginLeft = `${dx}px`;
    entry.label.element.style.marginTop = `${dy}px`;
    drawLeader(entry.label.element, entry.rect, dx, dy);
  }
}

function firstFree(
  rect: DOMRect,
  bounds: DOMRect,
  occupied: readonly Box[],
): Box | null {
  const across = rect.width / 2 + gap,
    down = rect.height + gap;
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, -down],
    [0, down],
    [across, 0],
    [-across, 0],
    [across, -down],
    [-across, -down],
  ];
  for (const [dx, dy] of offsets) {
    const box = clamped(rect.left + dx, rect.top + dy, rect, bounds);
    if (!occupied.some(overlaps.bind(null, box))) return box;
  }
  return null;
}

function stacked(rect: DOMRect, bounds: DOMRect, placed: readonly Box[]): Box {
  let box = clamped(rect.left, rect.top, rect, bounds);
  for (const previous of placed) {
    if (overlaps(box, previous))
      box = clamped(box.left, previous.bottom + gap, rect, bounds);
  }
  return box;
}

function clamped(
  left: number,
  top: number,
  rect: DOMRect,
  bounds: DOMRect,
): Box {
  const x = Math.max(
    bounds.left + gap,
    Math.min(left, bounds.right - rect.width - gap),
  );
  const y = Math.max(
    bounds.top + gap,
    Math.min(top, bounds.bottom - rect.height - gap),
  );
  return { left: x, top: y, right: x + rect.width, bottom: y + rect.height };
}

/** Draws a short line from the moved label's edge back to its anchor. */
function drawLeader(
  element: HTMLElement,
  rect: DOMRect,
  dx: number,
  dy: number,
): void {
  const anchorX = rect.width / 2 - dx,
    anchorY = rect.height / 2 - dy;
  const startX = Math.max(0, Math.min(rect.width, anchorX)),
    startY = Math.max(0, Math.min(rect.height, anchorY));
  const length = Math.hypot(anchorX - startX, anchorY - startY);
  if (length < 6) return;
  element.dataset.leader = "true";
  element.style.setProperty("--leader-x", `${startX}px`);
  element.style.setProperty("--leader-y", `${startY}px`);
  element.style.setProperty("--leader-length", `${length}px`);
  element.style.setProperty(
    "--leader-angle",
    `${Math.atan2(anchorY - startY, anchorX - startX)}rad`,
  );
  element.style.setProperty("--anchor-x", `${anchorX}px`);
  element.style.setProperty("--anchor-y", `${anchorY}px`);
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right + gap &&
    a.right > b.left - gap &&
    a.top < b.bottom + gap &&
    a.bottom > b.top - gap
  );
}

function byPriority(a: Placement, b: Placement): number {
  return a.priority - b.priority;
}

function hasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function toBox(rect: DOMRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function swatchKey(swatch: LabelSwatch): string {
  return `${swatch.color}:${swatch.text}`;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
