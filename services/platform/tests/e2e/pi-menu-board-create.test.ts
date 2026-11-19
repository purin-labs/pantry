// Plan 40B, the start screen: a new board starts from a layout's template,
// a blank free canvas or a designed menu. The owner makes a blank canvas
// and a Night market board through the Portal's route; a viewer is
// refused, and a design on a fixed layout is refused. Sous Chef makes a Matcha
// board for a portrait TV with menu_board_create: a wrong start comes back
// in words that it can act on, and the board that it makes has the Matcha
// style, tiles, and the elements of the template of its shape. People open the board
// in its room and see what Sous Chef made.
import { expect, it, type TestContext } from "vitest";
import {
  MENU_BOARD_STYLE_PRESETS,
  type MenuBoardSnapshot,
} from "@purin-labs/menu-board-crdt";
import { isRecord } from "@purin-labs/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  delivered,
  installBoardJourney,
  redactIds,
  send,
  toolOutput,
} from "./menu-board-journey-support";
import { sendListingMessage } from "./pi-sdk-effect-support";
import {
  ROOT_TS,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardCreate?: Record<string, unknown>;
  }
}

type Script = { outputs: string[]; steps: number; boardId: string };

it(
  "makes boards from a blank canvas, a designed menu and Urk's menu_board_create, and refuses a viewer",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { outputs: [], steps: 0, boardId: "" };
    const journey = await installBoardJourney("create", (body) => respond(script, body));

    // A viewer cannot make a board; a design needs a free canvas layout.
    const viewer = await send(`${BASE}/menu-boards`, journey.viewer, "POST", {
      title: "Viewer board",
      layout: "canvas_landscape",
      start: "blank",
    });
    expect(viewer.status).toBe(404);
    const fixed = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Wrong",
      layout: "three_columns",
      start: "matcha_bar",
    });
    expect([fixed.status, fixed.body]).toEqual([422, { ok: false, error: "menu_board_invalid" }]);

    // The owner makes a blank canvas and a Night market board.
    const blank = await made(journey.owner, { title: "Blank", layout: "canvas_tablet", start: "blank" });
    const night = await made(journey.owner, { title: "Pickup", layout: "canvas_landscape", start: "night_market" });
    // The template of the same shape lists the menu's sections, as a design does.
    const template = await made(journey.owner, { title: "Template", layout: "canvas_portrait", start: "template" });
    const templateKinds = template.elements.map((element) => element.kind);
    expect(blank.elements).toEqual([]);
    expect(blank.layout).toBe("canvas_tablet");
    expect(night.style).toMatchObject(MENU_BOARD_STYLE_PRESETS.night_market.style);
    expect(night.elements.map((element) => element.kind)).toEqual([
      "heading",
      "pickup_codes",
      "pickup_codes",
      "order_qr",
    ]);
    expect(night.elements.every((element) => element.placement.frameId === "canvas")).toBe(true);

    // Sous Chef makes a Matcha board for the window TV.
    await sendListingMessage(
      "app_mention",
      "EvCreateUrk",
      ROOT_TS,
      "<@U0PANTRY> Make a Matcha menu board for the portrait TV in the window. Call it Window.",
    );
    await expect
      .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
      .toContain("CR_DONE");
    const listed = await send(`${BASE}/menu-boards`, journey.owner, "GET");
    const window = boardsOf(listed.body).find((board) => board.title === "Window");
    expect(window).toBeDefined();
    script.boardId = window?.boardId ?? "";
    const peer = await BoardPeer.open(`${BASE}/menu-boards/${script.boardId}/socket`, journey.staff);
    try {
      const board = peer.read();
      expect(board.layout).toBe("canvas_portrait");
      expect(board.style).toMatchObject({ ...MENU_BOARD_STYLE_PRESETS.matcha.style, itemRow: "tiles" });
      // The design places the same elements as the template, in its style.
      expect(board.elements.map((element) => element.kind)).toEqual(templateKinds);
      expect(board.elements.at(-1)?.kind).toBe("order_qr");
      task.meta.menuBoardCreate = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: ["Pantry Worker, the board store and its room", "Underclerk fixture Worker"],
        refused: { viewer: viewer.status, designOnFixedLayout: fixed.status },
        blank: { layout: blank.layout, elements: blank.elements.length },
        nightMarket: night.elements.map((element) => element.kind),
        urk: {
          layout: board.layout,
          itemRow: board.style.itemRow,
          background: board.style.background,
          kinds: board.elements.map((element) => element.kind),
        },
        toolOutputs: script.outputs.map(redactIds),
      };
    } finally {
      await closeSocket(peer.socket);
    }
  },
);

async function made(
  authority: Parameters<typeof send>[1],
  body: Record<string, unknown>,
): Promise<MenuBoardSnapshot> {
  const created = await send(`${BASE}/menu-boards`, authority, "POST", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const boardId = boardIdOf(created.body);
  const peer = await BoardPeer.open(`${BASE}/menu-boards/${boardId}/socket`, authority);
  try {
    return peer.read();
  } finally {
    await closeSocket(peer.socket);
  }
}

function boardsOf(body: unknown): readonly Readonly<{ boardId: string; title: string }>[] {
  if (!isRecord(body) || !Array.isArray(body.boards)) throw new Error(`No boards: ${JSON.stringify(body)}`);
  return body.boards as Readonly<{ boardId: string; title: string }>[];
}

function respond(script: Script, body: Record<string, unknown>): Response {
  script.steps += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (script.steps) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_board_create menu board new", limit: 8 },
        "cr_discover",
      );
    case 2:
      // A designed menu on a fixed layout: the tool says what fits.
      return openRouterToolCall(
        "menu_board_create",
        { title: "Window", layout: "portrait_list", start: "matcha_bar" },
        "cr_wrong",
      );
    case 3:
      expect(last).toContain("need a canvas_* layout");
      return openRouterToolCall(
        "menu_board_create",
        { title: "Window", layout: "canvas_portrait", start: "matcha_bar" },
        "cr_make",
      );
    case 4:
      expect(JSON.parse(last)).toMatchObject({ board: { title: "Window", layout: "canvas_portrait" } });
      return openRouterText("CR_DONE", "cr_done");
    default:
      throw new Error(`Unexpected create model request ${script.steps}`);
  }
}
