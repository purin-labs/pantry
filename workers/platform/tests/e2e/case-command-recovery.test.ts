import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { deriveDirectCaseIdentities } from "@purin-labs/conversation/actors/case-direct-processing";
import {
  preparePortalChatJourney,
  assignmentStates,
  caseOf,
  dispatchCommand,
  sessionOf,
  turnState,
} from "./chat-journey-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  openRouterText,
} from "./slack-journey-support";

/**
 * A command whose first delivery stopped gets a final answer on the next
 * delivery (Refactor 15, refactor 9).
 *
 * An admin sends an agent command through the API. While the model works on
 * it, the process of the command's Session ends at a point that the next
 * process cannot resume, so the first request fails. The Session ends the
 * turn as a failed turn, but nothing settles the Case's assignment, which
 * stays `running`. The admin sends the same command again, with the same
 * idempotency key. That delivery reads the failed turn, ends the assignment
 * as abandoned on the Session's proof that it runs no turn, and answers that
 * the turn failed; a later try gets the same answer. The admin's next
 * command gets an answer. The old direct path answered
 * `case_assignment_in_progress` on every try, so the caller never learned
 * that the work had stopped.
 */
it(
  "ends a stopped command's assignment on its next delivery and takes the next command",
  stuckCommandJourney,
  120_000,
);

const KEY = "case_command_recovery";
const NEXT_KEY = "case_command_recovery_next";
const INSTRUCTION = "Count the open supplier orders.";
const NEXT_INSTRUCTION = "Count the open customer orders.";
const ANSWER = "There are three open orders.";

/** The first model request waits while its phase is `held`. */
type Model = {
  readonly requests: unknown[];
  phase: "waiting" | "held" | "released";
};

async function stuckCommandJourney(test: TestContext): Promise<void> {
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

  // The first delivery: the model request waits, and the Session's process
  // ends under it after Pi's record of the turn's submission is lost.
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

  // The next process of the Session ends the turn as a failed turn. Nothing
  // settles the Case's assignment.
  const turnId = `turn_trigger_${identities.value.digest}`;
  await expect
    .poll(
      async () => {
        const resumed = await sessionOf(identities.value.sessionId);
        // A poll can find no alarm. The turn state below is the check.
        await runDurableObjectAlarm(resumed).catch(ignoreLostProcess);
        return turnState(resumed, turnId);
      },
      { timeout: 30_000, interval: 500 },
    )
    .toBe("failed");
  const caseActor = await caseOf(identities.value.caseId);
  expect(await assignmentStates(caseActor)).toEqual(["running"]);

  // The same command again: the turn failed, and the assignment ends.
  const retried = await dispatchCommand(session, KEY, INSTRUCTION);
  expect(retried.status).toBe(503);
  const retriedError = errorOf(await retried.json());
  expect(retriedError).toBe("case_turn_failed");
  expect(await assignmentStates(caseActor)).toEqual(["settled:abandoned"]);
  const again = await dispatchCommand(session, KEY, INSTRUCTION);
  expect(errorOf(await again.json())).toBe("case_turn_failed");

  // The admin's next command gets an answer.
  const next = await dispatchCommand(session, NEXT_KEY, NEXT_INSTRUCTION);
  const nextBody: unknown = await next.json();
  expect(next.status, JSON.stringify(nextBody)).toBe(200);
  expect(isRecord(nextBody) && nextBody.disposition).toBe("completed");

  Object.assign(test.task.meta, {
    caseCommandRecovery: {
      firstDelivery: "failed",
      retryError: retriedError,
      assignment: "settled:abandoned",
      nextCommand: "completed",
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
    `recovery_answer_${model.requests.length}`,
  );
}

function errorOf(body: unknown): unknown {
  return isRecord(body) ? body.error : null;
}

/** Deletes Pi's record of the turn's submission, the record of a lost start. */
function losePiSubmission(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec("DELETE FROM submissions");
}

function loseProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Recovery journey: the Session Actor is lost");
}

function ignoreLostProcess(): void {}
