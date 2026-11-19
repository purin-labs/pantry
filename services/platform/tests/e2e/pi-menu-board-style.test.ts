// Plan 40B phase 5, slice 2: style tokens and a type scale. The owner sets
// the colours, the fonts and the text size of the open board. Sous Chef reads
// the style, and an invalid type scale is refused in words that it can act
// on before it sets a valid one. Only the next release carries the style to
// the TV. `pi-menu-board-together` proves that people and Sous Chef converge
// and that a viewer's change is refused.
import { expect, it, type TestContext } from "vitest";
import type { MenuBoardStyle } from "@seams/menu-board-crdt";
import { isRecord } from "@seams/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  delivered,
  feed,
  installBoardJourney,
  pairScreen,
  publishBoard,
  send,
  toolOutput,
} from "./menu-board-journey-support";
import {
  ROOT_TS,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";
import { sendListingMessage } from "./pi-sdk-effect-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardStyle?: Record<string, unknown>;
  }
}

const COLOURS = {
  background: "#f4efe4",
  surface: "#ffffff",
  ink: "#1f1a14",
  accent: "#9a3412",
} as const;
const TYPE = {
  fontDisplay: "rounded",
  fontBody: "rounded",
  typeBase: 22,
} as const;

type Script = { boardId: string; outputs: string[]; steps: number };

it(
  "lets the owner and Sous Chef restyle one board, and carries the style to the TV only in the next release",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { boardId: "", outputs: [], steps: 0 };
    const journey = await installBoardJourney("style", (body) =>
      respond(script, body),
    );
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Drinks",
      layout: "two_columns",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);

    const token = await pairScreen(journey.owner, script.boardId);
    const first = await publishBoard(journey.owner, script.boardId, null);

    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    try {
      expect(ownerPeer.read().style).toEqual({});
      await ownerPeer.submit(
        "owner-style",
        ownerPeer.doc.setStyle({ ...COLOURS, ...TYPE }),
      );

      // Sous Chef reads the style and changes the type scale; an invalid ratio is
      // refused with the values that it may use.
      await sendListingMessage(
        "app_mention",
        "EvStyleScale",
        ROOT_TS,
        "<@U0PANTRY> Make the headings on the Drinks board stand out more: use a stronger type scale.",
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("ST_SCALE_SET");
      await expect
        .poll(() => ownerPeer.read().style.typeRatio, { timeout: 15_000 })
        .toBe("1.414");
      const merged = ownerPeer.read();
      expect(merged.style).toMatchObject({
        ...COLOURS,
        ...TYPE,
        typeRatio: "1.414",
      });

      // Nothing reached the TV before a person published.
      expect((await feed(token)).release?.releaseRevision).toBe(first);
      const second = await publishBoard(journey.owner, script.boardId, first);
      const styled = await feed(token);
      expect(styled.release?.releaseRevision).toBe(second);
      expect(styled.release?.style).toEqual(merged.style);

      task.meta.menuBoardStyle = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: ["Pantry Worker and the board room", "screen feed"],
        merged: sortedStyle(merged.style),
        toolOutputs: script.outputs.map(scrub),
        releases: {
          first,
          second,
          styleEqualsMerged: true,
        },
      };
    } finally {
      await closeSocket(ownerPeer.socket);
    }
  },
);

function respond(script: Script, body: Record<string, unknown>): Response {
  script.steps += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (script.steps) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        {
          query: "menu_board_read menu_board_edit menu_board_propose_price",
          limit: 3,
        },
        "st_discover",
      );
    case 2:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: null },
        "st_read",
      );
    case 3: {
      const read: unknown = JSON.parse(last);
      const board =
        isRecord(read) && Array.isArray(read.boards) ? read.boards[0] : null;
      // The read carries the owner's style.
      expect(board).toMatchObject({ style: { ...COLOURS, ...TYPE } });
      return openRouterToolCall(
        "menu_board_edit",
        styleEdit(script, "1.75"),
        "st_bad_ratio",
      );
    }
    case 4:
      expect(last).toContain("typeRatio");
      expect(last).toContain("1.75");
      return openRouterToolCall(
        "menu_board_edit",
        styleEdit(script, "1.414"),
        "st_ratio",
      );
    case 5:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { kind: "style", style: { typeRatio: "1.414" } } },
      });
      return openRouterText("ST_SCALE_SET", "st_done");
    default:
      throw new Error(`Unexpected style model request ${script.steps}`);
  }
}

function styleEdit(script: Script, ratio: string): Record<string, unknown> {
  return {
    kind: "set_style",
    boardId: script.boardId,
    elementId: null,
    prop: "typeRatio",
    before: null,
    text: ratio,
    title: null,
    itemId: null,
    frameId: null,
    order: null,
    x: null,
    y: null,
    width: null,
    height: null,
  };
}

function sortedStyle(style: MenuBoardStyle): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(style).sort(([first], [second]) =>
      first.localeCompare(second),
    ),
  );
}

function scrub(text: string): string {
  return text
    .replace(/(board|element)_[0-9a-f]{16,32}/gu, "$1_…")
    .replace(/"(observedAt|publishedAt|createdAt|updatedAt)":\s*\d+/gu, '"$1":0');
}
