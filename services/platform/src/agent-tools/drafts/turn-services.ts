import type { ToolTurnContext } from "../../actors/session/tool-wiring";
import { withToolContext } from "../context";
import {
  archiveMenuBoardForEmbeddedHarness,
  createMenuBoardForEmbeddedHarness,
  editMenuBoardForEmbeddedHarness,
  editMenuDraftForEmbeddedHarness,
  readMenuBoardsForEmbeddedHarness,
  readMenuDraftForEmbeddedHarness,
} from "./handlers";

/**
 * What Café gives to one turn for the menu tools. Commerce gives the price
 * proposal of the same family.
 */
export function menuToolServices(turn: ToolTurnContext) {
  const tool = withToolContext(turn);
  return {
    readMenuDraft: tool(readMenuDraftForEmbeddedHarness),
    editMenuDraft: tool(editMenuDraftForEmbeddedHarness),
    readMenuBoards: tool(readMenuBoardsForEmbeddedHarness),
    editMenuBoard: tool(editMenuBoardForEmbeddedHarness),
    createMenuBoard: tool(createMenuBoardForEmbeddedHarness),
    archiveMenuBoard: tool(archiveMenuBoardForEmbeddedHarness),
  };
}
