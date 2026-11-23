import { env } from "cloudflare:workers";
import { HttpResponse, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { SLACK_PERMISSION_RESUME_TEXT } from "@purin-labs/surface-slack/server/actors/connector-slack-case-work";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { createGrant, enableCapability } from "./access-route-support";
import { network } from "./network";
import {
  decide,
  givePortalHandles,
  readRequest,
  requestIdIn,
  requestItems,
} from "./permission-request-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  WORKSPACE_ID,
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
    slackPermissionDuringOutage?: Record<string, unknown>;
  }
}

/**
 * An owner allows an agent's permission request while Pantry cannot reach
 * Slack. The scheduled Slack check has found the Slack connection unhealthy,
 * so Pantry cannot post in the thread. The Allow must still succeed in the
 * Portal and say that the request waits for Slack; no turn may run that
 * cannot answer. When Slack answers the next scheduled check, the same run
 * continues the request: the thread gets the notice and the answer once, and
 * later runs start nothing more.
 */
it(
  "keeps an allow that Slack cannot take yet and continues the request once Slack works again",
  outageJourney,
  180_000,
);

const MENU_QUESTION = "how many items are on the shared menu draft?";
const ANSWERS = {
  asked: "I asked an owner for permission to read the menu draft.",
  menu: "Nobody has started the shared menu draft yet.",
} as const;
const ALLOWED_NOTICE =
  "An owner or admin allowed the permission. Sous Chef continues the request now.";

type Recorded = { readonly requests: Record<string, unknown>[] };

async function outageJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  const recorded: Recorded = { requests: [] };
  const slackApp = { healthy: true };
  const slack = slackSimulator();
  network.use(
    http.post("https://slack.com/api/auth.test", () =>
      HttpResponse.json(
        slackApp.healthy
          ? { ok: true, team_id: WORKSPACE_ID }
          : { ok: false, error: "account_inactive" },
      ),
    ),
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    slack.handler,
  );

  // 1. The turn lacks the menu read and asks for it.
  await postMention("Ev_OUTAGE_MENU", ROOT_TS, MENU_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  const requestId = requestIdIn(slack.messages);
  await enableCapability(ORGANISATION_ID, owner, "commerce.menu_draft.read");
  const [item] = requestItems(
    await readRequest(ORGANISATION_ID, owner, requestId),
  );
  if (item === undefined) throw new Error("Permission request item missing");
  await createGrant(ORGANISATION_ID, owner, item.grant);

  // 2. Slack stops answering, and the scheduled check marks the
  //    connection as needing attention.
  slackApp.healthy = false;
  await runScheduledOnboardingReconciliation(env, Date.now());
  const posts = slack.visibleMessageCount();

  // 3. The owner allows. The Portal gets a success that says the request
  //    waits for Slack, and no turn runs.
  const allowed = await decide(ORGANISATION_ID, owner, requestId, "allow");
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect(await allowed.json()).toEqual({
    ok: true,
    status: "allowed",
    waitingForSlack: true,
  });
  const waiting = await readRequest(ORGANISATION_ID, owner, requestId);
  expect(waiting).toMatchObject({ status: "allowed", waitingForSlack: true });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(recorded.requests).toHaveLength(2);
  expect(slack.visibleMessageCount()).toBe(posts);

  // 4. Slack answers again. The next scheduled run makes the connection
  //    usable and continues the request in the thread.
  slackApp.healthy = true;
  await runScheduledOnboardingReconciliation(env, Date.now());
  await expect
    .poll(slack.visibleMessageCount, { timeout: 60_000 })
    .toBe(posts + 1);
  expect(textsOf(slack.messages)[0]).toBe(ALLOWED_NOTICE);
  expect(textsOf(slack.messages).slice(posts)).toEqual([ANSWERS.menu]);
  expect(recorded.requests).toHaveLength(4);
  const continued = await readRequest(ORGANISATION_ID, owner, requestId);
  expect(continued).toMatchObject({
    status: "allowed",
    waitingForSlack: false,
  });

  // 5. Later runs and a repeated allow start nothing more.
  await runScheduledOnboardingReconciliation(env, Date.now());
  const repeated = await decide(ORGANISATION_ID, owner, requestId, "allow");
  expect(await repeated.json()).toEqual({
    ok: true,
    status: "allowed",
    waitingForSlack: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(recorded.requests).toHaveLength(4);
  expect(slack.visibleMessageCount()).toBe(posts + 1);

  task.meta.slackPermissionDuringOutage = {
    allowDuringOutage: { status: allowed.status, waitingForSlack: true },
    postsWhileWaiting: posts,
    afterRecovery: textsOf(slack.messages).slice(posts),
    modelRequests: recorded.requests.length,
  };
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  switch (recorded.requests.length) {
    case 1:
      expect(offered).not.toContain("menu_draft_read");
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: ["commerce.menu_draft.read"], entityTypeReads: [] },
        "call_outage_permission",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("permission_requested");
      return openRouterText(ANSWERS.asked, "outage_asked");
    case 3: {
      expect(offered).toContain("menu_draft_read");
      const text = JSON.stringify(body.messages);
      expect(text).toContain(SLACK_PERMISSION_RESUME_TEXT);
      expect(text).toContain(MENU_QUESTION);
      return openRouterToolCall("menu_draft_read", {}, "call_outage_menu");
    }
    case 4:
      return openRouterText(ANSWERS.menu, "outage_answered");
    default:
      throw new Error("Unexpected model request");
  }
}

function textsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map((message) => message.text ?? "");
}
