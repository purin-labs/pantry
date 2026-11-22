import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { COLLABORATION_PONG } from "@purin-labs/collaboration";
import {
  CHAT_SIGNAL,
  newConversationId,
  newProjectId,
  parseChatSignal,
  type ChatSignal,
  type ConversationId,
} from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { saveConversation } from "../../src/chat/store";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { parseActorFenceToken } from "../../src/actors/actor-registry";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { newActorExportId } from "../../src/actors/actor-export";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import {
  requireOrganisationBootstrap,
  requireOrganisationExecutionScope,
} from "../organisation-execution-fixture";
import {
  PUBLIC_ORIGIN,
  SOCKET_MOVED_CODE,
  closeSocket,
  createControlClient,
  dueSocketSweepNow,
  expectPong,
  nextCloseCode,
  openSocket,
  type ControlClient,
} from "./hibernatable-socket-support";
import { control, platformConversation } from "./chat-journey-support";
import { requiredPlacement } from "./slack-journey-support";

// A signal that has not come within this time does not come.
const QUIET_MS = 750;
const CHANGED: ChatSignal = { kind: CHAT_SIGNAL };

it(
  "signals shared chat changes to each member's open page, survives a sleeping Organisation, and stops at revoked access",
  chatSignalJourney,
);

async function chatSignalJourney(): Promise<void> {
  const scenario = await installChatScenario();
  const { organisationId, owner, teammate } = scenario;
  const ownerPage = await openSignalSocket(organisationId, owner.session);
  let teammatePage = await openSignalSocket(organisationId, teammate.session);
  try {
    // The owner shares a Project with the teammate. Project membership
    // decides who sees its chats, so every open page hears it.
    const projectId = newProjectId();
    await fixtureDatabase()
      .prepare(
        `INSERT INTO project
        (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
       VALUES (?, ?, ?, 'Morning bake', '', '[]', 1, 1, ?, ?)`,
      )
      .bind(
        organisationId,
        owner.identity.userId,
        projectId,
        Date.now(),
        Date.now(),
      )
      .run();
    const sharedProject = nextSignal(teammatePage);
    expect(
      (
        await control(
          organisationId,
          owner.session,
          `projects/${projectId}/access`,
          "POST",
          {
            kind: "share_project",
            operationId: crypto.randomUUID(),
            expectedAccessRevision: 0,
            members: [{ userId: teammate.identity.userId, role: "editor" }],
          },
        )
      ).status,
    ).toBe(200);
    expect(await sharedProject).toEqual(CHANGED);

    // A private conversation of the owner never signals the teammate.
    const conversationId = newConversationId();
    const ownerHeard = nextSignal(ownerPage);
    const teammateSilent = noSignal(teammatePage);
    expect(
      (
        await saveConversation(
          await requireOrganisationExecutionScope(env, organisationId),
          owner.identity.userId,
          platformConversation(conversationId, "Proof schedule"),
          0,
          { projectId },
        )
      ).kind,
    ).toBe("saved");
    expect(await ownerHeard).toEqual(CHANGED);
    await teammateSilent;

    // The owner shares the conversation into the Project.
    const shared = nextSignal(teammatePage);
    expect(
      (
        await control(
          organisationId,
          owner.session,
          `chat/conversations/${conversationId}/access`,
          "POST",
          {
            kind: "share_conversation",
            operationId: crypto.randomUUID(),
            projectId,
            expectedRevision: 1,
            expectedProjectAccessRevision: 1,
          },
        )
      ).status,
    ).toBe(200);
    expect(await shared).toEqual(CHANGED);
    expect(
      await readTitle(organisationId, teammate.session, conversationId),
    ).toBe("Proof schedule");

    // The Organisation leaves memory and the pages stay connected. The next
    // change still reaches the teammate, who reads the new title.
    await evictDurableObject(scenario.organisation);
    await expectPong(teammatePage);
    const renamed = nextSignal(teammatePage);
    await rename(
      organisationId,
      owner.session,
      conversationId,
      "Proof and bake schedule",
      2,
    );
    expect(await renamed).toEqual(CHANGED);
    expect(
      await readTitle(organisationId, teammate.session, conversationId),
    ).toBe("Proof and bake schedule");

    // The teammate's connection drops and a change happens meanwhile. After
    // the reconnect, one read shows the same state as the owner's page.
    await closeSocket(teammatePage);
    await rename(
      organisationId,
      owner.session,
      conversationId,
      "Bake schedule",
      3,
    );
    teammatePage = await openSignalSocket(organisationId, teammate.session);
    expect(
      await readTitle(organisationId, teammate.session, conversationId),
    ).toBe(await readTitle(organisationId, owner.session, conversationId));

    // The owner removes the teammate from the Project while the page is
    // open. The page hears that its directory changed, gets no signal for
    // the conversation after that, and its next read shows no conversation.
    const removed = nextSignal(teammatePage);
    expect(
      (
        await control(
          organisationId,
          owner.session,
          `projects/${projectId}/access`,
          "POST",
          {
            kind: "remove_project_member",
            operationId: crypto.randomUUID(),
            expectedAccessRevision: 1,
            userId: teammate.identity.userId,
          },
        )
      ).status,
    ).toBe(200);
    expect(await removed).toEqual(CHANGED);
    const ownerStillHears = nextSignal(ownerPage);
    const removedSilent = noSignal(teammatePage);
    await rename(
      organisationId,
      owner.session,
      conversationId,
      "Owner's schedule",
      4,
    );
    expect(await ownerStillHears).toEqual(CHANGED);
    await removedSilent;
    expect(
      await readTitle(organisationId, teammate.session, conversationId),
    ).toBeNull();

    // The teammate loses the Organisation role. The next sweep closes the
    // page's socket for revoked access and keeps the owner's page.
    await fixtureDatabase()
      .prepare(
        `UPDATE service_role_grant SET status = 'revoked', revoked_at = ?
        WHERE organisation_id = ? AND user_id = ?`,
      )
      .bind(Date.now(), organisationId, teammate.identity.userId)
      .run();
    const closed = nextCloseCode(teammatePage);
    await runInDurableObject(scenario.organisation, dueSocketSweepNow);
    expect(await runDurableObjectAlarm(scenario.organisation)).toBe(true);
    expect(await closed).toBe(4403);
    await expectPong(ownerPage);

    // The Organisation moves to another placement. Its Actor closes the
    // owner's page socket with a retryable code, so the page reconnects to
    // the Actor that serves the Organisation next.
    const registry = await fixtureDatabase()
      .prepare(
        `SELECT fence_token FROM durable_object_registry
        WHERE organisation_id = ? AND object_kind = 'organisation' AND lifecycle_status = 'active'`,
      )
      .bind(organisationId)
      .first<{ fence_token: unknown }>();
    const fence = parseActorFenceToken(registry?.fence_token);
    if (!fence.ok) throw new Error(fence.error.code);
    const moved = nextCloseCode(ownerPage);
    expect(
      await scenario.organisation.exportPlacementState({
        expectedFenceToken: fence.value,
        exportId: newActorExportId(),
        requestedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });
    expect(await moved).toBe(SOCKET_MOVED_CODE);
  } finally {
    await Promise.all([ownerPage, teammatePage].map(closeSocket));
  }
}

async function installChatScenario(): Promise<
  Readonly<{
    organisationId: OrganisationId;
    owner: ControlClient;
    teammate: ControlClient;
    organisation: DurableObjectStub<OrganisationDO>;
  }>
> {
  const now = Date.now() - 1_000;
  const owner = await createControlClient("chat-signals-owner", "Signal Owner");
  const teammate = await createControlClient(
    "chat-signals-teammate",
    "Signal Teammate",
  );
  const created = await requireOrganisationBootstrap({
    env,
    owner: owner.identity,
    organisationName: "Chat signals",
    environment: "development",
    placement: requiredPlacement(),
    mutation: organisationBootstrapMutation(owner.identity, now),
    now,
  });
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(
        created.organisationId,
        "person_chat_signals_teammate",
        teammate.identity.displayName,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant
        (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, 'admin', 'active', ?, NULL)`,
      )
      .bind(
        created.organisationId,
        teammate.identity.userId,
        "person_chat_signals_teammate",
        now,
      ),
  ]);
  await ensureCreatedOrganisationActor({
    env,
    organisationId: created.organisationId,
    now,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: created.organisationId,
    now,
  });
  return {
    organisationId: created.organisationId,
    owner,
    teammate,
    organisation,
  };
}

function openSignalSocket(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<WebSocket> {
  return openSocket(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/chat/signals`,
    session,
  );
}

async function rename(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  conversationId: ConversationId,
  title: string,
  expectedRevision: number,
): Promise<void> {
  const response = await control(
    organisationId,
    session,
    `chat/conversations/${conversationId}`,
    "PATCH",
    { action: "rename", title, expectedRevision },
  );
  expect(response.status).toBe(200);
}

async function readTitle(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  conversationId: ConversationId,
): Promise<string | null> {
  const response = await control(
    organisationId,
    session,
    `chat?observe=true&conversation=${conversationId}`,
    "GET",
    null,
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("conversation" in body))
    throw new Error("chat read has no conversation field");
  const conversation = body.conversation;
  if (conversation === null) return null;
  if (
    typeof conversation !== "object" ||
    !("title" in conversation) ||
    typeof conversation.title !== "string"
  )
    throw new Error("chat read has no title");
  return conversation.title;
}

function nextSignal(socket: WebSocket): Promise<ChatSignal> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.data === COLLABORATION_PONG) return;
      const signal = parseChatSignal(event.data);
      if (signal === null) return;
      socket.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(signal);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("chat signal did not arrive"));
    }, 5_000);
    socket.addEventListener("message", onMessage);
  });
}

function noSignal(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.data === COLLABORATION_PONG) return;
      socket.removeEventListener("message", onMessage);
      clearTimeout(timer);
      reject(new Error(`unexpected chat signal: ${String(event.data)}`));
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve();
    }, QUIET_MS);
    socket.addEventListener("message", onMessage);
  });
}
