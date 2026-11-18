import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { bypass, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  slackSimulator,
  slackEnvelope,
  signedSlackRequest,
  openRouterText,
} from "./slack-journey-support";

it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "stops real Pi calls at a goal budget and resumes accepted history after Actor eviction without duplicate usage",
  nativeGoalJourney,
  180_000,
);

async function nativeGoalJourney(context: TestContext): Promise<void> {
  await installSlackActorFixture();
  await fixtureDatabase()
    .prepare(
      "UPDATE workspace_ai_budget SET max_tokens = 500000 WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
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
  const provider = new NativeGoalProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendMessage(
    "bootstrap",
    ROOT_TS,
    "Prepare for a goal acceptance test.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const caseRow = await actorRow("case");
  const sessionRow = await actorRow("session");
  const owner = env.CASE.getByName(caseRow.name);
  const session = env.SESSION.getByName(sessionRow.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: caseRow.id };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "native_goal",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Retain the acceptance marker",
        tokenBudget: 1,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendMessage(
    "first",
    "1787500000.000002",
    "Remember marker PROOF-GOAL-50. Reply with exactly PROOF-GOAL-50. Do not call tools.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 90_000 }).toBe(2);
  expect(provider.receipts).toHaveLength(1);
  const receipt = provider.receipts[0];
  if (receipt === undefined) throw new Error("Missing native usage receipt");
  const stopped = await owner.readGoal(identity);
  expect(stopped).toMatchObject({
    ok: true,
    value: {
      goal: {
        tokensUsed: receipt.tokens,
        tokenBudget: 1,
        unknownOperations: 0,
        state: { kind: "budget_limited" },
      },
    },
  });
  if (!stopped.ok) throw new Error(stopped.error.code);

  const replayed = await runInDurableObject(session, loseUsageReceipt);
  expect(replayed).toBe(1);
  await evictDurableObject(session);
  await evictDurableObject(owner);
  expect(await runDurableObjectAlarm(session)).toBe(true);
  expect(await owner.readGoal(identity)).toEqual(stopped);
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "raise_native_goal",
      expectedRevision: stopped.value.revision,
      command: { kind: "update_budget", tokenBudget: receipt.tokens + 100000 },
    }),
  ).toMatchObject({
    ok: true,
    value: { goal: { state: { kind: "budget_limited" } } },
  });
  await sendMessage(
    "blocked",
    "1787500000.000003",
    "Return the saved marker. Do not call tools.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(provider.receipts).toHaveLength(1);
  expect(slack.messages[2]?.text).toContain("explicitly resume");
  const raised = await owner.readGoal(identity);
  if (!raised.ok) throw new Error(raised.error.code);
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "resume_native_goal",
      expectedRevision: raised.value.revision,
      command: { kind: "resume" },
    }),
  ).toMatchObject({ ok: true });
  await evictDurableObject(owner);
  await evictDurableObject(session);
  await sendMessage(
    "resumed",
    "1787500000.000004",
    "Return only the marker I asked you to remember earlier. Read it from our conversation. Do not call tools.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 90_000 }).toBe(4);
  expect(provider.receipts).toHaveLength(2);
  expect(provider.nativeCalls).toBe(2);
  expect(provider.restoredHistory).toBe(true);
  expect(slack.messages[3]?.text).toContain("PROOF-GOAL-50");
  const final = await owner.readGoal(identity);
  expect(final).toMatchObject({
    ok: true,
    value: {
      goal: {
        tokensUsed: provider.receipts.reduce(sumTokens, 0),
        unknownOperations: 0,
        state: { kind: "active" },
      },
    },
  });
  Object.assign(context.task.meta, {
    nativeGoalEvidence: {
      scope:
        "Real Pi/OpenRouter and local production Actors; simulated Slack delivery",
      providerReceipts: provider.receipts,
      nativeCalls: provider.nativeCalls,
      originalGoal: stopped,
      finalGoal: final,
      replayedReceipts: replayed,
      increaseWithoutResumeBlocked: true,
      acceptedHistorySurvivedEviction: provider.restoredHistory,
      resumedResponse: slack.messages[3]?.text,
    },
  });
}

type NativeReceipt = { id: string; model: string; tokens: number };
function sumTokens(total: number, receipt: NativeReceipt): number {
  return total + receipt.tokens;
}

class NativeGoalProvider {
  private bootstrap = true;
  nativeCalls = 0;
  restoredHistory = false;
  readonly receipts: NativeReceipt[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (this.bootstrap) {
      this.bootstrap = false;
      return openRouterText("Ready.", "bootstrap");
    }
    this.nativeCalls += 1;
    if (this.nativeCalls > 2)
      throw new Error("Unexpected native model dispatch");
    const body = await request.text();
    if (this.nativeCalls === 2)
      this.restoredHistory = body.includes("PROOF-GOAL-50");
    const response = await fetch(
      bypass(request.url, { method: "POST", headers: request.headers, body }),
    );
    if (!response.ok)
      throw new Error(`Native provider status ${response.status}`);
    const receipt = readNativeReceipt(await response.clone().text());
    this.receipts.push(receipt);
    return response;
  }
}

function readNativeReceipt(stream: string): NativeReceipt {
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const value: unknown = JSON.parse(line.slice(6));
    if (!isRecord(value) || !isRecord(value.usage)) continue;
    const tokens = value.usage.total_tokens;
    if (
      typeof value.id === "string" &&
      typeof value.model === "string" &&
      typeof tokens === "number" &&
      Number.isSafeInteger(tokens) &&
      tokens > 0
    )
      return { id: value.id, model: value.model, tokens };
  }
  throw new Error("Native provider omitted measured token usage");
}

async function sendMessage(
  id: string,
  ts: string,
  text: string,
): Promise<void> {
  const body = slackEnvelope({
    eventType: "app_mention",
    eventId: `EvNativeGoal_${id}`,
    messageTs: ts,
    threadTs: ROOT_TS,
    text: `<@U0SATYR> ${text}`,
  });
  expect(
    (await exports.default.fetch(await signedSlackRequest(body))).status,
  ).toBe(200);
}

async function actorRow(
  kind: "case" | "session",
): Promise<{ id: string; name: string }> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS id, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = ? AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
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
    .exec<{ effect_id: string }>(
      "SELECT effect_id FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND state_kind = 'settled' AND json_extract(state_projection, '$.outcome.tokens') > 0",
    )
    .toArray();
  for (const row of rows)
    state.storage.sql.exec(
      "UPDATE actor_outbox SET state_kind = 'pending', state_projection = json_set(state_projection, '$.kind', 'settling') WHERE effect_id = ?",
      row.effect_id,
    );
  await state.storage.setAlarm(Date.now() + 60000);
  return rows.length;
}
