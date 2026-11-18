import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  GenerationTask,
  Harness,
  ToolTask,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

const SCENARIOS = new Set([
  "receipt_recovery",
  "unsafe_default",
  "revoked_authority",
  "model_interruption",
  "cancelled",
  "no_alarm",
  "hook_denial",
  "transport_denial",
]);

export class CandidateActor extends DurableObject {
  runtime = null;
  driving = false;

  async provider(path, body, signal) {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    const response = await fetch(this.env.PROVIDER_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario, ...body }),
      signal,
    });
    if (!response.ok)
      throw new Error(`Fixture provider returned ${response.status}`);
    return response.json();
  }

  async modelResponse(context, options) {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    if (scenario === "transport_denial") {
      await this.provider("/transport-denied", {}, options?.signal);
      throw new Error("Evaluation model authority denied at transport");
    }
    const result = await this.provider(
      "/model",
      { messages: context.messages },
      options?.signal,
    );
    return fauxAssistantMessage(result.content, {
      stopReason: result.stopReason,
    });
  }

  async beforeRequest() {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    if (scenario === "hook_denial") {
      throw new Error("Evaluation model authority denied in hook");
    }
  }

  async beforeTool(call) {
    await this.provider("/before-tool", { name: call.name, callId: call.id });
  }

  async executeTool(name, _args, api, context) {
    const identity = { name, operationId: `operation-${api.taskId}` };
    const authority = await this.provider(
      "/authorize",
      identity,
      context.abortSignal,
    );
    if (!authority.allowed)
      throw new Error("Evaluation tool authority revoked");
    if (name === "publish_product") {
      const existing = await this.provider(
        "/receipt",
        identity,
        context.abortSignal,
      );
      if (existing.receipt !== null) return toolResult(existing.receipt);
      const result = await this.provider(
        "/effect",
        identity,
        context.abortSignal,
      );
      return toolResult(result.receipt);
    }
    const result = await this.provider("/read", identity, context.abortSignal);
    return toolResult(result);
  }

  report({ error }) {
    this.ctx.storage.sql.exec(
      "INSERT INTO evaluation_reports (message) VALUES (?)",
      error instanceof Error ? error.message : String(error),
    );
  }

  async initialize() {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS evaluation_reports (message TEXT NOT NULL)",
    );
    const storage = await SqliteStorage.open(
      new ActorSqliteDatabase(this.ctx.storage),
    );
    const registry = createRegistry();
    const publish = {
      name: "publish_product",
      description: "Apply the operator-approved product update.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: this.executeTool.bind(this, "publish_product"),
    };
    if (scenario !== "unsafe_default") publish.replay = "safe";
    registry.install(
      defineExtension({
        name: "satyr-evaluation",
        tools: [
          defineTool(publish),
          defineTool({
            name: "read_product",
            description: "Read the product after its update.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            replay: "safe",
            execute: this.executeTool.bind(this, "read_product"),
          }),
        ],
        hooks: [
          hook(ToolTask, { beforeTool: this.beforeTool.bind(this) }),
          hook(GenerationTask, {
            beforeRequest: this.beforeRequest.bind(this),
          }),
        ],
      }),
    );
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses(Array(20).fill(this.modelResponse.bind(this)));
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { retry: { maxRetries: 0 }, compaction: { enabled: false } },
        onReport: this.report.bind(this),
      },
      BACKGROUND_CONTEXT,
    );
    const model = faux.getModel();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    return { harness, root };
  }

  getRuntime() {
    if (this.runtime === null) this.runtime = this.initialize();
    return this.runtime;
  }

  async schedule() {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    if (scenario !== "no_alarm")
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async drive() {
    if (this.driving) return;
    this.driving = true;
    try {
      const { harness, root } = await this.getRuntime();
      harness.resume();
      await root.waitForIdle(BACKGROUND_CONTEXT);
      await this.ctx.storage.deleteAlarm();
    } finally {
      this.driving = false;
    }
  }

  async alarm() {
    await this.schedule();
    this.ctx.waitUntil(this.drive());
  }

  snapshot() {
    const tables = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray();
    const names = new Set(tables.map(tableName));
    return {
      entries: readRecords(this.ctx.storage.sql, names, "entries"),
      tasks: readRecords(this.ctx.storage.sql, names, "tasks"),
      submissions: readRecords(this.ctx.storage.sql, names, "submissions"),
      reports: names.has("evaluation_reports")
        ? this.ctx.storage.sql
            .exec("SELECT message FROM evaluation_reports")
            .toArray()
        : [],
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const scenario = url.searchParams.get("scenario");
    if (!SCENARIOS.has(scenario))
      return new Response("Invalid scenario", { status: 400 });
    if (url.pathname === "/snapshot") return Response.json(this.snapshot());
    if (url.pathname === "/start") {
      await this.ctx.storage.put("evaluation_scenario", scenario);
      await this.schedule();
      const { root } = await this.getRuntime();
      const submission = await root.submit(
        {
          type: "input",
          content: "Apply the approved update, read it back, and report.",
          requestId: "request-1",
        },
        BACKGROUND_CONTEXT,
      );
      this.ctx.waitUntil(this.drive());
      return Response.json({ submissionId: submission.id });
    }
    const { root } = await this.getRuntime();
    if (url.pathname === "/cancel") {
      await root.abort(BACKGROUND_CONTEXT);
      return Response.json({ cancelled: true });
    }
    if (url.pathname === "/resume") {
      await this.schedule();
      this.ctx.waitUntil(this.drive());
      return Response.json({ resumed: true });
    }
    return new Response("Unknown path", { status: 404 });
  }
}

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function tableName(row) {
  return row.name;
}

function decodeRecord(row) {
  return JSON.parse(row.record);
}

function readRecords(sql, tables, name) {
  if (!tables.has(name)) return [];
  return sql
    .exec(`SELECT record FROM ${name} ORDER BY id`)
    .toArray()
    .map(decodeRecord);
}

export default {
  fetch(request, env) {
    const scenario = new URL(request.url).searchParams.get("scenario");
    if (!SCENARIOS.has(scenario))
      return new Response("Invalid scenario", { status: 400 });
    return env.CANDIDATE.getByName(scenario).fetch(request);
  },
};
