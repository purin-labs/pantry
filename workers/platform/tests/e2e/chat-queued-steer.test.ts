import { expect, it, type TestContext } from "vitest";

import { controlPaths, post } from "./memory-support";
import { openRouterText } from "./slack-journey-support";
import {
  isCancellation,
  OTHER_TAB,
  queuedRequests,
  queueIsDone,
  replyText,
  send,
  startHeldChat,
  TAB,
  textsOf,
  timelineOf,
} from "./chat-queued-steer-support";

/**
 * A person sends a message that waits in the queue now, with Steer.
 *
 * A message from another browser tab cannot join the turn, so it waits. Two
 * of them wait. The owner steers the second one: the running turn stops, its
 * answer never appears, the steered message runs first, and the other message
 * keeps its place behind it. A second click changes nothing.
 */
it(
  "stops the running turn for a steered message that cannot join it",
  steerCancelsJourney,
  120_000,
);

const QUESTION = "Check the next deliveries of our suppliers.";
const OTHER = "Also list the open invoices.";
const URGENT = "Stop that, and check the flour supplier only.";
const DROPPED_ANSWER = "All supplier deliveries are on time.";

async function steerCancelsJourney(test: TestContext): Promise<void> {
  const { owner, route, conversationId, model } = await startHeldChat(
    test,
    () => openRouterText(replyText(DROPPED_ANSWER), "dropped_answer"),
  );
  await send(owner, route, conversationId, "message", "first", QUESTION, TAB);
  await model.firstStarted.promise;
  // A second tab: its browser is not the turn's browser, so these messages wait.
  await send(owner, route, conversationId, "next", "other", OTHER, OTHER_TAB);
  await send(owner, route, conversationId, "next", "urgent", URGENT, OTHER_TAB);
  expect(await queuedRequests(owner, conversationId)).toEqual([
    "request_other",
    "request_urgent",
  ]);

  const command = {
    kind: "steer_queued",
    conversationId,
    inputId: "input_urgent",
    cancellationId: "cancel_urgent",
    model: route,
  };
  const path = controlPaths(owner.organisationId).chat;
  const steeredAt = Date.now();
  const steered = await post(owner, path, command);
  const steerMs = Date.now() - steeredAt;
  expect(steered.status, await steered.clone().text()).toBe(200);
  // A double click, and a retry after a lost response.
  const again = await post(owner, path, command);
  expect(again.status, await again.clone().text()).toBe(200);
  model.releaseFirst.resolve();

  await expect
    .poll(queueIsDone.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe(true);
  const timeline = await timelineOf(owner, conversationId);
  expect(textsOf("user", timeline)).toEqual([QUESTION, URGENT, OTHER]);
  const settledMs = Date.now() - steeredAt;
  // Send now: no wait for the 15 s recovery alarm of the Case Actor.
  expect(settledMs).toBeLessThan(10_000);
  const answers = textsOf("assistant", timeline);
  expect(answers).toHaveLength(2);
  expect(answers).not.toContain(DROPPED_ANSWER);
  expect(timeline.filter(isCancellation)).toHaveLength(1);

  // The message left the queue, so a late click finds nothing to do.
  const late = await post(owner, path, command);
  expect(late.status, await late.clone().text()).toBe(200);
  expect(textsOf("user", await timelineOf(owner, conversationId))).toEqual([
    QUESTION,
    URGENT,
    OTHER,
  ]);

  Object.assign(test.task.meta, {
    chatQueuedSteer: {
      users: textsOf("user", timeline),
      answers,
      steerMs,
      settledMs,
      modelRequestMs: model.requestedAt.map((at) => at - steeredAt),
    },
  });
}
