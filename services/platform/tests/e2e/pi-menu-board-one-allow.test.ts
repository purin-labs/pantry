// Plan 40B phase 7: one Allow covers one request. The owner asks the Portal
// chat agent to change a text on a board and to add a note under it. The
// private chat's content may not reach the shared board, so the first edit
// is held, and the board does not change. The owner allows it, as the
// Portal's prompt does, and asks again. In that one request the agent makes
// both edits: the change and the new note reach the open editor, and no
// second permission request waits. A later request of the owner to change
// the note is held again: the earlier Allow does not cover it. The new note
// streams its arguments in small parts, as real models do, and the open
// editor sees the agent's draft of it before the note lands.
//
// Not covered here: an edit whose content grows inside the request (a
// private read between two edits). The label check that asks again for it
// is in `passUse` (src/actors/harness-follow-up.ts).
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type PortalPageViewV1 } from "@seams/control-api";
import { isRecord } from "@seams/std";
import { encodeMenuBoardClientMessage, parseMenuBoardServerMessage } from "@seams/menu-board-crdt/protocol";
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
import { HttpResponse } from "msw";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardOneAllow?: Record<string, unknown>;
  }
}

const BEFORE = "Soy milk +¥50";
const AFTER = "Oat milk is free today";
const NOTE = "Ask us about the yuzu tart";
const NOTE_LATER = "The yuzu tart is sold out";
const TEXT_ID = "element_soymilknote";
const HELD = "permission request";
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

type Step = (body: Record<string, unknown>) => Response;
type Script = { steps: Step[]; outputs: string[]; calls: number };

it(
  "lets one Allow cover the later board edits of the same request, and asks again for a later request",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const script: Script = { steps: [], outputs: [], calls: 0 };
    const journey = await installBoardJourney("one-allow", (body) =>
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
    // The agent's draft frames that reach the open editor.
    const drafts: string[] = [];
    // Frames that the Portal's board client refuses: it stops on the first.
    const refused: string[] = [];
    ownerPeer.socket.addEventListener("message", (event: MessageEvent) => {
      const text = String(event.data);
      if (!parseMenuBoardServerMessage(event.data).ok || text.includes('"kind":"failure"')) refused.push(text);
      if (text.includes("presence_changed") && text.includes('"state":"pending"') && text.includes("Ask us"))
        drafts.push(text);
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
      const message = (label: string, text: string) =>
        send(`${BASE}/chat`, journey.owner, "POST", {
          kind: "message",
          conversationId,
          requestId: `request_${conversationId}_${label}`,
          model,
          text,
          surfaceContext: null,
          browserContext: { kind: "unavailable" },
          pageView,
        });
      const changeText = setText(boardId, TEXT_ID, BEFORE, AFTER);
      const addNote = addText(boardId, NOTE);

      // 1. The first edit is held, and the board keeps its text.
      script.steps.push(changeText("first"), reply("PR_PERMISSION"));
      const ask = `Make it say "${AFTER}" and add a note under it: "${NOTE}"`;
      expect((await message("first", ask)).status).toBe(200);
      await expect
        .poll(() => lastAnswer(journey.owner, conversationId), { timeout: 60_000 })
        .toBe("PR_PERMISSION");
      expect(script.outputs.at(-1)).toContain(HELD);
      expect(textOf(ownerPeer, TEXT_ID)).toBe(BEFORE);
      const firstHeld = await pending(journey.owner);
      expect(firstHeld).toHaveLength(1);
      expect(firstHeld[0]).toMatchObject({
        reason: "private_source",
        effect: "Edit the shared menu draft",
        conversationId,
      });

      // 2. The owner allows it and asks again. The model writes both edits
      // in one message, so they run at the same time, as Claude does in
      // production. Both reach the board, and nothing else waits for the
      // owner.
      // The prompt says that the Allow is for one request, not for one step.
      const prompt = await send(
        `${BASE}/access-control/held-outputs/${String(firstHeld[0]?.requestId)}`,
        journey.owner,
        "GET",
      );
      expect(prompt.body).toMatchObject({ covers: "request", status: "pending" });
      const allowed = await send(
        `${BASE}/access-control/held-outputs/${String(firstHeld[0]?.requestId)}/decision`,
        journey.owner,
        "POST",
        { decision: "allow" },
      );
      expect(allowed.status, JSON.stringify(allowed.body).slice(0, 400)).toBe(200);
      script.steps.push(
        addNote("again", setTextArgs(boardId, TEXT_ID, BEFORE, AFTER)),
        reply("PR_DONE"),
      );
      // The owner moves the pointer over the board while the agent works,
      // at the rate of the Portal's board client.
      let tick = 0;
      const pointer = setInterval(() => {
        tick += 1;
        if (ownerPeer.socket.readyState !== WebSocket.OPEN) return;
        ownerPeer.socket.send(encodeMenuBoardClientMessage({
          kind: "pointer_update",
          position: { x: (tick % 100) / 100, y: 0.5 },
        }));
      }, 50);
      expect((await message("again", ask)).status).toBe(200);
      await expect
        .poll(() => lastAnswer(journey.owner, conversationId), { timeout: 60_000 })
        .toBe("PR_DONE");
      clearInterval(pointer);
      expect(script.outputs.at(-1)).not.toContain(HELD);
      expect(refused).toEqual([]);
      await expect.poll(() => textOf(ownerPeer, TEXT_ID), { timeout: 10_000 }).toBe(AFTER);
      await expect.poll(() => noteOf(ownerPeer)?.text ?? null, { timeout: 10_000 }).toBe(NOTE);
      // The draft of the streamed note showed while its text grew.
      expect(drafts.length).toBeGreaterThan(0);
      expect(refused).toEqual([]);
      expect(await pending(journey.owner)).toHaveLength(0);
      const noteId = noteOf(ownerPeer)?.id ?? "";

      // 3. A later request to change the note needs a new Allow.
      script.steps.push(
        setText(boardId, noteId, NOTE, NOTE_LATER)("later"),
        reply("PR_PERMISSION"),
      );
      expect((await message("later", `Make the note say "${NOTE_LATER}"`)).status).toBe(200);
      await expect
        .poll(() => script.steps.length, { timeout: 60_000 })
        .toBe(0);
      await expect
        .poll(() => lastAnswer(journey.owner, conversationId), { timeout: 60_000 })
        .toBe("PR_PERMISSION");
      expect(script.outputs.at(-1)).toContain(HELD);
      expect(noteOf(ownerPeer)?.text).toBe(NOTE);
      expect(await pending(journey.owner)).toHaveLength(1);

      task.meta.menuBoardOneAllow = {
        substituted: ["model provider (deterministic OpenRouter transport)"],
        real: [
          "Satyr Worker, the Portal chat route, the exit check and the board room",
          "the Portal's own board page view",
        ],
        firstRequest: { held: true, boardText: BEFORE },
        afterOneAllow: {
          edits: 2,
          boardText: textOf(ownerPeer, TEXT_ID),
          note: NOTE,
          pendingAfter: 0,
          noteDraftFrames: drafts.length,
        },
        laterRequest: { held: true, note: noteOf(ownerPeer)?.text, pendingAfter: 1 },
        toolOutputs: script.outputs.map(redactIds),
      };
    } finally {
      await closeSocket(ownerPeer.socket);
    }
  },
);

function respond(script: Script, body: Record<string, unknown>): Response {
  script.calls += 1;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  // The board tools come through the tool search, as with a real model.
  if (!JSON.stringify(body.tools ?? []).includes('"menu_board_edit"'))
    return openRouterToolCall(
      "tool_search",
      { query: "menu_board_edit", limit: 8 },
      `oa_discover_${script.calls}`,
    );
  const step = script.steps.shift();
  if (step === undefined) throw new Error("Unexpected model request");
  return step(body);
}

const EMPTY_EDIT = {
  title: null,
  itemId: null,
  frameId: null,
  order: null,
  elementId: null,
  prop: null,
  before: null,
  x: null,
  y: null,
  width: null,
  height: null,
} as const;

function setTextArgs(boardId: string, elementId: string, before: string, text: string) {
  return { ...EMPTY_EDIT, kind: "set_text", boardId, elementId, prop: "text", before, text };
}

function setText(boardId: string, elementId: string, before: string, text: string) {
  return (label: string): Step =>
    () =>
      openRouterToolCall(
        "menu_board_edit",
        setTextArgs(boardId, elementId, before, text),
        `oa_set_${label}_${elementId}`,
      );
}

/**
 * A new note whose arguments arrive in parts of 12 characters, 40 ms apart:
 * the real routes take 0.3 to 2 s for such a call (docs/evidence/
 * plan-40b-phase-7/real-routes). An `alongside` edit comes first in the same
 * message, whole.
 */
function addText(boardId: string, text: string) {
  return (label: string, alongside?: Record<string, unknown>): Step =>
    () => {
      const callId = `oa_add_${label}`;
      const args = JSON.stringify({
        kind: "add_text",
        boardId,
        frameId: "canvas",
        x: 200,
        y: 560,
        width: 500,
        height: 96,
        text,
        ...EMPTY_EDIT_REST,
      });
      const parts: string[] = [];
      for (let at = 0; at < args.length; at += 12) parts.push(args.slice(at, at + 12));
      const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
        id: `chatcmpl_${callId}`,
        object: "chat.completion.chunk",
        created: 1_787_500_000,
        model: "moonshotai/kimi-k3",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const index = alongside === undefined ? 0 : 1;
      const first =
        alongside === undefined
          ? []
          : [
              chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `oa_alongside_${label}`,
                      type: "function",
                      function: { name: "menu_board_edit", arguments: JSON.stringify(alongside) },
                    },
                  ],
                },
                null,
              ),
            ];
      const events = [
        ...first,
        chunk(
          {
            role: "assistant",
            tool_calls: [{ index, id: callId, type: "function", function: { name: "menu_board_edit", arguments: "" } }],
          },
          null,
        ),
        ...parts.map((part) => chunk({ tool_calls: [{ index, function: { arguments: part } }] }, null)),
        chunk({}, "tool_calls"),
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
      events.push("data: [DONE]\n\n");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(event));
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          controller.close();
        },
      });
      return new HttpResponse(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
}

const EMPTY_EDIT_REST = {
  title: null,
  itemId: null,
  order: null,
  elementId: null,
  prop: null,
  before: null,
} as const;

function reply(text: string): Step {
  return () => openRouterText(JSON.stringify({ kind: "reply", text }), `oa_${text}_${Date.now()}`);
}

async function pending(
  session: Parameters<typeof send>[1],
): Promise<readonly Record<string, unknown>[]> {
  const listed = await send(`${BASE}/access-control/permission-requests`, session, "GET");
  expect(listed.status).toBe(200);
  const held = isRecord(listed.body) && Array.isArray(listed.body.heldOutputs) ? listed.body.heldOutputs : [];
  return held.filter(isRecord);
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

function textOf(peer: BoardPeer, id: string): string | null {
  const element = peer.read().elements.find((candidate) => candidate.id === id);
  return element?.kind === "text" ? element.text : null;
}

function noteOf(peer: BoardPeer): Readonly<{ id: string; text: string }> | null {
  for (const element of peer.read().elements)
    if (element.kind === "text" && element.id !== TEXT_ID && (element.text === NOTE || element.text === NOTE_LATER))
      return { id: element.id, text: element.text };
  return null;
}
