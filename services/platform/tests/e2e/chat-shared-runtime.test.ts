import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import {
  parseChatSummary,
  type ChatConversationSummary,
} from "@purin-labs/control-api/portal/chat";
import {
  organisationDatabase,
  fixtureDatabase,
  onboardFixtureOrganisation,
} from "./organisation-database";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { isRecord } from "@purin-labs/std";
import {
  newSlackOrganisationConnectionId,
  parseSessionId,
  parseSlackInstallationId,
} from "@purin-labs/kernel/ids";
import { createOrganisationInstall } from "@purin-labs/tenancy/data/organisation";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/domain";
import { resolveActiveSlackOrganisationCredential } from "@purin-labs/authority/credential-vault/surface-installation-resolution";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import { createSlackOrganisationConnection } from "@purin-labs/authority/slack/installation-store";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, vi, type TestContext } from "vitest";
import type { SessionDO } from "../../src/actors/agent-session";
import {
  archiveOrganisation,
  restoreOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  listOrganisationActorRegistryEntries,
  type ActorRegistryEntry,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import type { OrganisationDO } from "../../src/actors/organisation";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { readOrganisationHarnessErasureReceipts } from "../../src/data/onboarding-reconciliation";
import {
  readOrganisationArchiveCleanup,
  type OrganisationArchiveCleanupRequest,
} from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import type { SessionId } from "@purin-labs/kernel/ids";
import { readPortalChatErasure } from "@purin-labs/agent/actors/portal-chat-cleanup";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { http, type HttpResponseResolver } from "msw";
import {
  isConversationId,
  newProjectId,
  newConversationId,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { readConversation, saveConversation } from "../../src/chat/store";
import { readProjectDirectory } from "../../src/chat/projects";
import { requireDefaultProjectId } from "../fixtures/default-project";
import { conversationCaseIdentity } from "../../src/chat/conversation-access";
import {
  authorizeChatTurnAccess,
  readAdmittedChatInput,
} from "../../src/chat/turn-access";
import { readChatControlAuthority } from "../../src/chat/information-flow";
import { observeProjectReference } from "../../src/projects/references";
import { platformConversation } from "./chat-journey-support";
import { commerceClient } from "./commerce-support";
import {
  installSlackActorFixture,
  openRouterText,
  OTHER_WORKSPACE_ID,
  requiredPlacement,
  ORGANISATION_ID,
  WORKSPACE_ID,
} from "./slack-journey-support";
import { network } from "./network";
import {
  executionShape,
  listExecutionCases,
  readCaseExecution,
  verifyChatCaseExecution,
  verifyExecutionHidden,
} from "./case-execution-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";

it(
  "shares accepted Actor history, attributes a peer turn, restores history, rejects an incompatible member, and revokes a running contributor",
  sharedRuntimeJourney,
  100000,
);

type Member = Readonly<{
  userId: UserId;
  personId: string;
  session: IssuedControlSession;
}>;
type Provider = {
  calls: number;
  paused: boolean;
  started: PromiseWithResolvers<void>;
  resume: PromiseWithResolvers<void>;
  prompts: string[];
};

async function sharedRuntimeJourney(context: TestContext): Promise<void> {
  // The Slack fixture makes the one account attach of the Organisation; it
  // admits the four people of this journey before they get their roles.
  const people = [
    await person("Owner"),
    await person("Editor"),
    await person("Viewer"),
    await person("Excluded"),
  ] as const;
  await installSlackActorFixture();
  const owner = await member(people[0]);
  const editor = await member(people[1]);
  const viewer = await member(people[2]);
  const excluded = await member(people[3]);
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(ORGANISATION_ID, excluded.userId)
    .run();
  await fixtureDatabase().prepare(
    "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_shared', activated_at = ? WHERE organisation_id = ?",
  )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  for (const user of [owner, editor, viewer]) await grantHistory(user);
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
  const provider: Provider = {
    calls: 0,
    paused: true,
    started: Promise.withResolvers(),
    resume: Promise.withResolvers(),
    prompts: [],
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      reply.bind(null, provider),
    ),
  );
  const privateConversationId = newConversationId();
  const scope = { organisationId: ORGANISATION_ID, userId: owner.userId };
  const privateRetainedAddress = `${ORGANISATION_ID}:portal-chat:retained_owner:retained_chat`;
  await saveConversation(
    await requireOrganisationExecutionScope(env, scope.organisationId),
    scope.userId,
    platformConversation(
      privateConversationId,
      "Private biscuit",
      PLATFORM_DEFAULT_PI_MODEL,
    ),
    0,
  );
  // Retained canonical roots keep their original Actor address after an ID cutover.
  await fixtureDatabase().prepare(
    "UPDATE portal_conversation SET state_json = json_set(state_json, '$.actorIdentity', ?) WHERE organisation_id = ? AND conversation_id = ?",
  )
    .bind(privateRetainedAddress, ORGANISATION_ID, privateConversationId)
    .run();
  expect(
    (
      await send(
        owner,
        privateConversationId,
        "owner_request",
        "Record the iridescent biscuit code.",
      )
    ).status,
  ).toBe(200);
  await provider.started.promise;
  const workingSummary = await sidebarSummary(owner, privateConversationId);
  expect(workingSummary.activity).toBe("working");
  provider.paused = false;
  provider.resume.resolve();
  await expect
    .poll(workKind.bind(null, owner, privateConversationId), { timeout: 20000 })
    .toBe("ready");
  const completedSummary = await sidebarSummary(owner, privateConversationId);
  expect(completedSummary.activity).toBe("idle");
  expect(completedSummary.latestSequence).toBeGreaterThan(
    completedSummary.lastReadSequence,
  );
  expect(
    (
      await post(
        owner,
        `/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${privateConversationId}/read`,
        {
          sequence: completedSummary.latestSequence,
        },
      )
    ).status,
  ).toBe(200);
  const viewedSummary = await sidebarSummary(owner, privateConversationId);
  expect(viewedSummary.lastReadSequence).toBe(viewedSummary.latestSequence);
  provider.started = Promise.withResolvers();
  provider.resume = Promise.withResolvers();
  const privateOriginal = await readConversation(
    fixtureDatabase(),
    scope,
    privateConversationId,
  );
  if (
    privateOriginal === null ||
    privateOriginal.conversation.historyBindings.length === 0
  )
    throw new Error("Accepted Actor history is missing");
  const privateInput = await acceptedInputEvidence(
    owner,
    privateConversationId,
  );
  expect(privateInput.label.policies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        readers: [{ kind: "person", personId: owner.personId }],
      }),
    ]),
  );
  const projectId = newProjectId();
  const base = `/v1/control/organisations/${ORGANISATION_ID}/chat`;
  const projects = `/v1/control/organisations/${ORGANISATION_ID}/projects`;
  expect(
    (
      await post(owner, projects, {
        kind: "create_project",
        operationId: crypto.randomUUID(),
        projectId,
        content: {
          name: "Shared launch",
          brief: "Prepare the launch together.",
          references: [],
        },
      })
    ).status,
  ).toBe(200);
  const projectAccess = `${projects}/${projectId}/access`;
  expect(
    (
      await post(owner, projectAccess, {
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
  const privateShare = await post(
    owner,
    `${base}/conversations/${privateConversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: privateOriginal.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    },
  );
  expect(await privateShare.json()).toMatchObject({
    kind: "rejected",
    code: "chat_history_forbidden",
    reason: "source_policy_denied",
  });
  expect(
    await readConversation(
      fixtureDatabase(),
      { organisationId: ORGANISATION_ID, userId: editor.userId },
      privateConversationId,
    ),
  ).toBeNull();
  const conversationId = newConversationId();
  const retainedAddress = `${ORGANISATION_ID}:portal-chat:retained_owner:retained_shared_chat`;
  await saveConversation(
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    owner.userId,
    platformConversation(conversationId, "Shared launch", PLATFORM_DEFAULT_PI_MODEL),
    0,
  );
  await fixtureDatabase().prepare(
    "UPDATE portal_conversation SET state_json = json_set(state_json, '$.actorIdentity', ?) WHERE organisation_id = ? AND conversation_id = ?",
  )
    .bind(retainedAddress, ORGANISATION_ID, conversationId)
    .run();
  const original = await readConversation(fixtureDatabase(), scope, conversationId);
  if (original === null) throw new Error("Shared candidate missing");
  const sharingPath = `${base}/conversations/${conversationId}/access`;
  const shareCommand = {
    kind: "share_conversation",
    operationId: crypto.randomUUID(),
    expectedRevision: original.revision,
    projectId,
    expectedProjectAccessRevision: 1,
  };
  const simultaneousShares = await Promise.all([
    post(owner, sharingPath, shareCommand),
    post(owner, sharingPath, shareCommand),
  ]);
  for (const shared of simultaneousShares) {
    expect(await shared.clone().json()).toMatchObject({
      kind: "accepted",
      revision: original.revision + 1,
    });
    expect(shared.status).toBe(200);
  }
  expect(
    (await readConversation(fixtureDatabase(), scope, conversationId))?.revision,
  ).toBe(original.revision + 1);
  expect(
    (
      await send(
        owner,
        conversationId,
        "owner_shared_request",
        "Plan our shared launch.",
      )
    ).status,
  ).toBe(200);
  try {
    await expect
      .poll(storedWorkKind.bind(null, scope, conversationId), {
        timeout: 20000,
      })
      .toBe("ready");
  } catch {
    const failed = await readConversation(fixtureDatabase(), scope, conversationId);
    throw new Error(
      JSON.stringify({
        work: failed?.conversation.work,
        lastEvent: failed?.conversation.timeline.at(-1),
      }),
    );
  }
  const sharedInput = await acceptedInputEvidence(owner, conversationId);
  expect(sharedInput.label.policies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        readers: [
          {
            kind: "chat_conversation",
            organisationId: ORGANISATION_ID,
            conversationId,
          },
        ],
      }),
    ]),
  );
  expect(sharedInput.audience.surface).toBe("shared");
  expect(sharedInput.audience.recipients).toHaveLength(3);
  const identities = await deriveDirectCaseIdentities(retainedAddress);
  if (!identities.ok) throw new Error(identities.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const caseSnapshot = await caseActor.value.inspect();
  if (!caseSnapshot.ok) throw new Error(caseSnapshot.error.code);
  const entry = caseSnapshot.value.entries.at(-1);
  if (entry === undefined) throw new Error("Accepted Case entry missing");
  const reference = {
    kind: "case_entry" as const,
    caseId: identities.value.caseId,
    entryId: entry.entryId,
    label: "Shared launch history",
  };
  for (const user of [owner, editor, viewer]) {
    expect(
      (await jsonGet(user, `${projects}/references?search=shared`)).references,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "case_entry",
          caseId: reference.caseId,
          entryId: reference.entryId,
        }),
      ]),
    );
    expect(
      await observeProjectReference(
        env,
        await requireOrganisationExecutionScope(env, ORGANISATION_ID),
        { organisationId: ORGANISATION_ID, userId: user.userId },
        reference,
        Date.now(),
      ),
    ).toMatchObject({ kind: "available" });
  }
  const peer = await jsonGet(
    editor,
    `${base}?conversation=${conversationId}&observe=true`,
  );
  expect(peer.conversation).toMatchObject({
    sharing: { visibility: "shared", role: "editor" },
    timeline: expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant",
        text: "Accepted shared response 2.",
      }),
    ]),
  });
  expect(
    await conversationCaseIdentity(
      fixtureDatabase(),
      { organisationId: ORGANISATION_ID, userId: editor.userId },
      conversationId,
    ),
  ).toBe(await conversationCaseIdentity(fixtureDatabase(), scope, conversationId));
  expect(
    (await send(viewer, conversationId, "viewer_request", "A forbidden write."))
      .status,
  ).toBe(403);
  expect(
    (
      await send(
        editor,
        conversationId,
        "editor_request",
        "Continue our launch with your accepted history.",
      )
    ).status,
  ).toBe(200);
  await expect
    .poll(storedWorkKind.bind(null, scope, conversationId), { timeout: 20000 })
    .toBe("ready");
  const newReplySummary = await sidebarSummary(owner, conversationId);
  expect(newReplySummary.activity).toBe("idle");
  expect(newReplySummary.latestSequence).toBeGreaterThan(
    newReplySummary.lastReadSequence,
  );
  const contributed = await readConversation(fixtureDatabase(), scope, conversationId);
  const sharedCase = await fixtureDatabase().prepare(
    "SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
  )
    .bind(ORGANISATION_ID, conversationId)
    .first<{ case_id: string }>();
  if (sharedCase === null) throw new Error("Missing shared chat Case");
  const sharedSnapshot = await caseActor.value.inspect();
  if (!sharedSnapshot.ok) throw new Error(sharedSnapshot.error.code);
  const sharedExecution = await verifyChatCaseExecution({
    organisationId: ORGANISATION_ID,
    caseId: sharedCase.case_id,
    readers: [owner.session, editor.session, viewer.session],
    canonical: sharedSnapshot.value,
    lastTurn: {
      input: "Continue our launch with your accepted history.",
      reply: `Accepted shared response ${provider.calls}.`,
    },
  });
  // A member who may not open the chat gets the answer of a missing Case.
  const firstSharedNode = sharedExecution.full.nodes[0];
  if (firstSharedNode === undefined) throw new Error("Empty execution");
  const hiddenExecution = await verifyExecutionHidden(
    ORGANISATION_ID,
    excluded.session,
    sharedCase.case_id,
    firstSharedNode.nodeId,
  );
  // The owner's private chat is the owner's alone, also for a member of the
  // shared Project.
  const privateCase = await fixtureDatabase().prepare(
    "SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
  )
    .bind(ORGANISATION_ID, privateConversationId)
    .first<{ case_id: string }>();
  if (privateCase === null) throw new Error("Missing private chat Case");
  const privateExecution = await readCaseExecution(
    ORGANISATION_ID,
    owner.session,
    privateCase.case_id,
    100,
  );
  expect(executionShape(privateExecution)).toEqual({
    open: { trigger: 1, assignment: 1, proposal: 1, turn: 1, attempt: 1 },
    withheld: {},
    edges: 4,
  });
  const privateNode = privateExecution.nodes[0];
  if (privateNode === undefined) throw new Error("Empty private execution");
  await verifyExecutionHidden(
    ORGANISATION_ID,
    editor.session,
    privateCase.case_id,
    privateNode.nodeId,
  );
  // Each person's list holds the chats that person can open.
  const listed = {
    owner: await listExecutionCases(ORGANISATION_ID, owner.session),
    editor: await listExecutionCases(ORGANISATION_ID, editor.session),
    excluded: await listExecutionCases(ORGANISATION_ID, excluded.session),
  };
  expect(listed.owner.cases?.map((entry) => entry.caseId).sort()).toEqual(
    [sharedCase.case_id, privateCase.case_id].sort(),
  );
  expect(listed.editor.cases?.map((entry) => entry.caseId)).toEqual([
    sharedCase.case_id,
  ]);
  expect(listed.excluded).toEqual({ status: 404, cases: null });
  const binding = contributed?.conversation.historyBindings.at(-1);
  if (binding === undefined) throw new Error("Peer accepted history missing");
  const sessionId = parseSessionId(binding.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  await evictDurableObject(actor.value);
  // The projection is rebuilt from the records: after the Session's
  // instance and then the Case's instance are replaced, it is the same.
  expect(
    await readCaseExecution(
      ORGANISATION_ID,
      viewer.session,
      sharedCase.case_id,
      100,
    ),
  ).toEqual(sharedExecution.full);
  await evictDurableObject(caseActor.value);
  expect(
    await readCaseExecution(
      ORGANISATION_ID,
      owner.session,
      sharedCase.case_id,
      100,
    ),
  ).toEqual(sharedExecution.full);
  Object.assign(context.task.meta, {
    caseExecution: {
      substituted: ["model provider (deterministic OpenRouter transport)"],
      shared: {
        caseId: sharedCase.case_id,
        readers: ["owner", "editor", "viewer"],
        shape: executionShape(sharedExecution.full),
        limitations: sharedExecution.full.limitations,
        nodes: sharedExecution.full.nodes,
        edges: sharedExecution.full.edges,
        details: sharedExecution.details,
        paging: sharedExecution.paging,
        sameAfterActorReplacement: ["Session", "Case"],
      },
      excludedMember: hiddenExecution,
      privateChat: {
        caseId: privateCase.case_id,
        shape: executionShape(privateExecution),
        otherMember: 404,
      },
      listed: {
        owner: listed.owner.cases?.length,
        editor: listed.editor.cases?.length,
        excluded: listed.excluded.status,
      },
    },
  });
  expect(
    (
      await jsonGet(
        viewer,
        `${base}?conversation=${conversationId}&observe=true`,
      )
    ).conversation,
  ).toMatchObject({
    timeline: expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant",
        text: "Accepted shared response 3.",
      }),
    ]),
  });
  const admitted = await fixtureDatabase().prepare(
    "SELECT actor_user_id FROM session_turn_access WHERE organisation_id = ? AND turn_id = ?",
  )
    .bind(ORGANISATION_ID, binding.turnId)
    .first<{ actor_user_id: string }>();
  expect(admitted?.actor_user_id).toBe(editor.userId);
  const forkResponse = await patch(
    viewer,
    `${base}/conversations/${conversationId}`,
    {
      action: "fork",
      operationId: crypto.randomUUID(),
      messageId: binding.responseId,
    },
  );
  const forkRaw: unknown = await forkResponse.json();
  if (
    !isRecord(forkRaw) ||
    forkRaw.kind !== "ready" ||
    !isConversationId(forkRaw.conversationId)
  )
    throw new Error(`Shared-history fork failed: ${JSON.stringify(forkRaw)}`);
  const forkId = forkRaw.conversationId;
  expect(await readConversation(fixtureDatabase(), scope, forkId)).toBeNull();
  expect(
    (await send(viewer, forkId, "fork_request", "Continue my private fork."))
      .status,
  ).toBe(200);
  await expect
    .poll(workKind.bind(null, viewer, forkId), { timeout: 20000 })
    .toBe("ready");
  const fork = await readConversation(
    fixtureDatabase(),
    { organisationId: ORGANISATION_ID, userId: viewer.userId },
    forkId,
  );
  const forkBinding = fork?.conversation.historyBindings.at(-1);
  if (forkBinding === undefined)
    throw new Error("Fork accepted history missing");
  const forkSessionId = parseSessionId(forkBinding.sessionId);
  if (!forkSessionId.ok) throw new Error(forkSessionId.error.code);
  const forkActor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: forkSessionId.value,
    now: Date.now(),
  });
  if (!forkActor.ok) throw new Error(forkActor.error.code);
  const forkObjects = await forkActor.value.inspectHarnessHistoryReferences({
    requestingOrganisationId: ORGANISATION_ID,
  });
  if (!forkObjects.ok || forkObjects.value.length === 0)
    throw new Error("Fork session objects missing");
  const ownDirectory = await readProjectDirectory(fixtureDatabase(), scope);
  expect(
    (
      await post(owner, `${base}/projects`, {
        kind: "set_project_placement",
        operationId: crypto.randomUUID(),
        expectedDirectoryRevision: ownDirectory.revision,
        projectId,
        position: 0,
        collapsed: true,
      })
    ).status,
  ).toBe(200);
  expect((await readProjectDirectory(fixtureDatabase(), scope)).placements).toEqual([
    { projectId, position: 0, collapsed: true },
  ]);
  expect(
    (
      await readProjectDirectory(fixtureDatabase(), {
        organisationId: ORGANISATION_ID,
        userId: viewer.userId,
      })
    ).placements,
  ).toEqual([]);
  const deletion = {
    kind: "delete_project",
    operationId: crypto.randomUUID(),
    projectId,
    expectedProjectRevision: 1,
    expectedAccessRevision: 1,
  };
  expect(await (await post(owner, projects, deletion)).json()).toMatchObject({
    kind: "rejected",
    code: "project_contains_shared_chats",
  });
  const privateId = newConversationId();
  const privateState = contributed?.conversation;
  if (privateState === undefined)
    throw new Error("Missing conversation template");
  await saveConversation(
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    viewer.userId,
    {
      ...privateState,
      id: privateId,
      title: "Viewer private plan",
      timeline: [],
      historyBindings: [],
      lineage: { kind: "original" },
      documents: [],
      completedRequests: [],
      latestSequence: 0,
      lastReadSequence: 0,
      work: { kind: "ready" },
    },
    0,
    { projectId },
  );
  const denied = await post(owner, projectAccess, {
    kind: "set_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: excluded.userId,
    role: "viewer",
  });
  expect(await denied.json()).toMatchObject({
    kind: "rejected",
    code: "chat_history_forbidden",
  });
  const revokedResponse = `Accepted shared response ${provider.calls + 1}.`;
  provider.paused = true;
  expect(
    (
      await send(
        editor,
        conversationId,
        "revoked_request",
        "Hold this response until access changes.",
      )
    ).status,
  ).toBe(200);
  await provider.started.promise;
  const running = await readConversation(fixtureDatabase(), scope, conversationId);
  if (running?.conversation.work.kind !== "running")
    throw new Error("Expected the peer run to be active");
  const stream = running.conversation.work.stream;
  const subscription = await exports.default.fetch(
    `https://localhost${base}/stream?conversation=${conversationId}&request=revoked_request`,
    { headers: { cookie: `pantry_session=${editor.session.token}` } },
  );
  expect(subscription.status).toBe(200);
  const streamed = subscription.text();
  expect(
    (
      await post(owner, projectAccess, {
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
      ORGANISATION_ID,
      stream.sessionId,
      stream.turnId,
      editor.userId,
    ),
  ).toBe(false);
  provider.resume.resolve();
  const delivered = await streamed;
  expect(delivered).not.toContain(revokedResponse);
  await expect
    .poll(storedWorkKind.bind(null, scope, conversationId), { timeout: 20000 })
    .toBe("failed");
  const remaining = await readConversation(fixtureDatabase(), scope, conversationId);
  expect(JSON.stringify(remaining?.conversation.timeline)).not.toContain(
    revokedResponse,
  );
  const removed = await jsonGet(
    editor,
    `${base}?conversation=${conversationId}&observe=true`,
  );
  expect(removed.conversation).toBeNull();
  const remainingView = await jsonGet(
    viewer,
    `${base}?conversation=${conversationId}&observe=true`,
  );
  expect(remainingView.conversation).toMatchObject({
    timeline: expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant",
        text: "Accepted shared response 2.",
      }),
    ]),
  });
  if (remaining === null) throw new Error("Stopped chat missing");
  expect(
    (
      await post(owner, projectAccess, {
        kind: "set_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 2,
        userId: viewer.userId,
        role: "owner",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(viewer, projectAccess, {
        kind: "remove_project_member",
        operationId: crypto.randomUUID(),
        expectedAccessRevision: 3,
        userId: owner.userId,
      })
    ).status,
  ).toBe(200);
  expect(
    (await jsonGet(owner, `${projects}/references?search=shared`)).references,
  ).toEqual([]);
  expect(
    await observeProjectReference(
      env,
      await requireOrganisationExecutionScope(env, scope.organisationId),
      scope,
      reference,
      Date.now(),
    ),
  ).toMatchObject({ kind: "unavailable" });
  const retainedSession = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!retainedSession.ok) throw new Error(retainedSession.error.code);
  const historyObjects =
    await retainedSession.value.inspectHarnessHistoryReferences({
      requestingOrganisationId: ORGANISATION_ID,
    });
  if (!historyObjects.ok || historyObjects.value.length === 0)
    throw new Error("Retained session objects missing before deletion");
  const finalRoot = await readConversation(
    fixtureDatabase(),
    { organisationId: ORGANISATION_ID, userId: viewer.userId },
    conversationId,
  );
  if (finalRoot === null) throw new Error("Final root history unavailable");
  expect(
    (
      await patch(viewer, `${base}/conversations/${conversationId}`, {
        action: "archive",
        expectedRevision: finalRoot.revision,
      })
    ).status,
  ).toBe(200);
  const deleteCommand = {
    action: "delete",
    operationId: crypto.randomUUID(),
    expectedRevision: finalRoot.revision,
  };
  // Fail D1 publication after the fork's Actor and R2 history have been erased.
  await fixtureDatabase().prepare(
    `CREATE TRIGGER interrupt_fork_deletion BEFORE DELETE ON portal_conversation
    WHEN OLD.conversation_id = '${forkId}'
    BEGIN SELECT RAISE(ABORT, 'Interrupted fork deletion acceptance'); END`,
  ).run();
  const forkCleanupRelocation = await cleanupRelocationRace(
    viewer,
    `${base}/conversations/${conversationId}`,
    deleteCommand,
    forkActor.value,
    forkSessionId.value,
    forkObjects.value,
    "complete",
  );
  const relocatedRoot = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!relocatedRoot.ok) throw new Error(relocatedRoot.error.code);
  expect(
    await relocatedRoot.value.erasePortalChatSession({
      requestingOrganisationId: ORGANISATION_ID,
      sessionId: sessionId.value,
      placement: forkCleanupRelocation.scope.placement,
      placementFenceToken: forkCleanupRelocation.scope.fenceToken,
      objectKeys: historyObjects.value,
    }),
  ).toEqual({ ok: false, error: { code: "chat_cleanup_conflict" } });
  expect(
    await relocatedRoot.value.inspectHarnessHistoryReferences({
      requestingOrganisationId: ORGANISATION_ID,
    }),
  ).toMatchObject({ ok: true, value: historyObjects.value });
  const interrupted = await patch(
    viewer,
    `${base}/conversations/${conversationId}`,
    deleteCommand,
  );
  expect(await interrupted.json()).toMatchObject({ kind: "failed" });
  expect(interrupted.status).toBe(503);
  for (const key of forkObjects.value)
    expect(await env.ARCHIVE.head(key)).toBeNull();
  expect(
    await readConversation(
      fixtureDatabase(),
      { organisationId: ORGANISATION_ID, userId: viewer.userId },
      forkId,
    ),
  ).toBeNull();
  const interruptedForkActor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: forkSessionId.value,
    now: Date.now(),
  });
  if (!interruptedForkActor.ok)
    throw new Error(interruptedForkActor.error.code);
  await evictDurableObject(interruptedForkActor.value);
  await fixtureDatabase().exec("DROP TRIGGER interrupt_fork_deletion");
  const rootCleanupRelocation = await cleanupRelocationRace(
    viewer,
    `${base}/conversations/${conversationId}`,
    deleteCommand,
    relocatedRoot.value,
    sessionId.value,
    historyObjects.value,
    "fail",
  );
  const deleted = await patch(
    viewer,
    `${base}/conversations/${conversationId}`,
    deleteCommand,
  );
  const deletedBody = await deleted.clone().json();
  expect(deletedBody, JSON.stringify(deletedBody)).toMatchObject({
    kind: "deleted",
  });
  expect(deleted.status).toBe(200);
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM portal_conversation WHERE organisation_id = ? AND conversation_id IN (?, ?)",
    )
      .bind(ORGANISATION_ID, conversationId, forkId)
      .first<number>("count"),
  ).toBe(0);
  expect(
    (
      await patch(
        viewer,
        `${base}/conversations/${conversationId}`,
        deleteCommand,
      )
    ).status,
  ).toBe(200);
  await evictDurableObject(retainedSession.value);
  const erasedSession = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!erasedSession.ok) throw new Error(erasedSession.error.code);
  expect(
    await erasedSession.value.inspectHarnessHistoryReferences({
      requestingOrganisationId: ORGANISATION_ID,
    }),
  ).toEqual({ ok: true, value: [] });
  for (const key of historyObjects.value)
    expect(await env.ARCHIVE.head(key)).toBeNull();
  for (const key of forkObjects.value)
    expect(await env.ARCHIVE.head(key)).toBeNull();
  expect(
    await readConversation(
      fixtureDatabase(),
      { organisationId: ORGANISATION_ID, userId: viewer.userId },
      forkId,
    ),
  ).toBeNull();
  expect(
    (
      await post(viewer, projects, {
        ...deletion,
        expectedAccessRevision: 4,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        { organisationId: ORGANISATION_ID, userId: viewer.userId },
        privateId,
      )
    )?.placement.projectId,
  ).toBe(await requireDefaultProjectId(fixtureDatabase(), ORGANISATION_ID));
  expect(await readConversation(fixtureDatabase(), scope, privateId)).toBeNull();
  const organisationArchiveCleanup =
    await organisationArchiveCleanupRace(owner);
  Object.assign(context.task.meta, {
    organisationArchiveCleanup,
    cleanupQuiescence: {
      liveR2: forkCleanupRelocation.evidence,
      interruptedR2: rootCleanupRelocation.evidence,
      retiredScopeAtCurrentActor: "rejected with accepted history preserved",
      freshDeletionRetry: "deleted",
    },
    sidebarActivity: {
      workingSummary,
      completedSummary,
      viewedSummary,
      newReplySummary,
    },
    plan54: {
      scenario: "accepted-shared-runtime",
      acceptedHistory: true,
      actingUser: editor.userId,
      stableCreatorAddress: true,
      retainedActorAddress: true,
      sharedCaseReferences: true,
      revokedCreatorReferencesDenied: true,
      retainedSessionErased: true,
      retainedHistoryObjectsErased: true,
      erasedHistoryObjectCount: historyObjects.value.length,
      simultaneousSharingRetry: true,
      acceptedSharingRevision: original.revision + 1,
      privateInputDisclosureDenied: true,
      nativeInputEvidence: { privateInput, sharedInput },
      restoredActor: true,
      viewerWriteDenied: true,
      incompatibleMemberDenied: true,
      liveTurnRevoked: true,
      revokedOutputWithheld: true,
      openSubscriptionRevoked: true,
      acceptedHistoryRetained: true,
      modelCalls: provider.calls,
      privateProjectPlacement: true,
      sharedDeletion: true,
      crossUserForkErasure: true,
      continuedPrivateFork: true,
      interruptedForkDeletionRetried: true,
      erasedForkHistoryObjectCount: forkObjects.value.length,
      privateChatDetachment: true,
    },
  });
}

async function organisationArchiveCleanupRace(owner: Member) {
  const peer = await connectArchivePeer(owner);
  const peerAccountId = peer.accountId;
  const peerOrganisationId = peer.organisationId;
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(ORGANISATION_ID, owner.userId)
    .run();
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const entries = await listOrganisationActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const organisationEntry = entries.value.find(
    isCurrentOrganisationActor.bind(null, scope.placement.placementEpoch),
  );
  if (organisationEntry === undefined)
    throw new Error("Missing current Organisation Actor");
  const routed = actorStub(
    env.ORGANISATION,
    organisationEntry.physicalObjectName,
    organisationEntry.placement,
  );
  const actor = env.ORGANISATION.get(routed.id);
  const nativeCheckpoints = (
    await env.ARCHIVE.list({
      prefix: `harness-checkpoints/${ORGANISATION_ID}/`,
    })
  ).objects;
  expect(nativeCheckpoints.length).toBeGreaterThan(0);
  const firstKey = nativeCheckpoints[0]?.key;
  if (firstKey === undefined)
    throw new Error("Missing native history checkpoint");
  const attachmentKey = `attachments/${ORGANISATION_ID}/slack/archive-purge`;
  const foreignKey = `attachments/${peerOrganisationId}/slack/preserved`;
  await env.ARCHIVE.put(attachmentKey, "Owned archive attachment");
  await env.ARCHIVE.put(foreignKey, "Other organisation attachment");
  const exports = await env.DB.prepare(
    "SELECT export_key AS objectKey FROM state_object_relocation_item WHERE export_key IS NOT NULL AND export_organisation_id = ?",
  )
    .bind(ORGANISATION_ID)
    .all<{ objectKey: string }>();
  expect(exports.results.length).toBeGreaterThan(0);
  const retained = [];
  for (const row of exports.results) {
    const object = await env.ARCHIVE.get(row.objectKey);
    if (object === null) throw new Error("Missing retained export");
    retained.push({ key: row.objectKey, etag: object.etag });
  }
  const version = await fixtureDatabase().prepare(
    "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
  )
    .bind(ORGANISATION_ID)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: scope,
    actorUserId: owner.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "p55-archive",
        requestHash: "p55-archive-request",
        expectedConfigurationVersion: version,
      },
      scope: {
        userId: owner.userId,
        organisationScope: ORGANISATION_ID,
        route: `/v1/control/organisations/${ORGANISATION_ID}/archive`,
        operation: "organisation.archive",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "p55-archive-owner",
        causationId: "p55-archive",
        now: Date.now(),
      }),
    },
  });
  if (!archived.ok) throw new Error(archived.error.code);
  const preparation = await actor.reconcileArchiveCleanup({
    organisationId: ORGANISATION_ID,
    placement: { placement: scope.placement, fenceToken: scope.fenceToken },
    now: Date.now(),
  });
  expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true });
  expect(
    await fixtureDatabase().prepare(
      "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
    )
      .bind(ORGANISATION_ID)
      .first("status"),
  ).toBe("pending_purge");
  const request = {
    organisationId: ORGANISATION_ID,
    placement: { placement: scope.placement, fenceToken: scope.fenceToken },
    now: archived.value.purgeAfter + 1,
  };
  const failed: CleanupR2Pause = {
    objectKeys: new Set([firstKey]),
    outcome: "fail",
    state: "waiting",
    resume: Promise.withResolvers(),
    original: null,
  };
  const paused: CleanupR2Pause = {
    objectKeys: new Set([attachmentKey]),
    outcome: "complete",
    state: "waiting",
    resume: Promise.withResolvers(),
    original: null,
  };
  await runInDurableObject(actor, installCleanupR2Pause.bind(null, failed));
  try {
    const erasureRace: RestoreErasureRace = {
      actor,
      request,
      pause: failed,
      phase: { kind: "waiting" },
    };
    const withSession = scope.database.withSession.bind(scope.database);
    const intercepted = vi
      .spyOn(scope.database, "withSession")
      .mockImplementation(
        interceptRestoreSession.bind(null, erasureRace, withSession),
      );
    let restored;
    try {
      restored = await restoreOrganisation({
        directory: env.DB,
        execution: scope,
        actorUserId: owner.userId,
        now: Date.now(),
        mutation: {
          boundary: {
            kind: "configuration_versioned",
            idempotencyKey: "p55-restore-during-purge",
            requestHash: "p55-restore-during-purge-request",
            expectedConfigurationVersion: archived.value.configurationVersion,
          },
          scope: {
            userId: owner.userId,
            organisationScope: ORGANISATION_ID,
            route: `/v1/control/organisations/${ORGANISATION_ID}/restore`,
            operation: "organisation.restore",
          },
          identity: newControlMutationIdentity({
            portalSubjectHash: "p55-archive-owner",
            causationId: "p55-restore-during-purge",
            now: Date.now(),
          }),
        },
      });
    } finally {
      intercepted.mockRestore();
    }
    expect(restored).toEqual({
      ok: false,
      error: { code: "organisation_purge_started" },
    });
    if (erasureRace.phase.kind !== "erasing")
      throw new Error("Restore never reached the erasure commit race");
    const purging = erasureRace.phase.purging;
    expect(await actor.reconcileArchiveCleanup(request)).toEqual({
      ok: false,
      error: { code: "organisation_archive_cleanup_conflict" },
    });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS count FROM control_mutation_receipt WHERE organisation_scope = ? AND idempotency_key = 'p55-restore-during-purge'",
      )
        .bind(ORGANISATION_ID)
        .first("count"),
    ).toBe(0);
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e-archive-cleanup",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.code);
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    const moving = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readArchiveBarrier.bind(null, actor), { timeout: 10000 })
      .toBe(true);
    await verifyArchiveMovePaused(
      started.value.relocationId,
      firstKey,
      scope.placement.placementEpoch,
    );
    expect(await actor.reconcileArchiveCleanup(request)).toEqual({
      ok: false,
      error: { code: "organisation_archive_cleanup_conflict" },
    });
    failed.resume.resolve();
    expect(await purging).toMatchObject({
      ok: false,
      error: { code: "organisation_archive_cleanup_failed" },
    });
    expect(await moving).toMatchObject({
      ok: false,
      error: { code: "actor_cleanup_failed" },
    });
    expect(
      await runInDurableObject(actor, archiveCleanupCheckpoint),
    ).toMatchObject({ pending: request, blocked: true });
    await runInDurableObject(actor, restoreCleanupR2.bind(null, failed));
    await evictDurableObject(actor);
    await runInDurableObject(actor, installCleanupR2Pause.bind(null, paused));
    const recovered = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(cleanupPauseState.bind(null, paused), { timeout: 10000 })
      .toBe("paused");
    await verifyArchiveMovePaused(
      started.value.relocationId,
      attachmentKey,
      scope.placement.placementEpoch,
    );
    expect(await env.ARCHIVE.head(firstKey)).toBeNull();
    const pending = await runInDurableObject(actor, archiveCleanupCheckpoint);
    expect(pending).toMatchObject({ pending: request, blocked: true });
    paused.resume.resolve();
    const result = await recovered;
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const receipts = await readOrganisationHarnessErasureReceipts(
      fixtureDatabase(),
      ORGANISATION_ID,
      request.now,
    );
    expect(receipts).toMatchObject({
      ok: true,
      value: { status: "completed" },
    });
    expect(
      await fixtureDatabase().prepare(
        "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
      )
        .bind(ORGANISATION_ID)
        .first("status"),
    ).toBe("purged");
    if (!receipts.ok) throw new Error(receipts.error.code);
    expect(receipts.value.sessionReceipts.length).toBeGreaterThan(2);
    for (const receipt of receipts.value.sessionReceipts)
      expect(receipt.status).toBe("erased");
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS count FROM organisation_harness_erasure_session WHERE organisation_id = ? AND lifecycle_status = 'retired'",
      )
        .bind(ORGANISATION_ID)
        .first<number>("count"),
    ).toBeGreaterThan(0);
    expect(await env.ARCHIVE.head(attachmentKey)).toBeNull();
    expect(await env.ARCHIVE.head(foreignKey)).not.toBeNull();
    const identity = resolveConfiguredSlackInstallationIdentity({
      deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
      appId: env.SLACK_APP_ID,
    });
    if (!identity.ok) throw new Error(identity.error.code);
    const peerCredential = await resolveActiveSlackOrganisationCredential({
      env,
      keys: env,
      organisationId: peerOrganisationId,
      integrationAccountId: peerAccountId,
      installationIdentity: identity.value,
      workspaceId: WORKSPACE_ID,
    });
    expect(peerCredential.ok).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT lifecycle FROM slack_organisation_connection WHERE connection_id = 'connection_e2e_slack_org'",
      ).first("lifecycle"),
    ).toBe("revoked");
    for (const table of [
      "portal_conversation",
      "project",
      "portal_chat_fork",
      "portal_chat_directory",
      "service_role_grant",
    ]) {
      expect(
        await fixtureDatabase().prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE organisation_id = ?`,
        )
          .bind(ORGANISATION_ID)
          .first<number>("count"),
      ).toBe(0);
    }
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    for (const object of retained)
      expect((await env.ARCHIVE.head(object.key))?.etag).toBe(object.etag);
    expect(await runInDurableObject(actor, archiveCleanupCheckpoint)).toEqual({
      pending: null,
      blocked: true,
    });
    await evictDurableObject(actor);
    expect(await actor.reconcileArchiveCleanup(request)).toMatchObject({
      ok: false,
      error: { code: "organisation_archive_cleanup_conflict" },
    });
    const current = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    expect(await current.reconcileArchiveCleanup(request)).toMatchObject({
      ok: false,
      error: { code: "organisation_archive_cleanup_conflict" },
    });
    const fresh = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
    expect(
      await current.reconcileArchiveCleanup({
        organisationId: ORGANISATION_ID,
        placement: { placement: fresh.placement, fenceToken: fresh.fenceToken },
        now: request.now,
      }),
    ).toEqual({ ok: true, value: 0 });
    return {
      pending,
      receipt: receipts.value,
      restoreDuringErasure:
        "erasure started after restore preflight; commit rejected without receipt",
      interruptedHarnessDeletion: "resumed after Organisation eviction",
      pausedAttachmentDeletion: "drained before export",
      retiredSessions: "erased with Actor fences",
      retiredScope: "rejected at source and target",
      replay: "fresh placement returned zero effects",
      retainedExports: retained,
      otherOrganisationObject: "preserved",
      sharedSlackInstallation:
        "peer credential resolves after organisation purge",
      organisationSlackConnection: "revoked",
      organisationChatAndMembership: "purged without foreign-key violations",
    };
  } finally {
    failed.resume.resolve();
    paused.resume.resolve();
    await runInDurableObject(
      actor,
      restoreCleanupR2.bind(null, paused.original === null ? failed : paused),
    );
  }
}

type RestoreErasureRace = {
  readonly actor: DurableObjectStub<OrganisationDO>;
  readonly request: OrganisationArchiveCleanupRequest;
  readonly pause: CleanupR2Pause;
  phase:
    | { kind: "waiting"; purging?: never }
    | {
        kind: "erasing";
        purging: ReturnType<
          DurableObjectStub<OrganisationDO>["reconcileArchiveCleanup"]
        >;
      };
};

function interceptRestoreSession(
  race: RestoreErasureRace,
  withSession: OrganisationDatabase["withSession"],
  constraint?: D1SessionBookmark | D1SessionConstraint,
): OrganisationDatabaseSession {
  const session = withSession(constraint);
  if (race.phase.kind === "waiting") {
    vi.spyOn(session, "batch").mockImplementationOnce(
      startErasureBeforeRestoreBatch.bind(
        null,
        race,
        session.batch.bind(session),
      ),
    );
  }
  return session;
}

async function startErasureBeforeRestoreBatch<T>(
  race: RestoreErasureRace,
  batch: D1DatabaseSession["batch"],
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  race.phase = {
    kind: "erasing",
    purging: race.actor.reconcileArchiveCleanup(race.request),
  };
  await expect
    .poll(cleanupPauseState.bind(null, race.pause), { timeout: 10000 })
    .toBe("paused");
  return batch<T>(statements);
}

async function connectArchivePeer(owner: Member) {
  const now = Date.now();
  // The peer onboards in the Portal, then installs Slack.
  const { organisationId: peerOrganisationId } =
    await onboardFixtureOrganisation("Archive peer");
  await createOrganisationInstall(organisationDatabase(peerOrganisationId), env.DB, {
    organisationId: peerOrganisationId,
    name: "Archive peer",
    surfaceKind: "slack",
    workspaceId: OTHER_WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: "vault:slack:bot:archive-peer",
    scopes: ["chat:write"],
    placement: requiredPlacement(),
    createdAt: now,
    installedAt: now,
  });
  const handle = parseVaultHandle("vault:slack:bot:e2e-actor");
  const installation = parseSlackInstallationId("installation_e2e_slack");
  if (!handle.ok || !installation.ok)
    throw new Error("Invalid shared installation fixture");
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: peerOrganisationId,
    provider: "slack",
    providerSubjectId: WORKSPACE_ID,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["chat:write"],
    createdByUserId: owner.userId,
    providerAccountId: WORKSPACE_ID,
    accountKind: "workspace",
    displayName: "Shared archive installation",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  await createSlackOrganisationConnection(env, {
    connectionId: newSlackOrganisationConnectionId(),
    installationId: installation.value,
    organisationId: peerOrganisationId,
    integrationAccountId: connected.account.integrationAccountId,
    connectedAt: now,
  });
  return {
    organisationId: peerOrganisationId,
    accountId: connected.account.integrationAccountId,
  };
}

function isCurrentOrganisationActor(
  epoch: number,
  entry: ActorRegistryEntry,
): boolean {
  return (
    entry.identity.objectKind === "organisation" &&
    entry.placement.placementEpoch === epoch &&
    entry.lifecycleStatus === "active"
  );
}

async function archiveCleanupCheckpoint(
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    pending:
      (await readOrganisationArchiveCleanup(state.storage))?.request ?? null,
    blocked:
      state.storage.sql
        .exec("SELECT 1 FROM state_object_policy_export_barrier")
        .toArray().length === 1,
  };
}

async function readArchiveBarrier(
  actor: DurableObjectStub<OrganisationDO>,
): Promise<boolean> {
  return (await runInDurableObject(actor, archiveCleanupCheckpoint)).blocked;
}

async function verifyArchiveMovePaused(
  relocationId: ActorRelocationId,
  objectKey: string,
  sourceEpoch: number,
): Promise<void> {
  expect(
    await env.DB.prepare(
      "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?",
    )
      .bind(ORGANISATION_ID, sourceEpoch)
      .first("status"),
  ).toBe("frozen");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
    )
      .bind(relocationId)
      .first<number>("count"),
  ).toBe(0);
  expect(await env.ARCHIVE.head(objectKey)).not.toBeNull();
}

async function reply(
  provider: Provider,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  provider.calls += 1;
  provider.prompts.push(JSON.stringify(await request.json()));
  if (provider.paused) {
    provider.started.resolve();
    await provider.resume.promise;
  }
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text:
        provider.calls === 1
          ? "Private biscuit recorded."
          : `Accepted shared response ${provider.calls}.`,
    }),
    `shared_${provider.calls}`,
  );
}
async function person(displayName: string) {
  const client = await commerceClient(`shared-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  return {
    displayName,
    client,
    personId,
    slot: { client, laterPersonId: personId },
  };
}

async function member(
  joining: Awaited<ReturnType<typeof person>>,
): Promise<Member> {
  const userId = joining.client.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(ORGANISATION_ID, joining.personId, joining.displayName),
    fixtureDatabase().prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    ).bind(ORGANISATION_ID, userId, joining.personId, Date.now()),
  ]);
  return {
    userId,
    personId: joining.personId,
    session: joining.client.session,
  };
}
async function grantHistory(user: Member): Promise<void> {
  const result = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: `grant_${user.userId}`,
    subject: { kind: "person", personId: user.personId },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_shared",
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(result.error.code);
}
function post(user: Member, path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "https://localhost",
      cookie: `pantry_session=${user.session.token}; pantry_csrf=${user.session.csrfToken}`,
      "x-pantry-csrf": user.session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
function patch(user: Member, path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "PATCH",
    headers: {
      origin: "https://localhost",
      cookie: `pantry_session=${user.session.token}; pantry_csrf=${user.session.csrfToken}`,
      "x-pantry-csrf": user.session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function jsonGet(
  user: Member,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    headers: { cookie: `pantry_session=${user.session.token}` },
  });
  const raw: unknown = await response.json();
  if (!isRecord(raw)) throw new Error("Invalid chat response");
  return raw;
}
async function acceptedInputEvidence(
  user: Member,
  conversationId: ConversationId,
) {
  const scope = { organisationId: ORGANISATION_ID, userId: user.userId };
  const stored = await readConversation(fixtureDatabase(), scope, conversationId);
  const binding = stored?.conversation.historyBindings.at(-1);
  if (binding === undefined)
    throw new Error("Accepted history binding missing");
  const authority = await readChatControlAuthority(fixtureDatabase(), scope);
  if (authority === null) throw new Error("Current control authority missing");
  const input = await readAdmittedChatInput(fixtureDatabase(), authority, binding.turnId);
  if (input === null) throw new Error("Native input admission missing");
  return {
    source: input.source,
    label: input.inputLabel.toJSON(),
    audience: input.audience,
  };
}
function send(
  user: Member,
  conversationId: ConversationId,
  requestId: string,
  text: string,
): Promise<Response> {
  return post(user, `/v1/control/organisations/${ORGANISATION_ID}/chat`, {
    kind: "message",
    conversationId,
    requestId,
    model: PLATFORM_DEFAULT_PI_MODEL,
    text,
    browserContext: { kind: "unavailable" },
  });
}
async function sidebarSummary(
  user: Member,
  conversationId: ConversationId,
): Promise<ChatConversationSummary> {
  const page = await jsonGet(
    user,
    `/v1/control/organisations/${ORGANISATION_ID}/chat?observe=true`,
  );
  if (!Array.isArray(page.conversations))
    throw new Error("Invalid chat directory");
  for (const raw of page.conversations) {
    const summary = parseChatSummary(raw);
    if (summary.id === conversationId) return summary;
  }
  throw new Error("Chat missing from sidebar");
}

async function workKind(
  user: Member,
  conversationId: ConversationId,
): Promise<string | null> {
  const response = await jsonGet(
    user,
    `/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${conversationId}&observe=true`,
  );
  if (!isRecord(response.conversation) || !isRecord(response.conversation.work))
    return null;
  return typeof response.conversation.work.kind === "string"
    ? response.conversation.work.kind
    : null;
}

type CleanupR2Pause = {
  objectKeys: ReadonlySet<string>;
  outcome: "complete" | "fail";
  state: "waiting" | "paused";
  resume: PromiseWithResolvers<void>;
  original: PropertyDescriptor | null;
};

async function cleanupRelocationRace(
  user: Member,
  path: string,
  command: { action: string; operationId: string; expectedRevision: number },
  actor: DurableObjectStub<SessionDO>,
  sessionId: SessionId,
  objectKeys: readonly string[],
  outcome: CleanupR2Pause["outcome"],
) {
  // Test helpers require a stub owned by the runner's I/O context.
  actor = env.SESSION.get(actor.id);
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const control: CleanupR2Pause = {
    objectKeys: new Set(objectKeys),
    outcome,
    state: "waiting",
    resume: Promise.withResolvers(),
    original: null,
  };
  await runInDurableObject(actor, installCleanupR2Pause.bind(null, control));
  try {
    const deleting = patch(user, path, command);
    await expect
      .poll(cleanupPauseState.bind(null, control), { timeout: 10000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId:
        outcome === "complete" ? "e2e-cleanup-live" : "e2e-cleanup-recovery",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.code);
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    const relocating = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readClosedCleanup.bind(null, actor), { timeout: 10000 })
      .toBe("pending");
    const pending = await runInDurableObject(actor, cleanupCheckpoint);
    expect(pending.sessionsRemaining).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?",
      )
        .bind(ORGANISATION_ID, scope.placement.placementEpoch)
        .first("status"),
    ).toBe("frozen");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first("count"),
    ).toBe(0);
    for (const key of objectKeys)
      expect(await env.ARCHIVE.head(key)).not.toBeNull();
    expect(
      await actor.erasePortalChatSession({
        requestingOrganisationId: ORGANISATION_ID,
        sessionId,
        placement: scope.placement,
        placementFenceToken: scope.fenceToken,
        objectKeys,
      }),
    ).toEqual({ ok: false, error: { code: "chat_cleanup_conflict" } });
    control.resume.resolve();
    const interrupted = await deleting;
    expect(interrupted.status, await interrupted.clone().text()).toBe(409);
    expect(await interrupted.json()).toMatchObject({
      kind: "rejected",
      code: "chat_delete_conflict",
    });
    let relocated = await relocating;
    if (outcome === "fail") {
      expect(relocated).toMatchObject({
        ok: false,
        error: { code: "actor_cleanup_failed" },
      });
      expect(await runInDurableObject(actor, cleanupCheckpoint)).toMatchObject({
        erasure: { kind: "pending" },
        blocked: true,
      });
      await runInDurableObject(actor, restoreCleanupR2.bind(null, control));
      await evictDurableObject(actor);
      relocated = await resumeActorRelocation({
        env,
        relocationId: started.value.relocationId,
        now: Date.now(),
      });
    }
    expect(relocated).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const erased = await runInDurableObject(actor, cleanupCheckpoint);
    expect(erased).toMatchObject({
      erasure: { kind: "erased" },
      blocked: true,
      sessionsRemaining: 0,
    });
    expect(erased.erasure).not.toHaveProperty("objectKeys");
    for (const key of objectKeys)
      expect(await env.ARCHIVE.head(key)).toBeNull();
    await evictDurableObject(actor);
    expect(
      await actor.erasePortalChatSession({
        requestingOrganisationId: ORGANISATION_ID,
        sessionId,
        placement: scope.placement,
        placementFenceToken: scope.fenceToken,
        objectKeys,
      }),
    ).toEqual({ ok: false, error: { code: "chat_cleanup_conflict" } });
    return {
      scope,
      evidence: {
        outcome,
        sourceEpoch: scope.placement.placementEpoch,
        pending,
        erased,
        copyingWhileR2Pending: false,
        publication: "after cleanup",
        retiredActorAfterEviction: "rejected",
        recovery:
          outcome === "fail"
            ? "pending checkpoint resumed after eviction"
            : "in-flight deletion drained",
      },
    };
  } finally {
    control.resume.resolve();
    await runInDurableObject(actor, restoreCleanupR2.bind(null, control));
  }
}

function cleanupPauseState(control: CleanupR2Pause): CleanupR2Pause["state"] {
  return control.state;
}

async function pauseCleanupR2(
  control: CleanupR2Pause,
  original: R2Bucket["delete"],
  keys: string | string[],
): Promise<void> {
  if (control.state === "waiting") {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      if (!control.objectKeys.has(key)) continue;
      control.state = "paused";
      await control.resume.promise;
      if (control.outcome === "fail")
        throw new Error("p55_r2_cleanup_interrupted");
      break;
    }
  }
  await original(keys);
}

function installCleanupR2Pause(control: CleanupR2Pause, actor: object): void {
  const archive = Reflect.get(Reflect.get(actor, "env"), "ARCHIVE");
  if (!isRecord(archive) || typeof archive.delete !== "function")
    throw new Error("Missing Actor R2 binding");
  control.original = { configurable: true, value: archive.delete };
  Object.defineProperty(archive, "delete", {
    configurable: true,
    value: pauseCleanupR2.bind(null, control, archive.delete.bind(archive)),
  });
}

function restoreCleanupR2(control: CleanupR2Pause, actor: object): void {
  if (control.original === null)
    throw new Error("Missing original R2 deletion");
  const archive = Reflect.get(Reflect.get(actor, "env"), "ARCHIVE");
  Object.defineProperty(archive, "delete", control.original);
}

async function cleanupCheckpoint(_actor: unknown, state: DurableObjectState) {
  return {
    erasure: await readPortalChatErasure(state.storage),
    blocked:
      state.storage.sql
        .exec("SELECT 1 FROM state_object_cleanup_export_barrier")
        .toArray().length === 1,
    sessionsRemaining: state.storage.sql
      .exec("SELECT 1 FROM session_meta")
      .toArray().length,
  };
}

async function readClosedCleanup(
  actor: DurableObjectStub<SessionDO>,
): Promise<string> {
  const checkpoint = await runInDurableObject(actor, cleanupCheckpoint);
  return checkpoint.blocked ? (checkpoint.erasure?.kind ?? "intact") : "open";
}

async function storedWorkKind(
  scope: Parameters<typeof readConversation>[1],
  conversationId: Parameters<typeof readConversation>[2],
) {
  const stored = await readConversation(fixtureDatabase(), scope, conversationId);
  return stored?.conversation.work.kind;
}
