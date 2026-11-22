import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { bypass, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { CommerceAdminClient } from "@purin-labs/commerce-client";
import { network } from "./network";
import { connectCommerceFixture } from "./commerce-support";
import {
  ORGANISATION_ID,
  CHANNEL_ID,
  ROOT_TS,
  installSlackActorFixture,
  createRequiredGrant,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
  inspectSlackActors,
  requiredUserId,
} from "./slack-journey-support";
import {
  installMerchantAgent,
  merchantAgentDefaultSkills,
  MERCHANT_AGENT_READ_CAPABILITY,
} from "../../src/data/merchant-agent-preset";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";

const MERCHANT_ID = "merchant_bakery_c3_order_attention";
const OUTPUT_SHAPE =
  'Return only JSON {"issues":[{"orderId":"existing ID","kind":"payment|delay|exception","reason":"evidence and relevant time","nextStep":"manual advice"}],"coverage":"source types and timestamps checked; gaps"}. Keep exclusions outside issues. Never invent links.';

it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "accepts a mock-shop brief, investigation and resolved-payment refresh through signed Slack, real Urk and native commerce",
  acceptsOrderAttention,
  600_000,
);

async function acceptsOrderAttention(context: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  await connectCommerceFixture(
    ORGANISATION_ID,
    "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
    MERCHANT_ID,
  );
  await mutateFixture("seed");
  const installed = await installMerchantAgent({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    actorUserId: "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
    policyRevision: 1,
    skills: merchantAgentDefaultSkills(),
    now: Date.now(),
  });
  if (!installed.ok) throw new Error(installed.error.code);
  for (const capabilityId of [
    MERCHANT_AGENT_READ_CAPABILITY,
    "commerce.entity.read",
  ] as const) {
    const changed = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: requiredUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
          mutationReceiptId: "receipt_attention_capabilities",
        },
        now: Date.now(),
      },
    });
    if (!changed.ok) throw new Error(changed.error.code);
  }
  for (const typeId of [
    "order",
    "payment",
    "fulfillment",
    "shipment",
  ] as const) {
    await createRequiredGrant({
      grantId: `grant_attention_${typeId}`,
      subject: {
        kind: "conversation",
        integrationAccountId: fixture.selectedIntegrationAccountId,
        conversationId: CHANNEL_ID,
      },
      target: {
        kind: "commerce_read",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId },
        },
      },
      now: Date.now(),
    });
  }
  await createRequiredGrant({
    grantId: "grant_attention_capability",
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: MERCHANT_AGENT_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  await fixtureDatabase()
    .prepare(
      "UPDATE workspace_ai_budget SET max_tokens = 256000, max_wall_ms = 600000, max_tool_calls = 40, previous_limits_json = json_object('maxTokens', 256000, 'maxWallMs', 600000, 'maxToolCalls', 40) WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
  const slack = slackSimulator();
  const provider = new LiveAttentionProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  const native = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const before = await native.readSnapshot(MERCHANT_ID);
  if (!before.ok) throw new Error("Mock shop snapshot unavailable");
  const turns: { phase: string; text: string; elapsedMs: number }[] = [];
  Object.assign(context.task.meta, {
    orderAttentionEvidence: {
      merchantId: MERCHANT_ID,
      before: before.value,
      turns,
      modelCalls: provider.calls,
    },
  });
  const brief = await sendAttentionTurn(
    slack,
    turns,
    "brief",
    1,
    `<@U0PANTRY> Agent Urk: Which orders need my attention because of unresolved failed payments or delays? Group repeated failures by order, check later captures and completion, read all four source types and follow all pages. ${OUTPUT_SHAPE}`,
  );
  expect(issueIdentities(brief)).toEqual([
    "order_attention_delayed:delay",
    "order_attention_exception:exception",
    "order_attention_failed:payment",
  ]);
  const unchanged = await native.readSnapshot(MERCHANT_ID);
  expect(unchanged).toEqual(before);
  const investigation = await sendAttentionTurn(
    slack,
    turns,
    "investigation",
    2,
    "Investigate order_attention_failed from your brief. Re-read its order and both failed payment attempts. Explain their card-decline reason, why the payment remains unresolved, source freshness and the next manual step. Use existing references; do not execute an action.",
  );
  expect(investigation).toContain("order_attention_failed");
  expect(investigation.toLowerCase()).toContain("declin");
  const afterInvestigation = await native.readSnapshot(MERCHANT_ID);
  expect(afterInvestigation).toEqual(before);
  await mutateFixture("resolve");
  const resolved = await native.readSnapshot(MERCHANT_ID);
  if (!resolved.ok) throw new Error("Resolution snapshot unavailable");
  expect(resolved.value.merchantRevision).toBe(
    before.value.merchantRevision + 1,
  );
  const refresh = await sendAttentionTurn(
    slack,
    turns,
    "refresh",
    3,
    `Refresh the order-attention brief from current source records. Re-read all four types and check whether order_attention_failed has recovered. Include only remaining issues; disclose missing coverage. ${OUTPUT_SHAPE}`,
  );
  expect(issueIdentities(refresh)).toEqual([
    "order_attention_delayed:delay",
    "order_attention_exception:exception",
  ]);
  const after = await native.readSnapshot(MERCHANT_ID);
  expect(after).toEqual(resolved);
  const actors = await inspectSlackActors(fixture.connectorId);
  if (!actors.case.ok) throw new Error("Case inspection unavailable");
  expect(actors.case.value.outputs).toHaveLength(3);
  for (const output of actors.case.value.outputs)
    expect(output.kind).toBe("settled");
  Object.assign(context.task.meta, {
    orderAttentionEvidence: {
      merchantId: MERCHANT_ID,
      instructions: "Current installed Urk and all five skill revisions",
      before: before.value,
      resolution: resolved.value,
      after: after.ok ? after.value : null,
      turns,
      modelCalls: provider.calls,
      case: actors.case,
      session: actors.session,
      noAgentBusinessMutations: true,
      expectedBefore: [
        "order_attention_failed",
        "order_attention_delayed",
        "order_attention_exception",
      ],
      expectedAfter: ["order_attention_delayed", "order_attention_exception"],
    },
  });
}

async function mutateFixture(kind: "seed" | "resolve"): Promise<void> {
  const result = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${MERCHANT_ID}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: kind === "seed" ? "order_attention" : "order_attention_resolve",
      }),
    },
  );
  expect(result.status, await result.text()).toBe(200);
}

async function sendAttentionTurn(
  slack: ReturnType<typeof slackSimulator>,
  turns: { phase: string; text: string; elapsedMs: number }[],
  phase: string,
  sequence: number,
  text: string,
): Promise<string> {
  const started = performance.now();
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: sequence === 1 ? "app_mention" : "message",
        eventId: `EvATTENTION${sequence}`,
        messageTs:
          sequence === 1
            ? ROOT_TS
            : `1787500000.${String(sequence).padStart(6, "0")}`,
        threadTs: ROOT_TS,
        text,
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect
    .poll(slack.visibleMessageCount, { timeout: 180_000, interval: 1_000 })
    .toBe(sequence);
  const answer = slack.messages[sequence - 1]?.text;
  if (answer === undefined) throw new Error("Slack answer missing");
  turns.push({ phase, text: answer, elapsedMs: performance.now() - started });
  return answer;
}

function issueIdentities(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.issues) ||
    typeof raw.coverage !== "string" ||
    raw.coverage.length === 0
  )
    throw new Error("Brief must include issues and explicit coverage");
  const identities: string[] = [];
  for (const issue of raw.issues) {
    if (
      !isRecord(issue) ||
      typeof issue.orderId !== "string" ||
      typeof issue.kind !== "string" ||
      typeof issue.reason !== "string" ||
      typeof issue.nextStep !== "string"
    )
      throw new Error("Brief issue lacks evidence or manual advice");
    identities.push(`${issue.orderId}:${issue.kind}`);
  }
  return identities.sort();
}

class LiveAttentionProvider {
  readonly calls: { model: unknown; toolNames: string[] }[] = [];
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.clone().json();
    if (!isRecord(raw)) throw new Error("Provider request invalid");
    const toolNames: string[] = [];
    if (Array.isArray(raw.messages))
      for (const message of raw.messages) {
        if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
        for (const call of message.tool_calls) {
          if (
            isRecord(call) &&
            isRecord(call.function) &&
            typeof call.function.name === "string"
          )
            toolNames.push(call.function.name);
        }
      }
    this.calls.push({ model: raw.model, toolNames });
    return fetch(
      bypass(request.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      }),
    );
  }
}
