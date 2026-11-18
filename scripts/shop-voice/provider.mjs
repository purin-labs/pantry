// Starts the Worker of the shop Mac journeys (Plan 82 Phases 1B and 2) and answers
// every request that it sends out. The simulated services are the Cloudflare DNS
// API, Workers AI and the model provider. They only record each call and answer
// it. The account authority is the built account Worker of the acceptance tests,
// as in Plan 81.
import {
  accountArtifact,
  runKeys,
  startAccountWorker,
  startFixtureWorker,
  stopOnSignal,
  text,
} from "../lib/fixture-worker.mjs";
import { sleep } from "../../packages/std/src/index.ts";

const [config, persistence] = process.argv.slice(2);
const port = Number(process.env.SHOP_VOICE_PORT ?? 8891);

const artifact = accountArtifact();
const keys = runKeys();

const records = new Map();
const writes = [];
let nextRecord = 1;

function dnsApi(request, url) {
  const id = /\/dns_records\/([^/]+)$/u.exec(url.pathname)?.[1];
  return (async () => {
    if (request.method === "GET") {
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      const result = [...records.values()].filter(
        (record) =>
          (type === null || record.type === type) &&
          (name === null || record.name === name),
      );
      return Response.json({ success: true, result });
    }
    if (request.method === "DELETE") {
      writes.push({ method: "DELETE", record: records.get(id) ?? null });
      records.delete(id);
      return Response.json({ success: true, result: { id } });
    }
    const body = await request.json();
    const recordId = id ?? `record_${nextRecord++}`;
    const record = { ...body, id: recordId };
    records.set(recordId, record);
    writes.push({ method: request.method, record });
    return Response.json({ success: true, result: record });
  })();
}

const MODEL = "https://openrouter.ai/api/v1/chat/completions";
const FALLBACK_TEXT = "Label the second tray.";
const CARD_ANSWER = "The card is ready. Please confirm it.";
const LONG_ANSWER =
  "Two trays are in the second oven. The timer is set. I also checked the butter.";
const aiCalls = [];
const modelRequests = [];
/** A turn that lasts long enough for the next spoken command to find it working. */
const SLOW_TURNS = [
  [/second oven/iu, 14_000],
  [/financiers/iu, 12_000],
  [/croissants/iu, 25_000],
];
/** The first sentence and the next word come long before the rest. A sentence's end shows when the next word comes. */
const FIRST_SENTENCE = "The flour count is twelve bags. The";
const REST_OF_ANSWER = " sugar is low. I also checked the butter.";
const REST_AFTER_MS = 12_000;

function toolCallStream(name, args, callId) {
  const base = {
    id: `shop_voice_${callId}`,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
  };
  const chunks = [
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
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function offeredProposal(body) {
  return (body.tools ?? []).some(
    (tool) => tool.function?.name === "configuration_propose",
  );
}

/** A setup change for a spoken approval: the agent stages it, and the card waits. */
function stageArea(body) {
  const messages = body.messages ?? [];
  const start = messages.findLastIndex((message) => message.role === "user");
  const called = messages
    .slice(start)
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.function?.name);
  if (called.includes("configuration_propose")) return null;
  if (called.includes("tool_search") && !offeredProposal(body)) {
    console.log(
      `The search offered: ${JSON.stringify(body.tools?.map((tool) => tool.function?.name))}`,
    );
    throw new Error("The search did not offer configuration_propose");
  }
  return offeredProposal(body)
    ? toolCallStream(
        "configuration_propose",
        {
          request: {
            command: {
              kind: "create_area",
              name: "Pastry",
              purpose: "Pastry production",
            },
          },
        },
        `propose_${modelRequests.length}`,
      )
    : toolCallStream(
        "tool_search",
        { query: "configuration_propose", limit: 1 },
        `search_${modelRequests.length}`,
      );
}

async function model(request) {
  const body = await request.json();
  const latest = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  const asked = JSON.stringify(latest?.content ?? "");
  modelRequests.push(asked.slice(-300));
  const staging = /new area/iu.test(asked.slice(-300));
  if (staging) {
    const stage = stageArea(body);
    if (stage !== null) return stage;
  }
  const slow = SLOW_TURNS.find(([pattern]) => pattern.test(asked.slice(-300)));
  if (slow) await sleep(slow[1]);
  const base = {
    id: `shop_voice_${modelRequests.length}`,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
  };
  if (/flour/iu.test(asked.slice(-300))) {
    const line = (delta, finish, extra = {}) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              line(
                {
                  role: "assistant",
                  content: `{"kind":"reply","text":"${FIRST_SENTENCE}`,
                },
                null,
              ),
            ),
          );
          await sleep(REST_AFTER_MS);
          controller.enqueue(
            encoder.encode(
              line({ content: `${REST_OF_ANSWER}"}` }, null) +
                line({}, "stop", {
                  usage: {
                    prompt_tokens: 20,
                    completion_tokens: 5,
                    total_tokens: 25,
                  },
                }) +
                "data: [DONE]\n\n",
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: JSON.stringify({
              kind: "reply",
              text: staging ? CARD_ANSWER : LONG_ANSWER,
            }),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

const account = await startAccountWorker({
  artifact,
  name: "satyr-shop-voice-account-authority",
  database: {
    name: "shop-voice-account-authority",
    id: "00000000-0000-0000-0000-000000000582",
  },
  persistence,
  port: port + 1,
  keys,
});

async function respond(request) {
  const url = new URL(request.url);
  if (url.hostname === "api.cloudflare.com") return dnsApi(request, url);
  if (request.url === MODEL) return model(request);
  if (url.pathname === "/ai") {
    aiCalls.push(await request.json());
    return Response.json({ text: FALLBACK_TEXT });
  }
  if (url.hostname === "shop-voice-fixture.internal")
    return Response.json({
      records: [...records.values()],
      writes,
      aiCalls,
      modelRequests,
    });
  throw new Error(`Unexpected external request: ${request.url}`);
}

const worker = await startFixtureWorker({
  config,
  persistence,
  port,
  keys,
  account: (request) => account.fetch(request),
  bindings: {
    // This shop has no commerce backend. An agent turn reads it, and each read
    // finds it unavailable, as a shop with Commerce down would.
    UNDERCLERK: {
      type: "fetcher",
      fetcher: () => new Response(null, { status: 503 }),
    },
    SATYR_PUBLIC_ORIGIN: text(
      process.env.SHOP_VOICE_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
    ),
  },
  respond,
});
stopOnSignal(worker, account);
