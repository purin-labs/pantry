import { expect, it, type TestContext } from "vitest";
import type { ConversationId } from "@seams/control-api";

import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import {
  controlPaths,
  post,
  storedConversation,
  type Member,
} from "./memory-support";
import { organisationDatabase } from "./organisation-database";
import { openRouterText } from "./slack-journey-support";
import {
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
 * A queued Portal message whose AI connection went away fails where the
 * person sees it (Refactor 15, refactor 9).
 *
 * The owner asks a question, and a second message from another tab waits in
 * the queue. The owner then switches the workspace's AI connection to a
 * ChatGPT sign-in that nobody has made, and stops the running answer. The
 * queued message is due, but no model can run it. Within a minute the chat
 * shows the queued message as a failed turn that names the AI connection,
 * with a retry. Once the owner switches back, the retry gets an answer. The
 * old code left the message in the queue with no failure while the Case's
 * alarm tried it every 15 seconds.
 */
it(
  "shows a queued message's failure while the AI connection is unavailable",
  unavailableRouteJourney,
  120_000,
);

const QUESTION = "Check the next deliveries of our suppliers.";
const QUEUED = "Also list the open invoices.";
const UNAVAILABLE =
  "This conversation's AI connection is unavailable. Restore its connection, then retry.";

async function unavailableRouteJourney(test: TestContext): Promise<void> {
  const { owner, route, conversationId, model } = await startHeldChat(
    test,
    () => openRouterText(replyText("This answer was stopped."), "stopped"),
  );
  await send(owner, route, conversationId, "message", "first", QUESTION, TAB);
  await model.firstStarted.promise;
  await send(owner, route, conversationId, "next", "queued", QUEUED, OTHER_TAB);
  expect(await queuedRequests(owner, conversationId)).toEqual([
    "request_queued",
  ]);

  // The owner moves the workspace to a ChatGPT sign-in that nobody made,
  // and stops the running answer.
  await selectInference(owner, "codex_subscription");
  await stopTurn(owner, conversationId);
  const stoppedAt = Date.now();

  // The person sees the queued message fail, with the reason.
  await expect
    .poll(() => workOf(owner, conversationId), {
      timeout: 60_000,
      interval: 1_000,
    })
    .toBe("failed:request_queued");
  const failedAfterMs = Date.now() - stoppedAt;
  expect(failedAfterMs).toBeLessThan(60_000);
  const timeline = await timelineOf(owner, conversationId);
  expect(textsOf("user", timeline)).toEqual([QUESTION, QUEUED]);
  expect(textsOf("run_failed", timeline)).toEqual([UNAVAILABLE]);
  expect(await queuedRequests(owner, conversationId)).toEqual([]);

  // The owner restores the connection and retries the message.
  await selectInference(owner, "satyr_platform");
  const retried = await post(owner, controlPaths(owner.organisationId).chat, {
    kind: "retry",
    conversationId,
    requestId: "request_queued",
    model: route,
  });
  expect(retried.status, await retried.clone().text()).toBe(200);
  await expect
    .poll(queueIsDone.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe(true);
  const answers = textsOf("assistant", await timelineOf(owner, conversationId));
  expect(answers).toHaveLength(1);

  Object.assign(test.task.meta, {
    unavailableRoute: {
      failedAfterMs,
      failure: UNAVAILABLE,
      retried: "answered",
    },
  });
}

async function selectInference(
  owner: Member,
  kind: "codex_subscription" | "satyr_platform",
): Promise<void> {
  const db = organisationDatabase(owner.organisationId);
  const current = await readOrganisationInferenceSelection({
    db,
    organisationId: owner.organisationId,
  });
  if (current === null) throw new Error("Missing inference selection");
  const selected = await selectOrganisationInferenceSelection({
    db,
    organisationId: owner.organisationId,
    selection: { kind },
    expectedConfigurationVersion: current.configurationVersion,
    selectedByUserId: owner.userId,
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
}

async function stopTurn(
  owner: Member,
  conversationId: ConversationId,
): Promise<void> {
  const stored = await storedConversation(owner, conversationId);
  if (stored?.conversation.work.kind !== "running")
    throw new Error("Expected a running turn");
  const { requestId, stream } = stored.conversation.work;
  const response = await post(
    owner,
    `${controlPaths(owner.organisationId).chat}/cancel`,
    {
      conversationId,
      requestId,
      sessionId: stream.sessionId,
      turnId: stream.turnId,
      cancellationId: "cancel_unavailable",
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function workOf(
  owner: Member,
  conversationId: ConversationId,
): Promise<string> {
  const work = (await storedConversation(owner, conversationId))?.conversation
    .work;
  if (work === undefined) return "missing";
  return work.kind === "failed" ? `failed:${work.requestId}` : work.kind;
}
