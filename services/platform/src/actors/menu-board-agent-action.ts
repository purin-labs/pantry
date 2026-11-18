import {
  COLLABORATION_AGENT_ACTION_ELEMENTS,
  COLLABORATION_AGENT_DRAFT_TEXT_LIMIT,
  type CollaborationAgentAction,
} from "@seams/collaboration";
import type { MenuBoardRect } from "@seams/menu-board-crdt/board";
import { assertNever } from "@seams/std";
import type { MenuBoardEdit } from "./menu-boards";

/**
 * What an agent's board edit does, as the canvas shows it (Plan 40B phase 7,
 * slice 1): the kind, the elements that it names, the rect that it proposes
 * and the text field that it changes. A new element takes its ID from the
 * operation, so the action names it before the edit commits. The action is
 * `pending` here; the room marks it `applied` for its hold after the edit.
 *
 * `currentRect` is the element's rect before a `place_on_canvas`, so that a
 * change of size reads as a resize and a change of place as a move.
 */
export function boardEditAction(
  edit: MenuBoardEdit,
  operationId: string,
  currentRect: MenuBoardRect | null,
): CollaborationAgentAction {
  const created = `element_${operationId.slice(0, 16)}`;
  switch (edit.kind) {
    case "add_text":
    case "add_item":
      return action(
        "create",
        [created],
        edit.rect,
        edit.kind === "add_text" ? "text" : null,
      );
    case "add_image":
      return action("create", [created], edit.rect, null);
    case "stack_elements":
      return action(
        "create",
        [...new Set([created, ...edit.elementIds])].slice(
          0,
          COLLABORATION_AGENT_ACTION_ELEMENTS,
        ),
        null,
        null,
      );
    case "place_on_canvas":
      return action(
        currentRect !== null &&
          (currentRect.width !== edit.rect.width ||
            currentRect.height !== edit.rect.height)
          ? "resize"
          : "move",
        [edit.elementId],
        edit.rect,
        null,
      );
    case "move_element":
    case "move_in_stack":
    case "unstack":
      return action("move", [edit.elementId], null, null);
    case "set_text":
      return action("text", [edit.elementId], null, edit.prop);
    case "rename_board":
      return action("text", [], null, "title");
    case "set_featured_item":
    case "set_row":
    case "set_look":
    case "set_fit":
    case "set_stack":
      return action("style", [edit.elementId], null, null);
    case "set_style":
      return action("style", [], null, null);
    case "remove_element":
      return action("remove", [edit.elementId], null, null);
    case "add_comment":
      return action("comment", [edit.elementId], null, null);
    case "reply_comment":
    case "resolve_comment":
      return action("comment", [], null, null);
    case "save_version":
    case "restore_version":
      return action("history", [], null, null);
    default:
      return assertNever(edit);
  }
}

function action(
  kind: CollaborationAgentAction["kind"],
  elementIds: readonly string[],
  rect: MenuBoardRect | null,
  field: string | null,
): CollaborationAgentAction {
  return {
    kind,
    elementIds,
    rect:
      rect === null
        ? null
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    field,
    state: "pending",
  };
}

/**
 * The part of a board edit that the model has written so far (Plan 40B
 * phase 7, slices 3 and 4): only the fields that the canvas draws. The
 * Session reads them from the model's tool arguments while they stream; a
 * number counts only when the model has finished it.
 */
export type MenuBoardDraftEdit = Readonly<{
  kind: "add_text" | "set_text" | "place_on_canvas";
  elementId: string | null;
  prop: string | null;
  text: string | null;
  rect: MenuBoardRect | null;
}>;

/**
 * The action of a draft edit, or null while it has no real target yet. A
 * new text shows at its proposed rect, a text change on its element and a
 * move at the rect that the model wrote. Nothing shows at an invented place.
 */
export function boardDraftAction(
  draft: MenuBoardDraftEdit,
  currentRect: MenuBoardRect | null,
): CollaborationAgentAction | null {
  switch (draft.kind) {
    case "add_text":
      return draft.rect === null
        ? null
        : withText(action("create", [], draft.rect, "text"), draft.text);
    case "set_text":
      return draft.elementId === null || draft.prop === null
        ? null
        : withText(
            action("text", [draft.elementId], null, draft.prop),
            draft.text,
          );
    case "place_on_canvas":
      return draft.elementId === null || draft.rect === null
        ? null
        : action(
            currentRect !== null &&
              (currentRect.width !== draft.rect.width ||
                currentRect.height !== draft.rect.height)
              ? "resize"
              : "move",
            [draft.elementId],
            draft.rect,
            null,
          );
    default:
      return assertNever(draft.kind);
  }
}

function withText(
  base: CollaborationAgentAction,
  text: string | null,
): CollaborationAgentAction {
  return text === null
    ? base
    : {
        ...base,
        text: [...text].slice(0, COLLABORATION_AGENT_DRAFT_TEXT_LIMIT).join(""),
      };
}
