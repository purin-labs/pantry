import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { deriveCodeModeLeaseBinding } from "../../src/actors/code-mode-execution-record";
import { OrganisationDO } from "../../src/actors/organisation";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { newRequestId } from "../../src/ids";
import {
  preparePortalChatJourney,
  assignmentStates,
  caseOf,
  dispatchCommand,
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
 * A refused Code Mode settlement settles from the Organisation's record, and
 * its quarantine ends (Refactor 15).
 *
 * Two commands run a script each, and a late call of each execution is in
 * flight when the Organisation answers its settlement, so each Session
 * quarantines, its turn fails and its Case settles the assignment as
 * failed. The first reservation then passes its lease: the Organisation's
 * record shows that the settlement never happened. The second reservation
 * moved to the lease of the next runtime generation, so no record decides
 * that Session's receipt. Two days pass, the idle Sessions stop, and they
 * wake. The first settlement settles and its quarantine ends. The second
 * Session stays quarantined.
 */
it(
  "settles a refused Code Mode settlement from the Organisation's record",
  refusedSettlementJourney,
  180_000,
);

const INSTRUCTION = "Count the open supplier orders.";

type Model = { readonly requests: unknown[] };

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
  const model: Model = { requests: [] };
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
  for (const sessionId of [settled.sessionId, undecided.sessionId])
    expect(await unknownEffects(sessionId)).toEqual(REFUSED_SETTLEMENT);

  // The first reservation passes its lease, and two days pass for both
  // Sessions. Their processes end, as idle Actors do, and they wake.
  await scheduler.wait(Math.max(0, settled.leaseExpiresAt - Date.now() + 500));
  for (const sessionId of [settled.sessionId, undecided.sessionId]) {
    const actor = await sessionOf(sessionId);
    await runInDurableObject(actor, letTwoDaysPass);
    await runInDurableObject(actor, endProcess).catch(ignoreEndedProcess);
    await (await sessionOf(sessionId)).ping();
  }
  const sessions = {
    settled: await sessionOf(settled.sessionId),
    undecided: await sessionOf(undecided.sessionId),
  };
  await expect
    .poll(() => readLifecycleKind(sessions.settled), { timeout: 20_000 })
    .not.toBe("quarantined");
  expect(await readLifecycleKind(sessions.undecided)).toBe("quarantined");
  expect(await unknownEffects(settled.sessionId)).toBeUndefined();
  expect(await unknownEffects(undecided.sessionId)).toEqual({
    "code_mode_execution_settlement.v1:code_mode_capability_calls_in_flight:lt_7d": 1,
  });

  Object.assign(test.task.meta, {
    refusedSettlement: {
      settledSession: await readLifecycleKind(sessions.settled),
      undecidedSession: "quarantined",
      assignments: [settled.assignments, undecided.assignments],
    },
  });
}

/**
 * Runs a command whose script ends while a late call of its execution is in
 * flight, so the Organisation refuses the settlement and the Session
 * quarantines. The turn then fails, and its Case settles the assignment as
 * failed.
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
  // The command answers only after the turn; its result is the failed turn.
  void dispatchCommand(session, key, INSTRUCTION).catch(ignoreAnswer);
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
  const caseActor = await caseOf(identities.value.caseId);
  await expect
    .poll(() => assignmentStates(caseActor), { timeout: 20_000 })
    .toEqual(["settled:failed"]);
  expect(await readLifecycleKind(sessionActor)).toBe("quarantined");
  return {
    sessionId: identities.value.sessionId,
    assignments: await assignmentStates(caseActor),
    executionId,
    admissionDigest: String(reservation.admission_digest),
    binding,
    leaseExpiresAt: Number(reservation.lease_expires_at),
  };
}

/** The model runs one script, then answers. */
async function answerWithScript(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.requests.push(await request.json());
  const id = `refused_settlement_${model.requests.length}`;
  if (!JSON.stringify(model.requests.at(-1)).includes('"role":"tool"'))
    return openRouterToolCall("codemode", { code: 'text("counted");' }, id);
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

/** Two days pass for the refused settlement and the lease of the failed turn. */
function letTwoDaysPass(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE actor_outbox SET updated_at = updated_at - ? WHERE state_kind = 'indeterminate'",
    2 * DAY_MS,
  );
  state.storage.sql.exec(
    "UPDATE session_harness_lease SET issued_at = issued_at - ?1, expires_at = expires_at - ?1",
    2 * DAY_MS,
  );
}

function endProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Quarantine journey: the Actor's process ends");
}

function ignoreEndedProcess(): void {}

/** The Session census entry of effects whose result nobody knows. */
async function unknownEffects(
  sessionId: Parameters<typeof sessionOf>[0],
): Promise<Readonly<Record<string, number>> | undefined> {
  const census = await (await sessionOf(sessionId)).machineCensus();
  return census.find(
    (entry) => entry.machine === "session_indeterminate_effect",
  )?.states;
}

function ignoreAnswer(): void {}
