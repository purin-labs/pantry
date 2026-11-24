import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  type MenuBoardCanvasPlacement,
  type MenuBoardConstraints,
  type MenuBoardElement,
  type MenuBoardFramePlacement,
  type MenuBoardLayout,
  type MenuBoardRect,
  type MenuBoardStart,
  MENU_BOARD_DESIGNS,
} from "./index.ts";
import type { MenuDraftSnapshot } from "@purin-labs/menu-draft-crdt";

/**
 * The elements of a new board (Plan 40B): a heading, one section list for
 * each menu section, a featured item and the order QR code, placed in a
 * fixed layout's frames or on the free canvas of its screen shape. A pickup
 * layout gets the two lists of order codes instead of a menu.
 */
export function templateElements(
  title: string,
  layout: MenuBoardLayout,
  menu: MenuDraftSnapshot,
  start: MenuBoardStart = "template",
): MenuBoardElement[] {
  // The start screen (Plan 40B): a blank canvas has no element, and a
  // designed pickup board shows the order codes on the canvas.
  if (start === "blank") return [];
  if (start !== "template" && MENU_BOARD_DESIGNS[start].pickup)
    return canvasPickupElements(title, layout);
  if (layout === "pickup_board" || layout === "portrait_pickup")
    return pickupElements(title);
  return MENU_BOARD_LAYOUTS[layout].canvas
    ? canvasElements(title, layout, menu)
    : frameElements(title, layout, menu);
}

function frameElements(
  title: string,
  layout: MenuBoardLayout,
  menu: MenuDraftSnapshot,
): MenuBoardElement[] {
  const portrait = MENU_BOARD_LAYOUTS[layout].orientation === "portrait";
  const columns = MENU_BOARD_LAYOUTS[layout].frames.filter(
    (frame): frame is MenuBoardFramePlacement["frameId"] =>
      frame.startsWith("column_"),
  );
  const last: MenuBoardFramePlacement["frameId"] = portrait
    ? "footer"
    : (columns.at(-1) ?? "column_1");
  const sectionColumns =
    columns.length > 1 && !portrait ? columns.slice(0, -1) : columns;
  const elements: MenuBoardElement[] = [
    heading(title, menu, { frameId: "header", order: 0 }),
  ];
  menu.sections.forEach((section, index) => {
    const frameId = portrait
      ? "column_1"
      : sectionColumns[Math.min(index, sectionColumns.length - 1)];
    if (frameId === undefined) return;
    elements.push({
      id: elementId(),
      kind: "section",
      placement: { frameId, order: index },
      sectionId: section.id,
      note: "",
    });
  });
  const featured = menu.items[0];
  if (featured !== undefined && !portrait)
    elements.push({
      id: elementId(),
      kind: "featured",
      placement: { frameId: last, order: 0 },
      itemId: featured.id,
      label: "Today’s pick",
      note: "",
    });
  elements.push(orderQr({ frameId: last, order: 1 }));
  return elements;
}

const MARGIN = 48;
const GAP = 32;
const HEADING_HEIGHT = 120;
const QR_HEIGHT = 200;
const FEATURED_HEIGHT = 240;

/**
 * The same elements on a free canvas: the heading across the top, the
 * sections in columns, and a side column with the featured item and the QR
 * code. A portrait board stacks the sections and puts the QR code at the
 * foot. The constraints keep the heading across the top and the QR code in
 * its corner when the board plays on another screen shape.
 */
function canvasElements(
  title: string,
  layout: MenuBoardLayout,
  menu: MenuDraftSnapshot,
): MenuBoardElement[] {
  const shape = MENU_BOARD_LAYOUTS[layout].shape;
  const size = MENU_BOARD_SCREEN_SIZES[shape];
  const inner = size.width - 2 * MARGIN;
  const top = MARGIN + HEADING_HEIGHT + GAP;
  const bottom = size.height - MARGIN;
  let order = 0;
  const place = (
    rect: MenuBoardRect,
    constraints: MenuBoardConstraints = MENU_BOARD_DEFAULT_CONSTRAINTS,
  ): MenuBoardCanvasPlacement => ({
    frameId: "canvas",
    order: order++,
    rect,
    constraints,
  });
  const elements: MenuBoardElement[] = [
    heading(
      title,
      menu,
      place(
        { x: MARGIN, y: MARGIN, width: inner, height: HEADING_HEIGHT },
        { horizontal: "stretch", vertical: "top" },
      ),
    ),
  ];
  const sections = menu.sections;
  if (shape === "portrait") {
    const listBottom = bottom - QR_HEIGHT - GAP;
    const height = sideLength(listBottom - top, sections.length);
    sections.forEach((section, index) =>
      elements.push(
        sectionElement(
          section.id,
          place({
            x: MARGIN,
            y: top + index * (height + GAP),
            width: inner,
            height,
          }),
        ),
      ),
    );
    elements.push(
      orderQr(
        place(
          { x: MARGIN, y: bottom - QR_HEIGHT, width: inner, height: QR_HEIGHT },
          { horizontal: "stretch", vertical: "bottom" },
        ),
      ),
    );
    return elements;
  }
  const columns = shape === "landscape" ? 3 : 2;
  const columnWidth = Math.floor((inner - (columns - 1) * GAP) / columns);
  const sectionColumns = columns - 1;
  const perColumn = Math.max(1, Math.ceil(sections.length / sectionColumns));
  const sectionHeight = sideLength(bottom - top, perColumn);
  sections.forEach((section, index) => {
    const column = Math.min(Math.floor(index / perColumn), sectionColumns - 1);
    const row = index - column * perColumn;
    elements.push(
      sectionElement(
        section.id,
        place({
          x: MARGIN + column * (columnWidth + GAP),
          y: top + row * (sectionHeight + GAP),
          width: columnWidth,
          height: sectionHeight,
        }),
      ),
    );
  });
  const sideX = MARGIN + sectionColumns * (columnWidth + GAP);
  const featured = menu.items[0];
  if (featured !== undefined)
    elements.push({
      id: elementId(),
      kind: "featured",
      placement: place(
        { x: sideX, y: top, width: columnWidth, height: FEATURED_HEIGHT },
        { horizontal: "right", vertical: "top" },
      ),
      itemId: featured.id,
      label: "Today’s pick",
      note: "",
    });
  elements.push(
    orderQr(
      place(
        {
          x: sideX,
          y: bottom - QR_HEIGHT,
          width: columnWidth,
          height: QR_HEIGHT,
        },
        { horizontal: "right", vertical: "bottom" },
      ),
    ),
  );
  return elements;
}

/** The side of one of `count` equal boxes in `length`, with gaps. */
function sideLength(length: number, count: number): number {
  const boxes = Math.max(1, count);
  return Math.max(64, Math.floor((length - (boxes - 1) * GAP) / boxes));
}

function heading(
  title: string,
  menu: MenuDraftSnapshot,
  placement: MenuBoardElement["placement"],
): MenuBoardElement {
  return {
    id: elementId(),
    kind: "heading",
    placement,
    eyebrow: menu.title.slice(0, 280),
    title: title.slice(0, 280),
    detail: "Prices include tax",
  };
}

function sectionElement(
  sectionId: string,
  placement: MenuBoardElement["placement"],
): MenuBoardElement {
  return { id: elementId(), kind: "section", placement, sectionId, note: "" };
}

function orderQr(placement: MenuBoardElement["placement"]): MenuBoardElement {
  return {
    id: elementId(),
    kind: "order_qr",
    placement,
    title: "Order ahead",
    detail: "Scan, pay, and collect at the counter with your pickup code.",
  };
}

/**
 * The order codes on a free canvas: the heading across the top, the
 * preparing and ready lists side by side (one above the other on a
 * portrait board), and the order QR code, for the Night market design.
 */
function canvasPickupElements(title: string, layout: MenuBoardLayout): MenuBoardElement[] {
  const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[layout].shape];
  const portrait = MENU_BOARD_LAYOUTS[layout].shape === "portrait";
  const inner = size.width - 2 * MARGIN;
  const top = MARGIN + HEADING_HEIGHT + GAP;
  const bottom = size.height - MARGIN;
  let order = 0;
  const place = (
    rect: MenuBoardRect,
    constraints: MenuBoardConstraints = MENU_BOARD_DEFAULT_CONSTRAINTS,
  ): MenuBoardCanvasPlacement => ({ frameId: "canvas", order: order++, rect, constraints });
  const elements: MenuBoardElement[] = [{
    id: elementId(),
    kind: "heading",
    placement: place({ x: MARGIN, y: MARGIN, width: inner, height: HEADING_HEIGHT }, { horizontal: "stretch", vertical: "top" }),
    eyebrow: "",
    title: title.slice(0, 280),
    detail: "Scan to order",
  }];
  const listBottom = bottom - QR_HEIGHT - GAP;
  const codes = (stage: "preparing" | "ready", rect: MenuBoardRect): MenuBoardElement => ({
    id: elementId(),
    kind: "pickup_codes",
    placement: place(rect),
    stage,
    title: stage === "ready" ? "Ready" : "Preparing",
  });
  if (portrait) {
    const height = sideLength(listBottom - top, 2);
    elements.push(codes("preparing", { x: MARGIN, y: top, width: inner, height }));
    elements.push(codes("ready", { x: MARGIN, y: top + height + GAP, width: inner, height }));
  } else {
    const width = Math.floor((inner - GAP) / 2);
    elements.push(codes("preparing", { x: MARGIN, y: top, width, height: listBottom - top }));
    elements.push(codes("ready", { x: MARGIN + width + GAP, y: top, width, height: listBottom - top }));
  }
  elements.push(orderQr(place(
    { x: MARGIN, y: bottom - QR_HEIGHT, width: inner, height: QR_HEIGHT },
    { horizontal: "stretch", vertical: "bottom" },
  )));
  return elements;
}

/** The order codes in two columns; a pickup board shows no menu. */
function pickupElements(title: string): MenuBoardElement[] {
  return [
    {
      id: elementId(),
      kind: "heading",
      placement: { frameId: "header", order: 0 },
      eyebrow: "",
      title: title.slice(0, 280),
      detail: "",
    },
    {
      id: elementId(),
      kind: "pickup_codes",
      placement: { frameId: "column_1", order: 0 },
      stage: "preparing",
      title: "Preparing",
    },
    {
      id: elementId(),
      kind: "pickup_codes",
      placement: { frameId: "column_2", order: 0 },
      stage: "ready",
      title: "Ready",
    },
  ];
}

function elementId(): string {
  return `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
