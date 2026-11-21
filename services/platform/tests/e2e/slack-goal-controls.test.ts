import { isRecord } from "@purin-labs/std";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  slackEnvelope,
  signedSlackRequest,
  openRouterStream,
} from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

it(
  "applies explicit Slack goal commands once, recovers durable replies after eviction, and enforces operator authority without inference",
  goalJourney,
  60_000,
);

async function goalJourney(context: TestContext): Promise<void> {
  await installSlackActorFixture();
  await role("admin");
  const provider = new GoalProviders();
  network.use(
    http.post("https://slack.com/api/:method", provider.slack.bind(provider)),
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.model.bind(provider),
    ),
  );
  await send("set", "goal set 100 Review stock", 1);
  await expect
    .poll(provider.attemptCount.bind(provider), { timeout: 15000 })
    .toBeGreaterThan(0);
  const row = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS id, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error("Missing Case");
  const owner = env.CASE.getByName(row.name);
  const identity = { organisationId: ORGANISATION_ID, caseId: row.id };
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { revision: 1, goal: { tokensUsed: 0, tokenBudget: 100 } },
  });
  const sessionCount = await fixtureDatabase()
    .prepare(
      "SELECT count(*) AS count FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session'",
    )
    .bind(ORGANISATION_ID)
    .first<{ count: number }>();
  expect(sessionCount?.count).toBe(0);
  await evictDurableObject(owner);
  provider.blocked = false;
  await expect
    .poll(provider.messageCount.bind(provider), { timeout: 20000 })
    .toBe(1);
  await send("set", "goal set 100 Review stock", 1);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { revision: 1 },
  });
  await command(provider, "pause", "goal pause", 2);
  await command(provider, "budget", "goal budget 200", 3);
  expect(provider.messages[2]).toContain("Status: paused");
  expect(provider.messages[2]).toContain("0 / 200");
  await command(provider, "resume", "goal resume", 4);
  expect(provider.messages[3]).toContain("Send another message to continue");
  expect(provider.calls).toBe(0);
  await command(provider, "work", "Review stock now", 5);
  expect(provider.calls).toBe(1);
  await command(provider, "status", "goal status", 6);
  expect(provider.messages[5]).toContain("25 / 200");
  await role("operator");
  await command(provider, "denied", "goal clear", 7);
  expect(provider.messages[6]).toContain("owner or admin");
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { kind: "present", goal: { tokensUsed: 25 } },
  });
  await role("admin");
  await command(provider, "invalid", "goal set -1 Ignore the budget", 8);
  expect(provider.messages[7]).toContain("Goal commands:");
  await command(provider, "complete", "goal complete Stock count verified", 9);
  await command(provider, "clear", "goal clear", 10);
  expect(await owner.readGoal(identity)).toMatchObject({
    ok: true,
    value: { kind: "none" },
  });
  expect(provider.calls).toBe(1);
  const inspected = await owner.inspect();
  if (!inspected.ok) throw new Error(inspected.error.code);
  const goalOutputs = inspected.value.outputs.filter(isGoalOutput);
  expect(goalOutputs).toHaveLength(9);
  expect(goalOutputs.every(isSettled)).toBe(true);
  Object.assign(context.task.meta, {
    slackGoalEvidence: {
      providerCalls: provider.calls,
      deliveryAttempts: provider.attempts,
      replies: provider.messages,
      goalReplyCount: goalOutputs.length,
      allGoalRepliesSettled: true,
      initialGoalWithoutSession: true,
      budgetIncreasePreservedPause: true,
    },
  });
}
function isGoalOutput(output: {
  output: { source: { kind: string } };
}): boolean {
  return output.output.source.kind === "operator_command";
}
function isSettled(output: { kind: string }): boolean {
  return output.kind === "settled";
}
async function role(value: "admin" | "operator"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'",
    )
    .bind(value, ORGANISATION_ID)
    .run();
}
async function command(
  provider: GoalProviders,
  id: string,
  text: string,
  sequence: number,
): Promise<void> {
  await send(id, text, sequence);
  await expect
    .poll(provider.messageCount.bind(provider), { timeout: 15000 })
    .toBe(sequence);
}
async function send(id: string, text: string, sequence: number): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: `EvGoalCommand_${id}`,
        messageTs: `1787500000.${String(sequence).padStart(6, "0")}`,
        threadTs: ROOT_TS,
        text,
      }),
    ),
  );
  expect(response.status).toBe(200);
}
class GoalProviders {
  blocked = true;
  attempts = 0;
  calls = 0;
  messages: string[] = [];
  messageCount(): number {
    return this.messages.length;
  }
  attemptCount(): number {
    return this.attempts;
  }
  async slack({
    request,
    params,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (params.method === "assistant.threads.setStatus")
      return HttpResponse.json({ ok: true });
    expect(params.method).toBe("chat.postMessage");
    this.attempts += 1;
    if (this.blocked)
      return new HttpResponse(null, {
        status: 429,
        headers: { "retry-after": "1" },
      });
    const raw: unknown = await request.json();
    // An answer is posted as Markdown, a notice as plain text.
    const text = isRecord(raw) ? (raw.markdown_text ?? raw.text) : undefined;
    if (typeof text !== "string") throw new Error("Invalid Slack reply");
    this.messages.push(text);
    return HttpResponse.json({
      ok: true,
      channel: "C0E2EACTOR",
      ts: `1787500001.${String(this.messages.length).padStart(6, "0")}`,
    });
  }
  model(): Response {
    this.calls += 1;
    return openRouterStream([
      {
        id: "goal_command_model",
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
        id: "goal_command_model",
        object: "chat.completion.chunk",
        created: 1787500000,
        model: PLATFORM_DEFAULT_PI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);
  }
}
