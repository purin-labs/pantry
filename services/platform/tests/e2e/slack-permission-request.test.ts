import { runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { listPlacementActorRegistryEntries } from "../../src/actors/actor-registry";
import { actorStub } from "../../src/actors/actor-stubs";
import { SLACK_PERMISSION_RESUME_TEXT } from "../../src/actors/connector-slack-case-work";
import {
  createGrant,
  enableCapability,
  pendingDecisionsOf,
} from "./access-route-support";
import { network } from "./network";
import {
  decide as decideRequest,
  givePortalHandles,
  readRequest as readRequestView,
  requestIdIn,
  requestItems,
} from "./permission-request-support";
import {
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

/**
 * An agent in a Slack thread asks for a permission instead of giving up.
 *
 * An operator asks Pantry about the shared menu draft while the Organisation
 * has the menu read turned off. The turn is not offered the menu tool; it is
 * offered `request_permission`, asks, and answers once. The thread gets one
 * notice with a Portal link. An allow before the owner changes Access is
 * refused. The owner turns the capability on and grants it to the operator
 * role through the Access routes, then allows the request: the thread gets
 * one notice and a new turn that reads the menu for the person's original
 * question. A repeated allow starts nothing. In a second thread the owner
 * denies a request: the thread gets one notice, no turn runs, and a later
 * allow of that request is refused.
 */
it(
  "asks for a missing permission in Slack and continues after an owner allows it",
  permissionJourney,
  180_000,
);

const MENU_QUESTION = "how many items are on the shared menu draft?";
const EMAIL_QUESTION = "put Autumn tasting in the shared email subject";
const SECOND_ROOT_TS = "1787500100.000001";
const ANSWERS = {
  askedMenu: "I asked an owner for permission to read the menu draft.",
  menu: "Nobody has started the shared menu draft yet.",
  askedEmail: "I asked an owner for permission to edit the email draft.",
} as const;

type Recorded = { readonly requests: Record<string, unknown>[] };

async function permissionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  const recorded: Recorded = { requests: [] };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    slack.handler,
  );

  // 1. The turn lacks the menu read, asks for it, and answers once.
  await postMention("Ev_PERMISSION_MENU", ROOT_TS, MENU_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(recorded.requests).toHaveLength(2);
  const menuRequestId = requestIdIn(slack.messages);
  expect(textsOf(slack.messages)).toEqual([
    expect.stringContaining(
      "Sous Chef needs permission to read the shared menu draft",
    ),
    ANSWERS.askedMenu,
  ]);

  const pending = await readRequest(owner, menuRequestId);
  expect(pending).toMatchObject({
    status: "pending",
    requesterRole: "operator",
    mayDecide: true,
    items: [
      {
        capabilityId: "commerce.menu_draft.read",
        mode: "disabled",
        granted: false,
      },
    ],
  });

  // The one read over every store shows the request one time.
  expect(await pendingDecisionsOf(ORGANISATION_ID, owner)).toEqual([
    { kind: "permission_request", id: menuRequestId },
  ]);

  // 2. An allow before Access gives the capability is refused.
  const early = await decide(owner, menuRequestId, "allow");
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ error: "permission_missing" });
  expect(recorded.requests).toHaveLength(2);

  // 3. The owner changes Access as the Portal does, then allows.
  await enableCapability(ORGANISATION_ID, owner, "commerce.menu_draft.read");
  const enabled = await readRequest(owner, menuRequestId);
  expect(enabled).toMatchObject({
    items: [{ mode: "enabled", granted: false }],
  });
  const [item] = requestItems(enabled);
  if (item === undefined) throw new Error("Permission request item missing");
  await createGrant(ORGANISATION_ID, owner, item.grant);
  expect(await readRequest(owner, menuRequestId)).toMatchObject({
    items: [{ mode: "enabled", granted: true }],
  });
  const allowed = await decide(owner, menuRequestId, "allow");
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({
    ok: true,
    status: "allowed",
    waitingForSlack: false,
  });

  // A decided request waits for nobody.
  expect(await pendingDecisionsOf(ORGANISATION_ID, owner)).toEqual([]);

  // 4. The request continues in the thread, for the original question.
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  expect(recorded.requests).toHaveLength(4);
  expect(textsOf(slack.messages)[0]).toBe(
    "An owner or admin allowed the permission. Sous Chef continues the request now.",
  );
  expect(textsOf(slack.messages).slice(2)).toEqual([ANSWERS.menu]);
  expect(threadsOf(slack.messages)).toEqual([ROOT_TS, ROOT_TS, ROOT_TS]);

  // 5. A repeated allow releases nothing more.
  const repeated = await decide(owner, menuRequestId, "allow");
  expect(repeated.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(recorded.requests).toHaveLength(4);
  expect(slack.visibleMessageCount()).toBe(3);

  // 6. In a second thread the owner denies the request.
  await postMention("Ev_PERMISSION_EMAIL", SECOND_ROOT_TS, EMAIL_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(5);
  expect(recorded.requests).toHaveLength(6);
  const emailRequestId = requestIdIn(slack.messages.slice(3));
  expect(emailRequestId).not.toBe(menuRequestId);
  const denied = await decide(owner, emailRequestId, "deny");
  expect(denied.status).toBe(200);
  expect(await denied.json()).toEqual({
    ok: true,
    status: "denied",
    waitingForSlack: false,
  });
  await expect
    .poll(() => textsOf(slack.messages)[3], { timeout: 15_000 })
    .toBe(
      "An owner or admin denied the permission. Sous Chef stopped this request.",
    );
  expect(slack.visibleMessageCount()).toBe(5);
  const lateAllow = await decide(owner, emailRequestId, "allow");
  expect(lateAllow.status).toBe(409);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(recorded.requests).toHaveLength(6);
  expect(slack.visibleMessageCount()).toBe(5);
  expect(await readRequest(owner, emailRequestId)).toMatchObject({
    status: "denied",
    items: [{ capabilityId: "marketing.email_draft.edit", granted: false }],
  });

  Object.assign(test.task.meta, {
    slackPermissionRequest: {
      modelRequests: recorded.requests.length,
      posts: slack.messages.map(threadAndText),
      allowed: await readRequest(owner, menuRequestId),
      denied: await readRequest(owner, emailRequestId),
      connector: await connectorWork(fixture.connectorId),
    },
  });
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
      expect(offered).toContain("request_permission");
      expect(offered).not.toContain("menu_draft_read");
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: ["commerce.menu_draft.read"], entityTypeReads: [] },
        "call_permission_menu",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("permission_requested");
      return openRouterText(ANSWERS.askedMenu, "permission_menu_asked");
    case 3: {
      // The continued turn has the tool and the person's own question.
      expect(offered).toContain("menu_draft_read");
      const text = JSON.stringify(body.messages);
      expect(text).toContain(SLACK_PERMISSION_RESUME_TEXT);
      expect(text).toContain(MENU_QUESTION);
      return openRouterToolCall("menu_draft_read", {}, "call_menu_read");
    }
    case 4:
      // The read ran under the new grant. No person has opened the menu yet,
      // so the Organisation reports no draft, and the answer says so.
      expect(requireLastToolOutput(body)).not.toContain("permission");
      return openRouterText(ANSWERS.menu, "permission_menu_answered");
    case 5:
      expect(offered).toContain("request_permission");
      expect(offered).not.toContain("email_draft_edit");
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: ["marketing.email_draft.edit"], entityTypeReads: [] },
        "call_permission_email",
      );
    case 6:
      expect(requireLastToolOutput(body)).toContain("permission_requested");
      return openRouterText(ANSWERS.askedEmail, "permission_email_asked");
    default:
      throw new Error("Unexpected model request");
  }
}

function readRequest(
  session: Parameters<typeof readRequestView>[1],
  requestId: string,
): Promise<Record<string, unknown>> {
  return readRequestView(ORGANISATION_ID, session, requestId);
}

function decide(
  session: Parameters<typeof decideRequest>[1],
  requestId: string,
  decision: "allow" | "deny",
): Promise<Response> {
  return decideRequest(ORGANISATION_ID, session, requestId, decision);
}

function textsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map(textOf);
}

function textOf(message: Record<string, string>): string {
  return message.text ?? "";
}

function threadsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map(threadOf);
}

function threadOf(message: Record<string, string>): string {
  return message.thread_ts ?? "";
}

function threadAndText(post: Record<string, string>) {
  return { thread: post.thread_ts, text: post.text };
}

/** What the Connector keeps: parked requests and the continued turn. */
async function connectorWork(connectorId: string) {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const entry = entries.value.find(
    (candidate) =>
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId,
  );
  if (entry === undefined) throw new Error("Connector registry entry missing");
  const stub = actorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
  return runInDurableObject(
    stub,
    (_actor: unknown, ctx: DurableObjectState) => ({
      parked: ctx.storage.sql
        .exec(
          "SELECT request_id, decision FROM connector_parked_case_work ORDER BY created_at",
        )
        .toArray(),
      continued: ctx.storage.sql
        .exec(
          "SELECT event_id, outcome FROM connector_case_work_receipt WHERE event_id LIKE 'permission!_%' ESCAPE '!'",
        )
        .toArray(),
    }),
  );
}
