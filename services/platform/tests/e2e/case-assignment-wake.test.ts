import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import type { SessionDO } from "../../src/actors/agent-session";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { preparePortalChatJourney } from "./chat-journey-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  openRouterText,
} from "./slack-journey-support";

/**
 * A stuck assignment from an earlier release ends with no new delivery.
 *
 * The census after the Refactor 15 release found 47 Case assignments in
 * `running`. Only a new assignment sets the Case wakeup that abandons it, so
 * an assignment made before that release had no wakeup, and its Case kept
 * it until a delivery of the same work came back, which may never happen.
 *
 * An admin's command stops: its Session ends the turn as failed, and the
 * Case's assignment stays `running`. The journey then gives the Case the
 * state that the earlier release left: no wakeup, no assignment time, and a
 * start older than the abandon time. The Case's process ends. When the Case
 * wakes for any read, it sets its wakeup; that wakeup ends the assignment
 * as abandoned, with no new command, and leaves no further wakeup.
 *
 * The Case also holds a record that the current release no longer restores,
 * as 14 production Cases from October hold answers whose stored labels no
 * longer restore. The full read of the Case fails for that record; the
 * assignment still ends, because the abandon step reads only assignments.
 */
it(
  "ends an old stuck assignment that has no wakeup when its Case wakes",
  oldStuckAssignmentJourney,
  120_000,
);

const KEY = "case_assignment_wake";
const INSTRUCTION = "Count the open supplier orders.";
const ANSWER = "There are three open orders.";
/** Older than the 30-minute abandon time. */
const OLD_START_AGE_MS = 31 * 60_000;

/** The first model request waits while its phase is `held`. */
type Model = {
  readonly requests: unknown[];
  phase: "waiting" | "held" | "released";
};

async function oldStuckAssignmentJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const model: Model = { requests: [], phase: "waiting" };
  test.onTestFinished(() => {
    model.phase = "released";
  });
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerModel.bind(null, model),
    ),
  );

  // The command stops: the Session's process ends under the model request
  // after Pi's record of the turn's submission is lost.
  const first = dispatchCommand(session, KEY, INSTRUCTION).then(
    (response) => response.status,
    () => "lost" as const,
  );
  await expect.poll(() => model.phase, { timeout: 30_000 }).toBe("held");
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:api:${SLACK_ACTOR_USER_ID}:${KEY}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const lost = await sessionOf(identities.value.sessionId);
  await runInDurableObject(lost, losePiSubmission);
  await runInDurableObject(lost, loseProcess).catch(ignoreLostProcess);
  model.phase = "released";
  expect(await first).not.toBe(200);

  // The next process of the Session ends the turn as failed. Nothing settles
  // the Case's assignment.
  const turnId = `turn_trigger_${identities.value.digest}`;
  await expect
    .poll(
      async () => {
        const resumed = await sessionOf(identities.value.sessionId);
        await runDurableObjectAlarm(resumed).catch(ignoreLostProcess);
        return turnState(resumed, turnId);
      },
      { timeout: 30_000, interval: 500 },
    )
    .toBe("failed");
  const stopped = await caseOf(identities.value.caseId);
  expect(await assignmentStates(stopped)).toEqual(["running"]);

  // The state that the earlier release left, then the end of the process.
  await runInDurableObject(stopped, leaveEarlierReleaseState);
  await runInDurableObject(stopped, leaveUnrestorableRecord);
  expect(await stopped.inspect()).toEqual({
    ok: false,
    error: { code: "case_storage_corrupt" },
  });
  // The census names why it stays: an old assignment in an open Case that
  // has no alarm.
  const staleBefore = await staleCensus(stopped);
  expect(staleBefore).toEqual({ "open:no_alarm": 1 });
  await runInDurableObject(stopped, loseProcess).catch(ignoreLostProcess);

  // The Case wakes for a read. Its wakeup ends the assignment with no new
  // command, and no wakeup stays after it.
  const woken = await caseOf(identities.value.caseId);
  expect(await assignmentStates(woken)).toEqual(["running"]);
  // The wakeup is due at once, so the runtime may run it before this call.
  await expect
    .poll(
      async () => {
        await runDurableObjectAlarm(woken);
        return assignmentStates(woken);
      },
      { timeout: 10_000, interval: 250 },
    )
    .toEqual(["settled:abandoned"]);
  const laterWakeup = await runInDurableObject(woken, readAlarm);
  expect(laterWakeup).toBeNull();
  expect(await staleCensus(woken)).toBeNull();
  expect(model.requests).toHaveLength(1);

  Object.assign(test.task.meta, {
    caseAssignmentWake: {
      before: "running",
      after: "settled:abandoned",
      laterWakeup,
      modelRequests: model.requests.length,
    },
  });
}

async function answerModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.requests.push(await request.json());
  if (model.requests.length === 1) {
    model.phase = "held";
    while (model.phase === "held") await scheduler.wait(5);
  }
  return openRouterText(
    JSON.stringify({ kind: "reply", text: ANSWER }),
    `wake_answer_${model.requests.length}`,
  );
}

function dispatchCommand(
  session: IssuedControlSession,
  key: string,
  instruction: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/cases/commands`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({ instruction }),
    },
  );
}

async function sessionOf(
  sessionId: Parameters<typeof resolveActiveSessionActor>[0]["sessionId"],
): Promise<DurableObjectStub<SessionDO>> {
  const resolved = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

async function caseOf(
  caseId: Parameters<typeof resolveActiveCaseActor>[0]["caseId"],
) {
  const resolved = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

async function turnState(
  session: DurableObjectStub<SessionDO>,
  turnId: string,
): Promise<string> {
  const inspected = await session.inspectTurnStream({
    organisationId: ORGANISATION_ID,
    turnId,
  });
  if (!inspected.ok) return inspected.error.code;
  return inspected.value.kind === "missing" ? "missing" : inspected.value.state;
}

async function assignmentStates(
  caseActor: Awaited<ReturnType<typeof caseOf>>,
): Promise<string[]> {
  const lifecycles = await caseActor.assignmentLifecycles();
  if (!lifecycles.ok) throw new Error(lifecycles.error.code);
  return lifecycles.value.map((lifecycle) =>
    lifecycle.kind === "settled"
      ? `settled:${lifecycle.disposition.kind}`
      : lifecycle.kind,
  );
}

/**
 * What a Case of the earlier release holds: no wakeup, no assignment time,
 * and a start older than the abandon time.
 */
async function leaveEarlierReleaseState(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.deleteAlarm();
  const rows = state.storage.sql
    .exec<{ assignment_id: string; lifecycle_json: string }>(
      "SELECT assignment_id, lifecycle_json FROM case_assignment",
    )
    .toArray();
  for (const row of rows) {
    const lifecycle: unknown = JSON.parse(row.lifecycle_json);
    if (!isRecord(lifecycle) || !isRecord(lifecycle.start))
      throw new Error("case_assignment_start_missing");
    const acceptedAt = Number(lifecycle.start.acceptedAt) - OLD_START_AGE_MS;
    lifecycle.start.acceptedAt =
      typeof lifecycle.start.acceptedAt === "string"
        ? String(acceptedAt)
        : acceptedAt;
    state.storage.sql.exec(
      "UPDATE case_assignment SET lifecycle_json = ?, assigned_at = NULL WHERE assignment_id = ?",
      JSON.stringify(lifecycle),
      row.assignment_id,
    );
  }
}

/** A binding row in a shape that the current release does not restore. */
function leaveUnrestorableRecord(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "INSERT INTO case_binding (binding_id, payload) VALUES (?, ?)",
    "binding_retired_shape",
    JSON.stringify({ kind: "retired_binding_shape" }),
  );
}

/** Deletes Pi's record of the turn's submission, the record of a lost start. */
function losePiSubmission(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec("DELETE FROM submissions");
}

/** The Case's count of old active assignments, as the census route sums it. */
async function staleCensus(
  caseActor: Awaited<ReturnType<typeof caseOf>>,
): Promise<Record<string, number> | null> {
  const census = await caseActor.machineCensus();
  return (
    census.find((entry) => entry.machine === "case_assignment_stale")?.states ??
    null
  );
}

function readAlarm(
  _actor: unknown,
  state: DurableObjectState,
): Promise<number | null> {
  return state.storage.getAlarm();
}

function loseProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Wake journey: the Actor's process is lost");
}

function ignoreLostProcess(): void {}
