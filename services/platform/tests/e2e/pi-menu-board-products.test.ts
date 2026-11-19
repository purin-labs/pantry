// Plan 40B, the Products panel: a product on a board in a look. Sous Chef puts
// taro milk tea on the menu, and the owner publishes the menu and makes a
// blank free canvas board. A viewer cannot add a product. Sous Chef adds the item
// to the board as a tile with menu_board_edit add_item; an unknown look is
// refused in words that it can act on; then it makes the product a big
// price with set_look. The owner's open board shows Sous Chef's product, and the
// next release carries the product and its look to the TV with its live
// price. The owner adds a photo to the product on the product page; the
// TV's feed, the editor's facts and the Products panel's list show it.
import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import type { MenuScreenPhoto } from "@seams/control-api";
import type { MenuBoardElement } from "@seams/menu-board-crdt";
import { isRecord } from "@seams/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  delivered,
  draftItemId,
  entryOf,
  feed,
  installBoardJourney,
  menuRevision,
  pairScreen,
  publishBoard,
  readHeaders,
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
    menuBoardProducts?: Record<string, unknown>;
  }
}

const TARO = "Taro Milk Tea";
const PHOTO_ALT = "Taro milk tea in a tall glass";
/** PNG bytes that Commerce's type check accepts. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x40]);
const TILE = { x: 200, y: 300, width: 360, height: 300 };

type Script = {
  products: ReadonlyMap<string, string>;
  boardId: string;
  taroId: string;
  elementId: string;
  outputs: string[];
  steps: number;
};

it(
  "puts a menu item on a board as a product in a look, refuses a viewer, and carries the look to the TV",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { products: new Map(), boardId: "", taroId: "", elementId: "", outputs: [], steps: 0 };
    const journey = await installBoardJourney("products", (body) => respond(script, body));
    script.products = journey.products;

    // Turn 1: Sous Chef puts taro milk tea on the menu. The owner publishes the
    // menu, makes a blank board and pairs a TV.
    await sendListingMessage("app_mention", "EvProductsMenu", ROOT_TS, "<@U0PANTRY> Put the taro milk tea under Drinks.");
    await expect.poll(delivered.bind(null, journey.slack), { timeout: 45_000 }).toContain("PD_MENU_READY");
    const published = await send(`${BASE}/commerce/menu-publication`, journey.owner, "POST", {
      documentRevision: await menuRevision(journey.owner),
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Window",
      layout: "canvas_landscape",
      start: "blank",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const token = await pairScreen(journey.owner, script.boardId);
    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const viewerPeer = await BoardPeer.open(socket, journey.viewer);
    try {
      // A viewer cannot add a product.
      const refused = await viewerPeer.submitRefused((copy) =>
        copy.addElement(product("element_viewer", script.taroId, "card")),
      );
      expect(refused).toMatchObject({ kind: "failure", code: "access_revoked" });

      // Turn 2: Sous Chef adds the product as a tile, then makes it a big price.
      await sendListingMessage(
        "message",
        "EvProductsBoard",
        "1710000500.000100",
        "Show the taro milk tea on the Window board, big, with its price.",
        ROOT_TS,
      );
      await expect.poll(delivered.bind(null, journey.slack), { timeout: 45_000 }).toContain("PD_DONE");
      await expect
        .poll(() => ownerPeer.read().elements.map((element) => [element.kind, lookOf(element)]), { timeout: 10_000 })
        .toEqual([["featured", "price"]]);
      const placed = ownerPeer.read().elements[0];
      expect(placed).toMatchObject({ kind: "featured", itemId: script.taroId, label: "", placement: { frameId: "canvas", rect: TILE } });

      // The next release carries the product, its look and its live price.
      const release = await publishBoard(journey.owner, script.boardId, null);
      const screen = await feed(token);
      expect(screen.release?.elements).toEqual(ownerPeer.read().elements);
      const entry = entryOf(screen, script.taroId);
      expect(entry?.price.amountMinor).toBeGreaterThan(0);
      expect(entry?.image ?? null).toBeNull();

      // The owner adds a photo on the product page. The TV's next feed, the
      // editor's facts and the Products panel's list name the same photo.
      const productId = script.products.get(TARO) ?? "";
      const added = await addPhoto(journey.owner, productId);
      expect(added.status, await added.clone().text()).toBe(200);
      // The shop gives photo links only on HTTPS, as production names
      // Commerce; the suite's HTTP name gets none.
      const httpBase = env.UNDERCLERK_BASE_URL;
      env.UNDERCLERK_BASE_URL = "https://underclerk.test";
      let photo: MenuScreenPhoto | null = null;
      try {
        await expect
          .poll(async () => entryOf(await feed(token), script.taroId)?.image ?? null, { timeout: 30_000, interval: 1_000 })
          .toMatchObject({ altText: PHOTO_ALT, url: expect.stringMatching(/^https:\/\/underclerk\.test\/.+\/media\/media_/u) });
        photo = entryOf(await feed(token), script.taroId)?.image ?? null;
        const editor = await send(`${BASE}/menu-boards/facts`, journey.owner, "GET");
        expect(editorPhoto(editor.body, script.taroId)).toEqual(photo);
        const options = await send(`${BASE}/commerce/menu-publication`, journey.owner, "GET");
        expect(productPhoto(options.body, productId)).toEqual(photo);
      } finally {
        env.UNDERCLERK_BASE_URL = httpBase;
      }
      task.meta.menuBoardProducts = {
        substituted: ["model provider (deterministic OpenRouter transport)", "Slack (signed events)"],
        real: ["Pantry Worker, the board room and the menu draft", "Underclerk fixture Worker", "screen feed"],
        viewerAdd: refused,
        board: ownerPeer.read().elements.map((element) => ({ kind: element.kind, look: lookOf(element), placement: element.placement })),
        release: { releaseRevision: release, look: lookOf(screen.release?.elements[0]), priced: entry !== undefined },
        photo: { altText: photo?.altText ?? null, editorFacts: "same", productsPanel: "same" },
        toolOutputs: script.outputs.map(redactIds),
      };
    } finally {
      await Promise.all([ownerPeer, viewerPeer].map((peer) => closeSocket(peer.socket)));
    }
  },
);

function product(id: string, itemId: string, look: "card"): MenuBoardElement {
  return {
    id,
    kind: "featured",
    placement: { frameId: "canvas", order: 0, rect: TILE, constraints: { horizontal: "scale", vertical: "scale" } },
    itemId: itemId.length === 0 ? "item_none" : itemId,
    label: "",
    note: "",
    look,
  };
}

/** The product page's photo upload, as the Portal sends it. */
function addPhoto(owner: Parameters<typeof send>[1], productId: string): Promise<Response> {
  const form = new FormData();
  form.set("productId", productId);
  form.set("expectedPhotoRevision", "0");
  form.set("altText", PHOTO_ALT);
  form.set("photo", new File([PNG], "photo", { type: "image/png" }));
  return exports.default.fetch(`${BASE}/commerce/products/photos/add`, {
    method: "POST",
    headers: { ...readHeaders(owner), "idempotency-key": crypto.randomUUID() },
    body: form,
  });
}

function editorPhoto(body: unknown, itemId: string): unknown {
  const entries = isRecord(body) && isRecord(body.facts) && Array.isArray(body.facts.entries) ? body.facts.entries : [];
  const entry: unknown = entries.find((candidate: unknown) => isRecord(candidate) && candidate.menuEntryId === itemId);
  return isRecord(entry) ? entry.image : undefined;
}

function productPhoto(body: unknown, productId: string): unknown {
  const products = isRecord(body) && Array.isArray(body.products) ? body.products : [];
  const product: unknown = products.find((candidate: unknown) => isRecord(candidate) && candidate.productId === productId);
  return isRecord(product) ? product.image : undefined;
}

function lookOf(element: MenuBoardElement | undefined): string | null {
  return element?.kind === "featured" ? (element.look ?? "card") : null;
}

function respond(script: Script, body: Record<string, unknown>): Response {
  script.steps += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (script.steps) {
    case 1:
      return openRouterToolCall("tool_search", { query: "menu_draft_edit", limit: 1 }, "pd_discover_draft");
    case 2:
      return openRouterToolCall("menu_draft_edit", draftEdit({ kind: "add_section", title: "Drinks" }), "pd_drinks");
    case 3:
      return openRouterToolCall(
        "menu_draft_edit",
        draftEdit({
          kind: "add_item",
          sectionId: sectionIdOf(last, "Drinks"),
          productId: script.products.get(TARO),
          title: TARO,
          description: "Nutty taro and Assam tea.",
        }),
        "pd_taro",
      );
    case 4:
      script.taroId = draftItemId(last, TARO);
      return openRouterText("PD_MENU_READY", "pd_menu_done");
    case 5:
      return openRouterToolCall("tool_search", { query: "menu_board_read menu_board_edit", limit: 8 }, "pd_discover_boards");
    case 6:
      return openRouterToolCall("menu_board_edit", boardEdit(script, { kind: "add_item", itemId: script.taroId, text: "poster" }), "pd_bad_look");
    case 7:
      expect(last).toContain("must be a look: card, row, tile, price");
      return openRouterToolCall("menu_board_edit", boardEdit(script, { kind: "add_item", itemId: script.taroId, text: "tile" }), "pd_tile");
    case 8: {
      const result: unknown = JSON.parse(last);
      const after = isRecord(result) && isRecord(result.change) && isRecord(result.change.after) ? result.change.after : null;
      script.elementId = isRecord(result) && isRecord(result.change) && typeof result.change.elementId === "string"
        ? result.change.elementId
        : isRecord(after) && typeof after.id === "string" ? after.id : "";
      expect(script.elementId).not.toBe("");
      return openRouterToolCall(
        "menu_board_edit",
        boardEdit(script, { kind: "set_look", elementId: script.elementId, frameId: null, itemId: null, text: "price", x: null, y: null, width: null, height: null }),
        "pd_price",
      );
    }
    case 9:
      return openRouterText("PD_DONE", "pd_done");
    default:
      throw new Error(`Unexpected products model request ${script.steps}`);
  }
}

function boardEdit(script: Script, fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    kind: "add_item",
    boardId: script.boardId,
    elementId: null,
    prop: null,
    before: null,
    text: null,
    title: null,
    itemId: null,
    frameId: "canvas",
    order: null,
    ...TILE,
    ...fields,
  };
}

function draftEdit(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { kind: "add_item", itemId: null, sectionId: null, productId: null, title: null, description: null, order: null, ...fields };
}

function sectionIdOf(toolText: string, title: string): string {
  const parsed: unknown = JSON.parse(toolText);
  const sections = isRecord(parsed) && isRecord(parsed.draft) && Array.isArray(parsed.draft.sections) ? parsed.draft.sections : [];
  for (const section of sections)
    if (isRecord(section) && section.title === title && typeof section.id === "string") return section.id;
  throw new Error(`No section ${title} in ${toolText}`);
}
