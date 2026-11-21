import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import {
  preparePortalChatJourney,
  chat,
  readWork,
  CONVERSATION_ID,
} from "./chat-journey-support";
import { ORGANISATION_ID, openRouterStream } from "./slack-journey-support";
import { network } from "./network";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

it(
  "retains the request goal across Portal steps and Case eviction, then enrolls a new message in the replacement goal",
  continuationJourney,
  60_000,
);

async function continuationJourney(context: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  await choosePi();
  const provider = new ReplacingProvider();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  expect((await sendPiMessage(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  const row = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS id, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error("Missing conversation Case");
  let owner = env.CASE.getByName(row.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "original_goal",
      expectedRevision: 0,
      command: { kind: "set", objective: "Review stock", tokenBudget: 100 },
    }),
  ).toMatchObject({ ok: true });
  expect((await sendPiMessage(session, 2)).status).toBe(200);
  await provider.started.promise;
  owner = env.CASE.getByName(row.name);
  const current = await owner.readGoal(identity);
  if (!current.ok) throw new Error(current.error.code);
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "replacement_goal",
      expectedRevision: current.value.revision,
      command: {
        kind: "set",
        objective: "Review deliveries",
        tokenBudget: 200,
      },
    }),
  ).toMatchObject({ ok: true });
  provider.release.resolve(measuredResponse(2));
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  expect(provider.calls).toBe(2);
  expect(await (await chat(session, null)).text()).toContain(
    "goal was replaced",
  );
  // The stop notice completes the request, so it is a fork boundary like the
  // first reply.
  expect(await (await chat(session, null)).json()).toMatchObject({
    conversation: {
      forkableResponseIds: [expect.any(String), expect.any(String)],
    },
  });
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { goalId: "replacement_goal", tokensUsed: 0 } },
  });
  // Replaying completed untracked work cannot bypass a newly installed goal.
  expect(
    await owner.bindGoalExecution({
      ...identity,
      executionId: "retry_untracked",
      requestId: "request_credit_1",
    }),
  ).toMatchObject({ ok: false, error: { code: "goal_request_replaced" } });
  await evictDurableObject(owner);
  const recovered = {
    ...identity,
    executionId: "recovered-original-request",
    requestId: "request_credit_2",
  };
  expect(await owner.bindGoalExecution(recovered)).toMatchObject({
    ok: true,
    value: { goal: { goalId: "original_goal" } },
  });
  expect(await owner.closeGoalExecution(recovered)).toMatchObject({ ok: true });
  expect((await sendPiMessage(session, 3)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  expect(provider.calls).toBe(3);
  const goal = await owner.readGoal(identity);
  expect(goal).toMatchObject({
    ok: true,
    value: {
      goal: {
        goalId: "replacement_goal",
        tokensUsed: 25,
        unknownOperations: 0,
      },
    },
  });
  Object.assign(context.task.meta, {
    goalRequestContinuationEvidence: {
      scope:
        "Authenticated Portal, real Case and Session Actors, Pi, simulated provider",
      replacedDuringModelCall: true,
      originalBindingSurvivedEviction: true,
      automaticStepBlocked: true,
      oldUntrackedRequestBlocked: true,
      newMessageChargedToReplacement: true,
      providerCalls: provider.calls,
      goal,
    },
  });
}

class ReplacingProvider {
  calls = 0;
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<Response>();

  respond(): Response | Promise<Response> {
    this.calls += 1;
    if (this.calls === 2) {
      this.started.resolve();
      return this.release.promise;
    }
    return measuredResponse(this.calls);
  }
}

function measuredResponse(call: number): Response {
  const content =
    call === 2
      ? JSON.stringify({ kind: "reply", text: "" })
      : JSON.stringify({
          kind: "reply",
          text: `Review ${call} complete.`,
        });
  return openRouterStream([
    {
      id: `goal_request_${call}`,
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    },
    {
      id: `goal_request_${call}`,
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}

async function choosePi(): Promise<void> {
  const selection = await readOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (selection === null || !userId.ok)
    throw new Error("Missing inference authority");
  const selected = await selectOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    selection: { kind: "pantry_platform" },
    expectedConfigurationVersion: selection.configurationVersion,
    selectedByUserId: userId.value,
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
}

function sendPiMessage(
  session: IssuedControlSession,
  turn: number,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        kind: "message",
        conversationId: CONVERSATION_ID,
        requestId: `request_credit_${turn}`,
        model: PLATFORM_DEFAULT_PI_MODEL,
        text: `Review ${turn}`,
      }),
    },
  );
}
