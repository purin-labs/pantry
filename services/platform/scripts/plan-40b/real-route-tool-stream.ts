/**
 * Plan 40B phase 7: how does a real model route stream the arguments of a
 * `menu_board_edit` call?
 *
 * The script sends one board request to a real provider with pi-ai, the
 * provider code that the Session uses, the production tool schema and the
 * production thinking level of the route. It feeds every model event into
 * the real `PiToolArgumentStream` and records when each part arrives, when
 * the whole rect is known and how the text grows. It writes no secret: the
 * key is read here and goes only to the provider.
 *
 * Build and run (from services/platform):
 *   npx esbuild scripts/plan-40b/real-route-tool-stream.ts --bundle \
 *     --platform=node --format=esm --outfile=<scratch>/stream.mjs \
 *     --external:cloudflare:* --log-level=error
 *   node <scratch>/stream.mjs --route openrouter --model qwen/qwen3.7-flash \
 *     --env <repo>/.env.local --runs 3 --out <file.json>
 *
 * Routes: `openrouter` (platform + openai-compatible, OPENROUTER_API_KEY),
 * `openai` (organisation_byo + openai, OPENAI_API_KEY) and `openai-codex`
 * (organisation_subscription + openai, a ChatGPT sign-in access token from
 * the Codex CLI file `~/.codex/auth.json`) and `anthropic` (organisation_byo
 * + anthropic, ANTHROPIC_API_KEY). Each frame also records `previewRect`, the
 * rect that the production preview code (`draftEdit`) would draw. The run calls the provider from
 * this machine, not through the exit Workers; they pass the response body
 * through as a stream.
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import type {
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { PiToolArgumentStream } from "../../src/actors/pi-tool-argument-stream";
import { menuBoardEdit } from "../../src/agent-tools/drafts/drafts";
import { draftEdit } from "../../src/agent-tools/drafts/board-draft-edit";

type Route = "openrouter" | "openai" | "openai-codex" | "anthropic";

const BOARD_ID = "board_measure_1";
const SYSTEM_PROMPT =
  "You are Satyr, the agent of a café. You edit the café's menu boards with menu_board_edit. Make the change that the person asks for with one tool call, then stop.";
const REQUEST =
  `Board ${BOARD_ID} is a free canvas board (layout canvas_landscape, 1600 by 900). ` +
  "Add a text note at x 80, y 760, 640 wide and 96 high, that says: " +
  '"Oat milk at no extra cost today. Ask us about the seasonal yuzu tart, baked this morning."';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function routeKey(route: Route, envFile: string): Promise<string> {
  if (route === "openai-codex") {
    const auth = JSON.parse(
      await readFile(`${homedir()}/.codex/auth.json`, "utf8"),
    ) as { tokens?: { access_token?: unknown } };
    const token = auth.tokens?.access_token;
    if (typeof token !== "string" || token === "")
      throw new Error("No ChatGPT sign-in in ~/.codex/auth.json");
    return token;
  }
  const variables = parseEnv(await readFile(envFile, "utf8"));
  const name =
    route === "openrouter"
      ? "OPENROUTER_API_KEY"
      : route === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENAI_API_KEY";
  const key = variables[name];
  if (!key) throw new Error(`${name} is not in ${envFile}`);
  return key;
}

/** The same model values as `pi-model-transport.ts` for each route. */
function routeModel(route: Route, modelId: string) {
  switch (route) {
    case "openrouter": {
      const model: Model<"openai-completions"> = {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000,
        maxTokens: 4_096,
        compat: {
          supportsDeveloperRole: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
          openRouterRouting: { sort: "throughput" },
          sendSessionAffinityHeaders: true,
          sessionAffinityFormat: "openrouter",
          supportsStrictMode: true,
        },
      };
      return {
        provider: openrouterProvider(),
        model,
        reasoning: "minimal" as const,
      };
    }
    case "openai": {
      const provider = openaiProvider();
      const model = provider.getModels().find((each) => each.id === modelId);
      if (model === undefined) throw new Error(`pi-ai has no ${modelId}`);
      return { provider, model, reasoning: "high" as const };
    }
    case "openai-codex": {
      const provider = openaiCodexProvider();
      const model = provider.getModels().find((each) => each.id === modelId);
      if (model === undefined) throw new Error(`pi-ai has no ${modelId}`);
      return { provider, model, reasoning: "high" as const };
    }
    case "anthropic": {
      const provider = anthropicProvider();
      const model = provider.getModels().find((each) => each.id === modelId);
      if (model === undefined) throw new Error(`pi-ai has no ${modelId}`);
      return { provider, model, reasoning: "high" as const };
    }
  }
}

type Frame = {
  readonly t: number;
  readonly fields: readonly string[];
  readonly rect: boolean;
  readonly rectValues: readonly unknown[];
  readonly previewRect: boolean;
  readonly textLength: number;
  readonly complete: boolean;
};

async function measure(route: Route, modelId: string, key: string) {
  const { provider, model, reasoning } = routeModel(route, modelId);
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: REQUEST, timestamp: Date.now() }],
    tools: [
      {
        name: menuBoardEdit.name,
        description: menuBoardEdit.description,
        parameters: menuBoardEdit.input as object,
      },
    ],
  };
  const frames: Frame[] = [];
  const deltas: { t: number; bytes: number }[] = [];
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);
  const stream = new PiToolArgumentStream({
    observe(call) {
      if (call.name !== "menu_board_edit") return;
      const value = call.arguments;
      frames.push({
        t: at(),
        fields: Object.keys(value),
        rect: ["x", "y", "width", "height"].every(
          (field) => typeof value[field] === "number",
        ),
        rectValues: ["x", "y", "width", "height"].map((field) => value[field]),
        previewRect: draftEdit(value)?.rect != null,
        textLength: typeof value.text === "string" ? value.text.length : 0,
        complete: call.complete,
      });
    },
    abandon() {},
  });
  const options: SimpleStreamOptions = {
    apiKey: key,
    reasoning,
    maxTokens: 4_096,
    sessionId: `plan-40b-measure-${crypto.randomUUID()}`,
    ...(route === "openai-codex" ? { transport: "sse" as const } : {}),
  };
  let firstEvent: number | null = null;
  let toolStart: number | null = null;
  let toolEnd: number | null = null;
  let textBeforeTool = 0;
  let stopReason: string | null = null;
  let error: string | null = null;
  const events = provider.streamSimple(
    model as never,
    normalizeContext(context),
    options,
  );
  for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
    firstEvent ??= at();
    stream.accept(event);
    switch (event.type) {
      case "text_delta":
        if (toolStart === null) textBeforeTool += event.delta.length;
        break;
      case "toolcall_start":
        toolStart ??= at();
        break;
      case "toolcall_delta":
        deltas.push({ t: at(), bytes: Buffer.byteLength(event.delta) });
        break;
      case "toolcall_end":
        toolEnd ??= at();
        break;
      case "done":
        stopReason = event.reason;
        break;
      case "error":
        stopReason = event.reason;
        error = event.error.errorMessage ?? "error";
        break;
      default:
        break;
    }
  }
  const gaps = deltas
    .slice(1)
    .map((delta, index) => delta.t - deltas[index]!.t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const partial = frames.filter((frame) => !frame.complete);
  const firstRect = partial.find((frame) => frame.rect)?.t ?? null;
  const firstPreviewRect =
    partial.find((frame) => frame.previewRect)?.t ?? null;
  const firstText = partial.find((frame) => frame.textLength > 0)?.t ?? null;
  return {
    route,
    model: modelId,
    stopReason,
    error,
    firstEventMs: firstEvent,
    textCharactersBeforeTool: textBeforeTool,
    toolcallStartMs: toolStart,
    toolcallEndMs: toolEnd,
    argumentParts: deltas.length,
    argumentPartBytes: deltas.map((delta) => delta.bytes),
    partGapMs: {
      min: sorted[0] ?? null,
      median: sorted[Math.floor(sorted.length / 2)] ?? null,
      max: sorted.at(-1) ?? null,
    },
    argumentStreamMs:
      toolStart === null || toolEnd === null ? null : toolEnd - toolStart,
    partialFrames: partial.length,
    rectBeforeTextEnds:
      firstRect !== null &&
      partial.some(
        (frame) =>
          frame.rect && frame.textLength < (partial.at(-1)?.textLength ?? 0),
      ),
    firstRectMs: firstRect,
    firstPreviewRectMs: firstPreviewRect,
    firstTextMs: firstText,
    rectBeforeFirstText:
      firstRect !== null && (firstText === null || firstRect <= firstText),
    distinctTextLengths: new Set(
      partial.map((frame) => frame.textLength).filter((length) => length > 0),
    ).size,
    finalTextLength: frames.find((frame) => frame.complete)?.textLength ?? null,
    frames,
  };
}

async function main() {
  const route = argValue("route") as Route | undefined;
  const modelId = argValue("model");
  const out = argValue("out");
  const runs = Number(argValue("runs") ?? "3");
  const envFile = argValue("env") ?? ".env.local";
  if (
    (route !== "openrouter" &&
      route !== "openai" &&
      route !== "openai-codex" &&
      route !== "anthropic") ||
    modelId === undefined ||
    out === undefined
  )
    throw new Error("Give --route, --model and --out");
  const key = await routeKey(route, envFile);
  const results = [];
  for (let run = 0; run < runs; run += 1) {
    try {
      results.push(await measure(route, modelId, key));
    } catch (thrown) {
      results.push({
        route,
        model: modelId,
        error:
          thrown instanceof Error
            ? thrown.message.replaceAll(key, "<key>")
            : "error",
      });
    }
  }
  const record = {
    measuredAt: new Date().toISOString(),
    route,
    model: modelId,
    path: "this machine to the provider, pi-ai streamSimple, PiToolArgumentStream",
    request: REQUEST,
    runs: results,
  };
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  for (const result of results)
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(result).filter(
            ([field]) => field !== "frames" && field !== "argumentPartBytes",
          ),
        ),
      ),
    );
}

await main();
