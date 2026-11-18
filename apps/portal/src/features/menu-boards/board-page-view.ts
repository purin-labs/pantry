import type { PortalPageViewSection, PortalPageViewV1 } from "@seams/control-api";
import type { MenuBoardElement, MenuBoardSnapshot } from "@seams/menu-board-crdt/board";

/**
 * Menus › Boards as the chat sees it (Plan 40B phase 5, slice 9): the open
 * board, and the elements that the person has selected with their text and
 * place. The chat reads it when the person sends a message, so "this" in a
 * message names the selection.
 */
export type BoardPageSnapshot = Readonly<{
  organisationId: string;
  boardId: string;
  board: MenuBoardSnapshot;
  selection: readonly string[];
  names: Readonly<Record<MenuBoardElement["kind"], string>>;
}>;

const CELL = 400;

export function boardPageView(snapshot: BoardPageSnapshot, path: string): PortalPageViewV1 {
  const all = [...snapshot.board.elements, ...snapshot.board.unplaced];
  const selected = snapshot.selection.flatMap((id) => {
    const element = all.find((candidate) => candidate.id === id);
    return element === undefined ? [] : [element];
  });
  const sections: PortalPageViewSection[] = [{
    title: "Board",
    facts: [
      { label: "Board ID", value: snapshot.boardId },
      { label: "Title", value: cell(snapshot.board.title) },
      { label: "Layout", value: snapshot.board.layout },
      { label: "Elements", value: String(all.length) },
    ],
    table: null,
  }];
  sections.push({
    title: "Selected elements",
    facts: selected.length === 0
      ? [{ label: "Selection", value: "Nothing is selected" }]
      : [{ label: "Selection", value: `${selected.length} selected: “this” in the request means them` }],
    table: selected.length === 0 ? null : {
      columns: ["Element ID", "Kind", "Text", "Place"],
      rows: selected.slice(0, 24).map((element) => [
        element.id,
        snapshot.names[element.kind],
        cell(elementText(element)),
        cell(placeText(element)),
      ]),
      totalRows: selected.length,
    },
  });
  return {
    kind: "portal-page-view",
    schemaVersion: 1,
    page: "menu-boards",
    title: "Menus › Boards",
    path: path.startsWith("/") ? path.slice(0, 400) : "/menus",
    capturedAt: Date.now(),
    sections,
  };
}

function cell(text: string): string {
  return text.length > CELL ? `${text.slice(0, CELL - 1)}…` : text;
}

/** The text props of an element, as "prop: value". */
function elementText(element: MenuBoardElement): string {
  switch (element.kind) {
    case "heading":
      return `title: ${element.title}; eyebrow: ${element.eyebrow}; detail: ${element.detail}`;
    case "section":
      return `note: ${element.note}`;
    case "featured":
      return `label: ${element.label}; note: ${element.note}`;
    case "order_qr":
      return `title: ${element.title}; detail: ${element.detail}`;
    case "pickup_codes":
      return `title: ${element.title}`;
    case "text":
      return `text: ${element.text}`;
    case "image":
      return `mediaId: ${element.mediaId}; altText: ${element.altText}; fit: ${element.fit}`;
    case "stack":
      return `direction: ${element.direction}; gap: ${element.gap}; padding: ${element.padding}; align: ${element.align}`;
    default:
      return element satisfies never;
  }
}

function placeText(element: MenuBoardElement): string {
  const placement = element.placement;
  switch (placement.frameId) {
    case "canvas":
      return `canvas x ${placement.rect.x}, y ${placement.rect.y}, ${placement.rect.width} by ${placement.rect.height}`;
    case "stack":
      return `in stack ${placement.stackId}, place ${placement.order}`;
    default:
      return `${placement.frameId}, place ${placement.order}`;
  }
}
