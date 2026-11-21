// Plan 40B phase 5, slice 6: comments pinned to a board's elements. The
// owner pins a thread to the order QR code and staff reply; a repeated reply
// adds one comment. A viewer reads the thread but cannot write, and staff
// cannot delete the owner's comment. Sous Chef reads the thread, does what it
// asks with a board edit, replies and resolves it; a comment on an element
// that is not on the board is refused in words that it can act on. A thread
// on an element that staff remove stays readable as off the board, and its
// author deletes it. The next release carries no comment.
import { expect, it, type TestContext } from "vitest";
import type { MenuBoardCommentThread } from "@purin-labs/control-api";
import type { MenuBoardElement } from "@purin-labs/menu-board-crdt";
import { isRecord } from "@purin-labs/std";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  delivered,
  installBoardJourney,
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
    menuBoardComments?: Record<string, unknown>;
  }
}

const OWNER_ASK = "Make the QR code bigger, so people see it from the door.";
const STAFF_REPLY = "Agreed. At least 400 wide.";
const MERCHANT_AGENT_REPLY = "Done: the QR code is now 440 by 260.";
const BIGGER = { x: 1100, y: 600, width: 440, height: 260 };

type Script = {
  boardId: string;
  qrId: string;
  threadId: string;
  outputs: string[];
  steps: number;
};

it(
  "lets people pin comments to a board's elements, lets Urk act on a thread and resolve it, and keeps comments out of every release",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = {
      boardId: "",
      qrId: "",
      threadId: "",
      outputs: [],
      steps: 0,
    };
    const journey = await installBoardJourney("comments", (body) =>
      respond(script, body),
    );
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Counter",
      layout: "canvas_landscape",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const comments = `${BASE}/menu-boards/${script.boardId}/comments`;
    const socket = `${BASE}/menu-boards/${script.boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const staffPeer = await BoardPeer.open(socket, journey.staff);
    try {
      const qr = elementOf(ownerPeer.read().elements, "order_qr");
      const heading = elementOf(ownerPeer.read().elements, "heading");
      script.qrId = qr.id;

      // The owner pins a thread to the QR code; staff reply twice with one
      // operation, which adds one comment.
      const pinned = await send(comments, journey.owner, "POST", {
        elementId: qr.id,
        threadId: null,
        body: OWNER_ASK,
        operationId: "owner-ask",
      });
      expect(pinned.status, JSON.stringify(pinned.body)).toBe(201);
      const thread = threadsOf(pinned.body)[0];
      if (thread === undefined) throw new Error("No thread");
      script.threadId = thread.threadId;
      expect(thread).toMatchObject({
        elementId: qr.id,
        onBoard: true,
        resolvedAt: null,
        comments: [{ body: OWNER_ASK, author: { kind: "person" }, mine: true }],
      });
      for (const attempt of [1, 2]) {
        const reply = await send(comments, journey.staff, "POST", {
          elementId: null,
          threadId: thread.threadId,
          body: STAFF_REPLY,
          operationId: "staff-reply",
        });
        expect(reply.status, `reply ${attempt}`).toBe(201);
      }
      const staffRead = threadsOf(
        (await send(comments, journey.staff, "GET")).body,
      );
      expect(staffRead[0]?.comments.map((comment) => comment.mine)).toEqual([
        false,
        true,
      ]);

      // A viewer reads the thread and cannot write; staff cannot delete the
      // owner's comment.
      const viewerRead = await send(comments, journey.viewer, "GET");
      expect(viewerRead.status).toBe(200);
      expect(threadsOf(viewerRead.body)[0]?.comments).toHaveLength(2);
      const viewerWrite = await send(comments, journey.viewer, "POST", {
        elementId: qr.id,
        threadId: null,
        body: "Viewer note",
        operationId: "viewer-note",
      });
      const viewerResolve = await send(
        `${comments}/${thread.threadId}`,
        journey.viewer,
        "PATCH",
        { resolved: true },
      );
      const staffDelete = await send(
        `${comments}/${thread.threadId}`,
        journey.staff,
        "DELETE",
      );
      // A role refusal answers 404 with its code, as every control route does.
      expect([viewerWrite.status, viewerResolve.status, staffDelete.status]).toEqual(
        [404, 404, 403],
      );
      expect([viewerWrite.body, viewerResolve.body]).toEqual([
        expect.objectContaining({ error: "organisation_role_insufficient" }),
        expect.objectContaining({ error: "organisation_role_insufficient" }),
      ]);
      expect(staffDelete.body).toMatchObject({
        error: "menu_board_comment_not_author",
      });

      // Sous Chef reads the thread, makes the QR code bigger, replies and
      // resolves it.
      await sendListingMessage(
        "app_mention",
        "EvCommentsUrk",
        ROOT_TS,
        "<@U0PANTRY> Please handle the open comment on the Counter board.",
      );
      await expect
        .poll(delivered.bind(null, journey.slack), { timeout: 45_000 })
        .toContain("CM_DONE");
      await expect
        .poll(() => rectOf(staffPeer, qr.id), { timeout: 15_000 })
        .toEqual(BIGGER);
      const afterMerchantAgent = threadsOf((await send(comments, journey.owner, "GET")).body);
      const handled = afterMerchantAgent.find((candidate) => candidate.threadId === thread.threadId);
      expect(handled?.resolvedAt).toEqual(expect.any(Number));
      expect(handled?.comments.map((comment) => [comment.author.kind, comment.body])).toEqual([
        ["person", OWNER_ASK],
        ["person", STAFF_REPLY],
        ["agent", MERCHANT_AGENT_REPLY],
      ]);
      const merchantAgentName = handled?.comments[2]?.author.name ?? "";
      expect(handled?.resolvedBy).toBe(merchantAgentName);

      // A thread on the heading, which staff then remove, stays readable as
      // off the board; its author deletes it.
      const headingNote = await send(comments, journey.owner, "POST", {
        elementId: heading.id,
        threadId: null,
        body: "Shorter title?",
        operationId: "owner-heading",
      });
      expect(headingNote.status).toBe(201);
      await staffPeer.submit("staff-remove", staffPeer.doc.removeElement(heading.id));
      const orphan = threadsOf((await send(comments, journey.owner, "GET")).body).find(
        (candidate) => candidate.elementId === heading.id,
      );
      expect(orphan).toMatchObject({ onBoard: false });
      const removed = await send(
        `${comments}/${orphan?.threadId ?? ""}`,
        journey.owner,
        "DELETE",
      );
      expect(removed.status).toBe(200);
      expect(threadsOf(removed.body).map((candidate) => candidate.threadId)).toEqual([
        thread.threadId,
      ]);

      // A release carries the board and no comment.
      const token = await pairScreen(journey.owner, script.boardId);
      const release = await publishBoard(journey.owner, script.boardId, null);
      const raw = JSON.stringify(await rawFeed(token));
      expect(raw).toContain(`"releaseRevision":${release}`);
      for (const text of [OWNER_ASK, STAFF_REPLY, MERCHANT_AGENT_REPLY, "comment"])
        expect(raw).not.toContain(text);

      task.meta.menuBoardComments = {
        substituted: [
          "model provider (deterministic OpenRouter transport)",
          "Slack (signed events)",
        ],
        real: [
          "Pantry Worker, the board room and its comment store",
          "Commerce fixture Worker",
          "screen feed",
        ],
        thread: {
          comments: handled?.comments.map((comment) => ({
            author: comment.author.kind,
            body: comment.body,
          })),
          resolved: handled?.resolvedAt !== null,
          resolvedBy: "agent",
        },
        refusals: {
          viewerWrite: [viewerWrite.status, viewerWrite.body],
          viewerResolve: [viewerResolve.status, viewerResolve.body],
          staffDeletesOwners: [staffDelete.status, staffDelete.body],
        },
        removedElementThread: { onBoard: orphan?.onBoard, deletedByAuthor: true },
        qrRect: rectOf(ownerPeer, qr.id),
        releaseHasComments: false,
        toolOutputs: script.outputs.map(redactIds),
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
        {
          query: "menu_board_read menu_board_edit menu_board_comment",
          limit: 8,
        },
        "cm_discover",
      );
    case 2:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: script.boardId },
        "cm_read",
      );
    case 3: {
      const read: unknown = JSON.parse(last);
      const board =
        isRecord(read) && Array.isArray(read.boards) ? read.boards[0] : null;
      // The read shows the thread on the QR code, with both comments.
      expect(board).toMatchObject({
        comments: [
          {
            elementId: script.qrId,
            onBoard: true,
            comments: [{ body: OWNER_ASK }, { body: STAFF_REPLY }],
          },
        ],
      });
      return openRouterToolCall(
        "menu_board_edit",
        {
          kind: "place_on_canvas",
          boardId: script.boardId,
          elementId: script.qrId,
          prop: null,
          before: null,
          text: null,
          title: null,
          itemId: null,
          frameId: null,
          order: null,
          ...BIGGER,
        },
        "cm_place",
      );
    }
    case 4:
      return openRouterToolCall(
        "menu_board_comment",
        comment(script, "add_comment", { elementId: "element_not_here", text: "?" }),
        "cm_bad",
      );
    case 5:
      expect(last).toContain("not on the board now");
      return openRouterToolCall(
        "menu_board_comment",
        comment(script, "reply_comment", { commentId: script.threadId, text: MERCHANT_AGENT_REPLY }),
        "cm_reply",
      );
    case 6:
      expect(JSON.parse(last)).toMatchObject({
        change: { after: { kind: "comment_thread" } },
      });
      return openRouterToolCall(
        "menu_board_comment",
        comment(script, "resolve_comment", { commentId: script.threadId }),
        "cm_resolve",
      );
    case 7:
      expect(JSON.parse(last)).toMatchObject({
        change: {
          before: { thread: { resolvedAt: null } },
          after: { thread: { resolvedAt: expect.any(Number) } },
        },
      });
      return openRouterText("CM_DONE", "cm_done");
    default:
      throw new Error(`Unexpected comments model request ${script.steps}`);
  }
}

function comment(
  script: Script,
  kind: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    kind,
    boardId: script.boardId,
    elementId: null,
    commentId: null,
    text: null,
    ...fields,
  };
}

function threadsOf(body: unknown): readonly MenuBoardCommentThread[] {
  if (!isRecord(body) || !Array.isArray(body.threads))
    throw new Error(`No threads: ${JSON.stringify(body)}`);
  return body.threads as MenuBoardCommentThread[];
}

function elementOf(
  elements: readonly MenuBoardElement[],
  kind: MenuBoardElement["kind"],
): MenuBoardElement {
  const element = elements.find((candidate) => candidate.kind === kind);
  if (element === undefined) throw new Error(`No ${kind} element`);
  return element;
}

function rectOf(peer: BoardPeer, elementId: string): unknown {
  const element = peer.read().elements.find((candidate) => candidate.id === elementId);
  return element?.placement.frameId === "canvas" ? element.placement.rect : null;
}
