import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  fixtureDatabase,
  organisationDatabase,
  onboardFixtureOrganisation,
  publishGlobalOrganisation,
} from "./organisation-database";
import { ensureInitialOrganisationPlacement } from "../../src/data/shared-rows/placement-row";
import { parseOrganisationPlacementProfile } from "../../src/placement";
import { newConversationId } from "@purin-labs/control-api";
import { parseSessionId } from "../../src/ids";
import type { Conversation } from "../../src/chat/conversation";
import { readConversation, saveConversation } from "../../src/chat/store";
import { readProjectDirectory } from "../../src/chat/projects";
import { conversationCaseIdentity } from "../../src/chat/conversation-access";
import { prepareProjectSnapshot } from "../../src/projects/context";
import { storedProjectPlacement } from "../../src/chat/project-context-binding";
import {
  insertDefaultProject,
  requireDefaultProjectId,
} from "../fixtures/default-project";
import {
  bindConversationTurnAccess,
  authorizeChatTurnAccess,
} from "../../src/chat/turn-access";
import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { newProjectId, type UserId } from "@purin-labs/control-api";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { platformConversation } from "./chat-journey-support";
import { commerceClient } from "./commerce-support";
import { type OrganisationClient } from "./organisation-fixture";
import { newOrganisationId, type OrganisationId } from "../../src/ids";

it(
  "shares project context with explicit roles, protects the last owner, and revokes live member access",
  projectMembershipJourney,
);

async function projectMembershipJourney(context: TestContext): Promise<void> {
  const organisationId = newOrganisationId();
  await insertOrganisation(organisationId, "Project team");
  // The other team onboards in the Portal, which gives it its Base project.
  const { organisationId: otherOrganisationId } =
    await onboardFixtureOrganisation("Other team");
  await insertDefaultProject(fixtureDatabase(), organisationId);
  const owner = await createMember(organisationId, "Owner");
  const editor = await createMember(organisationId, "Editor");
  const viewer = await createMember(organisationId, "Viewer");
  const outsider = await createMember(organisationId, "Unrelated member");
  const foreign = await createMember(otherOrganisationId, "Foreign member");
  await assignOwner(organisationId, owner);
  const projectId = newProjectId();
  await fixtureDatabase()
    .prepare(
      `INSERT INTO project
    (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'Autumn launch', 'Plan the launch together.', '[]', 1, 1, ?, ?)`,
    )
    .bind(organisationId, owner.userId, projectId, Date.now(), Date.now())
    .run();
  const path = `/v1/control/organisations/${organisationId}/projects/${projectId}/access`;
  expect((await requestAccess(owner.session, path, null)).status).toBe(200);
  expect((await requestAccess(editor.session, path, null)).status).toBe(404);
  const share = {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [
      { userId: editor.userId, role: "editor" },
      { userId: viewer.userId, role: "viewer" },
    ],
  };
  expect(
    await (await requestAccess(owner.session, path, share)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 1 });
  expect(
    await (await requestAccess(owner.session, path, share)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 1 });
  expect(
    await (await requestAccess(editor.session, path, null)).json(),
  ).toMatchObject({
    access: { kind: "shared", role: "editor", accessRevision: 1 },
    members: expect.arrayContaining([
      expect.objectContaining({ userId: viewer.userId, role: "viewer" }),
    ]),
  });
  expect((await requestAccess(viewer.session, path, null)).status).toBe(200);
  expect((await requestAccess(outsider.session, path, null)).status).toBe(404);
  expect((await requestAccess(foreign.session, path, null)).status).toBe(404);
  const directoryPath = `/v1/control/organisations/${organisationId}/chat/projects`;
  const projectsPath = `/v1/control/organisations/${organisationId}/projects`;
  const edit = {
    kind: "edit_project",
    operationId: crypto.randomUUID(),
    projectId,
    expectedProjectRevision: 1,
    content: {
      name: "Autumn launch",
      brief: "Editors can update the shared brief.",
      references: [],
    },
  };
  expect((await requestAccess(editor.session, projectsPath, edit)).status).toBe(
    200,
  );
  expect(
    (
      await requestAccess(viewer.session, projectsPath, {
        ...edit,
        operationId: crypto.randomUUID(),
        expectedProjectRevision: 2,
      })
    ).status,
  ).toBe(409);
  const visible = await requestAccess(editor.session, directoryPath, null);
  expect(await visible.json()).toMatchObject({
    projects: [
      expect.objectContaining({
        id: projectId,
        brief: "Editors can update the shared brief.",
        access: { kind: "shared", role: "editor", accessRevision: 1 },
      }),
    ],
  });
  const removeOwner = {
    kind: "remove_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: owner.userId,
  };
  expect((await requestAccess(owner.session, path, removeOwner)).status).toBe(
    409,
  );
  expect((await requestAccess(editor.session, path, removeOwner)).status).toBe(
    409,
  );
  expect((await requestAccess(viewer.session, path, removeOwner)).status).toBe(
    409,
  );
  expect(
    (
      await requestAccess(owner.session, path, {
        kind: "set_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 1,
        userId: foreign.userId,
        role: "editor",
      })
    ).status,
  ).toBe(409);
  const revoke = {
    kind: "remove_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: editor.userId,
  };
  expect(
    await (await requestAccess(owner.session, path, revoke)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 2 });
  expect((await requestAccess(editor.session, path, null)).status).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), organisationId, viewer.userId)
    .run();
  expect((await requestAccess(viewer.session, path, null)).status).toBe(404);
  expect(
    await (await requestAccess(owner.session, path, null)).json(),
  ).toMatchObject({
    access: { kind: "shared", role: "owner", accessRevision: 2 },
    members: [{ userId: owner.userId, displayName: "Owner", role: "owner" }],
  });
  Object.assign(context.task.meta, {
    plan54: {
      scenario: "project-membership",
      explicitRoles: true,
      idempotent: true,
      lastOwnerProtected: true,
      crossOrganisationRejected: true,
      projectRevocation: true,
      organisationRevocation: true,
    },
  });
}

type Member = Readonly<{
  userId: UserId;
  session: IssuedControlSession;
  client: OrganisationClient;
}>;

async function createMember(
  organisationId: OrganisationId,
  displayName: string,
): Promise<Member> {
  const personId = `person_${crypto.randomUUID()}`;
  const now = Date.now();
  // The account authority admits only verified Google members.
  const client = await commerceClient(`project-${crypto.randomUUID()}`);
  const userId = client.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, displayName),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
      VALUES (?, ?, ?, 'admin', 'active', ?, NULL)`,
      )
      .bind(organisationId, userId, personId, now),
  ]);
  return { userId, session: client.session, client };
}

/** The first person of a journey owns its Organisation. */
async function assignOwner(
  organisationId: OrganisationId,
  owner: Member,
): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisationId, owner.userId)
    .run();
}

async function requestAccess(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      origin: "https://localhost",
      cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      "x-pantry-csrf": session.csrfToken,
      "content-type": "application/json",
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

it(
  "keeps shared history canonical while isolating personal state, serializing contributors, and revoking turn access",
  sharedConversationJourney,
);

it(
  "moves shared chats between audiences, retries ownership changes, and preserves organisation policy",
  projectTransitionJourney,
);

it(
  "deletes a shared project atomically, refreshes peers, preserves private chats and retries the accepted deletion",
  projectDeletionJourney,
);

async function projectDeletionJourney(context: TestContext): Promise<void> {
  const organisationId = newOrganisationId();
  await insertOrganisation(organisationId, "Project deletion");
  await insertDefaultProject(fixtureDatabase(), organisationId);
  const owner = await createMember(organisationId, "Project owner");
  const editor = await createMember(organisationId, "Private editor");
  const viewer = await createMember(organisationId, "Private viewer");
  await assignOwner(organisationId, owner);
  const projectId = newProjectId();
  const base = `/v1/control/organisations/${organisationId}/chat`;
  const projects = `/v1/control/organisations/${organisationId}/projects`;
  const ownerScope = { organisationId, userId: owner.userId };
  expect(
    (
      await requestAccess(owner.session, projects, {
        kind: "create_project",
        operationId: crypto.randomUUID(),
        projectId,
        content: {
          name: "Closing project",
          brief: "Retire inherited context.",
          references: [],
        },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await requestAccess(owner.session, `${projects}/${projectId}/access`, {
        kind: "share_project",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 0,
        members: [
          { userId: editor.userId, role: "editor" },
          { userId: viewer.userId, role: "viewer" },
        ],
      })
    ).status,
  ).toBe(200);
  const privateChats = [];
  for (const member of [editor, viewer]) {
    const id = newConversationId();
    const scope = { organisationId, userId: member.userId };
    expect(
      (
        await saveConversation(
          await requireOrganisationExecutionScope(env, scope.organisationId),
          scope.userId,
          platformConversation(id, "Confidential private chat"),
          0,
          { projectId },
        )
      ).kind,
    ).toBe("saved");
    expect(
      (
        await requestChatApi(
          member.session,
          `${base}/conversations/${id}`,
          "PATCH",
          { action: "pin" },
        )
      ).status,
    ).toBe(200);
    const lifecycle = member.userId === viewer.userId ? "archived" : "active";
    if (lifecycle === "archived") {
      expect(
        (
          await requestChatApi(
            member.session,
            `${base}/conversations/${id}`,
            "PATCH",
            { action: "archive", expectedRevision: 1 },
          )
        ).status,
      ).toBe(200);
    }
    const directory = await readProjectDirectory(fixtureDatabase(), scope);
    privateChats.push({
      member,
      scope,
      id,
      lifecycle,
      directoryRevision: directory.revision,
    });
  }
  const before = await readProjectDirectory(fixtureDatabase(), ownerScope);
  const command = {
    kind: "delete_project",
    operationId: crypto.randomUUID(),
    projectId,
    expectedProjectRevision: 1,
    expectedAccessRevision: 1,
  };
  expect((await requestAccess(viewer.session, projects, command)).status).toBe(
    409,
  );
  // A Project designated as the Organisation's default cannot be deleted, even by its owner.
  const organisationDefault = await requireDefaultProjectId(
    fixtureDatabase(),
    ownerScope.organisationId,
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_default_project SET project_id = ?, revision = revision + 1 WHERE organisation_id = ?",
    )
    .bind(projectId, ownerScope.organisationId)
    .run();
  const designated = await requestAccess(owner.session, projects, {
    ...command,
    operationId: crypto.randomUUID(),
  });
  expect(designated.status).toBe(409);
  expect(await designated.json()).toEqual({
    kind: "rejected",
    code: "project_is_default",
  });
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_default_project SET project_id = ?, revision = revision + 1 WHERE organisation_id = ?",
    )
    .bind(organisationDefault, ownerScope.organisationId)
    .run();
  const accepted = await (
    await requestAccess(owner.session, projects, command)
  ).json();
  expect(accepted).toEqual({ kind: "accepted", projectId, revision: 1 });
  const directoryRevisions = [];
  for (const chat of privateChats) {
    const directory = await readProjectDirectory(fixtureDatabase(), chat.scope);
    expect.soft(directory.revision).toBeGreaterThan(chat.directoryRevision);
    directoryRevisions.push({
      userId: chat.member.userId,
      before: chat.directoryRevision,
      after: directory.revision,
    });
    const defaultProjectId = await requireDefaultProjectId(
      fixtureDatabase(),
      chat.scope.organisationId,
    );
    expect(directory.projects.map(directoryProjectId)).not.toContain(projectId);
    const stored = await readConversation(
      fixtureDatabase(),
      chat.scope,
      chat.id,
    );
    if (stored === null)
      throw new Error("Project deletion removed a private chat");
    expect(stored.placement).toMatchObject({
      projectId: defaultProjectId,
      membershipRevision: 2,
    });
    expect(stored.metadata.pinnedAt).not.toBeNull();
    expect(stored.metadata.lifecycle).toBe(chat.lifecycle);
    expect(
      (
        await prepareProjectSnapshot(
          env,
          await requireOrganisationExecutionScope(
            env,
            chat.scope.organisationId,
          ),
          chat.scope,
          storedProjectPlacement(stored),
        )
      ).layer.projectId,
    ).toBe(defaultProjectId);
    expect(
      await readConversation(fixtureDatabase(), ownerScope, chat.id),
    ).toBeNull();
  }
  expect
    .soft(await (await requestAccess(owner.session, projects, command)).json())
    .toEqual(accepted);
  expect(
    (await readProjectDirectory(fixtureDatabase(), ownerScope)).revision,
  ).toBe(before.revision + 1);
  expect(
    await (
      await requestAccess(owner.session, projects, {
        ...command,
        expectedAccessRevision: 2,
      })
    ).json(),
  ).toMatchObject({ kind: "rejected", code: "project_operation_conflict" });
  expect(
    (
      await requestAccess(owner.session, projects, {
        ...command,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  Object.assign(context.task.meta, {
    plan54: {
      scenario: "shared-project-deletion",
      directoryRevisions,
      accepted,
      privateChatsPreserved: true,
      archiveAndPinsPreserved: true,
      inheritedContextRemoved: true,
      ownerCannotReadPrivateChats: true,
      peerDirectoriesInvalidated: true,
      matchingDeletionRetryAccepted: true,
      changedRetryRejected: true,
    },
  });
}

async function projectTransitionJourney(context: TestContext): Promise<void> {
  const organisationId = newOrganisationId();
  await insertOrganisation(organisationId, "Project transitions");
  await insertDefaultProject(fixtureDatabase(), organisationId);
  const owner = await createMember(organisationId, "Initial owner");
  const sourcePeer = await createMember(organisationId, "Source colleague");
  const destinationPeer = await createMember(
    organisationId,
    "Destination colleague",
  );
  await assignOwner(organisationId, owner);
  const sourceId = newProjectId();
  const destinationId = newProjectId();
  const base = `/v1/control/organisations/${organisationId}/chat`;
  const directoryPath = `/v1/control/organisations/${organisationId}/projects`;
  const sourcePath = `${directoryPath}/${sourceId}/access`;
  const destinationPath = `${directoryPath}/${destinationId}/access`;
  for (const projectId of [sourceId, destinationId]) {
    expect(
      (
        await requestAccess(owner.session, directoryPath, {
          kind: "create_project",
          operationId: crypto.randomUUID(),
          projectId,
          content: { name: "Launch project", brief: "", references: [] },
        })
      ).status,
    ).toBe(200);
  }
  for (const target of [
    { path: sourcePath, userId: sourcePeer.userId },
    { path: destinationPath, userId: destinationPeer.userId },
  ]) {
    expect(
      (
        await requestAccess(owner.session, target.path, {
          kind: "share_project",
          operationId: crypto.randomUUID(),
          expectedAccessRevision: 0,
          members: [{ userId: target.userId, role: "owner" }],
        })
      ).status,
    ).toBe(200);
  }
  const conversationId = newConversationId();
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, organisationId),
        owner.userId,
        platformConversation(conversationId, "Moving launch review"),
        0,
        { projectId: sourceId },
      )
    ).kind,
  ).toBe("saved");
  const conversationPath = `${base}/conversations/${conversationId}/access`;
  expect(
    await (
      await requestAccess(owner.session, conversationPath, {
        kind: "share_conversation",
        operationId: crypto.randomUUID(),
        projectId: sourceId,
        expectedRevision: 1,
        expectedProjectAccessRevision: 1,
      })
    ).json(),
  ).toEqual({ kind: "accepted", revision: 2 });
  const move = {
    kind: "move_shared_conversation",
    operationId: crypto.randomUUID(),
    projectId: destinationId,
    expectedRevision: 2,
    expectedProjectAccessRevision: 1,
  };
  expect(
    (await requestAccess(sourcePeer.session, conversationPath, move)).status,
  ).toBe(409);
  expect(
    await (await requestAccess(owner.session, conversationPath, move)).json(),
  ).toEqual({ kind: "accepted", revision: 3 });
  expect(
    await (await requestAccess(owner.session, conversationPath, move)).json(),
  ).toEqual({ kind: "accepted", revision: 3 });
  expect(
    (await requestAccess(sourcePeer.session, conversationPath, null)).status,
  ).toBe(404);
  expect(
    (await requestAccess(destinationPeer.session, conversationPath, null))
      .status,
  ).toBe(200);
  expect(
    await (await requestAccess(sourcePeer.session, base, null)).json(),
  ).toMatchObject({ conversations: [], archivedConversations: [] });
  const demoteSelf = {
    kind: "set_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: owner.userId,
    role: "editor",
  };
  const demotions = await Promise.all([
    requestAccess(owner.session, sourcePath, demoteSelf),
    requestAccess(owner.session, sourcePath, demoteSelf),
  ]);
  for (const response of demotions) {
    expect(await response.json()).toEqual({
      kind: "accepted",
      accessRevision: 2,
    });
  }
  expect(
    await (await requestAccess(owner.session, sourcePath, demoteSelf)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 2 });
  expect(
    (
      await requestAccess(owner.session, sourcePath, {
        ...demoteSelf,
        role: "owner",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await requestAccess(owner.session, sourcePath, {
        ...demoteSelf,
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 2,
        role: "owner",
      })
    ).status,
  ).toBe(409);
  const leave = {
    kind: "remove_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: owner.userId,
  };
  expect(
    await (await requestAccess(owner.session, destinationPath, leave)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 2 });
  expect(
    await (await requestAccess(owner.session, destinationPath, leave)).json(),
  ).toEqual({ kind: "accepted", accessRevision: 2 });
  expect(
    (await requestAccess(owner.session, destinationPath, null)).status,
  ).toBe(404);
  expect(
    (await requestAccess(owner.session, conversationPath, null)).status,
  ).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisationId, destinationPeer.userId)
    .run();
  expect(
    (await requestAccess(destinationPeer.session, base, null)).status,
  ).toBe(404);
  expect(
    (await requestAccess(destinationPeer.session, destinationPath, null))
      .status,
  ).toBe(404);
  expect(
    (
      await requestAccess(destinationPeer.session, destinationPath, {
        kind: "set_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 2,
        userId: sourcePeer.userId,
        role: "viewer",
      })
    ).status,
  ).toBe(404);
  expect(
    (await requestAccess(destinationPeer.session, conversationPath, null))
      .status,
  ).toBe(404);
  expect(
    (
      await requestAccess(destinationPeer.session, conversationPath, {
        kind: "move_shared_conversation",
        operationId: crypto.randomUUID(),
        projectId: sourceId,
        expectedRevision: 3,
        expectedProjectAccessRevision: 2,
      })
    ).status,
  ).toBe(404);
  Object.assign(context.task.meta, {
    plan54: {
      scenario: "shared-project-transitions",
      explicitMoveAudience: true,
      sourceOnlyOwnerDenied: true,
      formerAudiencePurged: true,
      ownershipChangeRetries: true,
      simultaneousOwnershipChangeRetries: true,
      changedRetryRejected: true,
      organisationPolicyPreserved: true,
    },
  });
}

async function sharedConversationJourney(context: TestContext): Promise<void> {
  const organisationId = newOrganisationId();
  await insertOrganisation(organisationId, "Shared conversations");
  await insertDefaultProject(fixtureDatabase(), organisationId);
  const owner = await createMember(organisationId, "Conversation owner");
  const editor = await createMember(organisationId, "Conversation editor");
  const viewer = await createMember(organisationId, "Conversation viewer");
  const outsider = await createMember(organisationId, "Unrelated colleague");
  await assignOwner(organisationId, owner);
  const projectId = newProjectId();
  await fixtureDatabase()
    .prepare(
      `INSERT INTO project
    (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'Launch team', '', '[]', 1, 1, ?, ?)`,
    )
    .bind(organisationId, owner.userId, projectId, Date.now(), Date.now())
    .run();
  const projectPath = `/v1/control/organisations/${organisationId}/projects/${projectId}/access`;
  expect(
    (
      await requestAccess(owner.session, projectPath, {
        kind: "share_project",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 0,
        members: [
          { userId: editor.userId, role: "editor" },
          { userId: viewer.userId, role: "viewer" },
        ],
      })
    ).status,
  ).toBe(200);
  const scope = { organisationId, userId: owner.userId };
  const conversationId = newConversationId();
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        platformConversation(conversationId, "Private capacity review"),
        0,
        { projectId },
      )
    ).kind,
  ).toBe("saved");
  const chatPath = `/v1/control/organisations/${organisationId}/chat`;
  const accessPath = `${chatPath}/conversations/${conversationId}/access`;
  expect((await requestAccess(editor.session, accessPath, null)).status).toBe(
    404,
  );
  const privateDirectory = await (
    await requestAccess(editor.session, chatPath, null)
  ).json();
  expect(privateDirectory).toMatchObject({ conversations: [] });
  const share = {
    kind: "share_conversation",
    operationId: crypto.randomUUID(),
    projectId,
    expectedRevision: 1,
    expectedProjectAccessRevision: 1,
  };
  expect(
    await (await requestAccess(owner.session, accessPath, share)).json(),
  ).toEqual({ kind: "accepted", revision: 2 });
  expect(
    await (await requestAccess(owner.session, accessPath, share)).json(),
  ).toEqual({ kind: "accepted", revision: 2 });
  expect((await requestAccess(editor.session, accessPath, null)).status).toBe(
    200,
  );
  expect((await requestAccess(viewer.session, accessPath, null)).status).toBe(
    200,
  );
  expect((await requestAccess(outsider.session, accessPath, null)).status).toBe(
    404,
  );
  expect(
    await conversationCaseIdentity(
      fixtureDatabase(),
      { organisationId, userId: editor.userId },
      conversationId,
    ),
  ).toBe(
    await conversationCaseIdentity(fixtureDatabase(), scope, conversationId),
  );
  const conversationPath = `${chatPath}/conversations/${conversationId}`;
  expect(
    (
      await requestChatApi(editor.session, `${conversationPath}/draft`, "PUT", {
        draft: "My private plan",
        expectedUpdatedAt: null,
      })
    ).status,
  ).toBe(200);
  expect(
    (await readConversation(fixtureDatabase(), scope, conversationId))
      ?.conversation.draftText,
  ).toBe("");
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        { organisationId, userId: editor.userId },
        conversationId,
      )
    )?.conversation.draftText,
  ).toBe("My private plan");
  expect(
    (
      await requestChatApi(owner.session, conversationPath, "PATCH", {
        action: "pin",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await requestChatApi(owner.session, conversationPath, "PATCH", {
        action: "archive",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(200);
  const own = await readConversation(fixtureDatabase(), scope, conversationId);
  const peer = await readConversation(
    fixtureDatabase(),
    { organisationId, userId: editor.userId },
    conversationId,
  );
  expect(own?.metadata.lifecycle).toBe("archived");
  expect(peer?.metadata).toEqual({ lifecycle: "active", pinnedAt: null });
  expect(peer?.revision).toBe(2);
  expect(
    (
      await requestChatApi(editor.session, conversationPath, "PATCH", {
        action: "delete",
        operationId: crypto.randomUUID(),
        expectedRevision: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await requestChatApi(owner.session, conversationPath, "PATCH", {
        action: "restore",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(200);
  const directory = await readProjectDirectory(fixtureDatabase(), {
    organisationId,
    userId: editor.userId,
  });
  const move = {
    kind: "move_chat",
    operationId: crypto.randomUUID(),
    expectedDirectoryRevision: directory.revision,
    conversationId,
    expectedMembershipRevision: 2,
    destination: { projectId },
    insertion: { kind: "end" },
  };
  expect(
    (await requestAccess(editor.session, `${chatPath}/projects`, move)).status,
  ).toBe(200);
  expect(
    (
      await requestAccess(editor.session, `${chatPath}/projects`, {
        ...move,
        operationId: crypto.randomUUID(),
        destination: {
          projectId: await requireDefaultProjectId(
            fixtureDatabase(),
            organisationId,
          ),
        },
      })
    ).status,
  ).toBe(409);
  const parsedSession = parseSessionId(`session_shared_${crypto.randomUUID()}`);
  if (!parsedSession.ok) throw new Error(parsedSession.error.code);
  const sessionId = parsedSession.value;
  const turnId = "turn_shared_review";
  if (peer === null) throw new Error("Shared conversation disappeared");
  const running: Conversation = {
    ...peer.conversation,
    work: {
      kind: "running",
      requestId: "shared_review",
      lease: "shared_review",
      expiresAt: Date.now() + 60000,
      stream: { step: 0, sessionId, turnId },
    },
  };
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, organisationId),
        editor.userId,
        running,
        2,
      )
    ).kind,
  ).toBe("saved");
  await bindConversationTurnAccess(
    fixtureDatabase(),
    { organisationId, userId: editor.userId },
    conversationId,
    sessionId,
    turnId,
    editor.session.session.controlSessionId,
  );
  expect(
    await authorizeChatTurnAccess(
      fixtureDatabase(),
      organisationId,
      sessionId,
      turnId,
      editor.userId,
    ),
  ).toBe(true);
  expect(
    await authorizeChatTurnAccess(
      fixtureDatabase(),
      organisationId,
      sessionId,
      turnId,
      owner.userId,
    ),
  ).toBe(false);
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        running,
        3,
      )
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, organisationId),
        viewer.userId,
        running,
        3,
      )
    ).kind,
  ).toBe("conflict");
  expect(
    await (
      await requestAccess(owner.session, projectPath, {
        kind: "set_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 1,
        userId: outsider.userId,
        role: "viewer",
      })
    ).json(),
  ).toMatchObject({ kind: "rejected", code: "chat_running" });
  expect(
    (
      await requestAccess(owner.session, projectPath, {
        kind: "remove_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 1,
        userId: editor.userId,
      })
    ).status,
  ).toBe(200);
  expect(
    await authorizeChatTurnAccess(
      fixtureDatabase(),
      organisationId,
      sessionId,
      turnId,
      editor.userId,
    ),
  ).toBe(false);
  expect((await requestAccess(editor.session, accessPath, null)).status).toBe(
    404,
  );
  expect(
    await readConversation(
      fixtureDatabase(),
      { organisationId, userId: editor.userId },
      conversationId,
    ),
  ).toBeNull();
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
      )
      .bind(organisationId, conversationId)
      .first("count"),
  ).toBe(1);
  Object.assign(context.task.meta, {
    plan54: {
      scenario: "canonical-shared-conversation",
      privateByDefault: true,
      noPrivateTitleLeak: true,
      independentArchivePinDraft: true,
      canonicalActorAddress: true,
      currentContributorAuthority: true,
      viewerWriteDenied: true,
      competingContributorBusy: true,
      activeMemberAdmissionBusy: true,
      liveTurnRevocation: true,
    },
  });
}

async function requestChatApi(
  session: IssuedControlSession,
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method,
    headers: {
      origin: "https://localhost",
      cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      "x-pantry-csrf": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function directoryProjectId(project: { readonly id: string }): string {
  return project.id;
}

/**
 * An Organisation row and its placement in its own database and in the
 * global one. The journey picks the id, so it does not use onboarding.
 */
async function insertOrganisation(
  organisationId: OrganisationId,
  name: string,
): Promise<void> {
  const now = Date.now();
  for (const database of new Set([env.DB, fixtureDatabase()]))
    await database
      .prepare(
        "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, ?, ?)",
      )
      .bind(organisationId, name, now)
      .run();
  const placement = parseOrganisationPlacementProfile(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  const installed = await ensureInitialOrganisationPlacement({
    db: organisationDatabase(organisationId, placement.value.placementCellId),
    organisationId,
    placement: placement.value,
    environment: "development",
    now,
  });
  if (!installed.ok) throw new Error(installed.error.code);
  await publishGlobalOrganisation(
    organisationId,
    placement.value.placementCellId,
  );
}
