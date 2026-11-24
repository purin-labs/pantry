import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { SessionDO } from "../../src/actors/agent-session";
import { SessionCheckpoints } from "@purin-labs/agent/actors/session/session-checkpoints";
import { fixtureDatabase } from "./organisation-database";
import { network } from "./network";
import {
  ROOT_TS,
  ORGANISATION_ID,
  installSlackActorFixture,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * A turn whose completion fails after its checkpoint is accepted still
 * answers (Refactor 15, refactor 3).
 *
 * The model answers the first message, and the Session accepts the turn's
 * checkpoint. The step that completes the turn then fails once, as a
 * placement read that fails for a moment does. The Session keeps the turn
 * in `checkpointing` and completes it from its alarm: the thread gets the
 * answer, with no failure notice, and the next message of the thread gets
 * its own answer.
 */
it(
  "completes a turn whose finalization failed once, so the thread gets both answers",
  turnCompletionJourney,
  90_000,
);

const FIRST_ANSWER = "FIRST_ANSWER_AFTER_FINALIZATION";
const SECOND_ANSWER = "SECOND_ANSWER_AFTER_FINALIZATION";

async function turnCompletionJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  const requests: unknown[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respond.bind(null, requests),
    ),
    slack.handler,
  );
  const restore = failFirstTurnFinalization();
  test.onTestFinished(restore);

  const admitted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EFINALIZEFIRST",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> summarise this case",
      }),
    ),
  );
  expect(admitted.status).toBe(200);
  // The Session completes the turn from its alarm; the journey runs the
  // alarm in place of the wait. A poll can find no alarm: the answer in Slack
  // is the check.
  await expect
    .poll(
      async () => {
        const session = await sessionStub();
        if (session !== null) await runDurableObjectAlarm(session);
        return slack.visibleMessageCount();
      },
      { timeout: 30_000, interval: 500 },
    )
    .toBe(1);
  expect(slack.messages[0]?.text).toContain(FIRST_ANSWER);

  const reply = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EFINALIZESECOND",
        messageTs: "1787500000.000002",
        threadTs: ROOT_TS,
        text: "and the next step?",
      }),
    ),
  );
  expect(reply.status).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(slack.messages[1]?.text).toContain(SECOND_ANSWER);
  expect(requests).toHaveLength(2);
  Object.assign(test.task.meta, {
    turnCompletion: {
      posts: slack.messages.map((message) => message.text),
      modelRequests: requests.length,
    },
  });
}

function respond(
  requests: unknown[],
  _input: Parameters<HttpResponseResolver>[0],
): Response {
  requests.push(null);
  return openRouterText(
    requests.length === 1 ? FIRST_ANSWER : SECOND_ANSWER,
    `finalize_reply_${requests.length}`,
  );
}

/**
 * The first completion of a turn fails, as a placement read that fails for
 * a moment does. Later completions, and every recovery completion, run.
 */
function failFirstTurnFinalization(): () => void {
  // The checkpoints module of the Session completes a turn.
  const prototype = SessionCheckpoints.prototype as unknown as Record<
    string,
    unknown
  >;
  const original = prototype.finalizeAcceptedSessionCheckpoint as (
    this: SessionCheckpoints,
    input: { readonly caller: { readonly kind: string } },
  ) => Promise<unknown>;
  if (typeof original !== "function")
    throw new Error("Missing turn completion");
  let failed = false;
  Object.defineProperty(prototype, "finalizeAcceptedSessionCheckpoint", {
    value: function finalizeOnceFailed(
      this: SessionCheckpoints,
      input: { readonly caller: { readonly kind: string } },
    ) {
      if (!failed && input.caller.kind === "turn") {
        failed = true;
        return Promise.resolve({
          ok: false,
          error: {
            code: "canonical_text_turn_state_invalid",
            reason: "execution_closed",
          },
        });
      }
      return original.call(this, input);
    },
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(prototype, "finalizeAcceptedSessionCheckpoint", {
      value: original,
      configurable: true,
      writable: true,
    });
}

async function sessionStub(): Promise<DurableObjectStub<SessionDO> | null> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' LIMIT 1",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  return row === null ? null : env.SESSION.getByName(row.name);
}
