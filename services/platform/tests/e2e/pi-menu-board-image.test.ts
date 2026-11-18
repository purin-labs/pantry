// Plan 40B, the image element: an image of the shop's library on a board.
// The owner uploads an image to the shop's library from the board editor's
// Images panel, and a viewer's upload is refused. Sous Chef reads the shop's
// images with menu_board_read, an image that is not in the library is
// refused in words that it can act on, and Sous Chef places the image on a blank
// free canvas and sets it to fit inside its rect. The owner's editor reads
// the image under the owner's session. While only the draft names it, the
// public screen route answers 404; once the board is published, the
// release names that route and a TV loads the same bytes with no session.
import { exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import type { MenuBoardElement } from "@seams/menu-board-crdt";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { isRecord } from "@seams/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  ORIGIN,
  boardIdOf,
  delivered,
  feed,
  installBoardJourney,
  pairScreen,
  publishBoard,
  readHeaders,
  redactIds,
  send,
  toolOutput,
} from "./menu-board-journey-support";
import { sendListingMessage } from "./pi-sdk-effect-support";
import { ORGANISATION_ID, ROOT_TS, openRouterText, openRouterToolCall } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardImage?: Record<string, unknown>;
  }
}

const ALT = "Morning bake on the counter";
/** PNG bytes that Commerce's type check accepts. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x7e]);
const RECT = { x: 820, y: 120, width: 640, height: 480 };
const UNKNOWN = "media_00000000000000000000000000000000";

type Script = {
  boardId: string;
  mediaId: string;
  elementId: string;
  outputs: string[];
  steps: number;
};

it(
  "puts a library image on a board, refuses a viewer's upload and an unknown image, and carries the media address to the TV",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { boardId: "", mediaId: "", elementId: "", outputs: [], steps: 0 };
    const journey = await installBoardJourney("image", (body) => respond(script, body));

    // The owner uploads an image to the library; a viewer cannot.
    // The Platform answers a role refusal as 404, so that a viewer learns
    // nothing; the body names the refusal, not a missing route.
    const refused = await upload(journey.viewer);
    const refusal = await refused.clone().text();
    expect(refused.status, refusal).toBe(404);
    expect(refusal).toContain("organisation_");
    const uploaded = await upload(journey.owner);
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const listed = await send(`${BASE}/commerce/media`, journey.owner, "GET");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const library = imagesOf(listed.body);
    expect(library.map((image) => image.altText)).toContain(ALT);

    // The owner makes a blank board and pairs a TV.
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Window",
      layout: "canvas_landscape",
      start: "blank",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const token = await pairScreen(journey.owner, script.boardId);
    const ownerPeer = await BoardPeer.open(`${BASE}/menu-boards/${script.boardId}/socket`, journey.owner);
    try {
      // Sous Chef places the image and sets it to fit inside its rect.
      await sendListingMessage("app_mention", "EvImageBoard", ROOT_TS, "<@U0SATYR> Put the morning bake photo on the Window board.");
      await expect.poll(delivered.bind(null, journey.slack), { timeout: 45_000 }).toContain("IM_DONE");
      await expect
        .poll(() => ownerPeer.read().elements.map(imageView), { timeout: 10_000 })
        .toEqual([{ kind: "image", mediaId: script.mediaId, altText: ALT, fit: "contain", rect: RECT }]);

      // The editor reads the image under the owner's session.
      const editor = await exports.default.fetch(`${BASE}/commerce/media/content/${script.mediaId}`, {
        headers: readHeaders(journey.owner),
      });
      expect(editor.status).toBe(200);
      expect(new Uint8Array(await editor.arrayBuffer())).toEqual(PNG);

      // While only the draft names the image, a TV cannot read it.
      const screenPath = `${ORIGIN}/v1/screens/media/${encodeURIComponent(ORGANISATION_ID)}/${script.mediaId}`;
      const draftOnly = await exports.default.fetch(screenPath);
      expect(draftOnly.status).toBe(404);

      // The release names the screen route; a TV loads the same bytes.
      const release = await publishBoard(journey.owner, script.boardId, null);
      const screen = await feed(token);
      expect(screen.release?.elements).toEqual(ownerPeer.read().elements);
      const mediaBase = screen.release?.mediaBase ?? "";
      expect(`${ORIGIN}${mediaBase}${script.mediaId}`).toBe(screenPath);
      const bytes = await exports.default.fetch(screenPath);
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get("cache-control")).toBe("public, max-age=300");
      expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG);
      // Another image of the library stays private.
      const other = await exports.default.fetch(`${ORIGIN}/v1/screens/media/${encodeURIComponent(ORGANISATION_ID)}/${UNKNOWN}`);
      expect(other.status).toBe(404);
      task.meta.menuBoardImage = {
        substituted: ["model provider (deterministic OpenRouter transport)", "Slack (signed events)"],
        real: ["Satyr Worker, the board room, the media routes and the screen media route", "Underclerk fixture Worker with its R2 store", "screen feed"],
        viewerUpload: { status: refused.status, body: JSON.parse(refusal) as unknown },
        library: library.filter((image) => image.altText === ALT).map((image) => ({ altText: image.altText, url: image.url !== null })),
        board: ownerPeer.read().elements.map((element) => ({ ...imageView(element), mediaId: "media_…" })),
        editorRead: editor.status,
        screenBeforePublish: draftOnly.status,
        release: { releaseRevision: release, mediaBase: mediaBase.replace(ORGANISATION_ID, "organisation_…"), bytes: bytes.status, otherImage: other.status },
        toolOutputs: script.outputs.map((text) => redactIds(text).replace(/media_[0-9a-f]{32}/gu, "media_…").replace(/"observedAt":\d+/gu, '"observedAt":…')),
      };
    } finally {
      await closeSocket(ownerPeer.socket);
    }
  },
);

function upload(session: IssuedControlSession): Promise<Response> {
  const form = new FormData();
  form.set("altText", ALT);
  form.set("photo", new File([PNG], "photo", { type: "image/png" }));
  return exports.default.fetch(`${BASE}/commerce/media/add`, {
    method: "POST",
    headers: { ...readHeaders(session), "idempotency-key": crypto.randomUUID() },
    body: form,
  });
}

function imagesOf(body: unknown): Readonly<{ mediaId: string; altText: string; url: string | null }>[] {
  const images = isRecord(body) && Array.isArray(body.images) ? body.images : [];
  return images.flatMap((image: unknown) =>
    isRecord(image) && typeof image.mediaId === "string" && typeof image.altText === "string"
      ? [{ mediaId: image.mediaId, altText: image.altText, url: typeof image.url === "string" ? image.url : null }]
      : []);
}

function imageView(element: MenuBoardElement): Record<string, unknown> {
  return element.kind === "image"
    ? {
        kind: element.kind,
        mediaId: element.mediaId,
        altText: element.altText,
        fit: element.fit,
        rect: element.placement.frameId === "canvas" ? element.placement.rect : null,
      }
    : { kind: element.kind };
}

function respond(script: Script, body: Record<string, unknown>): Response {
  script.steps += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (script.steps) {
    case 1:
      return openRouterToolCall("tool_search", { query: "menu_board_read menu_board_edit", limit: 8 }, "im_discover");
    case 2:
      return openRouterToolCall("menu_board_read", { boardId: script.boardId }, "im_read");
    case 3: {
      const read: unknown = JSON.parse(last);
      const images = isRecord(read) && Array.isArray(read.images) ? read.images : [];
      const found: unknown = images.find((image: unknown) => isRecord(image) && image.altText === ALT);
      script.mediaId = isRecord(found) && typeof found.mediaId === "string" ? found.mediaId : "";
      expect(script.mediaId).toMatch(/^media_[0-9a-f]{32}$/u);
      return openRouterToolCall("menu_board_edit", edit(script, { kind: "add_image", itemId: UNKNOWN, text: ALT, ...RECT }), "im_unknown");
    }
    case 4:
      expect(last).toContain("That image is not in the shop's library");
      return openRouterToolCall("menu_board_edit", edit(script, { kind: "add_image", itemId: script.mediaId, text: ALT, ...RECT }), "im_add");
    case 5: {
      const result: unknown = JSON.parse(last);
      const change = isRecord(result) && isRecord(result.change) ? result.change : null;
      script.elementId = change !== null && typeof change.elementId === "string" ? change.elementId : "";
      expect(script.elementId).not.toBe("");
      return openRouterToolCall("menu_board_edit", edit(script, { kind: "set_fit", elementId: script.elementId, text: "contain" }), "im_fit");
    }
    case 6:
      return openRouterText("IM_DONE", "im_done");
    default:
      throw new Error(`Unexpected image model request ${script.steps}`);
  }
}

function edit(script: Script, fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    kind: "add_image",
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
