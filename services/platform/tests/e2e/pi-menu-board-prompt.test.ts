// Plan 40B phase 5, slice 9: prompt to edit from a selected element. The
// owner selects a text on a board and asks the Portal chat agent to change
// "this". The message carries the board page, built by the Portal's own
// page view, with the selection. The model takes the board, the element and
// its text only from that page, and changes the element with
// menu_board_edit, under the owner's checks. The private chat's content may
// not reach the shared board until the owner allows it: the first edit is
// held for the owner's permission, and the board does not change. The owner
// allows the held step, as the Portal's prompt does, and asks again. The open
// editors see the change at once, with the agent's label on the element. The owner's undo is a
// Portal edit (the browser journey "Prompt to edit").
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type PortalPageViewV1 } from "@seams/control-api";
import { isRecord } from "@seams/std";
import { boardPageView } from "../../../../apps/portal/src/features/menu-boards/board-page-view";
import { closeSocket } from "./hibernatable-socket-support";
import {
  BASE,
  BoardPeer,
  boardIdOf,
  installBoardJourney,
  redactIds,
  send,
  toolOutput,
} from "./menu-board-journey-support";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardPrompt?: Record<string, unknown>;
  }
}

const ASK = "Make it say that oat milk is free today";
const BEFORE = "Soy milk +¥50";
const AFTER = "Oat milk is free today";
const TEXT_ID = "element_soymilknote";
/** The Portal's element names, as the Boards page passes them. */
const NAMES = {
  heading: "Heading",
  section: "Menu section",
  featured: "Product",
  order_qr: "Order QR code",
  pickup_codes: "Order codes",
  text: "Text",
  image: "Image",
  stack: "Stack",
} as const;

type Script = { outputs: string[]; prompts: string[]; steps: number };

it(
  "lets a person ask the chat agent to change the selected board element, and shows the change in the open editors",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { outputs: [], prompts: [], steps: 0 };
    const journey = await installBoardJourney("prompt", (body) =>
      respond(script, body),
    );
    const created = await send(`${BASE}/menu-boards`, journey.owner, "POST", {
      title: "Drinks",
      layout: "canvas_landscape",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const boardId = boardIdOf(created.body);
    const socket = `${BASE}/menu-boards/${boardId}/socket`;
    const ownerPeer = await BoardPeer.open(socket, journey.owner);
    const labels: string[] = [];
    ownerPeer.socket.addEventListener("message", (event: MessageEvent) => {
      const text = String(event.data);
      if (text.includes("presence_changed") && text.includes(TEXT_ID)) labels.push(text);
    });
    try {
      await ownerPeer.submit(
        "owner-text",
        ownerPeer.doc.addElement({
          id: TEXT_ID,
          kind: "text",
          placement: {
            frameId: "canvas",
            order: 3,
            rect: { x: 200, y: 400, width: 500, height: 120 },
            constraints: { horizontal: "scale", vertical: "scale" },
          },
          text: BEFORE,
        }),
      );
      // The page as the Portal builds it, with the text selected.
      const pageView: PortalPageViewV1 = boardPageView(
        {
          organisationId: "",
          boardId,
          board: ownerPeer.read(),
          selection: [TEXT_ID],
          names: NAMES,
        },
        "/portal/cafe/main/menus",
      );
      const chat = await send(`${BASE}/chat`, journey.owner, "GET");
      expect(chat.status, JSON.stringify(chat.body).slice(0, 400)).toBe(200);
      const model =
        isRecord(chat.body) && isRecord(chat.body.model) && typeof chat.body.model.selected === "string"
          ? chat.body.model.selected
          : "";
      const conversationId = newConversationId();
      const message = (label: string) =>
        send(`${BASE}/chat`, journey.owner, "POST", {
          kind: "message",
          conversationId,
          requestId: `request_${conversationId}_${label}`,
          model,
          text: `${ASK}\n\n(About the selected text on the board “Drinks”.)`,
          surfaceContext: null,
          browserContext: { kind: "unavailable" },
          pageView,
        });
      const sent = await message("first");
      expect(sent.status, JSON.stringify(sent.body).slice(0, 600)).toBe(200);
      // The first edit is stopped: the private chat's content would reach
      // the shared board. The agent tells the owner, and the board keeps
      // its text.
      await expect
        .poll(() => lastAnswer(journey.owner, conversationId), { timeout: 60_000 })
        .toBe("PR_PERMISSION");
      expect(textOf(ownerPeer)).toBe(BEFORE);
      // The owner allows the held step, as the Portal's permission prompt
      // does.
      const listed = await send(`${BASE}/access-control/permission-requests`, journey.owner, "GET");
      expect(listed.status).toBe(200);
      const heldOutputs = isRecord(listed.body) && Array.isArray(listed.body.heldOutputs) ? listed.body.heldOutputs : [];
      const held: unknown = heldOutputs.at(-1);
      expect(held).toMatchObject({ reason: "private_source", effect: "Edit the shared menu draft", conversationId });
      const heldId = isRecord(held) && typeof held.requestId === "string" ? held.requestId : "";
      const allowed = await send(
        `${BASE}/access-control/held-outputs/${heldId}/decision`,
        journey.owner,
        "POST",
        { decision: "allow" },
      );
      expect(allowed.status, JSON.stringify(allowed.body).slice(0, 400)).toBe(200);
      // The owner asks again from the same selection.
      const again = await message("again");
      expect(again.status, JSON.stringify(again.body).slice(0, 600)).toBe(200);
      await expect
        .poll(() => textOf(ownerPeer), { timeout: 60_000 })
        .toBe(AFTER);
      // The agent's label shows on the element that it changed.
      await expect.poll(() => labels.length, { timeout: 10_000 }).toBeGreaterThan(0);
      const stored = await BoardPeer.open(socket, journey.owner);
      expect(textOf(stored)).toBe(AFTER);
      await closeSocket(stored.socket);
      // The model saw the selection only through the page view.
      expect(script.prompts[0]).toContain("Selected elements");
      expect(script.prompts[0]).toContain(TEXT_ID);

      task.meta.menuBoardPrompt = {
        substituted: ["model provider (deterministic OpenRouter transport)"],
        real: [
          "Pantry Worker, the Portal chat route and the board room",
          "the Portal's own board page view",
        ],
        pageView: JSON.parse(redactIds(JSON.stringify({ ...pageView, capturedAt: 0 }))) as unknown,
        heldStep: isRecord(held) ? { reason: held.reason, effect: held.effect } : null,
        before: BEFORE,
        after: textOf(ownerPeer),
        agentLabelOnElement: labels.length > 0,
        toolOutputs: script.outputs.map(redactIds),
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
  const prompt = JSON.stringify(body.messages ?? []);
  script.prompts.push(prompt);
  if (last.includes('"change"')) {
    expect(JSON.parse(last)).toMatchObject({
      change: { before: { text: BEFORE }, after: { text: AFTER } },
    });
    return openRouterText(JSON.stringify({ kind: "reply", text: "PR_DONE" }), "pr_done");
  }
  // The flow check stopped the step and asked the person: tell them.
  if (last.includes("permission request"))
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "PR_PERMISSION" }),
      `pr_permission_${script.steps}`,
    );
  if (!JSON.stringify(body.tools ?? []).includes('"menu_board_edit"'))
    return openRouterToolCall(
      "tool_search",
      { query: "menu_board_edit", limit: 8 },
      `pr_discover_${script.steps}`,
    );
  const page = selectionOf(prompt);
  if (page === null) return openRouterText("PR_NO_SELECTION", "pr_none");
  return openRouterToolCall(
    "menu_board_edit",
    {
      kind: "set_text",
      boardId: page.boardId,
      elementId: page.elementId,
      prop: "text",
      before: page.text,
      text: AFTER,
      title: null,
      itemId: null,
      frameId: null,
      order: null,
      x: null,
      y: null,
      width: null,
      height: null,
    },
    `pr_edit_${script.steps}`,
  );
}

/** The board and the selected element, read only from the page view. */
function selectionOf(
  prompt: string,
): Readonly<{ boardId: string; elementId: string; text: string }> | null {
  const at = prompt.lastIndexOf("Portal page on the operator's screen");
  if (at < 0) return null;
  const view = prompt.slice(at);
  const boardId = /board_[0-9a-f]{20}/u.exec(view)?.[0];
  const row = /\\"(element_[A-Za-z0-9_]+)\\",\\"Text\\",\\"text: ([^"\\]*)\\"/u.exec(view);
  return boardId === undefined || row?.[1] === undefined || row[2] === undefined
    ? null
    : { boardId, elementId: row[1], text: row[2] };
}

/** The newest answer of a finished run, as the Portal reads the chat. */
async function lastAnswer(
  session: Parameters<typeof send>[1],
  conversationId: string,
): Promise<string | null> {
  const read = await send(`${BASE}/chat?conversation=${conversationId}`, session, "GET");
  const conversation = isRecord(read.body) && isRecord(read.body.conversation) ? read.body.conversation : null;
  if (conversation === null || !isRecord(conversation.work) || conversation.work.kind !== "ready") return null;
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const answer: unknown = [...messages].reverse().find((entry: unknown) => isRecord(entry) && entry.kind === "assistant");
  return isRecord(answer) && typeof answer.text === "string" ? answer.text : null;
}

function textOf(peer: BoardPeer): string | null {
  const element = peer.read().elements.find((candidate) => candidate.id === TEXT_ID);
  return element?.kind === "text" ? element.text : null;
}
