import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  CAPABILITY_KEYS,
  SLACK_MESSAGE_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { FlowPolicyInput } from "@purin-labs/authority/policy/information-flow/index";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { CARD_ONLY_REPLY } from "@purin-labs/tool-handlers/slack/card-only-reply";
import { reconcileHeldOutputRequests } from "../../src/slack/held-output-release";
import { enableCapability } from "./access-route-support";
import {
  admin,
  decide,
  heldStatus,
  joiner,
  pendingOf,
  raiseLabel,
  readHeld,
} from "./held-exit-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  CHANNEL_ID,
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  ORGANISATION_ID,
  readSlackMessageText,
  ROOT_TS,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackHeldEffect?: Record<string, unknown>;
  }
}

/**
 * A tool effect that the exit check stops asks a person (Plan 27C).
 *
 * In a thread, the agent has read a member's direct message and tries to draft
 * a Slack message from it. The step stops, the agent learns why, and the thread
 * gets a notice with no word of the draft. Only that member sees the request.
 * Allow continues the request in a new turn: the draft goes through once, and
 * a second draft in that turn asks again. In a second thread the member denies
 * the step. No new turn runs, and the agent's next turn in the thread knows.
 * In a third thread nobody decides, so the request expires.
 *
 * The journey adds the turn's read to the Session, as a tool read does.
 */
it("asks a person about a blocked tool effect", slackHeldEffect, 240_000);

const OWNER = {
  kind: "organisation",
  organisationId: ORGANISATION_ID,
} as const;
const SECOND_ROOT_TS = "1787500200.000001";
const THIRD_ROOT_TS = "1787500300.000001";
const DRAFT_TEXT = "The flour supplier raises the price on Monday.";
const STOPPED = "Purin Pantry stopped this step";

type Step = (body: Record<string, unknown>) => Promise<Response> | Response;

async function slackHeldEffect({ task }: TestContext): Promise<void> {
  const joining = [await joiner(), await joiner()] as const;
  const fixture = await installSlackActorFixture();
  const member = await admin(joining[0], "Direct message owner");
  const other = await admin(joining[1], "Other admin");
  await givePortalHandles(ORGANISATION_ID);
  await discoverSlackChannel("public_channel", Date.now() - 60_000);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_held_effect', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  await enableCapability(
    ORGANISATION_ID,
    fixture.ownerSession,
    CAPABILITY_KEYS.slackMessagePropose,
  );
  await enableCapability(
    ORGANISATION_ID,
    fixture.ownerSession,
    CAPABILITY_KEYS.integrationDiscoveryRead,
  );
  // A channel turn acts for the channel and for the person, so both hold them.
  const subjects = [
    { kind: "organisation_role", role: "operator" },
    {
      kind: "conversation",
      integrationAccountId: fixture.selectedIntegrationAccountId,
      conversationId: CHANNEL_ID,
    },
  ] as const;
  for (const [index, subject] of subjects.entries()) {
    await createRequiredGrant({
      grantId: `grant_held_effect_list_${index}`,
      subject,
      target: {
        kind: "platform_capability",
        capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
        capabilityVersion: 1,
      },
      now: Date.now(),
    });
    await createRequiredGrant({
      grantId: `grant_held_effect_draft_${index}`,
      subject,
      target: {
        kind: "provider_resource",
        capabilityId: CAPABILITY_KEYS.slackMessagePropose,
        capabilityVersion: 1,
        integrationAccountId: fixture.selectedIntegrationAccountId,
        resourceScope: SLACK_MESSAGE_RESOURCE_SCOPE,
      },
      now: Date.now(),
    });
  }
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

  const direct: FlowPolicyInput = {
    owner: OWNER,
    readers: [{ kind: "person", personId: member.personId }],
  };
  const steps: Step[] = [];
  const toolOutputs: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const slack = slackSimulator();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid model request");
        bodies.push(body);
        const step = steps.shift();
        if (step === undefined) throw new Error("Unexpected model request");
        return step(body);
      },
    ),
  );
  const shown = (): string[] => slack.messages.map(readSlackMessageText);
  const lastOutput = (body: Record<string, unknown>): string => {
    const text = JSON.stringify(body.input ?? body.messages);
    return text.slice(-2_000);
  };
  const accountRefFrom = (body: Record<string, unknown>): string => {
    const match = /integration_ref_[0-9a-f]{64}/u.exec(JSON.stringify(body));
    if (match === null) throw new Error("No Slack account reference");
    return match[0];
  };
  const proposeSteps = (id: string): Step[] => [
    () =>
      openRouterToolCall(
        "tool_search",
        { query: "slack_message_propose integration_list", limit: 8 },
        `search_${id}`,
      ),
    () => openRouterToolCall("integration_list", {}, `list_${id}`),
    (body) =>
      openRouterToolCall(
        "slack_message_propose",
        { accountRef: accountRefFrom(body), channel: null, text: DRAFT_TEXT },
        `propose_${id}`,
      ),
  ];
  const finish =
    (id: string, text: string): Step =>
    (body) => {
      toolOutputs.push(lastOutput(body));
      return openRouterText(text, `answer_${id}`);
    };

  // 1. The turn read the direct message, and its draft stops.
  const raised =
    (step: Step): Step =>
    async (body) => {
      await raiseLabel(direct);
      return step(body);
    };
  const first = proposeSteps("first");
  steps.push(
    first[0] as Step,
    first[1] as Step,
    raised(first[2] as Step),
    finish("first", CARD_ONLY_REPLY),
  );
  await mention("EvHELD_EFFECT_ONE", ROOT_TS);
  await expect.poll(() => steps.length, { timeout: 40_000 }).toBe(0);
  await expect.poll(() => shown().length, { timeout: 40_000 }).toBe(1);
  expect(toolOutputs.at(-1)).toContain(STOPPED);
  expect(shown().join("\n")).not.toContain(DRAFT_TEXT);
  const firstCard = heldCard(slack.messages);
  expect(firstCard?.blocks).toContain("Review in Portal");
  const effectRequest = heldRequestId(firstCard);

  // 2. Only the person in the audience sees the request.
  const listed = await pendingOf(member);
  expect(listed.find((held) => held.requestId === effectRequest)).toMatchObject(
    {
      effect: expect.any(String),
      reason: "private_source",
    },
  );
  expect(await pendingOf(other)).toEqual([]);
  expect((await readHeld(other, effectRequest)).status).toBe(404);
  expect((await decide(other, effectRequest, "allow")).status).toBe(404);
  const view = await readHeld(member, effectRequest);
  expect(await view.json()).toMatchObject({
    answer: null,
    covers: "step",
    status: "pending",
  });

  // 3. Allow continues in a new turn. One pass lets one draft through.
  const noticesBefore = shown().length;
  steps.push(
    (body) =>
      openRouterToolCall(
        "slack_message_propose",
        { accountRef: accountRefFrom(body), channel: null, text: DRAFT_TEXT },
        "propose_pass",
      ),
    (body) => {
      toolOutputs.push(lastOutput(body));
      return openRouterToolCall(
        "slack_message_propose",
        { accountRef: accountRefFrom(body), channel: null, text: DRAFT_TEXT },
        "propose_again",
      );
    },
    finish("pass", "One draft is on the card."),
  );
  expect((await decide(member, effectRequest, "allow")).status).toBe(200);
  await expect.poll(() => steps.length, { timeout: 40_000 }).toBe(0);
  await expect
    .poll(() => shown().length, { timeout: 40_000 })
    .toBeGreaterThan(noticesBefore + 1);
  expect(firstCard?.text).toContain("allowed the step");
  expect(firstCard?.blocks).not.toContain("Review in Portal");
  const drafted = toolOutputs.at(-2) ?? "";
  expect(drafted).not.toContain(STOPPED);
  expect(drafted).toContain('\\"success\\":true');
  expect(toolOutputs.at(-1)).toContain(STOPPED);
  expect((await decide(member, effectRequest, "allow")).status).toBe(200);

  // 4. Deny runs no turn, and the next turn of the thread knows.
  const second = proposeSteps("second");
  steps.push(
    second[0] as Step,
    second[1] as Step,
    raised(second[2] as Step),
    finish("second", "I asked again."),
  );
  const beforeSecond = shown().length;
  await mention("EvHELD_EFFECT_TWO", SECOND_ROOT_TS);
  await expect
    .poll(() => shown().length, { timeout: 40_000 })
    .toBeGreaterThan(beforeSecond + 1);
  const deniedCard = heldCard(slack.messages.slice(beforeSecond));
  const deniedRequest = heldRequestId(deniedCard);
  const modelCallsBeforeDeny = bodies.length;
  expect((await decide(member, deniedRequest, "deny")).status).toBe(200);
  expect(deniedCard?.text).toContain("denied the step");
  expect(deniedCard?.blocks).not.toContain("Review in Portal");
  expect(bodies).toHaveLength(modelCallsBeforeDeny);
  expect((await decide(member, deniedRequest, "allow")).status).toBe(409);
  steps.push(finish("next", "I understand."));
  await mention("EvHELD_EFFECT_NEXT", "1787500200.000009", SECOND_ROOT_TS);
  await expect.poll(() => steps.length, { timeout: 40_000 }).toBe(0);
  expect(JSON.stringify(bodies.at(-1))).toContain(
    "Sous Chef did not do the step that waited for approval",
  );

  // 5. Nobody decides, so the request expires.
  const third = proposeSteps("third");
  steps.push(
    third[0] as Step,
    third[1] as Step,
    raised(third[2] as Step),
    finish("third", "I asked once more."),
  );
  const beforeThird = shown().length;
  await mention("EvHELD_EFFECT_THREE", THIRD_ROOT_TS);
  await expect
    .poll(() => shown().length, { timeout: 40_000 })
    .toBeGreaterThan(beforeThird + 1);
  const expiredCard = heldCard(slack.messages.slice(beforeThird));
  const expiredRequest = heldRequestId(expiredCard);
  const scope = await OrganisationExecutionScope.resolve(env, ORGANISATION_ID);
  if (!scope.ok) throw new Error(scope.error.code);
  await reconcileHeldOutputRequests({
    env,
    scope: scope.value,
    now: Date.now() + 8 * 24 * 60 * 60_000,
  });
  expect(await heldStatus(expiredRequest)).toBe("expired");
  expect(expiredCard?.text).toContain("Nobody approved the step");
  expect(expiredCard?.blocks).not.toContain("Review in Portal");
  // The agent had nothing to add to the first card, so no note stays under it.
  expect(shown()).not.toContain(CARD_ONLY_REPLY);

  // Slack was told to fetch no link of what Pantry posted in this thread.
  expect(slack.messages.length).toBeGreaterThan(0);
  expect(slack.postsWithLinkPreview()).toBe(0);

  task.meta.slackHeldEffect = {
    shown: shown(),
    statuses: await Promise.all(
      [effectRequest, deniedRequest, expiredRequest].map(heldStatus),
    ),
  };
}

async function mention(
  eventId: string,
  messageTs: string,
  threadTs: string = messageTs,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs,
        threadTs,
        text: "<@U0PANTRY> draft a message about the flour price",
      }),
    ),
  );
  expect(response.status).toBe(200);
}

function heldCard(
  messages: readonly Record<string, string>[],
): Record<string, string> | undefined {
  return messages.find((message) => message.text?.includes("one step"));
}

function heldRequestId(card: Record<string, string> | undefined): string {
  expect(card?.text).not.toContain("https:");
  const match = /heldOutput=([0-9a-f]{32})/u.exec(card?.blocks ?? "");
  if (match?.[1] === undefined) throw new Error("Held request link missing");
  return match[1];
}
