import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { recoverInterruptedSessionInTransaction } from "../../src/actors/actor-journal/transactions";
import { discardHarnessTurnContinuation } from "../../src/actors/agent-session-continuation";
import { failSessionTurnStream } from "../../src/actors/agent-session-turn-stream";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { deriveCodeModeLeaseBinding } from "../../src/actors/code-mode-execution-record";
import { OrganisationDO } from "../../src/actors/organisation";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { newRequestId, type CaseId, type SessionId } from "../../src/ids";
import {
  preparePortalChatJourney,
  assignmentStates,
  caseOf,
  dispatchCommand,
  leaveOldAssignment,
  sessionOf,
} from "./chat-journey-support";
import {
  organisationActor,
  readLifecycleKind,
  readOrganisationLedger,
} from "./durable-codemode-journey-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

/**
 * An old quarantine from an interrupted turn ends, and its assignment with it.
 *
 * Before Refactor 15, a process loss in the middle of a turn quarantined the
 * Session as `effect_indeterminate`, and only termination could end that
 * quarantine. Nothing terminated it, so the Session never proved that it ran
 * no turn, and its Case kept the assignment `running` for ever. The census
 * of 2026-11-07 found 16 such assignments.
 *
 * Two commands stop under their model requests, and each Session gets the
 * quarantine that the older release wrote. The second Session also holds an
 * effect whose result nobody knows. Each Case gets an old `running`
 * assignment with no wakeup, and every process ends. When the Sessions and
 * then the Cases wake, the first Session ends as failed and its Case ends the
 * assignment as abandoned. The second Session keeps its quarantine, because
 * its effect may have happened, and its assignment stays `running`. Before
 * the Sessions wake, the Session census names the kind of that effect and
 * why its result is unknown, so an operator can choose how to settle it.
 */
it(
  "ends an old interrupted-turn quarantine unless an effect result is unknown",
  oldQuarantineJourney,
  120_000,
);

/**
 * An old refused Code Mode settlement settles from the Organisation's record,
 * and its quarantine ends (Refactor 15).
 *
 * The census of 2026-11-09 found three Sessions quarantined since the
 * Organisation refused their settlement while a call of the script was in
 * flight. Two commands run a script each, and a late call of each execution
 * is in flight when the Organisation answers its settlement, so each Session
 * quarantines as in production. The first reservation then passes its lease:
 * the Organisation's record shows that the settlement never happened. The
 * second reservation moved to the lease of the next runtime generation, so no
 * record decides that Session's receipt. A day later the Sessions wake. The
 * first settlement settles, the Session ends and its Case abandons the
 * assignment. The second Session stays quarantined, with its assignment.
 */
it(
  "settles an old refused Code Mode settlement from the Organisation's record",
  refusedSettlementJourney,
  180_000,
);

const ENDED_KEY = "session_quarantine_end_clean";
const KEPT_KEY = "session_quarantine_end_effect";
const INSTRUCTION = "Count the open supplier orders.";

/** Each model request waits while the phase is `held`. */
type Model = {
  readonly requests: unknown[];
  phase: "held" | "released";
};

async function oldQuarantineJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const model: Model = { requests: [], phase: "held" };
  test.onTestFinished(() => {
    model.phase = "released";
  });
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerModel.bind(null, model),
    ),
  );

  const ended = await stopUnderQuarantine(session, model, ENDED_KEY, 1, false);
  const kept = await stopUnderQuarantine(session, model, KEPT_KEY, 2, true);
  model.phase = "released";

  // The census names both old assignments before anything wakes, and the
  // kind of the effect that keeps the second Session quarantined.
  expect(await staleAssignmentCount()).toBe(2);
  expect(await unknownEffects(ended.sessionId)).toBeUndefined();
  expect(await unknownEffects(kept.sessionId)).toEqual({
    "code_mode_execution.v1:process_lost:lt_1d": 1,
  });
  for (const caseId of [ended.caseId, kept.caseId])
    await runInDurableObject(await caseOf(caseId), loseProcess).catch(
      ignoreLostProcess,
    );

  // The Sessions wake, and then the Cases. The first Case's wakeup ends its
  // assignment as abandoned.
  for (const sessionId of [ended.sessionId, kept.sessionId])
    await (await sessionOf(sessionId)).ping();
  await expect
    .poll(
      async () => {
        const woken = await caseOf(ended.caseId);
        await runDurableObjectAlarm(woken);
        return assignmentStates(woken);
      },
      { timeout: 20_000, interval: 250 },
    )
    .toEqual(["settled:abandoned"]);

  // The second Case runs its wakeup too, and keeps its assignment.
  const keptCase = await caseOf(kept.caseId);
  await expect
    .poll(() => runDurableObjectAlarm(keptCase), {
      timeout: 10_000,
      interval: 250,
    })
    .toBe(true);
  expect(await assignmentStates(keptCase)).toEqual(["running"]);

  // The census counts only the assignment of the Session whose effect is
  // unknown.
  expect(await staleAssignmentCount()).toBe(1);
  expect(model.requests).toHaveLength(2);

  Object.assign(test.task.meta, {
    sessionQuarantineEnd: {
      endedAssignment: "settled:abandoned",
      keptAssignment: "running",
      staleAfter: 1,
    },
  });
}

const SETTLED_KEY = "session_quarantine_settlement_expired";
const UNDECIDED_KEY = "session_quarantine_settlement_moved";
const REFUSED_SETTLEMENT = {
  "code_mode_execution_settlement.v1:code_mode_capability_calls_in_flight:lt_1d": 1,
};
const DAY_MS = 24 * 60 * 60_000;

/** Each settlement waits at the Organisation until the journey releases it. */
type SettleGate = { readonly calls: string[]; held: Promise<void> };

async function refusedSettlementJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const model: Model = { requests: [], phase: "held" };
  test.onTestFinished(() => {
    model.phase = "released";
  });
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerWithScript.bind(null, model),
    ),
  );
  const organisation = await organisationActor();
  const gate: SettleGate = { calls: [], held: Promise.resolve() };
  await runInDurableObject(
    organisation,
    holdSettlements.bind(null, test, gate),
  );
  const settled = await refuseSettlement(
    session,
    organisation,
    gate,
    SETTLED_KEY,
  );
  const undecided = await refuseSettlement(
    session,
    organisation,
    gate,
    UNDECIDED_KEY,
  );
  const moved = await organisation.rebindCodeModeLease({
    requestId: newRequestId(),
    organisationId: ORGANISATION_ID,
    executionId: undecided.executionId,
    admissionDigest: undecided.admissionDigest,
    previous: undecided.binding,
    next: await deriveCodeModeLeaseBinding(
      undecided.executionId,
      undecided.binding.runtimeGeneration + 1,
    ),
    now: Date.now(),
  });
  expect(moved.ok).toBe(true);
  expect(await staleAssignmentCount()).toBe(2);
  for (const sessionId of [settled.sessionId, undecided.sessionId])
    expect(await unknownEffects(sessionId)).toEqual(REFUSED_SETTLEMENT);

  // The first reservation passes its lease, and a day passes for both.
  await scheduler.wait(Math.max(0, settled.leaseExpiresAt - Date.now() + 500));
  for (const sessionId of [settled.sessionId, undecided.sessionId]) {
    const actor = await sessionOf(sessionId);
    await runInDurableObject(actor, ageRefusedSettlement);
    await runInDurableObject(actor, loseProcess).catch(ignoreLostProcess);
  }
  for (const caseId of [settled.caseId, undecided.caseId])
    await runInDurableObject(await caseOf(caseId), loseProcess).catch(
      ignoreLostProcess,
    );

  // The Sessions wake, and then the first Case abandons its assignment.
  for (const sessionId of [settled.sessionId, undecided.sessionId])
    await (await sessionOf(sessionId)).ping();
  await expect
    .poll(
      async () => {
        const woken = await caseOf(settled.caseId);
        await runDurableObjectAlarm(woken);
        return assignmentStates(woken);
      },
      { timeout: 20_000, interval: 250 },
    )
    .toEqual(["settled:abandoned"]);
  const keptCase = await caseOf(undecided.caseId);
  await expect
    .poll(() => runDurableObjectAlarm(keptCase), {
      timeout: 10_000,
      interval: 250,
    })
    .toBe(true);
  expect(await assignmentStates(keptCase)).toEqual(["running"]);
  expect(await unknownEffects(settled.sessionId)).toBeUndefined();
  expect(await unknownEffects(undecided.sessionId)).toEqual({
    "code_mode_execution_settlement.v1:code_mode_capability_calls_in_flight:lt_7d": 1,
  });
  expect(await staleAssignmentCount()).toBe(1);

  Object.assign(test.task.meta, {
    refusedSettlement: {
      settledAssignment: "settled:abandoned",
      undecidedAssignment: "running",
      staleAfter: 1,
    },
  });
}

/**
 * Runs a command whose script ends while a late call of its execution is in
 * flight, so the Organisation refuses the settlement and the Session
 * quarantines. Its Case keeps an old `running` assignment with no wakeup.
 */
async function refuseSettlement(
  session: IssuedControlSession,
  organisation: Awaited<ReturnType<typeof organisationActor>>,
  gate: SettleGate,
  key: string,
) {
  const released = Promise.withResolvers<void>();
  gate.held = released.promise;
  const before = gate.calls.length;
  void dispatchCommand(session, key, INSTRUCTION).catch(ignoreLostProcess);
  await expect
    .poll(() => gate.calls.length, { timeout: 30_000 })
    .toBe(before + 1);
  const executionId = gate.calls[before] ?? "";
  const reservation = (
    await readOrganisationLedger(organisation)
  ).reservations.find((row) => row.execution_id === executionId);
  if (reservation === undefined) throw new Error("reservation_missing");
  const binding = {
    leaseId: String(reservation.lease_id),
    runtimeGeneration: Number(reservation.runtime_generation),
  };
  const claimed = await organisation.claimCodeModeCapability({
    requestId: newRequestId(),
    organisationId: ORGANISATION_ID,
    executionId,
    leaseId: binding.leaseId,
    callId: "call-late",
    inputBytes: 2,
    now: Date.now(),
  });
  expect(claimed.ok).toBe(true);
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:api:${SLACK_ACTOR_USER_ID}:${key}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  released.resolve();
  const sessionActor = await sessionOf(identities.value.sessionId);
  await expect
    .poll(() => readLifecycleKind(sessionActor), { timeout: 20_000 })
    .toBe("quarantined");
  // The turn's next model request waits, and the process is lost under it.
  await runInDurableObject(sessionActor, endTurnAsOlderRelease);
  await runInDurableObject(sessionActor, loseProcess).catch(ignoreLostProcess);
  const caseActor = await caseOf(identities.value.caseId);
  await expect
    .poll(() => assignmentStates(caseActor), { timeout: 10_000 })
    .toEqual(["running"]);
  await runInDurableObject(caseActor, leaveOldAssignment);
  return {
    sessionId: identities.value.sessionId,
    caseId: identities.value.caseId,
    executionId,
    admissionDigest: String(reservation.admission_digest),
    binding,
    leaseExpiresAt: Number(reservation.lease_expires_at),
  };
}

/** The model runs one script. Its request after the result waits. */
async function answerWithScript(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.requests.push(await request.json());
  const id = `refused_settlement_${model.requests.length}`;
  if (!JSON.stringify(model.requests.at(-1)).includes('"role":"tool"'))
    return openRouterToolCall("codemode", { code: 'text("counted");' }, id);
  while (model.phase === "held") await scheduler.wait(5);
  return openRouterText("Counted.", id);
}

/** Puts the gate between the Sessions and the Organisation's settlement. */
function holdSettlements(
  test: TestContext,
  gate: SettleGate,
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype: object = Object.getPrototypeOf(actor);
  const original = actor.settleCodeModeBudget;
  const define = (value: unknown) =>
    Object.defineProperty(prototype, "settleCodeModeBudget", {
      value,
      configurable: true,
      writable: true,
    });
  define(async function held(
    this: OrganisationDO,
    input: Parameters<OrganisationDO["settleCodeModeBudget"]>[0],
  ) {
    gate.calls.push(input.executionId);
    await gate.held;
    return original.call(this, input);
  });
  test.onTestFinished(() => void define(original));
}

/**
 * The older release's recovery of the interrupted turn: its stream fails and
 * its lease goes, as `recoverInterruptedSessionInTransaction` does. That
 * recovery does nothing for a Session that is quarantined already. The older
 * release left the Session with no wakeup.
 */
async function endTurnAsOlderRelease(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.deleteAlarm();
  const sql = state.storage.sql;
  state.storage.transactionSync(() => {
    for (const { turn_id } of sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM session_turn_stream WHERE state = 'running'",
      )
      .toArray()) {
      const failed = failSessionTurnStream(
        sql,
        turn_id,
        "session_interrupted",
        Date.now(),
      );
      if (!failed.ok) throw new Error(failed.error.code);
    }
    sql.exec("DELETE FROM session_harness_lease");
  });
}

/** Two days pass for the refused settlement, with no wakeup. */
async function ageRefusedSettlement(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.deleteAlarm();
  state.storage.sql.exec(
    "UPDATE actor_outbox SET updated_at = updated_at - ? WHERE state_kind = 'indeterminate'",
    2 * DAY_MS,
  );
}

/**
 * Starts a command, holds its model request, and leaves its Session and Case
 * as the older release did: a quarantined Session whose process is lost, and
 * an old `running` assignment in a Case with no wakeup.
 */
async function stopUnderQuarantine(
  session: IssuedControlSession,
  model: Model,
  key: string,
  requestCount: number,
  unknownEffect: boolean,
): Promise<{ readonly sessionId: SessionId; readonly caseId: CaseId }> {
  const response = dispatchCommand(session, key, INSTRUCTION).then(
    (answer) => answer.status,
    () => "lost" as const,
  );
  await expect
    .poll(() => model.requests.length, { timeout: 30_000 })
    .toBe(requestCount);
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:api:${SLACK_ACTOR_USER_ID}:${key}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const sessionActor = await sessionOf(identities.value.sessionId);
  await runInDurableObject(
    sessionActor,
    unknownEffect ? quarantineWithUnknownEffect : quarantineAsOlderRelease,
  );
  await runInDurableObject(sessionActor, loseProcess).catch(ignoreLostProcess);
  const caseActor = await caseOf(identities.value.caseId);
  await expect
    .poll(() => assignmentStates(caseActor), { timeout: 10_000 })
    .toEqual(["running"]);
  await runInDurableObject(caseActor, leaveOldAssignment);
  // The held model request ends with the lost process, so the command does
  // not answer.
  void response;
  return {
    sessionId: identities.value.sessionId,
    caseId: identities.value.caseId,
  };
}

async function answerModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.requests.push(await request.json());
  while (model.phase === "held") await scheduler.wait(5);
  return openRouterText(
    JSON.stringify({ kind: "reply", text: "There are three open orders." }),
    `quarantine_answer_${model.requests.length}`,
  );
}

/**
 * The recovery of the older release: the interrupted turn quarantines the
 * Session.
 */
function quarantineAsOlderRelease(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.transactionSync(() => {
    recoverInterruptedSessionInTransaction(state.storage.sql, Date.now());
    discardHarnessTurnContinuation(state.storage.sql);
  });
}

/** The same quarantine, with an effect whose result nobody knows. */
function quarantineWithUnknownEffect(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const organisation = state.storage.sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM session_meta LIMIT 1",
    )
    .one().organisation_id;
  state.storage.sql.exec(
    `INSERT INTO actor_outbox (
       effect_id, organisation_id, originating_event_id, request_envelope,
       state_kind, state_projection, updated_at
     ) VALUES ('execution-unknown', ?, 'event-unknown', ?, 'indeterminate', ?, ?)`,
    organisation,
    JSON.stringify({ kind: "code_mode_execution.v1" }),
    JSON.stringify({ kind: "indeterminate", reason: "process_lost" }),
    Date.now(),
  );
  quarantineAsOlderRelease(_actor, state);
}

/** The old active assignments that the admin census route counts. */
async function staleAssignmentCount(): Promise<number> {
  const response = await exports.default.fetch(
    new Request("https://localhost/v1/admin/machine-census", {
      headers: { authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}` },
    }),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const machines =
    isRecord(body) && isRecord(body.machines) ? body.machines : {};
  const stale = machines.case_assignment_stale;
  return isRecord(stale)
    ? Object.values(stale).reduce<number>(
        (sum, count) => sum + (typeof count === "number" ? count : 0),
        0,
      )
    : 0;
}

/** The Session census entry of effects whose result nobody knows. */
async function unknownEffects(
  sessionId: Parameters<typeof sessionOf>[0],
): Promise<Readonly<Record<string, number>> | undefined> {
  const census = await (await sessionOf(sessionId)).machineCensus();
  return census.find(
    (entry) => entry.machine === "session_indeterminate_effect",
  )?.states;
}

function loseProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Quarantine journey: the Actor's process is lost");
}

function ignoreLostProcess(): void {}
