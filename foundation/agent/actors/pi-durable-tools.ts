import {
  CodeModeResult,
  type PendingCodeModeReceipt,
  type AuthorizedResult,
  startCodeModeReceipt,
  readCodeModeReceipt,
  saveCodeModeReceipt,
  completeCodeModeReceipt,
} from "./pi-durable-code-receipt";
export { CodeModeResult } from "./pi-durable-code-receipt";
import type { Context } from "@earendil-works/chord/context";
import type {
  HarnessNativeCodeMode,
  HarnessToolHost,
  HarnessToolDefinition,
} from "./embedded-harness";
import type {
  AuthorizedHarnessToolResult,
  CodeModeExecutionOutcome,
} from "@purin-labs/contracts";
import {
  AgentDoc,
  NestedCallDoc,
  defineDoc,
  defineTool,
  type ToolRegistration,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolPark,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { HarnessCodeModeExecutionLease } from "@purin-labs/agent-tools/catalog/types";
import { Type } from "typebox";
import { refuseChangedToolArguments } from "./pi-tool-arguments";
import {
  canonicalJson,
  errorMessage,
  isRecord,
  isString,
  parseJsonOrNull,
  sha256Hex,
} from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { CodeModeAdmissionFrozenError } from "@purin-labs/agent-tools/catalog/types";
import { PERMISSION_REQUEST_TOOL_NAME } from "@purin-labs/agent-tools/catalog/permission";
import { MAX_CODE_MODE_SOURCE_BYTES } from "@purin-labs/agent-tools/catalog/code-mode";
import { StructuredToolResult } from "@purin-labs/agent-tools/structured-result";
import type { PiToolRules } from "./pi-tool-replay";
import { renderHarnessHistoryContent } from "./harness-history";
import {
  governCodeModeRemote,
  type CodeModeExchangeDenial,
  type CodeModeExchangeGate,
  type CodeModeRemoteCall,
  type CodeModeRemoteTerminal,
} from "./code-mode-governed-remote";
import { CODE_MODE_PILOT_BUDGET } from "./code-mode-budget";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { CODE_MODE_SANDBOX_MEMORY_BYTES } from "../code-mode-sandbox/limits";

type EnabledCodeMode = Variant<HarnessNativeCodeMode, "enabled">;

/** One Code Mode execution that this process runs. */
type LiveExecution = {
  readonly lease: HarnessCodeModeExecutionLease;
  /** The capability calls of this process that hold a claim. */
  readonly calls: Set<Promise<void>>;
  /** Set when the script has ended. No further call may claim. */
  closed: boolean;
  /**
   * Set when a capability call met a refusal that the script must not
   * outlive. The exchange then stops the script at the next result.
   */
  denial: CodeModeExchangeDenial | null;
  /**
   * Set when a claim or a completion of a call failed. The Organisation can
   * then hold a call in flight, or counts that this process did not receive.
   */
  unconfirmed: boolean;
};

type ToolState = {
  readonly host: HarnessToolHost;
  readonly preflight: () => void | Promise<void>;
  readonly turnId: string;
  readonly rules: (name: string) => PiToolRules;
  /**
   * The executions of this process, by the call ID of their Code Mode call.
   * A nested call waits here for its execution: after a restart, Pi can run an
   * interrupted nested call before the Code Mode call that owns it.
   */
  readonly executions: Map<string, PromiseWithResolvers<LiveExecution>>;
};

/** The Code Mode attempt of a turn. Scratch values are in Pi's store document. */
type CodeStore = {
  execution:
    { kind: "none" } | { kind: "used"; turnId: string; harnessTaskId: TaskId };
};
export const CodeModeStore = defineDoc<CodeStore>({
  kind: "pantry.codemode.store",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: emptyStore,
  checkpointWhen: alwaysCheckpoint,
});

function emptyStore(): CodeStore {
  return { execution: { kind: "none" } };
}
function alwaysCheckpoint() {
  return true;
}
function toolName(tool: { name: string }) {
  return tool.name;
}

const WHOLE_CATALOG_TOOLS = 16;
const WHOLE_CATALOG_BYTES = 8 * 1024;
/** The bytes of script output that one execution may return to the model. */
const MAX_CODE_MODE_RESULT_BYTES = CODE_MODE_PILOT_BUDGET.maxOutputBytes;

/**
 * A small catalog is enabled as a whole when Code Mode is enabled. A deferred
 * tool costs one more model call for its first use in a conversation, and a
 * small catalog adds little to the prompt. Each call is authorized when it
 * runs, so an enabled tool carries no authority.
 *
 * The limits count only the tools that a whole catalog adds to the first
 * request. The permission request is enabled before any search in every
 * catalog, so its description, which names each missing capability, does not
 * make a small catalog deferred.
 */
export function wholeCatalogEnabled(
  definitions: readonly HarnessToolDefinition[],
): boolean {
  const added = definitions.filter(isDeferrableDefinition);
  return (
    added.length <= WHOLE_CATALOG_TOOLS &&
    new TextEncoder().encode(JSON.stringify(added)).byteLength <=
      WHOLE_CATALOG_BYTES
  );
}

/**
 * The host tools that a large catalog enables before any search: the
 * permission request. A turn that lacks a capability cannot find the tool
 * for it, so the agent sees from the start that it may ask.
 */
export function isInitialHostToolName(name: string): boolean {
  return name === PERMISSION_REQUEST_TOOL_NAME;
}

function isDeferrableDefinition(definition: HarnessToolDefinition): boolean {
  return !isInitialHostToolName(definition.name);
}

export function createDurableHostTools(
  host: HarnessToolHost,
  preflight: ToolState["preflight"],
  turnId: string,
  rules: ToolState["rules"],
): ToolRegistration[] {
  const state: ToolState = {
    host,
    preflight,
    turnId,
    rules,
    executions: new Map(),
  };
  return [
    ...host.definitions.map(hostTool.bind(null, state)),
    defineTool({
      name: "tool_search",
      description:
        "Find deferred tools by name or description and enable the matches for subsequent calls.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 512 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      // A script finds tools with its own searchTools().
      callers: ["model"],
      replay: "safe",
      execute: searchTools.bind(null, state),
    }),
    defineTool({
      name: "codemode",
      description: CODE_MODE_DESCRIPTION,
      parameters: Type.Object({
        code: Type.String({
          minLength: 1,
          maxLength: MAX_CODE_MODE_SOURCE_BYTES,
        }),
      }),
      // A script cannot start a script.
      callers: ["model"],
      replay: "safe",
      executionMode: "sequential",
      execute: executeCode.bind(null, state),
    }),
  ];
}

const CODE_MODE_DESCRIPTION =
  "Run bounded JavaScript with discovered tools, text(), store(key, value), and load(key). One attempt is allowed per accepted turn. Await tool calls before using their results. commerce_entity_context resolves with an object. Every other tool resolves with text: when that text is JSON, read it with JSON.parse. A failed tool call rejects.";

function hostTool(
  state: ToolState,
  definition: HarnessToolDefinition,
): ToolRegistration {
  const rules = state.rules(definition.name);
  const common = {
    name: definition.name,
    description: definition.description,
    parameters: Type.Unsafe(definition.parameters),
    prepareArguments: refuseChangedToolArguments.bind(
      null,
      definition.parameters,
    ),
    replay: rules.replay,
    execute: executeHostTool.bind(null, state, definition.name),
  };
  // A capability that changes what the operator sees runs only as a direct
  // call. Leaving it out of a script's tools enforces that.
  if (rules.modelOnly) return defineTool({ ...common, callers: ["model"] });
  // This tool declares its value. A script receives that value, validated.
  if (rules.structuredOutput !== undefined)
    return defineTool({
      ...common,
      structuredOutputSchema: rules.structuredOutput,
    });
  return defineTool(common);
}

async function executeHostTool(
  state: ToolState,
  name: string,
  args: unknown,
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  await state.preflight();
  const parentCallId = await nestedParentCallId(api, context);
  return parentCallId === null
    ? executeDirect(state, name, args, api, context)
    : executeNested(state, name, args, api, context, parentCallId);
}

/**
 * The call ID of the Code Mode call that made this call, or `null` for a call
 * that the model made. Pi's own task record decides it, not the call ID.
 */
async function nestedParentCallId(
  api: ToolExecutionApi,
  context: Context,
): Promise<string | null> {
  // Pi names a nested call `<parent call ID>/<key>`.
  if (!api.callId.includes("/")) return null;
  const task = await api.getTask(api.taskId, context);
  const input: unknown = task?.input;
  return isRecord(input) &&
    input.kind === "nested" &&
    typeof input.parentCallId === "string"
    ? input.parentCallId
    : null;
}

async function executeDirect(
  state: ToolState,
  name: string,
  args: unknown,
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  const result = await state.host.executeTool(
    name,
    JSON.stringify(args),
    api.callId,
  );
  await state.preflight();
  context.abortSignal?.throwIfAborted();
  const authorized = authorizedResult(result);
  if (state.rules(name).structuredOutput === undefined) return authorized;
  // A tool that declares a value returns it on every result that succeeded.
  return result instanceof StructuredToolResult
    ? { ...authorized, structuredOutput: jsonValue(result.structuredContent) }
    : { ...authorized, isError: true };
}

/**
 * One capability call of a script. The claim binds the call to the admitted
 * execution before the Tool Host runs it. The call ID derives from Pi's stable
 * nested identity, so a call that runs again after a restart keeps its claim.
 */
async function executeNested(
  state: ToolState,
  name: string,
  args: unknown,
  api: ToolExecutionApi,
  context: Context,
  parentCallId: string,
): Promise<ToolExecutionResult> {
  const mode = state.host.codeMode;
  if (mode.kind !== "enabled")
    return nestedFailure("Code Mode is unavailable", []);
  const execution = await liveExecution(state, parentCallId, context);
  const callId = `call_${await sha256Hex(api.callId)}`;
  const input = JSON.stringify(args);
  if (execution.closed) return nestedFailure("The script has ended", []);
  // The execution settles only after this call has released its claim.
  const call = Promise.withResolvers<void>();
  execution.calls.add(call.promise);
  try {
    return await executeClaimedCall(
      state,
      mode,
      execution,
      name,
      input,
      callId,
      context,
    );
  } finally {
    call.resolve();
  }
}

async function executeClaimedCall(
  state: ToolState,
  mode: EnabledCodeMode,
  execution: LiveExecution,
  name: string,
  input: string,
  callId: string,
  context: Context,
): Promise<ToolExecutionResult> {
  try {
    await mode.admission.claim(
      execution.lease,
      callId,
      new TextEncoder().encode(input).byteLength,
    );
  } catch (error) {
    execution.unconfirmed = true;
    if (error instanceof CodeModeAdmissionFrozenError)
      execution.denial ??= {
        code: "code_mode_admission_frozen",
        reason: "Code Mode admission is frozen, so no new capability call runs",
      };
    return nestedFailure(errorMessage(error), []);
  }
  let result: AuthorizedHarnessToolResult | null = null;
  let failure: string | null = null;
  let outputBytes = 0;
  try {
    result = await mode.executeTool(execution.lease, name, input, callId);
    requireTrustedResult(result);
    outputBytes = new TextEncoder().encode(
      JSON.stringify(result.output),
    ).byteLength;
  } catch (error) {
    failure = errorMessage(error);
  }
  try {
    await mode.admission.complete(execution.lease, callId, outputBytes);
  } catch (error) {
    execution.unconfirmed = true;
    failure ??= errorMessage(error);
  }
  await state.preflight();
  context.abortSignal?.throwIfAborted();
  // The sources are stored with the result, before Pi can deliver it.
  const sources = mode.claimedCapabilities(callId);
  return result === null || failure !== null
    ? nestedFailure(failure ?? "Tool call failed", sources)
    : nestedResult(result, sources);
}

/** Waits for the Code Mode call that owns a nested call to hold its lease. */
function liveExecution(
  state: ToolState,
  parentCallId: string,
  context: Context,
): Promise<LiveExecution> {
  const signal = context.abortSignal;
  if (signal === undefined) return executionEntry(state, parentCallId).promise;
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = rejectAborted.bind(null, aborted, signal);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([
    executionEntry(state, parentCallId).promise,
    aborted.promise,
  ]).finally(signal.removeEventListener.bind(signal, "abort", abort));
}

function rejectAborted(
  aborted: PromiseWithResolvers<never>,
  signal: AbortSignal,
): void {
  aborted.reject(signal.reason);
}

function executionEntry(
  state: ToolState,
  callId: string,
): PromiseWithResolvers<LiveExecution> {
  let entry = state.executions.get(callId);
  if (entry === undefined) {
    entry = Promise.withResolvers<LiveExecution>();
    // A nested call that outlives its execution is aborted by Pi.
    entry.promise.catch(ignore);
    state.executions.set(callId, entry);
  }
  return entry;
}

function ignore(): void {}

type NestedDetails = {
  pantryAuthority: AuthorizedHarnessToolResult["authority"];
  pantryOutput: AuthorizedHarnessToolResult["output"];
  pantryStatus: AuthorizedHarnessToolResult["status"];
  /** The capabilities whose data the result can hold. */
  pantrySources: readonly string[];
};

function nestedResult(
  result: AuthorizedHarnessToolResult,
  sources: readonly string[],
): ToolExecutionResult {
  const details = nestedDetails({
    pantryAuthority: result.authority,
    pantryOutput: result.output,
    pantryStatus: result.status,
    pantrySources: sources,
  });
  const text = toolText(result);
  if (result instanceof StructuredToolResult)
    return {
      output: [{ type: "text", text }],
      structuredOutput: jsonValue(result.structuredContent),
      isError: result.status === "failed",
      details,
    };
  return result.status === "failed"
    ? {
        output: [{ type: "text", text: failureText(text) }],
        isError: true,
        details,
      }
    : { output: [{ type: "text", text: scriptText(text) }], details };
}

async function nestedFailure(
  message: string,
  sources: readonly string[],
): Promise<ToolExecutionResult> {
  const digest = await sha256Hex(message);
  return {
    output: [{ type: "text", text: message }],
    isError: true,
    details: nestedDetails({
      pantryAuthority: { kind: "read", resultDigest: digest },
      pantryOutput: {
        kind: "inline",
        content: [{ kind: "text", text: message }],
        digest,
      },
      pantryStatus: "failed",
      pantrySources: sources,
    }),
  };
}

function nestedDetails(details: NestedDetails): JsonValue {
  return jsonValue(details);
}

/**
 * What a script receives from a tool without a declared value. The Tool Host
 * wraps a tool's value for the model. A script receives the value itself, as
 * text: a string as it is, and any other value as JSON.
 */
function scriptText(text: string): string {
  const envelope = parseJsonOrNull(text);
  if (!isRecord(envelope) || !Object.hasOwn(envelope, "code_mode_value"))
    return text;
  const value = envelope.code_mode_value;
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function failureText(text: string): string {
  const envelope = parseJsonOrNull(text);
  return isRecord(envelope) &&
    envelope.success === false &&
    typeof envelope.output === "string"
    ? envelope.output
    : text;
}

async function searchTools(
  state: ToolState,
  args: { query: string; limit?: number },
  _api: ToolExecutionApi,
  _context: Context,
) {
  await state.preflight();
  const query = args.query.toLowerCase();
  const words = query.split(/[^a-z0-9]+/u).filter(Boolean);
  const matches = state.host.definitions
    .map(scoreTool.bind(null, query, words))
    .filter(positiveScore)
    .sort(compareScore)
    .slice(0, args.limit ?? 8)
    .map(scoredTool);
  const result = await readResult(JSON.stringify(matches));
  return {
    ...receiptToolResult(result),
    control: { addTools: matches.map(toolName) },
  };
}

function scoreTool(
  query: string,
  words: string[],
  tool: HarnessToolDefinition,
) {
  const name = tool.name.toLowerCase();
  const text = `${name} ${tool.description.toLowerCase()}`;
  let score = name === query ? 1000 : name.includes(query) ? 100 : 0;
  for (const word of words) if (text.includes(word)) score += 1;
  return { tool, score };
}
function positiveScore(match: ReturnType<typeof scoreTool>) {
  return match.score > 0;
}
function compareScore(
  a: ReturnType<typeof scoreTool>,
  b: ReturnType<typeof scoreTool>,
) {
  return b.score - a.score || a.tool.name.localeCompare(b.tool.name);
}
function scoredTool(match: ReturnType<typeof scoreTool>) {
  return match.tool;
}

/**
 * The Code Mode call of a turn. Pi runs the script and records what it
 * delivers, so a later process continues the same script. This function owns
 * what Pi cannot: the attempt of the turn, the admission, the authority over
 * every message of the script, and the settlement.
 */
async function executeCode(
  state: ToolState,
  args: { code: string },
  api: ToolExecutionApi,
  context: Context,
) {
  await state.preflight();
  const stored = await api.snapshot(CodeModeResult, api.taskId, context);
  const saved = stored === undefined ? null : readCodeModeReceipt(stored.state);
  if (saved?.kind === "completed") {
    // A rerun after a loss offers the tool again until Pi ends this call.
    await api.commit(removeCodeModeTool.bind(null, api), context);
    return receiptToolResult(saved.result);
  }
  if (saved?.kind === "pending_settlement")
    return settleSavedExecution(state, api, saved, context);
  const mode = state.host.codeMode;
  if (mode.kind !== "enabled") throw new Error("Code Mode is unavailable");
  if (
    new TextEncoder().encode(args.code).byteLength > MAX_CODE_MODE_SOURCE_BYTES
  )
    throw new Error("Code Mode source exceeds its limit");
  // A started receipt belongs to this same call: its script continues, and
  // the attempt of the turn is not spent again.
  if (saved?.kind !== "started")
    await api.commit(startExecution.bind(null, state.turnId, api), context);
  if (mode.sandbox === null)
    return failBeforeAdmission(
      api,
      context,
      "Code Mode sandbox is unavailable",
    );
  let admitted;
  try {
    admitted = await mode.admission.begin(args.code, api.callId);
  } catch (error) {
    // A resumed execution holds a reservation that only a lease can settle.
    if (saved?.kind === "started") throw error;
    return failBeforeAdmission(api, context, String(error));
  }
  const lease: HarnessCodeModeExecutionLease = {
    executionId: admitted.executionId,
    leaseId: admitted.leaseId,
  };
  const run = admitted.runnable
    ? await runScript(state, mode, mode.sandbox, args, api, context, {
        lease,
        deadlineAt: admitted.executionDeadlineAt,
      })
    : incompatibleRun();
  await state.preflight();
  context.abortSignal?.throwIfAborted();
  // A process that lost the lease has no authority to settle.
  if (run.observed.denial?.code === "code_mode_lease_stale")
    throw new Error("Code Mode execution lease is stale");
  // A lost process can leave a call in flight that this replay did not make
  // again, and a failed claim or completion can leave a call in flight or
  // counts that this process did not receive. Such a call ends here, and the
  // Session takes the counts of the Organisation, before the settlement.
  if (saved?.kind === "started" || run.unconfirmedCalls)
    await mode.admission.abandon(lease);
  const outcome = executionOutcome(run);
  if (outcome !== "succeeded") logScriptFailure(lease, outcome, run);
  const content = boundedContent(run, outcome);
  const text = JSON.stringify({
    content,
    // A script that lost access to a read keeps none of its reads here.
    nestedResults:
      run.observed.denial?.code === "code_mode_access_denied"
        ? []
        : await nestedResults(api, context, run.result),
  });
  const digest = await sha256Hex(text);
  const authorized: PendingCodeModeReceipt["authorized"] = {
    content: [...content, { type: "text", text: CODE_MODE_FINISHED }],
    details: {
      pantryOutput: {
        kind: "inline",
        content: [{ kind: "text", text }],
        digest,
      },
      pantryAuthority: {
        kind: "code_execution",
        receiptId: lease.executionId,
        resultDigest: digest,
      },
    },
    isError: outcome !== "succeeded",
  };
  const pending: PendingCodeModeReceipt = {
    kind: "pending_settlement",
    lease,
    outcome,
    outputBytes: new TextEncoder().encode(text).byteLength,
    authorized,
  };
  await api.commit(
    saveCodeModeReceipt.bind(null, pending, api.taskId),
    context,
  );
  return settleSavedExecution(state, api, pending, context);
}

type Observed = {
  denial: CodeModeExchangeDenial | null;
  terminal: CodeModeRemoteTerminal | null;
};

type ScriptRun = {
  /** Pi's result, or `null` when Pi failed outside the script. */
  readonly result: ToolExecutionResult | null;
  readonly failure: string | null;
  readonly observed: Observed;
  /** A claim or a completion of a call failed. */
  readonly unconfirmedCalls: boolean;
};

async function runScript(
  state: ToolState,
  mode: EnabledCodeMode,
  sandboxRemote: NonNullable<EnabledCodeMode["sandbox"]>,
  args: { code: string },
  api: ToolExecutionApi,
  context: Context,
  execution: {
    readonly lease: HarnessCodeModeExecutionLease;
    readonly deadlineAt: number;
  },
): Promise<ScriptRun> {
  const observed: Observed = { denial: null, terminal: null };
  const live: LiveExecution = {
    lease: execution.lease,
    calls: new Set(),
    closed: false,
    denial: null,
    unconfirmed: false,
  };
  const sandbox = new RemoteCodemodeSandbox({
    remote: governCodeModeRemote({
      remote: sandboxRemote.bind(null, execution.lease.executionId),
      gate: exchangeGate(state, mode, live, api, context, observed),
      deadlineAt: execution.deadlineAt,
      now: Date.now,
    }),
    memoryLimitBytes: CODE_MODE_SANDBOX_MEMORY_BYTES,
  });
  // The model APIs of Pi's tool stay off: a script reaches governed
  // capabilities only.
  const native = createCodemodeTool({ sandbox, models: false });
  executionEntry(state, api.callId).resolve(live);
  let ran: Pick<ScriptRun, "result" | "failure">;
  try {
    const outcome = await native.execute({ code: args.code }, api, context);
    ran = isToolPark(outcome)
      ? { result: null, failure: CODE_MODE_PARK_FAILURE }
      : { result: outcome, failure: null };
  } catch (error) {
    ran = { result: null, failure: errorMessage(error) };
  } finally {
    // Pi aborts the calls that a script left running, and does not wait for
    // them. Each still holds a claim until its Tool Host call returns.
    live.closed = true;
    state.executions.delete(api.callId);
    await Promise.allSettled([...live.calls]);
    await sandbox.close().catch(ignore);
  }
  // Read after the calls ended: a call that the script left running can fail
  // its completion after the script.
  return { ...ran, observed, unconfirmedCalls: live.unconfirmed };
}

/**
 * Pi 1.6 lets a tool park instead of returning a result. This host runs the
 * script inline and cannot resume a parked script, and no Pantry tool parks,
 * so a park ends the script as a failure.
 */
const CODE_MODE_PARK_FAILURE =
  "Code Mode parked the script, and this host does not resume a parked script";

function isToolPark(
  outcome: ToolExecutionResult | ToolPark,
): outcome is ToolPark {
  return "sleep" in outcome || "wait" in outcome;
}

/** An execution that another catalog or policy admitted. No VM starts. */
function incompatibleRun(): ScriptRun {
  return {
    result: null,
    failure:
      "The script cannot resume: the tools of this runtime differ from the tools that it started with.",
    observed: {
      denial: {
        code: "code_mode_catalog_changed",
        reason: "The admitted catalog or policy differs from the current one",
      },
      terminal: null,
    },
    unconfirmedCalls: false,
  };
}

/**
 * The authority over one attempt. A lease check is local and precedes every
 * message. A tool result also needs its recorded sources to be readable now,
 * whether the Tool Host produced it in this process or in an earlier one.
 */
function exchangeGate(
  state: ToolState,
  mode: EnabledCodeMode,
  live: LiveExecution,
  api: ToolExecutionApi,
  context: Context,
  observed: Observed,
): CodeModeExchangeGate {
  return {
    admitStart: requireLease.bind(null, state),
    admitCall: requireLease.bind(null, state),
    admitResult: admitResult.bind(null, state, mode, live, api, context),
    denied(denial) {
      observed.denial ??= denial;
    },
    ended(terminal) {
      observed.terminal ??= terminal;
    },
  };
}

async function requireLease(
  state: ToolState,
): Promise<CodeModeExchangeDenial | null> {
  try {
    await state.preflight();
    return null;
  } catch (error) {
    return { code: "code_mode_lease_stale", reason: errorMessage(error) };
  }
}

async function admitResult(
  state: ToolState,
  mode: EnabledCodeMode,
  live: LiveExecution,
  api: ToolExecutionApi,
  context: Context,
  call: CodeModeRemoteCall,
): Promise<CodeModeExchangeDenial | null> {
  const stale = await requireLease(state);
  if (stale !== null) return stale;
  // A refused capability call ends the script before it reads any result.
  if (live.denial !== null) return live.denial;
  // A discovery answer comes from the catalog that the turn already offers.
  if (call.target === "global") return null;
  const nested = await api.snapshot(
    NestedCallDoc,
    api.taskId,
    `c${call.id}`,
    context,
  );
  const sources = recordedSources(nested?.result);
  if (sources === null)
    return {
      code: "code_mode_access_denied",
      reason: `The result of ${call.name} has no recorded sources`,
    };
  const authorized = await mode
    .authorizeSources(sources)
    .catch(rejectedSources);
  return authorized.ok
    ? null
    : {
        code: "code_mode_access_denied",
        reason: `The sources of ${call.name} are not readable: ${authorized.error.detail}`,
      };
}

function rejectedSources(error: unknown) {
  return { ok: false as const, error: { detail: errorMessage(error) } };
}

/**
 * The sources of a recorded nested result. A failure that Pi wrote itself,
 * such as invalid arguments, holds no tool data and has no sources. Any other
 * result without recorded sources cannot be delivered.
 */
function recordedSources(result: unknown): readonly string[] | null {
  if (!isRecord(result)) return null;
  const details = result.details;
  if (!isRecord(details)) return result.isError === true ? [] : null;
  const sources = details.pantrySources;
  return Array.isArray(sources) && sources.every(isString) ? sources : null;
}

/** Codes and an error class only: a script's text and its data stay out of logs. */
function logScriptFailure(
  lease: HarnessCodeModeExecutionLease,
  outcome: CodeModeExecutionOutcome,
  run: ScriptRun,
): void {
  const { denial, terminal } = run.observed;
  const message = [
    run.failure,
    ...(run.result?.output ?? []).map((item) =>
      item.type === "text" ? item.text : null,
    ),
  ].find((text) => text !== null);
  traceWarn("code_mode.script_failed", {
    requestId: newRequestId(),
    execution_id: lease.executionId,
    outcome,
    denial_code: denial?.code ?? null,
    terminal: terminal?.kind ?? null,
    terminal_error: terminal?.kind === "failure" ? terminal.error : null,
    error_class: message?.match(/\b[A-Z][A-Za-z]{0,40}Error\b/u)?.[0] ?? null,
    pi_failed_outside_script: run.result === null,
  });
}

function executionOutcome(run: ScriptRun): CodeModeExecutionOutcome {
  if (run.result !== null && run.result.isError !== true) return "succeeded";
  const { denial, terminal } = run.observed;
  if (denial !== null)
    switch (denial.code) {
      case "code_mode_deadline_expired":
      case "code_mode_access_denied":
      case "code_mode_discovery_limit":
      case "code_mode_argument_limit":
      case "code_mode_journal_limit":
        return "organisation_failed";
      case "code_mode_lease_stale":
      case "code_mode_catalog_changed":
      case "code_mode_protocol_invalid":
      case "code_mode_admission_frozen":
        return "platform_failed";
      default:
        return denial.code satisfies never;
    }
  // Pi refused to run or to replay the script, or failed outside it.
  if (terminal === null) return "platform_failed";
  switch (terminal.kind) {
    case "done":
      // The script threw.
      return "organisation_failed";
    case "failure":
      // The script used up its computation or its deadline.
      return terminal.error === "timeout"
        ? "organisation_failed"
        : "platform_failed";
    case "crash":
    case "transport":
      return "platform_failed";
    default:
      return terminal satisfies never;
  }
}

type ResultContent = PendingCodeModeReceipt["authorized"]["content"];

const NO_OUTPUT_FILE = /\n*\[Could not save the full output: [^\]]*\]/gu;

/**
 * What the model reads of the script's result. Pi bounds it by tokens, and
 * Pantry's allowance is in bytes: a larger result becomes a bounded error. Pi
 * names a file for output that it cut, and this runtime has no files.
 */
function boundedContent(
  run: ScriptRun,
  outcome: CodeModeExecutionOutcome,
): ResultContent {
  const content: ResultContent = [];
  for (const item of run.result?.output ?? [])
    content.push(
      item.type === "text"
        ? { type: "text", text: item.text.replace(NO_OUTPUT_FILE, "") }
        : { type: "image", data: item.data, mimeType: item.mimeType },
    );
  if (run.failure !== null) content.push({ type: "text", text: run.failure });
  // Pi reports every stop as the same sandbox failure. The reason is here.
  if (outcome !== "succeeded" && run.observed.denial !== null)
    content.push({
      type: "text",
      text: `Code Mode stopped the script: ${run.observed.denial.reason}.`,
    });
  const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  return bytes <= MAX_CODE_MODE_RESULT_BYTES
    ? content
    : [
        {
          type: "text",
          text: `Code Mode output exceeded its limit of ${MAX_CODE_MODE_RESULT_BYTES} bytes. Return a smaller result.`,
        },
      ];
}

type NestedResult = {
  callId: string;
  tool: string;
  result: JsonValue;
};

/**
 * The authorized results of the script's capability calls, in call order. Pi
 * keeps each with its nested call, also the calls of an earlier process.
 */
async function nestedResults(
  api: ToolExecutionApi,
  context: Context,
  result: ToolExecutionResult | null,
): Promise<NestedResult[]> {
  const details = result?.details;
  const calls =
    isRecord(details) && Array.isArray(details.calls) ? details.calls : [];
  const results: NestedResult[] = [];
  for (const call of calls) {
    if (!isRecord(call) || typeof call.id !== "number") continue;
    const nested = await api.snapshot(
      NestedCallDoc,
      api.taskId,
      `c${call.id}`,
      context,
    );
    const recorded: unknown = nested?.result?.details;
    if (
      !isRecord(recorded) ||
      !isRecord(recorded.pantryAuthority) ||
      !isRecord(recorded.pantryOutput)
    )
      continue;
    results.push({
      callId: `call_${await sha256Hex(`${api.callId}/c${call.id}`)}`,
      tool: typeof call.name === "string" ? call.name : "",
      result: jsonValue({
        kind: recorded.pantryAuthority.kind,
        status: recorded.pantryStatus,
        output: recorded.pantryOutput,
        authority: recorded.pantryAuthority,
      }),
    });
  }
  return results;
}

/** Ends a call that reserved nothing. The attempt of the turn stays spent. */
async function failBeforeAdmission(
  api: ToolExecutionApi,
  context: Context,
  reason: string,
) {
  const failed = {
    ...(await readResult(`${reason}\n${CODE_MODE_FINISHED}`)),
    isError: true,
  };
  await api.commit(completeExecution.bind(null, api, failed), context);
  return receiptToolResult(failed);
}

async function settleSavedExecution(
  state: ToolState,
  api: ToolExecutionApi,
  saved: PendingCodeModeReceipt,
  context: Context,
) {
  if (state.host.codeMode.kind !== "enabled")
    throw new Error("Code Mode settlement is unavailable");
  await state.preflight();
  await state.host.codeMode.admission.settle(
    saved.lease,
    saved.outcome,
    saved.outputBytes,
  );
  await api.commit(
    completeExecution.bind(null, api, saved.authorized),
    context,
  );
  return receiptToolResult(saved.authorized);
}

const CODE_MODE_FINISHED =
  "Code Mode is finished for this accepted turn. Please do not retry Code Mode admission. Use discovered direct tools for further permitted reads. A new accepted turn can use Code Mode again.";

async function startExecution(turnId: string, api: ToolExecutionApi, tx: Tx) {
  await startCodeModeReceipt(tx, api.taskId);
  const store = await tx.doc(CodeModeStore, api.conversationId);
  if (store.execution.kind === "used" && store.execution.turnId === turnId)
    throw new Error("Code Mode already used in this turn");
  store.execution = { kind: "used", turnId, harnessTaskId: api.taskId };
}

async function completeExecution(
  api: ToolExecutionApi,
  authorized: PendingCodeModeReceipt["authorized"],
  tx: Tx,
) {
  await removeCodeModeTool(api, tx);
  await completeCodeModeReceipt(tx, api.taskId, authorized);
}

async function removeCodeModeTool(api: ToolExecutionApi, tx: Tx) {
  const agent = await tx.doc(AgentDoc, api.conversationId);
  if (Array.isArray(agent.tools))
    agent.tools = agent.tools.filter(isDirectTool);
  else
    agent.tools = {
      remove: [...new Set([...(agent.tools?.remove ?? []), "codemode"])],
    };
}

function toolText(result: AuthorizedHarnessToolResult) {
  return result.output.kind === "artifact"
    ? result.output.preview
    : result.output.content.map(renderHarnessHistoryContent).join("\n");
}
function requireTrustedResult(result: AuthorizedHarnessToolResult): void {
  if (
    result.kind !== result.authority.kind ||
    result.output.digest !== result.authority.resultDigest
  )
    throw new Error("Invalid trusted tool result");
}
function authorizedResult(
  result: AuthorizedHarnessToolResult,
): ToolExecutionResult {
  requireTrustedResult(result);
  return {
    output: [{ type: "text", text: toolText(result) }],
    details: {
      pantryAuthority: result.authority,
      pantryOutput: JSON.parse(canonicalJson(result.output)),
    },
    isError: result.status === "failed",
  };
}
// Stored receipts keep their own content shape. Convert to the upstream tool
// result only where a receipt crosses into the harness.
function receiptToolResult(result: AuthorizedResult): ToolExecutionResult {
  return {
    output: result.content,
    details: result.details,
    isError: result.isError,
  };
}
async function readResult(text: string): Promise<AuthorizedResult> {
  const digest = await sha256Hex(text);
  return {
    content: [{ type: "text", text }],
    details: {
      pantryAuthority: { kind: "read", resultDigest: digest },
      pantryOutput: {
        kind: "inline",
        content: [{ kind: "text", text }],
        digest,
      },
    },
    isError: false,
  };
}

/** A value of a trusted record, as the JSON that Pi stores. */
function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value));
}

function isDirectTool(name: string): boolean {
  return name !== "codemode";
}
