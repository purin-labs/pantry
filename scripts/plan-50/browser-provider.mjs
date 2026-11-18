import { unstable_startWorker } from "../../services/platform/node_modules/wrangler/wrangler-dist/cli.js";
import { writeFileSync } from "node:fs";

const [config, persistence, evidencePath] = process.argv.slice(2);
const calls = [];
writeFileSync(evidencePath, JSON.stringify({ calls }, null, 2) + "\n");

async function respond(request) {
  if (request.url !== "https://openrouter.ai/api/v1/chat/completions") {
    throw new Error(`Unexpected external request: ${request.url}`);
  }
  const body = await request.json();
  const number = calls.length + 1;
  calls.push({ number, model: body.model, tokens: 25 });
  writeFileSync(evidencePath, JSON.stringify({ calls }, null, 2) + "\n");
  const base = {
    id: `goal_browser_${number}`,
    object: "chat.completion.chunk",
    created: 1787500000,
    model: body.model,
  };
  const content = {
    ...base,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: JSON.stringify({
            kind: "reply",
            text: `Checklist review ${number} completed.`,
          }),
        },
        finish_reason: null,
      },
    ],
  };
  const final = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  };
  return new Response(
    `data: ${JSON.stringify(content)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
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
  await worker.dispose();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
