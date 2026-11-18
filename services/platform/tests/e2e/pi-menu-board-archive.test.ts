// Plan 40B, board removal: an owner or admin archives a board and deletes a
// library image, and Sous Chef archives and restores a board with the person's own
// checks. A board that a screen shows cannot be archived, by Sous Chef or by a
// person. An image that a board shows cannot be deleted, also while that
// board is archived, and the answer names the board. Staff and viewers are
// refused. An archived board leaves the board list and its published image
// stops being public; a restore brings back the board, its release and the
// public image. An image that no board shows is deleted for good.
import { exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  BASE,
  ORIGIN,
  boardIdOf,
  delivered,
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
    menuBoardArchive?: Record<string, unknown>;
  }
}

const ALT = "Window bake";
const SPARE = "Spare photo";
/** PNG bytes that Commerce's type check accepts. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]);
const SPARE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);
const RECT = { x: 120, y: 120, width: 640, height: 480 };

type Script = {
  boardId: string;
  mediaId: string;
  outputs: string[];
  steps: number;
};

it(
  "archives and restores a board with the person's checks, and deletes only a library image that no board shows",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { boardId: "", mediaId: "", outputs: [], steps: 0 };
    const journey = await installBoardJourney("archive", (body) => respond(script, body));

    // The owner uploads two images, makes a blank board and pairs a TV.
    expect((await upload(journey.owner, ALT, PNG)).status).toBe(200);
    expect((await upload(journey.owner, SPARE, SPARE_PNG)).status).toBe(200);
    const library = await images(journey.owner);
    const spareId = library.find((image) => image.altText === SPARE)?.mediaId ?? "";
    expect(spareId).toMatch(/^media_[0-9a-f]{32}$/u);
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Window",
      layout: "canvas_landscape",
      start: "blank",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    await pairScreen(journey.owner, script.boardId);

    // Turn 1: Sous Chef puts the image on the board. Its archive is refused while
    // the TV shows the board.
    await sendListingMessage("app_mention", "EvArchiveOne", ROOT_TS, "<@U0SATYR> Put the window bake photo on the Window board, then archive the board.");
    await expect.poll(delivered.bind(null, journey.slack), { timeout: 45_000 }).toContain("IA_ON_SCREEN");
    expect(script.outputs.at(-1)).toContain("A screen shows this board");
    expect((await boardList(journey.owner)).boards).toEqual(["Window"]);

    // The owner publishes, so the TV may read the image.
    await publishBoard(journey.owner, script.boardId, null);
    const screenImage = `${ORIGIN}/v1/screens/media/${encodeURIComponent(ORGANISATION_ID)}/${script.mediaId}`;
    expect((await exports.default.fetch(screenImage)).status).toBe(200);

    // A person's archive is refused for the same reason; staff and a viewer
    // may not archive at all, and nobody deletes an image that a board shows.
    const onScreen = await archive(journey.owner, script.boardId, true);
    expect(onScreen.status, JSON.stringify(onScreen.body)).toBe(409);
    for (const person of [journey.staff, journey.viewer]) {
      const refused = await archive(person, script.boardId, true);
      expect(refused.status, JSON.stringify(refused.body)).toBe(404);
      expect(JSON.stringify(refused.body)).toContain("organisation_");
    }
    const shown = await deleteImage(journey.owner, script.mediaId);
    expect(shown.status, JSON.stringify(shown.body)).toBe(409);
    expect(shown.body).toMatchObject({ error: "media_on_board", boards: ["Window"] });

    // The owner shows nothing on the TV any more: the pairing ends.
    const screens = await send(`${BASE}/menu-screens`, journey.owner, "GET");
    const screenId = isRecord(screens.body) && Array.isArray(screens.body.screens) && isRecord(screens.body.screens[0])
      ? String(screens.body.screens[0].screenId)
      : "";
    expect((await send(`${BASE}/menu-screens/${screenId}`, journey.owner, "DELETE")).status).toBe(200);

    // Turn 2: Sous Chef archives the board and lists it as archived.
    await sendListingMessage("message", "EvArchiveTwo", "1710000300.000100", "Now archive the Window board.", ROOT_TS);
    await expect.poll(delivered.bind(null, journey.slack), { timeout: 45_000 }).toContain("IA_ARCHIVED");
    const afterArchive = await boardList(journey.owner);
    expect(afterArchive).toEqual({ boards: [], archived: ["Window"] });
    // The archived board's image is private again, and it still keeps the
    // image from deletion: a restore must find it.
    expect((await exports.default.fetch(screenImage)).status).toBe(404);
    const archivedShown = await deleteImage(journey.owner, script.mediaId);
    expect(archivedShown.status, JSON.stringify(archivedShown.body)).toBe(409);
    expect(archivedShown.body).toMatchObject({ boards: ["Window (archived)"] });
    // An archived board takes no new screen.
    const pairingStarted = await exports.default.fetch(`${ORIGIN}/v1/screens/pairings`, { method: "POST" });
    const pairing: unknown = await pairingStarted.json();
    const code = isRecord(pairing) && typeof pairing.code === "string" ? pairing.code : "";
    const repaired = await send(`${BASE}/menu-screens`, journey.owner, "POST", { code, name: "Counter TV", boardId: script.boardId });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(404);

    // The owner restores it: the board, its release and the public image
    // come back.
    const restored = await archive(journey.owner, script.boardId, false);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await boardList(journey.owner)).toEqual({ boards: ["Window"], archived: [] });
    expect((await exports.default.fetch(screenImage)).status).toBe(200);
    const board = await send(`${BASE}/menu-boards`, journey.owner, "GET");
    const release = isRecord(board.body) && Array.isArray(board.body.boards) && isRecord(board.body.boards[0])
      ? board.body.boards[0].release
      : null;
    expect(release).toMatchObject({ releaseRevision: 1 });

    // An image that no board shows: staff may not delete it, the owner may,
    // and then it is gone from the library for good.
    const staffDelete = await deleteImage(journey.staff, spareId);
    expect(staffDelete.status, JSON.stringify(staffDelete.body)).toBe(404);
    const spareDeleted = await deleteImage(journey.owner, spareId);
    expect(spareDeleted.status, JSON.stringify(spareDeleted.body)).toBe(200);
    expect((await images(journey.owner)).map((image) => image.altText)).toEqual([ALT]);
    expect((await deleteImage(journey.owner, spareId)).status).toBe(404);

    task.meta.menuBoardArchive = {
      substituted: ["model provider (deterministic OpenRouter transport)", "Slack (signed events)"],
      real: ["Satyr Worker, the Organisation Actor's boards and screens, the media routes", "Underclerk fixture Worker with its R2 store"],
      agentOnScreen: redactIds(script.outputs.find((text) => text.includes("A screen shows this board")) ?? ""),
      agentArchived: redactIds(script.outputs.find((text) => text.includes('"archived":true')) ?? "")
        .replace(/"archivedAt":\d+/gu, '"archivedAt":…'),
      personOnScreen: onScreen.body,
      staffArchive: 404,
      viewerArchive: 404,
      imageOnBoard: shown.body,
      imageOnArchivedBoard: archivedShown.body,
      afterArchive,
      screenImage: { published: 200, archived: 404, restored: 200 },
      archivedBoardPairing: repaired.status,
      restoredRelease: isRecord(release) ? { ...release, publishedAt: "…" } : release,
      spareImage: { staff: staffDelete.status, owner: spareDeleted.status, again: 404 },
    };
  },
);

async function archive(session: IssuedControlSession, boardId: string, archived: boolean) {
  return send(`${BASE}/menu-boards/${boardId}/archive`, session, "POST", { archived });
}

function deleteImage(session: IssuedControlSession, mediaId: string) {
  return send(`${BASE}/commerce/media/delete`, session, "POST", { mediaId });
}

async function boardList(session: IssuedControlSession): Promise<Readonly<{ boards: string[]; archived: string[] }>> {
  const listed = await send(`${BASE}/menu-boards`, session, "GET");
  const titles = (key: string): string[] =>
    isRecord(listed.body) && Array.isArray(listed.body[key])
      ? listed.body[key].flatMap((board: unknown) => (isRecord(board) && typeof board.title === "string" ? [board.title] : []))
      : [];
  return { boards: titles("boards"), archived: titles("archivedBoards") };
}

function upload(session: IssuedControlSession, altText: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.set("altText", altText);
  form.set("photo", new File([bytes], "photo", { type: "image/png" }));
  return exports.default.fetch(`${BASE}/commerce/media/add`, {
    method: "POST",
    headers: { ...readHeaders(session), "idempotency-key": crypto.randomUUID() },
    body: form,
  });
}

async function images(session: IssuedControlSession): Promise<Readonly<{ mediaId: string; altText: string }>[]> {
  const listed = await send(`${BASE}/commerce/media`, session, "GET");
  const items = isRecord(listed.body) && Array.isArray(listed.body.images) ? listed.body.images : [];
  return items.flatMap((image: unknown) =>
    isRecord(image) && typeof image.mediaId === "string" && typeof image.altText === "string"
      ? [{ mediaId: image.mediaId, altText: image.altText }]
      : []);
}

function respond(script: Script, body: Record<string, unknown>): Response {
  script.steps += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (script.steps) {
    case 1:
      return openRouterToolCall("tool_search", { query: "menu_board_read menu_board_edit menu_board_archive", limit: 10 }, "ia_discover");
    case 2:
      return openRouterToolCall("menu_board_read", { boardId: script.boardId }, "ia_read");
    case 3: {
      const read: unknown = JSON.parse(last);
      const found: unknown = isRecord(read) && Array.isArray(read.images)
        ? read.images.find((image: unknown) => isRecord(image) && image.altText === ALT)
        : undefined;
      script.mediaId = isRecord(found) && typeof found.mediaId === "string" ? found.mediaId : "";
      expect(script.mediaId).toMatch(/^media_[0-9a-f]{32}$/u);
      return openRouterToolCall("menu_board_edit", {
        kind: "add_image",
        boardId: script.boardId,
        elementId: null,
        prop: null,
        before: null,
        text: ALT,
        title: null,
        itemId: script.mediaId,
        frameId: null,
        order: null,
        ...RECT,
      }, "ia_add");
    }
    case 4:
      return openRouterToolCall("menu_board_archive", { boardId: script.boardId, archived: true }, "ia_archive_refused");
    case 5:
      return openRouterText("IA_ON_SCREEN", "ia_on_screen");
    case 6:
      return openRouterToolCall("menu_board_archive", { boardId: script.boardId, archived: true }, "ia_archive");
    case 7:
      return openRouterToolCall("menu_board_read", { boardId: null }, "ia_list");
    case 8: {
      const read: unknown = JSON.parse(last);
      expect(isRecord(read) && Array.isArray(read.boards) ? read.boards : null).toEqual([]);
      expect(JSON.stringify(isRecord(read) ? read.archivedBoards : null)).toContain("Window");
      return openRouterText("IA_ARCHIVED", "ia_archived");
    }
    default:
      throw new Error(`Unexpected archive model request ${script.steps}`);
  }
}
