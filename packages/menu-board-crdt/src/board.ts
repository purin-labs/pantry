import { isRecord } from "@seams/std";

/**
 * A menu board (Plan 40B): a layout of frames, and elements that sit in those
 * frames. A board names menu sections and items by their draft IDs; it never
 * holds a price, stock, availability or order state. This module has no Yjs,
 * so that the screen player can read a published board without it.
 */

export const MENU_BOARD_ELEMENT_LIMIT = 48;
export const MENU_BOARD_TEXT_LIMIT = 280;

export type MenuBoardLayout =
  | "three_columns"
  | "two_columns"
  | "portrait_list"
  | "pickup_board"
  | "tablet_two_columns"
  | "portrait_pickup"
  | "canvas_landscape"
  | "canvas_portrait"
  | "canvas_tablet";

export type MenuBoardFrameId =
  | "header"
  | "column_1"
  | "column_2"
  | "column_3"
  | "footer"
  | "canvas";

export type MenuBoardOrientation = "landscape" | "portrait";

/** The screen shapes that a board is drawn for (Plan 40B phase 5). */
export type MenuBoardScreenShape = "landscape" | "portrait" | "tablet";

/** The size of each shape in board units; a screen scales it to fit. */
export const MENU_BOARD_SCREEN_SIZES: Readonly<
  Record<MenuBoardScreenShape, Readonly<{ width: number; height: number }>>
> = {
  landscape: { width: 1600, height: 900 },
  portrait: { width: 720, height: 1280 },
  tablet: { width: 1200, height: 900 },
};

export type MenuBoardLayoutShape = Readonly<{
  orientation: MenuBoardOrientation;
  shape: MenuBoardScreenShape;
  /** A free canvas has the one frame "canvas", and its elements have rects. */
  canvas: boolean;
  frames: readonly MenuBoardFrameId[];
}>;

/**
 * The fixed layouts (a header frame and its columns) and the free canvas, for
 * each screen shape.
 */
export const MENU_BOARD_LAYOUTS: Readonly<
  Record<MenuBoardLayout, MenuBoardLayoutShape>
> = {
  three_columns: {
    orientation: "landscape",
    shape: "landscape",
    canvas: false,
    frames: ["header", "column_1", "column_2", "column_3"],
  },
  two_columns: {
    orientation: "landscape",
    shape: "landscape",
    canvas: false,
    frames: ["header", "column_1", "column_2"],
  },
  portrait_list: {
    orientation: "portrait",
    shape: "portrait",
    canvas: false,
    frames: ["header", "column_1", "footer"],
  },
  pickup_board: {
    orientation: "landscape",
    shape: "landscape",
    canvas: false,
    frames: ["header", "column_1", "column_2"],
  },
  tablet_two_columns: {
    orientation: "landscape",
    shape: "tablet",
    canvas: false,
    frames: ["header", "column_1", "column_2"],
  },
  portrait_pickup: {
    orientation: "portrait",
    shape: "portrait",
    canvas: false,
    frames: ["header", "column_1", "column_2"],
  },
  canvas_landscape: {
    orientation: "landscape",
    shape: "landscape",
    canvas: true,
    frames: ["canvas"],
  },
  canvas_portrait: {
    orientation: "portrait",
    shape: "portrait",
    canvas: true,
    frames: ["canvas"],
  },
  canvas_tablet: {
    orientation: "landscape",
    shape: "tablet",
    canvas: true,
    frames: ["canvas"],
  },
};

/** The free canvas layout of each screen shape. */
export const MENU_BOARD_CANVAS_LAYOUTS: Readonly<
  Record<MenuBoardScreenShape, MenuBoardLayout>
> = {
  landscape: "canvas_landscape",
  portrait: "canvas_portrait",
  tablet: "canvas_tablet",
};

/** The stage of the order codes that a pickup list shows. */
export type MenuBoardPickupStage = "preparing" | "ready";

/** A rectangle on the free canvas, in board units of the board's shape. */
export type MenuBoardRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type MenuBoardHorizontalConstraint =
  "left" | "right" | "center" | "stretch" | "scale";
export type MenuBoardVerticalConstraint =
  "top" | "bottom" | "center" | "stretch" | "scale";

/** How an element moves when the board plays on another screen shape. */
export type MenuBoardConstraints = Readonly<{
  horizontal: MenuBoardHorizontalConstraint;
  vertical: MenuBoardVerticalConstraint;
}>;

export const MENU_BOARD_DEFAULT_CONSTRAINTS: MenuBoardConstraints = {
  horizontal: "scale",
  vertical: "scale",
};

/** An element in a frame of a fixed layout, at an ordering key. */
export type MenuBoardFramePlacement = Readonly<{
  frameId: Exclude<MenuBoardFrameId, "canvas">;
  order: number;
}>;

/**
 * An element on the free canvas: its rectangle and constraints, with `order`
 * as its stacking order (higher is in front). It is one atomic value, so two
 * moves of one element converge to one of them.
 */
export type MenuBoardCanvasPlacement = Readonly<{
  frameId: "canvas";
  order: number;
  rect: MenuBoardRect;
  constraints: MenuBoardConstraints;
}>;

/**
 * An element in an auto-layout stack on the free canvas (Plan 40B phase 5,
 * slice 8): the stack, its ordering key, and the element's own size. The
 * stack places it; the element keeps its size along the stack's direction.
 * It is one atomic value, as every placement is.
 */
export type MenuBoardStackPlacement = Readonly<{
  frameId: "stack";
  stackId: string;
  order: number;
  size: Readonly<{ width: number; height: number }>;
}>;

export type MenuBoardPlacement =
  | MenuBoardFramePlacement
  | MenuBoardCanvasPlacement
  | MenuBoardStackPlacement;

/** The smallest side of an element on the canvas, in board units. */
export const MENU_BOARD_MIN_SIDE = 16;
/** The largest coordinate on the canvas, in board units. */
export const MENU_BOARD_MAX_COORDINATE = 4000;

type ElementBase = Readonly<{ id: string; placement: MenuBoardPlacement }>;

/** The props of each element kind. Each prop is one key in the document. */
export type MenuBoardElementProps =
  | Readonly<{
      kind: "heading";
      eyebrow: string;
      title: string;
      detail: string;
    }>
  | Readonly<{
      kind: "section";
      sectionId: string;
      note: string;
      /**
       * The item-row variant of this section (Plan 40B phase 5); absent to
       * use the board's default.
       */
      row?: MenuBoardItemRow;
    }>
  | Readonly<{
      kind: "featured";
      itemId: string;
      label: string;
      note: string;
      /**
       * How a product shows (Plan 40B, the Products panel): a card, a row, a
       * tile or a big price. Absent for the featured card of before.
       */
      look?: MenuBoardProductLook;
    }>
  | Readonly<{ kind: "order_qr"; title: string; detail: string }>
  | Readonly<{ kind: "pickup_codes"; stage: MenuBoardPickupStage; title: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      /**
       * Plan 40B, the image element: a photo from the shop's media library,
       * on a free canvas. A release names the library's address.
       */
      kind: "image";
      mediaId: string;
      altText: string;
      fit: MenuBoardImageFit;
    }>
  | Readonly<{
      /**
       * Plan 40B phase 5, slice 8: an auto-layout stack. It shows nothing
       * itself and places its elements one after another, with a gap
       * between them and padding inside its rect.
       */
      kind: "stack";
      direction: MenuBoardStackDirection;
      /** Whole board units, as text, from 0 to 400. */
      gap: string;
      padding: string;
      align: MenuBoardStackAlign;
    }>;

/** How an image fills its rect: cropped to fill it, or whole inside it. */
export type MenuBoardImageFit = "cover" | "contain";

export function isMenuBoardImageFit(value: unknown): value is MenuBoardImageFit {
  return value === "cover" || value === "contain";
}

/** A media ID of the shop's library, as Commerce names one. */
export function isMenuBoardMediaId(value: unknown): value is string {
  return typeof value === "string" && /^media_[0-9a-f]{32}$/u.test(value);
}

/** Whether an image element's props are valid values. */
export function isMenuBoardImageProps(
  props: Readonly<Record<string, unknown>>,
): boolean {
  return isMenuBoardMediaId(props.mediaId) && isMenuBoardImageFit(props.fit);
}

export type MenuBoardStackDirection = "vertical" | "horizontal";
/** Where a stack puts its elements across its direction. */
export type MenuBoardStackAlign = "start" | "center" | "end" | "stretch";
export const MENU_BOARD_STACK_SPACING_LIMIT = 400;

export function isMenuBoardStackDirection(
  value: unknown,
): value is MenuBoardStackDirection {
  return value === "vertical" || value === "horizontal";
}

export function isMenuBoardStackAlign(
  value: unknown,
): value is MenuBoardStackAlign {
  return (
    value === "start" ||
    value === "center" ||
    value === "end" ||
    value === "stretch"
  );
}

/** A gap or a padding: a whole number of board units, as text. */
export function isMenuBoardStackSpacing(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,2})$/u.test(value) &&
    Number(value) <= MENU_BOARD_STACK_SPACING_LIMIT
  );
}

/** Whether a stack element's props are valid values. */
export function isMenuBoardStackProps(
  props: Readonly<Record<string, unknown>>,
): boolean {
  return (
    isMenuBoardStackDirection(props.direction) &&
    isMenuBoardStackSpacing(props.gap) &&
    isMenuBoardStackSpacing(props.padding) &&
    isMenuBoardStackAlign(props.align)
  );
}

export type MenuBoardElement = ElementBase & MenuBoardElementProps;
export type MenuBoardElementKind = MenuBoardElement["kind"];

export type MenuBoardSnapshot = Readonly<{
  title: string;
  layout: MenuBoardLayout;
  /** The board's style tokens; empty for the default look. */
  style: MenuBoardStyle;
  /** Elements in a frame of the layout, by frame, then order, then ID. */
  elements: readonly MenuBoardElement[];
  /**
   * Elements whose frame the layout does not have, for example after two
   * people changed the layout and moved an element at the same time. A board
   * with one cannot be published until someone moves it.
   */
  unplaced: readonly MenuBoardElement[];
}>;

/** The text props of each kind; the other props are IDs. */
export const MENU_BOARD_TEXT_PROPS: Readonly<
  Record<MenuBoardElementKind, readonly string[]>
> = {
  heading: ["eyebrow", "title", "detail"],
  section: ["note"],
  featured: ["label", "note"],
  order_qr: ["title", "detail"],
  pickup_codes: ["title"],
  text: ["text"],
  image: ["altText"],
  stack: [],
};

export const MENU_BOARD_ID_PROPS: Readonly<
  Record<MenuBoardElementKind, readonly string[]>
> = {
  heading: [],
  section: ["sectionId"],
  featured: ["itemId"],
  order_qr: [],
  pickup_codes: ["stage"],
  text: [],
  image: ["mediaId", "fit"],
  stack: ["direction", "gap", "padding", "align"],
};

/**
 * The variants of the item-row component, which repeats for every item of a
 * section: the name and the price on one line, with dot leaders between
 * them, stacked over the description, with the price first, or as tiles.
 */
export const MENU_BOARD_ITEM_ROWS = [
  "line",
  "leader",
  "stacked",
  "price_first",
  "tiles",
] as const;
export type MenuBoardItemRow = (typeof MENU_BOARD_ITEM_ROWS)[number];

export function isMenuBoardItemRow(value: unknown): value is MenuBoardItemRow {
  return (
    typeof value === "string" &&
    (MENU_BOARD_ITEM_ROWS as readonly string[]).includes(value)
  );
}

/**
 * Props that an element may leave out. An element from before phase 5 has
 * none, and the document reads it as before.
 */
export const MENU_BOARD_OPTIONAL_PROPS: Readonly<
  Record<MenuBoardElementKind, readonly string[]>
> = {
  heading: [],
  section: ["row"],
  featured: ["look"],
  order_qr: [],
  pickup_codes: [],
  text: [],
  image: [],
  stack: [],
};

/** Whether `value` is a valid value of an optional prop. */
export function isMenuBoardOptionalValue(key: string, value: unknown): boolean {
  return (key === "row" && isMenuBoardItemRow(value)) ||
    (key === "look" && isMenuBoardProductLook(value));
}

/**
 * The looks of a product on a board (Plan 40B, the Products panel). Each
 * shows the product's name and its live price and sold-out mark.
 */
export const MENU_BOARD_PRODUCT_LOOKS = ["card", "row", "tile", "price"] as const;
export type MenuBoardProductLook = (typeof MENU_BOARD_PRODUCT_LOOKS)[number];

export function isMenuBoardProductLook(value: unknown): value is MenuBoardProductLook {
  return typeof value === "string" && (MENU_BOARD_PRODUCT_LOOKS as readonly string[]).includes(value);
}

export function isMenuBoardLayout(value: unknown): value is MenuBoardLayout {
  return typeof value === "string" && Object.hasOwn(MENU_BOARD_LAYOUTS, value);
}

export function isMenuBoardCanvasLayout(layout: MenuBoardLayout): boolean {
  return MENU_BOARD_LAYOUTS[layout].canvas;
}

export function isMenuBoardFrameId(value: unknown): value is MenuBoardFrameId {
  return (
    value === "header" ||
    value === "column_1" ||
    value === "column_2" ||
    value === "column_3" ||
    value === "footer" ||
    value === "canvas"
  );
}

export function isMenuBoardHorizontalConstraint(
  value: unknown,
): value is MenuBoardHorizontalConstraint {
  return (
    value === "left" ||
    value === "right" ||
    value === "center" ||
    value === "stretch" ||
    value === "scale"
  );
}

export function isMenuBoardVerticalConstraint(
  value: unknown,
): value is MenuBoardVerticalConstraint {
  return (
    value === "top" ||
    value === "bottom" ||
    value === "center" ||
    value === "stretch" ||
    value === "scale"
  );
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= -MENU_BOARD_MAX_COORDINATE &&
    value <= MENU_BOARD_MAX_COORDINATE
  );
}

function isSide(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MENU_BOARD_MIN_SIDE &&
    value <= MENU_BOARD_MAX_COORDINATE
  );
}

export function isMenuBoardRect(value: unknown): value is MenuBoardRect {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    isCoordinate(value.x) &&
    isCoordinate(value.y) &&
    isSide(value.width) &&
    isSide(value.height)
  );
}

export function isMenuBoardConstraints(
  value: unknown,
): value is MenuBoardConstraints {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isMenuBoardHorizontalConstraint(value.horizontal) &&
    isMenuBoardVerticalConstraint(value.vertical)
  );
}

/** A placement from untrusted JSON, with exact keys for each kind. */
export function parseMenuBoardPlacement(
  value: unknown,
): MenuBoardPlacement | null {
  if (!isRecord(value) || !isMenuBoardOrder(value.order)) return null;
  if (value.frameId === "stack")
    return Object.keys(value).length === 4 &&
      isMenuBoardId(value.stackId) &&
      isRecord(value.size) &&
      Object.keys(value.size).length === 2 &&
      isSide(value.size.width) &&
      isSide(value.size.height)
      ? {
          frameId: "stack",
          stackId: value.stackId,
          order: value.order,
          size: { width: value.size.width, height: value.size.height },
        }
      : null;
  if (value.frameId === "canvas")
    return Object.keys(value).length === 4 &&
      isMenuBoardRect(value.rect) &&
      isMenuBoardConstraints(value.constraints)
      ? {
          frameId: "canvas",
          order: value.order,
          rect: {
            x: value.rect.x,
            y: value.rect.y,
            width: value.rect.width,
            height: value.rect.height,
          },
          constraints: {
            horizontal: value.constraints.horizontal,
            vertical: value.constraints.vertical,
          },
        }
      : null;
  return Object.keys(value).length === 2 &&
    isMenuBoardFrameId(value.frameId) &&
    value.frameId !== "canvas"
    ? { frameId: value.frameId, order: value.order }
    : null;
}

/**
 * Whether a placement fits a layout: a frame of a fixed layout, or the
 * canvas of a free canvas.
 */
export function placementFitsLayout(
  layout: MenuBoardLayout,
  placement: MenuBoardPlacement,
): boolean {
  return placement.frameId === "stack"
    ? MENU_BOARD_LAYOUTS[layout].canvas
    : layoutHasFrame(layout, placement.frameId);
}

/**
 * Where every element of a free canvas sits on a board of `size` (Plan 40B
 * phase 5, slice 8). A canvas element keeps its rect, or follows its
 * constraints on a screen of another size. A stack then places its
 * elements one after another inside its rect, less its padding: each keeps
 * its size along the stack's direction and takes its place across it by
 * the stack's alignment. An element that a stack cannot hold runs past its
 * end, as a fixed-size frame does in Figma.
 */
export function menuBoardCanvasRects(
  elements: readonly MenuBoardElement[],
  design: Readonly<{ width: number; height: number }>,
  size: Readonly<{ width: number; height: number }>,
): Map<string, MenuBoardRect> {
  const rects = new Map<string, MenuBoardRect>();
  const same = design.width === size.width && design.height === size.height;
  for (const element of elements) {
    if (element.placement.frameId !== "canvas") continue;
    rects.set(
      element.id,
      same
        ? element.placement.rect
        : resolveCanvasRect(
            element.placement.rect,
            element.placement.constraints,
            design,
            size,
          ),
    );
  }
  for (const stack of elements) {
    const box = rects.get(stack.id);
    if (stack.kind !== "stack" || box === undefined) continue;
    const padding = Number(stack.padding);
    const gap = Number(stack.gap);
    const vertical = stack.direction === "vertical";
    const children = elements
      .filter(
        (element) =>
          element.placement.frameId === "stack" &&
          element.placement.stackId === stack.id &&
          element.kind !== "stack",
      )
      .sort(compareMenuBoardElements);
    const crossStart = vertical ? box.x + padding : box.y + padding;
    const crossSize = Math.max(
      MENU_BOARD_MIN_SIDE,
      (vertical ? box.width : box.height) - 2 * padding,
    );
    let cursor = (vertical ? box.y : box.x) + padding;
    for (const child of children) {
      if (child.placement.frameId !== "stack") continue;
      const own = child.placement.size;
      const main = vertical ? own.height : own.width;
      const across =
        stack.align === "stretch"
          ? crossSize
          : Math.min(crossSize, vertical ? own.width : own.height);
      const offset =
        stack.align === "center"
          ? Math.round((crossSize - across) / 2)
          : stack.align === "end"
            ? crossSize - across
            : 0;
      rects.set(
        child.id,
        vertical
          ? { x: crossStart + offset, y: cursor, width: across, height: main }
          : { x: cursor, y: crossStart + offset, width: main, height: across },
      );
      cursor += main + gap;
    }
  }
  return rects;
}

/**
 * Where an element sits when a canvas board plays on a screen of another
 * size. Each constraint keeps a distance to an edge, keeps the centre,
 * stretches with the screen, or scales with it.
 */
export function resolveCanvasRect(
  rect: MenuBoardRect,
  constraints: MenuBoardConstraints,
  from: Readonly<{ width: number; height: number }>,
  to: Readonly<{ width: number; height: number }>,
): MenuBoardRect {
  const [x, width] = resolveAxis(
    rect.x,
    rect.width,
    from.width,
    to.width,
    constraints.horizontal === "left"
      ? "start"
      : constraints.horizontal === "right"
        ? "end"
        : constraints.horizontal,
  );
  const [y, height] = resolveAxis(
    rect.y,
    rect.height,
    from.height,
    to.height,
    constraints.vertical === "top"
      ? "start"
      : constraints.vertical === "bottom"
        ? "end"
        : constraints.vertical,
  );
  return {
    x: inside(x, width, to.width),
    y: inside(y, height, to.height),
    width,
    height,
  };
}

/**
 * A start that keeps the element on the screen when it fits, so that a
 * screen of another shape never cuts an element off at its edge.
 */
function inside(start: number, size: number, length: number): number {
  if (size >= length) return Math.min(0, Math.max(length - size, start));
  return Math.min(Math.max(0, start), length - size);
}

function resolveAxis(
  start: number,
  size: number,
  from: number,
  to: number,
  rule: "start" | "end" | "center" | "stretch" | "scale",
): readonly [number, number] {
  const delta = to - from;
  switch (rule) {
    case "start":
      return [start, size];
    case "end":
      return [start + delta, size];
    case "center":
      return [Math.round(start + delta / 2), size];
    case "stretch":
      return [start, Math.max(MENU_BOARD_MIN_SIDE, size + delta)];
    case "scale": {
      const ratio = from === 0 ? 1 : to / from;
      return [
        Math.round(start * ratio),
        Math.max(MENU_BOARD_MIN_SIDE, Math.round(size * ratio)),
      ];
    }
    default:
      return rule satisfies never;
  }
}

export function isMenuBoardElementKind(
  value: unknown,
): value is MenuBoardElementKind {
  return (
    value === "heading" ||
    value === "section" ||
    value === "featured" ||
    value === "order_qr" ||
    value === "pickup_codes" ||
    value === "text" ||
    value === "image" ||
    value === "stack"
  );
}

export function isMenuBoardPickupStage(
  value: unknown,
): value is MenuBoardPickupStage {
  return value === "preparing" || value === "ready";
}

export function isMenuBoardId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(value);
}

/** Plain text with no lone surrogate and no carriage return. */
export function isMenuBoardText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MENU_BOARD_TEXT_LIMIT &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ) &&
    !value.includes("\r")
  );
}

export function isMenuBoardOrder(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
}

/** Whether a frame belongs to a layout. */
export function layoutHasFrame(
  layout: MenuBoardLayout,
  frameId: MenuBoardFrameId,
): boolean {
  return MENU_BOARD_LAYOUTS[layout].frames.includes(frameId);
}

/** The elements of one frame, in display order. */
export function frameElements(
  snapshot: Pick<MenuBoardSnapshot, "elements">,
  frameId: MenuBoardFrameId,
): readonly MenuBoardElement[] {
  return snapshot.elements.filter(
    (element) => element.placement.frameId === frameId,
  );
}

export function compareMenuBoardElements(
  first: MenuBoardElement,
  second: MenuBoardElement,
): number {
  return (
    first.placement.frameId.localeCompare(second.placement.frameId) ||
    first.placement.order - second.placement.order ||
    first.id.localeCompare(second.id)
  );
}

/** The props of an element, without its ID and placement. */
export function menuBoardElementProps(
  element: MenuBoardElement,
): MenuBoardElementProps {
  switch (element.kind) {
    case "heading":
      return {
        kind: element.kind,
        eyebrow: element.eyebrow,
        title: element.title,
        detail: element.detail,
      };
    case "section":
      return {
        kind: element.kind,
        sectionId: element.sectionId,
        note: element.note,
        ...(element.row === undefined ? {} : { row: element.row }),
      };
    case "featured":
      return {
        kind: element.kind,
        itemId: element.itemId,
        label: element.label,
        note: element.note,
      };
    case "order_qr":
      return {
        kind: element.kind,
        title: element.title,
        detail: element.detail,
      };
    case "pickup_codes":
      return { kind: element.kind, stage: element.stage, title: element.title };
    case "text":
      return { kind: element.kind, text: element.text };
    case "image":
      return {
        kind: element.kind,
        mediaId: element.mediaId,
        altText: element.altText,
        fit: element.fit,
      };
    case "stack":
      return {
        kind: element.kind,
        direction: element.direction,
        gap: element.gap,
        padding: element.padding,
        align: element.align,
      };
    default:
      return element satisfies never;
  }
}

/** One element from untrusted JSON, such as a published release. */
export function parseMenuBoardElement(value: unknown): MenuBoardElement | null {
  if (!isRecord(value) || !isMenuBoardElementKind(value.kind)) return null;
  const placement = parseMenuBoardPlacement(value.placement);
  if (!isMenuBoardId(value.id) || placement === null) return null;
  const text = MENU_BOARD_TEXT_PROPS[value.kind];
  const ids = MENU_BOARD_ID_PROPS[value.kind];
  const optional = MENU_BOARD_OPTIONAL_PROPS[value.kind].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (
    Object.keys(value).length !==
    3 + text.length + ids.length + optional.length
  )
    return null;
  for (const key of text) if (!isMenuBoardText(value[key])) return null;
  for (const key of ids) if (!isMenuBoardId(value[key])) return null;
  for (const key of optional)
    if (!isMenuBoardOptionalValue(key, value[key])) return null;
  if (value.kind === "pickup_codes" && !isMenuBoardPickupStage(value.stage))
    return null;
  if (value.kind === "stack" && !isMenuBoardStackProps(value)) return null;
  if (value.kind === "image" && !isMenuBoardImageProps(value)) return null;
  return { ...value, placement } as MenuBoardElement;
}

/**
 * Style tokens of a board (Plan 40B phase 5): its colours, its two font
 * families and its type scale. Each token is optional; a board without a
 * token keeps the default look of the screens. Each token is one key in the
 * document, so two people who change two tokens both keep their change.
 */
export type MenuBoardFontFamily = "serif" | "sans" | "rounded" | "mono";

export const MENU_BOARD_TYPE_RATIOS = [
  "1.125",
  "1.2",
  "1.25",
  "1.333",
  "1.414",
  "1.5",
] as const;
export type MenuBoardTypeRatio = (typeof MENU_BOARD_TYPE_RATIOS)[number];

export const MENU_BOARD_COLOR_TOKENS = [
  "background",
  "surface",
  "ink",
  "accent",
] as const;
export type MenuBoardColorToken = (typeof MENU_BOARD_COLOR_TOKENS)[number];

export const MENU_BOARD_STYLE_TOKENS = [
  ...MENU_BOARD_COLOR_TOKENS,
  "fontDisplay",
  "fontBody",
  "typeBase",
  "typeRatio",
  "itemRow",
] as const;
export type MenuBoardStyleToken = (typeof MENU_BOARD_STYLE_TOKENS)[number];

export type MenuBoardStyle = Readonly<{
  background?: string;
  surface?: string;
  ink?: string;
  accent?: string;
  fontDisplay?: MenuBoardFontFamily;
  fontBody?: MenuBoardFontFamily;
  /** The body text size in board units, from 12 to 32. */
  typeBase?: number;
  /** Each step of the type scale is this ratio times the step below it. */
  typeRatio?: MenuBoardTypeRatio;
  /** The board's default item-row variant; a section can choose another. */
  itemRow?: MenuBoardItemRow;
}>;

/** A new value of a token; null clears it back to the default. */
export type MenuBoardStyleChanges = Readonly<
  Partial<Record<MenuBoardStyleToken, string | number | null>>
>;

export const MENU_BOARD_TYPE_BASE_LIMITS = { min: 12, max: 32 } as const;

export function isMenuBoardStyleToken(
  value: unknown,
): value is MenuBoardStyleToken {
  return (
    typeof value === "string" &&
    (MENU_BOARD_STYLE_TOKENS as readonly string[]).includes(value)
  );
}

export function isMenuBoardColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/u.test(value);
}

export function isMenuBoardFontFamily(
  value: unknown,
): value is MenuBoardFontFamily {
  return (
    value === "serif" ||
    value === "sans" ||
    value === "rounded" ||
    value === "mono"
  );
}

/** Whether `value` is a valid value of `token`. */
export function isMenuBoardStyleValue(
  token: MenuBoardStyleToken,
  value: unknown,
): boolean {
  switch (token) {
    case "background":
    case "surface":
    case "ink":
    case "accent":
      return isMenuBoardColor(value);
    case "fontDisplay":
    case "fontBody":
      return isMenuBoardFontFamily(value);
    case "typeBase":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= MENU_BOARD_TYPE_BASE_LIMITS.min &&
        value <= MENU_BOARD_TYPE_BASE_LIMITS.max
      );
    case "typeRatio":
      return (
        typeof value === "string" &&
        (MENU_BOARD_TYPE_RATIOS as readonly string[]).includes(value)
      );
    case "itemRow":
      return isMenuBoardItemRow(value);
    default:
      return token satisfies never;
  }
}

/** A style from untrusted JSON: known tokens with valid values only. */
export function parseMenuBoardStyle(value: unknown): MenuBoardStyle | null {
  if (!isRecord(value)) return null;
  const style: Record<string, unknown> = {};
  for (const [key, token] of Object.entries(value)) {
    if (!isMenuBoardStyleToken(key) || !isMenuBoardStyleValue(key, token))
      return null;
    style[key] = token;
  }
  return style as MenuBoardStyle;
}

/** Ready-made sets of tokens that a person starts from. */
export const MENU_BOARD_STYLE_PRESETS: Readonly<
  Record<
    "espresso" | "paper" | "matcha" | "night_market",
    Readonly<{ name: string; style: Required<Omit<MenuBoardStyle, "itemRow">> }>
  >
> = {
  espresso: {
    name: "Espresso",
    style: {
      background: "#17140f",
      surface: "#221e18",
      ink: "#f2ebdd",
      accent: "#d2b07a",
      fontDisplay: "serif",
      fontBody: "sans",
      typeBase: 18,
      typeRatio: "1.25",
    },
  },
  paper: {
    name: "Paper",
    style: {
      background: "#f4efe4",
      surface: "#ffffff",
      ink: "#1f1a14",
      accent: "#9a3412",
      fontDisplay: "serif",
      fontBody: "sans",
      typeBase: 18,
      typeRatio: "1.25",
    },
  },
  matcha: {
    name: "Matcha",
    style: {
      background: "#1d2b1f",
      surface: "#263829",
      ink: "#eef3e6",
      accent: "#b7d38a",
      fontDisplay: "rounded",
      fontBody: "rounded",
      typeBase: 19,
      typeRatio: "1.2",
    },
  },
  night_market: {
    name: "Night market",
    style: {
      background: "#0f1020",
      surface: "#1b1c34",
      ink: "#f5f3ff",
      accent: "#f59e0b",
      fontDisplay: "sans",
      fontBody: "sans",
      typeBase: 20,
      typeRatio: "1.333",
    },
  },
};

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function luminance(color: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * How a new board starts (Plan 40B, the start screen): the layout's own
 * template, a blank free canvas, or a designed menu. A designed menu is a
 * free canvas board with a style preset and an item row, filled from the
 * shop's menu.
 */
export const MENU_BOARD_STARTS = [
  "template",
  "blank",
  "espresso_bar",
  "bakery_counter",
  "matcha_bar",
  "night_market",
] as const;
export type MenuBoardStart = (typeof MENU_BOARD_STARTS)[number];
export type MenuBoardDesign = Exclude<MenuBoardStart, "template" | "blank">;

export function isMenuBoardStart(value: unknown): value is MenuBoardStart {
  return typeof value === "string" && (MENU_BOARD_STARTS as readonly string[]).includes(value);
}

export const MENU_BOARD_DESIGNS: Readonly<
  Record<
    MenuBoardDesign,
    Readonly<{
      name: string;
      detail: string;
      preset: keyof typeof MENU_BOARD_STYLE_PRESETS;
      itemRow: MenuBoardItemRow;
      /** A pickup design shows the order codes, not the menu. */
      pickup: boolean;
    }>
  >
> = {
  espresso_bar: { name: "Espresso bar", detail: "Dark, gold prices", preset: "espresso", itemRow: "leader", pickup: false },
  bakery_counter: { name: "Bakery counter", detail: "Paper, a line under each name", preset: "paper", itemRow: "stacked", pickup: false },
  matcha_bar: { name: "Matcha", detail: "Green, tiles", preset: "matcha", itemRow: "tiles", pickup: false },
  night_market: { name: "Night market", detail: "Pickup codes and the QR code", preset: "night_market", itemRow: "line", pickup: true },
};

/** A start other than the template needs a free canvas layout. */
export function menuBoardStartFits(start: MenuBoardStart, layout: MenuBoardLayout): boolean {
  return start === "template" || MENU_BOARD_LAYOUTS[layout].canvas;
}

/** The style tokens that a start sets on a new board, or null for none. */
export function menuBoardStartStyle(start: MenuBoardStart): MenuBoardStyleChanges | null {
  if (start === "template" || start === "blank") return null;
  const design = MENU_BOARD_DESIGNS[start];
  return { ...MENU_BOARD_STYLE_PRESETS[design.preset].style, itemRow: design.itemRow };
}
