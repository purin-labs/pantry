// Starts the Brain fixture Worker and answers every request it sends out.
// Gmail and the model provider are simulated here, in this process, so their
// state is one state whichever Actor asks. The journey reads that state, and
// delivers mail, through the control address below.
import {
  json,
  startFixtureWorker,
  stopOnSignal,
  stream,
} from "../lib/fixture-worker.mjs";
import { writeFileSync } from "node:fs";

const [config, persistence, evidencePath] = process.argv.slice(2);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MODEL = "https://openrouter.ai/api/v1/chat/completions";
const LEARNED_CHECK = {
  subject: "Change to tomorrow's order",
  body: "Please add ten cases of butter to tomorrow's delivery.",
};
const EVAL_REPLY =
  "This change is after the cutoff, so I have asked the team to confirm it.";
const EVAL_TURN_MESSAGE =
  /Admitted message ids \(oldest first\): [0-9a-f]{16}\./u;
const CONTROL = "https://brain-fixture.internal";
const MAILBOX = "shop@example.test";
const LEARNED_FACT =
  "Next-day orders close at noon. Changes after noon are refused.";
const DRAFTED_REPLY = "We can change tomorrow's order. Send us the new lines.";
const SECOND_REPLY =
  "Tomorrow's order closed at noon, so we cannot change it now.";

const state = {
  /** Mail the mailbox holds: id -> { threadId, from, body }. */
  inbox: new Map(),
  /** What the next history read reports. */
  arrivals: [],
  historyId: 1000,
  drafts: new Map(),
  draftCreates: 0,
  sent: [],
  modelRequests: [],
};

function record() {
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        calls: state.modelRequests.map((request, index) => ({
          number: index + 1,
          turn: request.turn,
          toolResults: request.toolResults,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}
record();

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The headers and the plain-text body of a raw message the Worker built. */
function decodeRaw(raw) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const headers = new Map();
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(": ");
    if (at > 0)
      headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 2));
  }
  return {
    headers,
    body: Buffer.from(body.replaceAll(/\s+/gu, ""), "base64").toString("utf8"),
  };
}

function modelText(text, id) {
  const base = {
    id,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
  };
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

function modelToolCall(name, args, callId) {
  const base = {
    id: `chatcmpl_${callId}`,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
  };
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

/** The text of the turn's request: what the model was asked, with its context. */
function promptOf(body) {
  const user = (body.messages ?? []).find((message) => message.role === "user");
  const content = user?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) && typeof content[0]?.text === "string"
    ? content[0].text
    : "";
}

async function model(request) {
  const body = await request.json();
  const learning = JSON.stringify(body.tools ?? []).includes("propose_memory");
  const toolResults = (body.messages ?? []).filter(
    (message) => message.role === "tool",
  ).length;
  const prompt = promptOf(body);
  // An eval turn is asked what a turn for arrived mail is asked. Its message
  // has an identity in Gmail's form, and no mail of this journey has one.
  const evaluated = EVAL_TURN_MESSAGE.test(prompt);
  state.modelRequests.push({
    turn: learning ? "learning" : evaluated ? "eval" : "reply",
    toolResults,
    prompt,
  });
  record();
  const id = `brain_${state.modelRequests.length}`;
  if (toolResults === 0) return modelToolCall("read_email_case", {}, id);
  if (toolResults > 1) return modelText("Settled.", id);
  // With the fact it learned, the agent also writes one message that tests it.
  if (learning)
    return modelToolCall(
      "propose_memory",
      { statement: LEARNED_FACT, check: LEARNED_CHECK },
      id,
    );
  // In an eval the agent sends a change to tomorrow's order to a person.
  if (evaluated)
    return modelToolCall(
      "email_reply_for_approval",
      { body: EVAL_REPLY, sources: null },
      id,
    );
  // A turn that was shown the learned fact follows it.
  return modelToolCall(
    "email_reply_for_approval",
    {
      body: prompt.includes(LEARNED_FACT) ? SECOND_REPLY : DRAFTED_REPLY,
      sources: null,
    },
    id,
  );
}

function message(id) {
  const held = state.inbox.get(id);
  if (held === undefined) return new Response(null, { status: 404 });
  return json({
    id,
    threadId: held.threadId,
    internalDate: "1790726400000",
    sizeEstimate: 200,
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: held.from },
        { name: "To", value: MAILBOX },
        { name: "Subject", value: "Tomorrow's order" },
        { name: "Message-ID", value: `<${id}@example.test>` },
      ],
      body: { data: encode(held.body) },
    },
  });
}

function draft(draftId) {
  const held = state.drafts.get(draftId);
  if (held === undefined) return new Response(null, { status: 404 });
  const decoded = decodeRaw(held.raw);
  return json({
    id: draftId,
    message: {
      id: `message_${draftId}`,
      threadId: held.threadId,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: MAILBOX },
          { name: "To", value: decoded.headers.get("to") ?? "" },
          { name: "Subject", value: decoded.headers.get("subject") ?? "" },
        ],
        body: { data: encode(decoded.body) },
      },
    },
  });
}

async function gmail(request, url) {
  const path = url.pathname.slice(new URL(GMAIL).pathname.length);
  const method = request.method;
  if (method === "GET" && path === "/profile")
    return json({ emailAddress: MAILBOX, historyId: "100" });
  if (method === "POST" && path === "/watch")
    return json({
      historyId: "1000",
      expiration: String(Date.now() + 3_600_000),
    });
  if (method === "GET" && path === "/history")
    return json({
      historyId: String(state.historyId),
      history: state.arrivals.map((id, index) => ({
        id: String(state.historyId + index),
        messagesAdded: [
          { message: { id, threadId: state.inbox.get(id)?.threadId ?? "" } },
        ],
      })),
    });
  if (method === "GET" && path === "/messages") return json({ messages: [] });
  if (method === "GET" && path.startsWith("/messages/"))
    return message(path.slice("/messages/".length));
  if (method === "POST" && path === "/messages/send") {
    const body = await request.json();
    state.sent.push({ raw: body.raw, threadId: body.threadId ?? null });
    return json({
      id: `sent_${state.sent.length}`,
      threadId: body.threadId ?? "",
    });
  }
  if (method === "GET" && path === "/drafts") {
    const query = url.searchParams.get("q");
    const found = [];
    for (const [id, held] of state.drafts)
      if (
        query === `rfc822msgid:${decodeRaw(held.raw).headers.get("message-id")}`
      )
        found.push({ id });
    return json({ drafts: found });
  }
  if (method === "POST" && path === "/drafts") {
    const body = await request.json();
    state.draftCreates += 1;
    const draftId = `draft_${state.draftCreates}`;
    state.drafts.set(draftId, {
      raw: body.message.raw,
      threadId: body.message.threadId ?? "",
    });
    return json({
      id: draftId,
      message: {
        id: `message_${draftId}`,
        threadId: body.message.threadId ?? "",
      },
    });
  }
  if (path.startsWith("/drafts/")) {
    const draftId = path.slice("/drafts/".length);
    if (method === "GET") return draft(draftId);
    if (method === "DELETE") {
      state.drafts.delete(draftId);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      const held = state.drafts.get(draftId);
      if (held === undefined) return new Response(null, { status: 404 });
      const body = await request.json();
      state.drafts.set(draftId, { ...held, raw: body.message.raw });
      return json({ id: draftId, message: { id: `message_${draftId}_edit` } });
    }
  }
  throw new Error(`Unexpected Gmail request: ${method} ${request.url}`);
}

/** The journey's own requests: deliver mail, and read what the providers hold. */
async function control(request, url) {
  if (request.method === "POST" && url.pathname === "/arrive") {
    const body = await request.json();
    for (const arrived of body.messages) state.inbox.set(arrived.id, arrived);
    state.arrivals = body.messages.map((arrived) => arrived.id);
    state.historyId = body.historyId;
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/settled") {
    state.arrivals = [];
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/state") {
    // The journey reads this state to its end, so the saved count is whole.
    record();
    return json({
      drafts: [...state.drafts].map(([id, held]) => ({
        id,
        threadId: held.threadId,
        to: decodeRaw(held.raw).headers.get("to") ?? null,
        body: decodeRaw(held.raw).body,
      })),
      sent: state.sent.map((sent) => ({
        threadId: sent.threadId,
        to: decodeRaw(sent.raw).headers.get("to") ?? null,
        body: decodeRaw(sent.raw).body,
      })),
      modelRequests: state.modelRequests,
    });
  }
  throw new Error(`Unexpected control request: ${request.url}`);
}

async function respond(request) {
  const url = new URL(request.url);
  if (request.url === MODEL) return model(request);
  if (request.url.startsWith(GMAIL)) return gmail(request, url);
  if (request.url.startsWith(CONTROL)) return control(request, url);
  throw new Error(`Unexpected external request: ${request.url}`);
}

const worker = await startFixtureWorker({
  config,
  persistence,
  port: 8842,
  respond,
});
stopOnSignal(worker);
