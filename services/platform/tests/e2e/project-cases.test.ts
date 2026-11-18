import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type ProjectId,
  type UserId,
} from "@seams/control-api";
import type { Conversation } from "../../src/chat/conversation";
import { conversationCaseId } from "../../src/chat/conversation-actor-identity";
import { parseSessionId } from "../../src/ids";
import { readConversation, saveConversation } from "../../src/chat/store";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { ensureCaseProject } from "../../src/projects/case-project";
import { requireDefaultProjectId } from "../fixtures/default-project";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { requireCaseId } from "../test-ids";
import { commerceClient } from "./commerce-support";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    projectCases?: Readonly<{
      commandReplayAndConflict: boolean;
      sourceCaseFiledInDefault: boolean;
      sourceCaseMovedWithReceipt: boolean;
      personalDestinationRefused: boolean;
      listingHidesForeignWork: boolean;
      deletionBlockedBySourceCase: boolean;
      defaultReplacedAndEarlierAdmissionPinned: boolean;
      privateChatReturnedToDefaultOnDeletion: boolean;
      chatMoveRefusedWhileRunningAndStaleSaveRefused: boolean;
    }>;
  }
}

const PEER_PERSON_ID = "person_project_cases_peer";
const PROJECTS = `/v1/control/organisations/${ORGANISATION_ID}/projects`;
const CASES = `/v1/control/organisations/${ORGANISATION_ID}/cases`;
const DIRECTORY = `/v1/control/organisations/${ORGANISATION_ID}/chat/projects`;

it(
  "files Cases from every source in one Project model: moves with receipts, a replaceable default, and deletion that orphans nothing",
  projectCasesJourney,
  60_000,
);

async function projectCasesJourney(context: TestContext): Promise<void> {
  // The Slack fixture makes the one account attach of the Organisation. It
  // admits the Slack actor and the peer; both become administrators below.
  const peerClient = await commerceClient("project-cases-peer");
  await installSlackActorFixture({
    privateMember: { client: peerClient, laterPersonId: PEER_PERSON_ID },
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const owner = await promoteSlackActor();
  const peer = await addPeerAdministrator(peerClient);
  const base = await requireDefaultProjectId(
    fixtureDatabase(),
    ORGANISATION_ID,
  );

  // Neither administrator is a member of the default Project, so neither sees it.
  expect(await json(await call(owner, PROJECTS, null))).toEqual({
    defaultProject: { projectId: base, revision: 1 },
    projects: [],
  });

  const launch = newProjectId();
  const create = {
    kind: "create_project",
    operationId: "create-launch",
    projectId: launch,
    content: { name: "Launch", brief: "", references: [] },
  };
  const created = { kind: "accepted", projectId: launch, revision: 1 };
  expect(await json(await call(owner, PROJECTS, create))).toEqual(created);
  expect(await json(await call(owner, PROJECTS, create))).toEqual(created);
  const conflicting = await call(owner, PROJECTS, {
    ...create,
    content: { ...create.content, name: "Another name" },
  });
  expect(conflicting.status).toBe(409);
  expect(await json(conflicting)).toEqual({
    kind: "rejected",
    code: "project_operation_conflict",
  });
  await share(owner, launch, []);

  // A Case a source admits with no named Project is filed in the default.
  const slackCase = requireCaseId(`case_${"a".repeat(32)}`);
  const filed = await ensureCaseProject({
    scope,
    caseId: slackCase,
    origin: "slack",
    now: Date.now(),
  });
  expect(filed).toMatchObject({
    ok: true,
    value: { projectId: base, revision: 1 },
  });
  const casePath = `${CASES}/${slackCase}/project`;
  expect(await json(await call(owner, casePath, null))).toEqual({
    placement: {
      caseId: slackCase,
      projectId: base,
      revision: 1,
      origin: "slack",
    },
  });

  // The Case moves into a shared Project its mover may edit. The move grants
  // the handling agent nothing.
  const move = {
    kind: "move_case",
    operationId: "move-slack-case",
    expectedRevision: 1,
    projectId: launch,
  };
  const moved = {
    kind: "accepted",
    placement: {
      caseId: slackCase,
      projectId: launch,
      revision: 2,
      origin: "slack",
    },
    agentProjectContext: "none",
  };
  expect(await json(await call(owner, casePath, move))).toEqual(moved);
  expect(await json(await call(owner, casePath, move))).toEqual(moved);
  const stale = await call(owner, casePath, {
    ...move,
    operationId: "move-slack-case-stale",
  });
  expect(stale.status).toBe(409);
  expect(await json(stale)).toEqual({
    kind: "rejected",
    code: "case_project_conflict",
  });

  // A personal Project would hide a source's Case from everyone else.
  const personal = newProjectId();
  expect(
    (
      await call(peer, PROJECTS, {
        kind: "create_project",
        operationId: "create-personal",
        projectId: personal,
        content: { name: "My notes", brief: "", references: [] },
      })
    ).status,
  ).toBe(200);
  const hidden = await call(peer, casePath, {
    kind: "move_case",
    operationId: "move-to-personal",
    expectedRevision: 2,
    projectId: personal,
  });
  expect(hidden.status).toBe(409);
  expect(await json(hidden)).toEqual({
    kind: "rejected",
    code: "case_destination_unavailable",
  });
  // Nor may an administrator file it in a Project they cannot read.
  const foreign = await call(peer, `${CASES}/${slackCase}/project`, {
    kind: "move_case",
    operationId: "move-to-unreadable",
    expectedRevision: 2,
    projectId: launch,
  });
  expect(await json(foreign)).toEqual({
    kind: "rejected",
    code: "case_destination_unavailable",
  });

  // The owner's private chat and the source's Case are listed to the owner.
  // Someone who cannot read the Project learns nothing, not even a count.
  const privateChat = newConversationId();
  expect(
    await saveConversation(
      scope,
      owner.userId,
      emptyConversation(privateChat, "Private launch notes"),
      0,
      { projectId: launch },
    ),
  ).toEqual({ kind: "saved" });
  const listed = await json(
    await call(owner, `${PROJECTS}/${launch}/cases`, null),
  );
  expect(listed.cases).toHaveLength(2);
  expect(listed.cases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        caseId: slackCase,
        origin: "slack",
        conversationId: null,
      }),
      expect.objectContaining({
        origin: "portal_chat",
        conversationId: privateChat,
      }),
    ]),
  );
  expect((await call(peer, `${PROJECTS}/${launch}/cases`, null)).status).toBe(
    404,
  );

  // A chat's Case does not move while a turn runs, and a save prepared before
  // a move does not land after it. These two fences are what keep a turn from
  // running against a Project the chat has left.
  const ownerScope = { organisationId: ORGANISATION_ID, userId: owner.userId };
  const moving = newConversationId();
  expect(
    await saveConversation(
      scope,
      owner.userId,
      emptyConversation(moving, "Chat that moves"),
      0,
      { projectId: launch },
    ),
  ).toEqual({ kind: "saved" });
  const fresh = await readConversation(fixtureDatabase(), ownerScope, moving);
  if (fresh === null) throw new Error("Missing chat");
  const chatCasePath = `${CASES}/${await conversationCaseId(fresh.actorIdentity)}/project`;
  const sessionId = parseSessionId(`session_moving_${crypto.randomUUID()}`);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  expect(
    await saveConversation(
      scope,
      owner.userId,
      {
        ...fresh.conversation,
        work: {
          kind: "running",
          requestId: "running_turn",
          lease: "running_turn",
          expiresAt: Date.now() + 60_000,
          stream: {
            step: 0,
            sessionId: sessionId.value,
            turnId: "turn_running",
          },
        },
      },
      fresh.revision,
    ),
  ).toEqual({ kind: "saved" });
  const whileRunning = await call(owner, chatCasePath, {
    kind: "move_case",
    operationId: "move-running-chat",
    expectedRevision: 1,
    projectId: base,
  });
  expect(whileRunning.status).toBe(409);
  expect(await json(whileRunning)).toEqual({
    kind: "rejected",
    code: "case_running",
  });
  const running = await readConversation(fixtureDatabase(), ownerScope, moving);
  if (running === null) throw new Error("Missing running chat");
  expect(running.placement).toMatchObject({
    projectId: launch,
    membershipRevision: 1,
  });
  // A failed turn can be retried and a queued message is sent later, each
  // with the Project context it was admitted under. The chat stays where it
  // is until they are dealt with, whichever command asks to move it.
  expect(
    await saveConversation(
      scope,
      owner.userId,
      {
        ...running.conversation,
        work: {
          kind: "failed",
          requestId: "running_turn",
          error: "The model stopped.",
          recovery: null,
        },
      },
      running.revision,
    ),
  ).toEqual({ kind: "saved" });
  const whileFailed = await call(owner, chatCasePath, {
    kind: "move_case",
    operationId: "move-failed-chat",
    expectedRevision: 1,
    projectId: base,
  });
  expect(whileFailed.status).toBe(409);
  expect(await json(whileFailed)).toEqual({
    kind: "rejected",
    code: "case_work_unfinished",
  });
  const directory = await json(await call(owner, DIRECTORY, null));
  const sidebarMove = await call(owner, DIRECTORY, {
    kind: "move_chat",
    operationId: "sidebar-move-failed-chat",
    expectedDirectoryRevision: directory.revision,
    conversationId: moving,
    expectedMembershipRevision: 1,
    destination: { projectId: base },
    insertion: { kind: "end" },
  });
  expect(sidebarMove.status).toBe(409);
  expect(await json(sidebarMove)).toEqual({
    kind: "rejected",
    code: "chat_work_unfinished",
  });
  const failed = await readConversation(fixtureDatabase(), ownerScope, moving);
  if (failed === null) throw new Error("Missing failed chat");
  expect(
    await saveConversation(
      scope,
      owner.userId,
      {
        ...failed.conversation,
        work: { kind: "ready" },
        pendingInputs: [
          {
            inputId: "queued_input",
            requestId: "queued_request",
            mode: "next",
            parts: [{ kind: "text", text: "Sent after the move was asked" }],
            acceptedAt: Date.now(),
          },
        ],
      },
      failed.revision,
    ),
  ).toEqual({ kind: "saved" });
  const whileQueued = await call(owner, chatCasePath, {
    kind: "move_case",
    operationId: "move-queued-chat",
    expectedRevision: 1,
    projectId: base,
  });
  expect(whileQueued.status).toBe(409);
  expect(await json(whileQueued)).toEqual({
    kind: "rejected",
    code: "case_work_unfinished",
  });
  const queued = await readConversation(fixtureDatabase(), ownerScope, moving);
  if (queued === null) throw new Error("Missing queued chat");
  expect(queued.placement).toMatchObject({
    projectId: launch,
    membershipRevision: 1,
  });
  expect(
    await saveConversation(
      scope,
      owner.userId,
      { ...queued.conversation, pendingInputs: [] },
      queued.revision,
    ),
  ).toEqual({ kind: "saved" });
  const idle = await readConversation(fixtureDatabase(), ownerScope, moving);
  if (idle === null) throw new Error("Missing idle chat");
  expect(
    await json(
      await call(owner, chatCasePath, {
        kind: "move_case",
        operationId: "move-idle-chat",
        expectedRevision: 1,
        projectId: base,
      }),
    ),
  ).toMatchObject({
    kind: "accepted",
    placement: { projectId: base, revision: 2, origin: "portal_chat" },
  });
  expect(
    await saveConversation(
      scope,
      owner.userId,
      { ...idle.conversation, title: "Prepared before the move" },
      idle.revision,
    ),
  ).toEqual({ kind: "conflict" });

  // A Project that still holds a source's Case is not deleted.
  const remove = {
    kind: "delete_project",
    operationId: "delete-launch",
    projectId: launch,
    expectedProjectRevision: 1,
    expectedAccessRevision: 1,
  };
  const blocked = await call(owner, PROJECTS, remove);
  expect(blocked.status).toBe(409);
  expect(await json(blocked)).toEqual({
    kind: "rejected",
    code: "project_contains_cases",
  });

  // Replacing the default changes where later work goes and moves nothing.
  const earlier = requireCaseId(`case_${"b".repeat(32)}`);
  await ensureCaseProject({
    scope,
    caseId: earlier,
    origin: "email",
    now: Date.now(),
  });
  const ineligible = await call(peer, PROJECTS, {
    kind: "set_default_project",
    operationId: "default-personal",
    projectId: personal,
    expectedDefaultRevision: 1,
  });
  expect(await json(ineligible)).toEqual({
    kind: "rejected",
    code: "default_project_ineligible",
  });
  const successor = newProjectId();
  expect(
    (
      await call(owner, PROJECTS, {
        kind: "create_project",
        operationId: "create-successor",
        projectId: successor,
        content: { name: "Operations", brief: "", references: [] },
      })
    ).status,
  ).toBe(200);
  await share(owner, successor, []);
  expect(
    await json(
      await call(owner, PROJECTS, {
        kind: "set_default_project",
        operationId: "default-successor",
        projectId: successor,
        expectedDefaultRevision: 1,
      }),
    ),
  ).toEqual({ kind: "accepted", projectId: successor, revision: 2 });
  expect(await json(await call(owner, PROJECTS, null))).toMatchObject({
    defaultProject: { projectId: successor, revision: 2 },
  });
  // A retried admission reads the Project it was first filed in.
  expect(
    await ensureCaseProject({
      scope,
      caseId: earlier,
      origin: "email",
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { projectId: base, revision: 1 } });
  const later = requireCaseId(`case_${"c".repeat(32)}`);
  expect(
    await ensureCaseProject({
      scope,
      caseId: later,
      origin: "whatsapp",
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { projectId: successor, revision: 1 } });
  const designated = await call(owner, PROJECTS, {
    kind: "delete_project",
    operationId: "delete-default",
    projectId: successor,
    expectedProjectRevision: 1,
    expectedAccessRevision: 1,
  });
  expect(await json(designated)).toEqual({
    kind: "rejected",
    code: "project_is_default",
  });

  // Once the source's Case has moved on, the Project is deleted. The private
  // chat it held returns to the default Project and stays its owner's alone.
  expect(
    (
      await call(owner, casePath, {
        kind: "move_case",
        operationId: "move-slack-case-on",
        expectedRevision: 2,
        projectId: successor,
      })
    ).status,
  ).toBe(200);
  expect(await json(await call(owner, PROJECTS, remove))).toEqual({
    kind: "accepted",
    projectId: launch,
    revision: 1,
  });
  const returned = await readConversation(
    fixtureDatabase(),
    { organisationId: ORGANISATION_ID, userId: owner.userId },
    privateChat,
  );
  expect(returned?.placement).toMatchObject({
    projectId: successor,
    membershipRevision: 2,
  });
  expect(returned?.sharing.visibility).toBe("private");
  expect(
    await readConversation(
      fixtureDatabase(),
      { organisationId: ORGANISATION_ID, userId: peer.userId },
      privateChat,
    ),
  ).toBeNull();
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT COUNT(*) AS orphans FROM case_project cp WHERE cp.organisation_id = ? AND NOT EXISTS (SELECT 1 FROM project p WHERE p.organisation_id = cp.organisation_id AND p.project_id = cp.project_id)",
      )
      .bind(ORGANISATION_ID)
      .first("orphans"),
  ).toBe(0);

  Object.assign(context.task.meta, {
    projectCases: {
      commandReplayAndConflict: true,
      sourceCaseFiledInDefault: true,
      sourceCaseMovedWithReceipt: true,
      personalDestinationRefused: true,
      listingHidesForeignWork: true,
      deletionBlockedBySourceCase: true,
      defaultReplacedAndEarlierAdmissionPinned: true,
      privateChatReturnedToDefaultOnDeletion: true,
      chatMoveRefusedWhileRunningAndStaleSaveRefused: true,
    },
  });
}

type Administrator = Readonly<{
  userId: UserId;
  session: IssuedControlSession;
}>;

async function promoteSlackActor(): Promise<Administrator> {
  const actor = await commerceClient("e2e-slack-actor");
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, actor.identity.userId)
    .run();
  return { userId: actor.identity.userId, session: actor.session };
}

async function addPeerAdministrator(
  peer: Awaited<ReturnType<typeof commerceClient>>,
): Promise<Administrator> {
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Unrelated administrator')",
      )
      .bind(ORGANISATION_ID, PEER_PERSON_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
      VALUES (?, ?, ?, 'admin', 'active', ?, NULL)`,
      )
      .bind(ORGANISATION_ID, peer.identity.userId, PEER_PERSON_ID, Date.now()),
  ]);
  return { userId: peer.identity.userId, session: peer.session };
}

// Makes a personal Project shared, owned by the administrator who made it.
async function share(
  owner: Administrator,
  projectId: ProjectId,
  members: readonly Readonly<{ userId: UserId; role: string }>[],
): Promise<void> {
  const response = await call(owner, `${PROJECTS}/${projectId}/access`, {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members,
  });
  expect(await json(response)).toEqual({ kind: "accepted", accessRevision: 1 });
}

function call(
  actor: Administrator,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      origin: "https://localhost",
      cookie: `satyr_control_session=${actor.session.token}; satyr_control_csrf=${actor.session.csrfToken}`,
      "x-satyr-csrf": actor.session.csrfToken,
      "content-type": "application/json",
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json<Record<string, unknown>>();
}

function emptyConversation(id: ConversationId, title: string): Conversation {
  return {
    id,
    title,
    lineage: { kind: "original" },
    historyBindings: [],
    modelRoute: {
      keySource: "platform",
      provider: "openai-compatible",
      model: "fixture",
    },
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs: [],
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: null,
  };
}
