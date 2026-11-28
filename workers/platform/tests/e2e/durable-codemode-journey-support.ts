import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { SessionDO } from "../../src/actors/agent-session";
import { readImportedCanonicalSession } from "@purin-labs/agent/actors/agent-session-canonical";
import { codeModePlatformGovernor } from "@purin-labs/agent/actors/code-mode-platform-governor-stub";
import {
  parseCodeModeExecutionRecord,
  type CodeModeExecutionRecord,
} from "@purin-labs/agent/actors/code-mode-execution-record";
import { CODE_MODE_PILOT_BUDGET } from "@purin-labs/agent/actors/code-mode-budget";
import { classifyCodeModeRecovery } from "@purin-labs/agent/actors/code-mode-recovery";
import { OrganisationDO } from "../../src/actors/organisation";
import type { Env } from "@purin-labs/kernel/env";
import { revokeAccessGrant } from "@purin-labs/authority/data/access-grants";
import { newRequestId } from "@purin-labs/kernel/ids";
import { network } from "./network";
import { installEffectAuthority } from "./pi-sdk-effect-support";
import {
  DISCOVERY_GRANT_ID,
  ORGANISATION_ID,
  ROOT_TS,
  installDiscoveryActorFixture,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
  isApprovalCard,
} from "./slack-journey-support";
import { runAlarmHandler } from "./durable-object-alarm-support";

// The journeys of Plan 50A that run a Code Mode script through the Slack
// Actor path share these steps. The Session, Organisation, and governor
// Actors, the Pi harness, and the sandbox Worker are the real ones. The
// model replies are controlled.

/** A name that only the result of an `integration_list` read holds. */
export const READ_DATA = "Supplier Dropbox";
/** What the Connector posts for a turn that ended without an answer. */
export const TURN_FAILED_NOTICE =
  "Sous Chef couldn’t complete this request. Please try again.";

/**
 * What the Organisation Actor does with one call of a controlled method:
 * `never` keeps the call open for good and does not run it, `lost` runs it
 * and keeps its answer for good, `held` keeps it until the journey releases
 * it, `oversized` runs a completion whose read answered more than the output
 * budget of the script holds, `dropped` runs it and its answer fails on the
 * way back, and `pass` lets it through.
 */
export type Passage =
  "never" | "lost" | "pass" | "held" | "oversized" | "dropped";

/** One reply of the model, in the order of its requests. */
export type ModelReply =
  | { readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly text: string };

type ControlledMethod = "completeCodeModeCapability" | "settleCodeModeBudget";

type MethodControl = {
  readonly passages: Passage[];
  readonly released: Promise<void>;
  /** What each call that reached the Organisation Actor names. */
  readonly calls: string[];
  /** The method of the Organisation Actor, as the journey found it. */
  original: ((this: OrganisationDO, input: never) => unknown) | null;
};

export type ScriptTurn = Awaited<ReturnType<typeof startScriptTurn>>;

/**
 * Sends one Slack message whose turn runs a script, and returns when the turn
 * waits at the first passage that is not `pass`, or at once when the journey
 * names none. `completions` control each completion of a capability call, and
 * `settlements` control each settlement of the execution, at the Organisation
 * Actor. Calls after a list pass.
 */
export async function startScriptTurn(
  test: TestContext,
  options: {
    readonly eventId: string;
    readonly replies: readonly ModelReply[];
    readonly completions?: readonly Passage[];
    readonly settlements?: readonly Passage[];
    /** The Organisation of the journey. The default grants one read. */
    readonly install?: () => Promise<unknown>;
    /** What the operator asks. The model replies do not depend on it. */
    readonly text?: string;
  },
) {
  await (options.install ?? installDiscoveryActorFixture)();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyInOrder.bind(null, requests, options.replies),
    ),
    slack.handler,
  );
  const organisation = await organisationActor();
  const governor = codeModePlatformGovernor(env);
  const held = Promise.withResolvers<void>();
  const completion = methodControl(options.completions, held.promise);
  const settlement = methodControl(options.settlements, held.promise);
  await runInDurableObject(
    organisation,
    controlMethod.bind(null, test, "completeCodeModeCapability", completion),
  );
  await runInDurableObject(
    organisation,
    controlMethod.bind(null, test, "settleCodeModeBudget", settlement),
  );
  await sendThreadMessage(
    "app_mention",
    options.eventId,
    ROOT_TS,
    options.text ?? "<@U0PANTRY> Read the granted integration metadata twice.",
  );
  await waitForStop(completion, options.completions);
  await waitForStop(settlement, options.settlements);
  // The Connector creates the Session Actor when it starts the turn.
  await expect
    .poll(activeObjectNameOrNull.bind(null, "session"), { timeout: 20_000 })
    .not.toBeNull();
  const sessionName = (await sessionObjectName()).name;
  return {
    organisation,
    governor,
    session: env.SESSION.getByName(sessionName),
    sessionName,
    slack,
    requests,
    /** The call ID of each completion that reached the Organisation Actor. */
    completed: completion.calls,
    /** The execution ID of each settlement that reached it. */
    settling: settlement.calls,
    completion,
    releaseHeld: held.resolve,
  };
}

/**
 * Controls each completion of a capability call at the Organisation Actor,
 * for a journey that starts its turn itself. `calls` holds the call ID of
 * each completion that reached the Actor.
 */
export async function controlCapabilityCompletions(
  test: TestContext,
  organisation: DurableObjectStub<OrganisationDO>,
  passages: readonly Passage[],
): Promise<Pick<MethodControl, "calls">> {
  const control = methodControl(passages, Promise.resolve());
  await runInDurableObject(
    organisation,
    controlMethod.bind(null, test, "completeCodeModeCapability", control),
  );
  return control;
}

function methodControl(
  passages: readonly Passage[] | undefined,
  released: Promise<void>,
): MethodControl {
  return {
    passages: [...(passages ?? [])],
    released,
    calls: [],
    original: null,
  };
}

async function waitForStop(
  control: MethodControl,
  passages: readonly Passage[] | undefined,
): Promise<void> {
  const stopAt = (passages ?? []).findIndex(isStop) + 1;
  if (stopAt === 0) return;
  await expect
    .poll(countCalls.bind(null, control.calls), { timeout: 20_000 })
    .toBe(stopAt);
}

function isStop(passage: Passage): boolean {
  return passage !== "pass";
}

export function countCalls(calls: readonly string[]): number {
  return calls.length;
}

/** Sends one signed Slack event of the journey's thread to the Worker. */
export async function sendThreadMessage(
  eventType: "app_mention" | "message",
  eventId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({ eventType, eventId, messageTs, threadTs: ROOT_TS, text }),
    ),
  );
  expect(response.status).toBe(200);
}

/** What the ledgers and the Session hold for the one execution of a turn. */
export async function readAdmitted(
  journey: Pick<ScriptTurn, "organisation" | "governor" | "session">,
) {
  return {
    organisation: await readOrganisationLedger(journey.organisation),
    governor: await runInDurableObject(journey.governor, readGovernorLedger),
    session: await runInDurableObject(journey.session, readSessionExecution),
  };
}

/**
 * The Connector lost its call when the Session Actor was lost, and it keeps
 * the Case work under its lease. The resumed turn completes in the Session.
 * The Connector reads that turn again when its lease ends, and delivers it.
 * The journey ends the lease in place of a wait of two minutes.
 */
export async function deliverAfterConnectorLease(
  journey: Pick<ScriptTurn, "slack">,
  session: DurableObjectStub<SessionDO>,
): Promise<void> {
  await expect
    .poll(readLifecycleKind.bind(null, session), { timeout: 20_000 })
    .toBe("sleeping");
  // A proposal's approval notice posts on its own; the turn's answer waits
  // for the connector.
  const notices = journey.slack.messages.filter(isApprovalCard).length;
  expect(journey.slack.messages).toHaveLength(notices);
  const connector = await connectorActor();
  await runInDurableObject(connector, endCaseWorkLease);
  await runAlarmHandler(connector);
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(notices + 1);
}

export function endCaseWorkLease(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const work = state.storage.sql
    .exec<{ event_id: string; state_kind: string }>(
      "SELECT event_id, state_kind FROM connector_case_work",
    )
    .one();
  if (work.state_kind !== "running")
    throw new Error(`Case work is ${work.state_kind}`);
  state.storage.sql.exec(
    "UPDATE connector_case_work SET due_at = ? WHERE event_id = ?",
    Date.now(),
    work.event_id,
  );
}

/** Makes the next attempt of the Case work due now, in place of a wait. */
export function makeCaseWorkDue(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_case_work SET due_at = ?",
    Date.now(),
  );
}

export async function readCaseWorkOutcome(connector: DurableObjectStub) {
  return runInDurableObject(connector, inspectCaseWorkOutcome);
}

/** The receipt of the Case work, or its state while no receipt exists. */
function inspectCaseWorkOutcome(_actor: unknown, state: DurableObjectState) {
  const receipt = state.storage.sql
    .exec<{ outcome: string; reason: string | null }>(
      "SELECT outcome, reason FROM connector_case_work_receipt",
    )
    .toArray()[0];
  if (receipt !== undefined) return receipt;
  const pending = state.storage.sql
    .exec<{ state_kind: string; retry_reason: string | null }>(
      "SELECT state_kind, retry_reason FROM connector_case_work",
    )
    .toArray()[0];
  return pending === undefined
    ? null
    : { outcome: pending.state_kind, reason: pending.retry_reason };
}

/** An Organisation whose operator may propose a catalog listing. */
export async function installListingAuthority(): Promise<void> {
  const fixture = await installSlackActorFixture();
  await installEffectAuthority(fixture.selectedIntegrationAccountId, "listing");
}

export async function revokeDiscoveryGrant(): Promise<void> {
  const revoked = await revokeAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: DISCOVERY_GRANT_ID,
    expectedRevision: 1,
    reason: "Revoke the read of a running script",
    now: Date.now(),
  });
  if (!revoked.ok) throw new Error(revoked.error.code);
}

/** Ends the Session Actor instance, and returns a stub of the next one. */
export async function loseSession(
  journey: Pick<ScriptTurn, "session" | "sessionName">,
): Promise<DurableObjectStub<SessionDO>> {
  await runInDurableObject(journey.session, loseProcess).catch(
    ignoreLostProcess,
  );
  // The lost instance broke its stub. A new stub reaches the next instance.
  return env.SESSION.getByName(journey.sessionName);
}

function loseProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Recovery journey: the Session Actor is lost");
}

function ignoreLostProcess(): void {}

async function replyInOrder(
  requests: Record<string, unknown>[],
  replies: readonly ModelReply[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(body);
  const reply = replies[requests.length - 1];
  if (reply === undefined) throw new Error("Unexpected model request");
  const id = `journey_reply_${requests.length}`;
  return "tool" in reply
    ? openRouterToolCall(reply.tool, reply.args, id)
    : openRouterText(reply.text, id);
}

/** The discovery of `integration_list`, as the first reply of a turn. */
export const DISCOVER_INTEGRATION_LIST: ModelReply = {
  tool: "tool_search",
  args: { query: "integration_list", limit: 1 },
};

export function scriptReply(code: string): ModelReply {
  return { tool: "codemode", args: { code } };
}

export function lastToolText(
  body: Record<string, unknown> | undefined,
): string {
  if (body === undefined || !Array.isArray(body.messages))
    throw new Error("Missing model messages");
  for (const message of [...body.messages].reverse()) {
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
  }
  throw new Error("Missing tool result");
}

export function serialized(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

export function messageText(message: Record<string, string>): string {
  return message.text ?? "";
}

/**
 * Puts the journey between the Session and the Organisation Actor for each
 * call of one method, until the test ends.
 */
function controlMethod(
  test: TestContext,
  method: ControlledMethod,
  control: MethodControl,
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype: unknown = Object.getPrototypeOf(actor);
  if (!isRecord(prototype)) throw new Error("Unexpected Organisation Actor");
  const original = actor[method] as NonNullable<MethodControl["original"]>;
  control.original = original;
  Object.defineProperty(prototype, method, {
    value: async function controlled(
      this: OrganisationDO,
      input: {
        readonly callId?: string;
        readonly executionId: string;
        readonly outputBytes?: number;
      },
    ) {
      control.calls.push(input.callId ?? input.executionId);
      const passage = control.passages.shift() ?? "pass";
      if (passage === "never") return new Promise(neverSettles);
      if (passage === "held") await control.released;
      const answer: unknown = await original.call(
        this,
        (passage === "oversized"
          ? {
              ...input,
              outputBytes:
                (input.outputBytes ?? 0) +
                CODE_MODE_PILOT_BUDGET.maxOutputBytes,
            }
          : input) as never,
      );
      if (passage === "dropped") throw new Error("Network connection lost.");
      return passage === "lost" ? new Promise(neverSettles) : answer;
    },
    configurable: true,
    writable: true,
  });
  test.onTestFinished(restoreMethod.bind(null, prototype, method, original));
}

function restoreMethod(
  prototype: object,
  method: ControlledMethod,
  original: unknown,
): void {
  Object.defineProperty(prototype, method, {
    value: original,
    configurable: true,
    writable: true,
  });
}

/** A completion that the journey makes itself, outside its own control. */
export function completeUncontrolled(
  journey: Pick<ScriptTurn, "completion">,
  input: Parameters<OrganisationDO["completeCodeModeCapability"]>[0],
  actor: unknown,
) {
  const original = journey.completion.original;
  if (!(actor instanceof OrganisationDO) || original === null)
    throw new Error("Unexpected Organisation Actor");
  return original.call(actor, input as never) as ReturnType<
    OrganisationDO["completeCodeModeCapability"]
  >;
}

function neverSettles(): void {}

/** What a journey sees and controls of the sandbox Worker. */
export type SandboxControl = {
  /** The execution and the source of each VM that an Actor started. */
  readonly started: { readonly execution: string; readonly code: string }[];
  /** Ends each call to the sandbox Worker, as a lost connection does. */
  readonly loseTransport: () => void;
};

/**
 * Puts the journey between the Actors and the sandbox Worker until the test
 * ends, or removes the binding of the sandbox Worker. Every Actor instance
 * of the test Worker holds the same bindings, so the journey reaches them
 * through the Organisation Actor before the Session Actor exists.
 */
export function controlSandbox(
  test: TestContext,
  binding: "watched" | "missing",
  actor: unknown,
): SandboxControl {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const bindings: unknown = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor bindings");
  const namespace = bindings.CODE_MODE_SANDBOX as Env["CODE_MODE_SANDBOX"];
  if (namespace === undefined) throw new Error("Missing sandbox binding");
  const started: SandboxControl["started"] = [];
  const lost = Promise.withResolvers<never>();
  lost.promise.catch(neverSettles);
  const watched: Pick<typeof namespace, "getByName"> = {
    getByName(name) {
      const sandbox = namespace.getByName(name);
      return Object.assign(Object.create(sandbox), {
        execute(...call: Parameters<typeof sandbox.execute>) {
          started.push({ execution: name, code: call[0].data.code });
          return Promise.race([sandbox.execute(...call), lost.promise]);
        },
      });
    },
  };
  bindings.CODE_MODE_SANDBOX = binding === "missing" ? undefined : watched;
  test.onTestFinished(restoreSandbox.bind(null, bindings, namespace));
  return {
    started,
    loseTransport: lost.reject.bind(
      null,
      new Error("Network connection lost."),
    ),
  };
}

function restoreSandbox(
  bindings: Record<string, unknown>,
  namespace: unknown,
): void {
  bindings.CODE_MODE_SANDBOX = namespace;
}

export function failFirstRebind(actor: unknown): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype = Object.getPrototypeOf(actor);
  const rebind = actor.rebindCodeModeLease;
  Object.defineProperty(prototype, "rebindCodeModeLease", {
    value: function unreachable() {
      Object.defineProperty(prototype, "rebindCodeModeLease", {
        value: rebind,
        configurable: true,
        writable: true,
      });
      throw new Error("Organisation Actor lost before the rebind");
    },
    configurable: true,
    writable: true,
  });
}

type Governor = ReturnType<
  typeof env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR.getByName
>;

export async function controlAdmission(
  governor: Governor,
  command: "freeze_admission" | "open_admission",
): Promise<void> {
  const controlled = await governor.controlAdmission({
    command,
    requestId: newRequestId(),
    idempotencyKey: `recovery-journey-${command}-${crypto.randomUUID()}`,
    requestedBy: "plan-50a-recovery-journey",
    reason: "Recovery journey",
    now: Date.now(),
  });
  if (!controlled.ok) throw new Error(controlled.error.code);
}

/**
 * The calls of a script whose results Pi holds. A script that runs again
 * receives each of them from Pi, and the Tool Host does not run them again.
 */
export function countRecordedScriptCalls(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec(
      "SELECT id FROM tasks WHERE kind = ? AND status = 'terminal' AND json_extract(record, '$.input.kind') = 'nested'",
      JSON.stringify("pi.tool"),
    )
    .toArray().length;
}

/** The commerce actions that the Organisation holds, in proposal order. */
export function readProposedActions(
  _actor: unknown,
  state: DurableObjectState,
) {
  return state.storage.sql
    .exec<{ nonce: string; proposal_id: string; state: string }>(
      "SELECT nonce, proposal_id, state FROM action_ledger ORDER BY rowid",
    )
    .toArray();
}

function readSessionExecution(_actor: unknown, state: DurableObjectState) {
  const row = state.storage.sql
    .exec<{ request_envelope: string; state_kind: string }>(
      "SELECT request_envelope, state_kind FROM actor_outbox WHERE json_extract(request_envelope, '$.kind') = 'code_mode_execution.v1'",
    )
    .one();
  const record = parseCodeModeExecutionRecord(row.request_envelope);
  if (record === null) throw new Error("Invalid execution record");
  return { record, stateKind: row.state_kind };
}

/**
 * The record of the Session's one execution: its outbox state, and what the
 * state holds.
 */
export function readExecutionRecord(
  _actor: unknown,
  state: DurableObjectState,
) {
  const row = state.storage.sql
    .exec<{ state_kind: string; state_projection: string }>(
      "SELECT state_kind, state_projection FROM actor_outbox WHERE effect_id LIKE 'execution-cmx-%'",
    )
    .one();
  const projection: unknown = JSON.parse(row.state_projection);
  if (!isRecord(projection)) throw new Error("Invalid execution projection");
  return { state: row.state_kind, projection };
}

/** The executions of the Session, running or settled. */
export function countExecutions(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec(
      "SELECT effect_id FROM actor_outbox WHERE effect_id LIKE 'execution-cmx-%'",
    )
    .toArray().length;
}

export function readSettlement(_actor: unknown, state: DurableObjectState) {
  const settlement = readSettlementOrNull(_actor, state);
  if (settlement === null) throw new Error("Missing settlement record");
  return settlement;
}

export async function readSessionSettlement(
  session: DurableObjectStub<SessionDO>,
) {
  return runInDurableObject(session, readSettlementOrNull);
}

/**
 * What the Session accepted as history and as delivery of its turns. This is
 * the text that a later turn, a fork, or a reader of the conversation can
 * receive.
 */
export function readAcceptedText(
  _actor: unknown,
  state: DurableObjectState,
): string {
  const sql = state.storage.sql;
  const text: string[] = [];
  for (const table of ["session_harness_history", "turn_delivery_segment"])
    for (const row of sql.exec(`SELECT payload FROM ${table}`).toArray())
      text.push(String(row.payload));
  return text.join("\n");
}

/**
 * The tool calls that the Session delivered to the readers of its turns, in
 * delivery order.
 */
export function readDeliveredToolCalls(
  _actor: unknown,
  state: DurableObjectState,
): string[] {
  const tools: string[] = [];
  for (const row of state.storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM turn_delivery_segment ORDER BY sequence",
    )
    .toArray()) {
    const segment: unknown = JSON.parse(row.payload);
    if (
      isRecord(segment) &&
      isRecord(segment.event) &&
      segment.event.type === "agent_tool_use" &&
      typeof segment.event.tool === "string"
    )
      tools.push(segment.event.tool);
  }
  return tools;
}

export function readSettlementOrNull(
  _actor: unknown,
  state: DurableObjectState,
) {
  const row = state.storage.sql
    .exec<{ request_envelope: string; state_kind: string }>(
      "SELECT request_envelope, state_kind FROM actor_outbox WHERE json_extract(request_envelope, '$.kind') = 'code_mode_execution_settlement.v1'",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const request: unknown = JSON.parse(row.request_envelope);
  if (!isRecord(request) || !isRecord(request.settle))
    throw new Error("Invalid settlement record");
  return { state: row.state_kind, settle: request.settle };
}

export function readTurnStreams(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ turn_id: string; state: string; error_detail: string | null }>(
      "SELECT turn_id, state, error_detail FROM session_turn_stream ORDER BY turn_id",
    )
    .toArray();
}

export function boundAuthority(record: CodeModeExecutionRecord) {
  if (record.authority.kind !== "bound")
    throw new Error(`Execution is ${record.authority.kind}`);
  return record.authority;
}

export async function readLifecycleKind(
  session: DurableObjectStub<SessionDO>,
): Promise<string> {
  return runInDurableObject(session, inspectLifecycleKind);
}

function inspectLifecycleKind(
  _actor: unknown,
  state: DurableObjectState,
): string {
  return readLifecycle(_actor, state).kind;
}

export function readLifecycle(_actor: unknown, state: DurableObjectState) {
  const session = readImportedCanonicalSession(
    state.storage.sql,
    ORGANISATION_ID,
  );
  if (!session.ok) throw new Error(session.error.code);
  return session.value.lifecycle;
}

/** The lifecycle, the execution record, and the recovery of a running turn. */
export function readSessionState(_actor: unknown, state: DurableObjectState) {
  const session = readImportedCanonicalSession(
    state.storage.sql,
    ORGANISATION_ID,
  );
  if (!session.ok) throw new Error(session.error.code);
  const lifecycle = session.value.lifecycle;
  if (lifecycle.kind !== "recovering" && lifecycle.kind !== "processing")
    throw new Error(`Session is ${lifecycle.kind}`);
  return {
    lifecycle,
    record: readSessionExecution(_actor, state).record,
    recovery: classifyCodeModeRecovery(
      state.storage.sql,
      lifecycle.state.activeTurn,
      Date.now(),
    ),
  };
}

type LedgerRow = Record<string, SqlStorageValue>;

export function readGovernorLedger(_actor: unknown, state: DurableObjectState) {
  return {
    reservations: state.storage.sql
      .exec<LedgerRow>(
        "SELECT execution_id, admission_digest, lease_id, runtime_generation, state, reserved_cost_micros, execution_deadline_at, lease_expires_at FROM code_mode_platform_reservation ORDER BY execution_id",
      )
      .toArray(),
  };
}

export async function readOrganisationLedger(
  organisation: DurableObjectStub<OrganisationDO>,
) {
  return runInDurableObject(organisation, inspectOrganisationLedger);
}

function inspectOrganisationLedger(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  return {
    reservations: sql
      .exec<LedgerRow>(
        "SELECT execution_id, admission_digest, lease_id, runtime_generation, state, reserved_cost_micros, execution_deadline_at, lease_expires_at FROM code_execution_reservation ORDER BY execution_id",
      )
      .toArray(),
    counters: sql
      .exec<LedgerRow>(
        "SELECT execution_id, capability_calls, in_flight_calls, input_bytes, output_bytes FROM code_execution_call_counter ORDER BY execution_id",
      )
      .toArray(),
    calls: sql
      .exec<{ call_id: string; state: string; input_bytes: number }>(
        "SELECT call_id, state, input_bytes FROM code_execution_call ORDER BY claimed_at, call_id",
      )
      .toArray(),
  };
}

export function ledgerEvidence(
  organisation: Awaited<ReturnType<typeof readOrganisationLedger>>,
  governor: ReturnType<typeof readGovernorLedger>,
) {
  return JSON.parse(JSON.stringify({ organisation, governor }));
}

export async function organisationActor(): Promise<
  DurableObjectStub<OrganisationDO>
> {
  return env.ORGANISATION.getByName(await activeObjectName("organisation"));
}

export async function connectorActor() {
  return env.CONNECTOR.getByName(await activeObjectName("connector"));
}

export async function sessionObjectName(): Promise<{ name: string }> {
  return { name: await activeObjectName("session") };
}

type ActorKind = "organisation" | "connector" | "session";

async function activeObjectName(kind: ActorKind): Promise<string> {
  const name = await activeObjectNameOrNull(kind);
  if (name === null) throw new Error(`${kind} Actor missing`);
  return name;
}

async function activeObjectNameOrNull(kind: ActorKind): Promise<string | null> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = ? AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID, kind)
    .first<{ name: string }>();
  return row?.name ?? null;
}
