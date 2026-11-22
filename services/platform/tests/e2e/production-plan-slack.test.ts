import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { SLACK_PERMISSION_RESUME_TEXT } from "../../src/actors/connector-slack-case-work";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { lastCalledTool } from "./chat-permission-support";
import { commerceHeaders, connectCommerceFixture } from "./commerce-support";
import { network } from "./network";
import {
  allowAsPortal,
  givePortalHandles,
  readRequest,
  requestIdIn,
} from "./permission-request-support";
import {
  LOCATION,
  PRODUCTION,
  PlanJourney,
  readPlan,
} from "./production-plan-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
  postMention,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    productionPlanSlack?: Record<string, unknown>;
  }
}

/**
 * Plan 40D Phase B2 in Slack. An operator asks Pantry in a channel thread to
 * plan the café's production. Nobody may read production requests, so the
 * agent asks for that read and for the plan; the channel answers everyone in
 * it, so the read names the channel as well as each role. The owner shares
 * the thread with the café's plan and allows the request. The continued turn
 * changes a line of the plan. In a second thread of the same channel, which
 * nobody shared with the plan, the agent reads the plan but its change is
 * refused, and the agent can tell the operator why.
 */
it(
  "plans the café's production from the Slack thread that the owner shared with the plan and refuses the same change from another thread",
  { timeout: 240_000 },
  slackPlanJourney,
);

const MERCHANT_ID = "merchant_bakery_c3_plan_slack";
const SECOND_ROOT_TS = "1787500300.000001";
const QUESTION = `plan today's production for ${LOCATION}`;
const ANSWERS = {
  asked: "I asked an owner for permission to plan production.",
  planned: "I set the first request to 48 pieces. Review and accept the plan.",
  refused:
    "This thread is not shared with the café's plan, so I cannot change it here.",
} as const;
const ALLOWED_NOTICE =
  "An owner or admin allowed the permission. Sous Chef continues the request now.";

type Recorded = {
  readonly requests: Record<string, unknown>[];
  turns: number;
  readonly editOutputs: string[];
};

async function slackPlanJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  await activateOrganisation();
  await connectCommerceFixture(
    ORGANISATION_ID,
    owner.session.userId,
    MERCHANT_ID,
  );
  const shop = new PlanJourney(ORGANISATION_ID, MERCHANT_ID, owner);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  await shop.write(PRODUCTION, { kind: "setup" });
  const [first, second] = await shop.createRequests(2);
  if (first === undefined || second === undefined)
    throw new Error("Production requests missing");

  const recorded: Recorded = { requests: [], turns: 0, editOutputs: [] };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded, first, second),
    ),
    slack.handler,
  );

  // 1. The agent asks for the read and the plan in one request.
  await postMention("Ev_PLAN_SLACK_FIRST", ROOT_TS, QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(textsOf(slack.messages)).toEqual([
    expect.stringContaining(
      "Sous Chef needs permission to read production requests and plan production in the shared plan",
    ),
    ANSWERS.asked,
  ]);
  const requestId = requestIdIn(slack.messages);
  const request = await readRequest(ORGANISATION_ID, owner, requestId);
  const items =
    isRecord(request) && Array.isArray(request.items) ? request.items : [];
  expect(items.map(itemId)).toEqual([
    "commerce.entity.read:production_requests:conversation",
    "commerce.entity.read:production_requests:owner",
    "commerce.entity.read:production_requests:admin",
    "commerce.entity.read:production_requests:operator",
    "commerce.entity.read:production_requests:viewer",
    "commerce.production_plan.edit",
  ]);
  expect(request).toMatchObject({ requesterRole: "operator" });

  // 2. The owner shares the thread with the plan and allows the request.
  const shared = await sharePlanThread(owner, ROOT_TS);
  expect(shared).toMatchObject({
    status: 200,
    body: { sharing: { kind: "slack_thread" } },
  });
  const allowed = await allowAsPortal(ORGANISATION_ID, owner, requestId);
  expect(allowed.status, await allowed.clone().text()).toBe(200);

  // 3. The continued turn changes the first line.
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  expect(textsOf(slack.messages)[0]).toBe(ALLOWED_NOTICE);
  expect(textsOf(slack.messages).slice(2)).toEqual([ANSWERS.planned]);
  expect(await planLines()).toEqual({ [first]: "48" });

  // 4. Another thread reads the plan, but its change is refused.
  await postMention("Ev_PLAN_SLACK_SECOND", SECOND_ROOT_TS, QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(4);
  expect(textsOf(slack.messages).slice(3)).toEqual([ANSWERS.refused]);
  expect(recorded.editOutputs[1]).toContain(
    "This conversation is not shared with this location's plan.",
  );
  expect(await planLines()).toEqual({ [first]: "48" });
  expect(threadsOf(slack.messages)).toEqual([
    ROOT_TS,
    ROOT_TS,
    ROOT_TS,
    SECOND_ROOT_TS,
  ]);

  task.meta.productionPlanSlack = {
    requests: { first, second },
    permissionRequest: request,
    threadShare: shared.body,
    posts: slack.messages.map(threadAndText),
    editOutputs: recorded.editOutputs,
    planAfter: await planLines(),
    modelRequests: recorded.requests.length,
  };
}

/**
 * Answers each model request. Turn 1 asks; turn 2 (the continued request)
 * and turn 3 (the second thread) read the plan and change one line.
 */
async function replyToModel(
  recorded: Recorded,
  first: string,
  second: string,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  const id = `plan_slack_${String(recorded.requests.length)}`;
  const called = lastCalledTool(body);
  if (called === null) {
    recorded.turns += 1;
    if (recorded.turns === 1) {
      expect(offered).toContain("request_permission");
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: ["commerce.production_plan.edit"],
          entityTypeReads: ["production_requests"],
        },
        `call_${id}`,
      );
    }
    if (recorded.turns === 2)
      expect(JSON.stringify(body.messages)).toContain(
        SLACK_PERMISSION_RESUME_TEXT,
      );
    return offered.includes("production_plan_read")
      ? readPlan(id)
      : openRouterToolCall(
          "tool_search",
          { query: "production_plan_read production_plan_edit" },
          `call_${id}`,
        );
  }
  const output = requireLastToolOutput(body);
  switch (called) {
    case "request_permission":
      expect(output).toContain("permission_requested");
      return openRouterText(ANSWERS.asked, id);
    case "tool_search":
      return readPlan(id);
    case "production_plan_read":
      expect(output).toContain(first);
      return openRouterToolCall(
        "production_plan_edit",
        recorded.turns === 2
          ? { locationId: LOCATION, requestId: first, quantity: "48" }
          : { locationId: LOCATION, requestId: second, quantity: "60" },
        `call_${id}`,
      );
    case "production_plan_edit":
      recorded.editOutputs.push(output);
      return openRouterText(
        recorded.turns === 2 ? ANSWERS.planned : ANSWERS.refused,
        id,
      );
    default:
      throw new Error(`Unexpected tool ${called}`);
  }
}

/** An active Organisation. The Slack fixture leaves its onboarding open. */
async function activateOrganisation(): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_plan_slack', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
}

/** The owner's plan share, as the plan page sends it. */
async function sharePlanThread(
  owner: IssuedControlSession,
  threadTs: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/inventory/production-plan/${LOCATION}/share`,
    {
      method: "PUT",
      headers: commerceHeaders(owner),
      body: JSON.stringify({
        threadUrl: `https://e2e.slack.com/archives/${CHANNEL_ID}/p${threadTs.replace(".", "")}`,
      }),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** The plan's lines as every open page and the agent read them. */
async function planLines(): Promise<Record<string, string>> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const plan = await organisation.readProductionPlan({
    organisationId: ORGANISATION_ID,
    locationId: LOCATION,
  });
  if (!plan.ok) throw new Error(plan.error.code);
  return Object.fromEntries(
    plan.value.lines.map((line) => [line.requestId, line.quantity]),
  );
}

function itemId(item: unknown): unknown {
  return isRecord(item) ? item.itemId : null;
}

function textsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map((message) => message.text ?? "");
}

function threadsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map((message) => message.thread_ts ?? "");
}

function threadAndText(post: Record<string, string>) {
  return { thread: post.thread_ts, text: post.text };
}
