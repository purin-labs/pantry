import type {
  AcceptedInputRef,
  EmbeddedHarnessModelUsage,
  HarnessTurnLease,
  TurnIdentity,
} from "@purin-labs/contracts";
import {
  createCancellableTask,
  type CancellableTask,
  type TaskCancellationReason,
} from "@purin-labs/async-control/cancellable-task";
import { describe, expect, it } from "vitest";

import type {
  CanonicalHarnessEventSink,
  CanonicalHarnessHistorySink,
  EmbeddedHarnessActiveTurn,
  EmbeddedHarnessAdapter,
  EmbeddedHarnessCancelError,
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessConstructionError,
  EmbeddedHarnessRuntime,
  EmbeddedHarnessStartTask,
  EmbeddedHarnessTurnError,
  EmbeddedHarnessTurnResult,
  EmbeddedHarnessUserInput,
} from "../src/actors/embedded-harness";
import {
  createTransientHarnessSinks,
  runTransientEmailTurn,
  type TransientEmailTeardownOutcome,
} from "../src/actors/transient-email-turn";
import { piToolReplay } from "../src/actors/pi-tool-replay";
import { TOOL_REGISTRY } from "../src/agent-tools/registry";
import type { Result } from "../src/result";

const NOW = 1_784_016_325_277;

describe("transient email turn", transientEmailTurnSuite);

function transientEmailTurnSuite(): void {
  it("returns the reply body and retains nothing durable", successTest);
  it("rejects empty and oversized bodies", bodyValidationTest);
  it("tears down after turn failures", turnFailureTest);
  it("tears down after construction failures", constructionFailureTest);
  it("fails closed when cleanup fails", cleanupFailureTest);
  it("cancels and tears down when the wall clock is exhausted", deadlineTest);
  it("times out when starting the harness stalls", startDeadlineTest);
  it("times out when teardown stalls", teardownDeadlineTest);
  it("advances transient sink cursors without persistence", sinkTest);
}

async function startDeadlineTest(): Promise<void> {
  const script = newScript({ hangStart: true });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 25,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_turn_failed",
  ).toBe(true);
  if (!result.ok && result.error.code === "transient_email_turn_failed") {
    expect(result.error.detail).toBe("wall_clock_exhausted");
  }
  expect(script.teardownCalls).toEqual(["failed"]);
  expect(script.closedBeforeTeardown).toBe(true);
}

async function teardownDeadlineTest(): Promise<void> {
  const script = newScript({ finalMessage: "A reply.", hangTeardown: true });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 25,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_cleanup_failed",
  ).toBe(true);
  if (!result.ok && result.error.code === "transient_email_cleanup_failed") {
    expect(result.error.detail).toBe("teardown_wall_clock_exhausted");
  }
  expect(script.teardownCalls).toEqual(["completed"]);
  expect(script.teardownCancelled).toBe(true);
}

async function deadlineTest(): Promise<void> {
  const script = newScript({ hangCompletion: true });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 25,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_turn_failed",
  ).toBe(true);
  if (!result.ok && result.error.code === "transient_email_turn_failed") {
    expect(result.error.detail).toBe("wall_clock_exhausted");
  }
  expect(script.cancelled).toBe(true);
  expect(script.teardownCalls).toEqual(["failed"]);
}

async function successTest(): Promise<void> {
  const script = newScript({
    finalMessage: "  Thanks for reaching out — your order ships Monday.  ",
  });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "customer asked about order status" }],
    maxBodyChars: 10_000,
    maxWallMs: 60_000,
    teardown: script.teardown,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.body).toBe(
      "Thanks for reaching out — your order ships Monday.",
    );
    expect(result.value.modelUsage.totalTokens).toBe(42);
  }
  expect(script.teardownCalls).toEqual(["completed"]);
  expect(script.closedBeforeTeardown).toBe(true);
  expect(script.sinkWrites.events).toBeGreaterThan(0);
  expect(script.sinkWrites.history).toBeGreaterThan(0);
}

async function bodyValidationTest(): Promise<void> {
  const empty = newScript({ finalMessage: "   " });
  const emptyResult = await runTransientEmailTurn({
    adapter: empty.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 60_000,
    teardown: empty.teardown,
  });
  expect(
    !emptyResult.ok &&
      emptyResult.error.code === "transient_email_body_invalid",
  ).toBe(true);
  expect(empty.teardownCalls).toEqual(["failed"]);

  const oversized = newScript({ finalMessage: "x".repeat(51) });
  const oversizedResult = await runTransientEmailTurn({
    adapter: oversized.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 50,
    maxWallMs: 60_000,
    teardown: oversized.teardown,
  });
  expect(
    !oversizedResult.ok &&
      oversizedResult.error.code === "transient_email_body_invalid",
  ).toBe(true);
  expect(oversized.teardownCalls).toEqual(["failed"]);
}

async function turnFailureTest(): Promise<void> {
  const script = newScript({ failCompletion: true });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 60_000,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_turn_failed",
  ).toBe(true);
  expect(script.teardownCalls).toEqual(["failed"]);
  expect(script.closedBeforeTeardown).toBe(true);
}

async function constructionFailureTest(): Promise<void> {
  const script = newScript({ failConstruction: true });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 60_000,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_construction_failed",
  ).toBe(true);
  expect(script.teardownCalls).toEqual(["failed"]);
}

async function cleanupFailureTest(): Promise<void> {
  const script = newScript({
    finalMessage: "A perfectly good reply.",
    failTeardown: true,
  });
  const result = await runTransientEmailTurn({
    adapter: script.adapter,
    construction: constructionInput(),
    input: [{ kind: "text", text: "cue" }],
    maxBodyChars: 10_000,
    maxWallMs: 60_000,
    teardown: script.teardown,
  });
  expect(
    !result.ok && result.error.code === "transient_email_cleanup_failed",
  ).toBe(true);
  expect(script.teardownCalls).toEqual(["completed"]);
}

async function sinkTest(): Promise<void> {
  const sinks = createTransientHarnessSinks(turnIdentity());
  const first = await sinks.eventSink.acceptCanonicalHarnessEvent({
    leaseId: "harness_lease_1" as never,
    sessionId: "session_transient_email",
    turn: turnIdentity(),
    sequence: 1 as never,
    eventDigest: digest("e1") as never,
    payload: "{}",
    acceptedAt: NOW as never,
  });
  expect(
    first.ok &&
      first.value.kind === "advanced" &&
      first.value.cursor.lastSequence === 1,
  ).toBe(true);
  const duplicate = await sinks.eventSink.acceptCanonicalHarnessEvent({
    leaseId: "harness_lease_1" as never,
    sessionId: "session_transient_email",
    turn: turnIdentity(),
    sequence: 1 as never,
    eventDigest: digest("e1") as never,
    payload: "{}",
    acceptedAt: NOW as never,
  });
  expect(duplicate.ok && duplicate.value.kind === "duplicate").toBe(true);
  const history = await sinks.historySink.appendHarnessHistory({
    leaseId: "harness_lease_1" as never,
    sessionId: "session_transient_email",
    turn: turnIdentity(),
    sequence: 1 as never,
    previousDigest: null,
    entry: {
      kind: "user_input",
      turn: turnIdentity(),
      input: acceptedInput(),
      content: [{ kind: "text", text: "hello" }],
      acceptedAt: NOW as never,
    },
    acceptedAt: NOW as never,
  });
  expect(history.ok && history.value.kind === "advanced").toBe(true);
  expect(sinks.usage()).toEqual({ acceptedEvents: 1, historyEntries: 1 });
}

type Script = {
  readonly adapter: EmbeddedHarnessAdapter;
  readonly teardown: (
    outcome: TransientEmailTeardownOutcome,
  ) => CancellableTask<
    Result<null, { readonly detail: string }>,
    Result<null, { readonly detail: string }>
  >;
  readonly teardownCalls: TransientEmailTeardownOutcome[];
  readonly sinkWrites: { events: number; history: number };
  readonly closedBeforeTeardown: boolean;
  readonly cancelled: boolean;
  readonly teardownCancelled: boolean;
};

type ScriptOptions = {
  readonly finalMessage?: string;
  readonly failCompletion?: boolean;
  readonly failConstruction?: boolean;
  readonly failTeardown?: boolean;
  readonly hangCompletion?: boolean;
  readonly hangStart?: boolean;
  readonly hangTeardown?: boolean;
};

type ScriptState = {
  closed: boolean;
  closedBeforeTeardown: boolean;
  cancelled: boolean;
  teardownCancelled: boolean;
  readonly teardownCalls: TransientEmailTeardownOutcome[];
  readonly sinkWrites: { events: number; history: number };
  startDeferred: Deferred<
    Result<EmbeddedHarnessActiveTurn, EmbeddedHarnessTurnError>
  > | null;
  completionDeferred: Deferred<
    Result<EmbeddedHarnessTurnResult, EmbeddedHarnessTurnError>
  > | null;
};

function newScript(options: ScriptOptions): Script {
  const state: ScriptState = {
    closed: false,
    closedBeforeTeardown: false,
    cancelled: false,
    teardownCancelled: false,
    teardownCalls: [] as TransientEmailTeardownOutcome[],
    sinkWrites: { events: 0, history: 0 },
    startDeferred: null,
    completionDeferred: null,
  };
  const adapter: EmbeddedHarnessAdapter = {
    manifest: {
      backendId: "pi",
      harnessBuild: "test-harness" as never,
      checkpointFormat: "test-format" as never,
      model: "test-model",
    },
    construct: constructScriptedRuntime.bind(null, options, state),
  };
  return {
    adapter,
    teardownCalls: state.teardownCalls,
    sinkWrites: state.sinkWrites,
    get closedBeforeTeardown() {
      return state.closedBeforeTeardown;
    },
    get cancelled() {
      return state.cancelled;
    },
    get teardownCancelled() {
      return state.teardownCancelled;
    },
    teardown: startScriptedTeardown.bind(null, options, state),
  };
}

function constructScriptedRuntime(
  options: ScriptOptions,
  state: ScriptState,
  input: EmbeddedHarnessConstructionInput,
): Result<EmbeddedHarnessRuntime, EmbeddedHarnessConstructionError> {
  if (options.failConstruction === true) {
    return {
      ok: false,
      error: {
        code: "embedded_harness_runtime_unavailable",
        detail: "scripted",
      },
    };
  }
  return {
    ok: true,
    value: {
      startTurn: startScriptedTurn.bind(null, options, state, input),
      close: closeScriptedRuntime.bind(null, state),
    },
  };
}

function startScriptedTurn(
  options: ScriptOptions,
  state: ScriptState,
  input: EmbeddedHarnessConstructionInput,
  _turnInput: readonly EmbeddedHarnessUserInput[],
): EmbeddedHarnessStartTask {
  state.startDeferred = options.hangStart === true ? new Deferred() : null;
  const completion =
    state.startDeferred?.promise ??
    completeScriptedStart(options, state, input);
  return createCancellableTask({
    completion,
    cancel: cancelScriptedStart.bind(null, state, completion),
  });
}

async function completeScriptedStart(
  options: ScriptOptions,
  state: ScriptState,
  input: EmbeddedHarnessConstructionInput,
): Promise<Result<EmbeddedHarnessActiveTurn, EmbeddedHarnessTurnError>> {
  await driveSinks(input.eventSink, input.historySink, state.sinkWrites);
  return {
    ok: true,
    value: {
      complete: completeScriptedTurn.bind(null, options, state),
      cancel: cancelScriptedTurn.bind(null, state),
      steer: refuseScriptedSteering,
    },
  };
}

async function cancelScriptedStart(
  state: ScriptState,
  completion: EmbeddedHarnessStartTask["completion"],
  _reason: TaskCancellationReason,
): Promise<Result<null, EmbeddedHarnessCancelError>> {
  state.cancelled = true;
  state.startDeferred?.resolve({
    ok: false,
    error: { code: "embedded_harness_turn_failed", detail: "start_cancelled" },
  });
  await completion;
  return { ok: true, value: null };
}

function completeScriptedTurn(
  options: ScriptOptions,
  state: ScriptState,
): Promise<Result<EmbeddedHarnessTurnResult, EmbeddedHarnessTurnError>> {
  if (options.hangCompletion === true) {
    state.completionDeferred = new Deferred();
    return state.completionDeferred.promise;
  }
  if (options.failCompletion === true) {
    return Promise.resolve({
      ok: false,
      error: { code: "embedded_harness_turn_failed", detail: "scripted" },
    });
  }
  return Promise.resolve({
    ok: true,
    value: {
      finalMessage: options.finalMessage ?? "",
      checkpoint: new ArrayBuffer(0),
      cursor: {
        turn: turnIdentity(),
        lastSequence: 1 as never,
        lastEventDigest: digest("e1") as never,
      },
      historyCursor: {
        lastSequence: 1 as never,
        lastEntryDigest: digest("h1") as never,
      },
      modelUsage: usage(),
    },
  });
}

async function cancelScriptedTurn(
  state: ScriptState,
): Promise<Result<null, EmbeddedHarnessCancelError>> {
  state.cancelled = true;
  state.completionDeferred?.resolve({
    ok: false,
    error: { code: "embedded_harness_turn_failed", detail: "turn_cancelled" },
  });
  return { ok: true, value: null };
}

async function refuseScriptedSteering() {
  return {
    ok: true as const,
    value: {
      kind: "refused" as const,
      reason: "steering_unsupported" as const,
    },
  };
}

function closeScriptedRuntime(state: ScriptState): void {
  state.closed = true;
}

function startScriptedTeardown(
  options: ScriptOptions,
  state: ScriptState,
  outcome: TransientEmailTeardownOutcome,
): CancellableTask<
  Result<null, { readonly detail: string }>,
  Result<null, { readonly detail: string }>
> {
  state.closedBeforeTeardown =
    state.closed || options.failConstruction === true;
  state.teardownCalls.push(outcome);
  const deferred =
    options.hangTeardown === true
      ? new Deferred<Result<null, { readonly detail: string }>>()
      : null;
  const completion =
    deferred?.promise ??
    Promise.resolve(
      options.failTeardown === true
        ? { ok: false as const, error: { detail: "scripted_cleanup_failure" } }
        : { ok: true as const, value: null },
    );
  return createCancellableTask({
    completion,
    cancel: cancelScriptedTeardown.bind(null, state, deferred, completion),
  });
}

async function cancelScriptedTeardown(
  state: ScriptState,
  deferred: Deferred<Result<null, { readonly detail: string }>> | null,
  completion: Promise<Result<null, { readonly detail: string }>>,
  _reason: TaskCancellationReason,
): Promise<Result<null, { readonly detail: string }>> {
  state.teardownCancelled = true;
  deferred?.resolve({ ok: true, value: null });
  await completion;
  return { ok: true, value: null };
}

class Deferred<TValue> {
  readonly promise: Promise<TValue>;
  #resolve: ((value: TValue) => void) | null = null;

  constructor() {
    this.promise = new Promise<TValue>(this.capture.bind(this));
  }

  resolve(value: TValue): void {
    if (this.#resolve === null)
      throw new Error("deferred resolver unavailable");
    this.#resolve(value);
  }

  private capture(resolve: (value: TValue) => void): void {
    this.#resolve = resolve;
  }
}

async function driveSinks(
  eventSink: CanonicalHarnessEventSink,
  historySink: CanonicalHarnessHistorySink,
  writes: { events: number; history: number },
): Promise<void> {
  const accepted = await eventSink.acceptCanonicalHarnessEvent({
    leaseId: "harness_lease_1" as never,
    sessionId: "session_transient_email",
    turn: turnIdentity(),
    sequence: 1 as never,
    eventDigest: digest("event") as never,
    payload: JSON.stringify({ kind: "status" }),
    acceptedAt: NOW as never,
  });
  if (accepted.ok) writes.events += 1;
  const appended = await historySink.appendHarnessHistory({
    leaseId: "harness_lease_1" as never,
    sessionId: "session_transient_email",
    turn: turnIdentity(),
    sequence: 1 as never,
    previousDigest: null,
    entry: {
      kind: "user_input",
      turn: turnIdentity(),
      input: acceptedInput(),
      content: [{ kind: "text", text: "cue" }],
      acceptedAt: NOW as never,
    },
    acceptedAt: NOW as never,
  });
  if (appended.ok) writes.history += 1;
}

function constructionInput(): Omit<
  EmbeddedHarnessConstructionInput,
  "eventSink" | "historySink"
> {
  return {
    persistence: { kind: "transient" },
    source: { kind: "fresh" },
    inheritedHistory: [],
    inheritedAttachments: {},
    sessionId: "session_transient_email" as never,
    acceptedInput: acceptedInput(),
    model: "test-model",
    modelTokenAllowance: 100_000,
    goalModelCalls: { kind: "untracked" },
    harnessInstructions: "Reply politely in plain text.",
    modelRouteLease: {
      kind: "platform_api_key",
      async resolveModelApiKey() {
        return "test-key";
      },
    },
    checkpointBinding: {
      cursor: null,
      modelRouteDigest: digest("route"),
      instructionDigest: digest("instructions"),
      toolCatalogDigest: digest("catalog"),
      workspaceRevision: digest("workspace"),
      policyRevision: "1",
    },
    toolReplay: piToolReplay.bind(null, TOOL_REGISTRY),
    toolHost: {
      mode: "hybrid",
      codeMode: { kind: "disabled" },
      catalogDigest: digest("catalog"),
      definitions: [],
      async executeTool() {
        throw new Error("tool execution is scripted out of this test");
      },
    },
    turnLease: turnLease(),
    now: () => NOW as never,
  };
}

function turnLease(): HarnessTurnLease {
  return {
    leaseId: "harness_lease_1" as never,
    session: {
      organisationId: "organisation_transient" as never,
      sessionId: "session_transient_email" as never,
      streamId: "stream_transient" as never,
    },
    turn: turnIdentity(),
    runtimeLease: {
      generation: 1 as never,
      leaseId: "runtime_lease_1" as never,
    },
    runtimeRevision: 1 as never,
    requestAuthority: {
      kind: "agent_mailbox",
      organisationId: "organisation_transient" as never,
      integrationAccountId: "integration_gmail_test",
      mailboxBindingId: "mailbox_binding_test",
      bindingRevision: 1,
      mailboxPolicyVersion: 1,
    },
    authorityPartitionDigest: digest("partition") as never,
    issuedAt: NOW as never,
    expiresAt: (NOW + 60_000) as never,
  };
}

function turnIdentity(): TurnIdentity {
  return {
    turnId: "turn_transient_1" as never,
    inputId: "input_transient_1" as never,
    turnLeaseGeneration: 1 as never,
    budgetRevision: "budget_1" as never,
  };
}

function acceptedInput(): AcceptedInputRef {
  return {
    kind: "case",
    inputId: "input_transient_1" as never,
    caseId: "case_gmail_test_thread_1" as never,
    assignmentId: "assignment_transient_1" as never,
    caseRevision: 1 as never,
    contentDigest: digest("content") as never,
    workspaceRevision: digest("workspace") as never,
    contextBundleDigest: digest("bundle") as never,
  };
}

function usage(): EmbeddedHarnessModelUsage {
  return {
    modelCalls: 1,
    callsWithUsage: 1,
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 22,
    reasoningTokens: 0,
    totalTokens: 42,
  };
}

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
