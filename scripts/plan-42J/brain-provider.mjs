// Starts the Brain fixture Worker and answers every request it sends out.
// Gmail and the model provider are simulated here, in this process, so their
// state is one state whichever Actor asks. The journey reads that state, and
// delivers mail, through the control address below.
//
// The account authority is not simulated. This process starts the built
// account Worker of the acceptance tests as a second local Worker with its
// own database, and binds it to the fixture Worker as `ACCOUNT_PLATFORM`.
// The account Worker has no public address in this journey.
import { unstable_startWorker } from "../../services/platform/node_modules/wrangler/wrangler-dist/cli.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [config, persistence, evidencePath] = process.argv.slice(2);

const accountArtifact = process.env.SATYR_ACCOUNT_WORKER_ARTIFACT;
if (!accountArtifact)
  throw new Error(
    "Set SATYR_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.",
  );
// The keys of one run. The fixture Worker signs each user assertion and the
// account Worker checks it. The account Worker signs the provision of the
// Organisation and the fixture Worker checks it.
const accountSha256 = createHash("sha256")
  .update(readFileSync(resolve(accountArtifact)))
  .digest("hex");
const assertionKeys = generateKeyPairSync("ed25519");
const provisionKeys = generateKeyPairSync("ed25519");
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

function text(value) {
  return { type: "plain_text", value };
}

function jwk(key) {
  return text(JSON.stringify(key.export({ format: "jwk" })));
}

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
  /** Requests that the fixture Worker sent to the account authority. */
  accountRequests: 0,
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
        accountAuthority: {
          workerSha256: accountSha256,
          requests: state.accountRequests,
        },
      },
      null,
      2,
    ) + "\n",
  );
}
record();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

function stream(chunks) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
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

function unexpectedAccountRequest(request) {
  throw new Error(`Unexpected request of the account Worker: ${request.url}`);
}

const account = await unstable_startWorker({
  name: "satyr-plan42j-account-authority",
  entrypoint: resolve(accountArtifact),
  compatibilityDate: "2026-07-07",
  compatibilityFlags: ["nodejs_compat"],
  build: { nodejsCompatMode: "v2" },
  bindings: {
    ACCOUNT_DB: {
      type: "d1",
      database_name: "plan42j-account-authority",
      database_id: "00000000-0000-0000-0000-000000000427",
    },
    FIXTURE_ASSERTION_PUBLIC_JWK: jwk(assertionKeys.publicKey),
    FIXTURE_GOOGLE_PRIVATE_JWK: jwk(googleKeys.privateKey),
    FIXTURE_GOOGLE_PUBLIC_JWK: jwk(googleKeys.publicKey),
    FIXTURE_GOOGLE_CLIENT_ID: text("shared-account-satyr-e2e"),
    FIXTURE_PROVISION_PRIVATE_JWK: jwk(provisionKeys.privateKey),
  },
  dev: {
    remote: false,
    persist: persistence,
    server: { hostname: "127.0.0.1", port: 8843 },
    inspector: false,
    watch: false,
    outboundService: unexpectedAccountRequest,
  },
});
await account.ready;

/** The binding of the fixture Worker to the account Worker. */
function accountCall(request) {
  state.accountRequests += 1;
  return account.fetch(request);
}

async function respond(request) {
  const url = new URL(request.url);
  if (request.url === MODEL) return model(request);
  if (request.url.startsWith(GMAIL)) return gmail(request, url);
  if (request.url.startsWith(CONTROL)) return control(request, url);
  throw new Error(`Unexpected external request: ${request.url}`);
}

const worker = await unstable_startWorker({
  config,
  build: { nodejsCompatMode: "v2" },
  bindings: {
    ACCOUNT_PLATFORM: { type: "fetcher", fetcher: accountCall },
    ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U: text(
      assertionKeys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
    ),
    ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK: jwk(provisionKeys.publicKey),
  },
  dev: {
    remote: false,
    persist: persistence,
    server: { hostname: "127.0.0.1", port: 8842 },
    inspector: false,
    watch: false,
    outboundService: respond,
  },
});
await worker.ready;
async function stop() {
  await worker.dispose();
  await account.dispose();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
