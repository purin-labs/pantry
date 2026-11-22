import React from "react";
import { MoreHorizontal } from "lucide-react";

import { HoverLabel } from "./hover-label";
import "./overflow-toolbar.css";

/** A control as an entry of a menu, for a row whose menu takes the overflow. */
export type ToolbarMenuEntry = Readonly<{
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}>;

/**
 * One control of a toolbar. A pinned control never moves into the overflow.
 * A control whose node is a function is the row's own menu: it stays, and it
 * lists the controls that do not fit, so that the row draws no second
 * ellipsis. In such a row only a control with a menu entry can move.
 */
export type ToolbarItem = Readonly<{
  key: string;
  node:
    | React.ReactNode
    | ((overflow: readonly ToolbarMenuEntry[]) => React.ReactNode);
  pinned?: boolean;
  menuEntry?: ToolbarMenuEntry;
  /** The label that shows on hover, such as "Close conversation". */
  label?: string;
}>;

type Props = Readonly<{
  items: readonly ToolbarItem[];
  /** The name of the overflow button, such as "More conversation tools". */
  overflowLabel: string;
  className?: string;
}>;

/** The overflow button's width when no control has measured it. */
const OVERFLOW_BUTTON_WIDTH = 32;

/**
 * A row of controls that keeps what fits. The controls that do not fit move,
 * from the start of the row, behind one ellipsis button. The row asks for the
 * width of all its controls, so that its container sizes it for all of them,
 * and it shrinks when the container gives it less.
 */
export function OverflowToolbar(props: Props): React.ReactNode {
  const row = React.useRef<HTMLDivElement>(null);
  const widths = React.useRef(new Map<string, number>());
  const [layout, setLayout] = React.useState<RowLayout>(FULL_ROW);
  const [open, setOpen] = React.useState(false);
  React.useLayoutEffect(
    measureRow.bind(null, row, widths, props.items, setLayout),
  );
  React.useEffect(observeRow.bind(null, row, setLayout), []);
  React.useEffect(closeOverflowWhenEmpty.bind(null, layout, setOpen), [layout]);
  const hidden = new Set(
    collapsible(props.items).slice(0, layout.hidden).map(itemKey),
  );
  const shown = props.items.filter(isShown.bind(null, hidden));
  const overflow = props.items.filter(isHidden.bind(null, hidden));
  const host = props.items.some(isMenuHost);
  const entries = overflow.flatMap(menuEntryOf);
  return (
    <div
      ref={row}
      className={
        props.className === undefined
          ? "overflow-toolbar"
          : `overflow-toolbar ${props.className}`
      }
      style={layout.natural === null ? undefined : { width: layout.natural }}
    >
      {overflow.length === 0 || host ? null : (
        <OverflowButton
          label={props.overflowLabel}
          open={open}
          setOpen={setOpen}
          items={overflow}
        />
      )}
      {shown.map(renderItem.bind(null, entries))}
    </div>
  );
}

type RowLayout = Readonly<{
  /** The width of the row with every control shown; null before a measure. */
  natural: number | null;
  /** How many collapsible controls wait behind the ellipsis. */
  hidden: number;
}>;

const FULL_ROW: RowLayout = { natural: null, hidden: 0 };

const NO_ENTRIES: readonly ToolbarMenuEntry[] = [];

function renderItem(
  entries: readonly ToolbarMenuEntry[],
  item: ToolbarItem,
): React.ReactNode {
  return (
    <div key={item.key} className="overflow-toolbar-item" data-key={item.key}>
      {item.label === undefined ? (
        itemNode(entries, item)
      ) : (
        <HoverLabel label={item.label}>{itemNode(entries, item)}</HoverLabel>
      )}
    </div>
  );
}

function itemNode(
  entries: readonly ToolbarMenuEntry[],
  item: ToolbarItem,
): React.ReactNode {
  return typeof item.node === "function" ? item.node(entries) : item.node;
}

function isMenuHost(item: ToolbarItem): boolean {
  return typeof item.node === "function";
}

function menuEntryOf(item: ToolbarItem): readonly ToolbarMenuEntry[] {
  return item.menuEntry === undefined ? [] : [item.menuEntry];
}

function itemKey(item: ToolbarItem): string {
  return item.key;
}

function collapsible(items: readonly ToolbarItem[]): readonly ToolbarItem[] {
  return items.filter(isCollapsible.bind(null, items.some(isMenuHost)));
}

function isCollapsible(host: boolean, item: ToolbarItem): boolean {
  if (item.pinned === true || isMenuHost(item)) return false;
  return !host || item.menuEntry !== undefined;
}

function isShown(hidden: ReadonlySet<string>, item: ToolbarItem): boolean {
  return !hidden.has(item.key);
}

function isHidden(hidden: ReadonlySet<string>, item: ToolbarItem): boolean {
  return hidden.has(item.key);
}

/**
 * Records the width of each shown control, then chooses how many controls
 * fit. A control behind the ellipsis keeps the width that it last had.
 */
function measureRow(
  row: React.RefObject<HTMLDivElement | null>,
  widths: React.RefObject<Map<string, number>>,
  items: readonly ToolbarItem[],
  setLayout: React.Dispatch<React.SetStateAction<RowLayout>>,
): void {
  const element = row.current;
  if (element === null) return;
  for (const child of element.querySelectorAll<HTMLElement>(
    ":scope > .overflow-toolbar-item",
  )) {
    const key = child.dataset.key;
    if (key !== undefined) {
      widths.current.set(key, child.getBoundingClientRect().width);
    }
  }
  const style = getComputedStyle(element);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const overflowButton = element.querySelector<HTMLElement>(
    ":scope > .overflow-toolbar-more",
  );
  const overflowWidth =
    overflowButton?.getBoundingClientRect().width ?? OVERFLOW_BUTTON_WIDTH;
  const width = widthOf.bind(null, widths.current);
  const natural = rowWidth(items.map(width), gap);
  const available = element.clientWidth;
  const choices = collapsible(items);
  // A row with its own menu needs no ellipsis for what does not fit.
  const extra = items.some(isMenuHost) ? [] : [overflowWidth];
  let hidden = 0;
  if (natural > available + 0.5) {
    const pinned = items
      .filter(isFixed.bind(null, new Set(choices.map(itemKey))))
      .map(width);
    hidden = choices.length;
    for (let count = 0; count < choices.length; count += 1) {
      const kept = choices.slice(count).map(width);
      if (rowWidth([...extra, ...pinned, ...kept], gap) <= available) {
        hidden = count;
        break;
      }
    }
  }
  setLayout(nextLayout.bind(null, natural, hidden));
}

function nextLayout(
  natural: number,
  hidden: number,
  current: RowLayout,
): RowLayout {
  return current.natural === natural && current.hidden === hidden
    ? current
    : { natural, hidden };
}

function isFixed(choices: ReadonlySet<string>, item: ToolbarItem): boolean {
  return !choices.has(item.key);
}

function widthOf(
  widths: ReadonlyMap<string, number>,
  item: ToolbarItem,
): number {
  return widths.get(item.key) ?? OVERFLOW_BUTTON_WIDTH;
}

function rowWidth(widths: readonly number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce(sum, 0) + gap * (widths.length - 1);
}

function sum(total: number, width: number): number {
  return total + width;
}

/** A new container width asks the row to choose again. */
function observeRow(
  row: React.RefObject<HTMLDivElement | null>,
  setLayout: React.Dispatch<React.SetStateAction<RowLayout>>,
): (() => void) | undefined {
  const element = row.current;
  if (element === null || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(remeasure.bind(null, setLayout));
  observer.observe(element);
  return observer.disconnect.bind(observer);
}

function remeasure(
  setLayout: React.Dispatch<React.SetStateAction<RowLayout>>,
): void {
  setLayout(copyLayout);
}

function copyLayout(current: RowLayout): RowLayout {
  return { ...current };
}

function closeOverflowWhenEmpty(
  layout: RowLayout,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  if (layout.hidden === 0) setOpen(false);
}

/**
 * The ellipsis. It opens a small tray with the controls that do not fit, so
 * that each control keeps its own behaviour, menus included.
 */
function OverflowButton(
  props: Readonly<{
    label: string;
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    items: readonly ToolbarItem[];
  }>,
): React.ReactNode {
  const root = React.useRef<HTMLDivElement>(null);
  const trayId = React.useId();
  React.useEffect(
    bindTrayDismissal.bind(null, root, props.open, props.setOpen),
    [props.open],
  );
  return (
    <div
      ref={root}
      className="overflow-toolbar-more"
      onKeyDown={closeOnEscape.bind(null, root, props.open, props.setOpen)}
    >
      <HoverLabel label={props.label}>
        <button
          type="button"
          className="overflow-toolbar-button"
          aria-label={props.label}
          aria-expanded={props.open}
          aria-controls={trayId}
          onClick={props.setOpen.bind(null, toggle)}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </HoverLabel>
      <div
        id={trayId}
        className="overflow-toolbar-tray"
        role="group"
        aria-label={props.label}
        hidden={!props.open}
      >
        {props.open ? props.items.map(renderItem.bind(null, NO_ENTRIES)) : null}
      </div>
    </div>
  );
}

function toggle(open: boolean): boolean {
  return !open;
}

/**
 * A click outside the tray closes it. A menu that a tray control opens draws
 * outside the tray, so a click in that menu keeps the tray open.
 */
function bindTrayDismissal(
  root: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): (() => void) | undefined {
  if (!open) return;
  const click = closeOnOutsideClick.bind(null, root, setOpen);
  document.addEventListener("click", click);
  return removeOutsideClick.bind(null, click);
}

function removeOutsideClick(click: (event: MouseEvent) => void): void {
  document.removeEventListener("click", click);
}

function closeOnOutsideClick(
  root: React.RefObject<HTMLDivElement | null>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: MouseEvent,
): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (root.current?.contains(target)) return;
  if (
    target instanceof Element &&
    target.closest("[data-radix-popper-content-wrapper]") !== null
  ) {
    return;
  }
  setOpen(false);
}

/** Escape closes an open tray and nothing else, such as the pane. */
function closeOnEscape(
  root: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: React.KeyboardEvent<HTMLDivElement>,
): void {
  if (!open || event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  setOpen(false);
  root.current
    ?.querySelector<HTMLButtonElement>(".overflow-toolbar-button")
    ?.focus();
}
