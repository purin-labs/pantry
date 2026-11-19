// Plan 40B phase 5, slice 8: auto-layout stacks on the free canvas. The
// owner places two texts. Sous Chef reads the board, a stack of an element that is
// not on the board is refused in words that it can act on, and it stacks
// the two texts. At the same moment the owner widens the gap and staff
// centre the stack; both keep their change, and a viewer's change is
// refused. Staff make the first text taller, and the stack moves the second
// one down with no edit of its own. Sous Chef puts the second text first. The TV
// plays the stack as the editors place it, and a stack that staff remove
// leaves its texts with no place, so the board cannot be published.
import { expect, it, type TestContext } from "vitest";
import {
  MENU_BOARD_SCREEN_SIZES,
  menuBoardCanvasRects,
  type MenuBoardElement,
  type MenuBoardRect,
  type MenuBoardSnapshot,
} from "@seams/menu-board-crdt";
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
    menuBoardStacks?: Record<string, unknown>;
  }
}

const SIZE = MENU_BOARD_SCREEN_SIZES.landscape;
const FIRST = "element_soupoftheday";
const SECOND = "element_breadbasket";

type Script = { boardId: string; stackId: string; outputs: string[]; steps: number };

it(
  "lets Urk and two people build an auto-layout stack together, reflows it when an element grows, and plays it on the TV",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { boardId: "", stackId: "", outputs: [], steps: 0 };
    const journey = await installBoardJourney("stacks", (body) =>
      respond(script, body),
    );
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Specials",
      layout: "canvas_landscape",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const staffPeer = await BoardPeer.open(socket, journey.staff);
    const viewerPeer = await BoardPeer.open(socket, journey.viewer);
    try {
      for (const [id, text, rect] of [
        [FIRST, "Soup of the day", { x: 120, y: 240, width: 420, height: 80 }],
        [SECOND, "Bread basket", { x: 160, y: 380, width: 360, height: 120 }],
      ] as const)
        await ownerPeer.submit(
          `add-${id}`,
          ownerPeer.doc.addElement({
            id,
            kind: "text",
            placement: {
              frameId: "canvas",
              order: 3,
              rect,
              constraints: { horizontal: "scale", vertical: "scale" },
            },
            text,
          }),
        );

      // Turn 1: Sous Chef stacks the two texts.
      await sendListingMessage(
        "app_mention",
        "EvStacksMake",
        ROOT_TS,
        "<@U0PANTRY> Stack the soup and the bread texts on the Specials board.",
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("ST_STACKED");
      await expect
        .poll(() => stackOf(staffPeer.read()) !== null, { timeout: 15_000 })
        .toBe(true);
      const made = stackOf(staffPeer.read());
      if (made === null || made.kind !== "stack") throw new Error("No stack");
      script.stackId = made.id;
      const first = rects(staffPeer.read());
      expect([made.direction, made.gap, made.padding, made.align]).toEqual([
        "vertical",
        "24",
        "16",
        "stretch",
      ]);
      // Each text fills the stack's width inside its padding, one after
      // the other with the gap.
      expect(first.get(FIRST)).toEqual({
        x: rectOf(made).x + 16,
        y: rectOf(made).y + 16,
        width: rectOf(made).width - 32,
        height: 80,
      });
      expect(first.get(SECOND)?.y).toBe(rectOf(made).y + 16 + 80 + 24);

      // The owner widens the gap while staff centre the stack; a viewer's
      // change is refused.
      await Promise.all([
        ownerPeer.submit("owner-gap", ownerPeer.doc.updateElement(made.id, { gap: "40" })),
        staffPeer.submit("staff-align", staffPeer.doc.updateElement(made.id, { align: "center" })),
      ]);
      const refused = await viewerPeer.submitRefused((copy) =>
        copy.updateElement(made.id, { direction: "horizontal" }),
      );
      expect(refused).toMatchObject({ kind: "failure", code: "access_revoked" });
      await expect.poll(() => ownerPeer.read(), { timeout: 10_000 }).toEqual(staffPeer.read());
      const settled = stackOf(ownerPeer.read());
      expect(settled?.kind === "stack" ? [settled.gap, settled.align] : null).toEqual(["40", "center"]);

      // Staff make the first text taller; the stack moves the second one.
      const soup = ownerPeer.read().elements.find((element) => element.id === FIRST);
      if (soup?.placement.frameId !== "stack") throw new Error("The soup is not stacked");
      const secondBefore = rects(ownerPeer.read()).get(SECOND);
      await staffPeer.submit(
        "staff-taller",
        staffPeer.doc.moveElement(FIRST, {
          ...soup.placement,
          size: { width: soup.placement.size.width, height: 140 },
        }),
      );
      await expect
        .poll(() => rects(ownerPeer.read()).get(SECOND)?.y, { timeout: 10_000 })
        .toBe((rects(ownerPeer.read()).get(FIRST)?.y ?? 0) + 140 + 40);
      const second = ownerPeer.read().elements.find((element) => element.id === SECOND);
      // The second text changed no value of its own.
      expect(second?.placement).toMatchObject({ frameId: "stack", stackId: made.id });

      // Turn 2: Sous Chef puts the bread first.
      await sendListingMessage(
        "message",
        "EvStacksOrder",
        "1710000400.000100",
        "Put the bread basket first.",
        ROOT_TS,
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("ST_ORDERED");
      await expect
        .poll(() => order(staffPeer.read(), made.id), { timeout: 10_000 })
        .toEqual([SECOND, FIRST]);
      const merged = ownerPeer.read();
      const stored = await BoardPeer.open(socket, journey.owner);
      expect(stored.read()).toEqual(merged);
      await closeSocket(stored.socket);

      // The TV plays the stack as the editors place it.
      const token = await pairScreen(journey.owner, script.boardId);
      const release = await publishBoard(journey.owner, script.boardId, null);
      const shown = await feed(token);
      expect(shown.release?.releaseRevision).toBe(release);
      expect(shown.release?.elements).toEqual(merged.elements);
      const played = menuBoardCanvasRects(shown.release?.elements ?? [], SIZE, SIZE);
      expect([played.get(FIRST), played.get(SECOND)]).toEqual([
        rects(merged).get(FIRST),
        rects(merged).get(SECOND),
      ]);
      // On a portrait TV the stack follows its constraints and still holds
      // its texts one after the other.
      const portrait = menuBoardCanvasRects(
        shown.release?.elements ?? [],
        SIZE,
        MENU_BOARD_SCREEN_SIZES.portrait,
      );
      const bread = portrait.get(SECOND);
      const soupOnPortrait = portrait.get(FIRST);
      expect(bread !== undefined && soupOnPortrait !== undefined && soupOnPortrait.y > bread.y).toBe(true);

      // A stack that staff remove leaves its texts with no place.
      await staffPeer.submit("staff-remove-stack", staffPeer.doc.removeElement(made.id));
      await expect
        .poll(() => ownerPeer.read().unplaced.map((element) => element.id).sort(), { timeout: 10_000 })
        .toEqual([SECOND, FIRST].sort());
      const blocked = await send(
        `${BASE}/menu-boards/${script.boardId}/releases`,
        journey.owner,
        "POST",
        {
          documentRevision: await revision(journey.owner, script.boardId),
          expectedReleaseRevision: release,
        },
      );
      expect([blocked.status, isRecord(blocked.body) ? blocked.body.error : null]).toEqual([
        422,
        "menu_board_unplaced",
      ]);

      task.meta.menuBoardStacks = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: [
          "Pantry Worker and the board room",
          "Underclerk fixture Worker",
          "screen feed",
        ],
        stack: {
          madeBy: "agent",
          settings: settled?.kind === "stack"
            ? { direction: settled.direction, gap: settled.gap, padding: settled.padding, align: settled.align }
            : null,
          order: order(merged, made.id),
        },
        reflow: { secondBefore, secondAfter: rects(merged).get(SECOND) },
        viewerRefusal: refused,
        release,
        removedStackLeaves: "unplaced",
        publishWithLooseElements: blocked.status,
        toolOutputs: script.outputs.map(redactIds),
      };
    } finally {
      await Promise.all(
        [ownerPeer, staffPeer, viewerPeer].map((peer) => closeSocket(peer.socket)),
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
        { query: "menu_board_read menu_board_stack", limit: 8 },
        "st_discover",
      );
    case 2:
      return openRouterToolCall("menu_board_read", { boardId: script.boardId }, "st_read");
    case 3: {
      const read: unknown = JSON.parse(last);
      const board = isRecord(read) && Array.isArray(read.boards) ? read.boards[0] : null;
      // The read gives where each element shows.
      expect(isRecord(board) && isRecord(board.canvasRects) ? board.canvasRects[FIRST] : null).toEqual({
        x: 120,
        y: 240,
        width: 420,
        height: 80,
      });
      return openRouterToolCall(
        "menu_board_stack",
        stackArgs(script, { kind: "stack_elements", elementIds: [FIRST, "element_missing"] }),
        "st_bad",
      );
    }
    case 4:
      expect(last).toContain("not on the board now");
      return openRouterToolCall(
        "menu_board_stack",
        stackArgs(script, { kind: "stack_elements", elementIds: [FIRST, SECOND] }),
        "st_stack",
      );
    case 5:
      expect(JSON.parse(last)).toMatchObject({
        change: { before: null, after: { kind: "stack", direction: "vertical" } },
      });
      return openRouterText("ST_STACKED", "st_done");
    case 6:
      return openRouterToolCall(
        "menu_board_stack",
        {
          kind: "move_in_stack",
          boardId: script.boardId,
          elementId: SECOND,
          elementIds: null,
          direction: null,
          gap: null,
          padding: null,
          align: null,
          order: 0,
        },
        "st_order",
      );
    case 7:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { placement: { frameId: "stack", order: 0 } } },
      });
      return openRouterText("ST_ORDERED", "st_ordered");
    default:
      throw new Error(`Unexpected stacks model request ${script.steps}`);
  }
}

function stackArgs(
  script: Script,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    boardId: script.boardId,
    elementId: null,
    direction: "vertical",
    gap: 24,
    padding: 16,
    align: "stretch",
    order: null,
    ...fields,
  };
}

function stackOf(board: MenuBoardSnapshot): MenuBoardElement | null {
  return board.elements.find((element) => element.kind === "stack") ?? null;
}

function rectOf(element: MenuBoardElement): MenuBoardRect {
  if (element.placement.frameId !== "canvas") throw new Error("Not on the canvas");
  return element.placement.rect;
}

function rects(board: MenuBoardSnapshot): Map<string, MenuBoardRect> {
  return menuBoardCanvasRects(board.elements, SIZE, SIZE);
}

function order(board: MenuBoardSnapshot, stackId: string): readonly string[] {
  return board.elements
    .filter((element) => element.placement.frameId === "stack" && element.placement.stackId === stackId)
    .sort((first, second) => first.placement.order - second.placement.order || first.id.localeCompare(second.id))
    .map((element) => element.id);
}

async function revision(
  session: Parameters<typeof send>[1],
  boardId: string,
): Promise<number> {
  const list = await send(`${BASE}/menu-boards`, session, "GET");
  const boards = isRecord(list.body) && Array.isArray(list.body.boards) ? list.body.boards : [];
  const board: unknown = boards.find((candidate: unknown) => isRecord(candidate) && candidate.boardId === boardId);
  if (!isRecord(board) || typeof board.documentRevision !== "number") throw new Error("No board");
  return board.documentRevision;
}
