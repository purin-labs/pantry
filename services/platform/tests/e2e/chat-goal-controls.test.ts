import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import {
  newProjectId,
  type UserId,
  type ChatGoalCommand,
} from "@purin-labs/control-api";
import { expect, it, type TestContext } from "vitest";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { ORGANISATION_ID } from "./slack-journey-support";
import { commerceClient } from "./commerce-support";
import {
  preparePortalChatJourney,
  CONVERSATION_ID,
  chat,
  readWork,
} from "./chat-journey-support";
import { FakeChatGpt, textAnswer } from "./chatgpt-subscription-support";

it(
  "authorizes conversation goals, fences revisions and replay, and preserves state after eviction",
  goalControlsJourney,
  60_000,
);

async function goalControlsJourney(context: TestContext): Promise<void> {
  // The account authority admits the other operator, who gets a role in
  // Pantry later in the journey.
  const outsiderClient = await commerceClient("goal-controls-outsider");
  const outsiderPersonId = `person_${crypto.randomUUID()}`;
  const chatgpt = new FakeChatGpt();
  chatgpt.answer = () =>
    textAnswer(JSON.stringify({ kind: "reply", text: "Stock reviewed." }));
  const { session } = await preparePortalChatJourney({ chatgpt });
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  const initial = await requestGoal(session, null);
  expect(initial.status, await initial.clone().text()).toBe(200);
  expect(await initial.json()).toMatchObject({
    goal: { kind: "none", revision: 0 },
    support: { kind: "supported", backend: "pi" },
  });
  const set: ChatGoalCommand = {
    commandId: "set_review",
    expectedRevision: 0,
    command: {
      kind: "set",
      objective: "Review bakery stock",
      tokenBudget: 100,
    },
  };
  expect((await requestGoal(session, set, false)).status).toBe(403);
  const outsider = await createOutsider(outsiderClient, outsiderPersonId);
  expect((await requestGoal(outsider.session, null)).status).toBe(404);
  expect((await requestGoal(outsider.session, set)).status).toBe(404);
  const accepted = await requestGoal(session, set);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const saved = await accepted.json();
  expect(saved).toMatchObject({
    goal: {
      revision: 1,
      goal: {
        objective: "Review bakery stock",
        tokensUsed: 0,
        tokenBudget: 100,
      },
    },
    support: { kind: "supported", backend: "pi" },
  });
  expect(await (await requestGoal(session, set)).json()).toEqual(saved);
  expect(
    (
      await requestGoal(session, {
        ...set,
        command: {
          kind: "set",
          objective: "Changed payload",
          tokenBudget: 100,
        },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await requestGoal(session, {
        commandId: "stale_pause",
        expectedRevision: 0,
        command: { kind: "pause" },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await requestGoal(session, {
        commandId: "pause",
        expectedRevision: 1,
        command: { kind: "pause" },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await requestGoal(session, {
        commandId: "raise",
        expectedRevision: 2,
        command: { kind: "update_budget", tokenBudget: 200 },
      })
    ).json(),
  ).toMatchObject({
    goal: {
      revision: 3,
      goal: { state: { kind: "paused" }, tokenBudget: 200 },
    },
  });
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing Case");
  await evictDurableObject(env.CASE.getByName(row.name));
  expect(await (await requestGoal(session, null)).json()).toMatchObject({
    goal: { revision: 3, goal: { state: { kind: "paused" } } },
  });
  expect(
    await (
      await requestGoal(session, {
        commandId: "resume",
        expectedRevision: 3,
        command: { kind: "resume" },
      })
    ).json(),
  ).toMatchObject({
    goal: { revision: 4, goal: { state: { kind: "active" } } },
  });
  expect(
    (
      await requestGoal(session, {
        commandId: "complete",
        expectedRevision: 4,
        command: { kind: "complete", evidence: "Operator verified inventory" },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await requestGoal(session, {
        commandId: "clear",
        expectedRevision: 5,
        command: { kind: "clear" },
      })
    ).json(),
  ).toMatchObject({ goal: { kind: "none", revision: 6 } });
  expect(chatgpt.modelRequestCount()).toBe(1);
  const projectId = await shareWithViewer(outsider.userId);
  const restricted = await requestGoal(outsider.session, null);
  expect(restricted.status).toBe(403);
  expect(await restricted.text()).toContain("chat_history_forbidden");
  expect(
    (
      await requestGoal(outsider.session, {
        commandId: "viewer_set",
        expectedRevision: 6,
        command: {
          kind: "set",
          objective: "Viewer cannot change this",
          tokenBudget: 100,
        },
      })
    ).status,
  ).toBe(403);
  await fixtureDatabase()
    .prepare(
      "DELETE FROM project_member WHERE organisation_id = ? AND project_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, projectId, outsider.userId)
    .run();
  expect((await requestGoal(outsider.session, null)).status).toBe(404);
  Object.assign(context.task.meta, {
    goalControlEvidence: {
      subscriptionRouteRunsGoalsOnPi: true,
      outsiderDenied: true,
      viewerWriteDeniedAndRevocationApplied: true,
      csrfRequired: true,
      replayStable: true,
      pausedAfterBudgetIncreaseAndEviction: true,
      final: await (await requestGoal(session, null)).json(),
      modelCalls: chatgpt.modelRequestCount(),
    },
  });
}

function requestGoal(
  session: IssuedControlSession,
  command: ChatGoalCommand | null,
  csrf = true,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${CONVERSATION_ID}/goal`,
    {
      method: command === null ? "GET" : "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": csrf ? session.csrfToken : "invalid",
      },
      body: command === null ? undefined : JSON.stringify(command),
    },
  );
}
async function createOutsider(
  client: Awaited<ReturnType<typeof commerceClient>>,
  personId: string,
): Promise<{
  userId: UserId;
  session: IssuedControlSession;
}> {
  const userId = client.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Other operator')",
      )
      .bind(ORGANISATION_ID, personId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'admin', 'active', ?, NULL)",
      )
      .bind(ORGANISATION_ID, userId, personId, Date.now()),
  ]);
  return { userId, session: client.session };
}

async function shareWithViewer(viewer: UserId): Promise<string> {
  const projectId = newProjectId();
  const owner = "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab";
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO project (organisation_id, user_id, project_id, access_kind, access_revision, name, brief, references_json, revision, content_revision, created_at, updated_at) VALUES (?, NULL, ?, 'shared', 1, 'Goal review', '', '[]', 1, 1, ?, ?)",
      )
      .bind(ORGANISATION_ID, projectId, Date.now(), Date.now()),
    fixtureDatabase()
      .prepare("INSERT INTO project_member VALUES (?, ?, ?, 'owner')")
      .bind(ORGANISATION_ID, projectId, owner),
    fixtureDatabase()
      .prepare("INSERT INTO project_member VALUES (?, ?, ?, 'viewer')")
      .bind(ORGANISATION_ID, projectId, viewer),
    fixtureDatabase()
      .prepare(
        "UPDATE case_project SET project_id = ?, revision = revision + 1 WHERE organisation_id = ? AND case_id = (SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?)",
      )
      .bind(projectId, ORGANISATION_ID, ORGANISATION_ID, CONVERSATION_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE portal_conversation SET access_kind = 'shared' WHERE organisation_id = ? AND conversation_id = ?",
      )
      .bind(ORGANISATION_ID, CONVERSATION_ID),
  ]);
  return projectId;
}
