import { env, exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { saveConversation } from "../../src/chat/store";
import { createAccessGrant } from "../../src/data/access-grants";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { newConversationId, newProjectId } from "@purin-labs/control-api";
import type { UserId } from "@purin-labs/control-api/ids";
import { requireDefaultProjectId } from "../fixtures/default-project";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { platformConversation } from "./chat-journey-support";
import { commerceClient } from "./commerce-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
  openRouterText,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    memberRemovalAccess?: Record<string, unknown>;
  }
}

const MODEL = "moonshotai/kimi-k3";

// Plan 95 step 1, journey J3. Pantry decides access from its own member
// records. When an owner removes a member, that member's next message is
// refused at once, and the member's private chats go back to the default
// Project.
it(
  "refuses the next message of a removed member and returns the member's private chats to the default Project",
  memberRemovalJourney,
  60_000,
);

type Member = Readonly<{
  userId: UserId;
  personId: string;
  session: IssuedControlSession;
}>;

async function memberRemovalJourney(context: TestContext): Promise<void> {
  const joining = await commerceClient(`removal-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  const { ownerSession } = await installSlackActorFixture({
    extraMembers: [{ client: joining, laterPersonId: personId }],
  });
  const member = await addAdmin(joining, personId);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_removal', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const model = countingModel();
  network.use(model.handler);

  // The member keeps a private chat in a Project of their own.
  const projectId = newProjectId();
  const created = await post(
    member.session,
    `/v1/control/organisations/${ORGANISATION_ID}/projects`,
    {
      kind: "create_project",
      operationId: crypto.randomUUID(),
      projectId,
      content: {
        name: "Spring menu",
        brief: "Notes for the spring menu.",
        references: [],
      },
    },
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const conversationId = newConversationId();
  const saved = await saveConversation(
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    member.userId,
    platformConversation(conversationId, "Spring menu notes", MODEL),
    0,
    { projectId },
  );
  expect(saved.kind).toBe("saved");

  // Before the removal, the member's message runs.
  const first = await send(member, conversationId, "removal_first");
  expect(first.status, await first.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, member, conversationId), { timeout: 20_000 })
    .toBe("ready");
  expect(model.calls()).toBe(1);

  // The owner removes the member while the chat is open.
  const removed = await removeMember(ownerSession, member.userId);
  expect(removed.status, await removed.clone().text()).toBe(200);

  // Denied: the next message of the removed member starts no turn.
  const refused = await send(member, conversationId, "removal_after");
  expect(refused.status).toBe(404);
  const refusal: unknown = await refused.json();
  expect(refusal).toMatchObject({ ok: false });
  // Denied: the member can no longer read the chat either.
  const read = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${conversationId}`,
    { headers: headers(member.session) },
  );
  expect(read.status).toBe(404);
  expect(model.calls()).toBe(1);

  // The private chat is in the default Project, and the member is in no
  // Project of the Organisation.
  const defaultProjectId = await requireDefaultProjectId(
    fixtureDatabase(),
    ORGANISATION_ID,
  );
  const filed = await fixtureDatabase()
    .prepare(
      `SELECT cp.project_id AS projectId FROM portal_conversation c
       JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
       WHERE c.organisation_id = ? AND c.conversation_id = ?`,
    )
    .bind(ORGANISATION_ID, conversationId)
    .first<{ projectId: string }>();
  expect(filed?.projectId).toBe(defaultProjectId);
  const projects = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM project_member WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, member.userId)
    .first<{ count: number }>();
  expect(projects?.count).toBe(0);

  context.task.meta.memberRemovalAccess = {
    firstMessage: first.status,
    removal: removed.status,
    messageAfterRemoval: { status: refused.status, body: refusal },
    readAfterRemoval: read.status,
    modelCalls: model.calls(),
    privateChatProject:
      filed?.projectId === defaultProjectId ? "default" : filed?.projectId,
    projectMemberships: projects?.count,
  };
}

/** A person joins as an admin, who may use the Portal chat. */
async function addAdmin(
  joining: Awaited<ReturnType<typeof commerceClient>>,
  personId: string,
): Promise<Member> {
  const userId = joining.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Removed admin')",
      )
      .bind(ORGANISATION_ID, personId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      )
      .bind(ORGANISATION_ID, userId, personId, Date.now()),
  ]);
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: `grant_${userId}`,
    subject: { kind: "person", personId },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_removal",
    },
    now: Date.now(),
  });
  if (!grant.ok) throw new Error(grant.error.code);
  return { userId, personId, session: joining.session };
}

async function removeMember(
  owner: IssuedControlSession,
  userId: UserId,
): Promise<Response> {
  const version = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  const request = headers(owner);
  request.set("idempotency-key", `removal-${crypto.randomUUID()}`);
  request.set("x-satyr-configuration-version", String(version));
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/members/${userId}`,
    { method: "DELETE", headers: request, body: "{}" },
  );
}

function send(
  member: Member,
  conversationId: ReturnType<typeof newConversationId>,
  requestId: string,
): Promise<Response> {
  return post(
    member.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      kind: "message",
      conversationId,
      requestId,
      model: MODEL,
      text: "Add rhubarb tart to the notes.",
      surfaceContext: null,
      browserContext: { kind: "unavailable" },
    },
  );
}

async function workKind(
  member: Member,
  conversationId: ReturnType<typeof newConversationId>,
): Promise<string | null> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${conversationId}&observe=true`,
    { headers: headers(member.session) },
  );
  const body: unknown = await response.json();
  return isRecord(body) &&
    isRecord(body.conversation) &&
    isRecord(body.conversation.work) &&
    typeof body.conversation.work.kind === "string"
    ? body.conversation.work.kind
    : null;
}

function post(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: headers(session),
    body: JSON.stringify(body),
  });
}

function headers(session: IssuedControlSession): Headers {
  return new Headers({
    origin: "https://localhost",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
    "content-type": "application/json",
  });
}

function countingModel(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }: Parameters<HttpResponseResolver>[0]) => {
        await request.json();
        calls += 1;
        return openRouterText(
          JSON.stringify({
            kind: "reply",
            text: "Rhubarb tart is in the notes.",
          }),
          `removal_${String(calls)}`,
        );
      },
    ),
  };
}
