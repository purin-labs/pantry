/**
 * Live Gemini key check (Plan 96, step B4).
 *
 * The E2E journey `gemini-key-portal.test.ts` answers the Gemini API with a
 * fake. This check proves what the fake cannot: a real Gemini API key runs a
 * tool loop of two calls on each model of the Gemini key route, through the
 * same Pi provider and catalog rows that Pantry uses, and Google accepts the
 * thought signatures that Pi sends back.
 *
 * It calls the Gemini API from this machine, so it does not prove the model
 * exit Worker. Run it before the production turn: a failure here is a fault
 * of the key, its Google Cloud project or a model id, not of Pantry's route.
 *
 * It refuses to run without a key. It prints and stores no part of the key.
 *
 *   GEMINI_LIVE_ENV_FILE=<the env file with GEMINI_API_KEY> \
 *   pnpm --filter @purin-labs/platform gemini:live-key
 *
 * The key comes from GEMINI_API_KEY in the environment, or from that one name
 * in the file that GEMINI_LIVE_ENV_FILE names. GEMINI_LIVE_MODELS takes a
 * comma-separated list of model ids; GEMINI_LIVE_EVIDENCE names the evidence
 * file.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type {
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { ORGANISATION_GOOGLE_MODEL_OPTIONS } from "@purin-labs/agent/models/catalog";

const MAX_MODEL_REQUESTS = 6;

const TOOLS: Tool[] = [
  {
    name: "read_stock",
    description: "Reads how many pieces of one product the shop has.",
    parameters: {
      type: "object",
      properties: { product: { type: "string" } },
      required: ["product"],
    },
  },
  {
    name: "record_count",
    description:
      "Records a stock count for one product. Returns the receipt code.",
    parameters: {
      type: "object",
      properties: {
        product: { type: "string" },
        pieces: { type: "integer" },
      },
      required: ["product", "pieces"],
    },
  },
];

type ModelEvidence = Readonly<{
  model: string;
  status: "passed" | "failed";
  failures: readonly string[];
  modelRequests: number;
  toolCalls: readonly string[];
  signedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}>;

async function main(): Promise<void> {
  const apiKey = await readApiKey();
  if (!apiKey)
    throw new Error(
      "The live check requires GEMINI_API_KEY, in the environment or in the file that GEMINI_LIVE_ENV_FILE names.",
    );
  const requested = process.env.GEMINI_LIVE_MODELS?.split(",") ?? null;
  const models = ORGANISATION_GOOGLE_MODEL_OPTIONS.map(
    (option) => option.id as string,
  ).filter((id) => requested === null || requested.includes(id));
  if (models.length === 0)
    throw new Error(
      "GEMINI_LIVE_MODELS names no model of the Gemini key route.",
    );

  const results: ModelEvidence[] = [];
  for (const model of models) results.push(await checkModel(apiKey, model));

  const failed = results.filter((result) => result.status === "failed");
  const evidencePath =
    process.env.GEMINI_LIVE_EVIDENCE ?? "gemini-key-live-check-evidence.json";
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        kind: "pantry.gemini-key.live-check.v1",
        checkedAt: new Date().toISOString(),
        status: failed.length === 0 ? "passed" : "failed",
        results,
      },
      null,
      2,
    )}\n`,
  );
  for (const result of results)
    process.stdout.write(
      `${result.status}: ${result.model}, ${result.modelRequests} model request(s), ` +
        `${result.signedToolCalls}/${result.toolCalls.length} signed tool call(s), ` +
        `$${result.costUsd.toFixed(4)}${result.failures.length > 0 ? `, ${result.failures.join(", ")}` : ""}\n`,
    );
  process.stdout.write(`evidence ${evidencePath}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

/** Only the key leaves the env file: its other secrets stay out of the process. */
async function readApiKey(): Promise<string | undefined> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const file = process.env.GEMINI_LIVE_ENV_FILE;
  if (!file) return undefined;
  return parseEnv(await readFile(file, "utf8")).GEMINI_API_KEY;
}

/** One tool loop of two calls: the answer needs the result of the second. */
async function checkModel(
  apiKey: string,
  modelId: string,
): Promise<ModelEvidence> {
  const startedAt = Date.now();
  const provider = googleProvider();
  const model = provider.getModels().find((entry) => entry.id === modelId);
  const pieces = 20 + Math.floor(Math.random() * 60);
  const receipt = `live-${randomUUID().slice(0, 8)}`;
  const failures: string[] = [];
  const toolCalls: string[] = [];
  let signedToolCalls = 0;
  let modelRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let answer = "";

  if (model === undefined) {
    failures.push("model_not_in_pi_catalog");
  } else {
    const messages: Message[] = [
      {
        role: "user",
        content:
          "Read the stock of the product croissant. Then record that count for croissant. " +
          "Then answer with one short sentence that contains the receipt code.",
        timestamp: Date.now(),
      },
    ];
    while (modelRequests < MAX_MODEL_REQUESTS) {
      modelRequests += 1;
      const message: AssistantMessage = await provider
        .streamSimple(
          model,
          normalizeContext({
            systemPrompt: "You count stock for a bakery. Use the tools.",
            messages,
            tools: TOOLS,
          }),
          { apiKey, reasoning: "high", maxTokens: 4_096, maxRetries: 0 },
        )
        .result();
      inputTokens += message.usage.input + message.usage.cacheRead;
      outputTokens += message.usage.output;
      costUsd += message.usage.cost.total;
      messages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        // The provider message can quote the request. Keep only its class.
        failures.push(`provider_${providerErrorClass(message.errorMessage)}`);
        break;
      }
      const calls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (calls.length === 0) {
        answer = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        break;
      }
      for (const call of calls) {
        toolCalls.push(call.name);
        if (call.thoughtSignature !== undefined) signedToolCalls += 1;
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: toolResult(call, pieces, receipt) }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
    if (failures.length === 0) {
      if (!toolCalls.includes("read_stock"))
        failures.push("no_read_stock_call");
      if (!toolCalls.includes("record_count"))
        failures.push("no_record_count_call");
      if (signedToolCalls === 0) failures.push("no_thought_signature");
      if (!answer.includes(receipt)) failures.push("answer_without_receipt");
    }
  }

  return {
    model: modelId,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    modelRequests,
    toolCalls,
    signedToolCalls,
    inputTokens,
    outputTokens,
    costUsd,
    durationMs: Date.now() - startedAt,
  };
}

/** The receipt code comes only from a count that repeats the stock read. */
function toolResult(call: ToolCall, pieces: number, receipt: string): string {
  if (call.name === "read_stock") return JSON.stringify({ pieces });
  if (call.name === "record_count" && call.arguments.pieces === pieces)
    return JSON.stringify({ recorded: true, receipt });
  return JSON.stringify({ recorded: false, reason: "count_mismatch" });
}

function providerErrorClass(message: string | undefined): string {
  const text = message ?? "";
  const status = text.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (/API key not valid|API_KEY_INVALID/i.test(text)) return "key_invalid";
  if (/location is not supported/i.test(text)) return "location_refused";
  if (/quota|RESOURCE_EXHAUSTED/i.test(text)) return "quota_exhausted";
  if (/not found|NOT_FOUND/i.test(text)) return "model_not_found";
  return status === undefined ? "error" : `status_${status}`;
}

await main();
