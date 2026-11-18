import { canonicalFact } from "../../services/platform/src/actors/pi-durable-history.ts";
import { armAlarmBy } from "../../services/platform/src/actors/lifecycle/actor-alarm.ts";
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  CompactionEntry,
  createRegistry,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  appendHarnessHistory,
  createSessionHarnessAuthoritySchema,
  parsePersistedHarnessTurnLease,
  preflightHarnessTurnLease,
  readHarnessHistory,
} from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";

const SESSION_ID = "session_plan50_seams";
const TURN = {
  turnId: "turn_plan50_seams",
  inputId: "input_plan50_seams",
  turnLeaseGeneration: 1,
  budgetRevision: "budget_plan50_seams",
};
const INPUT = {
  kind: "case",
  inputId: TURN.inputId,
  caseId: "case_plan50_seams",
  assignmentId: "assignment_plan50_seams",
  caseRevision: 1,
  contentDigest: "c".repeat(64),
  workspaceRevision: "workspace_plan50_seams",
  contextBundleDigest: "d".repeat(64),
};

class AcceptedSqliteDatabase extends ActorSqliteDatabase {
  facts = [];

  constructor(storage, actor) {
    super(storage);
    this.actor = actor;
  }

  // Pi reads documents in transactions while a commit is stored, so only the
  // commit's own transaction takes its facts.
  transaction(callback) {
    const facts = this.facts;
    const transaction = super.transaction(
      this.accept.bind(this, callback, facts),
    );
    this.facts = [];
    return transaction;
  }

  async accept(callback, facts, executor) {
    const previousTokens = this.actor.nativeModelTokens();
    const result = await callback(executor);
    const { next_seq: nextSeq } = await executor.get(
      "SELECT next_seq FROM durable_metadata WHERE singleton = 1",
    );
    await this.actor.acceptNativeModelUsage(
      this.actor.nativeModelTokens() - previousTokens,
      nextSeq - 1,
    );
    // This still runs inside the outer Actor transaction, before Pi publishes.
    await this.actor.acceptFacts(facts);
    return result;
  }
}

function keepReceipt(receipt, _index, seq) {
  receipt.seq = seq;
}

function bindStorageProperty(target, key, receiver) {
  const value = Reflect.get(target, key, receiver);
  return typeof value === "function" ? value.bind(target) : value;
}

function storageProperty(actor, database, target, key, receiver) {
  if (key === "commit") return actor.commit.bind(actor, target, database);
  return bindStorageProperty(target, key, receiver);
}

export class CandidateActor extends DurableObject {
  runtime = null;
  driving = false;
  publications = [];

  constructor(ctx, env) {
    super(ctx, env);
    this.initializeAdmission();
  }

  initializeAdmission() {
    const ctx = this.ctx;
    createSessionHarnessAuthoritySchema(ctx.storage.sql);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS evaluation_admission (singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    this.ctx.storage.transactionSync(this.recoverAdmission.bind(this));
  }

  recoverAdmission() {
    const admission = this.admission();
    if (admission === null || admission.status !== "admitted") return;
    this.writeLease(admission.generation + 1);
  }

  admission() {
    return (
      this.ctx.storage.sql
        .exec("SELECT generation, status FROM evaluation_admission")
        .toArray()[0] ?? null
    );
  }

  writeLease(generation) {
    const now = Date.now();
    const lease = {
      leaseId: `lease_plan50_${generation}`,
      session: {
        organisationId: "organisation_plan50_seams",
        sessionId: SESSION_ID,
        streamId: "stream_plan50_seams",
      },
      turn: TURN,
      runtimeLease: {
        generation,
        leaseId: `runtime_plan50_${generation}`,
      },
      runtimeRevision: "runtime_plan50_seams",
      requestAuthority: {
        kind: "workflow",
        organisationId: "organisation_plan50_seams",
        workflowId: "workflow_plan50_seams",
        workflowRevision: 1,
      },
      authorityPartitionDigest: "a".repeat(64),
      issuedAt: now,
      expiresAt: now + 60_000,
    };
    if (parsePersistedHarnessTurnLease(lease) === null)
      throw new Error("Invalid evaluation lease");
    this.ctx.storage.sql.exec(
      `INSERT INTO session_harness_lease
       (session_id, organisation_id, lease_id, turn_id, turn_projection, lease_projection, issued_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET lease_id = excluded.lease_id,
       lease_projection = excluded.lease_projection, issued_at = excluded.issued_at,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      SESSION_ID,
      lease.session.organisationId,
      lease.leaseId,
      TURN.turnId,
      JSON.stringify(TURN),
      JSON.stringify(lease),
      now,
      lease.expiresAt,
      now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO evaluation_admission VALUES (1, ?, 'admitted') ON CONFLICT (singleton) DO UPDATE SET generation = excluded.generation",
      generation,
    );
  }

  currentLease() {
    const row = this.ctx.storage.sql
      .exec("SELECT lease_projection FROM session_harness_lease")
      .toArray()[0];
    const lease = row
      ? parsePersistedHarnessTurnLease(JSON.parse(row.lease_projection))
      : null;
    if (lease === null) throw new Error("Missing evaluation lease");
    return lease;
  }

  async provider(path, body, signal) {
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    const response = await fetch(this.env.PROVIDER_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario, ...body }),
      signal,
    });
    if (!response.ok) throw new Error(`Fixture status ${response.status}`);
    return response.json();
  }

  async modelResponse(context, options) {
    if (this.admission()?.status !== "admitted")
      throw new Error("Execution cancelled before model dispatch");
    const lease = this.currentLease();
    const allowed = preflightHarnessTurnLease(
      this.ctx.storage,
      lease,
      Date.now(),
    );
    if (!allowed.ok) throw new Error(allowed.error.code);
    const result = await this.provider(
      "/model",
      { generation: lease.runtimeLease.generation, messages: context.messages },
      options?.signal,
    );
    const stillAllowed = preflightHarnessTurnLease(
      this.ctx.storage,
      lease,
      Date.now(),
    );
    if (!stillAllowed.ok) throw new Error(stillAllowed.error.code);
    return fauxAssistantMessage(result.content, {
      stopReason: result.stopReason ?? "stop",
    });
  }

  registry() {
    return createRegistry();
  }

  harnessSettings() {
    return { retry: { maxRetries: 0 }, compaction: { enabled: false } };
  }

  async initialize() {
    const { models, model } = await this.createModelRegistry();
    const { harness, storage } = await this.openHarness(
      models,
      await this.registry(),
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: this.rootAgent(model),
    });
    return { harness, root, storage };
  }

  async openHarness(models, registry) {
    const database = new AcceptedSqliteDatabase(this.ctx.storage, this);
    const sqlite = await SqliteStorage.open(database);
    const storage = new Proxy(sqlite, {
      get: storageProperty.bind(null, this, database),
    });
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: this.harnessSettings(),
      },
      BACKGROUND_CONTEXT,
    );
    harness.observeCommits({ advance: this.observe.bind(this), end() {} });
    return { harness, storage };
  }

  rootAgent(model) {
    return { model: { provider: model.provider, modelId: model.id } };
  }

  createModelRegistry() {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses(Array(10).fill(this.modelResponse.bind(this)));
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() };
  }

  getRuntime() {
    if (this.runtime === null) this.runtime = this.initialize();
    return this.runtime;
  }

  observe(publication) {
    this.publications.push(publication.seq);
  }

  async commit(sqlite, database, batches, receive, context) {
    for (const [index, writes] of batches.entries()) {
      receive(index, await this.commitBatch(sqlite, database, writes, context));
    }
    return { stored: batches.length };
  }

  async commitBatch(sqlite, database, writes, context) {
    const facts = [];
    for (const write of writes) {
      if (write.type !== "entry" || write.value.kind === CompactionEntry.kind)
        continue;
      for (const message of this.historyMessages(write.value, writes)) {
        const lease = this.currentLease();
        const fact = canonicalFact(
          message,
          lease.turn,
          this.historyInput(lease),
          message.role === "user"
            ? await this.userHistoryContent(message, write.value, writes)
            : null,
        );
        if (fact !== null) facts.push(fact);
      }
    }
    if (
      facts.length > 0 &&
      (await this.ctx.storage.get("evaluation_reject")) === "before_acceptance"
    )
      throw new Error("Injected rejection before local acceptance");
    database.facts = facts;
    const receipt = { seq: null };
    try {
      const result = await sqlite.commit(
        [writes],
        keepReceipt.bind(null, receipt),
        context,
      );
      if (result.stored === 0) throw result.refused;
    } finally {
      database.facts = [];
    }
    const { seq } = receipt;
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    if (scenario === "publication_gap" && facts.some(isAssistantFact))
      await this.provider("/commit-held", { seq });
    return seq;
  }

  nativeModelTokens() {
    return 0;
  }

  historyMessages(entry) {
    return entry.model ?? [];
  }

  acceptNativeModelUsage() {}

  async acceptFacts(facts) {
    for (const fact of facts) {
      const lease = this.currentLease();
      const result = await this.acceptOne(lease, fact);
      if (!result.ok) throw new Error(result.error.code);
    }
    if (facts.length === 0) return;
    await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    const fault = await this.ctx.storage.get("evaluation_reject");
    if (scenario === "atomic_rollback" && fault === "after_writes")
      throw new Error("Injected rejection after both sets of writes");
  }

  acceptOne(lease, fact) {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT history_sequence, history_digest FROM session_harness_lease",
      )
      .toArray()[0];
    return appendHarnessHistory(this.ctx.storage, {
      leaseId: lease.leaseId,
      sessionId: SESSION_ID,
      turn: lease.turn,
      sequence: (row.history_sequence ?? 0) + 1,
      previousDigest: row.history_digest,
      entry: fact,
      acceptedAt: Date.now(),
    });
  }

  historyInput(lease) {
    return { ...INPUT, inputId: lease.turn.inputId };
  }

  async userHistoryContent(message) {
    return [
      {
        kind: "text",
        text:
          typeof message.content === "string"
            ? message.content
            : message.content.map(textContent).join(""),
      },
    ];
  }

  async submit() {
    const { root } = await this.getRuntime();
    return root.submit(
      {
        type: "input",
        content: this.inputContent(),
        requestId: this.currentLease().turn.inputId,
      },
      BACKGROUND_CONTEXT,
    );
  }

  inputContent() {
    return "Verify integrated recovery.";
  }

  async drive() {
    if (this.driving) return;
    this.driving = true;
    try {
      const { harness, root } = await this.getRuntime();
      if (this.admission()?.status === "cancelled")
        await root.abort(BACKGROUND_CONTEXT);
      else harness.resume();
      await root.waitForIdle(BACKGROUND_CONTEXT);
      await this.ctx.storage.deleteAlarm();
    } finally {
      this.driving = false;
    }
  }

  async alarm() {
    await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
    this.ctx.waitUntil(this.drive());
  }

  async snapshot() {
    const tables = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master")
      .toArray();
    const names = new Set(tables.map(tableName));
    const materialization = await readHarnessHistory(
      this.ctx.storage.sql,
      SESSION_ID,
      "organisation_plan50_seams",
    );
    const leaseRows = this.ctx.storage.sql
      .exec("SELECT lease_id FROM session_harness_lease")
      .toArray();
    return {
      admission: this.admission(),
      lease: leaseRows.length === 0 ? null : this.currentLease(),
      history: this.ctx.storage.sql
        .exec(
          "SELECT sequence, previous_digest, entry_digest, payload FROM session_harness_history ORDER BY sequence",
        )
        .toArray(),
      materialization,
      usage: this.ctx.storage.sql
        .exec(
          "SELECT entry_count, inline_byte_count, through_sequence FROM session_harness_usage",
        )
        .toArray(),
      submissions: readRecords(this.ctx.storage.sql, names, "submissions"),
      tasks: readRecords(this.ctx.storage.sql, names, "tasks"),
      entries: readRecords(this.ctx.storage.sql, names, "entries"),
      nextSeq: names.has("durable_metadata")
        ? (this.ctx.storage.sql
            .exec("SELECT next_seq FROM durable_metadata")
            .toArray()[0]?.next_seq ?? null)
        : null,
      publications: this.publications,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot")
      return Response.json(await this.snapshot());
    if (url.pathname === "/start") {
      await this.ctx.storage.put(
        "evaluation_scenario",
        url.searchParams.get("scenario"),
      );
      if (this.admission() === null)
        this.ctx.storage.transactionSync(this.writeLease.bind(this, 1));
      await this.ctx.storage.put(
        "evaluation_reject",
        url.searchParams.get("reject") ?? "none",
      );
      try {
        const submission = await this.submit();
        this.ctx.waitUntil(this.drive());
        return Response.json({ accepted: true, submissionId: submission.id });
      } catch (error) {
        // Pi 1.5 closes a Session after a storage error; the next request
        // opens it again from storage.
        this.runtime = null;
        return Response.json({
          accepted: false,
          error: error.stack ?? String(error),
        });
      }
    }
    if (url.pathname === "/cancel") {
      this.ctx.storage.sql.exec(
        "UPDATE evaluation_admission SET status = 'cancelled'",
      );
      const { root } = await this.getRuntime();
      await root.abort(BACKGROUND_CONTEXT);
      return Response.json({ cancelled: true });
    }
    if (url.pathname === "/stale") {
      const result = await this.acceptOne(
        { leaseId: "lease_plan50_1", turn: TURN },
        canonicalFact(
          {
            role: "assistant",
            content: [{ type: "text", text: "STALE" }],
            model: "faux",
            stopReason: "stop",
          },
          TURN,
          INPUT,
          null,
        ),
      );
      return Response.json(result);
    }
    return new Response("Unknown path", { status: 404 });
  }
}

function textContent(block) {
  return block.type === "text" ? block.text : "";
}
function isAssistantFact(fact) {
  return fact.kind === "assistant_message";
}
function tableName(row) {
  return row.name;
}
function decodeRecord(row) {
  return JSON.parse(row.record);
}
export function readRecords(sql, names, table) {
  return names.has(table)
    ? sql
        .exec(`SELECT record FROM ${table} ORDER BY id`)
        .toArray()
        .map(decodeRecord)
    : [];
}

export default {
  fetch(request, env) {
    return env.CANDIDATE.getByName(
      new URL(request.url).searchParams.get("scenario"),
    ).fetch(request);
  },
};
