import { unstable_startWorker } from "../../services/platform/node_modules/wrangler/wrangler-dist/cli.js";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const [config, persistence, evidencePath] = process.argv.slice(2);
const calls = [];
let failed = false;
let release = null;
const control = createServer(controlRequest);
control.listen(8835, "127.0.0.1");
function controlRequest(request, response) {
  if (request.url === "/release" && release !== null) {
    release();
    release = null;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ waiting: release !== null, calls: calls.length }),
  );
}
function waitForHuman(resolve) {
  release = resolve;
}
function record() {
  writeFileSync(evidencePath, JSON.stringify({ calls }, null, 2) + "\n");
}
record();
function stream(number, delta, finish) {
  const base = {
    id: `canvas_browser_${number}`,
    object: "chat.completion.chunk",
    created: 1787500000,
    model: "moonshotai/kimi-k3",
  };
  const first = {
    ...base,
    choices: [
      { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null },
    ],
  };
  const last = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  return new Response(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function tool(number, name, args) {
  return stream(
    number,
    {
      tool_calls: [
        {
          index: 0,
          id: `canvas_call_${number}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}
function reply(number, text) {
  return stream(
    number,
    { content: JSON.stringify({ kind: "reply", text }) },
    "stop",
  );
}
async function respond(request) {
  if (request.url !== "https://openrouter.ai/api/v1/chat/completions")
    throw new Error(`Unexpected external request: ${request.url}`);
  const body = await request.json();
  const number = calls.length + 1;
  calls.push({ number, messages: body.messages });
  record();
  const lastUser = body.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const userContent = body.messages[lastUser].content;
  const prompt =
    typeof userContent === "string"
      ? userContent
      : userContent.map((part) => part.text ?? "").join("\n");
  const text = prompt.slice(prompt.lastIndexOf("Current workspace request:"));
  if (text.includes("FAIL_ONCE") && !failed) {
    failed = true;
    return Response.json(
      {
        error: {
          message: "Acceptance provider interrupted",
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }
  // The browser gives the synthetic provider a deterministic target in the user request.
  const matches = [
    ...text.matchAll(/CANVAS_MOVE (run:[a-f0-9]{64}) ([A-Za-z0-9_-]+)/g),
  ];
  const target = matches.at(-1);
  if (!target) return reply(number, "Canvas request completed.");
  const current = body.messages.slice(lastUser + 1);
  const results = current.filter((message) => message.role === "tool");
  if (results.length === 0)
    return tool(number, "tool_search", {
      query: "workflow_canvas_read move_object",
      limit: 20,
    });
  if (results.length === 1)
    return tool(number, "workflow_canvas_read", { documentId: target[1] });
  if (results.length === 2) {
    const read = JSON.parse(results[1].content);
    const revision = read.code_mode_value?.documentRevision;
    if (!Number.isInteger(revision))
      throw new Error(`Canvas read failed: ${results[1].content}`);
    if (text.includes("HUMAN_PAUSE")) await new Promise(waitForHuman);
    return tool(number, "move_object", {
      documentId: target[1],
      objectId: target[2],
      expectedRevision: revision,
      x: 450,
      y: 220,
    });
  }
  return reply(number, "Canvas move completed.");
}
const worker = await unstable_startWorker({
  config,
  build: { nodejsCompatMode: "v2" },
  dev: {
    remote: false,
    persist: persistence,
    server: { hostname: "127.0.0.1", port: 8834 },
    inspector: false,
    watch: false,
    outboundService: respond,
  },
});
await worker.ready;
async function stop() {
  control.close();
  await worker.dispose();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
