import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
} from "@earendil-works/pi-codemode/portable";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type Storage,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  governCodeModeRemote,
  type CodeModeExchangeDenial,
  type CodeModeExchangeGate,
  type CodeModeExchangeLimits,
} from "@purin-labs/agent/actors/code-mode-governed-remote";
import { ActorSqliteDatabase } from "@purin-labs/agent/actors/pi-durable-database";

/**
 * State that outlives a process: the providers behind the tools and the owner
 * of effect receipts. A process loss does not reset it.
 */
export type World = {
  readonly dispatches: Map<string, string[]>;
  readonly holds: Map<string, PromiseWithResolvers<void>>;
  readonly reached: Map<string, PromiseWithResolvers<void>>;
};

export function createWorld(): World {
  return {
    dispatches: new Map(),
    holds: new Map(),
    reached: new Map(),
  };
}

export function hold(world: World, key: string): Promise<void> {
  world.holds.set(key, Promise.withResolvers());
  const reached = Promise.withResolvers<void>();
  world.reached.set(key, reached);
  return reached.promise;
}

export function release(world: World, key: string): void {
  const held = world.holds.get(key);
  world.holds.delete(key);
  held?.resolve();
}

export function dispatchCount(world: World, key: string): number {
  return world.dispatches.get(key)?.length ?? 0;
}

const ORDERS: Record<string, { sku: string; quantity: number }[]> = {
  c: [{ sku: "flour", quantity: 1 }],
};

/** The kind of the document in which Pi journals delivered results. */
const CODE_MODE_JOURNAL_KIND = "pi.codemode.journal";

type GateState = {
  alive: boolean;
  readonly denials: CodeModeExchangeDenial[];
  readonly delivered: string[];
  /** The journal as storage held it when the first denial occurred. */
  journalAtDenial: Promise<JournalSize | null> | null;
};

type JournalSize = { entries: number; bytes: number };

class FencedDatabase extends ActorSqliteDatabase {
  dead = false;
  override enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dead) return Promise.reject(new Error("Process lost"));
    return super.enqueue(operation);
  }
}

export type ProbeProcess = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: Storage;
  readonly gate: GateState;
  /** Process loss: no further write, call, or result of this process counts. */
  kill(): void;
};

export type ProbeOptions = {
  readonly world: World;
  readonly faux: FauxProviderHandle;
  readonly executionName: string;
  readonly deadlineAt: number;
  readonly exchangeLimits?: CodeModeExchangeLimits;
};

export async function startProcess(
  actorStorage: DurableObjectStorage,
  options: ProbeOptions,
): Promise<ProbeProcess> {
  const { world, faux } = options;
  const database = new FencedDatabase(actorStorage);
  const storage: Storage = await SqliteStorage.open(database);
  const gate: GateState = {
    alive: true,
    denials: [],
    delivered: [],
    journalAtDenial: null,
  };
  const sandbox = new RemoteCodemodeSandbox({
    remote: governCodeModeRemote({
      remote: sandboxRemote.bind(null, options.executionName),
      gate: exchangeGate(gate, readStoredJournal.bind(null, storage)),
      deadlineAt: options.deadlineAt,
      now: Date.now,
      ...(options.exchangeLimits === undefined
        ? {}
        : { limits: options.exchangeLimits }),
    }),
  });
  const tools = [
    createCodemodeTool({ sandbox, models: false }),
    ...worldTools(world),
  ];
  const extension = defineExtension({ name: "probe.tools", tools });
  const registry = createRegistry();
  registry.install(extension);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      onReport: ignoreReport,
      settings: {
        retry: { maxRetries: 0 },
        compaction: { backgroundTokens: 0 },
      },
    },
    BACKGROUND_CONTEXT,
  );
  const model = faux.getModel();
  const agent = {
    model: { provider: model.provider, modelId: model.id },
    instructions: "Run the requested script.",
    extensions: [extension],
    tools,
  };
  const root = await harness.root(BACKGROUND_CONTEXT, { agent });
  await root.configure(agent, BACKGROUND_CONTEXT);
  return {
    harness,
    root,
    storage,
    gate,
    kill() {
      gate.alive = false;
      database.dead = true;
      void harness.close(BACKGROUND_CONTEXT).catch(ignoreReport);
    },
  };
}

function ignoreReport(): void {}

function sandboxRemote(name: string): CodemodeRemote {
  const stub = env.CODE_MODE_SANDBOX?.getByName(name);
  if (stub === undefined) throw new Error("Missing sandbox binding");
  return {
    async execute(request, exchange) {
      await stub.execute(request, exchange);
    },
  };
}

function exchangeGate(
  state: GateState,
  journal: () => Promise<JournalSize | null>,
): CodeModeExchangeGate {
  return {
    async admitStart() {
      return state.alive ? null : STALE;
    },
    async admitCall() {
      return state.alive ? null : STALE;
    },
    async admitResult(call) {
      if (!state.alive) return STALE;
      state.delivered.push(`${call.target}:${call.name}#${call.id}`);
      return null;
    },
    denied(denial) {
      state.denials.push(denial);
      state.journalAtDenial ??= journal().catch(noJournal);
    },
    ended() {},
  };
}

const STALE: CodeModeExchangeDenial = {
  code: "code_mode_lease_stale",
  reason: "A later process holds the execution lease",
};

async function dispatched(
  world: World,
  key: string,
  api: ToolExecutionApi,
  context: Context,
): Promise<void> {
  world.dispatches.set(key, [...(world.dispatches.get(key) ?? []), api.callId]);
  world.reached.get(key)?.resolve();
  const held = world.holds.get(key);
  if (held === undefined) return;
  const aborted = Promise.withResolvers<void>();
  const signal = context.abortSignal;
  const abort = () => aborted.reject(new Error("Tool call aborted"));
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([held.promise, aborted.promise]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function worldTools(world: World): ToolRegistration[] {
  return [
    defineTool({
      name: "orders_read",
      description: "Read one page of orders of a shop.",
      parameters: Type.Object({ shop: Type.String() }),
      structuredOutputSchema: Type.Object({
        shop: Type.String(),
        orders: Type.Array(
          Type.Object({ sku: Type.String(), quantity: Type.Number() }),
        ),
      }),
      callers: ["tools"],
      replay: "safe",
      async execute(args, api, context) {
        await dispatched(world, `orders_read:${args.shop}`, api, context);
        const value = { shop: args.shop, orders: ORDERS[args.shop] ?? [] };
        return {
          output: [{ type: "text", text: JSON.stringify(value) }],
          structuredOutput: value,
        };
      },
    }),
  ];
}

export type ScriptOutcome = {
  /** The tool result of the script, as the model reads it. */
  readonly text: string;
  readonly isError: boolean;
  readonly modelCalls: number;
};

/** One accepted turn: the model writes `code`, then reads its result. */
export function scriptTurn(code: string): {
  readonly faux: FauxProviderHandle;
  outcome(): ScriptOutcome;
} {
  const faux = fauxProvider();
  let text = "";
  let isError = false;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], {
      stopReason: "toolUse",
    }),
    readResult,
  ]);
  function readResult(context: TranscriptContext) {
    const result = context.messages.findLast(isToolResult);
    if (result !== undefined) {
      isError = result.isError;
      text = result.content.map(contentText).join("\n");
    }
    return fauxAssistantMessage("Done.");
  }
  return {
    faux,
    outcome() {
      return { text, isError, modelCalls: faux.state.callCount };
    },
  };
}

function isToolResult(
  message: TranscriptContext["messages"][number],
): message is Extract<
  TranscriptContext["messages"][number],
  { role: "toolResult" }
> {
  return message.role === "toolResult";
}

function contentText(item: { type: string; text?: string }): string {
  return item.type === "text" ? (item.text ?? "") : `[${item.type}]`;
}

export async function submitScript(process: ProbeProcess): Promise<void> {
  await process.root.submit(
    {
      type: "input",
      requestId: "request_1",
      content: [{ type: "text", text: "Run the script." }],
      whenBusy: "reject",
    },
    BACKGROUND_CONTEXT,
  );
}

export async function finish(process: ProbeProcess): Promise<void> {
  process.harness.resume();
  await process.harness.waitForIdle(BACKGROUND_CONTEXT);
}

function noJournal(): null {
  return null;
}

async function readStoredJournal(
  storage: Storage,
): Promise<JournalSize | null> {
  const tasks = await storage.scanTasks({}, 200, undefined, BACKGROUND_CONTEXT);
  for (const task of tasks.items) {
    const documents = await storage.scanDocuments(
      {
        scope: { kind: "task", taskId: task.id },
        at: "current",
        kind: CODE_MODE_JOURNAL_KIND,
      },
      10,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const record = documents.items[0];
    if (record === undefined) continue;
    const stored = await storage.document(
      record.id,
      "current",
      BACKGROUND_CONTEXT,
    );
    if (stored === undefined) continue;
    const entries = stored.value.entries;
    return {
      entries: Array.isArray(entries) ? entries.length : 0,
      bytes: new TextEncoder().encode(JSON.stringify(stored.value)).byteLength,
    };
  }
  return null;
}
