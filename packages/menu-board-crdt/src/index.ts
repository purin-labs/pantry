import {
  checkDocumentSize,
  defineSharedDoc,
  normalizePlainText,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
} from "@purin-labs/collaboration";
import * as Y from "yjs";

import {
  MENU_BOARD_ELEMENT_LIMIT,
  MENU_BOARD_ID_PROPS,
  MENU_BOARD_OPTIONAL_PROPS,
  MENU_BOARD_STYLE_TOKENS,
  MENU_BOARD_TEXT_PROPS,
  compareMenuBoardElements,
  isMenuBoardElementKind,
  isMenuBoardFrameId,
  isMenuBoardHorizontalConstraint,
  isMenuBoardId,
  isMenuBoardOptionalValue,
  isMenuBoardRect,
  isMenuBoardStyleToken,
  isMenuBoardStyleValue,
  isMenuBoardVerticalConstraint,
  isMenuBoardLayout,
  isMenuBoardOrder,
  isMenuBoardText,
  isMenuBoardPickupStage,
  isMenuBoardImageProps,
  isMenuBoardStackProps,
  menuBoardElementProps,
  parseMenuBoardPlacement,
  placementFitsLayout,
  type MenuBoardElement,
  type MenuBoardLayout,
  type MenuBoardPlacement,
  type MenuBoardRect,
  type MenuBoardSnapshot,
  type MenuBoardStyle,
  type MenuBoardStyleChanges,
} from "./board.ts";

export * from "./board.ts";

export const MENU_BOARD_SCHEMA = "menu_board_crdt.v1";
export const MENU_BOARD_STATE_LIMIT = 256 * 1024;
export const MENU_BOARD_UPDATE_LIMIT = MENU_BOARD_STATE_LIMIT;
export const MENU_BOARD_STATE_VECTOR_LIMIT = 32 * 1024;

export type MenuBoardPresenceSelection =
  | Readonly<{ kind: "element"; elementId: string }>
  | Readonly<{ kind: "frame"; frameId: string }>
  | MenuBoardMovingSelection;

/**
 * A drag in progress (Plan 40B phase 5, slice 5), so that other people see
 * the elements move before the drag writes the board. A move gives the
 * offset of every element from its place in the draft; a resize gives the
 * new rect of its one element. It is presence, not a board edit: it lasts
 * until the drag ends.
 */
export type MenuBoardMovingSelection = Readonly<{
  kind: "moving";
  elementIds: readonly string[];
  offset: Readonly<{ x: number; y: number }> | null;
  /**
   * The top left corner of the moving elements when the drag began. Once
   * the drag's edit arrives, the elements are no longer there, so a viewer
   * stops adding the offset.
   */
  from: Readonly<{ x: number; y: number }> | null;
  rect: MenuBoardRect | null;
}>;

/** A drag shows at most this many elements in motion to other people. */
export const MENU_BOARD_MOVING_LIMIT = 12;

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = [
  "invalid_document_shape",
  "collection_limit",
  "text_too_long",
  "record_conflict",
] as const;
export type MenuBoardCrdtError = SharedDocError<(typeof FAILURES)[number]>;
export type MenuBoardCrdtResult<T> = SharedDocResult<
  T,
  MenuBoardCrdtError["code"]
>;

/** One element's new placement in a batch. */
export type MenuBoardElementPlacement = Readonly<{
  elementId: string;
  placement: MenuBoardPlacement;
}>;

/** The props that one edit changes: any subset of one kind's props. */
export type MenuBoardPropChanges = Readonly<Record<string, string>>;

const ENCODING_LIMITS = {
  state: MENU_BOARD_STATE_LIMIT,
  update: MENU_BOARD_UPDATE_LIMIT,
  stateVector: MENU_BOARD_STATE_VECTOR_LIMIT,
} as const;

export const menuBoardDocument = defineSharedDoc({
  schema: MENU_BOARD_SCHEMA,
  limits: ENCODING_LIMITS,
  failures: FAILURES,
  // `style` is of Plan 40B phase 5.
  roots: { board: "map", elements: "map", style: "map" },
  shapeFailure: "invalid_document_shape",
  validate: validateDocument,
  unchangedFailure: "record_conflict",
});

type Schema = typeof MENU_BOARD_SCHEMA;
export type MenuBoardState = SharedDocEncoding<"state", Schema>;
export type MenuBoardUpdate = SharedDocEncoding<"update", Schema>;
export type MenuBoardStateVector = SharedDocEncoding<"state_vector", Schema>;

export const parseMenuBoardState = menuBoardDocument.parseState;
export const parseMenuBoardUpdate = menuBoardDocument.parseUpdate;
export const parseMenuBoardStateVector = menuBoardDocument.parseStateVector;

/**
 * One board as a Yjs document. The `board` map holds the title and the
 * layout. Each element is a nested map in `elements`, with one key for each
 * prop, so that two people who change two props both keep their change. An
 * element's placement is one atomic value, so that two moves of the same
 * element converge to one of them. Every edit and every received update is
 * applied to a copy first, and the copy must pass the shape check.
 */
export class MenuBoardDoc extends menuBoardDocument.Doc {
  static create(
    title: string,
    layout: MenuBoardLayout,
  ): MenuBoardCrdtResult<MenuBoardDoc> {
    const normalized = normalizePlainText(title);
    if (!isMenuBoardText(normalized)) return failure("text_too_long");
    const doc = menuBoardDocument.emptyDocument();
    const board = doc.getMap("board");
    board.set("title", normalized);
    board.set("layout", layout);
    return success(new MenuBoardDoc(doc));
  }

  static createReplica(): MenuBoardDoc {
    return new MenuBoardDoc(menuBoardDocument.emptyDocument());
  }

  static restore(state: MenuBoardState): MenuBoardCrdtResult<MenuBoardDoc> {
    const doc = menuBoardDocument.restore(state);
    return doc.ok ? success(new MenuBoardDoc(doc.value)) : doc;
  }

  read(): MenuBoardSnapshot {
    const board = this.doc.getMap("board");
    const layoutValue = board.get("layout");
    const layout: MenuBoardLayout = isMenuBoardLayout(layoutValue)
      ? layoutValue
      : "three_columns";
    const placed: MenuBoardElement[] = [];
    const unplaced: MenuBoardElement[] = [];
    for (const [id, raw] of this.doc.getMap("elements")) {
      if (!(raw instanceof Y.Map)) continue;
      const element = readElement(id, raw);
      if (element === null) continue;
      if (placementFitsLayout(layout, element.placement)) placed.push(element);
      else unplaced.push(element);
    }
    // Plan 40B phase 5, slice 8: an element whose stack is gone, or is not
    // on the canvas, has no place. A stack does not sit in a stack.
    const stacks = new Set(
      placed
        .filter(
          (element) =>
            element.kind === "stack" && element.placement.frameId === "canvas",
        )
        .map((element) => element.id),
    );
    for (let index = placed.length - 1; index >= 0; index -= 1) {
      const element = placed[index];
      if (
        element !== undefined &&
        element.placement.frameId === "stack" &&
        (element.kind === "stack" || !stacks.has(element.placement.stackId))
      ) {
        placed.splice(index, 1);
        unplaced.push(element);
      }
    }
    placed.sort(compareMenuBoardElements);
    unplaced.sort(compareMenuBoardElements);
    return {
      title: String(board.get("title") ?? ""),
      layout,
      style: readStyle(this.doc),
      elements: placed,
      unplaced,
    };
  }

  rename(title: string): MenuBoardCrdtResult<MenuBoardUpdate> {
    const normalized = normalizePlainText(title);
    if (!isMenuBoardText(normalized)) return failure("text_too_long");
    return this.mutate(setBoardValue.bind(null, "title", normalized));
  }

  setLayout(layout: MenuBoardLayout): MenuBoardCrdtResult<MenuBoardUpdate> {
    if (!isMenuBoardLayout(layout)) return failure("invalid_document_shape");
    return this.mutate(setBoardValue.bind(null, "layout", layout));
  }

  /**
   * Sets or clears style tokens in one update (Plan 40B phase 5). A null
   * value clears a token, so the board takes the default again.
   */
  setStyle(
    changes: MenuBoardStyleChanges,
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(setBoardStyle.bind(null, changes));
  }

  addElement(element: MenuBoardElement): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(addBoardElement.bind(null, element));
  }

  /** Sets some props of one element; the others keep their value. */
  updateElement(
    elementId: string,
    changes: MenuBoardPropChanges,
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(updateBoardElement.bind(null, elementId, changes));
  }

  moveElement(
    elementId: string,
    placement: MenuBoardPlacement,
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(moveBoardElement.bind(null, elementId, placement));
  }

  removeElement(elementId: string): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(removeBoardElement.bind(null, elementId));
  }

  /**
   * Moves several elements in one update, for a drag of a selection, an
   * align or a distribute (Plan 40B phase 5). Each element keeps its own
   * atomic placement.
   */
  placeElements(
    placements: readonly MenuBoardElementPlacement[],
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(placeBoardElements.bind(null, placements));
  }

  /**
   * Changes the layout and places the elements for it in one update: a
   * board that moves to the free canvas, to another screen shape, or back
   * to a fixed layout. An element that is not named keeps its placement and
   * shows as unplaced if the new layout has no place for it.
   */
  arrangeLayout(
    layout: MenuBoardLayout,
    placements: readonly MenuBoardElementPlacement[],
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    if (!isMenuBoardLayout(layout)) return failure("invalid_document_shape");
    return this.mutate((doc) => {
      setBoardValue("layout", layout, doc);
      return placeBoardElements(placements, doc);
    });
  }

  /**
   * Adds an auto-layout stack and places elements in it, in one update
   * (Plan 40B phase 5, slice 8).
   */
  stackElements(
    stack: MenuBoardElement,
    placements: readonly MenuBoardElementPlacement[],
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate((doc) => {
      const added = addBoardElement(stack, doc);
      return added.ok ? placeBoardElements(placements, doc) : added;
    });
  }

  /** Places a stack's elements on the canvas and removes it, in one update. */
  unstackElements(
    stackId: string,
    placements: readonly MenuBoardElementPlacement[],
  ): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate((doc) => {
      const placed = placeBoardElements(placements, doc);
      return placed.ok ? removeBoardElement(stackId, doc) : placed;
    });
  }

  /**
   * Makes the board equal to `target` in one update (Plan 40B phase 5,
   * slice 7): a restore of a saved version. Each title, token, prop and
   * placement that differs is set; each element that the target lacks is
   * removed, and each that it has is added back. Values that already match
   * are not written, so a concurrent edit of another value survives.
   */
  restoreTo(target: MenuBoardSnapshot): MenuBoardCrdtResult<MenuBoardUpdate> {
    return this.mutate(replaceBoard.bind(null, target));
  }
}

function setBoardValue(
  key: "title" | "layout",
  value: string,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  doc.getMap("board").set(key, value);
  return success(null);
}

function setBoardStyle(
  changes: MenuBoardStyleChanges,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  const style = doc.getMap("style");
  for (const [token, value] of Object.entries(changes)) {
    if (!isMenuBoardStyleToken(token)) return failure("invalid_document_shape");
    if (value === null || value === undefined) {
      if (style.has(token)) style.delete(token);
      continue;
    }
    if (!isMenuBoardStyleValue(token, value))
      return failure("invalid_document_shape");
    if (style.get(token) !== value) style.set(token, value);
  }
  return success(null);
}

/** The style tokens; a document from before phase 5 has none. */
function readStyle(doc: Y.Doc): MenuBoardStyle {
  const map = doc.getMap("style");
  const style: Record<string, unknown> = {};
  // Tokens in one fixed order, whatever order the map holds them in.
  for (const token of MENU_BOARD_STYLE_TOKENS) {
    const value = map.get(token);
    if (value !== undefined && isMenuBoardStyleValue(token, value))
      style[token] = value;
  }
  return style as MenuBoardStyle;
}

function addBoardElement(
  element: MenuBoardElement,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  if (!isMenuBoardId(element.id) || !validPlacement(element.placement))
    return failure("invalid_document_shape");
  const elements = doc.getMap("elements");
  if (elements.has(element.id)) return failure("record_conflict");
  const value = new Y.Map<unknown>();
  value.set("kind", element.kind);
  value.set("placement", encodePlacement(element.placement));
  const props = menuBoardElementProps(element);
  for (const [key, prop] of Object.entries(props)) {
    if (key === "kind") continue;
    value.set(
      key,
      MENU_BOARD_TEXT_PROPS[element.kind].includes(key)
        ? normalizePlainText(String(prop))
        : prop,
    );
  }
  elements.set(element.id, value);
  return success(null);
}

function updateBoardElement(
  elementId: string,
  changes: MenuBoardPropChanges,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  const element = doc.getMap("elements").get(elementId);
  if (!(element instanceof Y.Map)) return failure("record_conflict");
  const kind = element.get("kind");
  if (!isMenuBoardElementKind(kind)) return failure("invalid_document_shape");
  const text = MENU_BOARD_TEXT_PROPS[kind];
  const ids = MENU_BOARD_ID_PROPS[kind];
  const optional = MENU_BOARD_OPTIONAL_PROPS[kind];
  for (const [key, raw] of Object.entries(changes)) {
    if (optional.includes(key)) {
      // An empty value leaves the prop out again.
      if (raw === "") {
        if (element.has(key)) element.delete(key);
      } else if (!isMenuBoardOptionalValue(key, raw))
        return failure("invalid_document_shape");
      else if (element.get(key) !== raw) element.set(key, raw);
    } else if (text.includes(key)) {
      const value = normalizePlainText(raw);
      if (!isMenuBoardText(value)) return failure("text_too_long");
      if (element.get(key) !== value) element.set(key, value);
    } else if (ids.includes(key)) {
      if (!isMenuBoardId(raw)) return failure("invalid_document_shape");
      if (element.get(key) !== raw) element.set(key, raw);
    } else return failure("invalid_document_shape");
  }
  return success(null);
}

function moveBoardElement(
  elementId: string,
  placement: MenuBoardPlacement,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  const element = doc.getMap("elements").get(elementId);
  if (!(element instanceof Y.Map) || !validPlacement(placement))
    return failure("record_conflict");
  const encoded = encodePlacement(placement);
  if (element.get("placement") !== encoded) element.set("placement", encoded);
  return success(null);
}

function placeBoardElements(
  placements: readonly MenuBoardElementPlacement[],
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  if (placements.length > MENU_BOARD_ELEMENT_LIMIT)
    return failure("collection_limit");
  const seen = new Set<string>();
  for (const { elementId, placement } of placements) {
    if (seen.has(elementId)) return failure("invalid_document_shape");
    seen.add(elementId);
    const moved = moveBoardElement(elementId, placement, doc);
    if (!moved.ok) return moved;
  }
  return success(null);
}

function replaceBoard(
  target: MenuBoardSnapshot,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  const board = doc.getMap("board");
  if (board.get("title") !== target.title) board.set("title", target.title);
  if (board.get("layout") !== target.layout) board.set("layout", target.layout);
  const style = doc.getMap("style");
  const tokens = target.style as Readonly<Record<string, unknown>>;
  for (const token of [...style.keys()])
    if (tokens[token] === undefined) style.delete(token);
  const styled = setBoardStyle(target.style, doc);
  if (!styled.ok) return styled;
  const elements = doc.getMap("elements");
  const wanted = new Map(
    [...target.elements, ...target.unplaced].map((element) => [
      element.id,
      element,
    ]),
  );
  for (const id of [...elements.keys()])
    if (!wanted.has(id)) elements.delete(id);
  for (const element of wanted.values()) {
    const current = elements.get(element.id);
    if (!(current instanceof Y.Map) || current.get("kind") !== element.kind) {
      if (current !== undefined) elements.delete(element.id);
      const added = addBoardElement(element, doc);
      if (!added.ok) return added;
      continue;
    }
    const props = menuBoardElementProps(element) as Readonly<
      Record<string, unknown>
    >;
    for (const key of MENU_BOARD_OPTIONAL_PROPS[element.kind])
      if (props[key] === undefined && current.has(key)) current.delete(key);
    for (const [key, value] of Object.entries(props))
      if (key !== "kind" && current.get(key) !== value) current.set(key, value);
    const moved = moveBoardElement(element.id, element.placement, doc);
    if (!moved.ok) return moved;
  }
  return success(null);
}

function validPlacement(placement: MenuBoardPlacement): boolean {
  return parseMenuBoardPlacement(placement) !== null;
}

function removeBoardElement(
  elementId: string,
  doc: Y.Doc,
): MenuBoardCrdtResult<null> {
  const elements = doc.getMap("elements");
  if (!elements.has(elementId)) return failure("record_conflict");
  elements.delete(elementId);
  return success(null);
}

/** The check of the content. The shared document checks the roots first. */
function validateDocument(doc: Y.Doc): MenuBoardCrdtResult<null> {
  for (const [token, value] of doc.getMap("style"))
    if (!isMenuBoardStyleToken(token) || !isMenuBoardStyleValue(token, value))
      return failure("invalid_document_shape");
  const board = doc.getMap("board");
  if (
    board.size !== 2 ||
    !isMenuBoardText(board.get("title")) ||
    !isMenuBoardLayout(board.get("layout"))
  )
    return failure("invalid_document_shape");
  const elements = doc.getMap("elements");
  if (elements.size > MENU_BOARD_ELEMENT_LIMIT)
    return failure("collection_limit");
  for (const [id, element] of elements) {
    if (!(element instanceof Y.Map) || readElement(id, element) === null)
      return failure("invalid_document_shape");
  }
  return checkDocumentSize(doc, ENCODING_LIMITS);
}

function readElement(
  id: string,
  element: Y.Map<unknown>,
): MenuBoardElement | null {
  const kind = element.get("kind");
  if (!isMenuBoardId(id) || !isMenuBoardElementKind(kind)) return null;
  const placement = parsePlacement(element.get("placement"));
  const text = MENU_BOARD_TEXT_PROPS[kind];
  const ids = MENU_BOARD_ID_PROPS[kind];
  const optional = MENU_BOARD_OPTIONAL_PROPS[kind].filter((key) =>
    element.has(key),
  );
  if (
    placement === null ||
    element.size !== 2 + text.length + ids.length + optional.length
  )
    return null;
  for (const key of optional)
    if (!isMenuBoardOptionalValue(key, element.get(key))) return null;
  const props: Record<string, string> = {};
  for (const key of text) {
    const value = element.get(key);
    if (!isMenuBoardText(value)) return null;
    props[key] = value;
  }
  for (const key of ids) {
    const value = element.get(key);
    if (!isMenuBoardId(value)) return null;
    props[key] = value;
  }
  if (kind === "pickup_codes" && !isMenuBoardPickupStage(props.stage))
    return null;
  if (kind === "stack" && !isMenuBoardStackProps(props)) return null;
  if (kind === "image" && !isMenuBoardImageProps(props)) return null;
  for (const key of optional) props[key] = String(element.get(key));
  return { id, kind, placement, ...props } as MenuBoardElement;
}

/**
 * A placement is one string, so that a move replaces it as one value: a
 * frame and its ordering key ("column_1@3"), or the canvas with the stacking
 * order, the rect and the constraints ("canvas@3@40,60,500,320@left:top").
 */
function parsePlacement(value: unknown): MenuBoardPlacement | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const parts = value.split("@");
  const frameId = parts[0];
  if (frameId === "stack") {
    // "stack@<stack ID>@<order>@<width>,<height>"
    const order = integer(parts[2]);
    const size = (parts[3] ?? "").split(",").map(integer);
    return parts.length === 4 &&
      isMenuBoardId(parts[1]) &&
      order !== null &&
      size.length === 2
      ? parseMenuBoardPlacement({
          frameId,
          stackId: parts[1],
          order,
          size: { width: size[0], height: size[1] },
        })
      : null;
  }
  const order = integer(parts[1]);
  if (frameId === "canvas") {
    if (parts.length !== 4 || order === null) return null;
    const box = (parts[2] ?? "").split(",").map(integer);
    const [horizontal, vertical, extra] = (parts[3] ?? "").split(":");
    const rect = {
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
    };
    if (
      box.length !== 4 ||
      !isMenuBoardRect(rect) ||
      extra !== undefined ||
      !isMenuBoardHorizontalConstraint(horizontal) ||
      !isMenuBoardVerticalConstraint(vertical)
    )
      return null;
    return {
      frameId,
      order,
      rect,
      constraints: { horizontal, vertical },
    };
  }
  return parts.length === 2 &&
    isMenuBoardFrameId(frameId) &&
    frameId !== "canvas" &&
    order !== null &&
    isMenuBoardOrder(order)
    ? { frameId, order }
    : null;
}

function integer(text: string | undefined): number | null {
  if (text === undefined || !/^-?(0|[1-9][0-9]{0,6})$/u.test(text)) return null;
  return Number(text);
}

function encodePlacement(placement: MenuBoardPlacement): string {
  if (placement.frameId === "stack")
    return `stack@${placement.stackId}@${placement.order}@${placement.size.width},${placement.size.height}`;
  if (placement.frameId !== "canvas")
    return `${placement.frameId}@${placement.order}`;
  const { rect, constraints } = placement;
  return `canvas@${placement.order}@${rect.x},${rect.y},${rect.width},${rect.height}@${constraints.horizontal}:${constraints.vertical}`;
}
