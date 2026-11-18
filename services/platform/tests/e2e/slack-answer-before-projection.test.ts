import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { caseActorStub } from "../../src/actors/actor-router";
import type { CaseDO } from "../../src/actors/case";
import { selectOrganisationPlacementDatabase } from "../../src/organisation-execution-scope";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  requiredPlacement,
  signedSlackRequest,
  slackEnvelope,
  respondToSlack,
} from "./slack-journey-support";

/**
 * The Case retains the context projection of an accepted answer in its
 * outbox, with the acceptance, and publishes it after the acceptance
 * returns. The answer therefore does not wait for the queue.
 *
 * The journey holds the queue send of each answer's projection. The answer
 * must reach Slack while the queue still holds the send. The Case then
 * publishes the projection and empties its outbox.
 */
it(
  "posts the Slack answer before the queue takes the answer's context projection",
  answerBeforeProjection,
  60_000,
);

const HOLD_MS = 2_000;

type HeldSend = {
  readonly entryId: string;
  readonly startedAt: number;
  endedAt: number;
};

async function answerBeforeProjection(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const posts: number[] = [];
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", replyToModel),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, posts),
    ),
  );
  const held = holdAnswerProjections(test);

  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev55E_PROJECTION",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0SATYR> open this case",
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);
  const postedAt = posts[0];
  if (postedAt === undefined) throw new Error("The answer was not posted");

  // The queue takes the projection of the answer one time, after the post.
  await expect
    .poll(() => held.filter(hasEnded).length, { timeout: 15_000 })
    .toBe(1);
  const send = held[0];
  if (send === undefined || held.length !== 1)
    throw new Error("The answer's projection was not sent one time");
  expect(send.entryId).toBe("entry_ingress_slack_Ev55E_PROJECTION");
  expect(postedAt).toBeLessThan(send.endedAt);

  // The published entry leaves the outbox of the Case.
  const caseActor = await activeCase();
  await expect
    .poll(() => runInDurableObject(caseActor, pendingProjections), {
      timeout: 15_000,
    })
    .toBe(0);

  Object.assign(test.task.meta, {
    answerBeforeProjection: {
      holdMs: HOLD_MS,
      postBeforeQueueTookTheProjectionMs: send.endedAt - postedAt,
      sendStartedAfterPostMs: send.startedAt - postedAt,
      pendingAfterPublication: 0,
    },
  });
}

function hasEnded(send: HeldSend): boolean {
  return Number.isFinite(send.endedAt);
}

/**
 * Hold each queue send that carries the projection of an accepted answer.
 * The entry of an answer is `entry_<ingress>`. A trigger's is `trigger:<id>`.
 */
function holdAnswerProjections(test: TestContext): HeldSend[] {
  const held: HeldSend[] = [];
  const queue: Record<string, unknown> = Object.getPrototypeOf(env.EVENT_Q);
  const original = queue.send;
  if (typeof original !== "function")
    throw new Error("The queue has no send operation");
  queue.send = async function heldSend(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const entryId = answerEntryId(args[0]);
    if (entryId === null) return Reflect.apply(original, this, args);
    const send: HeldSend = {
      entryId,
      startedAt: Date.now(),
      endedAt: Number.POSITIVE_INFINITY,
    };
    held.push(send);
    await scheduler.wait(HOLD_MS);
    try {
      return await Reflect.apply(original, this, args);
    } finally {
      send.endedAt = Date.now();
    }
  };
  test.onTestFinished(function restoreQueue(): void {
    queue.send = original;
  });
  return held;
}

function answerEntryId(message: unknown): string | null {
  if (!isRecord(message) || !isRecord(message.source)) return null;
  const entryId = message.source.entryId;
  return typeof entryId === "string" && entryId.startsWith("entry_")
    ? entryId
    : null;
}

/** The one Case that the registry lists as active for the fixture. */
async function activeCase(): Promise<DurableObjectStub<CaseDO>> {
  const database = selectOrganisationPlacementDatabase(
    env,
    ORGANISATION_ID,
    requiredPlacement(),
  );
  if (!database.ok) throw new Error(database.error.code);
  const row = await database.value
    .prepare(
      `SELECT physical_object_name AS name FROM durable_object_registry
       WHERE organisation_id = ? AND lifecycle_status = 'active'
         AND object_kind = 'case'`,
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("No active Case");
  return caseActorStub(env.CASE, row.name, requiredPlacement());
}

function pendingProjections(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec("SELECT entry_id FROM case_context_projection_outbox")
    .toArray().length;
}

async function replyToModel({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  await request.json();
  return openRouterText("Reply.", "chatcmpl_55e_projection");
}
