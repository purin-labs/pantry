// Plan 40B phase 5, slice 7: version history with restore. A board keeps a
// version when it is made, when the owner names one and when it is
// published. Later, the owner and staff change the open board, and staff
// remove the heading, which has a comment. A viewer reads the history but
// cannot restore. The owner restores the named version while both editors
// are open: both replicas converge on it at once, the comment is on the
// board again, and a repeated restore changes nothing. The TV keeps its
// release. Sous Chef reads the history, an unknown version is refused in words
// that it can act on, and it undoes the owner's restore by restoring the
// version that the restore saved. The next release carries the result.
import { expect, it, type TestContext } from "vitest";
import type {
  MenuBoardCommentThread,
  MenuBoardVersionSummary,
} from "@purin-labs/control-api";
import type {
  MenuBoardElement,
  MenuBoardPlacement,
  MenuBoardSnapshot,
} from "@purin-labs/menu-board-crdt";
import { isRecord } from "@purin-labs/std";
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
    menuBoardHistory?: Record<string, unknown>;
  }
}

const MORNING_QR: MenuBoardPlacement = {
  frameId: "canvas",
  order: 5,
  rect: { x: 96, y: 600, width: 400, height: 220 },
  constraints: { horizontal: "left", vertical: "bottom" },
};

type Script = {
  boardId: string;
  beforeRestoreId: string;
  outputs: string[];
  steps: number;
};

it(
  "keeps a board's versions, restores one into the open editors as one edit, and lets Urk undo the restore",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = {
      boardId: "",
      beforeRestoreId: "",
      outputs: [],
      steps: 0,
    };
    const journey = await installBoardJourney("history", (body) =>
      respond(script, body),
    );
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Counter",
      layout: "canvas_landscape",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const versionsPath = `${BASE}/menu-boards/${script.boardId}/versions`;
    const commentsPath = `${BASE}/menu-boards/${script.boardId}/comments`;
    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    expect(kinds((await send(versionsPath, journey.owner, "GET")).body)).toEqual([
      "created",
    ]);
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const staffPeer = await BoardPeer.open(socket, journey.staff);
    try {
      const heading = elementOf(ownerPeer.read(), "heading");
      const qr = elementOf(ownerPeer.read(), "order_qr");

      // The morning look: a new title and the QR code on the left. The owner
      // names that version.
      await ownerPeer.submit("morning-title", ownerPeer.doc.updateElement(heading.id, { title: "Morning" }));
      await ownerPeer.submit("morning-qr", ownerPeer.doc.moveElement(qr.id, MORNING_QR));
      await expect.poll(() => staffPeer.read(), { timeout: 10_000 }).toEqual(ownerPeer.read());
      const morning = ownerPeer.read();
      const named = await send(versionsPath, journey.owner, "POST", {
        label: "Morning look",
        operationId: "morning-look",
      });
      expect(named.status, JSON.stringify(named.body)).toBe(201);
      const morningId = versionsOf(named.body).find((version) => version.label === "Morning look")?.versionId ?? "";

      // Later changes: a new title, a text from staff, a comment on the
      // heading, and staff remove the heading.
      await ownerPeer.submit("lunch-title", ownerPeer.doc.updateElement(heading.id, { title: "Lunch" }));
      await staffPeer.submit(
        "staff-soup",
        staffPeer.doc.addElement({
          id: "element_soup",
          kind: "text",
          placement: {
            frameId: "canvas",
            order: 9,
            rect: { x: 600, y: 300, width: 400, height: 120 },
            constraints: { horizontal: "scale", vertical: "scale" },
          },
          text: "Soup of the day",
        }),
      );
      const note = await send(commentsPath, journey.owner, "POST", {
        elementId: heading.id,
        threadId: null,
        body: "Keep the morning title?",
        operationId: "heading-note",
      });
      expect(note.status).toBe(201);
      await staffPeer.submit("staff-remove", staffPeer.doc.removeElement(heading.id));
      await expect.poll(() => ownerPeer.read(), { timeout: 10_000 }).toEqual(staffPeer.read());
      const lunch = ownerPeer.read();
      expect(lunch.elements.map((element) => element.id)).not.toContain(heading.id);
      expect(onBoard(await send(commentsPath, journey.owner, "GET"))).toEqual([false]);

      // The owner publishes the lunch board to a TV.
      const token = await pairScreen(journey.owner, script.boardId);
      const first = await publishBoard(journey.owner, script.boardId, null);
      expect(kinds((await send(versionsPath, journey.owner, "GET")).body)).toEqual([
        "published",
        "named",
        "created",
      ]);

      // A viewer reads the history but cannot restore.
      const viewerRead = await send(versionsPath, journey.viewer, "GET");
      expect(viewerRead.status).toBe(200);
      const viewerRestore = await send(
        `${versionsPath}/${morningId}/restore`,
        journey.viewer,
        "POST",
        { operationId: "viewer-restore" },
      );
      expect(viewerRestore.status).toBe(404);
      expect(viewerRestore.body).toMatchObject({ error: "organisation_role_insufficient" });

      // The owner restores the morning look into both open editors.
      const restored = await send(
        `${versionsPath}/${morningId}/restore`,
        journey.owner,
        "POST",
        { operationId: "owner-restore" },
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      await expect.poll(() => staffPeer.read(), { timeout: 10_000 }).toEqual(morning);
      await expect.poll(() => ownerPeer.read(), { timeout: 10_000 }).toEqual(morning);
      const stored = await BoardPeer.open(socket, journey.owner);
      expect(stored.read()).toEqual(morning);
      await closeSocket(stored.socket);
      expect(onBoard(await send(commentsPath, journey.owner, "GET"))).toEqual([true]);
      const afterRestore = versionsOf(restored.body);
      expect(afterRestore.map((version) => version.kind)).toEqual([
        "before_restore",
        "published",
        "named",
        "created",
      ]);
      script.beforeRestoreId = afterRestore[0]?.versionId ?? "";
      const again = await send(
        `${versionsPath}/${morningId}/restore`,
        journey.owner,
        "POST",
        { operationId: "owner-restore" },
      );
      expect(versionsOf(again.body)).toHaveLength(4);
      expect(staffPeer.read()).toEqual(morning);
      // The TV keeps the lunch release until a person publishes.
      expect((await feed(token)).release?.releaseRevision).toBe(first);
      expect((await feed(token)).release?.elements.map((element) => element.id)).toEqual(
        lunch.elements.map((element) => element.id),
      );

      // Sous Chef undoes the owner's restore.
      await sendListingMessage(
        "app_mention",
        "EvHistoryUrk",
        ROOT_TS,
        "<@U0PANTRY> Undo the restore on the Counter board, then name that version Lunch plan.",
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("HS_DONE");
      await expect.poll(() => staffPeer.read(), { timeout: 10_000 }).toEqual(lunch);
      expect(ownerPeer.read()).toEqual(lunch);
      const history = versionsOf((await send(versionsPath, journey.owner, "GET")).body);
      expect(history.map((version) => [version.kind, version.label])).toEqual([
        ["named", "Lunch plan"],
        ["before_restore", ""],
        ["before_restore", ""],
        ["published", "Release 1"],
        ["named", "Morning look"],
        ["created", ""],
      ]);
      const second = await publishBoard(journey.owner, script.boardId, first);
      expect((await feed(token)).release?.elements).toEqual(lunch.elements);

      task.meta.menuBoardHistory = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: [
          "Pantry Worker, the board room and its version store",
          "Underclerk fixture Worker",
          "screen feed",
        ],
        versions: history.map((version) => ({
          kind: version.kind,
          label: version.label,
          by: version.createdBy === null ? null : "named",
        })),
        restore: {
          editorsConverged: true,
          headingBack: morning.elements.some((element) => element.id === heading.id),
          commentOnBoardAgain: true,
          repeatedRestoreAddedVersions: 0,
        },
        viewerRestore: [viewerRestore.status, viewerRestore.body],
        releases: { first, second },
        toolOutputs: script.outputs.map(redactIds).map(redactVersions),
      };
    } finally {
      await Promise.all(
        [ownerPeer, staffPeer].map((peer) => closeSocket(peer.socket)),
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
        { query: "menu_board_read menu_board_history", limit: 8 },
        "hs_discover",
      );
    case 2:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: script.boardId },
        "hs_read",
      );
    case 3: {
      const read: unknown = JSON.parse(last);
      const board =
        isRecord(read) && Array.isArray(read.boards) ? read.boards[0] : null;
      // The read shows the history, newest first: the owner's restore saved
      // the board as it was.
      expect(isRecord(board) && Array.isArray(board.versions) ? board.versions[0] : null).toMatchObject({
        kind: "before_restore",
        versionId: script.beforeRestoreId,
      });
      return openRouterToolCall(
        "menu_board_history",
        history(script, "restore_version", { versionId: "version_unknown" }),
        "hs_bad",
      );
    }
    case 4:
      expect(last).toContain("not in the board's history");
      return openRouterToolCall(
        "menu_board_history",
        history(script, "restore_version", { versionId: script.beforeRestoreId }),
        "hs_undo",
      );
    case 5:
      expect(JSON.parse(last)).toMatchObject({
        change: {
          before: { kind: "version", version: { kind: "before_restore" } },
          after: { kind: "version", version: { versionId: script.beforeRestoreId } },
        },
      });
      return openRouterToolCall(
        "menu_board_history",
        history(script, "save_version", { text: "Lunch plan" }),
        "hs_save",
      );
    case 6:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { kind: "version", version: { kind: "named", label: "Lunch plan" } } },
      });
      return openRouterText("HS_DONE", "hs_done");
    default:
      throw new Error(`Unexpected history model request ${script.steps}`);
  }
}

function history(
  script: Script,
  kind: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { kind, boardId: script.boardId, versionId: null, text: null, ...fields };
}

function versionsOf(body: unknown): readonly MenuBoardVersionSummary[] {
  if (!isRecord(body) || !Array.isArray(body.versions))
    throw new Error(`No versions: ${JSON.stringify(body)}`);
  return body.versions as MenuBoardVersionSummary[];
}

function kinds(body: unknown): readonly string[] {
  return versionsOf(body).map((version) => version.kind);
}

function onBoard(read: Readonly<{ body: unknown }>): readonly boolean[] {
  const threads =
    isRecord(read.body) && Array.isArray(read.body.threads)
      ? (read.body.threads as MenuBoardCommentThread[])
      : [];
  return threads.map((thread) => thread.onBoard);
}

function elementOf(
  board: MenuBoardSnapshot,
  kind: MenuBoardElement["kind"],
): MenuBoardElement {
  const element = board.elements.find((candidate) => candidate.kind === kind);
  if (element === undefined) throw new Error(`No ${kind} element`);
  return element;
}

/** Version IDs that hash the operation change from run to run. */
function redactVersions(text: string): string {
  return text
    .replace(/version_before_[0-9a-f]{16}/gu, "version_before_…")
    .replace(/version_[0-9a-f]{20}/gu, "version_…");
}
