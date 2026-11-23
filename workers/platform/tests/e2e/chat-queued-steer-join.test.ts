import { expect, it, type TestContext } from "vitest";

import { controlPaths, post, workKind } from "./memory-support";
import { openRouterToolCall } from "./slack-journey-support";
import {
  isCancellation,
  queuedRequests,
  send,
  startHeldChat,
  TAB,
  textsOf,
  timelineOf,
} from "./chat-queued-steer-support";

/**
 * A message that waits because the turn could not take it at that moment joins
 * the turn when the owner steers it: the turn continues and reads it, with no
 * second turn.
 */
it(
  "joins a queued message to the running turn when the turn can take it",
  steerJoinsJourney,
  120_000,
);

const QUESTION = "Check the next deliveries of our suppliers.";
const URGENT = "Stop that, and check the flour supplier only.";

async function steerJoinsJourney(test: TestContext): Promise<void> {
  const { owner, route, conversationId, model } = await startHeldChat(
    test,
    () =>
      openRouterToolCall(
        "tool_search",
        { query: "supplier deliveries", limit: 1 },
        "call_queued_steer_search",
      ),
  );
  await send(owner, route, conversationId, "message", "first", QUESTION, TAB);
  // The turn has no running harness yet, so the message waits.
  await send(owner, route, conversationId, "next", "urgent", URGENT, TAB);
  expect(await queuedRequests(owner, conversationId)).toEqual([
    "request_urgent",
  ]);
  await model.firstStarted.promise;

  const steered = await post(owner, controlPaths(owner.organisationId).chat, {
    kind: "steer_queued",
    conversationId,
    inputId: "input_urgent",
    cancellationId: "cancel_urgent",
    model: route,
  });
  expect(steered.status, await steered.clone().text()).toBe(200);
  expect(await queuedRequests(owner, conversationId)).toEqual([]);
  model.releaseFirst.resolve();

  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe("ready");
  const timeline = await timelineOf(owner, conversationId);
  expect(textsOf("user", timeline)).toEqual([QUESTION, URGENT]);
  expect(timeline.filter(isCancellation)).toHaveLength(0);
  // One turn: the second model request carries the message.
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1])).toContain(URGENT);

  Object.assign(test.task.meta, {
    chatQueuedSteer: {
      users: textsOf("user", timeline),
      modelRequests: model.requests.length,
    },
  });
}
