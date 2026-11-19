import { piToolReplay } from "./pi-tool-replay";
import { PiToolArgumentStream } from "./pi-tool-argument-stream";
import { persistedAnswerDeltas } from "./harness-answer";
import {
  markSteeringInputPlaced,
  markSteeringInputQueued,
  markSteeringInputWithdrawn,
  readSteeringInput,
  unplacedSteeringInputs,
} from "./harness-steering";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type Message,
  type AssistantMessage,
  type TranscriptContext,
  type SimpleStreamOptions,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  type Conversation,
  type CommitResult,
  type Report,
  type StorageWrite,
  type Storage,
  type SubmissionRecord,
  type Tx,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteExecutor,
} from "@earendil-works/pi-durable/storage/sqlite";
import { createCancellableTask } from "@purin-labs/async-control/cancellable-task";
import { canonicalJson, errorMessage, sha256Hex, isRecord } from "@purin-labs/std";
import type {
  AgentEvent,
  AcceptedHarnessEventCursor,
  HarnessHistoryCursor,
  HarnessHistoryContent,
  HarnessHistoryEntry,
  EmbeddedHarnessModelUsage,
} from "@purin-labs/contracts";
import { newRequestId } from "../ids";
import { traceLog } from "../observability";
import type { Result } from "../result";
import type {
  EmbeddedHarnessAdapter,
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessConstructionError,
  EmbeddedHarnessRuntime,
  EmbeddedHarnessUserInput,
  EmbeddedHarnessActiveTurn,
  EmbeddedHarnessTurnResult,
  EmbeddedHarnessTurnError,
  EmbeddedHarnessCancelError,
  EmbeddedHarnessSteeringInput,
  EmbeddedHarnessSteerError,
  EmbeddedHarnessSteerOutcome,
} from "./embedded-harness";
import {
  resolvePiInferenceRoute,
  dispatchPiModel,
  type PiModelResponse,
  type PiInferenceRoute,
} from "./pi-model-transport";
import { toPiPrompt, toHistoryContent } from "./pi-user-input";
import { materializePiHistory } from "./pi-history-adapter";
import { ActorSqliteDatabase } from "./pi-durable-database";
import { hasUnfinishedCodeModeCall } from "./pi-durable-recovery";
import { canonicalFact, canonicalStopNotice } from "./pi-durable-history";
import {
  createDurableHostTools,
  isInitialHostToolName,
  wholeCatalogEnabled,
} from "./pi-durable-tools";
import {
  failNativeStream,
  providerAllowanceSpent,
  errorStatusWithoutTokens,
} from "./pi-durable-stream";
import {
  capturePiDurableCheckpoint,
  preparePiDurableStorage,
  PI_DURABLE_BUILD,
  PI_DURABLE_CHECKPOINT_FORMAT,
} from "./pi-durable-checkpoint";
import { createPiUsageSchema, savePiUsage } from "./pi-durable-usage";
import { goalStopMessage, type GoalModelStop } from "./goal-model-calls";

export function createPiDurableAdapter(model: string): EmbeddedHarnessAdapter {
  return {
    manifest: {
      backendId: "pi",
      harnessBuild: PI_DURABLE_BUILD,
      checkpointFormat: PI_DURABLE_CHECKPOINT_FORMAT,
      model,
    },
    construct: construct.bind(null, model),
  };
}
function construct(
  model: string,
  input: EmbeddedHarnessConstructionInput,
): Result<EmbeddedHarnessRuntime, EmbeddedHarnessConstructionError> {
  if (input.model !== model)
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  const route = resolvePiInferenceRoute(input);
  if (!route.ok) return route;
  return { ok: true, value: new PiDurableRuntime(input, route.value) };
}

class AcceptanceDatabase extends ActorSqliteDatabase {
  /** The writes of the commit whose transaction starts next. */
  writes: readonly StorageWrite[] = [];
  commitTail: Promise<unknown> = Promise.resolve();
  constructor(
    storage: DurableObjectStorage,
    readonly runtime: PiDurableRuntime,
  ) {
    super(storage);
  }
  /**
   * Pi starts a commit's transaction in the same step as the call, and reads a
   * document in a transaction while another commit is stored. So each
   * transaction takes the writes when it starts: a read queued next to a
   * commit accepts nothing.
   */
  override transaction<T>(
    callback: (executor: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    const writes = this.writes;
    const transaction = super.transaction(
      (this.accept<T>).bind(this, callback, writes),
    );
    this.writes = [];
    return transaction;
  }
  private async accept<T>(
    callback: (executor: SqliteExecutor) => Promise<T>,
    writes: readonly StorageWrite[],
    executor: SqliteExecutor,
  ): Promise<T> {
    const before = writes.length === 0 ? null : await nextCommitSeq(executor);
    const result = await callback(executor);
    // A batch that Pi's own checks refuse stores nothing and takes no seq, and
    // the transaction still commits. Nothing of it may reach the history.
    const refused =
      before !== null && before === (await nextCommitSeq(executor));
    await this.runtime.acceptWrites(refused ? [] : writes);
    return result;
  }
}
async function nextCommitSeq(executor: SqliteExecutor): Promise<number | null> {
  const row = await executor.get<{ next_seq: number }>(
    "SELECT next_seq FROM durable_metadata WHERE singleton = 1",
  );
  return row?.next_seq ?? null;
}
type CommitReceipt = Parameters<Storage["commit"]>[1];
type Seq = Parameters<CommitReceipt>[1];
type OpenRuntime = { harness: Harness; root: Conversation; storage: Storage };
type RuntimeState =
  | { kind: "prepared"; runtime?: never; opening?: never }
  | { kind: "opening"; opening: Promise<OpenRuntime>; runtime?: never }
  | { kind: "open"; runtime: OpenRuntime; opening?: never }
  | { kind: "closed"; runtime?: never; opening?: never };

class PiDurableRuntime implements EmbeddedHarnessRuntime {
  private state: RuntimeState = { kind: "prepared" };
  private importing = false;
  private finalResponse: string | null = null;
  /**
   * The turn's answer: the text of every model response, as it streams, with
   * a blank line between responses. Each part becomes an answer delta, so a
   * Slack thread or the Portal shows it while the model writes. A transient
   * turn (an email body, for example) streams nothing: its answer is the
   * last model response only.
   */
  private answerText = "";
  private answerPending = "";
  private answerFlushedAt = 0;
  private database: AcceptanceDatabase | null = null;
  private readonly fault = Promise.withResolvers<never>();
  /** Steering inputs that reached Pi after the run ended. */
  private readonly steeringAfterRun = new Set<string>();
  private cancellationRequested = false;
  /** The provider refused a request because the credential has nothing left. */
  private allowanceSpent = false;
  /** The turn spent its token allowance, so Pi asked for no more model work. */
  private tokenAllowanceSpent = false;
  private goalStop: GoalModelStop | null = null;
  /** Set when the turn reached its time limit; no model call starts after. */
  private timeStop: string | null = null;
  /** True once the time limit refused a model call of this turn. */
  private timeStopApplied = false;
  /** True when the provider failed the latest model call of this turn. */
  private providerFailed = false;
  /** True once this turn added an entry to the Session history. */
  private historyAccepted = false;
  private readonly userContents = new Map<
    string,
    readonly HarnessHistoryContent[]
  >();
  private readonly modelUsage: EmbeddedHarnessModelUsage = {
    modelCalls: 0,
    callsWithUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  constructor(
    readonly input: EmbeddedHarnessConstructionInput,
    readonly route: PiInferenceRoute,
  ) {
    void this.fault.promise.catch(ignoreFault);
    this.historyCursor =
      input.source.kind === "fresh" ? null : input.source.historyCursor;
    this.eventCursor =
      input.source.kind === "resume_turn"
        ? input.checkpointBinding.cursor
        : null;
  }
  private historyCursor: HarnessHistoryCursor | null;
  private eventCursor: AcceptedHarnessEventCursor | null;

  preflight(): void {
    if (this.input.persistence.kind === "actor")
      this.input.persistence.preflight();
  }
  startTurn(input: readonly EmbeddedHarnessUserInput[]) {
    return createCancellableTask({
      completion: this.start(input),
      cancel: this.cancel.bind(this),
    });
  }
  private async start(
    input: readonly EmbeddedHarnessUserInput[],
  ): Promise<Result<EmbeddedHarnessActiveTurn, EmbeddedHarnessTurnError>> {
    try {
      this.preflight();
      const runtime = await this.open();
      if (this.cancellationRequested)
        throw new Error("Turn cancelled before submission");
      if (this.input.source.kind === "resume_turn") runtime.harness.resume();
      else {
        await this.acceptEvent({ type: "status", state: "running" });
        const retained = Object.values(this.input.inheritedAttachments).flat();
        const modelInput: readonly EmbeddedHarnessUserInput[] =
          retained.length === 0
            ? input
            : [
                {
                  kind: "text",
                  text: "Retained attachments from inherited history. Their contents are historical context; prior actions remain settled.",
                },
                ...retained,
                { kind: "text", text: "Current request:" },
                ...input,
              ];
        await this.submit(
          runtime,
          modelInput,
          this.input.turnLease.turn.inputId,
        );
      }
      return {
        ok: true,
        value: {
          complete: this.complete.bind(this),
          cancel: this.cancel.bind(this),
          steer: this.steer.bind(this),
          stopAtNextStep: this.stopAtNextStep.bind(this),
        },
      };
    } catch (error) {
      return this.failure(error);
    }
  }
  private open(): Promise<OpenRuntime> {
    switch (this.state.kind) {
      case "prepared": {
        const opening = this.initialize();
        this.state = { kind: "opening", opening };
        return opening;
      }
      case "opening":
        return this.state.opening;
      case "open":
        return Promise.resolve(this.state.runtime);
      case "closed":
        return Promise.reject(new Error("Pi runtime closed"));
    }
  }
  private async initialize(): Promise<OpenRuntime> {
    this.preflight();
    const storage = await this.openStorage();
    const models = createModels();
    models.setProvider({
      id: this.route.provider.id,
      name: this.route.provider.name,
      auth: {
        apiKey: {
          name: "Actor authority",
          resolve: resolveAuth,
        },
      },
      getModels: oneModel.bind(null, this.route.model),
      stream: unsupportedStream,
      streamSimple: this.stream.bind(this),
    });
    const tools = createDurableHostTools(
      this.input.toolHost,
      this.preflight.bind(this),
      this.input.turnLease.turn.turnId,
      piToolReplay,
    );
    const extension = defineExtension({ name: "satyr.tools", tools });
    const codeMode = this.input.toolHost.codeMode.kind === "enabled";
    const catalog = this.input.toolHost.definitions;
    const wholeCatalog = codeMode && wholeCatalogEnabled(catalog);
    const registry = createRegistry();
    registry.install(extension);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        now: this.input.now,
        onReport: this.report.bind(this),
        settings: {
          retry: { maxRetries: 0 },
          compaction: { backgroundTokens: 0 },
        },
      },
      BACKGROUND_CONTEXT,
    );
    const agent = {
      model: {
        provider: this.route.model.provider,
        modelId: this.route.model.id,
      },
      instructions: this.input.harnessInstructions,
      extensions: [extension],
      tools: !codeMode
        ? tools.filter(directTool)
        : wholeCatalog
          ? tools
          : tools.filter(initialTool),
      thinkingLevel: piThinkingLevel(this.route, this.input.thinkingLevel),
    };
    const root = await harness.root(BACKGROUND_CONTEXT, { agent });
    if (
      this.input.source.kind === "restore" ||
      this.input.source.kind === "resume_turn"
    ) {
      const previous = await root.agent(BACKGROUND_CONTEXT);
      const names = new Set(previous.tools.map(nativeToolName));
      if (
        codeMode &&
        (this.input.source.kind === "restore" ||
          (this.input.persistence.kind === "actor" &&
            hasUnfinishedCodeModeCall(this.input.persistence.storage.sql)))
      )
        names.add("codemode");
      if (wholeCatalog) addToolNames(names, catalog);
      agent.tools = tools.filter(selectedNativeTool.bind(null, names));
    }
    await root.configure(agent, BACKGROUND_CONTEXT);
    const runtime = { harness, root, storage };
    if (
      this.input.source.kind !== "restore" &&
      this.input.source.kind !== "resume_turn"
    ) {
      this.importing = true;
      try {
        await this.importHistory(root);
      } finally {
        this.importing = false;
      }
    }
    if (this.state.kind === "closed") {
      await harness.close(BACKGROUND_CONTEXT);
      throw new Error("Pi runtime closed during construction");
    }
    this.state = { kind: "open", runtime };
    return runtime;
  }
  private report(report: Report): void {
    this.fault.reject(report.error);
  }
  private async importHistory(root: Conversation): Promise<void> {
    const source = this.input.source;
    const own = source.kind === "fresh_lineage" ? source.history.entries : [];
    const entries = [...this.input.inheritedHistory, ...own];
    if (entries.length === 0) return;
    const history = materializePiHistory({
      systemPrompt: this.input.harnessInstructions,
      entries,
      attachments: this.input.inheritedAttachments,
      model: this.route.model,
    });
    if (history === null) throw new Error("Invalid inherited Pi history");
    await root.commit(
      importMessages.bind(null, root, history.messages),
      BACKGROUND_CONTEXT,
    );
  }
  private async submit(
    runtime: OpenRuntime,
    input: readonly EmbeddedHarnessUserInput[],
    requestId: string,
  ): Promise<void> {
    const prompt = required(toPiPrompt(input));
    const content =
      prompt.text.length === 0
        ? prompt.images
        : [{ type: "text" as const, text: prompt.text }, ...prompt.images];
    this.userContents.set(canonicalJson(content), input.map(toHistoryContent));
    await runtime.root.submit(
      { type: "input", requestId, content, whenBusy: "reject" },
      BACKGROUND_CONTEXT,
    );
  }
  /**
   * Give Pi a steering input that the Session admitted. Pi queues it while
   * the run is busy and places it at the next boundary, as an entry of kind
   * `pantry.steer`. If the run has ended, Pi would place it at once and start
   * a new run outside the turn's lease: the acceptance hook refuses that
   * commit, and the input stays with the surface.
   */
  private async steer(
    steering: EmbeddedHarnessSteeringInput,
  ): Promise<Result<EmbeddedHarnessSteerOutcome, EmbeddedHarnessSteerError>> {
    if (this.input.persistence.kind !== "actor")
      return {
        ok: true,
        value: { kind: "refused", reason: "steering_unsupported" },
      };
    if (this.state.kind !== "open" || this.cancellationRequested)
      return {
        ok: true,
        value: { kind: "refused", reason: "turn_not_running" },
      };
    try {
      this.preflight();
      const prompt = required(toPiPrompt(steering.input));
      const content =
        prompt.text.length === 0
          ? prompt.images
          : [{ type: "text" as const, text: prompt.text }, ...prompt.images];
      await this.state.runtime.root.submit(
        {
          type: "input",
          requestId: steering.inputId,
          content,
          whenBusy: "steer",
          entry: {
            kind: STEERING_ENTRY_KIND,
            data: { inputId: steering.inputId },
          },
        },
        BACKGROUND_CONTEXT,
      );
      return { ok: true, value: { kind: "queued" } };
    } catch (error) {
      if (this.steeringAfterRun.has(steering.inputId))
        return {
          ok: true,
          value: { kind: "refused", reason: "turn_not_running" },
        };
      return {
        ok: false,
        error: {
          code: "embedded_harness_steer_failed",
          detail: errorMessage(error),
        },
      };
    }
  }
  private stream(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void this.forward(context, options, output).catch(
      failNativeStream.bind(null, output, model),
    );
    return output;
  }
  private async forward(
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
    output: AssistantMessageEventStream,
  ): Promise<void> {
    this.preflight();
    if (this.goalStop !== null) throw new Error("Goal model admission stopped");
    if (this.timeStop !== null) {
      this.timeStopApplied = true;
      throw new Error("Turn time limit reached");
    }
    // A request needs allowance left: the turn ends instead of asking the
    // provider for zero or fewer tokens.
    if (this.input.modelTokenAllowance - this.modelUsage.totalTokens <= 0) {
      this.tokenAllowanceSpent = true;
      throw new Error("Model token allowance exhausted");
    }
    const compaction = compactionRequest(context);
    const startedAt = this.input.now();
    // A key that cannot be read sends no request: the turn fails with known
    // usage instead of an unknown model call.
    const apiKey = await this.route.resolveModelApiKey();
    this.modelUsage.modelCalls += 1;
    this.saveUsage();
    const response: PiModelResponse = { errorStatus: null };
    const dispatch = await dispatchPiModel({
      route: this.route,
      apiKey,
      response,
      context,
      sessionId: this.input.sessionId,
      tokenAllowance:
        this.input.modelTokenAllowance - this.modelUsage.totalTokens,
      goalModelCalls: this.input.goalModelCalls,
      options,
    });
    if (!dispatch.ok) {
      this.modelUsage.modelCalls -= 1;
      this.saveUsage();
      this.goalStop = dispatch.error;
      throw new Error("Goal model admission stopped");
    }
    const stream = dispatch.value;
    // Compaction asks for a summary with its own system prompt; the summary
    // is no answer.
    const answers = this.input.persistence.kind === "actor" && !compaction;
    // Plan 40B phase 7: a board edit shows on the board while the model
    // writes its arguments.
    const toolArguments =
      answers && this.input.toolArguments !== undefined
        ? new PiToolArgumentStream(this.input.toolArguments)
        : null;
    let responseStarted = false;
    for await (const event of stream) {
      toolArguments?.accept(event);
      if (answers)
        switch (event.type) {
          case "text_delta":
            if (!responseStarted && this.answerText + this.answerPending !== "")
              this.answerPending += "\n\n";
            responseStarted = true;
            await this.streamAnswer(event.delta, "more");
            break;
          case "toolcall_start":
            // Tool arguments can stream for seconds; show the text before them.
            await this.streamAnswer("", "flush");
            break;
          case "done":
          case "error":
            await this.streamAnswer("", "end");
            break;
          default:
            await this.streamAnswer("", "more");
        }
      if (event.type === "done") {
        if (this.route.kind === "openrouter")
          normalizeToolCallIds(event.message);
        this.recordUsage(event.message);
        this.providerFailed = false;
      }
      if (event.type === "error") {
        this.providerFailed = true;
        this.recordUsage(
          event.error,
          errorStatusWithoutTokens(response, event.error),
        );
        if (providerAllowanceSpent(event.error.errorMessage))
          this.allowanceSpent = true;
      }
      this.preflight();
      output.push(event);
    }
    output.end(await stream.result());
    // Background compaction is off, so the turn waited for this summary.
    // Plan 57 enables it inside the turn lease only if these waits matter.
    if (compaction)
      traceLog("pi.compaction_waited", {
        requestId: newRequestId(),
        session_id: this.input.sessionId,
        turn_id: this.input.turnLease.turn.turnId,
        duration_ms: this.input.now() - startedAt,
      });
  }
  async acceptWrites(writes: readonly StorageWrite[]): Promise<void> {
    if (!this.cancellationRequested) this.preflight();
    if (this.importing) return;
    for (const write of writes) {
      if (write.type === "submission") {
        this.followSteeringSubmission(write.value);
        continue;
      }
      if (write.type !== "entry" || write.value.kind === "pi.compaction")
        continue;
      const steering =
        write.value.kind === STEERING_ENTRY_KIND
          ? this.placeSteering(write.value.data)
          : null;
      for (const storedMessage of write.value.model ?? []) {
        const message = await trustedNativeResult(storedMessage);
        if (
          message.role === "assistant" &&
          (message.stopReason === "aborted" || message.stopReason === "error")
        )
          continue;
        // A cancelled turn accepts nothing more: its lease has ended. Pi
        // still records the result of each tool that the abort interrupted,
        // and a refusal here would fail the whole Pi session.
        if (this.cancellationRequested) continue;
        this.preflight();
        const userContent =
          message.role !== "user"
            ? null
            : steering !== null
              ? steering.content
              : (this.userContents.get(canonicalJson(message.content)) ?? null);
        const fact = canonicalFact(
          message,
          this.input.turnLease.turn,
          steering?.inputRef ?? this.input.acceptedInput,
          userContent,
        );
        if (fact === null) continue;
        await this.acceptHistory(fact);
        if (fact.kind === "assistant_message") {
          for (const block of fact.content) {
            if (block.kind === "tool_call")
              await this.acceptEvent({
                type: "agent_tool_use",
                tool: block.tool,
                callId: block.callId,
                args: block.arguments,
              });
          }
          if (fact.stopReason === "completed")
            this.finalResponse = assistantText(message);
        }
      }
    }
  }
  /**
   * Follow Pi's record of a steering input: `queued` while the run holds it,
   * `unanswered` when an abort withdrew it.
   */
  private followSteeringSubmission(record: SubmissionRecord): void {
    if (
      record.type !== "input" ||
      record.requestId === undefined ||
      this.input.persistence.kind !== "actor"
    )
      return;
    const sql = this.input.persistence.storage.sql;
    if (record.status === "queued")
      markSteeringInputQueued(
        sql,
        String(this.input.sessionId),
        record.requestId,
        String(record.id),
      );
    else if (record.status === "unanswered")
      markSteeringInputWithdrawn(
        sql,
        String(this.input.sessionId),
        record.requestId,
      );
  }
  /**
   * Accept the placement of a steering input, or refuse the commit. Pi places
   * a queued input inside the running turn. An input that Pi did not queue
   * first was placed by an idle conversation, which starts a new run: the
   * turn has ended, so the commit is refused.
   */
  private placeSteering(data: unknown) {
    const inputId = isRecord(data) ? data.inputId : undefined;
    if (typeof inputId !== "string" || this.input.persistence.kind !== "actor")
      throw new Error("Steering entry without an admitted input");
    const sql = this.input.persistence.storage.sql;
    const sessionId = String(this.input.sessionId);
    const admitted = readSteeringInput(sql, sessionId, inputId);
    if (
      admitted === null ||
      admitted.turnId !== String(this.input.turnLease.turn.turnId) ||
      admitted.state !== "queued"
    ) {
      this.steeringAfterRun.add(inputId);
      throw new Error("Steering input placed outside its turn's run");
    }
    markSteeringInputPlaced(sql, sessionId, inputId);
    return admitted;
  }
  private unplacedSteering() {
    return this.input.persistence.kind === "actor"
      ? unplacedSteeringInputs(
          this.input.persistence.storage.sql,
          String(this.input.sessionId),
          String(this.input.turnLease.turn.turnId),
        )
      : [];
  }
  private withdrawUnplacedSteering(): void {
    if (this.input.persistence.kind !== "actor") return;
    for (const steering of this.unplacedSteering())
      markSteeringInputWithdrawn(
        this.input.persistence.storage.sql,
        String(this.input.sessionId),
        steering.inputId,
      );
  }
  private cursor() {
    return {
      history_sequence: this.historyCursor?.lastSequence ?? null,
      history_digest: this.historyCursor?.lastEntryDigest ?? null,
      last_sequence: this.eventCursor?.lastSequence ?? null,
      last_event_digest: this.eventCursor?.lastEventDigest ?? null,
    };
  }
  private async openStorage(): Promise<Storage> {
    const persistence = this.input.persistence;
    if (persistence.kind === "transient") return new TransientStorage(this);
    const actorStorage = persistence.storage;
    actorStorage.transactionSync(
      preparePiDurableStorage.bind(null, actorStorage.sql, this.input),
    );
    const database = new AcceptanceDatabase(actorStorage, this);
    this.database = database;
    this.answerText = persistedAnswerDeltas(this.input);
    const sqlite = await SqliteStorage.open(database);
    createPiUsageSchema(actorStorage.sql);
    return new Proxy(sqlite, { get: bindStorage.bind(null, database) });
  }
  private async acceptHistory(entry: HarnessHistoryEntry): Promise<void> {
    const row = this.cursor();
    const accepted = required(
      await this.input.historySink.appendHarnessHistory({
        leaseId: this.input.turnLease.leaseId,
        sessionId: this.input.sessionId,
        turn: this.input.turnLease.turn,
        sequence: (row.history_sequence ?? 0) + 1,
        previousDigest: row.history_digest,
        entry,
        acceptedAt: this.input.now(),
      }),
    );
    this.historyCursor = accepted.cursor;
    this.historyAccepted = true;
  }
  /**
   * Adds text to the answer and writes it as answer deltas in parts.
   * Whitespace at the end waits for more text, and the end of a response
   * drops it, so the answer never starts or ends with whitespace. `more`
   * writes when the part is long or old enough, `flush` writes what is
   * waiting, and `end` also drops the response's trailing whitespace. The
   * writes go through Pi's database queue, so they keep their order with
   * Pi's own writes.
   */
  private async streamAnswer(
    text: string,
    mode: "more" | "flush" | "end",
  ): Promise<void> {
    // A cancelled turn's lease has ended: it accepts nothing more.
    if (this.cancellationRequested) return;
    const leading = this.answerText === "" && this.answerPending.trim() === "";
    this.answerPending += leading ? text.trimStart() : text;
    if (mode === "end") this.answerPending = this.answerPending.trimEnd();
    const delta = this.answerPending.trimEnd();
    const now = this.input.now();
    if (
      delta === "" ||
      (mode === "more" &&
        delta.length < ANSWER_DELTA_CHARS &&
        now - this.answerFlushedAt < ANSWER_DELTA_MS)
    )
      return;
    this.answerPending = this.answerPending.slice(delta.length);
    this.answerText += delta;
    this.answerFlushedAt = now;
    const accept = this.acceptEvent.bind(this, {
      type: "agent_message",
      text: delta,
      finalMessage: false,
    });
    await (this.database === null ? accept() : this.database.enqueue(accept));
  }
  private async acceptEvent(event: AgentEvent): Promise<void> {
    const sequence = (this.cursor().last_sequence ?? 0) + 1;
    const acceptedAt = this.input.now();
    const payload = canonicalJson({
      turnId: this.input.turnLease.turn.turnId,
      sequence,
      emittedAt: acceptedAt,
      event,
    });
    const accepted = required(
      await this.input.eventSink.acceptCanonicalHarnessEvent({
        leaseId: this.input.turnLease.leaseId,
        sessionId: this.input.sessionId,
        turn: this.input.turnLease.turn,
        sequence,
        eventDigest: await sha256Hex(payload),
        payload,
        acceptedAt,
      }),
    );
    this.eventCursor = accepted.cursor;
  }
  private recordUsage(message: AssistantMessage, errorStatus = false): void {
    const usage = message.usage;
    if (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0)
      return;
    if (
      (message.stopReason === "error" || message.stopReason === "aborted") &&
      usage.totalTokens === 0 &&
      !errorStatus
    )
      return;
    this.modelUsage.callsWithUsage += 1;
    this.modelUsage.inputTokens += usage.input;
    this.modelUsage.cachedInputTokens += usage.cacheRead;
    this.modelUsage.outputTokens += usage.output;
    this.modelUsage.reasoningTokens += usage.reasoning ?? 0;
    this.modelUsage.totalTokens += usage.totalTokens;
    this.saveUsage();
  }
  private saveUsage(): void {
    if (this.input.persistence.kind === "actor") {
      savePiUsage(
        this.input.persistence.storage.sql,
        this.input.turnLease,
        this.modelUsage,
      );
    }
  }
  private async complete(): Promise<
    Result<EmbeddedHarnessTurnResult, EmbeddedHarnessTurnError>
  > {
    try {
      const runtime = await this.open();
      await Promise.race([
        runtime.root.waitForIdle(BACKGROUND_CONTEXT),
        this.fault.promise,
      ]);
      this.preflight();
      await this.streamAnswer("", "end");
      // A turn that the time limit cut short ends like a goal stop; one whose
      // running call still brought the final answer keeps that answer.
      let notice =
        this.goalStop !== null
          ? goalStopMessage(this.goalStop)
          : this.timeStopApplied
            ? this.timeStop
            : null;
      let finalMessage = "";
      if (notice === null) {
        if (this.cancellationRequested)
          throw new Error("Native turn was cancelled");
        if (this.modelUsage.modelCalls !== this.modelUsage.callsWithUsage)
          throw new Error("Native model usage receipt missing");
        // The streamed answer counts only when the model finished its last
        // response; an answer cut off by a provider error is no answer.
        const context = await runtime.root.context(BACKGROUND_CONTEXT);
        const last = context.messages.at(-1);
        const response =
          this.finalResponse ??
          (last?.role === "assistant" && last.stopReason === "stop"
            ? assistantText(last)
            : null);
        // A provider failure stays a failure, so Portal chat offers its retry.
        // Its history ends with a failure note, so the next turn of the
        // Session sees the request and goes on. A reply that ended without
        // its answer for another reason, such as one cut off at its length
        // limit, ends with a notice like a stopped turn.
        if (response === null) {
          if (this.providerFailed) {
            await this.acceptFailureNote();
            throw new Error("Native turn has no accepted final response");
          }
          notice = UNFINISHED_ANSWER_NOTICE;
        } else
          finalMessage = this.answerText === "" ? response : this.answerText;
      }
      if (notice !== null)
        finalMessage =
          this.answerText === "" ? notice : `${this.answerText}\n\n${notice}`;
      const accept = this.acceptCompletion.bind(this, finalMessage, notice);
      if (this.input.persistence.kind === "actor")
        await this.input.persistence.storage.transaction(accept);
      else await accept();
      const row = this.cursor();
      if (
        row.last_sequence === null ||
        row.last_event_digest === null ||
        row.history_sequence === null ||
        row.history_digest === null
      )
        throw new Error("Native turn has no accepted cursor");
      const cursor: AcceptedHarnessEventCursor = {
        turn: this.input.turnLease.turn,
        lastSequence: row.last_sequence,
        lastEventDigest: row.last_event_digest,
      };
      const historyCursor: HarnessHistoryCursor = {
        lastSequence: row.history_sequence,
        lastEntryDigest: row.history_digest,
      };
      const checkpoint =
        this.input.persistence.kind === "actor"
          ? capturePiDurableCheckpoint(
              this.input.persistence.storage.sql,
              this.input,
              { cursor, historyCursor },
            )
          : new ArrayBuffer(0);
      return {
        ok: true,
        value: {
          finalMessage,
          checkpoint,
          cursor,
          historyCursor,
          modelUsage: { ...this.modelUsage },
        },
      };
    } catch (error) {
      return this.failure(error);
    }
  }
  /**
   * Writes the end of the turn in one transaction: the goal stop notice as the
   * answer's last part, its history entry, the completed answer and `done`.
   */
  private async acceptCompletion(
    finalMessage: string,
    notice: string | null,
  ): Promise<void> {
    if (
      this.input.persistence.kind === "actor" &&
      this.input.source.kind === "resume_turn"
    ) {
      const last = this.input.persistence.storage.sql
        .exec<{ type: string }>(
          "SELECT json_extract(payload, '$.event.type') AS type FROM turn_delivery_segment WHERE session_id = ? AND turn_id = ? ORDER BY sequence DESC LIMIT 1",
          this.input.sessionId,
          this.input.turnLease.turn.turnId,
        )
        .toArray()[0];
      if (last?.type === "done") return;
    }
    if (notice !== null) {
      if (this.answerText !== "")
        await this.acceptEvent({
          type: "agent_message",
          text: `\n\n${notice}`,
          finalMessage: false,
        });
      // History already holds the model's text; it gets only the notice.
      await this.acceptHistory(
        canonicalStopNotice(
          notice,
          this.route.model.id,
          this.input.turnLease.turn,
          this.input.now(),
        ),
      );
    }
    await this.acceptEvent({
      type: "agent_message",
      text: finalMessage,
      finalMessage: true,
    });
    await this.acceptEvent({
      type: "done",
      outcome:
        notice === null
          ? { status: "success", summary: null, artifacts: [] }
          : { status: "partial", summary: notice, artifacts: [] },
    });
  }
  /**
   * Ends the history of a turn that the provider failed with a note for the
   * model. The turn still fails, and it stores no checkpoint: the next turn
   * rebuilds its context from the whole history.
   */
  private async acceptFailureNote(): Promise<void> {
    if (this.input.persistence.kind !== "actor" || !this.historyAccepted)
      return;
    const accept = this.acceptHistory.bind(
      this,
      canonicalStopNotice(
        PROVIDER_FAILURE_NOTE,
        this.route.model.id,
        this.input.turnLease.turn,
        this.input.now(),
      ),
    );
    await this.input.persistence.storage.transaction(accept);
  }
  private failure(error: unknown): Result<never, EmbeddedHarnessTurnError> {
    if (
      this.tokenAllowanceSpent &&
      this.modelUsage.modelCalls === this.modelUsage.callsWithUsage
    )
      return {
        ok: false,
        error: {
          code: "embedded_harness_token_budget_exhausted",
          allowanceTokens: this.input.modelTokenAllowance,
          modelUsage: { ...this.modelUsage },
        },
      };
    return {
      ok: false,
      error: {
        code: "embedded_harness_turn_failed_with_usage",
        cause:
          this.modelUsage.modelCalls !== this.modelUsage.callsWithUsage
            ? {
                code: "embedded_harness_model_usage_missing",
                ...(this.allowanceSpent
                  ? { refusal: "authority_exhausted" as const }
                  : {}),
              }
            : {
                code: "embedded_harness_turn_failed",
                detail: errorMessage(error),
              },
        modelUsage: { ...this.modelUsage },
      },
    };
  }
  private stopAtNextStep(notice: string): void {
    this.timeStop = notice;
  }
  private async cancel(): Promise<Result<null, EmbeddedHarnessCancelError>> {
    this.cancellationRequested = true;
    try {
      if (this.state.kind === "opening") await this.state.opening;
      if (this.state.kind === "open")
        await this.state.runtime.root.abort(BACKGROUND_CONTEXT, {
          background: true,
        });
      return { ok: true, value: null };
    } catch (error) {
      // The turn closes its harness once it is idle, which rejects an abort
      // still waiting on background tasks. Nothing is left to cancel then.
      if (this.state.kind === "closed") return { ok: true, value: null };
      return {
        ok: false,
        error: {
          code: "embedded_harness_cancel_failed",
          detail: errorMessage(error),
        },
      };
    }
  }
  async close(): Promise<void> {
    const state = this.state;
    this.state = { kind: "closed" };
    // A turn that failed can leave steering inputs in Pi's inbox. The abort
    // withdraws them, so the next run of this conversation does not place
    // them; the surface runs each one as the next turn.
    if (state.kind === "open" && this.unplacedSteering().length > 0)
      await state.runtime.root
        .abort(BACKGROUND_CONTEXT, { background: true })
        .catch(ignoreFault);
    this.withdrawUnplacedSteering();
    if (state.kind === "open")
      await state.runtime.harness.close(BACKGROUND_CONTEXT);
    if (state.kind === "opening") await state.opening;
  }
}
const STEERING_ENTRY_KIND = "satyr.steer";
const UNFINISHED_ANSWER_NOTICE =
  "Sous Chef could not finish this answer. Ask again to continue.";
const PROVIDER_FAILURE_NOTE =
  "The model provider failed, so Sous Chef could not complete this request.";

/** The subscription route keeps its own effort; Portal offers only `high`. */
function piThinkingLevel(
  route: PiInferenceRoute,
  requested: EmbeddedHarnessConstructionInput["thinkingLevel"],
): "minimal" | "low" | "medium" | "high" | "xhigh" {
  switch (route.kind) {
    case "openai-codex":
    case "openai-chatgpt":
      return route.thinkingLevel;
    case "openrouter":
      return requested ?? "minimal";
    case "openai":
    case "anthropic":
      return requested ?? "high";
  }
}

function required<T>(result: Result<T, { code: string }>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function bindStorage(
  database: AcceptanceDatabase,
  target: SqliteStorage,
  key: string | symbol,
): unknown {
  if (key === "commit") return enqueueNativeCommit.bind(null, database, target);
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}
function enqueueNativeCommit(
  database: AcceptanceDatabase,
  storage: SqliteStorage,
  batches: readonly (readonly StorageWrite[])[],
  receive: CommitReceipt,
  context: Context,
) {
  const commit = database.commitTail.then(
    commitNative.bind(null, database, storage, batches, receive, context),
  );
  database.commitTail = commit.catch(ignoreCommitFailure);
  return commit;
}
function ignoreCommitFailure(): void {}
/**
 * Stores each batch in its own transaction, with its acceptance. Pi groups the
 * commits that wait for a storage call; a refusal of the Session history then
 * rolls back that commit alone, and the receipts of earlier ones stand.
 */
async function commitNative(
  database: AcceptanceDatabase,
  storage: SqliteStorage,
  batches: readonly (readonly StorageWrite[])[],
  receive: CommitReceipt,
  context: Context,
): Promise<CommitResult> {
  for (const [index, writes] of batches.entries()) {
    database.writes = writes;
    const result = await storage.commit(
      [writes],
      receiveBatch.bind(null, receive, index),
      context,
    );
    if (result.stored === 0) return { stored: index, refused: result.refused };
  }
  return { stored: batches.length };
}
function receiveBatch(
  receive: CommitReceipt,
  index: number,
  _only: number,
  seq: Seq,
): void {
  receive(index, seq);
}
const TRANSPORT_RESOLVES_MODEL_KEY = "resolved-by-transport";

/**
 * The provider registry only needs to know that this provider is configured.
 * The transport resolves the model key under the turn's admission for each
 * dispatch and replaces this value, so no request can carry it.
 */
function resolveAuth() {
  return Promise.resolve({ auth: { apiKey: TRANSPORT_RESOLVES_MODEL_KEY } });
}
function oneModel(model: Model<Api>) {
  return [model];
}
function unsupportedStream(): never {
  throw new Error("Use the admitted simple transport");
}
function searchTool(tool: ToolRegistration): boolean {
  return tool.name === "tool_search" || tool.name === "codemode";
}
/** The tools that a large catalogue enables before any search. */
function initialTool(tool: ToolRegistration): boolean {
  return searchTool(tool) || isInitialHostToolName(tool.name);
}
function directTool(tool: ToolRegistration): boolean {
  return !searchTool(tool);
}
/** The opening of Pi's fixed compaction prompt (pi-durable 1.5.0). */
const COMPACTION_PROMPT_START = "You are a context summarization assistant.";

function compactionRequest(context: TranscriptContext): boolean {
  const first: unknown = context.messages[0];
  return (
    context.messages.length === 2 &&
    isRecord(first) &&
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.startsWith(COMPACTION_PROMPT_START)
  );
}

// A part is about one Slack append: the Connector releases at most every
// second or 400 characters, and each part costs a few durable rows.
const ANSWER_DELTA_CHARS = 256;
const ANSWER_DELTA_MS = 250;

function assistantText(message: Message): string {
  if (message.role !== "assistant") return "";
  let text = "";
  for (const block of message.content)
    if (block.type === "text") text += block.text;
  return text.trim();
}
async function importMessages(
  root: Conversation,
  messages: readonly Message[],
  tx: Tx,
): Promise<void> {
  for (const message of messages)
    await tx.appendEntry(root.id, { kind: "satyr.imported", model: [message] });
}

class TransientStorage extends MemoryStorage {
  constructor(readonly runtime: PiDurableRuntime) {
    super();
  }
  override async commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: CommitReceipt,
    _context: Context,
  ): Promise<CommitResult> {
    for (const [index, writes] of batches.entries()) {
      let prepared: ReturnType<MemoryStorage["prepareCommit"]>;
      try {
        prepared = this.prepareCommit(writes);
      } catch (error) {
        return { stored: index, refused: error };
      }
      await this.runtime.acceptWrites(writes);
      receive(index, prepared.apply());
    }
    return { stored: batches.length };
  }
}

function normalizeToolCallIds(message: AssistantMessage): void {
  const response = crypto.randomUUID().replaceAll("-", "");
  const ids = new Map<string, string>();
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    let id = ids.get(block.id);
    if (id === undefined) {
      id = `call_${response}_${ids.size}`;
      ids.set(block.id, id);
    }
    block.id = id;
  }
}
async function trustedNativeResult(message: Message): Promise<Message> {
  if (
    message.role !== "toolResult" ||
    !message.isError ||
    (isRecord(message.details) && isRecord(message.details.satyrAuthority))
  )
    return message;
  const text = canonicalJson(message.content);
  return {
    ...message,
    details: {
      satyrAuthority: { kind: "read", resultDigest: await sha256Hex(text) },
    },
  };
}

function nativeToolName(tool: { name: string }): string {
  return tool.name;
}
function selectedNativeTool(
  names: Set<string>,
  tool: ToolRegistration,
): boolean {
  return names.has(tool.name);
}
function addToolNames(
  names: Set<string>,
  tools: readonly { name: string }[],
): void {
  for (const tool of tools) names.add(tool.name);
}

function ignoreFault(): void {}
