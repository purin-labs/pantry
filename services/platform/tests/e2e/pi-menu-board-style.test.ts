// Plan 40B phase 5, slice 2: style tokens and a type scale. A board in the
// default look publishes with no style, so a TV player from before phase 5
// still reads it. Then the owner and staff restyle the open board at the same
// moment: the owner sets the colours, staff set the fonts and the text size,
// and both set the accent. A viewer's restyle is refused. Sous Chef reads the style,
// and an invalid type scale is refused in words that it can act on before it
// sets a valid one. Every replica and the stored board end with one style,
// and the next release carries it to the TV.
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
  rawFeed,
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

const OWNER_COLOURS = {
  background: "#f4efe4",
  surface: "#ffffff",
  ink: "#1f1a14",
} as const;
const STAFF_TYPE = {
  fontDisplay: "rounded",
  fontBody: "rounded",
  typeBase: 22,
} as const;
const OWNER_ACCENT = "#9a3412";
const STAFF_ACCENT = "#0f766e";

type Script = { boardId: string; outputs: string[]; steps: number };

it(
  "lets two people and Urk restyle one board at once, converge on one style, and carry it to the TV only in the next release",
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

    // A board in the default look publishes with no style key, so a TV
    // player from before phase 5, which reads exact keys, still plays it.
    const token = await pairScreen(journey.owner, script.boardId);
    const first = await publishBoard(journey.owner, script.boardId, null);
    const plain = await rawFeed(token);
    expect(
      isRecord(plain.release) && Object.hasOwn(plain.release, "style"),
    ).toBe(false);
    expect((await feed(token)).release?.style).toBeUndefined();

    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const staffPeer = await BoardPeer.open(socket, journey.staff);
    const viewerPeer = await BoardPeer.open(socket, journey.viewer);
    try {
      expect(ownerPeer.read().style).toEqual({});
      // From the same state, the owner sets the colours and staff set the
      // fonts and the text size; both set the accent.
      await Promise.all([
        ownerPeer.submit(
          "owner-colours",
          ownerPeer.doc.setStyle({ ...OWNER_COLOURS, accent: OWNER_ACCENT }),
        ),
        staffPeer.submit(
          "staff-type",
          staffPeer.doc.setStyle({ ...STAFF_TYPE, accent: STAFF_ACCENT }),
        ),
      ]);
      const refused = await viewerPeer.submitRefused((copy) =>
        copy.setStyle({ background: "#000000" }),
      );
      expect(refused).toMatchObject({
        kind: "failure",
        code: "access_revoked",
      });

      // Sous Chef reads the style and changes the type scale; an invalid ratio is
      // refused with the values that it may use.
      await sendListingMessage(
        "app_mention",
        "EvStyleScale",
        ROOT_TS,
        "<@U0SATYR> Make the headings on the Drinks board stand out more: use a stronger type scale.",
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("ST_SCALE_SET");
      await expect
        .poll(() => ownerPeer.read().style.typeRatio, { timeout: 15_000 })
        .toBe("1.414");
      await expect
        .poll(() => staffPeer.read().style.typeRatio, { timeout: 15_000 })
        .toBe("1.414");

      const stored = await BoardPeer.open(socket, journey.owner);
      const merged = stored.read();
      await closeSocket(stored.socket);
      expect(ownerPeer.read()).toEqual(merged);
      expect(staffPeer.read()).toEqual(merged);
      expect(merged.style).toMatchObject({
        ...OWNER_COLOURS,
        ...STAFF_TYPE,
        typeRatio: "1.414",
      });
      expect([OWNER_ACCENT, STAFF_ACCENT]).toContain(merged.style.accent);

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
        real: ["Satyr Worker and the board room", "screen feed"],
        firstReleaseHasStyle: false,
        // Yjs keeps one of two writes of one token; which one depends on
        // the replicas' random client IDs, so the evidence names no winner.
        merged: sortedStyle(withoutAccent(merged.style)),
        accentIsOneOfTheTwo: [OWNER_ACCENT, STAFF_ACCENT].includes(
          merged.style.accent ?? "",
        ),
        viewerRefusal: refused,
        toolOutputs: script.outputs.map((output) =>
          scrub(output)
            .replaceAll(OWNER_ACCENT, "#contested")
            .replaceAll(STAFF_ACCENT, "#contested"),
        ),
        releases: {
          first,
          second,
          styleEqualsMerged: true,
        },
      };
    } finally {
      await Promise.all(
        [ownerPeer, staffPeer, viewerPeer].map((peer) =>
          closeSocket(peer.socket),
        ),
      );
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
      // The read carries the merged style of the two people.
      expect(board).toMatchObject({
        style: { ...OWNER_COLOURS, ...STAFF_TYPE },
      });
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

function withoutAccent(style: MenuBoardStyle): MenuBoardStyle {
  const { accent: _accent, ...rest } = style;
  return rest;
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
