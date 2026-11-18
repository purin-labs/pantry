// Starts the side Case fixture Worker (Plan 74) and answers every request it
// sends out. The model provider is simulated here, in this process, so its
// record is one record whichever Actor asks. The journey reads that record
// through the control address below.
//
// The account authority is not simulated. This process starts the built
// account Worker of the acceptance tests as a second local Worker with its
// own database, and binds it to the fixture Worker as `ACCOUNT_PLATFORM`.
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

const MODEL = "https://openrouter.ai/api/v1/chat/completions";
const CONTROL = "https://side-case-fixture.internal";
// The journey's words. The browser journey sends QUESTION, and starts the
// side Case whose brief holds BRIEF.
const QUESTION = "How many croissant orders came in today?";
const ANSWER = "Today has 14 croissant orders. I proposed a side Case.";
const TITLE = "Fix the almond croissant price";
const BRIEF =
  "The almond croissant shows a price of 0 yen in the shop, but the menu says 520 yen. Find where the price came from and correct it to 520 yen.";
const SIDE_ANSWER = "I will check the almond croissant price record.";

const state = {
  modelRequests: [],
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
          answer: request.answer,
          historyRoles: request.historyRoles,
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

function stream(chunks) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function modelText(content, id) {
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
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
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
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}

/** The person's request of this turn, as Pantry quotes it to the model. */
function currentRequest(body) {
  const messages = body.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const content = JSON.stringify(messages[index].content);
    const at = content.indexOf("Current user request");
    if (at < 0) return "";
    const end = content.indexOf("Accepted organizational context", at);
    return content.slice(at, end < 0 ? undefined : end);
  }
  return "";
}

/** The tools that the model called in this turn, in order. */
function calledTools(body) {
  return (body.messages ?? []).flatMap((message) =>
    (message.tool_calls ?? []).map((call) => call.function?.name ?? ""),
  );
}

function reply(answer, id) {
  return modelText(JSON.stringify({ kind: "reply", text: answer }), id);
}

/**
 * The source chat's turn proposes one side Case and answers; the side Case's
 * turn answers its brief. A large catalogue offers the tool after a search,
 * as a real model sees it.
 */
async function model(request) {
  const body = await request.json();
  const current = currentRequest(body);
  const calls = calledTools(body);
  const offered = (body.tools ?? []).map((tool) => tool.function?.name);
  const id = `side_case_${state.modelRequests.length + 1}`;
  const historyRoles = (body.messages ?? []).map((message) => message.role);
  if (current.includes(QUESTION)) {
    if (calls.includes("propose_side_case")) {
      state.modelRequests.push({
        turn: "source",
        answer: ANSWER,
        historyRoles,
      });
      record();
      return reply(ANSWER, id);
    }
    const search =
      !offered.includes("propose_side_case") && calls.at(-1) !== "tool_search";
    state.modelRequests.push({
      turn: "source",
      answer: search ? "tool_search" : "propose_side_case",
      historyRoles,
    });
    record();
    return search
      ? modelToolCall("tool_search", { query: "propose_side_case" }, id)
      : modelToolCall("propose_side_case", { title: TITLE, brief: BRIEF }, id);
  }
  if (current.includes("Find where the price came from")) {
    state.modelRequests.push({
      turn: "side_case",
      answer: SIDE_ANSWER,
      historyRoles,
    });
    record();
    return reply(SIDE_ANSWER, id);
  }
  throw new Error(`Unexpected model request: ${current.slice(0, 200)}`);
}

/** The journey's own request: what the model was asked. */
function control(request, url) {
  if (request.method === "GET" && url.pathname === "/state") {
    record();
    return json({ modelRequests: state.modelRequests });
  }
  throw new Error(`Unexpected control request: ${request.url}`);
}

function unexpectedAccountRequest(request) {
  throw new Error(`Unexpected request of the account Worker: ${request.url}`);
}

const account = await unstable_startWorker({
  name: "satyr-plan74-account-authority",
  entrypoint: resolve(accountArtifact),
  compatibilityDate: "2026-07-07",
  compatibilityFlags: ["nodejs_compat"],
  build: { nodejsCompatMode: "v2" },
  bindings: {
    ACCOUNT_DB: {
      type: "d1",
      database_name: "plan74-account-authority",
      database_id: "00000000-0000-0000-0000-000000000475",
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
    server: { hostname: "127.0.0.1", port: 8875 },
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
    server: { hostname: "127.0.0.1", port: 8874 },
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
