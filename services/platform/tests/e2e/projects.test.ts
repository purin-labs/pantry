import type {
  OrganisationDatabase,
  OrganisationStatement,
} from "../../src/database-handles";
import {
  shareConversation,
  type ConversationSharingCommand,
} from "../../src/chat/conversation-sharing";
import { fixtureDatabase } from "./organisation-database";
import { mutateProjectAccess } from "../../src/projects/membership";
import { deleteArchivedChat } from "../../src/chat/deletion";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import { admitTurn } from "../../src/chat/turn/admission";
import { resumeConversationExecution } from "../../src/chat/application";
import * as modelRoutes from "../../src/models/route";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { resolveActiveCaseActor } from "../../src/actors/actor-router";
import { parseChatCommand } from "../../src/chat/conversation";
import {
  bindConversationProjectSnapshot,
  projectSnapshotFromParts,
  storedProjectPlacement,
} from "../../src/chat/project-context-binding";
import { requireDefaultProjectId } from "../fixtures/default-project";
import { prepareProjectSnapshot } from "../../src/projects/context";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi, type TestContext } from "vitest";
import {
  mutateChatDirectory,
  readProjectDirectory,
} from "../../src/chat/projects";
import { mutateProject } from "../../src/projects/commands";
import { isRecord } from "@purin-labs/std";
import {
  parseChatPlacement,
  parseProjectCommand,
  type ChatDirectoryCommand,
  type ProjectCommand,
  type ProjectAccessCommand,
  type ProjectId,
  type ConversationId,
  parseConversationId,
  newUserId,
} from "@purin-labs/control-api";
import { requireProjectId } from "../test-ids";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "@purin-labs/control-api/ids";
import { resolveOrganisationModelRoute } from "../../src/models/route";
import {
  readConversation,
  reconcileRevokedConversationRun,
  readConversationForExecution,
  saveConversation,
  updateConversationMetadata,
  type ConversationScope,
} from "../../src/chat/store";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

it(
  "organizes an owned directory atomically, preserving unseen chats and fencing competing tabs and retries",
  directoryJourney,
);

async function directoryJourney(context: TestContext): Promise<void> {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 61);
  const directory = await projectRequest(fixture.session, "GET", null);
  expect(directory.status).toBe(200);
  const raw = await directory.json();
  if (!isRecord(raw) || typeof raw.revision !== "number")
    throw new Error("Missing directory");
  const create: ProjectCommand = {
    kind: "create_project",
    projectId: requireProjectId("project_2d912df0-930f-5fbb-93b5-b3746e99b40b"),
    operationId: "create-project_2d912df0-930f-5fbb-93b5-b3746e99b40b",
    content: {
      name: "Bakery capacity",
      brief: "Plan cold-tray handoff",
      references: [],
    },
  };
  const accepted = await projectCommandRequest(fixture.session, create);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({
    kind: "accepted",
    projectId: create.projectId,
    revision: 1,
  });
  // A retry reads the recorded outcome and leaves every sidebar as it was.
  expect(
    await (await projectCommandRequest(fixture.session, create)).json(),
  ).toEqual({ kind: "accepted", projectId: create.projectId, revision: 1 });
  expect(
    (await readProjectDirectory(fixtureDatabase(), fixture.scope)).revision,
  ).toBe(raw.revision + 1);
  const beforeMove = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    "conv_00000000-0000-4000-8000-000000000000",
  );
  if (beforeMove === null) throw new Error("Missing original chat");
  const prepared = await prepareProjectSnapshot(
    env,
    await requireOrganisationExecutionScope(env, fixture.scope.organisationId),
    fixture.scope,
    storedProjectPlacement(beforeMove),
  );
  const parsed = parseChatCommand({
    kind: "message",
    conversationId: fixtureConversationId(0),
    requestId: "stale_preparation",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Keep this literal task request.",
    browserContext: { kind: "unavailable" },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const lateAdmission = await admitTurn(
    beforeMove,
    parsed.value,
    beforeMove.conversation.modelRoute,
    fixture.scope,
  );
  if (!lateAdmission.ok) throw new Error(lateAdmission.code);
  const stale = bindConversationProjectSnapshot(
    lateAdmission.conversation,
    "stale_preparation",
    prepared,
  );
  const move: Extract<ChatDirectoryCommand, { kind: "move_chat" }> = {
    kind: "move_chat",
    operationId: "move-first",
    expectedDirectoryRevision: raw.revision + 1,
    conversationId: fixtureConversationId(0),
    expectedMembershipRevision: 1,
    destination: {
      projectId: requireProjectId(
        "project_2d912df0-930f-5fbb-93b5-b3746e99b40b",
      ),
    },
    insertion: { kind: "end" },
  };
  const simultaneousMoves = await Promise.all([
    projectRequest(fixture.session, "POST", move),
    projectRequest(fixture.session, "POST", move),
  ]);
  for (const response of simultaneousMoves) {
    expect(await response.json()).toEqual({
      kind: "accepted",
      directoryRevision: raw.revision + 2,
    });
    expect(response.status).toBe(200);
  }
  expect(
    (
      await projectRequest(fixture.session, "POST", {
        ...move,
        operationId: "competing-move",
        conversationId: fixtureConversationId(60),
      })
    ).status,
  ).toBe(409);
  const placement = await fixtureDatabase()
    .prepare(
      "SELECT cp.project_id, cp.revision AS membership_revision, u.manual_position FROM portal_conversation c JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id JOIN portal_conversation_user u ON u.organisation_id = c.organisation_id AND u.conversation_id = c.conversation_id AND u.user_id = c.user_id WHERE c.conversation_id = 'conv_00000000-0000-4000-8000-000000000000'",
    )
    .first();
  expect(placement).toMatchObject({
    project_id: "project_2d912df0-930f-5fbb-93b5-b3746e99b40b",
    membership_revision: 2,
  });
  const moved = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    "conv_00000000-0000-4000-8000-000000000000",
  );
  if (moved === null) throw new Error("Missing moved chat");
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(
          env,
          fixture.scope.organisationId,
        ),
        fixture.scope.userId,
        stale,
        moved.revision,
      )
    ).kind,
  ).toBe("conflict");
  const noOp: ChatDirectoryCommand = {
    ...move,
    operationId: "same-place",
    expectedDirectoryRevision: raw.revision + 2,
    expectedMembershipRevision: 2,
  };
  expect(
    await (await projectRequest(fixture.session, "POST", noOp)).json(),
  ).toEqual({ kind: "accepted", directoryRevision: raw.revision + 2 });
  const unseen = await projectRequest(fixture.session, "POST", {
    ...move,
    operationId: "move-unseen",
    expectedDirectoryRevision: raw.revision + 2,
    conversationId: fixtureConversationId(60),
    insertion: { kind: "before", conversationId: fixtureConversationId(0) },
  });
  expect(unseen.status).toBe(200);
  const rows = await fixtureDatabase()
    .prepare(
      "SELECT c.conversation_id FROM portal_conversation c JOIN portal_conversation_user u ON u.organisation_id = c.organisation_id AND u.conversation_id = c.conversation_id AND u.user_id = c.user_id JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id WHERE cp.project_id = 'project_2d912df0-930f-5fbb-93b5-b3746e99b40b' ORDER BY u.manual_position",
    )
    .all();
  expect(rows.results).toEqual([
    { conversation_id: "conv_00000000-0000-4000-8000-000000000060" },
    { conversation_id: "conv_00000000-0000-4000-8000-000000000000" },
  ]);
  expect(
    await fixtureDatabase()
      .prepare("SELECT COUNT(*) AS count FROM portal_conversation")
      .first("count"),
  ).toBe(61);
  expect(
    parseProjectCommand({
      ...move,
      destination: {
        kind: "project",
        projectId: requireProjectId(
          "project_2d912df0-930f-5fbb-93b5-b3746e99b40b",
        ),
      },
    }),
  ).toBeNull();
  expect(parseChatPlacement({ position: 1, membershipRevision: 1 })).toBeNull();
  await verifyQueuedProjectBinding(fixture.scope);
  const firstPage = await chatApiRequest(
    fixture.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat`,
    "GET",
    null,
  );
  const first = await firstPage.json();
  if (
    !isRecord(first) ||
    typeof first.nextActiveCursor !== "string" ||
    !Array.isArray(first.conversations)
  )
    throw new Error("Missing directory cursor");
  expect(first.conversations.length).toBe(50);
  const selectedPage = await chatApiRequest(
    fixture.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=conv_00000000-0000-4000-8000-000000000009`,
    "GET",
    null,
  );
  expect(await selectedPage.json()).toMatchObject({
    nextActiveCursor: first.nextActiveCursor,
    conversations: expect.arrayContaining([
      expect.objectContaining({
        id: "conv_00000000-0000-4000-8000-000000000009",
      }),
    ]),
  });
  const nextPage = await chatApiRequest(
    fixture.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat?activeAfter=${first.nextActiveCursor}`,
    "GET",
    null,
  );
  expect(await nextPage.json()).toMatchObject({
    nextActiveCursor: null,
    conversations: expect.any(Array),
  });
  const path = `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/conv_00000000-0000-4000-8000-000000000000`;
  await chatApiRequest(fixture.session, path, "PATCH", { action: "pin" });
  const archived = await chatApiRequest(fixture.session, path, "PATCH", {
    action: "archive",
    expectedRevision: 2,
  });
  expect(archived.status).toBe(200);
  const archiveBody = await archived.json();
  if (!isRecord(archiveBody) || !isRecord(archiveBody.conversation))
    throw new Error("Missing archive result");
  expect(archiveBody.conversation.pinnedAt).toEqual(expect.any(Number));
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "restore",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(200);
  const restored = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    "conv_00000000-0000-4000-8000-000000000000",
  );
  if (restored === null) throw new Error("Missing restored chat");
  expect(restored.placement).toMatchObject({
    projectId: requireProjectId("project_2d912df0-930f-5fbb-93b5-b3746e99b40b"),
    membershipRevision: 2,
  });
  expect(restored.metadata.pinnedAt).toBe(archiveBody.conversation.pinnedAt);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "rename",
        title: "Accepted production plan",
        expectedRevision: restored.revision,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "restore",
        expectedRevision: archiveBody.conversation.revision,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "delete",
        operationId: "delete-active",
        expectedRevision: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "archive",
        expectedRevision: 3,
      })
    ).status,
  ).toBe(200);
  const deletion = {
    action: "delete",
    operationId: "delete-archived",
    expectedRevision: 3,
  };
  expect(
    (await chatApiRequest(fixture.session, path, "PATCH", deletion)).status,
  ).toBe(200);
  expect(
    (await chatApiRequest(fixture.session, path, "PATCH", deletion)).status,
  ).toBe(200);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "restore",
        expectedRevision: 3,
      })
    ).status,
  ).toBe(404);
  expect(
    await readConversation(
      fixtureDatabase(),
      fixture.scope,
      "conv_00000000-0000-4000-8000-000000000000",
    ),
  ).toBeNull();
  expect(
    await saveConversation(
      await requireOrganisationExecutionScope(
        env,
        fixture.scope.organisationId,
      ),
      fixture.scope.userId,
      restored.conversation,
      0,
    ),
  ).toEqual({ kind: "conflict" });
  const organizedDirectory = await readProjectDirectory(
    fixtureDatabase(),
    fixture.scope,
  );
  const archivedPagination = await verifyArchivedPagination(
    fixture.scope,
    fixture.session,
  );
  Object.assign(context.task.meta, {
    projectDirectoryEvidence: {
      initialRevision: raw.revision,
      organizedDirectory,
      finalDirectory: await readProjectDirectory(
        fixtureDatabase(),
        fixture.scope,
      ),
      movedPlacement: placement,
      acceptedProjectOrder: rows.results,
      paginatedChats: 61,
      selectedOutsideFirstPage: true,
      stalePreparationFenced: true,
      queuedBindingPreserved: true,
      competingMutationRejected: true,
      restoreAfterRenameIdempotent: true,
      deletionCannotResurrect: true,
      archivedPagination,
    },
  });
}

async function verifyArchivedPagination(
  scope: ConversationScope,
  session: IssuedControlSession,
): Promise<
  Readonly<{
    total: number;
    pageSizes: readonly number[];
    selectedOutsideFirstPage: boolean;
    pinnedProjectRestored: boolean;
  }>
> {
  const path = `/v1/control/organisations/${ORGANISATION_ID}/chat`;
  const pinnedPath = `${path}/conversations/conv_00000000-0000-4000-8000-000000000060`;
  expect(
    (await chatApiRequest(session, pinnedPath, "PATCH", { action: "pin" }))
      .status,
  ).toBe(200);
  const pinned = await readConversation(
    fixtureDatabase(),
    scope,
    "conv_00000000-0000-4000-8000-000000000060",
  );
  if (pinned === null) throw new Error("Missing pinned project chat");
  for (let index = 1; index < 61; index += 1) {
    const id = fixtureConversationId(index);
    const stored = await readConversation(fixtureDatabase(), scope, id);
    if (stored === null) throw new Error("Missing archive candidate");
    expect(
      (
        await chatApiRequest(session, `${path}/conversations/${id}`, "PATCH", {
          action: "archive",
          expectedRevision: stored.revision,
        })
      ).status,
    ).toBe(200);
  }
  const first: unknown = await (
    await chatApiRequest(session, path, "GET", null)
  ).json();
  if (
    !isRecord(first) ||
    !Array.isArray(first.archivedConversations) ||
    typeof first.nextArchivedCursor !== "string"
  )
    throw new Error("Missing archived directory cursor");
  expect(first.archivedConversations).toHaveLength(50);
  const selected: unknown = await (
    await chatApiRequest(
      session,
      `${path}?conversation=conv_00000000-0000-4000-8000-000000000001`,
      "GET",
      null,
    )
  ).json();
  expect(selected).toMatchObject({
    nextArchivedCursor: first.nextArchivedCursor,
    archivedConversations: expect.arrayContaining([
      expect.objectContaining({
        id: "conv_00000000-0000-4000-8000-000000000001",
        lifecycle: "archived",
      }),
    ]),
  });
  const second: unknown = await (
    await chatApiRequest(
      session,
      `${path}?archivedAfter=${encodeURIComponent(first.nextArchivedCursor)}`,
      "GET",
      null,
    )
  ).json();
  if (!isRecord(second) || !Array.isArray(second.archivedConversations))
    throw new Error("Missing second archive page");
  expect(second.nextArchivedCursor).toBeNull();
  expect(second.archivedConversations).toHaveLength(10);
  const ids = new Set(
    [...first.archivedConversations, ...second.archivedConversations].map(
      readArchivedId,
    ),
  );
  expect(ids.size).toBe(60);
  const archived = await readConversation(
    fixtureDatabase(),
    scope,
    "conv_00000000-0000-4000-8000-000000000060",
  );
  if (archived === null) throw new Error("Missing pinned archive");
  expect(
    (
      await chatApiRequest(session, pinnedPath, "PATCH", {
        action: "restore",
        expectedRevision: archived.revision,
      })
    ).status,
  ).toBe(200);
  const restored = await readConversation(
    fixtureDatabase(),
    scope,
    "conv_00000000-0000-4000-8000-000000000060",
  );
  expect(restored?.placement).toEqual(pinned.placement);
  expect(restored?.metadata.pinnedAt).toBe(pinned.metadata.pinnedAt);
  return {
    total: ids.size,
    pageSizes: [50, 10],
    selectedOutsideFirstPage: true,
    pinnedProjectRestored: true,
  };
}

function readArchivedId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.id !== "string")
    throw new Error("Invalid archived chat");
  return raw.id;
}

export async function createProjectFixture(): Promise<{
  scope: ConversationScope;
  session: IssuedControlSession;
}> {
  await installSlackActorFixture();
  const identity = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!identity.ok) throw new Error(identity.error.code);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.value,
    now: Date.now(),
    ttlMs: 1800000,
  });
  return {
    scope: { organisationId: ORGANISATION_ID, userId: identity.value },
    session,
  };
}

export async function seedProjectChats(
  scope: ConversationScope,
  count: number,
): Promise<void> {
  const model = await resolveOrganisationModelRoute({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  if (!model.ok) throw new Error(model.error.code);
  for (let i = 0; i < count; i += 1) {
    const saved = await saveConversation(
      await requireOrganisationExecutionScope(env, scope.organisationId),
      scope.userId,
      {
        lineage: { kind: "original" },
        historyBindings: [],
        id: fixtureConversationId(i),
        title: `Production ${i}`,
        modelRoute: model.value,
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
        effort: "medium",
      },
      0,
    );
    if (saved.kind !== "saved")
      throw new Error("Fixture chat could not be saved");
  }
}

// The member's sidebar: the Project directory read and their ordering commands.
export async function projectRequest(
  session: IssuedControlSession,
  method: "GET" | "POST",
  body: ChatDirectoryCommand | null,
): Promise<Response> {
  return chatApiRequest(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat/projects`,
    method,
    body,
  );
}

export async function projectCommandRequest(
  session: IssuedControlSession,
  body: ProjectCommand,
): Promise<Response> {
  return chatApiRequest(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/projects`,
    "POST",
    body,
  );
}

export async function chatApiRequest(
  session: IssuedControlSession,
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method,
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
      cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      "x-pantry-csrf": session.csrfToken,
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

async function verifyQueuedProjectBinding(
  scope: ConversationScope,
): Promise<void> {
  const stored = await readConversation(
    fixtureDatabase(),
    scope,
    "conv_00000000-0000-4000-8000-000000000001",
  );
  if (stored === null) throw new Error("Missing queue chat");
  const running = parseChatCommand({
    kind: "message",
    conversationId: stored.conversation.id,
    requestId: "running_input",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "First task",
    browserContext: { kind: "unavailable" },
  });
  if (!running.ok) throw new Error(running.error);
  const active = await admitTurn(
    stored,
    running.value,
    stored.conversation.modelRoute,
    scope,
  );
  if (!active.ok || active.kind !== "admitted")
    throw new Error("Input not admitted");
  const snapshot = await prepareProjectSnapshot(
    env,
    await requireOrganisationExecutionScope(env, scope.organisationId),
    scope,
    storedProjectPlacement(stored),
  );
  const first = bindConversationProjectSnapshot(
    active.conversation,
    "running_input",
    snapshot,
  );
  const queuedCommand = parseChatCommand({
    kind: "next",
    conversationId: first.id,
    requestId: "queued_input",
    inputId: "queued_project_input",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Queued literal task",
    browserContext: { kind: "unavailable" },
  });
  if (!queuedCommand.ok) throw new Error(queuedCommand.error);
  const queued = await admitTurn(
    {
      revision: stored.revision,
      actorIdentity: stored.actorIdentity,
      conversation: first,
      metadata: stored.metadata,
      placement: stored.placement,
      inheritsProject: stored.inheritsProject,
      sharing: stored.sharing,
    },
    queuedCommand.value,
    first.modelRoute,
    scope,
  );
  if (!queued.ok || queued.kind !== "queued")
    throw new Error("Input not queued");
  const bound = bindConversationProjectSnapshot(
    queued.conversation,
    "queued_input",
    snapshot,
  );
  expect(projectSnapshotFromParts(bound.pendingInputs[0]?.parts ?? [])).toEqual(
    snapshot,
  );
  const later = await prepareProjectSnapshot(
    env,
    await requireOrganisationExecutionScope(env, scope.organisationId),
    scope,
    storedProjectPlacement(stored),
  );
  expect(
    projectSnapshotFromParts(
      bindConversationProjectSnapshot(bound, "queued_input", later)
        .pendingInputs[0]?.parts ?? [],
    ),
  ).toEqual(snapshot);
}

function fixtureConversationId(index: number) {
  const result = parseConversationId(
    `conv_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const readScopeActive = OrganisationExecutionScope.prototype.isActive;
type DirectoryPlacementRace = { relocationId: ActorRelocationId | null };

it(
  "fences directory receipts and effects across a freeze, rollback and relocation",
  directoryPlacementJourney,
  90_000,
);

async function directoryPlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  const execution = await currentDirectoryScope();
  expect(await readProjectDirectory(fixtureDatabase(), fixture.scope)).toEqual({
    revision: 0,
    defaultProjectId: await requireDefaultProjectId(
      fixtureDatabase(),
      ORGANISATION_ID,
    ),
    projects: [],
    placements: [],
  });
  const empty = await directoryPlacementEvidence();
  expect(empty.directories).toEqual([]);
  const placementActor = {
    userId: fixture.scope.userId,
    organisationRole: "admin",
  } as const;
  const create: ProjectCommand = {
    kind: "create_project",
    operationId: "p55_create_project",
    projectId: requireProjectId("project_2d912df0-930f-5fbb-93b5-b3746e99b40b"),
    content: {
      name: "Regional bakery",
      brief: "Cold-tray handoff",
      references: [],
    },
  };
  const createRace: DirectoryPlacementRace = { relocationId: null };
  const pause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeDirectoryAfterCheck.bind(null, execution, createRace),
    );
  try {
    expect(
      await mutateProject(env, execution, placementActor, create, Date.now()),
    ).toMatchObject({ kind: "rejected" });
    expect(pause).toHaveBeenCalled();
  } finally {
    pause.mockRestore();
  }
  expect(await directoryPlacementEvidence()).toEqual(empty);
  expect((await projectRequest(fixture.session, "GET", null)).status).toBe(409);
  expect(await directoryPlacementEvidence()).toEqual(empty);
  await resumeDirectoryPlacement(createRace);
  expect(
    await mutateProject(env, execution, placementActor, create, Date.now()),
  ).toMatchObject({ kind: "rejected" });
  expect((await projectCommandRequest(fixture.session, create)).status).toBe(
    200,
  );
  const created = await directoryPlacementEvidence();
  expect((await projectCommandRequest(fixture.session, create)).status).toBe(
    200,
  );
  expect(await directoryPlacementEvidence()).toEqual(created);

  await seedProjectChats(fixture.scope, 2);
  const directory = await readProjectDirectory(
    fixtureDatabase(),
    fixture.scope,
  );
  const move: ChatDirectoryCommand = {
    kind: "move_chat",
    operationId: "p55_move_chat",
    expectedDirectoryRevision: directory.revision,
    conversationId: fixtureConversationId(0),
    expectedMembershipRevision: 1,
    destination: { projectId: create.projectId },
    insertion: { kind: "end" },
  };
  const beforeMove = await directoryPlacementEvidence();
  const active = await currentDirectoryScope();
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER directory_settlement_failure BEFORE UPDATE OF revision ON portal_chat_directory
    BEGIN SELECT RAISE(ABORT, 'directory_settlement_failure'); END`,
    )
    .run();
  try {
    await expect(
      mutateChatDirectory(active, fixture.scope.userId, move, Date.now()),
    ).rejects.toThrow("directory_settlement_failure");
  } finally {
    await fixtureDatabase()
      .prepare("DROP TRIGGER directory_settlement_failure")
      .run();
  }
  expect(await directoryPlacementEvidence()).toEqual(beforeMove);
  expect((await projectRequest(fixture.session, "POST", move)).status).toBe(
    200,
  );
  const moved = await directoryPlacementEvidence();
  expect((await projectRequest(fixture.session, "POST", move)).status).toBe(
    200,
  );
  expect(await directoryPlacementEvidence()).toEqual(moved);
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        fixture.scope,
        fixtureConversationId(0),
      )
    )?.placement,
  ).toMatchObject({
    projectId: create.projectId,
    membershipRevision: 2,
  });
  const defaultProjectId = await requireDefaultProjectId(
    fixtureDatabase(),
    ORGANISATION_ID,
  );
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        fixture.scope,
        fixtureConversationId(1),
      )
    )?.placement,
  ).toMatchObject({ projectId: defaultProjectId, membershipRevision: 1 });

  const edit: ProjectCommand = {
    kind: "edit_project",
    operationId: "p55_edit",
    projectId: create.projectId,
    expectedProjectRevision: 1,
    content: {
      name: "Regional bakery revised",
      brief: "Ready for dispatch",
      references: [],
    },
  };
  expect((await projectCommandRequest(fixture.session, edit)).status).toBe(200);
  const arrange: ChatDirectoryCommand = {
    kind: "set_project_placement",
    operationId: "p55_arrange",
    projectId: create.projectId,
    expectedDirectoryRevision: directory.revision + 2,
    position: 0,
    collapsed: true,
  };
  expect((await projectRequest(fixture.session, "POST", arrange)).status).toBe(
    200,
  );
  const remove: ProjectCommand = {
    kind: "delete_project",
    operationId: "p55_remove",
    projectId: create.projectId,
    expectedProjectRevision: 2,
    expectedAccessRevision: 0,
  };
  expect((await projectCommandRequest(fixture.session, remove)).status).toBe(
    200,
  );
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        fixture.scope,
        fixtureConversationId(0),
      )
    )?.placement,
  ).toMatchObject({ projectId: defaultProjectId, membershipRevision: 3 });
  expect(
    (await readProjectDirectory(fixtureDatabase(), fixture.scope)).projects,
  ).toEqual([]);
  Object.assign(task.meta, {
    directoryPlacementEvidence: {
      emptyRead:
        "frozen placement rejects reads without directory initialization",
      freeze: "create rejected after active check without receipt or effects",
      rollback:
        "late directory update failure rolls back receipt, ordering and membership",
      recovery:
        "retired scope rejected; fresh HTTP requests succeed after the relocation",
      replay: "create and move receipts replay without additional writes",
      operations:
        "create, move, edit, reorder and delete accepted on active placement",
      final: await directoryPlacementEvidence(),
    },
  });
}

async function currentDirectoryScope() {
  const result = await OrganisationExecutionScope.resolve(env, ORGANISATION_ID);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function freezeDirectoryAfterCheck(
  execution: OrganisationExecutionScope,
  race: DirectoryPlacementRace,
) {
  const active = await readScopeActive.call(execution);
  expect(active).toBe(true);
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const move = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!move.ok) throw new Error(JSON.stringify(move.error));
  race.relocationId = move.value.relocationId;
  await env.DB.prepare(
    `CREATE TRIGGER directory_placement_hold BEFORE UPDATE OF status ON state_object_relocation
    WHEN NEW.status = 'published' BEGIN SELECT RAISE(ABORT, 'directory_placement_hold'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: move.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("directory_placement_hold");
  return active;
}
async function resumeDirectoryPlacement(race: DirectoryPlacementRace) {
  if (race.relocationId === null)
    throw new Error("Directory placement was not frozen");
  await env.DB.prepare("DROP TRIGGER directory_placement_hold").run();
  const resumed = await resumeActorRelocation({
    env,
    relocationId: race.relocationId,
    now: Date.now(),
  });
  if (!resumed.ok) throw new Error(resumed.error.code);
  if (resumed.value.status !== "retained")
    throw new Error("Directory relocation did not retain its source");
  // Complete the retention period before another journey reuses this cell.
  const retentionMs = resumed.value.retainUntil - resumed.value.resumedAt;
  const expiredAt = Date.now() - 1;
  await env.DB.prepare(
    "UPDATE state_object_relocation SET resumed_at = ?, retain_until = ? WHERE relocation_id = ?",
  )
    .bind(expiredAt - retentionMs, expiredAt, race.relocationId)
    .run();
  expect(
    await resumeActorRelocation({
      env,
      relocationId: race.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "complete" } });
}

async function freezeDirectoryBeforeBatch<T>(
  execution: OrganisationExecutionScope,
  race: DirectoryPlacementRace,
  batch: D1Database["batch"],
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  await freezeDirectoryAfterCheck(execution, race);
  return batch<T>(statements);
}

function interceptConversationUpdate(
  execution: OrganisationExecutionScope,
  race: DirectoryPlacementRace,
  prepare: OrganisationDatabase["prepare"],
  sql: string,
): OrganisationStatement {
  const statement = prepare(sql);
  const bind = statement.bind.bind(statement);
  vi.spyOn(statement, "bind").mockImplementationOnce(
    bindConversationUpdate.bind(null, execution, race, bind),
  );
  return statement;
}

function bindConversationUpdate(
  execution: OrganisationExecutionScope,
  race: DirectoryPlacementRace,
  bind: D1PreparedStatement["bind"],
  ...values: unknown[]
): D1PreparedStatement {
  const statement = bind(...values);
  const run = statement.run.bind(statement);
  vi.spyOn(statement, "run").mockImplementationOnce(
    freezeConversationUpdate.bind(null, execution, race, run),
  );
  return statement;
}

async function freezeConversationUpdate<T = Record<string, unknown>>(
  execution: OrganisationExecutionScope,
  race: DirectoryPlacementRace,
  run: D1PreparedStatement["run"],
): Promise<D1Result<T>> {
  await freezeDirectoryAfterCheck(execution, race);
  return run<T>();
}
async function directoryPlacementEvidence() {
  const [
    directories,
    receipts,
    projects,
    placement,
    chats,
    ordering,
    projectReceipts,
  ] = await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "SELECT user_id, revision FROM portal_chat_directory WHERE organisation_id = ? ORDER BY user_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT user_id, operation_id, directory_revision FROM portal_chat_directory_operation WHERE organisation_id = ? ORDER BY user_id, operation_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT project_id, revision, name FROM project WHERE organisation_id = ? ORDER BY project_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT user_id, project_id, position, collapsed FROM portal_chat_directory_project WHERE organisation_id = ? ORDER BY user_id, project_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT c.conversation_id, cp.project_id, c.revision, cp.revision AS membership_revision, c.state_json, c.active_user_id FROM portal_conversation c JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id WHERE c.organisation_id = ? ORDER BY c.conversation_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT user_id, conversation_id, manual_position, lifecycle, pinned_at, archived_at, draft_text, draft_updated_at, last_read_sequence FROM portal_conversation_user WHERE organisation_id = ? ORDER BY user_id, conversation_id",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "SELECT actor_user_id, operation_id, project_id, case_id, result_revision, applied FROM project_operation WHERE organisation_id = ? ORDER BY actor_user_id, operation_id",
      )
      .bind(ORGANISATION_ID),
  ]);
  return {
    directories: evidenceRows(directories),
    receipts: evidenceRows(receipts),
    projectReceipts: evidenceRows(projectReceipts),
    projects: evidenceRows(projects),
    placement: evidenceRows(placement),
    chats: evidenceRows(chats),
    ordering: evidenceRows(ordering),
  };
}
function evidenceRows(result: D1Result | undefined) {
  if (!result) throw new Error("Missing directory evidence query");
  return result.results;
}

it(
  "fences an operator chat pin and rolls back personal-state initialization",
  operatorPlacementJourney,
  90_000,
);

async function operatorPlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 1);
  const id = fixtureConversationId(0);
  const execution = await currentDirectoryScope();
  const before = await directoryPlacementEvidence();
  const race: DirectoryPlacementRace = { relocationId: null };
  const pause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeDirectoryAfterCheck.bind(null, execution, race),
    );
  try {
    expect(
      await updateConversationMetadata(
        execution,
        fixture.scope.userId,
        id,
        { kind: "pin" },
        Date.now(),
      ),
    ).toMatchObject({ ok: false });
    expect(pause).toHaveBeenCalled();
  } finally {
    pause.mockRestore();
  }
  expect(await directoryPlacementEvidence()).toEqual(before);
  await resumeDirectoryPlacement(race);
  expect(
    await updateConversationMetadata(
      execution,
      fixture.scope.userId,
      id,
      { kind: "pin" },
      Date.now(),
    ),
  ).toMatchObject({ ok: false });
  expect(await directoryPlacementEvidence()).toEqual(before);
  const path = `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${id}`;
  expect(
    (await chatApiRequest(fixture.session, path, "PATCH", { action: "pin" }))
      .status,
  ).toBe(200);
  const edited = await readConversation(fixtureDatabase(), fixture.scope, id);
  if (!edited) throw new Error("Missing edited chat");
  expect(edited.metadata.pinnedAt).not.toBeNull();

  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "DELETE FROM portal_conversation_user WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
      )
      .bind(ORGANISATION_ID, fixture.scope.userId, id),
    fixtureDatabase()
      .prepare(
        "DELETE FROM portal_chat_directory WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, fixture.scope.userId),
  ]);
  const uninitialized = await directoryPlacementEvidence();
  const current = await currentDirectoryScope();
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER operator_metadata_failure BEFORE UPDATE OF revision ON portal_chat_directory
    BEGIN SELECT RAISE(ABORT, 'operator_metadata_failure'); END`,
    )
    .run();
  try {
    await expect(
      updateConversationMetadata(
        current,
        fixture.scope.userId,
        id,
        { kind: "archive", expectedRevision: edited.revision },
        Date.now(),
      ),
    ).rejects.toThrow("operator_metadata_failure");
  } finally {
    await fixtureDatabase()
      .prepare("DROP TRIGGER operator_metadata_failure")
      .run();
  }
  expect(await directoryPlacementEvidence()).toEqual(uninitialized);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "archive",
        expectedRevision: edited.revision,
      })
    ).status,
  ).toBe(200);
  expect(
    (await readConversation(fixtureDatabase(), fixture.scope, id))?.metadata
      .lifecycle,
  ).toBe("archived");
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "restore",
        expectedRevision: edited.revision,
      })
    ).status,
  ).toBe(200);
  expect(
    (await readConversation(fixtureDatabase(), fixture.scope, id))?.metadata
      .lifecycle,
  ).toBe("active");
  Object.assign(task.meta, {
    operatorPlacementEvidence: {
      freezeRace: "pin",
      rejection:
        "no conversation, personal-state or directory mutation after freeze or retired-scope retry",
      recovery: "fresh HTTP pin succeeded after the relocation",
      rollback:
        "late metadata failure rolled back directory and personal-state initialization and archive",
      retry: "fresh archive and restore succeeded after rollback",
      final: await directoryPlacementEvidence(),
    },
  });
}

it(
  "fences conversation creation, updates and delayed recovery saves",
  conversationSavePlacementJourney,
  90_000,
);

async function conversationSavePlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 1);
  const source = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    fixtureConversationId(0),
  );
  if (!source) throw new Error("Missing save fixture");
  const conversation = {
    ...source.conversation,
    id: fixtureConversationId(1),
    title: "Pending handoff",
  };
  await fixtureDatabase()
    .prepare(
      "DELETE FROM portal_chat_directory WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, fixture.scope.userId)
    .run();
  const empty = await directoryPlacementEvidence();
  const initial = await currentDirectoryScope();
  const createRace: DirectoryPlacementRace = { relocationId: null };
  const createBatch = initial.database.batch.bind(initial.database);
  const createPause = vi
    .spyOn(initial.database, "batch")
    .mockImplementationOnce(
      freezeDirectoryBeforeBatch.bind(null, initial, createRace, createBatch),
    );
  try {
    expect(
      await saveConversation(initial, fixture.scope.userId, conversation, 0),
    ).toEqual({ kind: "conflict" });
    expect(createPause).toHaveBeenCalled();
  } finally {
    createPause.mockRestore();
  }
  expect(await directoryPlacementEvidence()).toEqual(empty);
  await resumeDirectoryPlacement(createRace);
  expect(
    await saveConversation(initial, fixture.scope.userId, conversation, 0),
  ).toEqual({ kind: "conflict" });
  const active = await currentDirectoryScope();
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER conversation_creation_failure BEFORE UPDATE OF revision ON portal_chat_directory
    BEGIN SELECT RAISE(ABORT, 'conversation_creation_failure'); END`,
    )
    .run();
  try {
    await expect(
      saveConversation(active, fixture.scope.userId, conversation, 0),
    ).rejects.toThrow("conversation_creation_failure");
  } finally {
    await fixtureDatabase()
      .prepare("DROP TRIGGER conversation_creation_failure")
      .run();
  }
  expect(await directoryPlacementEvidence()).toEqual(empty);
  expect(
    await saveConversation(active, fixture.scope.userId, conversation, 0),
  ).toEqual({ kind: "saved" });
  const created = await directoryPlacementEvidence();
  const update = { ...conversation, title: "Accepted handoff" };
  const updateRace: DirectoryPlacementRace = { relocationId: null };
  const updatePrepare = active.database.prepare.bind(active.database);
  const updatePause = vi
    .spyOn(active.database, "prepare")
    .mockImplementationOnce(
      interceptConversationUpdate.bind(null, active, updateRace, updatePrepare),
    );
  try {
    expect(
      await saveConversation(active, fixture.scope.userId, update, 1),
    ).toEqual({ kind: "conflict" });
  } finally {
    updatePause.mockRestore();
  }
  expect(await directoryPlacementEvidence()).toEqual(created);
  await resumeDirectoryPlacement(updateRace);
  expect(
    await saveConversation(active, fixture.scope.userId, update, 1),
  ).toEqual({ kind: "conflict" });
  const current = await currentDirectoryScope();
  expect(
    await saveConversation(current, fixture.scope.userId, update, 1),
  ).toEqual({ kind: "saved" });
  const stored = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    conversation.id,
  );
  if (!stored) throw new Error("Missing current conversation");
  const command = parseChatCommand({
    kind: "message",
    conversationId: conversation.id,
    requestId: "p55_delayed_recovery",
    model: stored.conversation.modelRoute.model,
    text: "Continue the handoff",
    browserContext: { kind: "unavailable" },
  });
  if (!command.ok) throw new Error(command.error);
  const admitted = await admitTurn(
    stored,
    command.value,
    stored.conversation.modelRoute,
    fixture.scope,
  );
  if (!admitted.ok) throw new Error(admitted.code);
  expect(
    await saveConversation(
      current,
      fixture.scope.userId,
      admitted.conversation,
      stored.revision,
    ),
  ).toEqual({ kind: "saved" });
  const beforeRecovery = await directoryPlacementEvidence();
  const caseActor = await conversationCase(stored.actorIdentity);
  const recoveryRace: DirectoryPlacementRace = { relocationId: null };
  const unavailable = vi
    .spyOn(modelRoutes, "resolveOrganisationModelRouteAtScope")
    .mockImplementationOnce(
      retireDuringModelPreparation.bind(null, recoveryRace),
    );
  const execution = {
    scope: fixture.scope,
    conversationId: conversation.id,
    controlSessionId: fixture.session.session.controlSessionId,
  };
  try {
    expect(
      await resumeConversationExecution(
        env,
        await requireOrganisationExecutionScope(
          env,
          fixture.scope.organisationId,
        ),
        execution,
        caseActor,
      ),
    ).toBe("pending");
    expect(unavailable).toHaveBeenCalled();
  } finally {
    unavailable.mockRestore();
  }
  expect(await directoryPlacementEvidence()).toEqual(beforeRecovery);
  const retryUnavailable = vi
    .spyOn(modelRoutes, "resolveOrganisationModelRouteAtScope")
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "pantry_platform_credential_unavailable" },
    });
  try {
    expect(
      await resumeConversationExecution(
        env,
        await requireOrganisationExecutionScope(
          env,
          fixture.scope.organisationId,
        ),
        execution,
        await conversationCase(stored.actorIdentity),
      ),
    ).toBe("settled");
  } finally {
    retryUnavailable.mockRestore();
  }
  const settled = await readConversation(
    fixtureDatabase(),
    fixture.scope,
    conversation.id,
  );
  expect(settled?.conversation.work.kind).toBe("failed");
  expect(settled?.revision).toBe(stored.revision + 2);
  Object.assign(task.meta, {
    conversationSavePlacementEvidence: {
      createFreeze: "no conversation, personal row or directory initialization",
      creationRollback:
        "late directory failure rolls back the entire creation batch",
      updateFreeze: "revision and state unchanged; retired scope cannot retry",
      delayedRecovery:
        "placement retired during model preparation; failure retries retained old authority and wrote nothing",
      freshRecovery:
        "new recovery attempt captured current placement, persisted failure once and ended the wake",
      final: await directoryPlacementEvidence(),
    },
  });
}
async function retireDuringModelPreparation(race: DirectoryPlacementRace) {
  const execution = await currentDirectoryScope();
  await freezeDirectoryAfterCheck(execution, race);
  await resumeDirectoryPlacement(race);
  return {
    ok: false as const,
    error: { code: "pantry_platform_credential_unavailable" as const },
  };
}
async function conversationCase(actorIdentity: string) {
  const identities = await deriveDirectCaseIdentities(actorIdentity);
  if (!identities.ok) throw new Error(identities.error.code);
  const actor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}

it(
  "fences revoked contributor settlement across relocation and keeps snapshot reads pure",
  revokedConversationPlacementJourney,
  90_000,
);

async function revokedConversationPlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 1);
  const id = fixtureConversationId(0);
  const source = await readConversation(fixtureDatabase(), fixture.scope, id);
  if (source === null) throw new Error("Missing revocation fixture");
  const contributor = await installRevocationContributor();
  const projectId = requireProjectId(
    "project_00000000-0000-4000-8000-000000000055",
  );
  await fixtureDatabase()
    .prepare(
      `INSERT INTO project
    (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'Cold-tray team', '', '[]', 1, 1, ?, ?)`,
    )
    .bind(
      ORGANISATION_ID,
      fixture.scope.userId,
      projectId,
      Date.now(),
      Date.now(),
    )
    .run();
  const projectAccess = `/v1/control/organisations/${ORGANISATION_ID}/projects/${projectId}/access`;
  expect(
    (
      await chatApiRequest(fixture.session, projectAccess, "POST", {
        kind: "share_project",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 0,
        members: [{ userId: contributor, role: "editor" }],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await chatApiRequest(
        fixture.session,
        `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${id}/access`,
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
  expect(
    await saveConversation(
      await currentDirectoryScope(),
      fixture.scope.userId,
      {
        ...source.conversation,
        latestSequence: 1,
        timeline: [
          {
            kind: "user",
            eventId: "accepted_prior_request",
            requestId: "accepted_prior_request",
            sequence: 1,
            createdAt: Date.now(),
            text: "Keep the accepted cold-tray plan",
            parts: [{ kind: "text", text: "Keep the accepted cold-tray plan" }],
          },
        ],
      },
      source.revision + 1,
    ),
  ).toEqual({ kind: "saved" });
  const contributorScope = {
    organisationId: ORGANISATION_ID,
    userId: contributor,
  };
  const shared = await readConversation(
    fixtureDatabase(),
    contributorScope,
    id,
  );
  if (shared === null) throw new Error("Missing shared fixture");
  const command = parseChatCommand({
    kind: "message",
    conversationId: id,
    requestId: "revoked_contributor_request",
    model: shared.conversation.modelRoute.model,
    text: "Unaccepted contributor work",
    browserContext: { kind: "unavailable" },
  });
  if (!command.ok) throw new Error(command.error);
  const admitted = await admitTurn(
    shared,
    command.value,
    shared.conversation.modelRoute,
    contributorScope,
  );
  if (!admitted.ok || admitted.kind !== "admitted")
    throw new Error("Contributor was not admitted");
  expect(
    await saveConversation(
      await currentDirectoryScope(),
      contributor,
      admitted.conversation,
      shared.revision,
    ),
  ).toEqual({ kind: "saved" });
  expect(
    (
      await chatApiRequest(fixture.session, projectAccess, "POST", {
        kind: "remove_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 1,
        userId: contributor,
      })
    ).status,
  ).toBe(200);
  const before = await directoryPlacementEvidence();
  const snapshot = await readConversation(fixtureDatabase(), fixture.scope, id);
  expect(snapshot?.conversation.work.kind).toBe("running");
  expect(
    await readConversation(fixtureDatabase(), contributorScope, id),
  ).toBeNull();
  expect(await directoryPlacementEvidence()).toEqual(before);
  const contributorSession = await issueControlSession({
    db: env.DB,
    userId: contributor,
    now: Date.now(),
    ttlMs: 60_000,
  });
  const pending = {
    scope: contributorScope,
    conversationId: id,
    controlSessionId: contributorSession.session.controlSessionId,
  };
  const execution = await currentDirectoryScope();
  // Revoked readers cannot settle work for the remaining audience.
  await reconcileRevokedConversationRun(execution, contributor, id);
  expect(await directoryPlacementEvidence()).toEqual(before);
  const race: DirectoryPlacementRace = { relocationId: null };
  const batch = execution.database.batch.bind(execution.database);
  const pause = vi
    .spyOn(execution.database, "batch")
    .mockImplementationOnce(
      freezeDirectoryBeforeBatch.bind(null, execution, race, batch),
    );
  try {
    await readConversationForExecution(execution, pending);
    expect(await directoryPlacementEvidence()).toEqual(before);
  } finally {
    pause.mockRestore();
  }
  await resumeDirectoryPlacement(race);
  await readConversationForExecution(execution, pending);
  expect(await directoryPlacementEvidence()).toEqual(before);
  await readConversationForExecution(await currentDirectoryScope(), pending);
  const response = await chatApiRequest(
    fixture.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${id}/access`,
    "GET",
    null,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const settled = await readConversation(fixtureDatabase(), fixture.scope, id);
  expect(settled?.conversation.work).toMatchObject({
    kind: "failed",
    requestId: "revoked_contributor_request",
  });
  expect(settled?.revision).toBe((snapshot?.revision ?? 0) + 1);
  expect(settled?.conversation.timeline.map(timelineRequestId)).toEqual([
    "accepted_prior_request",
  ]);
  const after = await directoryPlacementEvidence();
  expect(after.directories).toEqual(before.directories);
  expect(after.ordering).toEqual(before.ordering);
  await reconcileRevokedConversationRun(
    await currentDirectoryScope(),
    fixture.scope.userId,
    id,
  );
  expect(await directoryPlacementEvidence()).toEqual(after);
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT active_user_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
      )
      .bind(ORGANISATION_ID, id)
      .first("active_user_id"),
  ).toBeNull();
  Object.assign(task.meta, {
    conversationRevocationPlacementEvidence: {
      snapshotReads: "no writes for visible or revoked readers",
      revokedReader: "no settlement without current visibility",
      frozenScope:
        "freeze before SQL settlement; captured scope made no changes",
      retiredScope: "no changes after relocation publication",
      actorRecovery:
        "settles revoked contributor once after relocation, releases contributor and removes unaccepted work",
      acceptedHistory: "prior request preserved",
      final: after,
    },
  });
}

function timelineRequestId(event: { readonly requestId: string }): string {
  return event.requestId;
}

async function installRevocationContributor() {
  const userId = newUserId();
  const personId = `person_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_user
      (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at)
      VALUES (?, 'https://identity.example.invalid', ?, ?, 'Revocation contributor', 1, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.invalid`, now, now),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Revocation contributor')",
      )
      .bind(ORGANISATION_ID, personId),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
      VALUES (?, ?, ?, 'admin', 'active', ?, NULL)`,
      )
      .bind(ORGANISATION_ID, userId, personId, now),
  ]);
  return userId;
}

it(
  "fences sharing and membership receipts across relocation and transaction rollback",
  sharingPlacementJourney,
  90_000,
);

async function sharingPlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 1);
  const contributor = await installRevocationContributor();
  const projectId = requireProjectId(
    "project_00000000-0000-4000-8000-000000000056",
  );
  const targetId = requireProjectId(
    "project_00000000-0000-4000-8000-000000000057",
  );
  await createPlacementProject(fixture, projectId, "Shared handoff");
  await createPlacementProject(fixture, targetId, "New audience");
  const projectCommand: ProjectAccessCommand = {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [{ userId: contributor, role: "editor" }],
  };
  const projectPath = `/v1/control/organisations/${ORGANISATION_ID}/projects/${projectId}/access`;
  expect(
    (await chatApiRequest(fixture.session, projectPath, "POST", projectCommand))
      .status,
  ).toBe(200);
  const projectAccepted = await sharingDeletionEvidence();
  expect(
    (await chatApiRequest(fixture.session, projectPath, "POST", projectCommand))
      .status,
  ).toBe(200);
  expect(await sharingDeletionEvidence()).toEqual(projectAccepted);
  const targetPath = `/v1/control/organisations/${ORGANISATION_ID}/projects/${targetId}/access`;
  expect(
    (
      await chatApiRequest(fixture.session, targetPath, "POST", {
        ...projectCommand,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  const id = fixtureConversationId(0);
  const share: ConversationSharingCommand = {
    kind: "share_conversation",
    operationId: crypto.randomUUID(),
    projectId,
    expectedRevision: 1,
    expectedProjectAccessRevision: 1,
  };
  const beforeShare = await sharingDeletionEvidence();
  await installSharingRollback();
  try {
    await expect(
      shareConversation(
        env,
        await currentDirectoryScope(),
        fixture.scope.userId,
        id,
        share,
      ),
    ).rejects.toThrow("sharing_batch_failure");
    expect(await sharingDeletionEvidence()).toEqual(beforeShare);
  } finally {
    await fixtureDatabase().prepare("DROP TRIGGER sharing_batch_failure").run();
  }
  const conversationPath = `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${id}/access`;
  expect(
    (await chatApiRequest(fixture.session, conversationPath, "POST", share))
      .status,
  ).toBe(200);
  const shared = await sharingDeletionEvidence();
  expect(
    (await chatApiRequest(fixture.session, conversationPath, "POST", share))
      .status,
  ).toBe(200);
  expect(await sharingDeletionEvidence()).toEqual(shared);
  const move: ConversationSharingCommand = {
    kind: "move_shared_conversation",
    operationId: crypto.randomUUID(),
    projectId: targetId,
    expectedRevision: 2,
    expectedProjectAccessRevision: 1,
  };
  const moveExecution = await currentDirectoryScope();
  const moveRace: DirectoryPlacementRace = { relocationId: null };
  const movePause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeDirectoryAfterCheck.bind(null, moveExecution, moveRace),
    );
  try {
    expect(
      await shareConversation(
        env,
        moveExecution,
        fixture.scope.userId,
        id,
        move,
      ),
    ).toMatchObject({ kind: "rejected" });
    expect(await sharingDeletionEvidence()).toEqual(shared);
  } finally {
    movePause.mockRestore();
  }
  await resumeDirectoryPlacement(moveRace);
  expect(
    await shareConversation(env, moveExecution, fixture.scope.userId, id, move),
  ).toMatchObject({ kind: "rejected" });
  expect(
    (await chatApiRequest(fixture.session, conversationPath, "POST", move))
      .status,
  ).toBe(200);
  const moved = await readConversation(fixtureDatabase(), fixture.scope, id);
  if (moved === null) throw new Error("Missing moved shared chat");
  const contributorScope = {
    organisationId: ORGANISATION_ID,
    userId: contributor,
  };
  expect(
    await saveConversation(
      await currentDirectoryScope(),
      contributor,
      {
        ...moved.conversation,
        id: fixtureConversationId(1),
        title: "Private member work",
      },
      0,
      { projectId: targetId },
    ),
  ).toEqual({ kind: "saved" });
  const remove: ProjectAccessCommand = {
    kind: "remove_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: contributor,
  };
  const removeExecution = await currentDirectoryScope();
  const removeRace: DirectoryPlacementRace = { relocationId: null };
  const beforeRemoval = await sharingDeletionEvidence();
  const removePause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeDirectoryAfterCheck.bind(null, removeExecution, removeRace),
    );
  try {
    expect(
      await mutateProjectAccess(
        env,
        removeExecution,
        fixture.scope.userId,
        targetId,
        remove,
      ),
    ).toMatchObject({ kind: "rejected" });
    expect(await sharingDeletionEvidence()).toEqual(beforeRemoval);
  } finally {
    removePause.mockRestore();
  }
  await resumeDirectoryPlacement(removeRace);
  expect(
    await mutateProjectAccess(
      env,
      removeExecution,
      fixture.scope.userId,
      targetId,
      remove,
    ),
  ).toMatchObject({ kind: "rejected" });
  await installSharingRollback();
  try {
    await expect(
      mutateProjectAccess(
        env,
        await currentDirectoryScope(),
        fixture.scope.userId,
        targetId,
        remove,
      ),
    ).rejects.toThrow("sharing_batch_failure");
    expect(await sharingDeletionEvidence()).toEqual(beforeRemoval);
  } finally {
    await fixtureDatabase().prepare("DROP TRIGGER sharing_batch_failure").run();
  }
  expect(
    (await chatApiRequest(fixture.session, targetPath, "POST", remove)).status,
  ).toBe(200);
  expect(
    await readConversation(fixtureDatabase(), contributorScope, id),
  ).toBeNull();
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        contributorScope,
        fixtureConversationId(1),
      )
    )?.placement,
  ).toMatchObject({
    projectId: await requireDefaultProjectId(
      fixtureDatabase(),
      ORGANISATION_ID,
    ),
    membershipRevision: 2,
  });
  const removed = await sharingDeletionEvidence();
  expect(
    (await chatApiRequest(fixture.session, targetPath, "POST", remove)).status,
  ).toBe(200);
  expect(await sharingDeletionEvidence()).toEqual(removed);
  Object.assign(task.meta, {
    sharingPlacementEvidence: {
      frozenOperations: ["shared audience move", "member removal"],
      retiredScopes: "cannot create receipts or retry accepted mutations",
      rollback:
        "late directory failure rolls back sharing and membership effects with their receipts",
      freshHttp: "operations succeed and receipt replay has no new effects",
      removal: "revokes shared access and detaches private member chat",
      final: removed,
    },
  });
}

async function createPlacementProject(
  fixture: Awaited<ReturnType<typeof createProjectFixture>>,
  projectId: ProjectId,
  name: string,
) {
  expect(
    (
      await projectCommandRequest(fixture.session, {
        kind: "create_project",
        operationId: crypto.randomUUID(),
        projectId,
        content: { name, brief: "", references: [] },
      })
    ).status,
  ).toBe(200);
}

async function installSharingRollback() {
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER sharing_batch_failure BEFORE UPDATE OF revision ON portal_chat_directory
    BEGIN SELECT RAISE(ABORT, 'sharing_batch_failure'); END`,
    )
    .run();
}

async function sharingDeletionEvidence() {
  const directory = await directoryPlacementEvidence();
  const [projectReceipts, conversationReceipts, members, deletions, forks] =
    await fixtureDatabase().batch([
      fixtureDatabase()
        .prepare(
          "SELECT * FROM project_access_operation WHERE organisation_id = ? ORDER BY actor_user_id, operation_id",
        )
        .bind(ORGANISATION_ID),
      fixtureDatabase()
        .prepare(
          "SELECT * FROM portal_chat_conversation_access_operation WHERE organisation_id = ? ORDER BY actor_user_id, operation_id",
        )
        .bind(ORGANISATION_ID),
      fixtureDatabase()
        .prepare(
          "SELECT * FROM project_member WHERE organisation_id = ? ORDER BY project_id, user_id",
        )
        .bind(ORGANISATION_ID),
      fixtureDatabase()
        .prepare(
          "SELECT * FROM portal_chat_deletion WHERE organisation_id = ? ORDER BY conversation_id",
        )
        .bind(ORGANISATION_ID),
      fixtureDatabase()
        .prepare(
          "SELECT * FROM portal_chat_fork WHERE organisation_id = ? ORDER BY destination_conversation_id",
        )
        .bind(ORGANISATION_ID),
    ]);
  return {
    directory,
    projectReceipts: evidenceRows(projectReceipts),
    conversationReceipts: evidenceRows(conversationReceipts),
    members: evidenceRows(members),
    deletions: evidenceRows(deletions),
    forks: evidenceRows(forks),
  };
}

it(
  "fences deletion admission and accepted cleanup, rolls back final settlement, and resumes descendant erasure",
  deletionPlacementJourney,
  90_000,
);

type DeletionPlacementRace = DirectoryPlacementRace & {
  accepted: Awaited<ReturnType<typeof sharingDeletionEvidence>> | null;
};

async function deletionPlacementJourney({ task }: TestContext) {
  const fixture = await createProjectFixture();
  await seedProjectChats(fixture.scope, 2);
  const id = fixtureConversationId(0);
  const path = `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${id}`;
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_p55_deletion', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const fork = await chatApiRequest(fixture.session, path, "PATCH", {
    action: "fork",
    operationId: "p55_failed_fork",
    messageId: "response_not_accepted",
  });
  expect(fork.status).toBe(409);
  const forkBody = await fork.json();
  if (!isRecord(forkBody) || typeof forkBody.conversationId !== "string")
    throw new Error("Missing failed fork receipt");
  const destination = parseConversationId(forkBody.conversationId);
  if (!destination.ok) throw new Error(destination.error.code);
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        action: "archive",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  const command = { operationId: "p55_deletion_cleanup", expectedRevision: 1 };
  const initial = await sharingDeletionEvidence();
  const admissionScope = await currentDirectoryScope();
  const admissionRace: DirectoryPlacementRace = { relocationId: null };
  const admissionPause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeDirectoryAfterCheck.bind(null, admissionScope, admissionRace),
    );
  try {
    expect(
      await deleteArchivedChat(
        env,
        admissionScope,
        fixture.scope.userId,
        id,
        command,
      ),
    ).toMatchObject({ kind: "rejected", code: "chat_delete_conflict" });
    expect(await sharingDeletionEvidence()).toEqual(initial);
  } finally {
    admissionPause.mockRestore();
  }
  await resumeDirectoryPlacement(admissionRace);
  expect(
    await deleteArchivedChat(
      env,
      admissionScope,
      fixture.scope.userId,
      id,
      command,
    ),
  ).toMatchObject({ kind: "rejected" });
  expect(await sharingDeletionEvidence()).toEqual(initial);
  const cleanupScope = await currentDirectoryScope();
  const cleanupRace: DeletionPlacementRace = {
    relocationId: null,
    accepted: null,
  };
  const cleanupPause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementation(
      freezeAfterDeletionAdmission.bind(null, cleanupScope, cleanupRace, id),
    );
  try {
    expect(
      await deleteArchivedChat(
        env,
        cleanupScope,
        fixture.scope.userId,
        id,
        command,
      ),
    ).toMatchObject({ kind: "rejected", code: "chat_delete_conflict" });
    expect(cleanupRace.accepted).not.toBeNull();
    expect(await sharingDeletionEvidence()).toEqual(cleanupRace.accepted);
  } finally {
    cleanupPause.mockRestore();
  }
  await resumeDirectoryPlacement(cleanupRace);
  expect(
    await deleteArchivedChat(
      env,
      cleanupScope,
      fixture.scope.userId,
      id,
      command,
    ),
  ).toMatchObject({ kind: "rejected" });
  expect(await sharingDeletionEvidence()).toEqual(cleanupRace.accepted);
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER deletion_final_failure BEFORE UPDATE OF revision ON portal_chat_directory
    WHEN EXISTS (SELECT 1 FROM portal_chat_deletion WHERE organisation_id = '${ORGANISATION_ID}'
      AND conversation_id = '${id}' AND status = 'deleted')
    BEGIN SELECT RAISE(ABORT, 'deletion_final_failure'); END`,
    )
    .run();
  try {
    expect(
      await deleteArchivedChat(
        env,
        await currentDirectoryScope(),
        fixture.scope.userId,
        id,
        command,
      ),
    ).toMatchObject({ kind: "failed" });
    const failed = await sharingDeletionEvidence();
    expect(failed.directory.chats).toEqual(initial.directory.chats);
    expect(failed.directory.directories).toEqual(initial.directory.directories);
    expect(
      await fixtureDatabase()
        .prepare(
          "SELECT status FROM portal_chat_deletion WHERE organisation_id = ? AND conversation_id = ?",
        )
        .bind(ORGANISATION_ID, id)
        .first("status"),
    ).toBe("failed");
    expect(
      await fixtureDatabase()
        .prepare(
          "SELECT status FROM portal_chat_deletion WHERE organisation_id = ? AND conversation_id = ?",
        )
        .bind(ORGANISATION_ID, destination.value)
        .first("status"),
    ).toBe("deleted");
    expect(
      await fixtureDatabase()
        .prepare(
          "SELECT status FROM portal_chat_fork WHERE organisation_id = ? AND destination_conversation_id = ?",
        )
        .bind(ORGANISATION_ID, destination.value)
        .first("status"),
    ).toBe("erased");
  } finally {
    await fixtureDatabase()
      .prepare("DROP TRIGGER deletion_final_failure")
      .run();
  }
  const deletion = { action: "delete", ...command };
  expect(
    (await chatApiRequest(fixture.session, path, "PATCH", deletion)).status,
  ).toBe(200);
  const accepted = await sharingDeletionEvidence();
  expect(
    (await chatApiRequest(fixture.session, path, "PATCH", deletion)).status,
  ).toBe(200);
  expect(await sharingDeletionEvidence()).toEqual(accepted);
  expect(
    await readConversation(fixtureDatabase(), fixture.scope, id),
  ).toBeNull();
  expect(
    await readConversation(
      fixtureDatabase(),
      fixture.scope,
      fixtureConversationId(1),
    ),
  ).not.toBeNull();
  expect(
    (
      await chatApiRequest(fixture.session, path, "PATCH", {
        ...deletion,
        operationId: "competing_deletion",
      })
    ).status,
  ).toBe(409);
  expect(await sharingDeletionEvidence()).toEqual(accepted);
  Object.assign(task.meta, {
    deletionPlacementEvidence: {
      admissionFreeze: "no tombstone or cleanup writes",
      acceptedCleanupFreeze:
        "accepted inventory retained; stale continuation writes nothing",
      retiredScopes: "no cleanup restart or terminal settlement",
      rollback:
        "late directory failure preserves root transcript and directory; terminal receipt rolls back",
      descendantRecovery:
        "failed fork journal erased and child tombstone settled before root retry",
      freshHttp:
        "retry deletes once; replay is stable and another operation is rejected",
      independentChat: "preserved",
      final: accepted,
    },
  });
}

async function freezeAfterDeletionAdmission(
  execution: OrganisationExecutionScope,
  race: DeletionPlacementRace,
  conversationId: ConversationId,
) {
  const active = await readScopeActive.call(execution);
  const admitted = await fixtureDatabase()
    .prepare(
      "SELECT 1 FROM portal_chat_deletion WHERE organisation_id = ? AND conversation_id = ? AND status = 'cleaning'",
    )
    .bind(ORGANISATION_ID, conversationId)
    .first();
  if (active && admitted !== null && race.relocationId === null) {
    race.accepted = await sharingDeletionEvidence();
    return freezeDirectoryAfterCheck(execution, race);
  }
  return active;
}
