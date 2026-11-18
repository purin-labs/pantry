import qrcode from "qrcode-generator";
import React from "react";
import { formatMoneyMinorEnglish } from "../../formatting";
import type {
  MenuBoardReleaseItem,
  MenuBoardReleaseSection,
  MenuScreenEntry,
  MenuScreenFacts,
  MenuScreenPhoto,
  MenuScreenPickup,
} from "@seams/control-api";
import {
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  MENU_BOARD_STYLE_PRESETS,
  frameElements,
  menuBoardCanvasRects,
  type MenuBoardElement,
  type MenuBoardFrameId,
  type MenuBoardLayout,
  type MenuBoardRect,
  type MenuBoardFontFamily,
  type MenuBoardItemRow,
  type MenuBoardScreenShape,
  type MenuBoardStyle,
} from "@seams/menu-board-crdt/board";
import type { MenuDraftSnapshot } from "@seams/menu-draft-crdt";
import "./board-view.css";

/**
 * One menu board as a screen shows it (Plan 40B). The board's layout and
 * elements come from a release or a draft; prices and sold-out marks come
 * from the shop's live facts. The Portal's preview and the `/tv` player use
 * this one renderer, so a person sees what the screen shows.
 */

export type BoardContent = Readonly<{
  title: string;
  layout: MenuBoardLayout;
  /** Style tokens (Plan 40B phase 5); absent or empty for the default look. */
  style?: MenuBoardStyle;
  elements: readonly MenuBoardElement[];
  sections: readonly MenuBoardReleaseSection[];
  items: readonly MenuBoardReleaseItem[];
  /**
   * Where the shop serves its media library (Plan 40B, the image element),
   * ending in "/"; absent on a board with no image.
   */
  mediaBase?: string;
}>;

export type BoardFactsView = Readonly<{
  facts: MenuScreenFacts | null;
  /** False when the facts are a saved copy that the shop did not confirm now. */
  verified: boolean;
  /** The order codes of a pickup board; null until the shop answers. */
  pickup?: MenuScreenPickup | null;
}>;

/** Codes that show how a pickup board looks in the Portal's preview. */
export const SAMPLE_PICKUP: MenuScreenPickup = {
  observedAt: 0,
  preparing: ["F-062", "K-418", "B-205"],
  ready: ["T-731"],
};

export type BoardSize = Readonly<{ width: number; height: number }>;

/** A free canvas plays on any screen; its width follows the screen's shape. */
const CANVAS_ASPECT_LIMITS = { min: 0.4, max: 3 } as const;

/** The board scaled to fit its container, which keeps the screen's shape. */
export function ScaledBoard(props: Readonly<{
  content: BoardContent;
  facts: BoardFactsView;
  selectedElementId?: string | null;
  onSelectElement?: (elementId: string) => void;
  fill?: boolean;
  /** A canvas board drawn for another screen shape, as that screen shows it. */
  previewShape?: MenuBoardScreenShape;
  /** Drawn above the board in board units, for the canvas editor. */
  overlay?: (scale: number, size: BoardSize) => React.ReactNode;
}>): React.ReactNode {
  const frame = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<BoardSize>({ width: 0, height: 0 });
  const shape = MENU_BOARD_LAYOUTS[props.content.layout];
  const design = MENU_BOARD_SCREEN_SIZES[shape.shape];
  const fill = props.fill === true;
  React.useLayoutEffect(observeBox.bind(null, frame, setBox), []);
  const size = boardSize(props.content.layout, fill ? box : null, props.previewShape);
  const scale = box.width === 0
    ? 0
    : fill
      ? Math.min(box.width / size.width, box.height / size.height)
      : box.width / size.width;
  return <div
    ref={frame}
    className={`menu-board-frame${fill ? " menu-board-frame-fill" : ""}`}
    style={{
      // The frame around a letterboxed board takes the board's background.
      ...styleVariables(props.content.style),
      ...(fill ? {} : { aspectRatio: `${size.width} / ${size.height}` }),
    }}
  >
    <div
      className="menu-board-scaler"
      style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
    >
      <BoardSurface {...props} size={size} design={design} />
      {props.overlay?.(scale, size) ?? null}
    </div>
  </div>;
}

/**
 * The size that a board is drawn at. A fixed layout has its shape's size. A
 * free canvas on a screen takes the screen's shape at the design height, and
 * its constraints place the elements for that width.
 */
function boardSize(
  layout: MenuBoardLayout,
  screen: BoardSize | null,
  previewShape: MenuBoardScreenShape | undefined,
): BoardSize {
  const shape = MENU_BOARD_LAYOUTS[layout];
  const design = MENU_BOARD_SCREEN_SIZES[shape.shape];
  if (!shape.canvas) return design;
  if (previewShape !== undefined) return MENU_BOARD_SCREEN_SIZES[previewShape];
  if (screen === null || screen.width === 0 || screen.height === 0) return design;
  const aspect = Math.min(
    CANVAS_ASPECT_LIMITS.max,
    Math.max(CANVAS_ASPECT_LIMITS.min, screen.width / screen.height),
  );
  return { width: Math.round(design.height * aspect), height: design.height };
}

function observeBox(
  frame: React.RefObject<HTMLDivElement | null>,
  setBox: (box: BoardSize) => void,
): () => void {
  const element = frame.current;
  if (element === null) return noCleanup;
  const measure = (): void => {
    const box = element.getBoundingClientRect();
    setBox({ width: box.width, height: box.height });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
}

function BoardSurface(props: Readonly<{
  content: BoardContent;
  facts: BoardFactsView;
  selectedElementId?: string | null;
  onSelectElement?: (elementId: string) => void;
  size: BoardSize;
  design: BoardSize;
}>): React.ReactNode {
  const { content } = props;
  const shape = MENU_BOARD_LAYOUTS[content.layout];
  const entries = new Map<string, MenuScreenEntry>();
  for (const entry of props.facts.facts?.entries ?? []) entries.set(entry.menuEntryId, entry);
  // Commerce shows no menu outside its hours.
  const notServing =
    props.facts.facts !== null && entries.size === 0 && content.layout !== "pickup_board";
  const context: RenderContext = {
    content,
    entries: props.facts.facts === null ? null : entries,
    notServing,
    verified: props.facts.verified,
    orderUrl: props.facts.facts?.orderUrl ?? null,
    pickup: props.facts.pickup ?? null,
    selectedElementId: props.selectedElementId ?? null,
    onSelectElement: props.onSelectElement,
  };
  const variables = styleVariables(content.style);
  if (shape.canvas) return <div
    className={`menu-board menu-board-canvas menu-board-${shape.orientation}`}
    data-verified={props.facts.verified ? "true" : "false"}
    style={{ ...variables, width: props.size.width, height: props.size.height }}
  >
    {notServing ? <p className="menu-board-not-serving" role="status">Not serving now</p> : null}
    {canvasElements(content.elements, props.design, props.size).map(renderCanvasElement.bind(null, context))}
    {props.facts.verified ? null : <p className="menu-board-unverified" role="status">
      {unverifiedText(props.facts.facts)}
    </p>}
  </div>;
  const columns = shape.frames.filter(isColumnFrame);
  return <div
    className={`menu-board menu-board-${shape.orientation} menu-board-${content.layout}`}
    data-verified={props.facts.verified ? "true" : "false"}
    style={variables}
  >
    <header className="menu-board-header" data-frame="header">
      {frameElements(content, "header").map(renderElement.bind(null, context))}
    </header>
    {notServing ? <p className="menu-board-not-serving" role="status">Not serving now</p> : null}
    <div className="menu-board-columns" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
      {columns.map(renderColumn.bind(null, context))}
    </div>
    {shape.frames.includes("footer") ? <footer className="menu-board-footer" data-frame="footer">
      {frameElements(content, "footer").map(renderElement.bind(null, context))}
    </footer> : null}
    {props.facts.verified ? null : <p className="menu-board-unverified" role="status">
      {content.layout === "pickup_board"
        ? "Offline. These order codes are not verified."
        : unverifiedText(props.facts.facts)}
    </p>}
  </div>;
}

type RenderContext = Readonly<{
  content: BoardContent;
  /** Null when no facts are known: the board then shows no prices. */
  entries: ReadonlyMap<string, MenuScreenEntry> | null;
  notServing: boolean;
  verified: boolean;
  orderUrl: string | null;
  pickup: MenuScreenPickup | null;
  selectedElementId: string | null;
  onSelectElement: ((elementId: string) => void) | undefined;
}>;

function isColumnFrame(frame: MenuBoardFrameId): boolean {
  return frame.startsWith("column_");
}

function renderColumn(context: RenderContext, frame: MenuBoardFrameId): React.ReactNode {
  return <section key={frame} className="menu-board-column" data-frame={frame}>
    {frameElements(context.content, frame).map(renderElement.bind(null, context))}
  </section>;
}

function renderElement(context: RenderContext, element: MenuBoardElement): React.ReactNode {
  const selected = context.selectedElementId === element.id;
  const select = context.onSelectElement;
  return <div
    key={element.id}
    className={`menu-board-element menu-board-element-${element.kind}`}
    data-element-id={element.id}
    data-selected={selected ? "true" : undefined}
    onClick={select === undefined ? undefined : selectElement.bind(null, select, element.id)}
  >
    {renderElementBody(context, element)}
  </div>;
}

/**
 * The free canvas's elements in stacking order, each with its rect. An
 * element in a stack (Plan 40B phase 5, slice 8) takes its place from the
 * stack and sits just in front of it.
 */
function canvasElements(
  elements: readonly MenuBoardElement[],
  design: BoardSize,
  size: BoardSize,
): readonly Readonly<{ element: MenuBoardElement; rect: MenuBoardRect; layer: number }>[] {
  const rects = menuBoardCanvasRects(elements, design, size);
  const layers = new Map<string, number>();
  for (const element of elements)
    if (element.placement.frameId === "canvas") layers.set(element.id, element.placement.order);
  return elements
    .flatMap((element) => {
      const rect = rects.get(element.id);
      if (rect === undefined) return [];
      const layer = element.placement.frameId === "stack"
        ? (layers.get(element.placement.stackId) ?? 0) + 0.5
        : element.placement.order;
      return [{ element, rect, layer }];
    })
    .sort((first, second) => first.layer - second.layer ||
      first.element.placement.order - second.element.placement.order ||
      first.element.id.localeCompare(second.element.id));
}

function renderCanvasElement(
  context: RenderContext,
  placed: Readonly<{ element: MenuBoardElement; rect: MenuBoardRect; layer: number }>,
): React.ReactNode {
  const { element, rect } = placed;
  const select = context.onSelectElement;
  return <div
    key={element.id}
    className={`menu-board-element menu-board-canvas-element menu-board-element-${element.kind}`}
    data-element-id={element.id}
    data-selected={context.selectedElementId === element.id ? "true" : undefined}
    style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: Math.floor(placed.layer) + 1 }}
    onClick={select === undefined ? undefined : selectElement.bind(null, select, element.id)}
  >
    {renderElementBody(context, element)}
  </div>;
}

function selectElement(select: (elementId: string) => void, elementId: string, event: React.MouseEvent): void {
  event.stopPropagation();
  select(elementId);
}

function renderElementBody(context: RenderContext, element: MenuBoardElement): React.ReactNode {
  switch (element.kind) {
    case "heading":
      return <>
        <div className="menu-board-heading-copy">
          {element.eyebrow.length > 0 ? <span className="menu-board-eyebrow">{element.eyebrow}</span> : null}
          <h1>{element.title.length > 0 ? element.title : context.content.title}</h1>
        </div>
        {element.detail.length > 0 ? <span className="menu-board-detail">{element.detail}</span> : null}
      </>;
    case "section":
      return renderSection(context, element.sectionId, element.note, element.row ?? context.content.style?.itemRow ?? "line");
    case "featured":
      return element.look === undefined || element.look === "card"
        ? renderFeatured(context, element.itemId, element.label, element.note)
        : renderProduct(context, element.itemId, element.look);
    case "order_qr":
      return <div className="menu-board-qr-card">
        {context.orderUrl === null
          ? <div className="menu-board-qr-missing" aria-hidden="true" />
          : <OrderQr url={context.orderUrl} />}
        <div className="menu-board-qr-copy">
          <strong>{element.title}</strong>
          <span>{element.detail}</span>
        </div>
      </div>;
    case "pickup_codes":
      return renderPickupCodes(context, element.stage, element.title);
    case "text":
      return <p className="menu-board-text">{element.text}</p>;
    case "image":
      return context.content.mediaBase === undefined
        ? <div className="menu-board-image-missing" role="img" aria-label={element.altText} />
        : <img
          className="menu-board-image"
          src={`${context.content.mediaBase}${encodeURIComponent(element.mediaId)}`}
          alt={element.altText}
          data-fit={element.fit}
          loading="eager"
          decoding="async"
          draggable={false}
        />;
    case "stack":
      // A stack shows nothing itself; its elements show in its place.
      return null;
    default:
      return element satisfies never;
  }
}

function renderPickupCodes(
  context: RenderContext,
  stage: "preparing" | "ready",
  title: string,
): React.ReactNode {
  const codes = context.pickup?.[stage] ?? [];
  return <div className="menu-board-pickup" data-stage={stage}>
    <h2 className="menu-board-section-title">{title}</h2>
    <ul className="menu-board-pickup-codes">
      {codes.map(renderPickupCode)}
    </ul>
  </div>;
}

function renderPickupCode(code: string, index: number): React.ReactNode {
  // Two open orders can share a code, so the position keeps each key apart.
  return <li key={`${code}:${index}`}>{code}</li>;
}

function renderSection(context: RenderContext, sectionId: string, note: string, row: MenuBoardItemRow): React.ReactNode {
  const section = context.content.sections.find((candidate) => candidate.sectionId === sectionId);
  if (section === undefined) return <p className="menu-board-missing">This menu section is not on the menu.</p>;
  const items = section.itemIds.flatMap((itemId) => {
    const item = context.content.items.find((candidate) => candidate.itemId === itemId);
    // With live facts, the board shows only the items on the published menu.
    if (item === undefined || (context.entries !== null && !context.entries.has(itemId))) return [];
    return [item];
  });
  return <>
    <h2 className="menu-board-section-title">{section.title}</h2>
    {note.length > 0 ? <span className="menu-board-note">{note}</span> : null}
    <ul className="menu-board-items" data-row={row}>
      {items.map(renderItem.bind(null, context, row))}
    </ul>
  </>;
}

/**
 * One instance of the item-row component (Plan 40B phase 5). Every variant
 * shows the same facts: the name, the live price or deal, and the sold-out
 * mark; "stacked" and "tiles" also show the description, and "tiles"
 * shows the product's photo.
 */
function renderItem(context: RenderContext, row: MenuBoardItemRow, item: MenuBoardReleaseItem): React.ReactNode {
  const entry = context.entries?.get(item.itemId);
  const soldOut = entry?.availability === "unavailable";
  const name = <span className="menu-board-item-name">{item.name}</span>;
  const price = soldOut
    ? <span className="menu-board-sold-out">Sold out</span>
    : entry === undefined
      ? null
      : renderPrice(context, entry);
  const description = (row === "stacked" || row === "tiles") && item.description.length > 0
    ? <span className="menu-board-item-description">{item.description}</span>
    : null;
  // A tile shows the product's photo from the shop (Plan 40B), when it has one.
  const photo = row === "tiles" && entry?.image != null ? renderPhoto(entry.image, item.name) : null;
  return <li
    key={item.itemId}
    className="menu-board-item"
    data-row={row}
    data-photo={photo === null ? undefined : "true"}
    data-sold-out={soldOut ? "true" : undefined}
  >
    {photo}
    {row === "price_first" ? <>{price}{name}</> : null}
    {row === "line" ? <>{name}{price}</> : null}
    {row === "leader" ? <>{name}<span className="menu-board-item-leader" aria-hidden="true" />{price}</> : null}
    {row === "stacked" || row === "tiles" ? <>
      <span className="menu-board-item-copy">{name}{description}</span>
      {price}
    </> : null}
  </li>;
}

/**
 * A product in a row, a tile or a big price (Plan 40B, the Products
 * panel). The row and the tile are one instance of the item-row component;
 * every look shows the live price and the sold-out mark.
 */
function renderProduct(context: RenderContext, itemId: string, look: "row" | "tile" | "price"): React.ReactNode {
  const item = context.content.items.find((candidate) => candidate.itemId === itemId);
  const entry = context.entries?.get(itemId);
  if (context.notServing) return null;
  if (item === undefined || (context.entries !== null && entry === undefined))
    return <p className="menu-board-missing">This product is not on the menu.</p>;
  if (look !== "price") {
    const row = look === "row" ? "leader" : "tiles";
    return <ul className="menu-board-items menu-board-product-items" data-row={row}>
      {renderItem(context, row, item)}
    </ul>;
  }
  const soldOut = entry?.availability === "unavailable";
  return <div className="menu-board-product-price" data-sold-out={soldOut ? "true" : undefined}>
    <span className="menu-board-product-price-name">{item.name}</span>
    {soldOut
      ? <span className="menu-board-sold-out">Sold out</span>
      : entry === undefined
        ? null
        : renderPrice(context, entry)}
  </div>;
}

function renderFeatured(context: RenderContext, itemId: string, label: string, note: string): React.ReactNode {
  const item = context.content.items.find((candidate) => candidate.itemId === itemId);
  const entry = context.entries?.get(itemId);
  if (context.notServing) return null;
  if (item === undefined || (context.entries !== null && entry === undefined))
    return <p className="menu-board-missing">The featured item is not on the menu.</p>;
  const soldOut = entry?.availability === "unavailable";
  const photo = entry?.image != null ? renderPhoto(entry.image, item.name) : null;
  return <div
    className="menu-board-featured"
    data-photo={photo === null ? undefined : "true"}
    data-sold-out={soldOut ? "true" : undefined}
  >
    {photo}
    {label.length > 0 ? <span className="menu-board-featured-label">{label}</span> : null}
    <div className="menu-board-featured-line">
      <span className="menu-board-featured-name">{item.name}</span>
      {soldOut
        ? <span className="menu-board-sold-out">Sold out</span>
        : entry === undefined
          ? null
          : renderPrice(context, entry)}
    </div>
    {note.length > 0 ? <p>{note}</p> : item.description.length > 0 ? <p>{item.description}</p> : null}
  </div>;
}

/**
 * A product's photo, from the shop's address. A photo with no alt text
 * takes the item's name.
 */
function renderPhoto(photo: MenuScreenPhoto, name: string): React.ReactNode {
  return <img
    className="menu-board-photo"
    src={photo.url}
    alt={photo.altText.trim().length > 0 ? photo.altText : name}
    loading="eager"
    decoding="async"
    draggable={false}
  />;
}

/**
 * An item's live price. A deal (Plan 40B phase 4) shows the earlier price
 * struck through before the new one.
 */
function renderPrice(context: RenderContext, entry: MenuScreenEntry): React.ReactNode {
  const verified = context.verified ? undefined : "false";
  if (entry.compareAtPrice === undefined || entry.compareAtPrice === null)
    return <span className="menu-board-price" data-verified={verified}>{money(entry.price)}</span>;
  return <span className="menu-board-price menu-board-deal" data-verified={verified}>
    <s className="menu-board-was-price" aria-label={`Was ${money(entry.compareAtPrice)}`}>{money(entry.compareAtPrice)}</s>{" "}
    <span>{money(entry.price)}</span>
  </span>;
}

/** The order page's QR code, drawn as SVG cells. */
function OrderQr(props: Readonly<{ url: string }>): React.ReactNode {
  const cells = React.useMemo(qrCells.bind(null, props.url), [props.url]);
  return <svg
    className="menu-board-qr"
    viewBox={`0 0 ${cells.size} ${cells.size}`}
    role="img"
    aria-label="QR code for the order page"
    shapeRendering="crispEdges"
  >
    <rect width={cells.size} height={cells.size} fill="#F2EBDD" />
    {cells.dark.map(renderQrCell)}
  </svg>;
}

function qrCells(url: string): Readonly<{ size: number; dark: readonly (readonly [number, number])[] }> {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const dark: (readonly [number, number])[] = [];
  for (let row = 0; row < count; row++)
    for (let column = 0; column < count; column++)
      if (qr.isDark(row, column)) dark.push([column, row]);
  return { size: count, dark };
}

function renderQrCell(cell: readonly [number, number]): React.ReactNode {
  return <rect key={`${cell[0]}:${cell[1]}`} x={cell[0]} y={cell[1]} width={1} height={1} fill="#17140F" />;
}

function unverifiedText(facts: MenuScreenFacts | null): string {
  if (facts === null) return "Prices and sold-out marks are not verified.";
  const time = new Date(facts.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Offline since ${time}. Prices and sold-out marks are not verified.`;
}

export function money(price: Readonly<{ amountMinor: number; currency: string }>): string {
  return formatMoneyMinorEnglish(price.amountMinor, price.currency);
}

/**
 * A draft board's content for the Portal's preview: the board's elements
 * and the menu draft's copy, as a release would freeze them.
 */
export function draftBoardContent(
  board: Readonly<{ title: string; layout: MenuBoardLayout; style?: MenuBoardStyle; elements: readonly MenuBoardElement[] }>,
  menu: MenuDraftSnapshot,
  mediaBase: string | null = null,
): BoardContent {
  const sections: MenuBoardReleaseSection[] = menu.sections.map((section) => ({
    sectionId: section.id,
    title: section.title,
    itemIds: menu.items.filter((item) => item.placement.sectionId === section.id).map((item) => item.id),
  }));
  const items: MenuBoardReleaseItem[] = menu.items.map((item) => ({
    itemId: item.id,
    name: item.displayName,
    description: item.description,
  }));
  return {
    title: board.title,
    layout: board.layout,
    style: board.style,
    elements: board.elements,
    sections,
    items,
    ...(mediaBase === null ? {} : { mediaBase }),
  };
}

const FONT_STACKS: Readonly<Record<MenuBoardFontFamily, string>> = {
  serif: 'Fraunces, Georgia, "Noto Serif JP", "Times New Roman", serif',
  sans: 'Inter, "Helvetica Neue", Arial, "Noto Sans JP", sans-serif',
  rounded: '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", ui-rounded, "Nunito", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** The type scale's steps that the board's CSS reads, below and above the body. */
const TYPE_STEPS = [-1, 0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * The CSS variables of a board's style tokens. A board without colour
 * tokens sets no colour variables, so the CSS keeps its default look; with
 * any colour token, the muted text and the rules derive from the text and
 * background colours.
 */
export function styleVariables(style: MenuBoardStyle | undefined): React.CSSProperties {
  const variables: Record<string, string> = {};
  if (style === undefined) return variables;
  const defaults = MENU_BOARD_STYLE_PRESETS.espresso.style;
  if (style.background !== undefined || style.ink !== undefined || style.surface !== undefined || style.accent !== undefined) {
    const { background, ink, accent, surface } = boardColors(style);
    variables["--board-bg"] = background;
    variables["--board-ink"] = ink;
    variables["--board-surface"] = surface;
    variables["--board-accent"] = accent;
    variables["--board-muted-80"] = mix(ink, background, 0.8);
    variables["--board-muted-62"] = mix(ink, background, 0.62);
    variables["--board-muted-50"] = mix(ink, background, 0.5);
    variables["--board-muted-42"] = mix(ink, background, 0.42);
    variables["--board-rule"] = mix(ink, background, 0.12);
    variables["--board-rule-strong"] = mix(ink, background, 0.25);
    variables["--board-badge-bg"] = mix(accent, background, 0.25);
    variables["--board-badge-ink"] = mix(accent, ink, 0.6);
  }
  if (style.fontDisplay !== undefined) variables["--board-font-display"] = FONT_STACKS[style.fontDisplay];
  if (style.fontBody !== undefined) variables["--board-font-body"] = FONT_STACKS[style.fontBody];
  if (style.typeBase !== undefined || style.typeRatio !== undefined) {
    const base = style.typeBase ?? defaults.typeBase;
    const ratio = Number(style.typeRatio ?? defaults.typeRatio);
    for (const step of TYPE_STEPS)
      variables[`--board-step-${step < 0 ? `m${-step}` : step}`] = `${Math.round(base * ratio ** step * 10) / 10}px`;
  }
  return variables as React.CSSProperties;
}

/**
 * The four colours that a board shows. A card colour that is not set
 * derives from the text and background colours once any colour is set, so
 * cards stay close to the background that a person chose.
 */
export function boardColors(style: MenuBoardStyle): Readonly<{
  background: string;
  surface: string;
  ink: string;
  accent: string;
}> {
  const defaults = MENU_BOARD_STYLE_PRESETS.espresso.style;
  const anyColor = style.background !== undefined || style.ink !== undefined || style.accent !== undefined;
  const background = style.background ?? defaults.background;
  const ink = style.ink ?? defaults.ink;
  return {
    background,
    ink,
    accent: style.accent ?? defaults.accent,
    surface: style.surface ?? (anyColor ? mix(ink, background, 0.06) : defaults.surface),
  };
}

/** `first` mixed into `second` by `amount` (0 to 1), as #rrggbb. */
function mix(first: string, second: string, amount: number): string {
  const channel = (color: string, offset: number): number => Number.parseInt(color.slice(offset, offset + 2), 16);
  let result = "#";
  for (const offset of [1, 3, 5]) {
    const value = Math.round(channel(first, offset) * amount + channel(second, offset) * (1 - amount));
    result += value.toString(16).padStart(2, "0");
  }
  return result;
}

function noCleanup(): void {}
