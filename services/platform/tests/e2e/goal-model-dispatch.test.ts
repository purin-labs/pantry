import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { reconcileSessionGoalUsage } from "../../src/actors/session-goal-usage";
import { readSessionBudgetAccount } from "../../src/actors/agent-session-budget";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { network } from "./network";
import { requireRequestId, requireSessionId } from "../test-ids";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  slackSimulator,
  slackEnvelope,
  signedSlackRequest,
  openRouterText,
  openRouterStream,
} from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

it(
  "checkpoints goal stops, resumes only by explicit command after eviction, and preserves unknown-usage fences",
  goalDispatchJourney,
);

async function goalDispatchJourney(context: TestContext): Promise<void> {
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
  const provider = new GoalProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage("bootstrap", ROOT_TS);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const caseRow = await actorRow("case");
  const sessionRow = await actorRow("session");
  const owner = env.CASE.getByName(caseRow.name);
  const session = env.SESSION.getByName(sessionRow.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: caseRow.id };
  expect(
    await runInDurableObject(session, readBudget.bind(null, sessionRow.id)),
  ).toMatchObject({
    ok: true,
    value: { usage: { tokens: 25 } },
  });
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "goal_dispatch_trial",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Review bakery inventory",
        tokenBudget: 10,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("goal", "1787500000.000002");
  await expect
    .poll(readGoal.bind(null, owner, identity), { timeout: 15_000 })
    .toMatchObject({
      ok: true,
      value: { goal: { tokensUsed: 25, state: { kind: "budget_limited" } } },
    });
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  expect(provider.calls).toBe(2);
  const turnId = await runInDurableObject(session, latestTurnId);
  const replay = await session.replayStream({
    organisationId: ORGANISATION_ID,
    turnId,
    afterSequence: -1,
  });
  if (!replay.ok) throw new Error(replay.error.code);
  expect(await replay.value.text()).toContain('"status":"partial"');
  const before = await owner.readGoal(identity);
  const budgetBeforeReplay = await runInDurableObject(
    session,
    readBudget.bind(null, sessionRow.id),
  );
  expect(budgetBeforeReplay).toMatchObject({
    ok: true,
    value: { usage: { tokens: 50 } },
  });
  const rows = await runInDurableObject(session, loseUsageReceipt);
  expect(rows).toBe(1);
  await evictDurableObject(session);
  expect(await runDurableObjectAlarm(session)).toBe(true);
  expect(await owner.readGoal(identity)).toEqual(before);
  expect(await runInDurableObject(session, pendingUsage)).toBe(0);
  expect(provider.calls).toBe(2);
  const budgetAfterReplay = await runInDurableObject(
    session,
    readBudget.bind(null, sessionRow.id),
  );
  expect(budgetAfterReplay).toMatchObject({
    ok: true,
    value: { usage: { tokens: 50 } },
  });
  Object.assign(context.task.meta, {
    goalDispatchEvidence: {
      scope:
        "Signed Slack ingress, real Session and Case Actors, Pi SDK, simulated provider, durable usage redelivery after eviction",
      providerCalls: provider.calls,
      goal: before,
      replayedReceipts: rows,
      budgetBeforeReplay,
      budgetAfterReplay,
      delivered: slack.messages,
    },
  });
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "raise_dispatch_budget",
      expectedRevision: 2,
      command: { kind: "update_budget", tokenBudget: 100 },
    }),
  ).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 25, state: { kind: "budget_limited" } } },
  });
  await sendMessage("raised_without_resume", "1787500000.000003");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(provider.calls).toBe(2);
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "resume_dispatch_goal",
      expectedRevision: 3,
      command: { kind: "resume" },
    }),
  ).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 25, state: { kind: "active" } } },
  });
  await evictDurableObject(owner);
  await evictDurableObject(session);
  await sendMessage("resumed", "1787500000.000004");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(4);
  expect(provider.calls).toBe(3);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 55, state: { kind: "active" } } },
  });
  expect(slack.messages[1]?.text).toContain(
    "goal token budget has been reached",
  );
  expect(slack.messages[2]?.text).toContain("explicitly resume");
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "pause_dispatch_goal",
      expectedRevision: 5,
      command: { kind: "pause" },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("paused", "1787500000.000005");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(5);
  expect(provider.calls).toBe(3);
  expect(slack.messages[4]?.text).toContain("goal is paused");
  await evictDurableObject(session);
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "resume_paused_goal",
      expectedRevision: 6,
      command: { kind: "resume" },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("resume_paused", "1787500000.000006");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(6);
  expect(provider.calls).toBe(4);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 85, state: { kind: "active" } } },
  });
  Object.assign(context.task.meta, {
    goalResumeEvidence: {
      providerCalls: provider.calls,
      goal: await owner.readGoal(identity),
      delivered: slack.messages,
    },
  });
  await lateUsageJourney(context);
  await unknownUsageJourney(context);
  await compactionGoalJourney(context);
}

class GoalProvider {
  calls = 0;
  readonly release = Promise.withResolvers<Response>();
  readonly lateRelease = Promise.withResolvers<void>();
  constructor(readonly mode: "budget" | "unknown" | "late" = "budget") {}
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    this.calls += 1;
    if (this.calls === 1)
      return openRouterText("Ready to review the bakery.", "bootstrap");
    if (this.mode === "late") {
      await this.lateRelease.promise;
      return textWithUsage("The delayed review is complete.", 20);
    }
    if (this.mode === "unknown") {
      return this.release.promise;
    }
    if (this.calls === 3) {
      const body = await request.text();
      expect(body).toContain("tool_search");
      expect(body).toContain("tool_calls");
      return textWithUsage("Resumed bakery review.", 20);
    }
    if (this.calls === 4)
      return textWithUsage("Resumed the paused bakery review.", 20);
    if (this.calls > 4) throw new Error("Goal permitted an extra model call");
    return openRouterStream([
      {
        id: "goal_call",
        object: "chat.completion.chunk",
        created: 1787500000,
        model: PLATFORM_DEFAULT_PI_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "goal_search",
                  type: "function",
                  function: {
                    name: "tool_search",
                    arguments: '{"query":"inventory","limit":1}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "goal_call",
        object: "chat.completion.chunk",
        created: 1787500000,
        model: PLATFORM_DEFAULT_PI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);
  }
}
async function sendMessage(
  id: string,
  ts: string,
  root = ROOT_TS,
): Promise<void> {
  const body = slackEnvelope({
    eventType: "app_mention",
    eventId: `EvGoal_${id}`,
    messageTs: ts,
    threadTs: root,
    text: "<@U0PANTRY> Review the bakery inventory.",
  });
  expect(
    (await exports.default.fetch(await signedSlackRequest(body))).status,
  ).toBe(200);
}
async function actorRow(kind: string): Promise<{ id: string; name: string }> {
  const row = await fixtureDatabase()
    .prepare(
      `SELECT logical_object_id AS id, physical_object_name AS name
    FROM durable_object_registry WHERE organisation_id = ? AND object_kind = ? AND lifecycle_status = 'active' ORDER BY reserved_at DESC`,
    )
    .bind(ORGANISATION_ID, kind)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error(`Missing ${kind} Actor`);
  return row;
}
async function loseUsageReceipt(
  _actor: unknown,
  state: DurableObjectState,
): Promise<number> {
  const rows = state.storage.sql
    .exec<{ effect_id: string; state_projection: string }>(
      "SELECT effect_id, state_projection FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND state_kind = 'settled' AND json_extract(state_projection, '$.outcome.tokens') > 0",
    )
    .toArray();
  for (const row of rows) {
    const phase = JSON.parse(row.state_projection);
    state.storage.sql.exec(
      "UPDATE actor_outbox SET state_kind = 'pending', state_projection = ? WHERE effect_id = ?",
      JSON.stringify({ kind: "settling", outcome: phase.outcome }),
      row.effect_id,
    );
  }
  await state.storage.setAlarm(Date.now() + 60_000);
  return rows.length;
}
function pendingUsage(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec(
      "SELECT effect_id FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND state_kind != 'settled'",
    )
    .toArray().length;
}

async function readGoal(
  owner: ReturnType<typeof env.CASE.getByName>,
  identity: { organisationId: string; caseId: string },
) {
  return await owner.readGoal(identity);
}

async function unknownUsageJourney(context: TestContext): Promise<void> {
  const root = "1787500001.000001";
  const slack = slackSimulator();
  const provider = new GoalProvider("unknown");
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage("bootstrap_unknown", root, root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const row = await actorRow("case");
  const owner = env.CASE.getByName(row.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "goal_unknown_trial",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Review the bakery",
        tokenBudget: 1000,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("unknown", "1787500001.000003", root);
  await expect.poll(providerCallCount.bind(null, provider)).toBe(2);
  const sessionRow = await actorRow("session");
  const session = env.SESSION.getByName(sessionRow.name);
  const interrupted = await runInDurableObject(session, pendingGoalExecution);
  expect(interrupted.operations).toBe(1);
  expect(interrupted.historyEntries).toBeGreaterThan(0);
  await expect(
    runInDurableObject(session, interruptGoalSession),
  ).rejects.toThrow();
  provider.release.resolve(
    HttpResponse.json(
      { error: { message: "Response lost during restart" } },
      { status: 503 },
    ),
  );
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(interrupted.expiresAt + 1);
  try {
    expect(
      await runDurableObjectAlarm(env.SESSION.getByName(sessionRow.name)),
    ).toBe(true);
  } finally {
    clock.mockRestore();
  }
  const retainedHistory = await runInDurableObject(
    env.SESSION.getByName(sessionRow.name),
    goalHistoryCount,
  );
  expect(retainedHistory).toBeGreaterThanOrEqual(interrupted.historyEntries);
  await expect
    .poll(readGoal.bind(null, owner, identity), { timeout: 15_000 })
    .toMatchObject({
      ok: true,
      value: { goal: { tokensUsed: 0, unknownOperations: 1 } },
    });
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "raise_unknown_budget",
      expectedRevision: 2,
      command: { kind: "update_budget", tokenBudget: 2000 },
    }),
  ).toMatchObject({ ok: true });
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "resume_unknown_goal",
      expectedRevision: 3,
      command: { kind: "resume" },
    }),
  ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
  const before = await owner.readGoal(identity);
  expect(
    await runInDurableObject(
      env.SESSION.getByName(sessionRow.name),
      readBudget.bind(null, sessionRow.id),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "open", reservation: { kind: "indeterminate" } },
  });
  await evictDurableObject(owner);
  expect(await owner.readGoal(identity)).toEqual(before);
  expect(
    await owner.admitGoalOperation({
      ...identity,
      sessionId: "another_session",
      operationId: "blocked_unknown",
      expectedRevision: 3,
    }),
  ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
  expect(provider.calls).toBe(2);
  const recoveredSession = env.SESSION.getByName(sessionRow.name);
  const cancelled =
    await recoveredSession.interruptCanonicalEmbeddedHarnessTurn({
      requestId: requireRequestId("request_cancel_unknown_recovery"),
      organisationId: ORGANISATION_ID,
      sessionId: requireSessionId(sessionRow.id),
      interruptedAt: interrupted.expiresAt + 2,
    });
  expect(cancelled).toMatchObject({ ok: true, value: { kind: "interrupted" } });
  await evictDurableObject(recoveredSession);
  await runDurableObjectAlarm(env.SESSION.getByName(sessionRow.name));
  expect(provider.calls).toBe(2);
  expect(await owner.readGoal(identity)).toEqual(before);
  Object.assign(context.task.meta, {
    goalUnknownEvidence: {
      scope:
        "Real Slack, Session, Case and Pi boundaries; Session aborted while provider response pending, then alarm recovery after lease expiry",
      interrupted,
      retainedHistory,
      providerCalls: provider.calls,
      goal: before,
      delivered: slack.messages,
    },
  });
}

function pendingGoalExecution(_actor: unknown, state: DurableObjectState) {
  const operations = state.storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND json_extract(state_projection, '$.kind') = 'dispatched'",
    )
    .one().count;
  const expiresAt = state.storage.sql
    .exec<{ expires_at: number }>(
      "SELECT expires_at FROM session_harness_lease LIMIT 1",
    )
    .one().expires_at;
  const historyEntries = state.storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM session_harness_history",
    )
    .one().count;
  return { operations, expiresAt, historyEntries };
}

function interruptGoalSession(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.abort("Goal acceptance: interrupt pending model call");
}

function providerCallCount(provider: GoalProvider): number {
  return provider.calls;
}

function goalHistoryCount(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM session_harness_history",
    )
    .one().count;
}

async function compactionGoalJourney(context: TestContext): Promise<void> {
  const root = "1787500002.000001";
  const slack = slackSimulator();
  const provider = new GoalCompactionProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage("bootstrap_compact", root, root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const row = await actorRow("case");
  const owner = env.CASE.getByName(row.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "goal_compaction_trial",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Summarize bakery evidence",
        tokenBudget: 245_050,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("compact", "1787500002.000004", root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 245_010, state: { kind: "active" } } },
  });
  expect(provider.calls).toBe(2);
  expect(provider.summaries).toBe(0);
  await sendMessage("compact_budget_stop", "1787500002.000005", root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 245_097, state: { kind: "budget_limited" } } },
  });
  expect(provider.summaries).toBe(1);
  expect(provider.calls).toBe(3);
  expect(slack.messages[2]?.text).toContain(
    "goal token budget has been reached",
  );
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "raise_compaction_goal",
      expectedRevision: 3,
      command: { kind: "update_budget", tokenBudget: 245_200 },
    }),
  ).toMatchObject({ ok: true });
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "resume_compaction_goal",
      expectedRevision: 4,
      command: { kind: "resume" },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("compact_resumed", "1787500002.000006", root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(4);
  expect(provider.calls).toBe(4);
  expect(provider.summaries).toBe(1);
  // The answer streams into the message, so its text grows after it shows.
  await expect
    .poll(() => slack.messages[3]?.text?.trim(), { timeout: 15_000 })
    .toBe("Accepted bakery evidence. ".repeat(5000).trim());
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { goal: { tokensUsed: 490_107, state: { kind: "budget_limited" } } },
  });
  Object.assign(context.task.meta, {
    goalCompactionEvidence: {
      scope:
        "Real Slack, Session, Case, Pi automatic compaction; simulated large provider usage",
      providerCalls: provider.calls,
      compactionCalls: provider.summaries,
      goal: await owner.readGoal(identity),
    },
  });
}
class GoalCompactionProvider {
  calls = 0;
  summaries = 0;
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    this.calls += 1;
    if (this.calls === 1)
      return openRouterText("Ready to summarize.", "bootstrap");
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid model request");
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      this.summaries += 1;
      return textWithUsage("Accepted bakery evidence summary.", 77);
    }
    if (this.calls !== 2 && this.calls !== 4)
      throw new Error("Unexpected goal model request");
    return textWithUsage("Accepted bakery evidence. ".repeat(5000), 245_000);
  }
}
function textWithUsage(text: string, inputTokens: number): Response {
  return openRouterStream([
    {
      id: "goal_compact",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "goal_compact",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: 10,
        total_tokens: inputTokens + 10,
      },
    },
  ]);
}

function readBudget(
  sessionId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return readSessionBudgetAccount(state.storage.sql, {
    organisationId: ORGANISATION_ID,
    sessionId,
  });
}

function latestTurnId(_actor: unknown, state: DurableObjectState): string {
  const row = state.storage.sql
    .exec<{ turn_id: string }>(
      "SELECT turn_id FROM session_turn_stream ORDER BY started_at DESC LIMIT 1",
    )
    .one();
  return row.turn_id;
}

async function lateUsageJourney(context: TestContext): Promise<void> {
  const root = "1787500003.000001";
  const slack = slackSimulator();
  const provider = new GoalProvider("late");
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage("bootstrap_late", root, root);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const row = await actorRow("case");
  const sessionRow = await actorRow("session");
  const owner = env.CASE.getByName(row.name);
  const session = env.SESSION.getByName(sessionRow.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "goal_late_trial",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Finish the bakery review",
        tokenBudget: 1000,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage("late", "1787500003.000002", root);
  await expect.poll(providerCallCount.bind(null, provider)).toBe(2);
  const pending = await runInDurableObject(session, pendingGoalExecution);
  const clock = vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt + 1);
  try {
    await runInDurableObject(session, reconcileExpiredGoalUsage);
    expect(await owner.readGoal(identity)).toMatchObject({
      ok: true,
      value: { goal: { tokensUsed: 0, unknownOperations: 1 } },
    });
    clock.mockRestore();
    provider.lateRelease.resolve();
    await expect
      .poll(readGoal.bind(null, owner, identity), { timeout: 15_000 })
      .toMatchObject({
        ok: true,
        value: { goal: { tokensUsed: 30, unknownOperations: 0 } },
      });
  } finally {
    clock.mockRestore();
  }
  const settled = await owner.readGoal(identity);
  await runInDurableObject(session, reconcileExpiredGoalUsage);
  expect(await owner.readGoal(identity)).toEqual(settled);
  await evictDurableObject(owner);
  expect(await owner.readGoal(identity)).toEqual(settled);
  expect(provider.calls).toBe(2);
  Object.assign(context.task.meta, {
    goalLateReceiptEvidence: {
      scope:
        "Signed Slack ingress, real Session and Case Actors, lease expiry recovery before delayed provider usage",
      goal: settled,
      providerCalls: provider.calls,
    },
  });
}
async function reconcileExpiredGoalUsage(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await reconcileSessionGoalUsage({
    env,
    storage: state.storage,
    liveRuns: new Set(),
  });
}
