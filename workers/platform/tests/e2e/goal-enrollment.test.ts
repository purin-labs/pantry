import type { CaseDO } from "../../src/actors/case";
import { fixtureDatabase } from "./organisation-database";
import type { GoalCommandRequest } from "@purin-labs/agent/actors/case-goals";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  slackSimulator,
  slackEnvelope,
  signedSlackRequest,
  openRouterStream,
} from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";

it(
  "serializes initial goal enrollment with an in-flight untracked turn across Case eviction",
  enrollmentJourney,
  40_000,
);

async function enrollmentJourney(context: TestContext): Promise<void> {
  await installSlackActorFixture();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const slack = slackSimulator();
  const provider = new EnrollmentProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage("untracked", ROOT_TS);
  await provider.started.promise;
  const row = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS id, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error("Missing Case");
  const owner = env.CASE.getByName(row.name);
  const command = {
    organisationId: ORGANISATION_ID,
    caseId: row.id,
    commandId: "enroll_goal",
    expectedRevision: 0,
    command: {
      kind: "set" as const,
      objective: "Review stock",
      tokenBudget: 100,
    },
  };
  expect(await owner.applyGoalCommand(command)).toMatchObject({
    ok: false,
    error: { code: "goal_execution_running" },
  });
  await evictDurableObject(owner);
  expect(await owner.applyGoalCommand(command)).toMatchObject({
    ok: false,
    error: { code: "goal_execution_running" },
  });
  provider.release.resolve(measuredResponse());
  await expect.poll(slack.visibleMessageCount, { timeout: 15000 }).toBe(1);
  await expect
    .poll(applyGoal.bind(null, owner, command), { timeout: 15000 })
    .toMatchObject({
      ok: true,
      value: { revision: 1, goal: { tokensUsed: 0 } },
    });
  await sendMessage("tracked", "1787500000.000002");
  await expect.poll(slack.visibleMessageCount, { timeout: 15000 }).toBe(2);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  const closedBinding = {
    ...identity,
    executionId: "closed-before-delayed-bind",
    requestId: "closed-request",
  };
  expect(await owner.closeGoalExecution(closedBinding)).toMatchObject({
    ok: true,
  });
  await evictDurableObject(owner);
  expect(await owner.bindGoalExecution(closedBinding)).toMatchObject({
    ok: false,
    error: { code: "goal_execution_closed" },
  });
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 25, unknownOperations: 0 } },
  });
  expect(await owner.applyGoalCommand(command)).toMatchObject({
    ok: true,
    value: { revision: 1 },
  });
  expect(provider.calls).toBe(2);
  Object.assign(context.task.meta, {
    goalEnrollmentEvidence: {
      rejectedBeforeAndAfterEviction: true,
      untrackedCalls: 1,
      trackedCalls: 1,
      goal: await owner.readGoal(identity),
    },
  });
}
class EnrollmentProvider {
  calls = 0;
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<Response>();
  respond(): Response | Promise<Response> {
    this.calls += 1;
    if (this.calls === 1) {
      this.started.resolve();
      return this.release.promise;
    }
    return measuredResponse();
  }
}
function measuredResponse(): Response {
  return openRouterStream([
    {
      id: "enroll",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Stock reviewed." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "enroll",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}
async function sendMessage(id: string, ts: string): Promise<void> {
  const body = slackEnvelope({
    eventType: "app_mention",
    eventId: `EvEnrollment_${id}`,
    messageTs: ts,
    threadTs: ROOT_TS,
    text: "<@U0PANTRY> Review stock.",
  });
  expect(
    (await exports.default.fetch(await signedSlackRequest(body))).status,
  ).toBe(200);
}

function applyGoal(
  owner: DurableObjectStub<CaseDO>,
  command: GoalCommandRequest,
) {
  return owner.applyGoalCommand(command);
}
