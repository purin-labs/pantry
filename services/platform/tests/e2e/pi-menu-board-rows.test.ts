// Plan 40B phase 5, slice 3: the item-row component and its variants. Every
// item of a section repeats one item row. The owner sets the board's default
// row and gives the drinks section its own row. Sous Chef then reads the
// board, an unknown row is refused in words that it can act on, and it gives
// the pastries section the price-first row. The next release carries the rows
// to the TV. A section that keeps the board's default has no row key in the
// release. `pi-menu-board-together` proves that people and Sous Chef converge
// and that a viewer's change is refused.
import { expect, it, type TestContext } from "vitest";
import type {
  MenuBoardElement,
  MenuBoardSnapshot,
} from "@purin-labs/menu-board-crdt";
import { isRecord } from "@purin-labs/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  delivered,
  draftItemId,
  feed,
  installBoardJourney,
  menuRevision,
  pairScreen,
  publishBoard,
  rawFeed,
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
    menuBoardRows?: Record<string, unknown>;
  }
}

const DRINKS = "section_drinks";
const PASTRIES = "section_pastries";
const TARO = "Taro Milk Tea";
const FINANCIER = "Sesame Financier";

type Script = {
  products: ReadonlyMap<string, string>;
  boardId: string;
  pastriesElementId: string;
  outputs: string[];
  steps: number;
};

it(
  "lets the owner and Sous Chef choose item rows on one board, and carries the rows to the TV in the next release",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = {
      products: new Map(),
      boardId: "",
      pastriesElementId: "",
      outputs: [],
      steps: 0,
    };
    const journey = await installBoardJourney("rows", (body) =>
      respond(script, body),
    );
    script.products = journey.products;

    // Turn 1: Sous Chef makes two sections, each with one item. The owner
    // publishes the menu and a three-column board, and pairs a TV.
    await sendListingMessage(
      "app_mention",
      "EvRowsMenu",
      ROOT_TS,
      "<@U0PANTRY> Put the taro milk tea under Drinks and the sesame financier under Pastries.",
    );
    await expect
      .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
      .toContain("RW_MENU_READY");
    const published = await send(
      `${BASE}/commerce/menu-publication`,
      journey.owner,
      "POST",
      {
        documentRevision: await menuRevision(journey.owner),
      },
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "All day",
      layout: "three_columns",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const token = await pairScreen(journey.owner, script.boardId);
    const first = await publishBoard(journey.owner, script.boardId, null);

    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    try {
      const drinks = sectionOf(ownerPeer.read(), DRINKS);
      script.pastriesElementId = sectionOf(ownerPeer.read(), PASTRIES).id;
      expect(drinks.kind === "section" && drinks.row).toBeUndefined();

      // The owner sets the board's default row and gives the drinks section
      // its own.
      await ownerPeer.submit(
        "owner-default",
        ownerPeer.doc.setStyle({ itemRow: "leader" }),
      );
      await ownerPeer.submit(
        "owner-drinks",
        ownerPeer.doc.updateElement(drinks.id, { row: "stacked" }),
      );

      // Turn 2: Sous Chef gives the pastries their own row.
      await sendListingMessage(
        "message",
        "EvRowsPastries",
        "1710000400.000100",
        "Show the pastries with the price first.",
        ROOT_TS,
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("RW_ROW_SET");
      await expect
        .poll(() => rowOf(ownerPeer.read(), PASTRIES), { timeout: 15_000 })
        .toBe("price_first");
      const merged = ownerPeer.read();
      expect(merged.style.itemRow).toBe("leader");
      expect(rowOf(merged, DRINKS)).toBe("stacked");
      expect(rowOf(merged, PASTRIES)).toBe("price_first");

      // The TV keeps the first release until the owner publishes.
      expect((await feed(token)).release?.releaseRevision).toBe(first);
      const second = await publishBoard(journey.owner, script.boardId, first);
      const shown = await feed(token);
      expect(shown.release?.releaseRevision).toBe(second);
      expect(shown.release?.style?.itemRow).toBe("leader");
      expect(shown.release?.elements).toEqual(merged.elements);
      // A section with its own row carries the key; the release is the
      // same JSON that the TV parses.
      const raw = await rawFeed(token);
      const rawSections =
        isRecord(raw.release) && Array.isArray(raw.release.elements)
          ? raw.release.elements.filter(
              (element: unknown) =>
                isRecord(element) && element.kind === "section",
            )
          : [];
      // The "Menu" section keeps the board's default: its element has no
      // row key, so it reads as it did before phase 5.
      expect(
        rawSections
          .map((section: Record<string, unknown>) =>
            Object.hasOwn(section, "row") ? section.row : "no row key",
          )
          .sort(),
      ).toEqual(["no row key", "price_first", "stacked"]);

      task.meta.menuBoardRows = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: [
          "Pantry Worker and the board room",
          "Commerce fixture Worker",
          "screen feed",
        ],
        boardDefault: merged.style.itemRow,
        sections: merged.elements
          .filter((element) => element.kind === "section")
          .map((element) =>
            element.kind === "section"
              ? { sectionId: redactIds(element.sectionId), row: element.row ?? null }
              : null,
          ),
        toolOutputs: script.outputs.map(sortDraftItems).map(redactIds),
        releases: { first, second },
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
        { query: "menu_draft_edit", limit: 1 },
        "rw_discover_draft",
      );
    case 2:
      return openRouterToolCall(
        "menu_draft_edit",
        draftEdit({ kind: "add_section", title: "Drinks" }),
        "rw_drinks",
      );
    case 3:
      return openRouterToolCall(
        "menu_draft_edit",
        draftEdit({ kind: "add_section", title: "Pastries" }),
        "rw_pastries",
      );
    case 4:
      return openRouterToolCall(
        "menu_draft_edit",
        draftEdit({
          kind: "add_item",
          sectionId: sectionIdOf(last, "Drinks"),
          productId: script.products.get(TARO),
          title: TARO,
          description: "Nutty taro and Assam tea.",
        }),
        "rw_taro",
      );
    case 5:
      draftItemId(last, TARO);
      return openRouterToolCall(
        "menu_draft_edit",
        draftEdit({
          kind: "add_item",
          sectionId: sectionIdOf(last, "Pastries"),
          productId: script.products.get(FINANCIER),
          title: FINANCIER,
          description: "Brown butter and toasted sesame.",
        }),
        "rw_financier",
      );
    case 6:
      draftItemId(last, FINANCIER);
      return openRouterText("RW_MENU_READY", "rw_menu_done");
    case 7:
      return openRouterToolCall(
        "tool_search",
        {
          query: "menu_board_read menu_board_edit menu_board_propose_price",
          limit: 3,
        },
        "rw_discover_boards",
      );
    case 8:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: null },
        "rw_read",
      );
    case 9: {
      const read: unknown = JSON.parse(last);
      const board =
        isRecord(read) && Array.isArray(read.boards) ? read.boards[0] : null;
      // The read shows the owner's rows.
      expect(board).toMatchObject({ style: { itemRow: "leader" } });
      expect(JSON.stringify(board)).toContain('"row":"stacked"');
      return openRouterToolCall(
        "menu_board_edit",
        rowEdit(script, "list"),
        "rw_bad_row",
      );
    }
    case 10:
      expect(last).toContain("price_first");
      return openRouterToolCall(
        "menu_board_edit",
        rowEdit(script, "price_first"),
        "rw_row",
      );
    case 11:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { kind: "section", row: "price_first" } },
      });
      return openRouterText("RW_ROW_SET", "rw_done");
    default:
      throw new Error(`Unexpected rows model request ${script.steps}`);
  }
}

/** Ids in the draft are the menu sections that the board binds to. */
function sectionIdOf(toolText: string, title: string): string {
  const parsed: unknown = JSON.parse(toolText);
  const sections =
    isRecord(parsed) &&
    isRecord(parsed.draft) &&
    Array.isArray(parsed.draft.sections)
      ? parsed.draft.sections
      : [];
  for (const section of sections)
    if (
      isRecord(section) &&
      section.title === title &&
      typeof section.id === "string"
    ) {
      if (title === "Drinks") SECTION_IDS.drinks = section.id;
      if (title === "Pastries") SECTION_IDS.pastries = section.id;
      return section.id;
    }
  throw new Error(`No section ${title} in ${toolText}`);
}

const SECTION_IDS: { drinks: string; pastries: string } = {
  drinks: "",
  pastries: "",
};

function draftEdit(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    kind: "add_item",
    itemId: null,
    sectionId: null,
    productId: null,
    title: null,
    description: null,
    order: null,
    ...fields,
  };
}

function rowEdit(script: Script, row: string): Record<string, unknown> {
  return {
    kind: "set_row",
    boardId: script.boardId,
    elementId: script.pastriesElementId,
    prop: null,
    before: null,
    text: row,
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

function sectionOf(
  board: MenuBoardSnapshot,
  key: typeof DRINKS | typeof PASTRIES,
): MenuBoardElement {
  const sectionId = key === DRINKS ? SECTION_IDS.drinks : SECTION_IDS.pastries;
  const element = board.elements.find(
    (candidate) =>
      candidate.kind === "section" && candidate.sectionId === sectionId,
  );
  if (element === undefined) throw new Error(`No section element for ${key}`);
  return element;
}

function rowOf(
  board: MenuBoardSnapshot,
  key: typeof DRINKS | typeof PASTRIES,
): string | null {
  const element = sectionOf(board, key);
  return element.kind === "section" ? (element.row ?? null) : null;
}

/**
 * The menu draft lists two items with the same order key in the order of
 * their random IDs, in a draft edit's result and in menu_board_read; the
 * evidence lists them by name, so that it repeats.
 */
function sortDraftItems(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed)) return text;
  const byName = (items: readonly unknown[]): unknown[] =>
    [...items].sort((first, second) => nameOf(first).localeCompare(nameOf(second)));
  const draft = isRecord(parsed.draft) && Array.isArray(parsed.draft.items)
    ? { draft: { ...parsed.draft, items: byName(parsed.draft.items) } }
    : {};
  const items = Array.isArray(parsed.items) ? { items: byName(parsed.items) } : {};
  return JSON.stringify({ ...parsed, ...draft, ...items });
}

function nameOf(item: unknown): string {
  if (!isRecord(item)) return "";
  return String(item.displayName ?? item.name ?? "");
}
