// Plan 40B phase 5, acceptance journey 4 ("Together"). Two people and Sous Chef edit
// one free-canvas board at the same time, and all three converge. The owner
// and a member of staff hold the board open. From the same state they change
// different elements, and both move the order QR code at the same moment.
// While their sockets stay open, Sous Chef reads the boards, retitles the heading,
// moves the featured card on the canvas and proposes a new price for an item
// that only the published menu holds (the menu draft dropped it). A viewer's
// edit is refused. Every replica and the stored board end the same, with one
// QR placement. Nothing reaches the TV and no price moves until people act:
// the owner publishes the merged board, the TV plays it on a canvas layout,
// and only the owner's approval changes the price.
import { expect, it, type TestContext } from "vitest";
import {
  type MenuBoardElement,
  type MenuBoardSnapshot,
} from "@purin-labs/menu-board-crdt";
import { isRecord } from "@purin-labs/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  actionState,
  boardIdOf,
  click,
  delivered,
  draftItemId,
  dropFromDraft,
  entryOf,
  feed,
  installBoardJourney,
  menuRevision,
  offer,
  pairScreen,
  publishBoard,
  redactIds,
  send,
  toolOutput,
} from "./menu-board-journey-support";
import {
  OWNER,
  listingNonce,
  postControl,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ROOT_TS,
  isApprovalCard,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardTogether?: Record<string, unknown>;
  }
}

const SECTION = "section_main";
const TARO = "Taro Milk Tea";
const MATCHA = "Matcha Tea";
const MERCHANT_AGENT_TITLE = "Made together";
const STAFF_LABEL = "Staff pick";
const MERCHANT_AGENT_FEATURED_RECT = {
  x: 1072,
  y: 600,
  width: 480,
  height: 200,
};
const OWNER_HEADING_RECT = { x: 48, y: 24, width: 1504, height: 140 };
const OWNER_QR_RECT = { x: 64, y: 664, width: 400, height: 200 };
const STAFF_QR_RECT = { x: 1136, y: 40, width: 416, height: 192 };

type Script = {
  productIds: Record<string, string>;
  itemIds: Record<string, string>;
  boardId: string;
  headingId: string;
  headingTitle: string;
  featuredId: string;
  outputs: string[];
};

it(
  "lets two people and Urk edit one free-canvas board at once, converge on one board, and keep Urk's price waiting for the owner",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const requests: Record<string, unknown>[] = [];
    const script: Script = {
      productIds: {},
      itemIds: {},
      boardId: "",
      headingId: "",
      headingTitle: "",
      featuredId: "",
      outputs: [],
    };
    const { owner, staff, viewer, slack, answers, products } =
      await installBoardJourney("together", (body) =>
        respond(requests, script, body),
      );
    for (const title of [TARO, MATCHA]) {
      const productId = products.get(title);
      if (productId === undefined) throw new Error(`No product ${title}`);
      script.productIds[title] = productId;
    }

    // Turn 1: Sous Chef puts two drinks on the menu draft. The owner publishes the
    // menu, then staff drop the matcha from the draft: it stays on the
    // published menu only, as on a shop whose draft and menu differ.
    await sendListingMessage(
      "app_mention",
      "EvTogetherItems",
      ROOT_TS,
      "<@U0PANTRY> Put the taro milk tea and the matcha tea on the menu.",
    );
    await expect
      .poll(delivered.bind(null, slack), { timeout: 30_000 })
      .toContain("TG_ITEMS_IN_DRAFT");
    const menuPublished = await send(
      `${BASE}/commerce/menu-publication`,
      owner,
      "POST",
      { documentRevision: await menuRevision(owner) },
    );
    expect(menuPublished.status, JSON.stringify(menuPublished.body)).toBe(200);
    const matchaId = script.itemIds[MATCHA] ?? "";
    await dropFromDraft(staff, matchaId);

    // The owner makes a free-canvas board for a landscape TV. Its template
    // places every element on the canvas with a rect and constraints.
    const created = await send(`${BASE}/menu-boards`, owner, "POST", {
      title: "Drinks",
      layout: "canvas_landscape",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const boardSocket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(boardSocket, owner);
    const staffPeer = await BoardPeer.open(boardSocket, staff);
    const viewerPeer = await BoardPeer.open(boardSocket, viewer);
    try {
      expect(ownerPeer.access).toBe("edit");
      expect(staffPeer.access).toBe("edit");
      expect(viewerPeer.access).toBe("read");
      const template = ownerPeer.read();
      expect(template.layout).toBe("canvas_landscape");
      expect(template.unplaced).toEqual([]);
      expect(
        template.elements.every(
          (element) => element.placement.frameId === "canvas",
        ),
      ).toBe(true);
      const heading = elementOf(template, "heading");
      const featured = elementOf(template, "featured");
      const qr = elementOf(template, "order_qr");
      script.headingId = heading.id;
      script.featuredId = featured.id;
      script.headingTitle = heading.kind === "heading" ? heading.title : "";

      // Both people edit from the same state at the same moment. The owner
      // widens the heading and moves the QR code to the bottom left; staff
      // relabel the featured card and move the QR code to the top right.
      const [ownerAccepted, staffAccepted] = await Promise.all([
        ownerPeer.submit(
          "owner-move",
          ownerPeer.doc.placeElements([
            {
              elementId: heading.id,
              placement: canvasAt(heading, OWNER_HEADING_RECT),
            },
            { elementId: qr.id, placement: canvasAt(qr, OWNER_QR_RECT) },
          ]),
        ),
        staffPeer
          .submit(
            "staff-edit",
            staffPeer.doc.updateElement(featured.id, { label: STAFF_LABEL }),
          )
          .then(() =>
            staffPeer.submit(
              "staff-move",
              staffPeer.doc.moveElement(qr.id, canvasAt(qr, STAFF_QR_RECT)),
            ),
          ),
      ]);
      expect(ownerAccepted.kind).toBe("update_accepted");
      expect(staffAccepted.kind).toBe("update_accepted");

      // A viewer sees the board but cannot change it.
      const refused = await viewerPeer.submitRefused(featured.id);
      expect(refused).toMatchObject({
        kind: "failure",
        code: "access_revoked",
      });

      // Turn 2, with both editors still open: Sous Chef reads the boards, edits
      // the canvas, and proposes a price for the matcha, which only the
      // published menu holds.
      await sendListingMessage(
        "message",
        "EvTogetherCanvas",
        "1710000300.000100",
        `Call the board ${MERCHANT_AGENT_TITLE}, move the featured card to the bottom right, and propose the matcha tea at ¥550.`,
        ROOT_TS,
      );
      await expect
        .poll(delivered.bind(null, slack), { timeout: 45_000 })
        .toContain("TG_PRICE_WAITING");

      // All three converge: both open replicas and a fresh read of the
      // stored board are the same board, with one placement of the QR code.
      await expect
        .poll(() => headingTitleOf(ownerPeer.read()), { timeout: 15_000 })
        .toBe(MERCHANT_AGENT_TITLE);
      await expect
        .poll(() => headingTitleOf(staffPeer.read()), { timeout: 15_000 })
        .toBe(MERCHANT_AGENT_TITLE);
      const stored = await BoardPeer.open(boardSocket, owner);
      const merged = stored.read();
      await closeSocket(stored.socket);
      expect(ownerPeer.read()).toEqual(merged);
      expect(staffPeer.read()).toEqual(merged);
      expect(rectOf(merged, heading.id)).toEqual(OWNER_HEADING_RECT);
      expect(rectOf(merged, featured.id)).toEqual(MERCHANT_AGENT_FEATURED_RECT);
      const mergedFeatured = elementOf(merged, "featured");
      expect(mergedFeatured.kind === "featured" && mergedFeatured.label).toBe(
        STAFF_LABEL,
      );
      const qrRect = rectOf(merged, qr.id);
      expect([OWNER_QR_RECT, STAFF_QR_RECT]).toContainEqual(qrRect);

      // Sous Chef's price waits for the owner: the card is up, the offer keeps its
      // price, and an execution before the approval is refused.
      const card = slack.messages.find(isApprovalCard);
      if (card === undefined) throw new Error("No approval card");
      expect(card.text).toContain(`Change the price of ${MATCHA}`);
      const nonce = listingNonce(requests);
      expect(await actionState(nonce)).toBe("proposed");
      const priceBefore = (await offer(matchaId)).price.amountMinor;
      expect(priceBefore).not.toBe(550);
      const early = await postControl(
        owner,
        `/${nonce}/execute`,
        {},
        "tg-early",
      );
      expect(early.status).toBe(409);

      // The owner publishes the merged board; a TV plays it as one release.
      const token = await pairScreen(owner, script.boardId);
      const unpublished = await feed(token);
      expect(unpublished.release).toBeNull();
      const releaseRevision = await publishBoard(owner, script.boardId, null);
      const published = await feed(token);
      expect(published.release?.releaseRevision).toBe(releaseRevision);
      expect(published.release?.layout).toBe("canvas_landscape");
      expect(published.release?.elements).toEqual(merged.elements);

      // Only the owner's approval moves the price; the TV reads it live.
      await click(nonce, card.ts ?? "");
      await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
      expect(answers[0]?.text).toContain("Seams Pantry made the change.");
      expect(await actionState(nonce)).toBe("confirmed");
      expect((await offer(matchaId)).price.amountMinor).toBe(550);
      await expect
        .poll(
          async () => entryOf(await feed(token), matchaId)?.price.amountMinor,
          { timeout: 15_000, interval: 500 },
        )
        .toBe(550);
      const after = await feed(token);
      expect(after.release?.releaseRevision).toBe(releaseRevision);

      task.meta.menuBoardTogether = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events, interaction payloads and response URLs)",
        ],
        real: [
          "Pantry Worker and the board room",
          "Commerce fixture Worker",
          "screen feed",
        ],
        template: canvasSummary(template),
        merged: canvasSummary(merged, qr.id),
        // Yjs keeps one of the two moves; which one depends on the replicas'
        // random client IDs, so the evidence names no winner.
        qrIsOneOfTheTwo:
          sameRect(qrRect, OWNER_QR_RECT) || sameRect(qrRect, STAFF_QR_RECT),
        viewerRefusal: refused,
        toolOutputs: script.outputs.map((output) =>
          [OWNER_QR_RECT, STAFF_QR_RECT].reduce(
            (text, rect) =>
              text.replaceAll(JSON.stringify(rect), '"contested"'),
            redactIds(output),
          ),
        ),
        price: {
          before: priceBefore,
          waiting: priceBefore,
          afterApproval: 550,
        },
        release: {
          revision: releaseRevision,
          layout: published.release?.layout,
          elements: published.release?.elements.length,
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

async function respond(
  requests: Record<string, unknown>[],
  script: Script,
  body: Record<string, unknown>,
): Promise<Response> {
  requests.push(body);
  const step = requests.length;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (step) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_edit", limit: 1 },
        "tg_discover_draft",
      );
    case 2:
      return openRouterToolCall(
        "menu_draft_edit",
        addItem(script, TARO),
        "tg_add_taro",
      );
    case 3:
      script.itemIds[TARO] = draftItemId(last, TARO);
      return openRouterToolCall(
        "menu_draft_edit",
        addItem(script, MATCHA),
        "tg_add_matcha",
      );
    case 4:
      script.itemIds[MATCHA] = draftItemId(last, MATCHA);
      return openRouterText("TG_ITEMS_IN_DRAFT", "tg_items_done");
    case 5:
      return openRouterToolCall(
        "tool_search",
        {
          query: "menu_board_read menu_board_edit menu_board_propose_price",
          limit: 3,
        },
        "tg_discover_boards",
      );
    case 6:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: null },
        "tg_read",
      );
    case 7: {
      const read: unknown = JSON.parse(last);
      if (
        !isRecord(read) ||
        !Array.isArray(read.items) ||
        !Array.isArray(read.boards)
      )
        throw new Error(`No board read: ${last}`);
      // The matcha left the draft but stays on the published menu, so the
      // read still names it, with its price, for a proposal.
      expect(read.items).toContainEqual(
        expect.objectContaining({
          itemId: script.itemIds[MATCHA],
          name: MATCHA,
          sectionId: null,
          onPublishedMenu: true,
        }),
      );
      const board: unknown = read.boards[0];
      expect(board).toMatchObject({ layout: "canvas_landscape" });
      return openRouterToolCall(
        "menu_board_edit",
        boardEdit(script, {
          kind: "set_text",
          elementId: script.headingId,
          prop: "title",
          before: script.headingTitle,
          text: MERCHANT_AGENT_TITLE,
        }),
        "tg_title",
      );
    }
    case 8:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { kind: "heading", title: MERCHANT_AGENT_TITLE } },
      });
      return openRouterToolCall(
        "menu_board_edit",
        boardEdit(script, {
          kind: "place_on_canvas",
          elementId: script.featuredId,
          ...MERCHANT_AGENT_FEATURED_RECT,
        }),
        "tg_place",
      );
    case 9:
      expect(JSON.parse(last)).toMatchObject({
        change: {
          after: {
            kind: "featured",
            placement: {
              frameId: "canvas",
              rect: MERCHANT_AGENT_FEATURED_RECT,
            },
          },
        },
      });
      return openRouterToolCall(
        "menu_board_propose_price",
        { itemId: script.itemIds[MATCHA], priceMinor: 550, deal: false },
        "tg_price",
      );
    case 10:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("TG_PRICE_WAITING", "tg_waiting");
    default:
      throw new Error(`Unexpected board model request ${step}`);
  }
}

function addItem(script: Script, title: string): Record<string, unknown> {
  return {
    kind: "add_item",
    itemId: null,
    sectionId: SECTION,
    productId: script.productIds[title],
    title,
    description: "",
    order: null,
  };
}

function boardEdit(
  script: Script,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    boardId: script.boardId,
    elementId: null,
    prop: null,
    before: null,
    text: null,
    title: null,
    itemId: null,
    frameId: null,
    order: null,
    x: null,
    y: null,
    width: null,
    height: null,
    ...fields,
  };
}

function canvasAt(
  element: MenuBoardElement,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
): MenuBoardElement["placement"] {
  if (element.placement.frameId !== "canvas")
    throw new Error(`${element.id} is not on the canvas`);
  return { ...element.placement, rect };
}

function elementOf(
  board: MenuBoardSnapshot,
  kind: MenuBoardElement["kind"],
): MenuBoardElement {
  const element = board.elements.find((candidate) => candidate.kind === kind);
  if (element === undefined) throw new Error(`No ${kind} on the board`);
  return element;
}

function rectOf(board: MenuBoardSnapshot, elementId: string): unknown {
  const element = board.elements.find(
    (candidate) => candidate.id === elementId,
  );
  return element?.placement.frameId === "canvas"
    ? element.placement.rect
    : null;
}

function headingTitleOf(board: MenuBoardSnapshot): string | null {
  const heading = board.elements.find((element) => element.kind === "heading");
  return heading?.kind === "heading" ? heading.title : null;
}

function sameRect(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** The board without generated IDs, for a repeatable evidence file. */
function canvasSummary(
  board: MenuBoardSnapshot,
  contestedId: string | null = null,
): unknown {
  return {
    layout: board.layout,
    elements: board.elements
      .filter((element) => element.id !== contestedId)
      .map((element) => ({
        kind: element.kind,
        placement: element.placement,
        ...(element.kind === "heading" ? { title: element.title } : {}),
        ...(element.kind === "featured" ? { label: element.label } : {}),
      })),
  };
}

void OWNER;
